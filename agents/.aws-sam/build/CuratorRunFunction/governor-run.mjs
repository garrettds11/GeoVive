// Governor's real harness (build-order item 9 / readiness doc's three-agent-pipeline decision,
// corrected per Garrett's explicit ruling: Governor NEVER deletes records and NEVER produces an
// approved dataset by itself -- it is strictly read-and-flag. Works reviewStatus=passed datasets,
// checking each record for sensitive-data/safety concerns with Haiku triage; a flagged record is
// escalated to Opus for real verification, capped at 3 escalations per dataset ("3 strikes") --
// the 3rd aborts the WHOLE dataset (authStatus=escalation_aborted) as a cost-control circuit
// breaker, and it is deliberately left out of the admin queue for Garrett's own manual cleanup.
// Any Governor-confirmed sensitive-record incident fires its own incident email immediately,
// independent of how the dataset's run ultimately ends (readiness doc Section 9.6's two
// email-trigger rule). A dataset that clears with authStatus=authorized STILL requires Garrett's
// separate manual admin-page approval before publish -- that due-diligence gate is not this
// function's job and is not represented here at all.

import { checkGate } from "./cost-gate.mjs";
import { startSpan, endSpan } from "./otel.mjs";
import { auditEvent } from "./audit.mjs";
import { notify } from "./notify.mjs";
import { converse, extractJson, MODELS } from "./bedrock.mjs";
import { listAllDatasets, listFeatures, updateDataset } from "./geo-library-api.mjs";

const MAX_RUN_MS = 15 * 60 * 1000;
const MAX_TOKENS = 80_000;
const MAX_ESCALATIONS_PER_DATASET = 3;

async function triage(feature) {
  const { text, inputTokens, outputTokens } = await converse({
    modelId: MODELS.haiku,
    system: "You triage one geospatial record for sensitive or unsafe content (personal data, addresses tied to " +
      "named private individuals, anything that looks like it could put someone at risk if published). " +
      "Respond with ONLY JSON: {\"suspicious\": boolean, \"reason\": string}. Be trigger-happy: this is a cheap " +
      "first pass and a suspicious=true result gets a second, more careful look before anything is reported.",
    messages: [{ role: "user", content: `Record: ${JSON.stringify(feature.properties)}` }],
    maxTokens: 300
  });
  return { verdict: extractJson(text), tokensUsed: inputTokens + outputTokens };
}

async function escalate(feature) {
  const { text, inputTokens, outputTokens } = await converse({
    modelId: MODELS.opus,
    system: "A cheaper triage pass flagged this geospatial record as possibly sensitive. Verify carefully. " +
      "Respond with ONLY JSON: {\"confirmedSensitive\": boolean, \"reason\": string}.",
    messages: [{ role: "user", content: `Record: ${JSON.stringify(feature.properties)}` }],
    maxTokens: 500
  });
  return { verdict: extractJson(text), tokensUsed: inputTokens + outputTokens };
}

// Returns { authStatus, flagged: [...], incidents: [...] }. Never deletes; never sets authorized
// without finishing the full dataset (an abort mid-loop always lands on escalation_aborted).
async function reviewDataset(ds, budget) {
  const { features } = await listFeatures(ds.datasetId).catch(() => ({ features: [] }));
  const flagged = [];
  const incidents = [];
  let escalations = 0;

  for (const feature of features || []) {
    if (budget.timeLeft() <= 0 || budget.tokensUsed >= MAX_TOKENS) break;

    const { verdict: triageVerdict, tokensUsed: t1 } = await triage(feature);
    budget.tokensUsed += t1;
    if (!triageVerdict.suspicious) continue;

    if (escalations >= MAX_ESCALATIONS_PER_DATASET) {
      // 3 strikes: abort the whole dataset. Held for Garrett's manual mass-delete; never reaches
      // the admin queue as authorized OR unauthorized -- escalation_aborted is its own terminal
      // state precisely so it doesn't get confused with either.
      await auditEvent({
        action: "dataset.escalation_aborted", agent: "governor", datasetId: ds.datasetId,
        detail: { reason: `hit ${MAX_ESCALATIONS_PER_DATASET}-escalation cap`, escalations }
      });
      return { authStatus: "escalation_aborted", flagged, incidents };
    }

    escalations++;
    const { verdict: opusVerdict, tokensUsed: t2 } = await escalate(feature);
    budget.tokensUsed += t2;
    await auditEvent({
      action: "feature.escalated", agent: "governor", datasetId: ds.datasetId,
      detail: { featureId: feature.id, triageReason: triageVerdict.reason, opusVerdict }
    });

    if (opusVerdict.confirmedSensitive) {
      flagged.push({ featureId: feature.id, reason: opusVerdict.reason });
      incidents.push({ featureId: feature.id, reason: opusVerdict.reason, properties: feature.properties });
    }
  }

  const authStatus = flagged.length ? "unauthorized" : "authorized";
  return { authStatus, flagged, incidents };
}

