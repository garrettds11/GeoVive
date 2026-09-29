// Scope-card storage (readiness doc Section 9 / build-order item 9). A scope card is the
// Curator's written-down statement of what a dataset is supposed to be -- topic, geography,
// inclusion/exclusion criteria, intended source class -- captured BEFORE sourcing starts, so the
// Reviewer has a fixed target to check accuracy/scope-match against later, and so a curator's
// misjudgment about what it grabbed (e.g. skydiving dropzones mistaken for general sporting
// venues) has a concrete written intent to be checked against rather than only the record data.
//
// One item per dataset, keyed by the datasetId assigned once the dataset exists in the public
// API (geo-library-api.mjs's createDataset). Never client-writable by anyone but the agents --
// this table sits entirely behind the agents stack's own permissions boundary.

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand, GetCommand } from "@aws-sdk/lib-dynamodb";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TABLE = process.env.SCOPE_CARDS_TABLE;

// card: { topic, geography, includeCriteria, excludeCriteria, intendedSourceClass, notes }
export async function writeScopeCard(datasetId, card) {
  if (!TABLE) throw new Error("SCOPE_CARDS_TABLE not set");
  await ddb.send(new PutCommand({
    TableName: TABLE,
    Item: { datasetId, ...card, writtenAt: new Date().toISOString() }
  }));
}

export async function getScopeCard(datasetId) {
  if (!TABLE) throw new Error("SCOPE_CARDS_TABLE not set");
  const { Item } = await ddb.send(new GetCommand({ TableName: TABLE, Key: { datasetId } }));
  return Item || null;
}
