// GeoVive API — datasets + features (Node.js 22, AWS SDK v3)
//
// Read routes are public at the gateway; this handler enforces dataset visibility:
//   public dataset  -> anyone can read
//   private dataset -> only the owner (verified Cognito JWT) can read
// Write routes are protected by the API Gateway JWT authorizer, and the
// handler additionally enforces ownership.

import "./safelog.mjs";   // first: keeps personal information out of logs
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient, GetCommand, PutCommand, DeleteCommand,
  QueryCommand, BatchWriteCommand, UpdateCommand
} from "@aws-sdk/lib-dynamodb";
import {
  S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, HeadObjectCommand,
  ListObjectsV2Command, DeleteObjectsCommand
} from "@aws-sdk/client-s3";
import { CognitoJwtVerifier } from "aws-jwt-verify";
import { randomUUID } from "node:crypto";
import { gzipSync } from "node:zlib";
import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { originAllowed } from "./apps.mjs";
import { getActiveApp } from "./appstore.mjs";
import * as appconnect from "./appconnect.mjs";
import { fetchLayerList, layerHash } from "./appcheck.mjs";
import { cleanTags, searchTextOf, searchPublic, MetaError } from "./search.mjs";
import { loadApproved, visibleLayers } from "./approvals.mjs";
import { promises as dns } from "node:dns";
import { FORMATS, render as renderExport, fileName as exportFileName } from "./export.mjs";
import { validateLayerList, publicLayer, buildLayer, LayerListError } from "./overlays.mjs";
import {
  GeometryError, validateGeometry, bboxOf, byteSize, simplifyToFit,
  INLINE_LIMIT, MAX_GEOMETRY
} from "./geometry.mjs";

export const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true }
});

const DATASETS_TABLE = process.env.DATASETS_TABLE;
const FEATURES_TABLE = process.env.FEATURES_TABLE;
const GEOMETRY_BUCKET = process.env.GEOMETRY_BUCKET;
const IMPORTS_TABLE = process.env.IMPORTS_TABLE;
const IMPORT_FUNCTION = process.env.IMPORT_FUNCTION;
const APPCHECK_FUNCTION = process.env.APPCHECK_FUNCTION;
const lambda = new LambdaClient({});
const s3 = new S3Client({});
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "").split(",").map(s => s.trim()).filter(Boolean);

const verifier = CognitoJwtVerifier.create({
  userPoolId: process.env.USER_POOL_ID,
  clientId: process.env.USER_POOL_CLIENT_ID,
  tokenUse: "access"
});

const VISIBILITIES = new Set(["public", "private"]);

// ------------------------------------------------------------------ helpers