export const handler = async () => {
  const rootSpan = startSpan("governor.run");
  const gate = await checkGate();
  if (!gate.allowed) {
    console.log("Governor run blocked:", gate.reason);
    await auditEvent({ action: "run.blocked", agent: "governor", detail: { reason: gate.reason } });
    await endSpan(rootSpan, { attributes: { blocked: true, reason: gate.reason } });
    return { blocked: true, reason: gate.reason };
  }

  const startedAt = Date.now();
  const budget = { tokensUsed: 0, timeLeft: () => MAX_RUN_MS - (Date.now() - startedAt) };
  await auditEvent({ action: "run.started", agent: "governor", detail: { spentUsd: gate.spentUsd } });

  const { datasets: all } = await listAllDatasets().catch(() => ({ datasets: [] }));
  const passed = (all || []).filter(d => d.reviewStatus === "passed" && (!d.authStatus || d.authStatus === "pending"));

  if (!passed.length) {
    await auditEvent({ action: "run.stopped", agent: "governor", detail: { reason: "no reviewStatus=passed datasets awaiting authorization" } });
    await endSpan(rootSpan, { attributes: { outcome: "noop" } });
    return { blocked: false, note: "nothing to authorize" };
  }

  const summaries = [];
  for (const ds of passed) {
    if (budget.timeLeft() <= 0) break;
    try {
      const result = await reviewDataset(ds, budget);
      await updateDataset(ds.datasetId, { authStatus: result.authStatus });
      await auditEvent({
        action: "dataset.authorized", agent: "governor", datasetId: ds.datasetId,
        detail: { authStatus: result.authStatus, flaggedCount: result.flagged.length }
      });
      summaries.push({ datasetId: ds.datasetId, name: ds.name, authStatus: result.authStatus, flagged: result.flagged.length });

      // Incident email: independent of the run's own exit trigger, fires immediately per record
      // batch confirmed sensitive -- readiness doc 9.6's second trigger, not folded into the
      // end-of-run summary below.
      if (result.incidents.length) {
        await notify({
          subject: `SENSITIVE RECORD INCIDENT: dataset "${ds.name}" (${ds.datasetId})`,
          bodyText: result.incidents.map(i => `- feature ${i.featureId}: ${i.reason}\n  ${JSON.stringify(i.properties)}`).join("\n\n") +
            `\n\nGovernor never deletes records -- use the admin page to review and remove the flagged record(s), ` +
            `and approve/deny the dataset there once you've decided.`,
          reasonCode: "INCIDENT"
        });
      }
    } catch (err) {
      console.error("Governor failed on dataset", ds.datasetId, err);
      await auditEvent({ action: "run.failed", agent: "governor", datasetId: ds.datasetId, detail: { error: String(err?.message || err) } });
      summaries.push({ datasetId: ds.datasetId, name: ds.name, error: String(err?.message || err) });
    }
  }

  const lines = summaries.map(s => s.error
    ? `- ${s.name} (${s.datasetId}): FAILED -- ${s.error}`
    : `- ${s.name} (${s.datasetId}): ${s.authStatus}${s.flagged ? ` (${s.flagged} flagged)` : ""}`);
  await notify({
    subject: `Governor run complete: ${summaries.length} dataset(s)`,
    bodyText: lines.join("\n") + `\n\nReminder: every authorized dataset above still needs your manual due-diligence approval before it goes public.`,
    reasonCode: "AUTHORIZED"
  });
  await endSpan(rootSpan, {
    attributes: { outcome: "authorized_run", datasetsProcessed: summaries.length, tokensUsed: budget.tokensUsed }
  });
  return { blocked: false, authorized: summaries.length };
};
