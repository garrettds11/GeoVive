// GeoVive API — datasets + features (Node.js 22, AWS SDK v3)
//
// Read routes are public at the gateway; this handler enforces dataset visibility:
//   public dataset  -> anyone can read
//   private dataset -> only the owner (verified Cognito JWT) can read
// Write routes are protected by the API Gateway JWT authorizer, and the
// handler additionally enforces ownership.

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient, GetCommand, PutCommand, DeleteCommand,
  QueryCommand, BatchWriteCommand, UpdateCommand
} from "@aws-sdk/lib-dynamodb";
import { CognitoJwtVerifier } from "aws-jwt-verify";
import { randomUUID } from "node:crypto";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true }
});

const DATASETS_TABLE = process.env.DATASETS_TABLE;
const FEATURES_TABLE = process.env.FEATURES_TABLE;
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "").split(",").map(s => s.trim()).filter(Boolean);

const verifier = CognitoJwtVerifier.create({
  userPoolId: process.env.USER_POOL_ID,
  clientId: process.env.USER_POOL_CLIENT_ID,
  tokenUse: "access"
});

const GEOMETRY_TYPES = new Set(["Point", "MultiPoint", "LineString", "MultiLineString", "Polygon", "MultiPolygon"]);
const VISIBILITIES = new Set(["public", "private"]);

// ------------------------------------------------------------------ helpers

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function corsHeaders(event) {
  const origin = event.headers?.origin || event.headers?.Origin;
  const h = { "Content-Type": "application/json", "Vary": "Origin" };
  if (origin && ALLOWED_ORIGINS.includes(origin)) h["Access-Control-Allow-Origin"] = origin;
  return h;
}

function respond(event, status, body) {
  return { statusCode: status, headers: corsHeaders(event), body: body === undefined ? "" : JSON.stringify(body) };
}

function parseBody(event) {
  if (!event.body) throw new HttpError(400, "Request body is required");
  const raw = event.isBase64Encoded ? Buffer.from(event.body, "base64").toString("utf8") : event.body;
  try { return JSON.parse(raw); } catch { throw new HttpError(400, "Body must be valid JSON"); }
}

function parseLimit(raw, def = 500, max = 1000) {
  const n = Number(raw);
  if (!raw || !Number.isFinite(n) || n <= 0) return def;
  return Math.min(max, Math.floor(n));
}

function encodeToken(key) { return key ? Buffer.from(JSON.stringify(key)).toString("base64url") : undefined; }
function decodeToken(raw) {
  if (!raw) return undefined;
  try { return JSON.parse(Buffer.from(raw, "base64url").toString("utf8")); }
  catch { throw new HttpError(400, "Invalid nextToken"); }
}

// Caller identity: from the gateway authorizer on protected routes,
// or verified here from an optional Bearer token on public routes.
async function getCaller(event, { required }) {
  const claims = event.requestContext?.authorizer?.jwt?.claims;
  if (claims?.sub) return { sub: claims.sub };

  const auth = event.headers?.authorization || event.headers?.Authorization;
  if (auth?.startsWith("Bearer ")) {
    try {
      const payload = await verifier.verify(auth.slice(7));
      return { sub: payload.sub };
    } catch {
      throw new HttpError(401, "Invalid or expired token");
    }
  }
  if (required) throw new HttpError(401, "Sign-in required");
  return null;
}

async function loadDataset(datasetId) {
  const { Item } = await ddb.send(new GetCommand({ TableName: DATASETS_TABLE, Key: { datasetId } }));
  if (!Item) throw new HttpError(404, "Dataset not found");
  return Item;
}

// Private datasets answer 404 to non-owners so their existence is not leaked.
function assertCanRead(dataset, caller) {
  if (dataset.visibility === "public") return;
  if (caller && caller.sub === dataset.ownerId) return;
  throw new HttpError(404, "Dataset not found");
}

function assertOwner(dataset, caller) {
  if (!caller || caller.sub !== dataset.ownerId) throw new HttpError(403, "Only the dataset owner can modify it");
}

function datasetView(d) {
  return {
    datasetId: d.datasetId, name: d.name, description: d.description || "",
    visibility: d.visibility, ownerId: d.ownerId, source: d.source,
    featureCount: d.featureCount || 0, createdAt: d.createdAt, updatedAt: d.updatedAt
  };
}

function validateGeometry(g) {
  if (!g || typeof g !== "object" || !GEOMETRY_TYPES.has(g.type) || !Array.isArray(g.coordinates)) {
    throw new HttpError(400, `geometry must be a GeoJSON geometry of type ${[...GEOMETRY_TYPES].join(", ")}`);
  }
  if (g.type === "Point") {
    const [lng, lat] = g.coordinates;
    if (!Number.isFinite(lng) || !Number.isFinite(lat) || lng < -180 || lng > 180 || lat < -90 || lat > 90) {
      throw new HttpError(400, "Point coordinates must be [lng, lat] within valid ranges");
    }
  }
}

