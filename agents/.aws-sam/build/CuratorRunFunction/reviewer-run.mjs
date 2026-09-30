// Reviewer's real harness (build-order item 9 / readiness doc Sections 2, 5, 6, 9). Works
// through geo-library's own reviewStatus=pending datasets record-by-record, checking each
// record's accuracy/integrity against its scope card. Reviewer is the ONLY agent with
// record-delete authority in this pipeline (Governor, once built, is strictly read-and-flag --
// see AGENTS_READINESS.md's corrected Section on this). A record judged inaccurate or
// out-of-scope is deleted outright and the run moves on -- no partial-continuation logic, per
// the same graceful-exit philosophy Curator follows. Also runs the source-verification skill:
// when a managed-source-sourced record checks out, it's a candidate to promote the source's
// sourceClass; a repeatedly-wrong unstructured source is left alone rather than promoted.

import { checkGate } from "./cost-gate.mjs";
import { startSpan, endSpan } from "./otel.mjs";
import { auditEvent } from "./audit.mjs";
import { notify } from "./notify.mjs";
import { converse, extractJson, MODELS } from "./bedrock.mjs";
import { getScopeCard } from "./scope-cards.mjs";
import { getReviewSample } from "./review-samples.mjs";
import { addManagedSource, getManagedSource } from "./managed-sources.mjs";
import { listAllDatasets, listFeatures, deleteFeature, updateDataset } from "./geo-library-api.mjs";

const MAX_RUN_MS = 15 * 60 * 1000;
const MAX_TOKENS = 80_000;

async function judgeRecord({ feature, scopeCard }) {
  const { text, inputTokens, outputTokens } = await converse({
    modelId: MODELS.haiku,
    system: "You check one geospatial record against a dataset's stated scope for accuracy and fit. " +
      "Respond with ONLY JSON: {\"keep\": boolean, \"reason\": string, \"revisedName\"?: string, \"revisedDescription\"?: string}. " +
      "Set keep=false when the record is inaccurate, fabricated-sounding, or clearly outside the scope " +
      "(e.g. a skydiving dropzone returned for a \"sporting venues\" scope). Prefer keep=true with a revision " +
      "over keep=false when the record is right but mislabeled.",
    messages: [{
      role: "user",
      content: `Scope: topic="${scopeCard?.topic}", include="${scopeCard?.includeCriteria}", exclude="${scopeCard?.excludeCriteria}".\n\n` +
        `Record: ${JSON.stringify(feature.properties)}`
    }],
    maxTokens: 500
  });
  const verdict = extractJson(text);
  return { verdict, tokensUsed: inputTokens + outputTokens };
}

