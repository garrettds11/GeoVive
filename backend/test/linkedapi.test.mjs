// /v1/oauth/*, /v1/connections and /v1/linked/* through the API handler (mocked AWS).
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
process.env.USER_POOL_ID = "us-east-1_TEST123"; process.env.USER_POOL_CLIENT_ID = "abc";
process.env.DATASETS_TABLE = "d"; process.env.FEATURES_TABLE = "f"; process.env.GEOMETRY_BUCKET = "g"; process.env.ALLOWED_ORIGINS = "https://geovive.link";
process.env.APPS_TABLE = "apps"; process.env.LINKS_TABLE = "links";
process.env.AWS_ACCESS_KEY_ID = "x"; process.env.AWS_SECRET_ACCESS_KEY = "y"; process.env.AWS_REGION = "us-east-1";
const { DynamoDBDocumentClient } = await import("@aws-sdk/lib-dynamodb");
const { CognitoIdentityProviderClient } = await import("@aws-sdk/client-cognito-identity-provider");
const L = await import("../src/linking.mjs");
const AC = await import("../src/appconnect.mjs");
AC._setReviewSettings({ reviewKey: "k", reviewerEmail: "a@b.c" });

const { secret, hash } = L.newClientSecret();
const REDIRECT = "https://hunt.bowandarrow.fyi/cb";
const tables = {
  apps: new Map([["bowandarrow-hunt|APP", { appId: "bowandarrow-hunt", sk: "APP", name: "Bow & Arrow", domain: "bowandarrow.fyi", status: "live",
    termEndsAt: "2099-01-01T00:00:00Z", oauth: { redirectUris: [REDIRECT], secretHash: hash }, featureTypes: [] }]]),
  d: new Map([
    ["own-app", { datasetId: "own-app", ownerId: "u1", visibility: "private", name: "Hunt 2026", origin: { appId: "bowandarrow-hunt" }, featureCount: 1 }],
    ["shared", { datasetId: "shared", ownerId: "u1", visibility: "private", name: "Cabin", featureCount: 0 }],
    ["hidden", { datasetId: "hidden", ownerId: "u1", visibility: "public", name: "Diary", featureCount: 0 }],
    ["theirs", { datasetId: "theirs", ownerId: "u2", visibility: "public", name: "Theirs", featureCount: 0 }]]),
  f: new Map([["own-app|p1", { datasetId: "own-app", featureId: "p1", geometry: { type: "Point", coordinates: [1, 2] }, properties: { name: "Stand" } }]]),
  links: new Map()
};
const keyOf = (t, K) => t === "apps" ? `${K.appId}|${K.sk}` : t === "d" ? K.datasetId : t === "f" ? `${K.datasetId}|${K.featureId}` : `${K.pk}|${K.sk}`;
DynamoDBDocumentClient.prototype.send = async function (c) {
  const n = c.constructor.name, i = c.input, T = tables[i.TableName];
  if (n === "GetCommand") return { Item: structuredClone(T.get(keyOf(i.TableName, i.Key))) };
  if (n === "PutCommand") { T.set(keyOf(i.TableName, i.Item), structuredClone(i.Item)); return {}; }
  if (n === "DeleteCommand") { const k = keyOf(i.TableName, i.Key), old = T.get(k); T.delete(k); return { Attributes: old }; }
  if (n === "UpdateCommand") {
    const r = T.get(keyOf(i.TableName, i.Key)); const v = i.ExpressionAttributeValues || {};
    if (i.TableName === "d") { if (v[":d"]) r.featureCount += v[":d"]; return {}; }
    if (i.ConditionExpression?.includes("usedAt")) { if (!r || r.usedAt) throw Object.assign(new Error("c"), { name: "ConditionalCheckFailedException" }); r.usedAt = 1; return { Attributes: structuredClone(r) }; }
    if (r && v[":s"]) r.sharedDatasets = v[":s"];
    return {};
  }
  if (n === "QueryCommand") {
    const v = i.ExpressionAttributeValues;
    if (i.TableName === "d" && i.IndexName === "byOwner") return { Items: [...T.values()].filter(x => x.ownerId === v[":o"]) };
    if (i.TableName === "d" && i.IndexName === "byOrigin") return { Items: [...T.values()].filter(x => x.originKey === v[":k"]) };
    if (i.TableName === "f") return { Items: [...T.values()].filter(x => x.datasetId === v[":d"]) };
    if (i.TableName === "links") return { Items: [...T.values()].filter(x => x.pk === v[":p"] && x.sk.startsWith(v[":a"])) };
  }
  throw new Error(`unexpected ${n} ${i.TableName}`);
};
CognitoIdentityProviderClient.prototype.send = async () => ({ Users: [{ Attributes: [{ Name: "preferred_username", Value: "Garrett" }, { Name: "email", Value: "g@x.com" }] }] });
const { handler } = await import("../src/handler.mjs");

