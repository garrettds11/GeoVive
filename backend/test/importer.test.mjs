// Import worker tests with mocked DynamoDB, S3, Lambda and fetch.
import assert from "node:assert/strict";
process.env.USER_POOL_ID = "us-east-1_TEST123"; process.env.USER_POOL_CLIENT_ID = "abc";
Object.assign(process.env, { AWS_REGION: "us-east-1", AWS_ACCESS_KEY_ID: "test", AWS_SECRET_ACCESS_KEY: "test" });
Object.assign(process.env, { DATASETS_TABLE: "d", FEATURES_TABLE: "f", IMPORTS_TABLE: "i", GEOMETRY_BUCKET: "g",
  IMPORT_FUNCTION: "imp", ALLOWED_ORIGINS: "https://geovive.link" });

const { DynamoDBDocumentClient } = await import("@aws-sdk/lib-dynamodb");
const { S3Client } = await import("@aws-sdk/client-s3");
const { LambdaClient } = await import("@aws-sdk/client-lambda");
const { bigPolygon } = await import("./geometry.test.mjs");

const datasets = { ds1: { datasetId: "ds1", name: "Mine", visibility: "private", ownerId: "user-1", featureCount: 1 } };
let features = { "ds1/old": { datasetId: "ds1", featureId: "old", geometry: { type: "Point", coordinates: [0, 0] }, properties: { name: "old" } } };
const jobs = {}, objects = {}, invoked = [];
const key = x => `${x.datasetId}/${x.featureId}`;
const applyUpdate = (item, i) => {
  const names = i.ExpressionAttributeNames || {}, vals = i.ExpressionAttributeValues;
  const [setPart, addPart] = i.UpdateExpression.split(" ADD ");
  setPart.replace(/^SET /, "").split(", ").forEach(a => { const [l, r] = a.split(" = "); item[names[l] || l] = vals[r]; });
  if (addPart) { const [l, r] = addPart.split(" "); item[l] = (item[l] || 0) + vals[r]; }
};
DynamoDBDocumentClient.prototype.send = async function (c) {
  const n = c.constructor.name, i = c.input;
  if (i.TableName === "d") {
    if (n === "GetCommand") return { Item: datasets[i.Key.datasetId] };
    if (n === "UpdateCommand") { applyUpdate(datasets[i.Key.datasetId], i); return {}; }
    return {};
  }
  if (i.TableName === "i") {
    if (n === "PutCommand") { jobs[i.Item.importId] = structuredClone(i.Item); return {}; }
    if (n === "GetCommand") return { Item: jobs[i.Key.importId] && structuredClone(jobs[i.Key.importId]) };
    if (n === "UpdateCommand") { applyUpdate(jobs[i.Key.importId], i); return {}; }
  }
  if (n === "QueryCommand") return { Items: Object.values(features).filter(f => f.datasetId === i.ExpressionAttributeValues[":d"]) };
  if (n === "BatchWriteCommand") {
    i.RequestItems.f.forEach(r => {
      if (r.PutRequest) features[key(r.PutRequest.Item)] = r.PutRequest.Item;
      if (r.DeleteRequest) delete features[key(r.DeleteRequest.Key)];
    });
    return {};
  }
  return {};
};
S3Client.prototype.send = async function (c) {
  const n = c.constructor.name, i = c.input;
  if (n === "PutObjectCommand") { objects[i.Key] = i.Body; return {}; }
  if (n === "HeadObjectCommand") { if (!(i.Key in objects)) throw new Error("NotFound"); return { ContentLength: objects[i.Key].length }; }
  if (n === "GetObjectCommand") return { Body: { transformToString: async () => objects[i.Key] } };
  if (n === "DeleteObjectCommand") { delete objects[i.Key]; return {}; }
  if (n === "ListObjectsV2Command") return { Contents: Object.keys(objects).filter(k => k.startsWith(i.Prefix)).map(Key => ({ Key })) };
  if (n === "DeleteObjectsCommand") { i.Delete.Objects.forEach(o => delete objects[o.Key]); return {}; }
  return {};
};
LambdaClient.prototype.send = async function (c) { invoked.push(JSON.parse(Buffer.from(c.input.Payload).toString())); return {}; };

