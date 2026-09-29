// Bulk delete / move / copy of features, with mocked DynamoDB and S3.
import assert from "node:assert/strict";
process.env.USER_POOL_ID = "us-east-1_TEST123"; process.env.USER_POOL_CLIENT_ID = "abc";
process.env.DATASETS_TABLE = "d"; process.env.FEATURES_TABLE = "f"; process.env.GEOMETRY_BUCKET = "g"; process.env.ALLOWED_ORIGINS = "https://geovive.link";
process.env.AWS_ACCESS_KEY_ID = "x"; process.env.AWS_SECRET_ACCESS_KEY = "y"; process.env.AWS_REGION = "us-east-1";
const { DynamoDBDocumentClient } = await import("@aws-sdk/lib-dynamodb");
const { S3Client } = await import("@aws-sdk/client-s3");
const ds = new Map([["pub", { datasetId: "pub", ownerId: "u1", visibility: "public", name: "Public", featureCount: 3 }],
  ["priv", { datasetId: "priv", ownerId: "u1", visibility: "private", name: "Private", featureCount: 0 }],
  ["other", { datasetId: "other", ownerId: "u2", visibility: "private", name: "Theirs", featureCount: 0 }]]);
const feats = new Map();
const pt = (id, name) => feats.set(`pub|${id}`, { datasetId: "pub", featureId: id, geometry: { type: "Point", coordinates: [1, 2] }, properties: { name, category: "location" } });
pt("a", "Home"); pt("b", "Work"); pt("c", "Gym");
const s3objs = new Map([["geometry/pub/c.json", JSON.stringify({ type: "Point", coordinates: [5, 6] })]]);
feats.get("pub|c").geometryRef = { key: "geometry/pub/c.json", bytes: 10 };
DynamoDBDocumentClient.prototype.send = async function (c) {
  const n = c.constructor.name, i = c.input;
  if (i.TableName === "d") {
    if (n === "GetCommand") return { Item: structuredClone(ds.get(i.Key.datasetId)) };
    if (n === "UpdateCommand") { ds.get(i.Key.datasetId).featureCount += i.ExpressionAttributeValues[":d"]; return {}; }
  }
  if (n === "GetCommand") return { Item: structuredClone(feats.get(`${i.Key.datasetId}|${i.Key.featureId}`)) };
  if (n === "PutCommand") { feats.set(`${i.Item.datasetId}|${i.Item.featureId}`, i.Item); return {}; }
  if (n === "DeleteCommand") { feats.delete(`${i.Key.datasetId}|${i.Key.featureId}`); return {}; }
  throw new Error("unexpected " + n);
};
S3Client.prototype.send = async function (c) {
  const n = c.constructor.name, i = c.input;
  if (n === "GetObjectCommand") return { Body: { transformToString: async () => s3objs.get(i.Key) } };
  if (n === "DeleteObjectCommand") { s3objs.delete(i.Key); return {}; }
  if (n === "PutObjectCommand") { s3objs.set(i.Key, i.Body); return {}; }
  return {};
};
const { handler } = await import("../src/handler.mjs");
const call = (datasetId, body, sub = "u1") => handler({ routeKey: "POST /v1/datasets/{datasetId}/features/batch", pathParameters: { datasetId },
  headers: { origin: "https://geovive.link" }, requestContext: { authorizer: { jwt: { claims: { sub } } } }, body: JSON.stringify(body) }).then(r => ({ status: r.statusCode, ...JSON.parse(r.body) }));

assert.equal((await call("pub", { action: "delete", ids: ["a"] }, "u2")).status, 403, "only the owner");
assert.equal((await call("pub", { action: "move", ids: ["a"], targetDatasetId: "other" })).status, 403, "target must be yours");
assert.equal((await call("pub", { action: "nuke", ids: ["a"] })).status, 400);
// move a (point) and c (large shape in S3) from the public map to the private one
let r = await call("pub", { action: "move", ids: ["a", "c", "zzz"], targetDatasetId: "priv" });
assert.deepEqual(r.done, ["a", "c"]); assert.equal(r.failed[0].id, "zzz");
assert.ok(!feats.has("pub|a") && !feats.has("pub|c"));
const moved = [...feats.values()].filter(f => f.datasetId === "priv");
assert.equal(moved.length, 2);
assert.deepEqual(moved.find(f => f.properties.name === "Gym").geometry.coordinates, [5, 6], "full geometry carried over");
assert.ok(!s3objs.has("geometry/pub/c.json"), "old geometry file removed");
assert.equal(ds.get("pub").featureCount, 1); assert.equal(ds.get("priv").featureCount, 2);
// copy keeps the source; delete removes
r = await call("pub", { action: "copy", ids: ["b"], targetDatasetId: "priv" });
assert.ok(feats.has("pub|b")); assert.equal(ds.get("priv").featureCount, 3);
r = await call("pub", { action: "delete", ids: ["b"] });
assert.deepEqual(r.done, ["b"]); assert.equal(ds.get("pub").featureCount, 0);
console.log("batch tests passed");
