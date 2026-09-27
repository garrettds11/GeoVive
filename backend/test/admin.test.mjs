// Admin API: group check, authenticator (TOTP) setup and sign-in, sessions, audited actions.
import assert from "node:assert/strict";
process.env.USER_POOL_ID = "us-east-1_TEST"; process.env.USER_POOL_CLIENT_ID = "abc";
process.env.DATASETS_TABLE = "d"; process.env.FEATURES_TABLE = "f"; process.env.GEOMETRY_BUCKET = "g"; process.env.ALLOWED_ORIGINS = "https://geovive.link";
process.env.ADMIN_TABLE = "adm"; process.env.APPS_TABLE = "apps";
process.env.AWS_ACCESS_KEY_ID = "x"; process.env.AWS_SECRET_ACCESS_KEY = "y"; process.env.AWS_REGION = "us-east-1";
const { DynamoDBDocumentClient } = await import("@aws-sdk/lib-dynamodb");
const { S3Client } = await import("@aws-sdk/client-s3");
const { CognitoIdentityProviderClient } = await import("@aws-sdk/client-cognito-identity-provider");
const { CostExplorerClient } = await import("@aws-sdk/client-cost-explorer");
const A = await import("../src/admin.mjs");
const AC = await import("../src/appconnect.mjs");
AC._setReviewSettings({ reviewKey: "test-key", reviewerEmail: "a@b.c" });

// TOTP matches the RFC 6238 test vector (SHA-1, T=59s → 94287082 → last 6 digits 287082)
const rfcSecret = A.base32(Buffer.from("12345678901234567890"));
assert.equal(A.totp(rfcSecret, 59_000), "287082");
assert.ok(A.checkTotp(rfcSecret, "287082", 59_000));
assert.ok(!A.checkTotp(rfcSecret, "000000", 59_000));

const tables = { d: new Map([["m1", { datasetId: "m1", name: "Family spots", ownerId: "u2", visibility: "public", featureCount: 1 }]]),
  f: new Map([["m1|p1", { datasetId: "m1", featureId: "p1", geometry: { type: "Point", coordinates: [1, 2] }, properties: { name: "Home", category: "location" } }]]),
  adm: new Map(), apps: new Map() };
const key = (t, K) => t === "d" ? K.datasetId : t === "f" ? `${K.datasetId}|${K.featureId}` : `${K.pk}|${K.sk}`;
DynamoDBDocumentClient.prototype.send = async function (c) {
  const n = c.constructor.name, i = c.input, T = tables[i.TableName];
  if (n === "GetCommand") return { Item: structuredClone(T.get(key(i.TableName, i.Key))) };
  if (n === "PutCommand") { T.set(key(i.TableName, i.Item), structuredClone(i.Item)); return {}; }
  if (n === "DeleteCommand") { T.delete(key(i.TableName, i.Key)); return {}; }
  if (n === "UpdateCommand") { const r = T.get(key(i.TableName, i.Key)); const v = i.ExpressionAttributeValues;
    if (v[":t"] === true) r.confirmed = true; if (v[":v"]) r.visibility = v[":v"]; return {}; }
  if (n === "ScanCommand") return { Items: [...T.values()] };
  if (n === "QueryCommand") {
    if (i.TableName === "adm") return { Items: [...T.values()].filter(x => x.pk === "AUDIT").sort((a, b) => b.sk.localeCompare(a.sk)) };
    return { Items: [...T.values()].filter(x => x.datasetId === i.ExpressionAttributeValues[":d"]) };
  }
  if (n === "BatchWriteCommand") { for (const r of Object.values(i.RequestItems)[0]) tables.f.delete(key("f", r.DeleteRequest.Key)); return {}; }
  throw new Error("unexpected " + n);
};
S3Client.prototype.send = async () => ({ Contents: [] });
CognitoIdentityProviderClient.prototype.send = async () => ({ Users: [
  { Attributes: [{ Name: "sub", Value: "admin1" }, { Name: "email", Value: "g@x.com" }] },
  { Attributes: [{ Name: "sub", Value: "u2" }, { Name: "email", Value: "friend@x.com" }] }] });
CostExplorerClient.prototype.send = async () => ({ ResultsByTime: [{ Groups: [{ Keys: ["Amazon Bedrock"], Metrics: { UnblendedCost: { Amount: "1.25" } } }] }] });
const { handler } = await import("../src/handler.mjs");

let session = "";
const call = async (routeKey, { p = {}, body, groups = "[admins]", sub = "admin1" } = {}) => {
  const res = await handler({ routeKey, pathParameters: p, headers: { "x-admin-session": session }, body: body ? JSON.stringify(body) : undefined,
    requestContext: { authorizer: { jwt: { claims: { sub, "cognito:groups": groups } } } } });
  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
};

