// Managed-sources catalog (readiness doc Section 9 / build-order item 9). A curated list of
// known-good, structured sources (real APIs/feature services, not scraped listings) the Curator
// prefers over an unstructured Tavily web-search fallback, plus entries the Reviewer's
// source-verification skill adds as it discovers new ones worth trusting going forward. Seeded
// once post-deploy from agents/seed/managed-sources.json; grows over time via addManagedSource.
//
// sourceId is the hash key. topicTags/geography let the Curator do a cheap Scan-and-filter --
// small table, infrequent reads, PAY_PER_REQUEST -- a GSI is not worth it at this size.

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand, GetCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TABLE = process.env.MANAGED_SOURCES_TABLE;

export async function listManagedSources() {
  if (!TABLE) throw new Error("MANAGED_SOURCES_TABLE not set");
  const { Items } = await ddb.send(new ScanCommand({ TableName: TABLE }));
  return Items || [];
}

// Cheap in-process filter over the (small) full scan -- topic match against topicTags, optional
// geography match. Good enough at catalog sizes in the tens/hundreds; revisit with a GSI if this
// table ever grows past that.
export async function findManagedSource(topic, geography) {
  const all = await listManagedSources();
  const topicLower = String(topic || "").toLowerCase();
  return all.find(s =>
    (s.topicTags || []).some(t => topicLower.includes(String(t).toLowerCase())) &&
    (!geography || !s.geography || s.geography === "global" || s.geography === geography)
  ) || null;
}

export async function getManagedSource(sourceId) {
  if (!TABLE) throw new Error("MANAGED_SOURCES_TABLE not set");
  const { Item } = await ddb.send(new GetCommand({ TableName: TABLE, Key: { sourceId } }));
  return Item || null;
}

// Reviewer's source-verification skill calls this once it has confirmed a source used in an
// unstructured (web-search) run is actually a real, stable, structured source worth trusting for
// future Curator runs -- upgrading it from one-off web-search find to managed catalog entry.
export async function addManagedSource(source) {
  if (!TABLE) throw new Error("MANAGED_SOURCES_TABLE not set");
  await ddb.send(new PutCommand({
    TableName: TABLE,
    Item: { ...source, addedAt: source.addedAt || new Date().toISOString() }
  }));
}
