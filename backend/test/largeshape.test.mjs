// Large shapes go to S3 with a simplified preview in DynamoDB (mocked SDKs).
import assert from "node:assert/strict";
process.env.USER_POOL_ID = "us-east-1_TEST123"; process.env.USER_POOL_CLIENT_ID = "abc";
process.env.DATASETS_TABLE = "d"; process.env.FEATURES_TABLE = "f"; process.env.GEOMETRY_BUCKET = "g";
process.env.ALLOWED_ORIGINS = "https://geovive.link";
const { bigPolygon } = await import("./geometry.test.mjs");
const { DynamoDBDocumentClient } = await import("@aws-sdk/lib-dynamodb");
const { S3Client } = await import("@aws-sdk/client-s3");

const datasets = { ds1: { datasetId: "ds1", name: "Units", visibility: "public", ownerId: "user-1" } };
let features = {};
const objects = {};
DynamoDBDocumentClient.prototype.send = async function (c) {
  const n = c.constructor.name, i = c.input;
  if (i.TableName === "d" && n === "GetCommand") return { Item: datasets[i.Key.datasetId] };
  if (i.TableName === "d") return {};
  const k = x => `${x.datasetId}/${x.featureId}`;
  if (n === "PutCommand") { features[k(i.Item)] = structuredClone(i.Item); return {}; }
  if (n === "GetCommand") return { Item: features[k(i.Key)] };
  if (n === "QueryCommand") return { Items: Object.values(features) };
  if (n === "DeleteCommand") { const old = features[k(i.Key)]; delete features[k(i.Key)]; return { Attributes: old }; }
  if (n === "BatchWriteCommand") { i.RequestItems.f.forEach(r => delete features[k(r.DeleteRequest.Key)]); return {}; }
  return {};
};
S3Client.prototype.send = async function (c) {
  const n = c.constructor.name, i = c.input;
  if (n === "PutObjectCommand") { objects[i.Key] = i.Body; return {}; }
  if (n === "GetObjectCommand") return { Body: { transformToString: async () => objects[i.Key] } };
  if (n === "DeleteObjectCommand") { delete objects[i.Key]; return {}; }
  if (n === "ListObjectsV2Command") return { Contents: Object.keys(objects).filter(x => x.startsWith(i.Prefix)).map(Key => ({ Key })) };
  if (n === "DeleteObjectsCommand") { i.Delete.Objects.forEach(o => delete objects[o.Key]); return {}; }
  return {};
};
const { handler } = await import("../src/handler.mjs");
const ev = (routeKey, pathParameters, body, qs) => ({
  routeKey, pathParameters, queryStringParameters: qs, headers: { origin: "https://geovive.link" },
  requestContext: { authorizer: { jwt: { claims: { sub: "user-1" } } } },
  body: body && JSON.stringify(body)
});
const call = async (...a) => { const r = await handler(ev(...a)); return { status: r.statusCode, body: r.body ? JSON.parse(r.body) : undefined }; };

const big = bigPolygon();
const created = await call("POST /v1/datasets/{datasetId}/features", { datasetId: "ds1" },
  { type: "Feature", geometry: big, properties: { name: "Unit 61", category: "location" } });
assert.equal(created.status, 201, JSON.stringify(created.body).slice(0, 200));
const id = created.body.id;
assert.equal(Object.keys(objects).length, 1, "full shape stored in S3");
const stored = features[`ds1/${id}`];
assert.ok(stored.geometryRef && JSON.stringify(stored.geometry).length <= 60000, "table keeps a small preview");
assert.equal(created.body.properties.geometryDetail, "simplified");
assert.equal(created.body.bbox.length, 4);

await call("POST /v1/datasets/{datasetId}/features", { datasetId: "ds1" },
  { type: "Feature", geometry: { type: "Point", coordinates: [-105, 39] }, properties: { name: "P1", category: "location" } });
await call("POST /v1/datasets/{datasetId}/features", { datasetId: "ds1" },
  { type: "Feature", geometry: { type: "Point", coordinates: [-104, 38] }, properties: { name: "P2", category: "location" } });
const list = await call("GET /v1/datasets/{datasetId}/features", { datasetId: "ds1" });
assert.equal(list.body.features.find(f => f.id === id).properties.geometryDetail, "simplified");
// Every feature in a list keeps its own geometry (regression: map index leaked in as "full")
list.body.features.forEach(f => assert.ok(Array.isArray(f.geometry?.coordinates), `geometry intact for ${f.properties.name}`));
assert.equal(list.body.features.length, 3);

const one = await call("GET /v1/datasets/{datasetId}/features/{featureId}", { datasetId: "ds1", featureId: id });
assert.equal(one.body.properties.geometryDetail, "full");
assert.equal(one.body.geometry.coordinates[0].length, big.coordinates[0].length, "full detail returned");

// Replace with a small shape: S3 copy removed
const small = await call("PUT /v1/datasets/{datasetId}/features/{featureId}", { datasetId: "ds1", featureId: id },
  { type: "Feature", geometry: { type: "Polygon", coordinates: [[[-106, 39], [-105, 39], [-105, 40], [-106, 39]]] }, properties: { name: "Unit 61", category: "location" } });
assert.equal(small.status, 200);
assert.equal(Object.keys(objects).length, 0);
assert.equal(small.body.properties.geometryDetail, undefined);

// Big again, then delete the feature: S3 copy removed
await call("PUT /v1/datasets/{datasetId}/features/{featureId}", { datasetId: "ds1", featureId: id },
  { type: "Feature", geometry: big, properties: { name: "Unit 61", category: "location" } });
assert.equal(Object.keys(objects).length, 1);
await call("DELETE /v1/datasets/{datasetId}/features/{featureId}", { datasetId: "ds1", featureId: id });
assert.equal(Object.keys(objects).length, 0);

// Dataset delete clears its S3 prefix
await call("POST /v1/datasets/{datasetId}/features", { datasetId: "ds1" }, { type: "Feature", geometry: big, properties: { name: "A" } });
await call("DELETE /v1/datasets/{datasetId}", { datasetId: "ds1" });
assert.equal(Object.keys(objects).length, 0);

// Bad geometry is a 400
const bad = await call("POST /v1/datasets/{datasetId}/features", { datasetId: "ds1" },
  { type: "Feature", geometry: { type: "Point", coordinates: [500, 0] }, properties: { name: "x" } });
assert.equal(bad.status, 400);
console.log("large shapes ok");
