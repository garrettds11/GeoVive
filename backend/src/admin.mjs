// admin.mjs — the GeoVivé admin API (/v1/admin/*).
//
// Three checks on every admin action, all on the server:
//   1. a GeoVivé sign-in (Cognito access token, checked by the API gateway)
//   2. membership of the Cognito "admins" group (from the token's cognito:groups claim)
//   3. a GeoVivé admin session: a 6-digit authenticator (TOTP) code, verified here,
//      unlocks admin for 12 hours. This is GeoVivé's own second factor because Cognito
//      MFA doesn't apply to Google sign-ins.
// Every change an admin makes is written to the audit log.
//
// Table ADMIN_TABLE (pk/sk):
//   ADMIN#<sub>  TOTP                     { secret, confirmed, createdAt }
//   AUDIT        <iso time>#<random>      { actor, action, target, detail }

import { GetCommand, PutCommand, QueryCommand, ScanCommand, UpdateCommand, DeleteCommand } from "@aws-sdk/lib-dynamodb";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const TABLE = () => process.env.ADMIN_TABLE;
export const ADMIN_GROUP = "admins";
const SESSION_HOURS = 12;
const ISSUER = "GeoVivé";

export class AdminError extends Error {
  constructor(status, message, code) { super(message); this.status = status; this.code = code; }
}

// ------------------------------------------------------------------ TOTP (RFC 6238, SHA-1, 30 s, 6 digits)

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
export function base32(buf) {
  let bits = "", out = "";
  for (const b of buf) bits += b.toString(2).padStart(8, "0");
  for (let i = 0; i < bits.length; i += 5) out += B32[parseInt(bits.slice(i, i + 5).padEnd(5, "0"), 2)];
  return out;
}
function unbase32(s) {
  let bits = "";
  for (const c of s.replace(/=+$/, "").toUpperCase()) { const v = B32.indexOf(c); if (v < 0) continue; bits += v.toString(2).padStart(5, "0"); }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}
export function totp(secret, time = Date.now(), step = 0) {
  const counter = Math.floor(time / 30000) + step;
  const msg = Buffer.alloc(8); msg.writeBigUInt64BE(BigInt(counter));
  const h = createHmac("sha1", unbase32(secret)).update(msg).digest();
  const o = h[h.length - 1] & 15;
  return String(((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000)).padStart(6, "0");
}
export function checkTotp(secret, code, time = Date.now()) {
  const c = String(code || "").replace(/\s/g, "");
  if (!/^\d{6}$/.test(c)) return false;
  return [-1, 0, 1].some(s => { const t = totp(secret, time, s); return timingSafeEqual(Buffer.from(t), Buffer.from(c)); });
}

// ------------------------------------------------------------------ sessions (signed, stateless)

export function signSession(key, sub, now = Date.now()) {
  const exp = now + SESSION_HOURS * 3600_000;
  const sig = createHmac("sha256", `admin-session|${key}`).update(`${sub}.${exp}`).digest("base64url");
  return { token: `${sub}.${exp}.${sig}`, expiresAt: new Date(exp).toISOString() };
}
export function verifySession(key, token, sub, now = Date.now()) {
  const [s, exp, sig] = String(token || "").split(".");
  if (!s || s !== sub || !exp || Number(exp) < now) return false;
  const want = createHmac("sha256", `admin-session|${key}`).update(`${s}.${exp}`).digest("base64url");
  return sig && want.length === sig.length && timingSafeEqual(Buffer.from(want), Buffer.from(sig));
}

// ------------------------------------------------------------------ who is asking

export function groupsOf(event) {
  const raw = event.requestContext?.authorizer?.jwt?.claims?.["cognito:groups"];
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  return String(raw).replace(/^\[|\]$/g, "").split(/[\s,]+/).filter(Boolean);
}

// Group check only (used for the MFA setup and verify steps).
export function requireAdminUser(event) {
  const sub = event.requestContext?.authorizer?.jwt?.claims?.sub;
  if (!sub || !groupsOf(event).includes(ADMIN_GROUP)) throw new AdminError(404, "Not found");   // don't reveal the admin API
  return sub;
}

// Group + a valid admin session (every other admin route).
export async function requireAdmin(event, { key }) {
  const sub = requireAdminUser(event);
  const token = event.headers?.["x-admin-session"] || event.headers?.["X-Admin-Session"];
  if (!verifySession(key, token, sub)) throw new AdminError(401, "Enter your authenticator code to continue", "session");
  return sub;
}

// ------------------------------------------------------------------ authenticator setup and sign-in

export async function mfaStatus(ddb, sub) {
  const { Item } = await ddb.send(new GetCommand({ TableName: TABLE(), Key: { pk: `ADMIN#${sub}`, sk: "TOTP" }, ConsistentRead: true }));
  return Item?.confirmed ? "ready" : "setup";
}

// A new secret, until one has been confirmed with a code. Once confirmed, it can't be replaced here.
export async function mfaSetup(ddb, sub, label) {
  const { Item } = await ddb.send(new GetCommand({ TableName: TABLE(), Key: { pk: `ADMIN#${sub}`, sk: "TOTP" }, ConsistentRead: true }));
  if (Item?.confirmed) throw new AdminError(409, "Your authenticator is already set up");
  const secret = base32(randomBytes(20));
  await ddb.send(new PutCommand({ TableName: TABLE(), Item: { pk: `ADMIN#${sub}`, sk: "TOTP", secret, confirmed: false, createdAt: new Date().toISOString() } }));
  const name = encodeURIComponent(`${ISSUER}:${label || "admin"}`);
  return { secret, otpauth: `otpauth://totp/${name}?secret=${secret}&issuer=${encodeURIComponent(ISSUER)}&algorithm=SHA1&digits=6&period=30` };
}

export async function mfaVerify(ddb, sub, code, { key, audit }) {
  const { Item } = await ddb.send(new GetCommand({ TableName: TABLE(), Key: { pk: `ADMIN#${sub}`, sk: "TOTP" }, ConsistentRead: true }));
  if (!Item) throw new AdminError(400, "Set up your authenticator first");
  if (!checkTotp(Item.secret, code)) {
    await audit(sub, "admin.code-failed", "", {});
    throw new AdminError(401, "That code didn't match. Check your authenticator app's time and try the current code.");
  }
  if (!Item.confirmed) {
    await ddb.send(new UpdateCommand({ TableName: TABLE(), Key: { pk: Item.pk, sk: Item.sk }, UpdateExpression: "SET confirmed = :t, confirmedAt = :n",
      ExpressionAttributeValues: { ":t": true, ":n": new Date().toISOString() } }));
    await audit(sub, "admin.authenticator-set-up", "", {});
  }
  await audit(sub, "admin.signed-in", "", {});
  return signSession(key, sub);
}

// ------------------------------------------------------------------ audit log

export async function writeAudit(ddb, actor, action, target, detail = {}) {
  const at = new Date().toISOString();
  await ddb.send(new PutCommand({ TableName: TABLE(), Item: { pk: "AUDIT", sk: `${at}#${randomBytes(3).toString("hex")}`, at, actor, action, target, detail } }));
}

export async function listAudit(ddb, limit = 100) {
  const r = await ddb.send(new QueryCommand({ TableName: TABLE(), KeyConditionExpression: "pk = :p", ExpressionAttributeValues: { ":p": "AUDIT" },
    ScanIndexForward: false, Limit: Math.min(500, limit) }));
  return (r.Items || []).map(({ at, actor, action, target, detail }) => ({ at, actor, action, target, detail }));
}
