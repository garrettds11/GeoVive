// linking.mjs — account linking: OAuth 2.0 (authorization code + PKCE) for AppConnect apps.
//
// GeoVivé is the authorization server. A signed-in user approves an app on the consent
// page (/connect/), the app swaps the one-time code for tokens on its own server, and
// then calls /v1/linked/* with the access token.
//
//   Scopes    profile    a per-app user ID and display name
//             maps:read  read maps the app created for this user, and maps the user shared with it
//             maps:write create maps, and add, change and delete pins, in maps the app created
//   Tokens    opaque random strings; only their SHA-256 is stored. Access 1 hour, refresh
//             90 days, rotated on every use; reusing an old refresh token revokes the link.
//   Grant     one per user and app. Revoking it (user, app disconnect, or refresh-token reuse)
//             stops every token at once: tokens carry the grant version and are checked
//             against it on each call.
//   Privacy   apps get a pairwise user ID (different for each app), never the Cognito sub
//             or the email address.
//
// Table (LINKS_TABLE): pk/sk, TTL on `ttl`, GSI byApp (appId, pk).
//   USER#<sub>  APP#<appId>  grant
//   CODE#<h>    -            authorization code (5 minutes, single use)
//   AT#<h>      -            access token
//   RT#<h>      -            refresh token

import { GetCommand, PutCommand, DeleteCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const TABLE = () => process.env.LINKS_TABLE;
export const SCOPES = {
  profile: "See your display name and a user ID for this app",
  "maps:read": "See datasets it created for you, and datasets you share with it",
  "maps:write": "Create datasets and add, change or delete pins in the datasets it created"
};
const CODE_TTL = 300, ACCESS_TTL = 3600, REFRESH_TTL = 90 * 86400;
export const MAX_REDIRECTS = 5, MAX_SHARED = 50;

export class LinkError extends Error {
  // oauth: an RFC 6749 error code for the token endpoint
  constructor(status, message, oauth) { super(message); this.status = status; this.oauth = oauth; }
}

const sha = s => createHash("sha256").update(String(s)).digest("hex");
const token = (prefix) => `${prefix}_${randomBytes(32).toString("base64url")}`;
const nowSec = () => Math.floor(Date.now() / 1000);
function sameHash(a, b) {
  const x = Buffer.from(String(a || ""), "hex"), y = Buffer.from(String(b || ""), "hex");
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}

export function parseScopes(raw) {
  const list = [...new Set(String(raw || "maps:read").split(/[\s+]+/).filter(Boolean))];
  const bad = list.filter(s => !SCOPES[s]);
  if (bad.length) throw new LinkError(400, `Unknown scope: ${bad.join(", ")}`, "invalid_scope");
  return list.sort();
}

// Pairwise user ID: stable for one user and one app, unlinkable across apps.
export function pairwiseId(key, appId, sub) {
  return "gv_" + createHmac("sha256", `pairwise|${key}`).update(`${appId}|${sub}`).digest("base64url").slice(0, 27);
}

// ------------------------------------------------------------------ app settings (AppConnect console)

const onDomain = (host, domain) => host === domain || host.endsWith("." + domain);
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

// Redirect URIs: exact https URLs on the app's verified domain (no fragments, no wildcards).
// http://localhost is allowed only while the app is in the sandbox.
export function validateRedirects(list, app) {
  if (!Array.isArray(list)) throw new LinkError(400, "redirectUris must be a list");
  const out = [];
  for (const raw of list) {
    let u;
    try { u = new URL(String(raw).trim()); } catch { throw new LinkError(400, `Not a valid URL: ${raw}`); }
    if (u.hash || u.username || u.password) throw new LinkError(400, `Redirect URIs can't have a #fragment or credentials: ${raw}`);
    const loop = LOOPBACK.has(u.hostname);
    if (loop && !(u.protocol === "http:" && app.status === "sandbox")) throw new LinkError(400, "localhost redirects are only allowed in the sandbox");
    if (!loop && (u.protocol !== "https:" || !onDomain(u.hostname, app.domain))) throw new LinkError(400, `Redirect URIs must be https on ${app.domain}: ${raw}`);
    if (!out.includes(u.href)) out.push(u.href);
  }
  if (out.length > MAX_REDIRECTS) throw new LinkError(400, `Up to ${MAX_REDIRECTS} redirect URIs`);
  return out;
}

export function newClientSecret() {
  const secret = token("gvs");
  return { secret, hash: sha(secret), hint: secret.slice(-4) };
}

// ------------------------------------------------------------------ authorize (consent page)

// Validates a request from the consent page. Errors before redirect_uri is trusted are
// shown to the user on the page; they never send the browser to an unverified address.
export async function checkAuthorize(ddb, { getApp, sub }, q) {
  const app = await getApp(q.client_id);
  if (!app) throw new LinkError(400, "This app isn't connected to GeoVivé, or its connection isn't active.");
  const oauth = app.oauth || {};
  if (!oauth.secretHash || !oauth.redirectUris?.length) throw new LinkError(400, `${app.name} hasn't finished setting up account linking.`);
  if (!oauth.redirectUris.includes(q.redirect_uri)) throw new LinkError(400, "The return address in this link isn't registered for this app.");
  // From here on, errors can go back to the app
  const back = (error, description) => ({ redirect: withParams(q.redirect_uri, { error, error_description: description, state: q.state }) });
  if (q.response_type !== "code") return back("unsupported_response_type", "Only response_type=code is supported");
  if (q.code_challenge_method !== "S256" || !/^[A-Za-z0-9_-]{43}$/.test(q.code_challenge || "")) return back("invalid_request", "PKCE with S256 is required");
  let scopes;
  try { scopes = parseScopes(q.scope); } catch (e) { return back("invalid_scope", e.message); }
  const grant = sub ? await getGrant(ddb, sub, app.appId) : null;
  return { app, scopes, grant };
}

export async function approve(ddb, { getApp, sub, ownedMaps }, q, { approve, sharedDatasets = [] } = {}) {
  const chk = await checkAuthorize(ddb, { getApp, sub }, q);
  if (chk.redirect) return chk;
  if (!approve) return { redirect: withParams(q.redirect_uri, { error: "access_denied", error_description: "The user declined", state: q.state }) };
  const shared = await cleanShared(sharedDatasets, ownedMaps);
  const grant = await saveGrant(ddb, sub, chk.app, chk.scopes, shared);
  const code = token("gvc");
  await ddb.send(new PutCommand({ TableName: TABLE(), Item: {
    pk: `CODE#${sha(code)}`, sk: "-", ttl: nowSec() + CODE_TTL, sub, appId: chk.app.appId, redirectUri: q.redirect_uri,
    scopes: chk.scopes, challenge: q.code_challenge, version: grant.version } }));
  return { redirect: withParams(q.redirect_uri, { code, state: q.state }) };
}

function withParams(uri, params) {
  const u = new URL(uri);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "") u.searchParams.set(k, v);
  return u.href;
}