// Not an admin: the admin API doesn't exist for them
assert.equal((await call("GET /v1/admin/me", { groups: "", sub: "u2" })).status, 404);
assert.equal((await call("GET /v1/admin/overview", { groups: "[Readers]", sub: "u2" })).status, 404);
// Admin without a session: must enter a code
let r = await call("GET /v1/admin/me");
assert.deepEqual(r.body, { admin: true, authenticator: "setup", session: false });
r = await call("GET /v1/admin/overview");
assert.equal(r.status, 401); assert.equal(r.body.code, "session");
// Set up the authenticator
r = await call("POST /v1/admin/mfa/setup");
assert.match(r.body.otpauth, /^otpauth:\/\/totp\/GeoViv%C3%A9%3Ag%40x\.com\?secret=[A-Z2-7]+/);
const secret = r.body.secret;
assert.equal((await call("POST /v1/admin/mfa/verify", { body: { code: "123456" } })).status, 401);
r = await call("POST /v1/admin/mfa/verify", { body: { code: A.totp(secret) } });
assert.equal(r.status, 200); session = r.body.token;
assert.equal((await call("POST /v1/admin/mfa/setup")).status, 409, "can't replace a confirmed authenticator here");
assert.equal((await call("GET /v1/admin/me")).body.session, true);
// A session is tied to its admin
assert.equal((await call("GET /v1/admin/overview", { sub: "someone", groups: "[admins]" })).status, 401);

// Overview and maps
r = await call("GET /v1/admin/overview");
assert.equal(r.body.users, 2); assert.equal(r.body.maps, 1); assert.equal(r.body.pins, 1); assert.equal(r.body.cost.totalUsd, 1.25);
r = await call("GET /v1/admin/datasets");
assert.equal(r.body.datasets[0].owner, "friend@x.com");
r = await call("GET /v1/admin/datasets/{datasetId}/features", { p: { datasetId: "m1" } });
assert.equal(r.body.features.length, 1);
// Visibility and delete (audited, delete needs the exact name)
r = await call("PATCH /v1/admin/datasets/{datasetId}", { p: { datasetId: "m1" }, body: { visibility: "private", reason: "personal data" } });
assert.equal(r.body.visibility, "private");
assert.equal((await call("DELETE /v1/admin/datasets/{datasetId}", { p: { datasetId: "m1" }, body: { confirm: "wrong" } })).status, 400);
r = await call("DELETE /v1/admin/datasets/{datasetId}", { p: { datasetId: "m1" }, body: { confirm: "Family spots", reason: "test" } });
assert.equal(r.status, 200); assert.ok(!tables.d.has("m1")); assert.ok(!tables.f.has("m1|p1"));
r = await call("GET /v1/admin/audit");
const actions = r.body.entries.map(e => e.action);
for (const a of ["map.deleted", "map.visibility", "admin.signed-in", "admin.authenticator-set-up", "admin.code-failed"]) assert.ok(actions.includes(a), a);
assert.equal(r.body.entries.find(e => e.action === "map.deleted").actorEmail, "g@x.com");
// The gateway's single catch-all route maps back onto the same routes
const { adminRouteKey } = await import("../src/handler.mjs");
const ev = m => ({ requestContext: { http: { method: m } } });
assert.deepEqual(adminRouteKey(ev("DELETE"), "ANY /v1/admin/{proxy+}", { proxy: "datasets/m%201" }), { routeKey: "DELETE /v1/admin/datasets/{datasetId}", p: { datasetId: "m 1" } });
assert.deepEqual(adminRouteKey(ev("GET"), "ANY /v1/admin/{proxy+}", { proxy: "datasets/x/features" }).routeKey, "GET /v1/admin/datasets/{datasetId}/features");
assert.equal(adminRouteKey(ev("POST"), "ANY /v1/admin/{proxy+}", { proxy: "mfa/verify" }).routeKey, "POST /v1/admin/mfa/verify");
r = await handler({ routeKey: "ANY /v1/admin/{proxy+}", pathParameters: { proxy: "overview" }, headers: { "x-admin-session": session },
  requestContext: { http: { method: "GET" }, authorizer: { jwt: { claims: { sub: "admin1", "cognito:groups": "[admins]" } } } } });
assert.equal(r.statusCode, 200);
r = await handler({ routeKey: "ANY /v1/admin/{proxy+}", pathParameters: { proxy: "nope" }, headers: { "x-admin-session": session },
  requestContext: { http: { method: "GET" }, authorizer: { jwt: { claims: { sub: "admin1", "cognito:groups": "[admins]" } } } } });
assert.equal(r.statusCode, 404);
// OPTIONS (CORS preflight) is answered directly, with no auth required, so the
// browser's preflight never hits the authorizer and gets a non-2xx status.
r = await handler({ routeKey: "ANY /v1/admin/{proxy+}", pathParameters: { proxy: "overview" }, headers: {},
  requestContext: { http: { method: "OPTIONS" } } });
assert.equal(r.statusCode, 204);
console.log("admin tests passed");
