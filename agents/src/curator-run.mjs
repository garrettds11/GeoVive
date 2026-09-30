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
import { createDataset, createFeature, importFeatureCollection, listAllDatasets } from "./geo-library-api.mjs";
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


// --- Structured-source adapter -----------------------------------------------------------
// For managed sources with ingestionMode: "structured", skip Haiku entirely. Authenticate
// with the source's own API key, paginate through its native GeoJSON endpoint, and map
// each feature deterministically into GeoVive's FeatureProperties schema. Per the design
// rule: a capped/test run must NEVER perform removal reconciliation -- Curator only creates
// and updates, never deletes, and only the future Managed Record Index (not yet built) will
// handle removals after full-catalog runs.

const SECRET_ARN_MAP = {
  nlr: process.env.NLR_API_SECRET_ARN
};

async function getApiKey(provider) {
  const arn = SECRET_ARN_MAP[provider];
  if (!arn) throw new Error(`No secret ARN configured for auth provider "${provider}"`);
  const { SecretString } = await secrets.send(new GetSecretValueCommand({ SecretId: arn }));
  // Support a plain-string secret, or a JSON secret under any of a few common field-name
  // conventions ("apiKey", "api_key", "<provider>-api-key", e.g. Secrets Manager's own
  // "nlr-api-key" naming). If it parses as JSON but none of those fields are present, fail
  // loudly rather than silently sending the whole JSON blob as the key (which just gets a
  // 403 from the upstream API with no useful error message).
  let parsed;
  try { parsed = JSON.parse(SecretString); } catch { return SecretString.trim(); }
  if (typeof parsed !== "object" || parsed === null) return SecretString.trim();
  const key = parsed.apiKey || parsed.api_key || parsed[`${provider}-api-key`] || parsed[`${provider}_api_key`];
  if (!key) {
    throw new Error(
      `Secret for provider "${provider}" is JSON but has none of the expected key fields ` +
      `(apiKey, api_key, ${provider}-api-key, ${provider}_api_key). Found keys: ${Object.keys(parsed).join(", ")}`
    );
  }
  return String(key).trim();
}

async function fetchStructuredGeoJSON(managed, { maxRecords, timeLeft }) {
  const { baseUrl, auth, request: req } = managed;
  const features = [];

  // Build the base query params from catalog config
  const baseParams = { ...(req?.query || {}) };

  // Inject the API key
  if (auth?.type === "api-key") {
    const key = await getApiKey(auth.provider);
    baseParams[auth.parameter || "api_key"] = key;
  }

  const pagination = req?.pagination;
  if (pagination?.type === "offset-limit") {
    const pageSize = Number(pagination.pageSize) || 100;
    let offset = 0;
    while (features.length < maxRecords && timeLeft() > 0) {
      const params = new URLSearchParams({
        ...baseParams,
        [pagination.offsetParameter || "offset"]: String(offset),
        [pagination.limitParameter || "limit"]: String(pageSize)
      });
      const url = `${baseUrl}?${params}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`Structured fetch failed: ${res.status} ${res.statusText} from ${baseUrl}`);
      const geojson = await res.json();
      const page = geojson?.features || [];
      if (!page.length) break; // no more data
      features.push(...page);
      offset += page.length;
      if (page.length < pageSize) break; // last page
    }
  } else {
    // No pagination config -- single fetch (e.g. a small static GeoJSON file)
    const params = new URLSearchParams(baseParams);
    const url = Object.keys(baseParams).length ? `${baseUrl}?${params}` : baseUrl;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Structured fetch failed: ${res.status} ${res.statusText} from ${baseUrl}`);
    const geojson = await res.json();
    features.push(...(geojson?.features || []));
  }

  return features.slice(0, maxRecords);
}

// Deterministic mapper: GeoJSON feature → GeoVive FeatureProperties. All upstream-specific
// fields that don't map to a named GeoVive property go into the `description` markdown field,
// per datamodel.yaml's additionalProperties: false rule.
function mapStructuredFeature(geoJsonFeature, managed) {
  const props = geoJsonFeature.properties || {};
  const geom = geoJsonFeature.geometry;
  if (!geom || geom.type !== "Point") return null; // only Point geometry for now

  // Build a human-readable name from common fields
  const name = String(
    props.station_name || props.name || props.title || props.NAME || "Unnamed"
  ).slice(0, 200);

  // Build a markdown description from all non-null properties
  const skipKeys = new Set(["station_name", "name", "title", "NAME", "id", "latitude", "longitude"]);
  const lines = [];
  for (const [k, v] of Object.entries(props)) {
    if (skipKeys.has(k) || v == null || v === "") continue;
    lines.push(`**${k}**: ${String(v).slice(0, 500)}`);
  }
  const description = lines.join("\n").slice(0, 5000);

  const externalId = String(props.id || props.station_id || props.ID || "").slice(0, 200) || undefined;

  return {
    geometry: geom,
    properties: {
      name,
      description,
      category: "location",
      source: managed.sourceId,
      externalId,
      sourceClass: "managed",
      status: "active"
    }
  };
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
    if (managed?.ingestionMode === "structured") {
      // Deterministic structured path: no LLM, no token spend. Authenticate, paginate,
      // and map features directly from the source's native GeoJSON schema.
      const maxRecords = Math.min(MAX_RECORDS, Number(managed.request?.pagination?.pageSize) || 100);
      const rawFeatures = await fetchStructuredGeoJSON(managed, { maxRecords, timeLeft });
      records = rawFeatures.map(f => mapStructuredFeature(f, managed)).filter(Boolean);
      sourceUsed = { sourceClass: "managed", sourceId: managed.sourceId, ingestionMode: "structured", rawFetched: rawFeatures.length };
    } else if (managed) {
      // Legacy managed path: fetch raw text, extract via Haiku
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
    if (sourceUsed.ingestionMode === "structured") {
      // Structured records are already mapped to GeoVive features -- bulk-create them through
      // the async import API (upload-url -> PUT -> startImport -> poll). /features/batch is
      // delete/move/copy only (openapi.yaml), not bulk-create, so this is the real path.
      const featureCollection = { type: "FeatureCollection", features: records };
      const imp = await importFeatureCollection(dataset.datasetId, featureCollection, { mode: "append" });
      written = imp.imported || 0;
      await auditEvent({
        action: "import.completed",
        agent: "curator",
        datasetId: dataset.datasetId,
        detail: { importId: imp.importId, status: imp.status, imported: imp.imported, skipped: imp.skipped, errors: imp.errors }
      });
      if (imp.status !== "succeeded") {
        throw new Error(`Import did not complete: status=${imp.status} imported=${imp.imported} skipped=${imp.skipped} errors=${JSON.stringify(imp.errors || [])}`);
      }
    } else {
      // Haiku-extracted records need geocoding/conversion
      for (const record of records) {
        if (written >= MAX_RECORDS || timeLeft() <= 0) break;
        const feature = await toFeature(record);
        if (!feature) continue;
        await createFeature(dataset.datasetId, feature);
        written++;
        await auditEvent({ action: "feature.created", agent: "curator", datasetId: dataset.datasetId, detail: { name: feature.properties.name } });
      }
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