async function cleanShared(ids, ownedMaps) {
  if (!Array.isArray(ids)) throw new LinkError(400, "sharedDatasets must be a list");
  if (ids.length > MAX_SHARED) throw new LinkError(400, `Share up to ${MAX_SHARED} maps with one app`);
  const mine = new Set((await ownedMaps()).map(d => d.datasetId));
  const bad = ids.filter(id => !mine.has(id));
  if (bad.length) throw new LinkError(400, "You can only share your own maps");
  return [...new Set(ids)];
}

// ------------------------------------------------------------------ grants

export async function getGrant(ddb, sub, appId) {
  const { Item } = await ddb.send(new GetCommand({ TableName: TABLE(), Key: { pk: `USER#${sub}`, sk: `APP#${appId}` }, ConsistentRead: true }));
  return Item || null;
}

async function saveGrant(ddb, sub, app, scopes, shared) {
  const old = await getGrant(ddb, sub, app.appId);
  const at = new Date().toISOString();
  const grant = { pk: `USER#${sub}`, sk: `APP#${app.appId}`, appId: app.appId, appName: app.name, appDomain: app.domain,
    scopes: [...new Set([...(old?.scopes || []), ...scopes])].sort(),     // approving more keeps what was approved before
    sharedDatasets: shared, version: old?.version || randomBytes(9).toString("base64url"),
    createdAt: old?.createdAt || at, updatedAt: at, lastUsedAt: old?.lastUsedAt };
  await ddb.send(new PutCommand({ TableName: TABLE(), Item: grant }));
  return grant;
}

export function grantView(g) {
  return { appId: g.appId, appName: g.appName, appDomain: g.appDomain, scopes: g.scopes,
    scopeLabels: g.scopes.map(s => SCOPES[s] || s), sharedDatasets: g.sharedDatasets || [],
    createdAt: g.createdAt, updatedAt: g.updatedAt, lastUsedAt: g.lastUsedAt || null };
}

export async function listGrants(ddb, sub) {
  const res = await ddb.send(new QueryCommand({ TableName: TABLE(), KeyConditionExpression: "pk = :p AND begins_with(sk, :a)",
    ExpressionAttributeValues: { ":p": `USER#${sub}`, ":a": "APP#" } }));
  return (res.Items || []).map(grantView).sort((a, b) => a.appName.localeCompare(b.appName));
}

