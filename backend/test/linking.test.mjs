// Account linking: authorize → code → tokens → linked calls, rotation, reuse, revocation.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
process.env.LINKS_TABLE = "links";
const L = await import("../src/linking.mjs");

// Minimal in-memory DynamoDB for the links table
const rows = new Map();
const k = key => `${key.pk}|${key.sk}`;
const ddb = { async send(c) {
  const n = c.constructor.name, i = c.input;
  if (n === "PutCommand") { rows.set(k(i.Item), structuredClone(i.Item)); return {}; }
  if (n === "GetCommand") return { Item: structuredClone(rows.get(k(i.Key))) };
  if (n === "DeleteCommand") { const old = rows.get(k(i.Key)); rows.delete(k(i.Key)); return { Attributes: i.ReturnValues ? old : undefined }; }
  if (n === "QueryCommand") {
    const v = i.ExpressionAttributeValues;
    if (i.IndexName === "byApp") return { Items: [...rows.values()].filter(r => r.appId === v[":a"]).map(r => ({ pk: r.pk, sk: r.sk, appId: r.appId })) };
    return { Items: [...rows.values()].filter(r => r.pk === v[":p"] && r.sk.startsWith(v[":a"])) };
  }
  if (n === "UpdateCommand") {
    const r = rows.get(k(i.Key));
    if (i.ConditionExpression?.includes("attribute_not_exists(usedAt)")) {
      if (!r || r.usedAt) { const e = new Error("cond"); e.name = "ConditionalCheckFailedException"; throw e; }
      r.usedAt = i.ExpressionAttributeValues[":t"]; return { Attributes: structuredClone(r) };
    }
    if (!r) { const e = new Error("cond"); e.name = "ConditionalCheckFailedException"; throw e; }
    if (i.UpdateExpression.includes("sharedDatasets")) r.sharedDatasets = i.ExpressionAttributeValues[":s"];
    if (i.UpdateExpression.includes("lastUsedAt")) r.lastUsedAt = i.ExpressionAttributeValues[":t"];
    return {};
  }
  throw new Error("unexpected " + n);
} };

// Redirect validation
const app = { appId: "bowandarrow-hunt", name: "Bow & Arrow", domain: "bowandarrow.fyi", status: "live" };
assert.deepEqual(L.validateRedirects(["https://hunt.bowandarrow.fyi/geovive/callback"], app), ["https://hunt.bowandarrow.fyi/geovive/callback"]);
assert.throws(() => L.validateRedirects(["https://evil.example/cb"], app), /must be https on bowandarrow.fyi/);
assert.throws(() => L.validateRedirects(["http://hunt.bowandarrow.fyi/cb"], app), /must be https/);
assert.throws(() => L.validateRedirects(["https://hunt.bowandarrow.fyi/cb#x"], app), /fragment/);
assert.throws(() => L.validateRedirects(["http://localhost:3000/cb"], app), /sandbox/);
assert.equal(L.validateRedirects(["http://localhost:3000/cb"], { ...app, status: "sandbox" }).length, 1);
assert.throws(() => L.validateRedirects(["https://notbowandarrow.fyi/cb"], app), /must be https/);

// App with linking set up
const { secret, hash } = L.newClientSecret();
const REDIRECT = "https://hunt.bowandarrow.fyi/geovive/callback";
let active = true;
const live = { ...app, oauth: { redirectUris: [REDIRECT], secretHash: hash } };
const getApp = async id => (active && id === app.appId ? live : null);
const verifier = "v".repeat(50), challenge = createHash("sha256").update(verifier).digest("base64url");
const q = { client_id: app.appId, redirect_uri: REDIRECT, response_type: "code", scope: "profile maps:read maps:write", state: "xyz", code_challenge: challenge, code_challenge_method: "S256" };
const maps = [{ datasetId: "m1", ownerId: "u1" }, { datasetId: "m2", ownerId: "u1" }];
const ownedMaps = async () => maps;