export class HttpError extends Error {
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

export async function loadDataset(datasetId) {
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

export function datasetView(d) {
  return {
    datasetId: d.datasetId, name: d.name, description: d.description || "", tags: d.tags || [],
    visibility: d.visibility, ownerId: d.ownerId, source: d.source,
    origin: d.origin, referenceArea: d.referenceArea, featureTypes: d.featureTypes,
    featureCount: d.featureCount || 0, imports: d.imports, createdAt: d.createdAt, updatedAt: d.updatedAt
  };
}

// Large geometries live in S3; the table keeps a simplified preview.
const geometryKey = (datasetId, featureId) => `geometry/${datasetId}/${featureId}.json`;

export async function featureItem(datasetId, featureId, body, existing) {
  if (!body || body.type !== "Feature") throw new HttpError(400, "Body must be a GeoJSON Feature");
  try { validateGeometry(body.geometry); } catch (e) {
    if (e instanceof GeometryError) throw new HttpError(400, e.message);
    throw e;
  }
  const props = { ...(body.properties || {}) };
  if (!props.name || typeof props.name !== "string") throw new HttpError(400, "properties.name is required");
  delete props.id; delete props.datasetId; delete props.createdAt; delete props.updatedAt;
  delete props.geometryDetail;
  const now = new Date().toISOString();
  const item = {
    datasetId, featureId,
    geometry: body.geometry,
    properties: props,
    createdAt: existing?.createdAt || now,
    updatedAt: now
  };
  if (body.geometry.type !== "Point") item.bbox = bboxOf(body.geometry);

  const size = byteSize(body.geometry);
  if (size > MAX_GEOMETRY) throw new HttpError(413, `geometry is too large (${size} bytes; limit ${MAX_GEOMETRY})`);
  if (size > INLINE_LIMIT) {
    const key = geometryKey(datasetId, featureId);
    await s3.send(new PutObjectCommand({
      Bucket: GEOMETRY_BUCKET, Key: key, Body: JSON.stringify(body.geometry),
      ContentType: "application/geo+json"
    }));
    item.geometry = simplifyToFit(body.geometry);
    item.geometryRef = { key, bytes: size };
  } else if (existing?.geometryRef) {
    await deleteStoredGeometry(existing);   // shape got small again
  }
  return item;
}

async function deleteStoredGeometry(item) {
  if (item?.geometryRef?.key) {
    await s3.send(new DeleteObjectCommand({ Bucket: GEOMETRY_BUCKET, Key: item.geometryRef.key }));
  }
}

async function loadFullGeometry(item) {
  const res = await s3.send(new GetObjectCommand({ Bucket: GEOMETRY_BUCKET, Key: item.geometryRef.key }));
  return JSON.parse(await res.Body.transformToString());
}

// `full`: geometry to return in place of the stored preview.
function toFeature(item, full) {
  const f = {
    type: "Feature",
    id: item.featureId,
    geometry: full || item.geometry,
    properties: {
      ...item.properties,
      id: item.featureId,
      datasetId: item.datasetId,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt
    }
  };
  if (item.bbox) f.bbox = item.bbox;
  if (item.geometryRef) f.properties.geometryDetail = full ? "full" : "simplified";
  return f;
}

export async function adjustCount(datasetId, delta) {
  await ddb.send(new UpdateCommand({
    TableName: DATASETS_TABLE, Key: { datasetId },
    UpdateExpression: "ADD featureCount :d SET updatedAt = :u",
    ExpressionAttributeValues: { ":d": delta, ":u": new Date().toISOString() }
  }));
}

// ------------------------------------------------------------------ datasets

async function queryAll(input) {
  const items = []; let key;
  do {
    const res = await ddb.send(new QueryCommand({ ...input, ExclusiveStartKey: key }));
    items.push(...(res.Items || [])); key = res.LastEvaluatedKey;
  } while (key);
  return items;
}

// GET /v1/datasets            public datasets + the caller's own (all pages)
// GET /v1/datasets?scope=mine the caller's own, plus any ids=a,b,c they can read
//                             (the map uses this: search finds public maps)
async function listDatasets(event) {
  const caller = await getCaller(event, { required: false });
  const q = event.queryStringParameters || {};
  const mine = caller ? await queryAll({
    TableName: DATASETS_TABLE, IndexName: "byOwner",
    KeyConditionExpression: "ownerId = :o", ExpressionAttributeValues: { ":o": caller.sub }
  }) : [];
  let items;
  if (q.scope === "mine") {
    const ids = [...new Set(String(q.ids || "").split(",").map(x => x.trim()).filter(Boolean))].slice(0, 25);
    const have = new Set(mine.map(d => d.datasetId));
    const extra = await Promise.all(ids.filter(id => !have.has(id)).map(async id => {
      const { Item } = await ddb.send(new GetCommand({ TableName: DATASETS_TABLE, Key: { datasetId: id } }));
      return Item && (Item.visibility === "public" || Item.ownerId === caller?.sub) ? Item : null;
    }));
    items = mine.concat(extra.filter(Boolean));
  } else {
    const pub = await queryAll({
      TableName: DATASETS_TABLE, IndexName: "byVisibility",
      KeyConditionExpression: "visibility = :v", ExpressionAttributeValues: { ":v": "public" }
    });
    const seen = new Set(pub.map(d => d.datasetId));
    items = pub.concat(mine.filter(d => !seen.has(d.datasetId)));
  }
  items.sort((a, b) => a.name.localeCompare(b.name));
  return { datasets: items.map(datasetView) };
}

// GET /v1/datasets/search?q=&tag=&limit=  public datasets by name, description and tags
async function searchDatasets(event) {
  const q = event.queryStringParameters || {};
  const out = await searchPublic(ddb, DATASETS_TABLE, { q: String(q.q || "").slice(0, 100), tag: q.tag, limit: parseLimit(q.limit, 20, 50) });
  return { ...out, results: out.results.map(datasetView) };
}

function metaFields(body, existing = {}) {
  const out = {};
  if (body.description !== undefined) {
    if (typeof body.description !== "string") throw new HttpError(400, "description must be text");
    out.description = body.description.trim().slice(0, 1000);
  }
  try { const t = cleanTags(body.tags); if (t !== undefined) out.tags = t; }
  catch (e) { if (e instanceof MetaError) throw new HttpError(400, e.message); throw e; }
  return out;
}

async function createDataset(event) {
  const caller = await getCaller(event, { required: true });
  const body = parseBody(event);
  if (!body.name || typeof body.name !== "string") throw new HttpError(400, "name is required");
  const visibility = body.visibility || "private";
  if (!VISIBILITIES.has(visibility)) throw new HttpError(400, "visibility must be public or private");
  const now = new Date().toISOString();
  const meta = metaFields(body);
  const item = {
    datasetId: randomUUID(), name: body.name.trim().slice(0, 120), description: meta.description || "", tags: meta.tags || [],
    visibility, ownerId: caller.sub, source: body.source, featureCount: 0, createdAt: now, updatedAt: now
  };
  item.searchText = searchTextOf(item);
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
    ...metaFields(body, ds),
    name: typeof body.name === "string" && body.name.trim() ? body.name.trim().slice(0, 120) : ds.name,
    visibility: body.visibility ?? ds.visibility,
    updatedAt: new Date().toISOString()
  };
  next.searchText = searchTextOf(next);
  await ddb.send(new PutCommand({ TableName: DATASETS_TABLE, Item: next }));
  return datasetView(next);
}

async function deleteDataset(event, datasetId) {
  const caller = await getCaller(event, { required: true });
  const ds = await loadDataset(datasetId);
  assertOwner(ds, caller);
  await deleteAllFeatures(datasetId);
  await deleteDatasetGeometry(datasetId);
  await ddb.send(new DeleteCommand({ TableName: DATASETS_TABLE, Key: { datasetId } }));
  return undefined;
}

// Remove every feature of a dataset (table rows; call deleteDatasetGeometry for S3).
export async function deleteAllFeatures(datasetId) {
  let ExclusiveStartKey, removed = 0;
  do {
    const page = await ddb.send(new QueryCommand({
      TableName: FEATURES_TABLE, KeyConditionExpression: "datasetId = :d",
      ExpressionAttributeValues: { ":d": datasetId }, ProjectionExpression: "datasetId, featureId", ExclusiveStartKey
    }));
    const keys = page.Items || [];
    for (let i = 0; i < keys.length; i += 25) {
      await batchWrite(keys.slice(i, i + 25).map(Key => ({ DeleteRequest: { Key } })));
    }
    removed += keys.length;
    ExclusiveStartKey = page.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return removed;
}

// BatchWrite with retries for unprocessed items.
export async function batchWrite(requests) {
  let pending = requests, tries = 0;
  while (pending.length) {
    const res = await ddb.send(new BatchWriteCommand({ RequestItems: { [FEATURES_TABLE]: pending } }));
    pending = res.UnprocessedItems?.[FEATURES_TABLE] || [];
    if (pending.length) {
      if (++tries > 8) throw new Error("DynamoDB kept throttling the batch write");
      await new Promise(r => setTimeout(r, 100 * 2 ** tries));
    }
  }
}

export async function deleteDatasetGeometry(datasetId) {
  let ContinuationToken;
  do {
    const page = await s3.send(new ListObjectsV2Command({
      Bucket: GEOMETRY_BUCKET, Prefix: `geometry/${datasetId}/`, ContinuationToken
    }));
    const objects = (page.Contents || []).map(o => ({ Key: o.Key }));
    if (objects.length) {
      await s3.send(new DeleteObjectsCommand({ Bucket: GEOMETRY_BUCKET, Delete: { Objects: objects, Quiet: true } }));
    }
    ContinuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (ContinuationToken);
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
  const fc = { type: "FeatureCollection", features: (res.Items || []).map(item => toFeature(item)) };
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
  const qs = event.queryStringParameters || {};
  const full = Item.geometryRef && qs.detail !== "simplified" ? await loadFullGeometry(Item) : undefined;
  return toFeature(Item, full);
}

async function createFeature(event, datasetId) {
  const caller = await getCaller(event, { required: true });
  const ds = await loadDataset(datasetId);
  assertOwner(ds, caller);
  const item = await featureItem(datasetId, randomUUID(), parseBody(event));
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
  const item = await featureItem(datasetId, featureId, parseBody(event), existing);
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
  await deleteStoredGeometry(Attributes);
  await adjustCount(datasetId, -1);
  return undefined;
}

// ------------------------------------------------------------------ connected apps (phase 2)

function publicAppView(appId, app) {
  return {
    appId, name: app.name,
    returnOrigins: app.returnOrigins, areaOrigins: app.areaOrigins,
    featureTypes: app.featureTypes,
    hasLayers: !!(app.layers || app.layersUrl)
  };
}

async function getAppInfo(appId) {
  const app = await getActiveApp(ddb, appId);
  if (!app) throw new HttpError(404, "Unknown app");
  return publicAppView(appId, app);
}

// Find or create the signed-in user's map for one item in a connected app.
// owner + appId + externalRef is unique (GSI byOrigin on originKey).
async function openAppMap(event, appId, externalRef) {
  const caller = await getCaller(event, { required: true });
  const app = await getActiveApp(ddb, appId);
  if (!app) throw new HttpError(404, "Unknown app");
  if (!externalRef || externalRef.length > 200) throw new HttpError(400, "Invalid item reference");

  const body = event.body ? parseBody(event) : {};
  const title = typeof body.title === "string" && body.title.trim() ? body.title.trim().slice(0, 120) : null;
  const externalUrl = body.externalUrl;
  const referenceArea = body.referenceArea;
  if (externalUrl !== undefined && !originAllowed(externalUrl, app.returnOrigins)) {
    throw new HttpError(400, "externalUrl is not an allowed return address for this app");
  }
  if (referenceArea !== undefined && !originAllowed(referenceArea, app.areaOrigins)) {
    throw new HttpError(400, "referenceArea must be served from an allowed origin for this app");
  }

  const originKey = `${caller.sub}#${appId}#${externalRef}`;
  const found = await ddb.send(new QueryCommand({
    TableName: DATASETS_TABLE, IndexName: "byOrigin",
    KeyConditionExpression: "originKey = :k", ExpressionAttributeValues: { ":k": originKey }, Limit: 1
  }));
  const existing = found.Items?.[0];
  const now = new Date().toISOString();

  if (existing) {
    // Keep links fresh (the app's URL or area may change); never rename the user's map.
    const next = {
      ...existing,
      origin: { ...existing.origin, externalUrl: externalUrl ?? existing.origin?.externalUrl },
      referenceArea: referenceArea ?? existing.referenceArea,
      featureTypes: app.featureTypes,
      updatedAt: now
    };
    await ddb.send(new PutCommand({ TableName: DATASETS_TABLE, Item: next }));
    return { created: false, dataset: datasetView(next) };
  }

  const item = {
    datasetId: randomUUID(),
    name: title || `${app.name} – ${externalRef}`,
    description: `Created from ${app.name}`,
    visibility: "private",
    ownerId: caller.sub,
    origin: { appId, externalRef, externalUrl },
    originKey,
    referenceArea,
    featureTypes: app.featureTypes,
    featureCount: 0, createdAt: now, updatedAt: now, tags: []
  };
  item.searchText = searchTextOf(item);
  await ddb.send(new PutCommand({ TableName: DATASETS_TABLE, Item: item }));
  return { created: true, dataset: datasetView(item) };
}

// ------------------------------------------------------------------ imports
// Imports run in a separate worker (importer.mjs); these routes start and track them.

const IMPORT_SOURCES = new Set(["upload", "url", "arcgis"]);

async function createUploadUrl(event, datasetId) {
  const caller = await getCaller(event, { required: true });
  assertOwner(await loadDataset(datasetId), caller);
  const key = `uploads/${caller.sub}/${randomUUID()}.geojson`;
  const uploadUrl = await getSignedUrl(s3, new PutObjectCommand({
    Bucket: GEOMETRY_BUCKET, Key: key, ContentType: "application/geo+json"
  }), { expiresIn: 900 });
  return { key, uploadUrl, contentType: "application/geo+json", maxBytes: 50_000_000 };
}

function checkUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { throw new HttpError(400, "source.url must be a valid URL"); }
  if (u.protocol !== "https:") throw new HttpError(400, "source.url must use https");
  return u.toString();
}

async function startImport(event, datasetId) {
  const caller = await getCaller(event, { required: true });
  assertOwner(await loadDataset(datasetId), caller);
  const body = parseBody(event);
  const src = body.source || {};
  if (!IMPORT_SOURCES.has(src.type)) throw new HttpError(400, "source.type must be upload, url or arcgis");
  const source = { type: src.type };
  if (src.type === "upload") {
    if (typeof src.key !== "string" || !src.key.startsWith(`uploads/${caller.sub}/`)) throw new HttpError(400, "source.key is not one of your uploads");
    source.key = src.key;
    if (typeof src.fileName === "string") source.fileName = src.fileName.slice(0, 200);
  } else {
    source.url = checkUrl(src.url);
    if (src.type === "arcgis" && typeof src.where === "string" && src.where.trim()) source.where = src.where.slice(0, 1000);
  }
  const mode = body.mode === "replace" ? "replace" : "append";
  const str = (v) => typeof v === "string" && v.trim() ? v.trim().slice(0, 100) : undefined;
  const now = new Date();
  const job = {
    importId: randomUUID(), datasetId, ownerId: caller.sub, status: "queued", source, mode,
    nameField: str(body.nameField), categoryField: str(body.categoryField),
    createdAt: now.toISOString(), updatedAt: now.toISOString(),
    expiresAt: Math.floor(now.getTime() / 1000) + 30 * 86400
  };
  await ddb.send(new PutCommand({ TableName: IMPORTS_TABLE, Item: job }));
  await lambda.send(new InvokeCommand({
    FunctionName: IMPORT_FUNCTION, InvocationType: "Event",
    Payload: Buffer.from(JSON.stringify({ importId: job.importId }))
  }));
  return importView(job);
}

function importView(j) {
  return {
    importId: j.importId, datasetId: j.datasetId, status: j.status, source: j.source, mode: j.mode,
    nameField: j.nameField, categoryField: j.categoryField,
    imported: j.imported || 0, skipped: j.skipped || 0, errors: j.errors || [], message: j.message,
    createdAt: j.createdAt, updatedAt: j.updatedAt
  };
}

async function getImport(event, datasetId, importId) {
  const caller = await getCaller(event, { required: true });
  const { Item } = await ddb.send(new GetCommand({ TableName: IMPORTS_TABLE, Key: { importId } }));
  if (!Item || Item.datasetId !== datasetId || Item.ownerId !== caller.sub) throw new HttpError(404, "Import not found");
  return importView(Item);
}

// ------------------------------------------------------------------ exports
// Builds the file with full-detail geometry, stores it under exports/ (kept a
// day) and returns a short-lived download link. Anyone who can read the dataset
// can export it.

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); }
  }));
  return out;
}