const user = sub => ({ requestContext: { authorizer: { jwt: { claims: { sub } } } } });
const call = async (routeKey, { p = {}, q, body, headers = {}, sub } = {}) => {
  const res = await handler({ routeKey, pathParameters: p, queryStringParameters: q, headers, body: body === undefined ? undefined : (typeof body === "string" ? body : JSON.stringify(body)), ...(sub ? user(sub) : {}) });
  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null, headers: res.headers };
};

const verifier = "a".repeat(60), challenge = createHash("sha256").update(verifier).digest("base64url");
const params = { client_id: "bowandarrow-hunt", redirect_uri: REDIRECT, response_type: "code", scope: "profile maps:read maps:write", state: "s1", code_challenge: challenge, code_challenge_method: "S256" };

// Consent page info
let r = await call("GET /v1/oauth/authorize", { q: params, sub: "u1" });
assert.equal(r.status, 200); assert.equal(r.body.app.name, "Bow & Arrow"); assert.equal(r.body.scopes.length, 3);
assert.deepEqual(r.body.maps.map(m => m.datasetId).sort(), ["hidden", "own-app", "shared"]);
assert.equal(r.body.maps.find(m => m.datasetId === "own-app").fromThisApp, true);
assert.equal((await call("GET /v1/oauth/authorize", { q: params })).status, 401);
// Approve, sharing one map
r = await call("POST /v1/oauth/authorize", { sub: "u1", body: { params, approve: true, sharedDatasets: ["shared"] } });
const code = new URL(r.body.redirect).searchParams.get("code");
// Token endpoint: form-encoded
const form = new URLSearchParams({ grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: REDIRECT, client_id: "bowandarrow-hunt", client_secret: secret }).toString();
r = await call("POST /v1/oauth/token", { body: form, headers: { "content-type": "application/x-www-form-urlencoded" } });
assert.equal(r.status, 200); assert.equal(r.headers["Cache-Control"], "no-store");
const at = r.body.access_token;
r = await call("POST /v1/oauth/token", { body: form, headers: { "content-type": "application/x-www-form-urlencoded" } });
assert.equal(r.status, 400); assert.equal(r.body.error, "invalid_grant");
const auth = { authorization: `Bearer ${at}` };