// Bad redirect: shown on the page, never redirected
await assert.rejects(L.checkAuthorize(ddb, { getApp, sub: "u1" }, { ...q, redirect_uri: "https://evil.example/cb" }), /isn't registered/);
await assert.rejects(L.checkAuthorize(ddb, { getApp, sub: "u1" }, { ...q, client_id: "nope" }), /isn't connected/);
// No PKCE: error goes back to the app
let r = await L.checkAuthorize(ddb, { getApp, sub: "u1" }, { ...q, code_challenge: "" });
assert.match(r.redirect, /error=invalid_request/); assert.match(r.redirect, /state=xyz/);
r = await L.checkAuthorize(ddb, { getApp, sub: "u1" }, { ...q, scope: "admin" });
assert.match(r.redirect, /error=invalid_scope/);
// Declined
r = await L.approve(ddb, { getApp, sub: "u1", ownedMaps }, q, { approve: false });
assert.match(r.redirect, /error=access_denied/);
// Can't share someone else's map
await assert.rejects(L.approve(ddb, { getApp, sub: "u1", ownedMaps }, q, { approve: true, sharedDatasets: ["theirs"] }), /your own maps/);
// Approved
r = await L.approve(ddb, { getApp, sub: "u1", ownedMaps }, q, { approve: true, sharedDatasets: ["m2"] });
const code = new URL(r.redirect).searchParams.get("code");
assert.ok(code.startsWith("gvc_")); assert.equal(new URL(r.redirect).searchParams.get("state"), "xyz");
assert.ok(![...rows.keys()].some(x => x.includes(code)), "codes are stored hashed");

// Token exchange
const tok = body => L.tokenEndpoint(ddb, { getApp }, { client_id: app.appId, client_secret: secret, ...body });
await assert.rejects(L.tokenEndpoint(ddb, { getApp }, { client_id: app.appId, client_secret: "wrong", grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: REDIRECT }), e => e.oauth === "invalid_client");
await assert.rejects(tok({ grant_type: "authorization_code", code, code_verifier: "x".repeat(50), redirect_uri: REDIRECT }), e => e.oauth === "invalid_grant");
// The failed attempt consumed the code (single use)
await assert.rejects(tok({ grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: REDIRECT }), e => e.oauth === "invalid_grant");

r = await L.approve(ddb, { getApp, sub: "u1", ownedMaps }, q, { approve: true, sharedDatasets: ["m2"] });
const code2 = new URL(r.redirect).searchParams.get("code");
// HTTP Basic client auth works too
const basic = "Basic " + Buffer.from(`${app.appId}:${secret}`).toString("base64");
const t1 = await L.tokenEndpoint(ddb, { getApp }, { grant_type: "authorization_code", code: code2, code_verifier: verifier, redirect_uri: REDIRECT }, basic);
assert.equal(t1.token_type, "Bearer"); assert.equal(t1.expires_in, 3600); assert.equal(t1.scope, "maps:read maps:write profile");

// Linked calls
const link = await L.authenticate(ddb, { getApp }, `Bearer ${t1.access_token}`, "maps:read");
assert.equal(link.sub, "u1"); assert.equal(link.appId, app.appId);
assert.ok(L.canSee(link, { datasetId: "m1", ownerId: "u1", origin: { appId: app.appId } }), "maps the app created");
assert.ok(L.canSee(link, { datasetId: "m2", ownerId: "u1" }), "maps the user shared");
assert.ok(!L.canSee(link, { datasetId: "m3", ownerId: "u1" }), "other maps stay hidden");
assert.ok(!L.canSee(link, { datasetId: "m2", ownerId: "u2" }), "never another user's");
assert.ok(!L.canChange(link, { datasetId: "m2", ownerId: "u1" }), "shared maps are read-only");
assert.ok(L.canChange(link, { datasetId: "m1", ownerId: "u1", origin: { appId: app.appId } }));
await assert.rejects(L.authenticate(ddb, { getApp }, "Bearer gva_nope", null), /invalid or expired/);
await assert.rejects(L.authenticate(ddb, { getApp }, "Bearer eyJhbGciOi.cognito", null), /account-linking access token/);

// Pairwise IDs differ per app
assert.notEqual(L.pairwiseId("k", "a1", "u1"), L.pairwiseId("k", "a2", "u1"));
assert.equal(L.pairwiseId("k", "a1", "u1"), L.pairwiseId("k", "a1", "u1"));

// Sharing changes apply to live tokens
await L.updateShared(ddb, "u1", app.appId, [], ownedMaps);
const link2 = await L.authenticate(ddb, { getApp }, `Bearer ${t1.access_token}`, "maps:read");
assert.ok(!L.canSee(link2, { datasetId: "m2", ownerId: "u1" }));

// Refresh rotation, then replaying the old refresh token ends the link
const t2 = await tok({ grant_type: "refresh_token", refresh_token: t1.refresh_token });
assert.notEqual(t2.refresh_token, t1.refresh_token);
await L.authenticate(ddb, { getApp }, `Bearer ${t2.access_token}`, null);
await assert.rejects(tok({ grant_type: "refresh_token", refresh_token: t1.refresh_token }), e => e.oauth === "invalid_grant");
await assert.rejects(L.authenticate(ddb, { getApp }, `Bearer ${t2.access_token}`, null), /removed this link/);
assert.equal((await L.listGrants(ddb, "u1")).length, 0);

// Re-link; the user's revoke stops tokens at once
r = await L.approve(ddb, { getApp, sub: "u1", ownedMaps }, { ...q, scope: "maps:read" }, { approve: true });
const t3 = await tok({ grant_type: "authorization_code", code: new URL(r.redirect).searchParams.get("code"), code_verifier: verifier, redirect_uri: REDIRECT });
await assert.rejects(L.authenticate(ddb, { getApp }, `Bearer ${t3.access_token}`, "maps:write"), /maps:write scope/);
const grants = await L.listGrants(ddb, "u1");
assert.equal(grants.length, 1); assert.deepEqual(grants[0].scopes, ["maps:read"]);
assert.ok(await L.revokeGrant(ddb, "u1", app.appId));
await assert.rejects(L.authenticate(ddb, { getApp }, `Bearer ${t3.access_token}`, null), /removed this link/);

// App disconnect: every link ends; an inactive app's tokens stop too
r = await L.approve(ddb, { getApp, sub: "u1", ownedMaps }, q, { approve: true });
const t4 = await tok({ grant_type: "authorization_code", code: new URL(r.redirect).searchParams.get("code"), code_verifier: verifier, redirect_uri: REDIRECT });
r = await L.approve(ddb, { getApp, sub: "u2", ownedMaps: async () => [] }, q, { approve: true });
active = false;
await assert.rejects(L.authenticate(ddb, { getApp }, `Bearer ${t4.access_token}`, null), /isn't active/);
active = true;
assert.equal(await L.revokeAllForApp(ddb, app.appId), 2);
await assert.rejects(L.authenticate(ddb, { getApp }, `Bearer ${t4.access_token}`, null), /removed this link/);

// Token revocation endpoint
r = await L.approve(ddb, { getApp, sub: "u1", ownedMaps }, q, { approve: true });
const t5 = await tok({ grant_type: "authorization_code", code: new URL(r.redirect).searchParams.get("code"), code_verifier: verifier, redirect_uri: REDIRECT });
await L.revokeToken(ddb, { getApp }, { client_id: app.appId, client_secret: secret, token: t5.access_token });
await assert.rejects(L.authenticate(ddb, { getApp }, `Bearer ${t5.access_token}`, null), /invalid or expired/);
await assert.rejects(tok({ grant_type: "password" }), e => e.oauth === "unsupported_grant_type");

console.log("linking: all passed");
