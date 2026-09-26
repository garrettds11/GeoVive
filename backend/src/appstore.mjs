// Connected-app records (AppConnect).
//
// Table layout (APPS_TABLE), one partition per app:
//   { appId, sk: "APP" }                 current record: status, name, domain, contact,
//                                        origins, layer list address, pin types
//   { appId, sk: "EVENT#<iso>#<rand>" }  history: every status change and check result
// GSI byStatus (status, updatedAt) lists apps by stage, e.g. everything awaiting approval.
//
// Without APPS_TABLE (unit tests, local runs) the seed list in apps.mjs is used.

import { GetCommand, PutCommand, QueryCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { randomBytes } from "node:crypto";
import { SEED_APPS, SITE_ORIGINS } from "./apps.mjs";

const APPS_TABLE = process.env.APPS_TABLE;

// Setup stages, in order. suspended can be reached from anywhere.
export const STATUSES = [
  "registered",        // signed up, domain token issued
  "verifying",         // checks running
  "checks_failed",     // report sent with what to fix
  "checks_passed",     // report sent; waiting on payment or approval
  "awaiting_payment",  // payment link sent
  "sandbox",           // links work from the verified domain, limited use
  "live",              // fully connected, until termEndsAt
  "expired",           // the yearly term ran out; renewal payment re-activates it
  "suspended",         // turned off by GeoVivé or a failed re-check
  "disconnected",      // offboarded: layers off, data purged; record kept 90 days for reconnecting
  "closed"             // reduced to a tombstone after the reconnect window
];

const NEXT = {
  registered: ["verifying"],
  verifying: ["checks_failed", "checks_passed"],
  checks_failed: ["verifying"],
  checks_passed: ["awaiting_payment", "sandbox", "live", "verifying"],
  awaiting_payment: ["sandbox", "live", "verifying"],
  sandbox: ["live", "verifying", "expired"],
  live: ["verifying", "sandbox", "expired"],
  expired: ["verifying", "awaiting_payment"],
  suspended: ["verifying"],
  disconnected: ["registered", "closed"]
};

export function canTransition(from, to) {
  if (to === "suspended") return !["suspended", "disconnected", "closed"].includes(from);
  if (to === "disconnected") return !["disconnected", "closed"].includes(from);
  return (NEXT[from] || []).includes(to);
}

// Connections and the accepted terms run for one year, then renew with payment.
export const TERM_DAYS = 365;
export function termEnd(from = new Date()) {
  return new Date(from.getTime() + TERM_DAYS * 86400_000).toISOString();
}

// Apps in these stages may use open links, layers and relays, while their
// yearly term is current (records without termEndsAt predate terms).
export const isActive = (status, termEndsAt, now = Date.now()) =>
  (status === "sandbox" || status === "live") && (!termEndsAt || Date.parse(termEndsAt) > now);

// Stored records may say siteOrigins: true to mean "GeoVivé's own sites".
function resolve(item) {
  if (!item) return null;
  const app = { ...item };
  if (app.siteOrigins) { app.returnOrigins = SITE_ORIGINS; app.areaOrigins = SITE_ORIGINS; }
  app.returnOrigins ||= []; app.areaOrigins ||= []; app.featureTypes ||= [];
  // Self-service apps may keep localhost for sandbox testing; it's ignored once live.
  if (app.ownerId && app.status === "live") {
    const prod = o => !/^http:\/\/localhost(:\d+)?$/.test(o);
    app.returnOrigins = app.returnOrigins.filter(prod); app.areaOrigins = app.areaOrigins.filter(prod);
  }
  return app;
}

const CACHE_MS = 60_000;
const cache = new Map();   // appId -> { at, app }

// The app record (any status), or null. Cached for a minute per Lambda instance.
export async function getAppRecord(ddb, appId, { fresh = false } = {}) {
  if (typeof appId !== "string" || !/^[a-z0-9][a-z0-9-]{1,62}$/.test(appId)) return null;
  if (!APPS_TABLE) return resolve(SEED_APPS[appId] ? { appId, status: "live", ...SEED_APPS[appId] } : null);
  const hit = cache.get(appId);
  if (!fresh && hit && Date.now() - hit.at < CACHE_MS) return hit.app;
  const res = await ddb.send(new GetCommand({ TableName: APPS_TABLE, Key: { appId, sk: "APP" }, ConsistentRead: fresh }));
  const app = resolve(res.Item);
  cache.set(appId, { at: Date.now(), app });
  return app;
}

// The app only when it's allowed to be used (sandbox or live).
export async function getActiveApp(ddb, appId) {
  const app = await getAppRecord(ddb, appId);
  return app && isActive(app.status, app.termEndsAt) ? app : null;
}

// Move an app to a new stage and record why, atomically. Fails if another
// change got there first (the stored status must still be `from`).
export async function setStatus(ddb, appId, from, to, detail = {}) {
  if (!canTransition(from, to)) throw new Error(`Can't move an app from ${from} to ${to}`);
  const at = new Date().toISOString();
  await ddb.send(new TransactWriteCommand({ TransactItems: [
    { Update: {
      TableName: APPS_TABLE, Key: { appId, sk: "APP" },
      UpdateExpression: "SET #s = :to, updatedAt = :at",
      ConditionExpression: "#s = :from",
      ExpressionAttributeNames: { "#s": "status" },
      ExpressionAttributeValues: { ":to": to, ":from": from, ":at": at }
    } },
    { Put: { TableName: APPS_TABLE, Item: eventItem(appId, at, { type: "status", from, to, ...detail }) } }
  ] }));
  cache.delete(appId);
  return at;
}

// Start or renew the yearly term after payment (or approval) and record which
// terms version the app accepted. Renewing early extends from the current end.
export async function startTerm(ddb, appId, termsVersion, detail = {}) {
  const app = await getAppRecord(ddb, appId);
  const base = app?.termEndsAt && Date.parse(app.termEndsAt) > Date.now() ? new Date(app.termEndsAt) : new Date();
  const ends = termEnd(base), at = new Date().toISOString();
  await ddb.send(new TransactWriteCommand({ TransactItems: [
    { Update: {
      TableName: APPS_TABLE, Key: { appId, sk: "APP" },
      UpdateExpression: "SET termStartsAt = if_not_exists(termStartsAt, :at), termEndsAt = :end, termsVersion = :v, updatedAt = :at",
      ConditionExpression: "attribute_exists(appId)",
      ExpressionAttributeValues: { ":at": at, ":end": ends, ":v": termsVersion }
    } },
    { Put: { TableName: APPS_TABLE, Item: eventItem(appId, at, { type: "term", termsVersion, termEndsAt: ends, ...detail }) } }
  ] }));
  cache.delete(appId);
  return ends;
}

// Record something that happened without changing the stage (a check run, an email sent).
export async function addEvent(ddb, appId, detail) {
  const at = new Date().toISOString();
  await ddb.send(new PutCommand({ TableName: APPS_TABLE, Item: eventItem(appId, at, detail) }));
  return at;
}

export async function listEvents(ddb, appId, limit = 50) {
  const res = await ddb.send(new QueryCommand({
    TableName: APPS_TABLE,
    KeyConditionExpression: "appId = :a AND begins_with(sk, :e)",
    ExpressionAttributeValues: { ":a": appId, ":e": "EVENT#" },
    ScanIndexForward: false, Limit: limit
  }));
  return (res.Items || []).map(({ appId: _a, sk: _s, ...e }) => e);
}

export async function listByStatus(ddb, status) {
  const res = await ddb.send(new QueryCommand({
    TableName: APPS_TABLE, IndexName: "byStatus",
    KeyConditionExpression: "#s = :s", ExpressionAttributeNames: { "#s": "status" },
    ExpressionAttributeValues: { ":s": status }
  }));
  return (res.Items || []).map(resolve);
}

function eventItem(appId, at, detail) {
  return { appId, sk: `EVENT#${at}#${randomBytes(3).toString("hex")}`, at, ...detail };
}

// Seed records for the table (used by scripts/seed-apps.mjs).
export function seedItems(now = new Date().toISOString()) {
  return Object.entries(SEED_APPS).map(([appId, a]) => {
    const { returnOrigins, areaOrigins, ...rest } = a;
    const item = { appId, sk: "APP", status: "live", createdAt: now, updatedAt: now, ...rest };
    if (a.siteOrigins) return item;
    return { ...item, returnOrigins, areaOrigins };
  });
}