function featureItem(datasetId, featureId, body, existing) {
  if (!body || body.type !== "Feature") throw new HttpError(400, "Body must be a GeoJSON Feature");
  validateGeometry(body.geometry);
  const props = { ...(body.properties || {}) };
  if (!props.name || typeof props.name !== "string") throw new HttpError(400, "properties.name is required");
  delete props.id; delete props.datasetId; delete props.createdAt; delete props.updatedAt;
  const now = new Date().toISOString();
  return {
    datasetId, featureId,
    geometry: body.geometry,
    properties: props,
    createdAt: existing?.createdAt || now,
    updatedAt: now
  };
}

function toFeature(item) {
  return {
    type: "Feature",
    id: item.featureId,
    geometry: item.geometry,
    properties: {
      ...item.properties,
      id: item.featureId,
      datasetId: item.datasetId,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt
    }
  };
}

async function adjustCount(datasetId, delta) {
  await ddb.send(new UpdateCommand({
    TableName: DATASETS_TABLE, Key: { datasetId },
    UpdateExpression: "ADD featureCount :d SET updatedAt = :u",
    ExpressionAttributeValues: { ":d": delta, ":u": new Date().toISOString() }
  }));
}

// ------------------------------------------------------------------ datasets

async function listDatasets(event) {
  const caller = await getCaller(event, { required: false });
  const pub = await ddb.send(new QueryCommand({
    TableName: DATASETS_TABLE, IndexName: "byVisibility",
    KeyConditionExpression: "visibility = :v", ExpressionAttributeValues: { ":v": "public" }
  }));
  let items = pub.Items || [];
  if (caller) {
    const mine = await ddb.send(new QueryCommand({
      TableName: DATASETS_TABLE, IndexName: "byOwner",
      KeyConditionExpression: "ownerId = :o", ExpressionAttributeValues: { ":o": caller.sub }
    }));
    const seen = new Set(items.map(d => d.datasetId));
    items = items.concat((mine.Items || []).filter(d => !seen.has(d.datasetId)));
  }
  items.sort((a, b) => a.name.localeCompare(b.name));
  return { datasets: items.map(datasetView) };
}

async function createDataset(event) {
  const caller = await getCaller(event, { required: true });
  const body = parseBody(event);
  if (!body.name || typeof body.name !== "string") throw new HttpError(400, "name is required");
  const visibility = body.visibility || "private";
  if (!VISIBILITIES.has(visibility)) throw new HttpError(400, "visibility must be public or private");
  const now = new Date().toISOString();
  const item = {
    datasetId: randomUUID(), name: body.name.trim(), description: body.description || "",
    visibility, ownerId: caller.sub, source: body.source, featureCount: 0, createdAt: now, updatedAt: now
  };
  await ddb.send(new PutCommand({ TableName: DATASETS_TABLE, Item: item }));
  return datasetView(item);
}

async function updateDataset(event, datasetId) {
  const caller = await getCaller(event, { required: true });
  const ds = await loadDataset(datasetId);
  assertOwner(ds, caller);
  const body = parseBody(event);
  if (body.visibility !== undefined && !VISIBILITIES.has(body.visibility)) throw new HttpError(400, "visibility must be public or private");
  const next = {
    ...ds,
    name: typeof body.name === "string" && body.name.trim() ? body.name.trim() : ds.name,
    description: body.description ?? ds.description,
    visibility: body.visibility ?? ds.visibility,
    updatedAt: new Date().toISOString()
  };
  await ddb.send(new PutCommand({ TableName: DATASETS_TABLE, Item: next }));
  return datasetView(next);
}