async function reviewDataset(ds, budget) {
  const scopeCard = await getScopeCard(ds.datasetId).catch(() => null);

  // Spot-check design (2026-09-30): Curator writes a small honest random sample at build time
  // for any dataset that isn't from an "official" source (see review-samples.mjs's header) --
  // when one exists, judge THAT instead of re-scanning the live features table, so the verdict
  // is an intentional sample rather than whatever fraction of a full/partial scan happened to
  // fit in this run's token budget. No sample (an official-skipped dataset never reaches this
  // function at all since Curator sets reviewStatus=passed itself and it's not in the pending
  // queue; a small unstructured-websearch dataset or any legacy dataset predating this table)
  // falls back to the original full-scan behavior unchanged.
  const sample = await getReviewSample(ds.datasetId).catch(() => null);
  let features, sampleUnresolved = 0;
  if (sample) {
    features = sample.items.filter(i => i.featureId).map(i => ({ id: i.featureId, properties: i.properties }));
    sampleUnresolved = sample.items.length - features.length;
  } else {
    ({ features = [] } = await listFeatures(ds.datasetId).catch(() => ({ features: [] })));
  }

  let kept = 0, deleted = 0;

  for (const feature of features || []) {
    if (budget.timeLeft() <= 0 || budget.tokensUsed >= MAX_TOKENS) break;
    const { verdict, tokensUsed } = await judgeRecord({ feature, scopeCard });
    budget.tokensUsed += tokensUsed;

    if (!verdict.keep) {
      await deleteFeature(ds.datasetId, feature.id);
      deleted++;
      await auditEvent({ action: "feature.deleted", agent: "reviewer", datasetId: ds.datasetId, detail: { reason: verdict.reason } });
      continue;
    }
    kept++;
    // Source-verification skill: a managed-source record that held up under review is exactly
    // the signal that source is worth trusting -- nothing to do here beyond keeping it, since
    // it's already in the catalog. An unstructured-websearch source that held up on every record
    // in this dataset is the case worth promoting (below, after the loop).
  }

  if (sample) {
    await auditEvent({
      action: "dataset.spot_checked", agent: "reviewer", datasetId: ds.datasetId,
      detail: { sampleSize: sample.items.length, totalRecords: sample.totalRecords, judged: features.length, unresolved: sampleUnresolved }
    });
  }

  const reviewStatus = deleted > 0 && kept === 0 ? "failed" : "passed";
  await updateDataset(ds.datasetId, { reviewStatus });
  await auditEvent({ action: "dataset.reviewed", agent: "reviewer", datasetId: ds.datasetId, detail: { kept, deleted, reviewStatus } });

  // Promote an unstructured source to the managed catalog only when it survived review whole --
  // a single deletion means it's not reliable enough yet to skip Curator's scope-card check
  // next time by calling it "managed".
  if (reviewStatus === "passed" && deleted === 0 && scopeCard?.intendedSourceClass === "unstructured-websearch") {
    await addManagedSource({
      sourceId: `websearch-${ds.datasetId}`,
      name: scopeCard.topic,
      baseUrl: null,
      format: "unstructured",
      license: "unknown -- verify before relying on this at scale",
      topicTags: [scopeCard.topic],
      geography: scopeCard.geography,
      addedBy: "reviewer-source-verification",
      verifiedAt: new Date().toISOString(),
      notes: `Promoted after a clean review pass of dataset ${ds.datasetId}. No structured endpoint identified yet -- ` +
        `still needs a real baseUrl before Curator can use it as a managed source rather than falling back to web search again.`
    }).catch(err => console.warn("source-verification promotion skipped:", err.message));
  }

  return { kept, deleted, reviewStatus };
}

export const handler = async () => {
  const rootSpan = startSpan("reviewer.run");
  const gate = await checkGate();
  if (!gate.allowed) {
    console.log("Reviewer run blocked:", gate.reason);
    await auditEvent({ action: "run.blocked", agent: "reviewer", detail: { reason: gate.reason } });
    await endSpan(rootSpan, { attributes: { blocked: true, reason: gate.reason } });
    return { blocked: true, reason: gate.reason };
  }

  const startedAt = Date.now();
  const budget = { tokensUsed: 0, timeLeft: () => MAX_RUN_MS - (Date.now() - startedAt) };
  await auditEvent({ action: "run.started", agent: "reviewer", detail: { spentUsd: gate.spentUsd } });

  const { datasets: all } = await listAllDatasets().catch(() => ({ datasets: [] }));
  const pending = (all || []).filter(d => d.reviewStatus === "pending");

  if (!pending.length) {
    await auditEvent({ action: "run.stopped", agent: "reviewer", detail: { reason: "no reviewStatus=pending datasets" } });
    await endSpan(rootSpan, { attributes: { outcome: "noop" } });
    return { blocked: false, note: "nothing to review" };
  }

  const summaries = [];
  for (const ds of pending) {
    if (budget.timeLeft() <= 0) break;
    try {
      const result = await reviewDataset(ds, budget);
      summaries.push({ datasetId: ds.datasetId, name: ds.name, ...result });
    } catch (err) {
      console.error("Reviewer failed on dataset", ds.datasetId, err);
      await auditEvent({ action: "run.failed", agent: "reviewer", datasetId: ds.datasetId, detail: { error: String(err?.message || err) } });
      summaries.push({ datasetId: ds.datasetId, name: ds.name, error: String(err?.message || err) });
    }
  }

  const lines = summaries.map(s => s.error
    ? `- ${s.name} (${s.datasetId}): FAILED -- ${s.error}`
    : `- ${s.name} (${s.datasetId}): ${s.reviewStatus} (kept ${s.kept}, deleted ${s.deleted})`);
  await notify({
    subject: `Reviewer run complete: ${summaries.length} dataset(s)`,
    bodyText: lines.join("\n"),
    reasonCode: "REVIEWED"
  });
  await endSpan(rootSpan, {
    attributes: { outcome: "reviewed", datasetsReviewed: summaries.length, tokensUsed: budget.tokensUsed }
  });
  return { blocked: false, reviewed: summaries.length };
};