// me: pairwise ID and display name only
r = await call("GET /v1/linked/me", { headers: auth });
assert.match(r.body.userId, /^gv_/); assert.equal(r.body.displayName, "Garrett"); assert.ok(!JSON.stringify(r.body).includes("u1")); assert.ok(!JSON.stringify(r.body).includes("g@x.com"));
// datasets: app-created + shared, never others; no owner IDs
r = await call("GET /v1/linked/datasets", { headers: auth });
assert.deepEqual(r.body.datasets.map(d => d.datasetId).sort(), ["own-app", "shared"]);
assert.ok(r.body.datasets.every(d => d.ownerId === undefined));
assert.equal(r.body.datasets.find(d => d.datasetId === "shared").createdByThisApp, false);
assert.equal((await call("GET /v1/linked/datasets/{datasetId}", { p: { datasetId: "hidden" }, headers: auth })).status, 404);
assert.equal((await call("GET /v1/linked/datasets/{datasetId}", { p: { datasetId: "theirs" }, headers: auth })).status, 404);
r = await call("GET /v1/linked/datasets/{datasetId}/features", { p: { datasetId: "own-app" }, headers: auth });
assert.equal(r.body.features.length, 1);
// write: only in maps the app created
const pin = { type: "Feature", geometry: { type: "Point", coordinates: [3, 4] }, properties: { name: "Blind" } };
r = await call("POST /v1/linked/datasets/{datasetId}/features", { p: { datasetId: "own-app" }, headers: auth, body: pin });
assert.equal(r.status, 201); const fid = r.body.id;
assert.equal((await call("POST /v1/linked/datasets/{datasetId}/features", { p: { datasetId: "shared" }, headers: auth, body: pin })).status, 403);
assert.equal((await call("DELETE /v1/linked/datasets/{datasetId}/features/{featureId}", { p: { datasetId: "own-app", featureId: fid }, headers: auth })).status, 204);
// create a map (idempotent by externalRef)
r = await call("POST /v1/linked/datasets", { headers: auth, body: { name: "Elk 2027", externalRef: "hunt-42" } });
assert.equal(r.body.created, true); assert.equal(r.body.dataset.visibility, "private");
r = await call("POST /v1/linked/datasets", { headers: auth, body: { name: "Elk again", externalRef: "hunt-42" } });
assert.equal(r.body.created, false);
// A Cognito token isn't accepted on /v1/linked
assert.equal((await call("GET /v1/linked/datasets", { headers: { authorization: "Bearer eyJraWQ.x.y" } })).status, 401);

// Connected apps page
r = await call("GET /v1/connections", { sub: "u1" });
assert.equal(r.body.connections.length, 1); assert.deepEqual(r.body.connections[0].sharedDatasets, ["shared"]);
assert.equal((await call("PATCH /v1/connections/{appId}", { p: { appId: "bowandarrow-hunt" }, sub: "u1", body: { sharedDatasets: ["theirs"] } })).status, 400);
r = await call("PATCH /v1/connections/{appId}", { p: { appId: "bowandarrow-hunt" }, sub: "u1", body: { sharedDatasets: [] } });
assert.deepEqual(r.body.sharedDatasets, []);
assert.equal((await call("GET /v1/linked/datasets/{datasetId}", { p: { datasetId: "shared" }, headers: auth })).status, 404);
assert.equal((await call("DELETE /v1/connections/{appId}", { p: { appId: "bowandarrow-hunt" }, sub: "u1" })).status, 204);
assert.equal((await call("GET /v1/linked/me", { headers: auth })).status, 401);
assert.equal((await call("DELETE /v1/connections/{appId}", { p: { appId: "bowandarrow-hunt" }, sub: "u1" })).status, 404);


// AppConnect console: redirect URIs and secret (owner only)
tables.apps.get("bowandarrow-hunt|APP").ownerId = "owner";
r = await call("PUT /v1/appconnect/apps/{appId}/oauth", { p: { appId: "bowandarrow-hunt" }, sub: "owner", body: { redirectUris: [REDIRECT, "https://bowandarrow.fyi/cb"] } });
assert.equal(r.status, 200); assert.equal(r.body.redirectUris.length, 2);
assert.equal((await call("PUT /v1/appconnect/apps/{appId}/oauth", { p: { appId: "bowandarrow-hunt" }, sub: "owner", body: { redirectUris: ["https://evil.example/cb"] } })).status, 400);
assert.equal((await call("PUT /v1/appconnect/apps/{appId}/oauth", { p: { appId: "bowandarrow-hunt" }, sub: "u1", body: { redirectUris: [] } })).status, 404);
r = await call("POST /v1/appconnect/apps/{appId}/oauth/secret", { p: { appId: "bowandarrow-hunt" }, sub: "owner" });
assert.match(r.body.clientSecret, /^gvs_/); assert.equal(r.body.clientId, "bowandarrow-hunt");
console.log("linked API tests passed");
