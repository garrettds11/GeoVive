// Curator's real harness (build-order item 9 / readiness doc Sections 2 and 5). Picks a topic
// not already covered, writes a scope card, sources structured data from the managed-sources
// catalog when a match exists, falls back to Tavily web search + LLM extraction when it doesn't,
// and writes the dataset+features through the exact same public API any human uses
// (geo-library-api.mjs) -- never a direct table write. Every failure exits the routine cleanly
// (5's philosophy: simple, observable, improved later from real telemetry, not forward-engineered
// edge cases) and is reported via one audit event + one status email, never partial retries.

import { checkGate } from "./cost-gate.mjs";
import { startSpan, endSpan } from "./otel.mjs";
import { auditEvent } from "./audit.mjs";
import { notify } from "./notify.mjs";
import { converse, extractJson, MODELS } from "./bedrock.mjs";
import { findManagedSource } from "./managed-sources.mjs";
import { writeScopeCard } from "./scope-cards.mjs";
import { createDataset, createFeature, listAllDatasets } from "./geo-library-api.mjs";
import { geocode } from "./geocode.mjs";
import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";

const secrets = new SecretsManagerClient({});

// Stop conditions (Section 5): whichever hits first ends the run.
const MAX_RUN_MS = 15 * 60 * 1000;
const MAX_RECORDS = 5000;
const MAX_TOKENS = 80_000;

// A small, rotating candidate list -- Curator picks the first one not already covered by an
// existing dataset name/tag. Deliberately not LLM-driven yet: topic selection is cheap and
// mechanical, so there's no reason to spend a model call choosing among a fixed list. The list
// itself is expected to grow by hand as domains are added (readiness doc's envisioned-domains
// list), not generated at runtime.
const CANDIDATE_TOPICS = [
  { topic: "EV charging stations", geography: "us", tags: ["ev", "charging", "infrastructure"] },
  { topic: "petroleum refineries", geography: "us", tags: ["energy", "petroleum", "infrastructure"] },
  { topic: "polling locations", geography: "us", tags: ["elections", "civic"] },
  { topic: "theme parks", geography: "global", tags: ["recreation", "tourism"] }
];

async function pickTopic() {
  const existing = await listAllDatasets().catch(() => ({ datasets: [] }));
  const names = new Set((existing.datasets || []).map(d => (d.name || "").toLowerCase()));
  return CANDIDATE_TOPICS.find(c => !names.has(c.topic.toLowerCase())) || null;
}

async function tavilySearch(query) {
  const { SecretString } = await secrets.send(new GetSecretValueCommand({ SecretId: process.env.TAVILY_SECRET_ARN }));
  const { apiKey } = JSON.parse(SecretString);
  const res = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ api_key: apiKey, query, search_depth: "basic", max_results: 5, include_raw_content: true })
  });
  if (!res.ok) throw new Error(`Tavily search failed: ${res.status}`);
  return res.json();
}

// Fetches a managed source's own endpoint (JSON API / Esri feature service / etc.) and hands the
// raw payload (truncated to a safe size) to Haiku for structured extraction against the scope
// card. Generic on purpose -- see managed-sources.mjs's notes on source shape variety; a source
// whose payload doesn't survive this generic pass is a candidate for a source-specific fetcher
// later, not something to special-case here yet.
async function extractFromRaw({ rawText, scopeCard, tokenBudget }) {
  const trimmed = rawText.slice(0, 40_000); // keep prompt+response comfortably inside tokenBudget
  const { text, inputTokens, outputTokens } = await converse({
    modelId: MODELS.haiku,
    system: "You extract structured geospatial records from raw source data. Respond with ONLY a JSON array, " +
      "each element: {\"name\": string, \"lat\"?: number, \"lon\"?: number, \"address\"?: string, \"description\": string}. " +
      "Give lat/lon when the source states real coordinates. When it only gives a street address or place name " +
      "and no coordinates, give \"address\" instead (a full, geocodable address or place name) and omit lat/lon " +
      "-- never invent coordinates. Skip anything outside the requested scope. If nothing usable is found, respond with [].",
    messages: [{
      role: "user",
      content: `Scope: topic="${scopeCard.topic}", geography="${scopeCard.geography}", ` +
        `include="${scopeCard.includeCriteria}", exclude="${scopeCard.excludeCriteria}".\n\nRaw source data:\n${trimmed}`
    }],
    maxTokens: 4000
  });
  const records = extractJson(text);
  return { records: Array.isArray(records) ? records : [], tokensUsed: inputTokens + outputTokens };
}

async function toFeature(record) {
  let { lat, lon } = record;
  if (typeof lat !== "number" || typeof lon !== "number") {
    if (!record.address) return null;
    // Geocoding failure (no match, or a real API error) is not a run-level failure -- it just
    // means this one record can't be placed, same as any other per-record skip. The caller's
    // audit trail records the skip via the reduced written count; nothing further to log here.
    const geocoded = await geocode(record.address).catch(() => null);
    if (!geocoded) return null;
    ({ lat, lon } = geocoded);
  }
  return {
    geometry: { type: "Point", coordinates: [lon, lat] },
    properties: { name: String(record.name || "").slice(0, 200), description: String(record.description || "").slice(0, 2000) }
  };
}