export async function updateShared(ddb, sub, appId, sharedDatasets, ownedMaps) {
  const g = await getGrant(ddb, sub, appId);
  if (!g) throw new LinkError(404, "This app isn't linked to your account");
  const shared = await cleanShared(sharedDatasets, ownedMaps);
  await ddb.send(new UpdateCommand({ TableName: TABLE(), Key: { pk: g.pk, sk: g.sk },
    UpdateExpression: "SET sharedDatasets = :s, updatedAt = :u", ExpressionAttributeValues: { ":s": shared, ":u": new Date().toISOString() } }));
  return grantView({ ...g, sharedDatasets: shared });
}

// Deleting the grant ends every token for it (tokens are checked against the grant).
export async function revokeGrant(ddb, sub, appId) {
  const res = await ddb.send(new DeleteCommand({ TableName: TABLE(), Key: { pk: `USER#${sub}`, sk: `APP#${appId}` }, ReturnValues: "ALL_OLD" }));
  return !!res.Attributes;
}

// Every user's link to one app (app disconnected or closed).
export async function revokeAllForApp(ddb, appId) {
  if (!TABLE()) return 0;
  let key, n = 0;
  do {
    const res = await ddb.send(new QueryCommand({ TableName: TABLE(), IndexName: "byApp", KeyConditionExpression: "appId = :a",
      ExpressionAttributeValues: { ":a": appId }, ExclusiveStartKey: key }));
    for (const it of res.Items || []) {
      if (!String(it.pk).startsWith("USER#")) continue;
      await ddb.send(new DeleteCommand({ TableName: TABLE(), Key: { pk: it.pk, sk: it.sk } })); n++;
    }
    key = res.LastEvaluatedKey;
  } while (key);
  return n;
}

// ------------------------------------------------------------------ token endpoint

function clientAuth(app, clientId, secret) {
  if (!app || app.appId !== clientId) throw new LinkError(401, "Unknown client", "invalid_client");
  if (!sameHash(sha(secret || ""), app.oauth?.secretHash)) throw new LinkError(401, "Client authentication failed", "invalid_client");
}

async function issue(ddb, { sub, appId, scopes, version }) {
  const access = token("gva"), refresh = token("gvr");
  const t = nowSec();
  await ddb.send(new PutCommand({ TableName: TABLE(), Item: { pk: `AT#${sha(access)}`, sk: "-", ttl: t + ACCESS_TTL, expiresAt: t + ACCESS_TTL, sub, appId, scopes, version } }));
  await ddb.send(new PutCommand({ TableName: TABLE(), Item: { pk: `RT#${sha(refresh)}`, sk: "-", ttl: t + REFRESH_TTL, expiresAt: t + REFRESH_TTL, sub, appId, scopes, version } }));
  return { access_token: access, token_type: "Bearer", expires_in: ACCESS_TTL, refresh_token: refresh, scope: scopes.join(" ") };
}

// body: form fields. Client credentials in the body or HTTP Basic.
export async function tokenEndpoint(ddb, { getApp }, body, authHeader) {
  let clientId = body.client_id, secret = body.client_secret;
  if (authHeader?.startsWith("Basic ")) {
    const [id, sec] = Buffer.from(authHeader.slice(6), "base64").toString("utf8").split(":");
    clientId = decodeURIComponent(id || ""); secret = decodeURIComponent(sec || "");
  }
  const app = await getApp(clientId);
  clientAuth(app, clientId, secret);

  if (body.grant_type === "authorization_code") {
    if (!body.code || !body.code_verifier) throw new LinkError(400, "code and code_verifier are required", "invalid_request");
    let rec;
    try {   // single use: delete returns the record once
      rec = (await ddb.send(new DeleteCommand({ TableName: TABLE(), Key: { pk: `CODE#${sha(body.code)}`, sk: "-" }, ReturnValues: "ALL_OLD" }))).Attributes;
    } catch { rec = null; }
    if (!rec || rec.ttl < nowSec() || rec.appId !== app.appId) throw new LinkError(400, "The code is invalid or expired", "invalid_grant");
    if (rec.redirectUri !== body.redirect_uri) throw new LinkError(400, "redirect_uri doesn't match", "invalid_grant");
    const challenge = createHash("sha256").update(body.code_verifier).digest("base64url");
    if (challenge !== rec.challenge) throw new LinkError(400, "code_verifier doesn't match", "invalid_grant");
    const g = await getGrant(ddb, rec.sub, app.appId);
    if (!g || g.version !== rec.version) throw new LinkError(400, "The link was removed", "invalid_grant");
    return issue(ddb, rec);
  }

  if (body.grant_type === "refresh_token") {
    if (!body.refresh_token) throw new LinkError(400, "refresh_token is required", "invalid_request");
    const key = { pk: `RT#${sha(body.refresh_token)}`, sk: "-" };
    let rec;
    try {
      rec = (await ddb.send(new UpdateCommand({ TableName: TABLE(), Key: key, UpdateExpression: "SET usedAt = :t",
        ConditionExpression: "attribute_exists(pk) AND attribute_not_exists(usedAt)", ExpressionAttributeValues: { ":t": nowSec() }, ReturnValues: "ALL_NEW" }))).Attributes;
    } catch (e) {
      if (e.name !== "ConditionalCheckFailedException") throw e;
      // Used before: someone replayed a rotated token. Treat as stolen and end the link.
      const { Item } = await ddb.send(new GetCommand({ TableName: TABLE(), Key: key }));
      if (Item?.usedAt && Item.appId === app.appId) { await revokeGrant(ddb, Item.sub, Item.appId); console.warn("Refresh token reuse; link revoked", Item.appId); }
      throw new LinkError(400, "The refresh token is invalid", "invalid_grant");
    }
    if (rec.appId !== app.appId || rec.expiresAt < nowSec()) throw new LinkError(400, "The refresh token is invalid", "invalid_grant");
    const g = await getGrant(ddb, rec.sub, app.appId);
    if (!g || g.version !== rec.version) throw new LinkError(400, "The link was removed", "invalid_grant");
    const scopes = rec.scopes.filter(s => g.scopes.includes(s));
    return issue(ddb, { ...rec, scopes });
  }
  throw new LinkError(400, "grant_type must be authorization_code or refresh_token", "unsupported_grant_type");
}

