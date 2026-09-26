// approvals.mjs — AppConnect approved layers.
//
// GeoVivé shows only layers that passed review. Each app has:
//   S3 appconnect/<appId>/approved.json            the approved copy of each layer (what users see)
//   S3 appconnect/<appId>/pending/<id>-<hash>.json a layer version waiting for a person's review
//   app record layerState { <layerId>: { hash, state, at } }
//     state: approved | review | rejected | checking
// When the app's live list changes, new or changed layers are checked
// automatically. Passing layers are approved; layers with findings a person
// must judge go to the reviewer (emailed, with signed approve/reject links);
// failing layers are rejected. Approved versions keep showing until a change
// is approved, so an edit never takes a working layer offline.

import { PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { createHmac, timingSafeEqual } from "node:crypto";
import { layerHash } from "./appcheck.mjs";

const BUCKET = process.env.GEOMETRY_BUCKET;
const APPS_TABLE = process.env.APPS_TABLE;
export const REVIEW_BUSINESS_DAYS = 5;

// ------------------------------------------------------------------ approved copies

const cache = new Map();   // appId -> { at, data }
export async function loadApproved(s3, appId, { fresh = false } = {}) {
  const hit = cache.get(appId);
  if (!fresh && hit && Date.now() - hit.at < 60_000) return hit.data;
  let data = { layers: {} };
  try {
    const res = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: `appconnect/${appId}/approved.json` }));
    data = JSON.parse(await res.Body.transformToString());
  } catch (e) { if (e.name !== "NoSuchKey" && e.$metadata?.httpStatusCode !== 404) throw e; }
  cache.set(appId, { at: Date.now(), data });
  return data;
}

async function saveApproved(s3, appId, data) {
  await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: `appconnect/${appId}/approved.json`,
    Body: JSON.stringify(data), ContentType: "application/json" }));
  cache.set(appId, { at: Date.now(), data });
}

// Layers to show: the approved copy of each layer still in the app's list
// (or every approved layer when the list couldn't be read).
export function visibleLayers(approved, list) {
  const ids = list ? list.layers.map(l => l.id) : Object.keys(approved.layers);
  return ids.map(id => approved.layers[id]?.layer).filter(Boolean);
}

// Layers in the list whose current version hasn't been through checks yet.
export function changedLayers(app, list) {
  const st = app.layerState || {};
  return list.layers.filter(l => st[l.id]?.hash !== layerHash(l));
}

export function changeKey(layers) {
  return layers.map(l => `${l.id}:${layerHash(l)}`).sort().join(",");
}

// ------------------------------------------------------------------ applying check results

// rows: checkLayer() results; list: the validated list they came from.
export async function applyResults(ddb, s3, app, rows, list, { by = "automatic checks" } = {}) {
  const approved = await loadApproved(s3, app.appId, { fresh: true });
  const state = { ...(app.layerState || {}) };
  const at = new Date().toISOString();
  const out = { approved: [], review: [], rejected: [] };
  for (const row of rows) {
    const layer = list.layers.find(l => l.id === row.id);
    if (!layer) continue;
    const hash = row.hash || layerHash(layer);
    if (row.result === "pass" || row.result === "note") {
      approved.layers[row.id] = { hash, approvedAt: at, by, layer };
      state[row.id] = { hash, state: "approved", at };
      out.approved.push(row.id);
    } else if (row.result === "review") {
      await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: `appconnect/${app.appId}/pending/${row.id}-${hash}.json`,
        Body: JSON.stringify({ layer, findings: row.issues, features: row.features, at }), ContentType: "application/json" }));
      state[row.id] = { hash, state: "review", at, findings: row.issues.slice(0, 5) };
      out.review.push(row.id);
    } else {
      state[row.id] = { hash, state: "rejected", at, findings: row.issues.slice(0, 5) };
      out.rejected.push(row.id);
    }
  }
  // Layers the app removed from its list stop showing
  const inList = new Set(list.layers.map(l => l.id));
  for (const id of Object.keys(approved.layers)) if (!inList.has(id)) delete approved.layers[id];
  for (const id of Object.keys(state)) if (!inList.has(id)) delete state[id];
  await saveApproved(s3, app.appId, approved);
  await ddb.send(new UpdateCommand({ TableName: APPS_TABLE, Key: { appId: app.appId, sk: "APP" },
    UpdateExpression: "SET layerState = :s", ExpressionAttributeValues: { ":s": state } }));
  return out;
}

// A reviewer's decision on one pending layer version.
export async function decide(ddb, s3, app, layerId, hash, decision, reviewer) {
  const st = app.layerState?.[layerId];
  if (!st || st.hash !== hash || st.state !== "review") return { stale: true, state: st?.state };
  const at = new Date().toISOString();
  const state = { ...(app.layerState || {}) };
  if (decision === "approve") {
    const res = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: `appconnect/${app.appId}/pending/${layerId}-${hash}.json` }));
    const { layer } = JSON.parse(await res.Body.transformToString());
    const approved = await loadApproved(s3, app.appId, { fresh: true });
    approved.layers[layerId] = { hash, approvedAt: at, by: reviewer, layer };
    await saveApproved(s3, app.appId, approved);
    state[layerId] = { hash, state: "approved", at, by: reviewer };
  } else {
    state[layerId] = { ...st, state: "rejected", at, by: reviewer };
  }
  await ddb.send(new UpdateCommand({ TableName: APPS_TABLE, Key: { appId: app.appId, sk: "APP" },
    UpdateExpression: "SET layerState = :s", ConditionExpression: "attribute_exists(appId)", ExpressionAttributeValues: { ":s": state } }));
  return { decided: decision, layerId };
}

// ------------------------------------------------------------------ signed review links

export function signReview(key, { appId, layerId, hash, exp }) {
  return createHmac("sha256", key).update(`${appId}|${layerId}|${hash}|${exp}`).digest("hex");
}

export function verifyReview(key, q, now = Date.now()) {
  if (!q.appId || !q.layerId || !q.hash || !q.exp || !q.sig) return false;
  if (Number(q.exp) < now / 1000) return false;
  const want = signReview(key, q);
  return q.sig.length === want.length && timingSafeEqual(Buffer.from(q.sig), Buffer.from(want));
}

// ------------------------------------------------------------------ business days

export function businessDaysBetween(fromIso, now = Date.now()) {
  let d = new Date(fromIso), n = 0;
  d.setUTCHours(0, 0, 0, 0);
  const end = new Date(now); end.setUTCHours(0, 0, 0, 0);
  while (d < end) { d = new Date(d.getTime() + 86400_000); const w = d.getUTCDay(); if (w !== 0 && w !== 6) n++; }
  return n;
}