// Fake outside servers
const routes = {};
globalThis.fetch = async (url) => {
  const hit = Object.keys(routes).find(p => url.startsWith(p));
  if (!hit) return new Response("nope", { status: 404 });
  const body = routes[hit](url);
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
};

const { handler } = await import("../src/handler.mjs");
const importer = await import("../src/importer.mjs");
const ev = (routeKey, pathParameters, body, sub = "user-1") => ({
  routeKey, pathParameters, headers: { origin: "https://geovive.link" },
  requestContext: { authorizer: { jwt: { claims: { sub } } } }, body: body && JSON.stringify(body)
});
const call = async (...a) => { const r = await handler(ev(...a)); return { status: r.statusCode, body: r.body ? JSON.parse(r.body) : undefined }; };
const P = { datasetId: "ds1" };

// Helpers
assert.equal(importer.pickName({ NAME: "Unit 61" }, undefined, 0), "Unit 61");
assert.equal(importer.pickName({ foo: 1 }, undefined, 4), "Feature 5");
assert.equal(importer.pickName({ GMU: 61 }, "GMU", 0), "61");
assert.equal(importer.pickName({ forestname: "San Juan National Forest", region: "02" }, undefined, 0), "San Juan National Forest");
assert.equal(importer.pickName({ forestname: "San Juan" }, "FORESTNAME", 0), "San Juan");
assert.equal(importer.arcgisLayerUrl("https://x.gov/arcgis/rest/services/A/FeatureServer/3/query?where=1"), "https://x.gov/arcgis/rest/services/A/FeatureServer/3");
assert.throws(() => importer.arcgisLayerUrl("https://x.gov/arcgis/rest/services/A/FeatureServer"), /layer/);
assert.throws(() => importer.toFeatures({ type: "FeatureCollection", crs: { properties: { name: "EPSG:3857" } }, features: [] }), /WGS 84/);

// Validation at the API
assert.equal((await call("POST /v1/datasets/{datasetId}/imports", P, { source: { type: "url", url: "http://insecure.example/a.json" } })).status, 400);
assert.equal((await call("POST /v1/datasets/{datasetId}/imports", P, { source: { type: "upload", key: "uploads/someone-else/x.geojson" } })).status, 400);
assert.equal((await call("POST /v1/datasets/{datasetId}/imports", P, { source: { type: "url", url: "https://a.example/x" } }, "user-2")).status, 403);

// 1. GeoJSON URL, append: good features, one bad, one large shape
routes["https://data.example/units.geojson"] = () => ({
  type: "FeatureCollection", features: [
    { type: "Feature", id: 7, geometry: { type: "Point", coordinates: [-105, 39] }, properties: { NAME: "Trailhead", kind: "access" } },
    { type: "Feature", geometry: { type: "Point", coordinates: [500, 39] }, properties: { NAME: "Bad" } },
    { type: "Feature", geometry: bigPolygon(20000), properties: { NAME: "Big unit", kind: "unit" } }
  ]
});
let r = await call("POST /v1/datasets/{datasetId}/imports", P, { source: { type: "url", url: "https://data.example/units.geojson" }, categoryField: "kind" });
assert.equal(r.status, 202, JSON.stringify(r.body));
assert.equal(invoked.at(-1).importId, r.body.importId);
await importer.handler({ importId: r.body.importId });
let job = (await call("GET /v1/datasets/{datasetId}/imports/{importId}", { ...P, importId: r.body.importId })).body;
assert.equal(job.status, "succeeded", job.message);
assert.equal(job.imported, 2); assert.equal(job.skipped, 1);
assert.match(job.errors[0], /Feature 2/);
assert.equal(datasets.ds1.featureCount, 3);                      // 1 existing + 2
assert.equal(datasets.ds1.imports[0].url, "https://data.example/units.geojson");
const trail = Object.values(features).find(f => f.properties.name === "Trailhead");
assert.equal(trail.properties.category, "location");            // not one of the three → location
assert.equal(trail.properties.externalId, "7");
assert.match(trail.properties.description, /\*\*Type:\*\* access/);   // original type kept in the description
assert.deepEqual(Object.keys(trail.properties).sort().filter(k => !["id"].includes(k)).every(k => ["name","category","description","externalId","source"].includes(k)), true);
assert.ok(Object.values(features).find(f => f.properties.name === "Big unit").geometryRef, "large shape stored in S3");
// Someone else can't read the job
assert.equal((await call("GET /v1/datasets/{datasetId}/imports/{importId}", { ...P, importId: r.body.importId }, undefined, "user-2")).status, 404);