// RFC 7009: always 200, even for unknown tokens.
export async function revokeToken(ddb, { getApp }, body, authHeader) {
  let clientId = body.client_id, secret = body.client_secret;
  if (authHeader?.startsWith("Basic ")) {
    const [id, sec] = Buffer.from(authHeader.slice(6), "base64").toString("utf8").split(":");
    clientId = decodeURIComponent(id || ""); secret = decodeURIComponent(sec || "");
  }
  const app = await getApp(clientId);
  clientAuth(app, clientId, secret);
  const h = sha(body.token || "");
  for (const pk of [`AT#${h}`, `RT#${h}`]) {
    const { Item } = await ddb.send(new GetCommand({ TableName: TABLE(), Key: { pk, sk: "-" } }));
    if (Item && Item.appId === app.appId) await ddb.send(new DeleteCommand({ TableName: TABLE(), Key: { pk, sk: "-" } }));
  }
  return {};
}

// ------------------------------------------------------------------ bearer check for /v1/linked/*

// Returns { sub, appId, scopes, grant } or throws 401/403.
export async function authenticate(ddb, { getApp }, authHeader, needScope) {
  const raw = authHeader?.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
  if (!raw.startsWith("gva_")) throw new LinkError(401, "An account-linking access token is required");
  const { Item: t } = await ddb.send(new GetCommand({ TableName: TABLE(), Key: { pk: `AT#${sha(raw)}`, sk: "-" } }));
  if (!t || t.expiresAt < nowSec()) throw new LinkError(401, "The access token is invalid or expired");
  const grant = await getGrant(ddb, t.sub, t.appId);
  if (!grant || grant.version !== t.version) throw new LinkError(401, "The user removed this link");
  if (!(await getApp(t.appId))) throw new LinkError(401, "This app's GeoVivé connection isn't active");
  const scopes = t.scopes.filter(s => grant.scopes.includes(s));
  if (needScope && !scopes.includes(needScope)) throw new LinkError(403, `This needs the ${needScope} scope`);
  // Note use at most once an hour (keeps writes low)
  const last = grant.lastUsedAt ? Date.parse(grant.lastUsedAt) : 0;
  if (Date.now() - last > 3600_000) {
    try { await ddb.send(new UpdateCommand({ TableName: TABLE(), Key: { pk: grant.pk, sk: grant.sk }, UpdateExpression: "SET lastUsedAt = :t",
      ConditionExpression: "attribute_exists(pk)", ExpressionAttributeValues: { ":t": new Date().toISOString() } })); } catch { /* removed meanwhile */ }
  }
  return { sub: t.sub, appId: t.appId, scopes, grant };
}

// Which of the user's maps an app may see, and which it may change.
export function canSee(link, dataset) {
  if (!dataset || dataset.ownerId !== link.sub) return false;
  return dataset.origin?.appId === link.appId || (link.grant.sharedDatasets || []).includes(dataset.datasetId);
}
export function canChange(link, dataset) {
  return !!dataset && dataset.ownerId === link.sub && dataset.origin?.appId === link.appId;
}
