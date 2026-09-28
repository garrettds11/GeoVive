// Agent-action audit log (build-order item 5 / readiness doc Section 6.6). Distinct from the
// admin page's human-action audit log (admin.mjs / AdminTable in the backend stack) and from
// Grafana's operational traces -- this is a durable, queryable record of what each AGENT action
// did: create dataset, create feature, geocode call, web search fallback, and so on.

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";
import { randomUUID } from "node:crypto";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const TABLE = process.env.AGENT_AUDIT_TABLE;

// action examples: "run.started", "run.stopped", "dataset.created", "feature.created",
// "geocode.call", "websearch.fallback", "scopecard.written"
export async function auditEvent({ action, agent, datasetId, detail }) {
  if (!TABLE) { console.warn("AGENT_AUDIT_TABLE not set; skipping audit write for", action); return; }
  const now = new Date();
  await ddb.send(new PutCommand({
    TableName: TABLE,
    Item: {
      auditId: randomUUID(),
      at: now.toISOString(),
      // ttl-free by default; the table has no TTL attribute configured, records are kept
      action,
      agent,              // e.g. "curator", "reviewer"
      datasetId: datasetId || null,
      detail: detail || {}
    }
  }));
}
