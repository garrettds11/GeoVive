// Review-sample storage (spot-check design, 2026-09-30). Reviewer and Governor were both doing
// a full listFeatures() scan and judging records one-by-one with an LLM call each, until either
// hit its own token/time budget -- fine for a handful of records, meaningless at catalog scale
// (an 89,989-record structured import would get "reviewed" on whatever fraction of the first
// page happened to fit in ~80K tokens, then the WHOLE dataset gets marked passed/failed from
// that accidental partial sample). This table holds a deliberate, small, honest random sample
// instead: Curator picks it right after building/importing a dataset (it already has every
// record's content in memory, or -- for the async-import structured path -- resolves the
// sampled records' live featureIds via one bounded listFeatures pass), and Reviewer/Governor
// read the SAME sample rather than re-scanning the live table themselves.
//
// A dataset sourced from an "official" managed source (managed-sources.mjs entry with
// official: true -- currently meaning a direct .gov/.edu-style authoritative API, confirmed by
// hand when the catalog entry was added, not auto-derived from the URL at review time) skips
// sampling and per-record LLM review entirely: Curator sets reviewStatus: "passed" itself and no
// sample row is written here. getReviewSample() then correctly returns null for it, and
// Reviewer/Governor fall back to their original full-scan behavior for any dataset with no
// sample (which also covers small unstructured-websearch datasets and any legacy dataset that
// predates this table).
//
// One item per dataset, keyed by datasetId. Agents-only, same as scope-cards.mjs.

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand, GetCommand } from "@aws-sdk/lib-dynamodb";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TABLE = process.env.REVIEW_SAMPLES_TABLE;

// sample: { sourceId, sourceClass, sampleSize, totalRecords, items: [{ featureId, properties }] }
export async function writeReviewSample(datasetId, sample) {
  if (!TABLE) throw new Error("REVIEW_SAMPLES_TABLE not set");
  await ddb.send(new PutCommand({
    TableName: TABLE,
    Item: { datasetId, ...sample, sampledAt: new Date().toISOString() }
  }));
}

export async function getReviewSample(datasetId) {
  if (!TABLE) throw new Error("REVIEW_SAMPLES_TABLE not set");
  const { Item } = await ddb.send(new GetCommand({ TableName: TABLE, Key: { datasetId } }));
  return Item || null;
}

// Fisher-Yates partial shuffle -- picks up to n distinct random elements from arr without
// mutating the caller's array or needing to shuffle the whole thing.
export function pickRandomSample(arr, n) {
  const copy = arr.slice();
  const take = Math.min(n, copy.length);
  for (let i = 0; i < take; i++) {
    const j = i + Math.floor(Math.random() * (copy.length - i));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, take);
}