async function exportDataset(event, datasetId) {
  const caller = await getCaller(event, { required: false });
  const ds = await loadDataset(datasetId);
  assertCanRead(ds, caller);
  const body = event.body ? parseBody(event) : {};
  const format = String(body.format || "geojson").toLowerCase();
  if (!FORMATS[format]) throw new HttpError(400, `format must be one of ${Object.keys(FORMATS).join(", ")}`);

  const items = [];
  let ExclusiveStartKey;
  do {
    const page = await ddb.send(new QueryCommand({
      TableName: FEATURES_TABLE, KeyConditionExpression: "datasetId = :d",
      ExpressionAttributeValues: { ":d": datasetId }, ExclusiveStartKey
    }));
    items.push(...(page.Items || []));
    ExclusiveStartKey = page.LastEvaluatedKey;
  } while (ExclusiveStartKey);

  const features = await mapLimit(items, 8, async (item) => {
    const f = toFeature(item, item.geometryRef ? await loadFullGeometry(item) : undefined);
    delete f.properties.geometryDetail;
    return f;
  });
  features.sort((a, b) => String(a.properties.name).localeCompare(String(b.properties.name)));

  const { ext, type } = FORMATS[format];
  const name = exportFileName(ds.name, ext);
  const key = `exports/${datasetId}/${randomUUID()}/${name}`;
  const content = renderExport(format, ds, features);
  await s3.send(new PutObjectCommand({
    Bucket: GEOMETRY_BUCKET, Key: key, Body: content, ContentType: type,
    ContentDisposition: `attachment; filename="${name}"`
  }));
  const url = await getSignedUrl(s3, new GetObjectCommand({ Bucket: GEOMETRY_BUCKET, Key: key }), { expiresIn: 3600 });
  return {
    format, fileName: name, featureCount: features.length, bytes: Buffer.byteLength(content),
    url, expiresAt: new Date(Date.now() + 3600_000).toISOString()
  };
}

