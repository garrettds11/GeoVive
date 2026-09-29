// Background worker for AppConnect checks (invoked asynchronously by the API).
import "./safelog.mjs";   // first: keeps personal information out of logs
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { S3Client } from "@aws-sdk/client-s3";
import { promises as dns } from "node:dns";
import { runAppChecks, runDaily, runLayerReview } from "./appconnect.mjs";
import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";

const lambda = new LambdaClient({});

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } });
const s3 = new S3Client({});
const net = { fetch: globalThis.fetch, resolveTxt: dns.resolveTxt, lookup: dns.lookup };

export const handler = async (event) => {
  // Daily schedule: re-checks, renewal reminders, expiry
  if (event?.source === "aws.scheduler" || event?.task === "daily") {
    const out = await runDaily(ddb, { net, s3, invokeWorker: payload => lambda.send(new InvokeCommand({
      FunctionName: process.env.AWS_LAMBDA_FUNCTION_NAME, InvocationType: "Event", Payload: Buffer.from(JSON.stringify(payload)) })) });
    console.log("AppConnect daily", JSON.stringify(out));
    return out;
  }
  const out = event.mode === "layers" ? await runLayerReview(ddb, s3, event, net) : await runAppChecks(ddb, s3, event, net);
  console.log("AppConnect checks", event.appId, JSON.stringify(out));
  return out;
};