export const handler = async () => {
  const rootSpan = startSpan("curator.run");
  const gate = await checkGate();
  if (!gate.allowed) {
    console.log("Curator run blocked:", gate.reason);
    await auditEvent({ action: "run.blocked", agent: "curator", detail: { reason: gate.reason } });
    await endSpan(rootSpan, { attributes: { blocked: true, reason: gate.reason } });
    return { blocked: true, reason: gate.reason };
  }

  const startedAt = Date.now();
  let tokensUsed = 0;
  const timeLeft = () => MAX_RUN_MS - (Date.now() - startedAt);

  await auditEvent({ action: "run.started", agent: "curator", detail: { spentUsd: gate.spentUsd } });

  const pick = await pickTopic();
  if (!pick) {
    await auditEvent({ action: "run.stopped", agent: "curator", detail: { reason: "no uncovered topic in candidate list" } });
    await notify({ subject: "Curator run: nothing to do", bodyText: "Every candidate topic already has a dataset.", reasonCode: "NOOP" });
    await endSpan(rootSpan, { attributes: { outcome: "noop" } });
    return { blocked: false, note: "no uncovered topic" };
  }

  const scopeCard = {
    topic: pick.topic,
    geography: pick.geography,
    includeCriteria: `Records that are genuinely ${pick.topic} within ${pick.geography}.`,
    excludeCriteria: "Anything only tangentially related, or outside the stated geography.",
    intendedSourceClass: "unknown" // set below once sourcing succeeds
  };

  let dataset;
  let sourceUsed;
  try {
    let records = [];
    const managed = await findManagedSource(pick.topic, pick.geography);
    if (managed) {
      const raw = await fetch(managed.baseUrl).then(r => r.text());
      const extracted = await extractFromRaw({ rawText: raw, scopeCard, tokenBudget: MAX_TOKENS - tokensUsed });
      tokensUsed += extracted.tokensUsed;
      records = extracted.records;
      sourceUsed = { sourceClass: "managed", sourceId: managed.sourceId };
    } else {
      const search = await tavilySearch(`${pick.topic} ${pick.geography} list data`);
      const raw = (search.results || []).map(r => `${r.title}\n${r.content || r.raw_content || ""}`).join("\n\n---\n\n");
      const extracted = await extractFromRaw({ rawText: raw, scopeCard, tokenBudget: MAX_TOKENS - tokensUsed });
      tokensUsed += extracted.tokensUsed;
      records = extracted.records;
      sourceUsed = { sourceClass: "unstructured-websearch", query: `${pick.topic} ${pick.geography} list data` };
    }
    scopeCard.intendedSourceClass = sourceUsed.sourceClass;

    if (!records.length) {
      await auditEvent({ action: "run.stopped", agent: "curator", detail: { reason: "no records extracted", topic: pick.topic, sourceUsed } });
      await notify({
        subject: `Curator run: no data found for "${pick.topic}"`,
        bodyText: `Curator tried ${sourceUsed.sourceClass === "managed" ? "the managed source" : "a web search fallback"} for "${pick.topic}" and extracted zero usable records. No dataset was created.`,
        reasonCode: "NO_DATA"
      });
      await endSpan(rootSpan, { attributes: { outcome: "no_data", topic: pick.topic, sourceClass: sourceUsed.sourceClass, tokensUsed } });
      return { blocked: false, note: "no records extracted" };
    }

    dataset = await createDataset({
      name: pick.topic,
      description: `Auto-curated dataset: ${pick.topic} (${pick.geography}). Source: ${sourceUsed.sourceClass}. Pending Reviewer pass.`,
      tags: pick.tags
    });
    await writeScopeCard(dataset.datasetId, scopeCard);
    await auditEvent({ action: "dataset.created", agent: "curator", datasetId: dataset.datasetId, detail: { topic: pick.topic, sourceUsed } });

    let written = 0;
    for (const record of records) {
      if (written >= MAX_RECORDS || timeLeft() <= 0) break;
      const feature = await toFeature(record);
      if (!feature) continue;
      await createFeature(dataset.datasetId, feature);
      written++;
      await auditEvent({ action: "feature.created", agent: "curator", datasetId: dataset.datasetId, detail: { name: feature.properties.name } });
    }

    await notify({
      subject: `Curator run complete: "${pick.topic}" (${written} records)`,
      bodyText: `Dataset ${dataset.datasetId} ("${pick.topic}") was created with ${written} records via ${sourceUsed.sourceClass}. ` +
        `It now awaits Reviewer.`,
      reasonCode: "CURATED"
    });
    await endSpan(rootSpan, {
      attributes: { outcome: "curated", topic: pick.topic, datasetId: dataset.datasetId, written, sourceClass: sourceUsed.sourceClass, tokensUsed }
    });
    return { blocked: false, datasetId: dataset.datasetId, written };
  } catch (err) {
    console.error("Curator run failed:", err);
    await auditEvent({ action: "run.failed", agent: "curator", datasetId: dataset?.datasetId, detail: { error: String(err?.message || err), topic: pick.topic } });
    await notify({
      subject: `Curator run failed for "${pick.topic}"`,
      bodyText: `The run for "${pick.topic}" exited on an error and stopped, per the graceful-exit-only policy: ${String(err?.message || err)}`,
      reasonCode: "FAILED"
    });
    await endSpan(rootSpan, { status: "ERROR", error: String(err?.message || err), attributes: { outcome: "failed", topic: pick.topic, tokensUsed } });
    return { blocked: false, error: String(err?.message || err) };
  }
};