// ------------------------------------------------------------------ app layers + relay
// Connected apps bring their own layers (see overlays.mjs). GeoVivé reads the
// app's layer list, shows those layers for the app's users, and relays the
// ones marked "relay" through a cached, simplified copy.

const LAYER_LIST_TTL_MS = 5 * 60 * 1000;
const layerLists = new Map();   // appId -> { at, list }

export async function loadAppLayers(appId) {
  const app = await getActiveApp(ddb, appId);
  if (!app) throw new HttpError(404, "Unknown app");
  if (!app.layers && !app.layersUrl) return { title: undefined, layers: [] };
  const hit = layerLists.get(appId);
  if (hit && Date.now() - hit.at < LAYER_LIST_TTL_MS) return hit.list;
  if (app.ownerId) return loadApprovedLayers(app, hit);
  let json = app.layers;
  if (!json) {
    // The list must live on the app's own site
    if (!originAllowed(app.layersUrl, app.returnOrigins) || !app.layersUrl.startsWith("https://")) {
      throw new HttpError(500, "App layer list address is not on the app's site");
    }
    try {
      const res = await fetch(app.layersUrl, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      json = await res.json();
    } catch (e) {
      if (hit) return hit.list;   // keep serving the last good list
      throw new HttpError(502, `${app.name}'s layer list couldn't be loaded (${e.message})`);
    }
  }
  let list;
  try { list = validateLayerList(json); }
  catch (e) {
    if (e instanceof LayerListError) throw new HttpError(502, `${app.name}'s layer list is invalid: ${e.message}`);
    throw e;
  }
  layerLists.set(appId, { at: Date.now(), list });
  return list;
}

// Self-service apps: users see only approved layer versions. A new or changed
// layer in the app's list is checked automatically before it's shown.
async function loadApprovedLayers(app, hit) {
  let list = null;
  try {
    list = await fetchLayerList(app, { fetch, lookup: dns.lookup });
  } catch (e) { console.warn("Layer list unavailable; serving approved layers", app.appId, e.message); }
  const approved = await loadApproved(s3, app.appId);
  const out = { title: list?.title, layers: visibleLayers(approved, list) };
  if (list) {
    try {
      await appconnect.detectChanges(ddb, app, list, payload => lambda.send(new InvokeCommand({
        FunctionName: APPCHECK_FUNCTION, InvocationType: "Event", Payload: Buffer.from(JSON.stringify(payload)) })));
    } catch (e) { console.error("Change detection failed", app.appId, e); }
  }
  layerLists.set(app.appId, { at: Date.now(), list: out });
  return out;
}

async function getAppLayers(appId) {
  const app = await getActiveApp(ddb, appId);
  const list = await loadAppLayers(appId);
  return { appId, appName: app.name, title: list.title, layers: list.layers.map(publicLayer) };
}

async function relayLayer(appId, layerId) {
  const list = await loadAppLayers(appId);
  const layer = list.layers.find(l => l.id === layerId);
  if (!layer) throw new HttpError(404, "Unknown layer");
  if (layer.delivery !== "relay") throw new HttpError(400, "This layer loads directly from its source");
  const key = `overlays/v3/${appId}/${layerId}-${layerHash(layer)}.geojson`;   // a new approved version gets a new cache
  let fetchedAt, count;
  try {
    const head = await s3.send(new HeadObjectCommand({ Bucket: GEOMETRY_BUCKET, Key: key }));
    if (Date.now() - head.LastModified.getTime() < layer.cacheHours * 3600_000) fetchedAt = head.LastModified.toISOString();
  } catch { /* not cached yet */ }
  if (!fetchedAt) {
    let fc;
    try { fc = await buildLayer(layer); }
    catch (e) { console.error("Relay failed", appId, layerId, e); throw new HttpError(502, `The source for this layer isn't responding (${e.message})`); }
    await s3.send(new PutObjectCommand({
      Bucket: GEOMETRY_BUCKET, Key: key, Body: gzipSync(JSON.stringify(fc)), ContentType: "application/geo+json",
      ContentEncoding: "gzip", CacheControl: "public, max-age=3600"
    }));
    fetchedAt = fc.geovive.fetchedAt; count = fc.features.length;
  }
  const url = await getSignedUrl(s3, new GetObjectCommand({ Bucket: GEOMETRY_BUCKET, Key: key }), { expiresIn: 3600 });
  return { appId, layerId, url, fetchedAt, count };
}

const html = body => ({ statusCode: 200, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store",
  "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action https://api.geovive.link", "X-Frame-Options": "DENY" }, body });