// 2. ArcGIS layer with paging, replace mode
const layer = "https://gis.example.gov/arcgis/rest/services/Hunt/FeatureServer/0";
const all = Array.from({ length: 5 }, (_, k) => ({ type: "Feature", id: k + 1, geometry: { type: "Point", coordinates: [-106 + k * 0.1, 40] }, properties: { OBJECTID: k + 1, UNIT_NAME: `GMU ${k + 1}` } }));
routes[`${layer}?f=json`] = () => ({ type: "Feature Layer", name: "Hunt units", maxRecordCount: 2, copyrightText: "State wildlife agency", objectIdField: "OBJECTID", advancedQueryCapabilities: { supportsPagination: true } });
routes[`${layer}/query`] = (url) => {
  const u = new URL(url);
  const off = Number(u.searchParams.get("resultOffset")), n = Number(u.searchParams.get("resultRecordCount"));
  assert.equal(u.searchParams.get("outSR"), "4326");
  const page = all.slice(off, off + n);
  return { type: "FeatureCollection", features: page, exceededTransferLimit: off + n < all.length };
};
r = await call("POST /v1/datasets/{datasetId}/imports", P, { source: { type: "arcgis", url: `${layer}/query` }, mode: "replace" });
await importer.handler({ importId: r.body.importId });
job = jobs[r.body.importId];
assert.equal(job.status, "succeeded", job.message);
assert.equal(job.imported, 5);
assert.equal(Object.values(features).length, 5, "replace cleared the old features");
assert.equal(Object.keys(objects).filter(k => k.startsWith("geometry/")).length, 0, "old S3 shapes removed");
assert.equal(datasets.ds1.featureCount, 5);
assert.equal(datasets.ds1.imports[0].attribution, "State wildlife agency");
assert.equal(datasets.ds1.imports[0].title, "Hunt units");

// 3. Upload: presigned URL, then import; the upload is deleted afterwards
const up = await call("POST /v1/datasets/{datasetId}/imports/upload-url", P);
assert.equal(up.status, 200); assert.match(up.body.key, /^uploads\/user-1\//); assert.match(up.body.uploadUrl, /^https:\/\//);
objects[up.body.key] = JSON.stringify({ type: "Feature", geometry: { type: "LineString", coordinates: [[-105, 39], [-104, 40]] }, properties: { title: "Route" } });
r = await call("POST /v1/datasets/{datasetId}/imports", P, { source: { type: "upload", key: up.body.key, fileName: "route.geojson" } });
await importer.handler({ importId: r.body.importId });
assert.equal(jobs[r.body.importId].status, "succeeded", jobs[r.body.importId].message);
assert.ok(!(up.body.key in objects), "upload cleaned up");

// 4. Failures are reported, not thrown
r = await call("POST /v1/datasets/{datasetId}/imports", P, { source: { type: "url", url: "https://data.example/missing.json" } });
await importer.handler({ importId: r.body.importId });
assert.equal(jobs[r.body.importId].status, "failed");
assert.match(jobs[r.body.importId].message, /HTTP 404/);

console.log("importer ok");
