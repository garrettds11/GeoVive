// Background worker for AppConnect checks (invoked asynchronously by the API).
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { S3Client } from "@aws-sdk/client-s3";
import { promises as dns } from "node:dns";
import { runAppChecks } from "./appconnect.mjs";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } });
const s3 = new S3Client({});
const net = { fetch: globalThis.fetch, resolveTxt: dns.resolveTxt, lookup: dns.lookup };

export const handler = async (event) => {
  const out = await runAppChecks(ddb, s3, event, net);
  console.log("AppConnect checks", event.appId, JSON.stringify(out));
  return out;
};