async function deleteDataset(event, datasetId) {
  const caller = await getCaller(event, { required: true });
  const ds = await loadDataset(datasetId);
  assertOwner(ds, caller);
  // Delete all features, then the dataset record.
  let ExclusiveStartKey;
  do {
    const page = await ddb.send(new QueryCommand({
      TableName: FEATURES_TABLE, KeyConditionExpression: "datasetId = :d",
      ExpressionAttributeValues: { ":d": datasetId }, ProjectionExpression: "datasetId, featureId", ExclusiveStartKey
    }));
    const keys = page.Items || [];
    for (let i = 0; i < keys.length; i += 25) {
      await ddb.send(new BatchWriteCommand({
        RequestItems: { [FEATURES_TABLE]: keys.slice(i, i + 25).map(Key => ({ DeleteRequest: { Key } })) }
      }));
    }
    ExclusiveStartKey = page.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  await ddb.send(new DeleteCommand({ TableName: DATASETS_TABLE, Key: { datasetId } }));
  return undefined;
}

// ------------------------------------------------------------------ features

async function listFeatures(event, datasetId) {
  const caller = await getCaller(event, { required: false });
  const ds = await loadDataset(datasetId);
  assertCanRead(ds, caller);
  const qs = event.queryStringParameters || {};
  const res = await ddb.send(new QueryCommand({
    TableName: FEATURES_TABLE, KeyConditionExpression: "datasetId = :d",
    ExpressionAttributeValues: { ":d": datasetId },
    Limit: parseLimit(qs.limit), ExclusiveStartKey: decodeToken(qs.nextToken)
  }));
  const fc = { type: "FeatureCollection", features: (res.Items || []).map(toFeature) };
  const nextToken = encodeToken(res.LastEvaluatedKey);
  if (nextToken) fc.nextToken = nextToken;
  return fc;
}

async function getFeature(event, datasetId, featureId) {
  const caller = await getCaller(event, { required: false });
  const ds = await loadDataset(datasetId);
  assertCanRead(ds, caller);
  const { Item } = await ddb.send(new GetCommand({ TableName: FEATURES_TABLE, Key: { datasetId, featureId } }));
  if (!Item) throw new HttpError(404, "Feature not found");
  return toFeature(Item);
}

async function createFeature(event, datasetId) {
  const caller = await getCaller(event, { required: true });
  const ds = await loadDataset(datasetId);
  assertOwner(ds, caller);
  const item = featureItem(datasetId, randomUUID(), parseBody(event));
  await ddb.send(new PutCommand({ TableName: FEATURES_TABLE, Item: item }));
  await adjustCount(datasetId, 1);
  return toFeature(item);
}

async function updateFeature(event, datasetId, featureId) {
  const caller = await getCaller(event, { required: true });
  const ds = await loadDataset(datasetId);
  assertOwner(ds, caller);
  const { Item: existing } = await ddb.send(new GetCommand({ TableName: FEATURES_TABLE, Key: { datasetId, featureId } }));
  if (!existing) throw new HttpError(404, "Feature not found");
  const item = featureItem(datasetId, featureId, parseBody(event), existing);
  await ddb.send(new PutCommand({ TableName: FEATURES_TABLE, Item: item }));
  return toFeature(item);
}

async function deleteFeature(event, datasetId, featureId) {
  const caller = await getCaller(event, { required: true });
  const ds = await loadDataset(datasetId);
  assertOwner(ds, caller);
  const { Attributes } = await ddb.send(new DeleteCommand({
    TableName: FEATURES_TABLE, Key: { datasetId, featureId }, ReturnValues: "ALL_OLD"
  }));
  if (!Attributes) throw new HttpError(404, "Feature not found");
  await adjustCount(datasetId, -1);
  return undefined;
}

// ------------------------------------------------------------------ router

export const handler = async (event) => {
  const routeKey = event.routeKey; // e.g. "GET /v1/datasets/{datasetId}/features"
  const p = event.pathParameters || {};
  try {
    let result, status = 200;
    switch (routeKey) {
      case "GET /v1/datasets": result = await listDatasets(event); break;
      case "POST /v1/datasets": result = await createDataset(event); status = 201; break;
      case "GET /v1/datasets/{datasetId}": {
        const caller = await getCaller(event, { required: false });
        const ds = await loadDataset(p.datasetId);
        assertCanRead(ds, caller);
        result = datasetView(ds); break;
      }
      case "PATCH /v1/datasets/{datasetId}": result = await updateDataset(event, p.datasetId); break;
      case "DELETE /v1/datasets/{datasetId}": result = await deleteDataset(event, p.datasetId); status = 204; break;
      case "GET /v1/datasets/{datasetId}/features": result = await listFeatures(event, p.datasetId); break;
      case "POST /v1/datasets/{datasetId}/features": result = await createFeature(event, p.datasetId); status = 201; break;
      case "GET /v1/datasets/{datasetId}/features/{featureId}": result = await getFeature(event, p.datasetId, p.featureId); break;
      case "PUT /v1/datasets/{datasetId}/features/{featureId}": result = await updateFeature(event, p.datasetId, p.featureId); break;
      case "DELETE /v1/datasets/{datasetId}/features/{featureId}": result = await deleteFeature(event, p.datasetId, p.featureId); status = 204; break;
      default: throw new HttpError(404, `No route for ${routeKey}`);
    }
    return respond(event, status, result);
  } catch (err) {
    if (err instanceof HttpError) return respond(event, err.status, { message: err.message });
    console.error("Unhandled error", err);
    return respond(event, 500, { message: "Internal error" });
  }
};