// ------------------------------------------------------------------ router

export const handler = async (event) => {
  const routeKey = event.routeKey; // e.g. "GET /v1/datasets/{datasetId}/features"
  const p = event.pathParameters || {};
  try {
    let result, status = 200;
    switch (routeKey) {
      case "GET /v1/datasets": result = await listDatasets(event); break;
      case "GET /v1/datasets/search": result = await searchDatasets(event); break;
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
      case "GET /v1/apps/{appId}/layers": result = await getAppLayers(p.appId); break;
      case "GET /v1/relay/{appId}/{layerId}": result = await relayLayer(p.appId, p.layerId); break;
      case "POST /v1/datasets/{datasetId}/exports": result = await exportDataset(event, p.datasetId); break;
      case "POST /v1/datasets/{datasetId}/imports/upload-url": result = await createUploadUrl(event, p.datasetId); break;
      case "POST /v1/datasets/{datasetId}/imports": result = await startImport(event, p.datasetId); status = 202; break;
      case "GET /v1/datasets/{datasetId}/imports/{importId}": result = await getImport(event, p.datasetId, p.importId); break;
      case "GET /v1/apps/{appId}": result = await getAppInfo(p.appId); break;
      case "PUT /v1/apps/{appId}/maps/{externalRef}": {
        const out = await openAppMap(event, p.appId, p.externalRef);
        result = out.dataset; status = out.created ? 201 : 200; break;
      }
      case "POST /v1/appconnect/apps":
        result = await appconnect.signup(ddb, await getCaller(event, { required: true }), parseBody(event)); status = 201; break;
      case "GET /v1/appconnect/apps":
        result = await appconnect.listMine(ddb, await getCaller(event, { required: true })); break;
      case "GET /v1/appconnect/apps/{appId}":
        result = await appconnect.getMine(ddb, await getCaller(event, { required: true }), p.appId); break;
      case "POST /v1/appconnect/apps/{appId}/checks":
        result = await appconnect.requestChecks(ddb, await getCaller(event, { required: true }), p.appId,
          payload => lambda.send(new InvokeCommand({ FunctionName: APPCHECK_FUNCTION, InvocationType: "Event", Payload: Buffer.from(JSON.stringify(payload)) })));
        status = 202; break;
      case "GET /v1/appconnect/apps/{appId}/reports/{reportId}":
        result = await appconnect.reportLink(ddb, s3, await getCaller(event, { required: true }), p.appId, p.reportId); break;
      case "POST /v1/appconnect/apps/{appId}/disconnect":
        result = await appconnect.requestDisconnect(ddb, s3, await getCaller(event, { required: true }), p.appId, parseBody(event)); break;
      case "DELETE /v1/appconnect/apps/{appId}/disconnect":
        result = await appconnect.cancelScheduledDisconnect(ddb, await getCaller(event, { required: true }), p.appId); break;
      case "POST /v1/appconnect/apps/{appId}/reconnect":
        result = await appconnect.reconnect(ddb, await getCaller(event, { required: true }), p.appId); break;
      case "GET /v1/appconnect/apps/{appId}/export":
        result = await appconnect.exportMine(ddb, await getCaller(event, { required: true }), p.appId); break;
      case "GET /v1/appconnect/review":
        return html(await appconnect.reviewPage(ddb, s3, event.queryStringParameters || {}));
      case "POST /v1/appconnect/review": {
        const raw = event.isBase64Encoded ? Buffer.from(event.body || "", "base64").toString("utf8") : (event.body || "");
        return html(await appconnect.reviewDecision(ddb, s3, Object.fromEntries(new URLSearchParams(raw))));
      }
      case "POST /v1/appconnect/stripe/webhook": {
        const raw = event.isBase64Encoded ? Buffer.from(event.body || "", "base64").toString("utf8") : (event.body || "");
        result = await appconnect.stripeWebhook(ddb, s3, raw, event.headers?.["stripe-signature"] || event.headers?.["Stripe-Signature"]);
        break;
      }
      default: throw new HttpError(404, `No route for ${routeKey}`);
    }
    return respond(event, status, result);
  } catch (err) {
    if (err instanceof HttpError || err instanceof appconnect.AppConnectError) return respond(event, err.status, { message: err.message });
    console.error("Unhandled error", err);
    return respond(event, 500, { message: "Internal error" });
  }
};
