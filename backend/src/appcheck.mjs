// appcheck.mjs — AppConnect connection checks.
//
// Given an app record, checks that:
//   1. the app controls its domain (DNS TXT or /.well-known/geovive.txt token)
//   2. its layer list is on that domain, valid, and complete (credits, labels)
//   3. every source answers from a public address, returns shapes, and labels fill in
//   4. direct layers allow browser requests from GeoVivé
//   5. shown fields don't look like personal information
// Returns a structured result the report and the status change are built from.
//
// Network access is injected (fetch, resolveTxt, lookup) so tests can run offline.

import { validateLayerList, buildLayer, LayerListError } from "./overlays.mjs";
import { createHash } from "node:crypto";

export const CHECKS_VERSION = "AppConnect checks 1.0";
const SLOW_MS = 5000;
const PII = /(^|_)(e?mail|phone|tel|mobile|ssn|dob|birth|first_?name|last_?name|full_?name|owner_?name|address)($|_)/i;
const GENERIC_LICENSE = /^(official( agency)? data|n\/?a|none|unknown|tbd|various)\.?$/i;

// True for addresses GeoVivé must never fetch (private, loopback, link-local, metadata).
export function isPrivateAddress(ip) {
  if (/^(10|127|0)\./.test(ip)) return true;
  if (/^169\.254\./.test(ip) || /^192\.168\./.test(ip)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return true;
  if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(ip)) return true;   // carrier-grade NAT
  const v6 = ip.toLowerCase();
  if (v6 === "::1" || v6 === "::" || v6.startsWith("fe80:") || v6.startsWith("fc") || v6.startsWith("fd")) return true;
  if (v6.startsWith("::ffff:")) return isPrivateAddress(v6.slice(7));
  return false;
}

async function publicHost(host, lookup) {
  const addrs = await lookup(host, { all: true });
  if (!addrs.length) throw new Error(`${host} doesn't resolve`);
  const bad = addrs.find(a => isPrivateAddress(a.address));
  if (bad) throw new Error(`${host} resolves to a private address`);
}

const hostOf = url => { try { return new URL(url).hostname; } catch { return null; } };
const onDomain = (host, domain) => host === domain || host?.endsWith("." + domain);

function check(key, name, result, detail) { return { key, name, result, detail }; }

async function timed(fn) {
  const t = Date.now();
  try { return { value: await fn(), ms: Date.now() - t }; }
  catch (error) { return { error, ms: Date.now() - t }; }
}

// Run a list of async jobs with limited concurrency.
async function pool(items, n, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
  }));
  return out;
}

// Patterns for personal information inside values (not just field names)
const VALUE_PII = [
  ["email address", /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i],
  ["phone number", /(?:\+?1[\s.-]?)?\(?\b\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b/],
  ["street address", /\b\d{1,6}\s+(?:[NSEW]\.?\s+)?[A-Z][a-z]+(?:\s[A-Z][a-z]+)*\s(?:St|Street|Ave|Avenue|Rd|Road|Dr|Drive|Ln|Lane|Ct|Court|Blvd|Way|Pl|Place)\b/]
];
const MAX_FEATURES = 50_000;

function coordsOk(geom) {
  let ok = true;
  const walk = c => { if (typeof c[0] === "number") { if (!(c[0] >= -180 && c[0] <= 180 && c[1] >= -90 && c[1] <= 90)) ok = false; } else c.forEach(walk); };
  if (geom?.coordinates) walk(geom.coordinates);
  (geom?.geometries || []).forEach(g => { if (!coordsOk(g)) ok = false; });
  return ok;
}

// Check one layer. Results: pass, note (fine, with advice), review (a person must
// look before it's shown), fail (can't be shown).
export async function checkLayer(layer, rawLayer, net) {
  const { fetch, lookup } = net;
  const row = { id: layer.id, name: layer.name, group: layer.group, type: layer.source.type, delivery: layer.delivery, result: "pass", issues: [] };
  const worse = r => { const order = { pass: 0, note: 1, review: 2, fail: 3 }; if (order[r] > order[row.result]) row.result = r; };
  const run = await timed(async () => {
    await publicHost(hostOf(layer.source.url), lookup);
    return buildLayer(layer);
  });
  row.ms = run.ms;
  if (run.error) { worse("fail"); row.issues.push(`Source didn't respond with shapes (${run.error.message})`); return row; }
  const feats = run.value.features;
  row.features = feats.length;
  if (!row.features) { worse("fail"); row.issues.push("No shapes returned, or the label didn't fill in on any feature"); }
  if (row.features > MAX_FEATURES) { worse("fail"); row.issues.push(`${row.features.toLocaleString("en-US")} shapes is over the ${MAX_FEATURES.toLocaleString("en-US")} limit; split the layer`); }
  if (feats.some(f => !coordsOk(f.geometry))) { worse("fail"); row.issues.push("Some coordinates are outside valid longitude/latitude ranges"); }
  if (run.ms > SLOW_MS) { worse("note"); row.issues.push(`Source took ${(run.ms / 1000).toFixed(1)} s${layer.delivery === "relay" ? "; relay caching hides this from users" : ""}`); }
  if (layer.delivery === "direct") {
    try {
      const probe = layer.source.type === "arcgis" ? `${layer.source.url}?f=json` : layer.source.url;
      const res = await fetch(probe, { headers: { Origin: "https://geovive.link" }, signal: AbortSignal.timeout(10_000) });
      const acao = res.headers.get("access-control-allow-origin");
      row.cors = acao === "*" || acao === "https://geovive.link";
      if (!row.cors) { worse("fail"); row.issues.push("Direct layer's source doesn't allow browser requests from geovive.link (CORS)"); }
    } catch (e) { worse("fail"); row.issues.push(`CORS check failed (${e.message})`); }
  }
  const pii = Object.keys(layer.fields || {}).filter(f => PII.test(f));
  if (pii.length) { worse("fail"); row.issues.push(`Shown fields look like personal information: ${pii.join(", ")}`); }
  // Values people will see: labels and shown fields, on up to 500 features
  const found = new Map();
  for (const f of feats.slice(0, 500)) {
    for (const [k, v] of Object.entries(f.properties || {})) {
      if (typeof v !== "string") continue;
      for (const [what, re] of VALUE_PII) if (re.test(v) && !found.has(what)) found.set(what, k === "_label" ? "labels" : k);
    }
  }
  if (found.size) { worse("review"); row.issues.push(`Values may contain personal information (${[...found].map(([w, k]) => `${w} in ${k}`).join(", ")}); a GeoVivé reviewer will look before it's shown`); }
  if (GENERIC_LICENSE.test((rawLayer.license || "").trim())) {
    worse("note");
    row.issues.push(`License text “${rawLayer.license}” is generic; name the source's terms or link to them`);
  }
  row.hash = layerHash(layer);
  return row;
}

// Fingerprint of a validated layer: any change to its settings is a new version.
export function layerHash(layer) {
  return createHash("sha256").update(JSON.stringify(layer)).digest("hex").slice(0, 16);
}

// Fetch and validate an app's layer list from its verified domain.
export async function fetchLayerList(app, net) {
  const host = hostOf(app.layersUrl);
  if (!app.layersUrl?.startsWith("https://") || !onDomain(host, app.domain)) throw new Error(`The layer list must be served over HTTPS from ${app.domain}`);
  await publicHost(host, net.lookup);
  const res = await net.fetch(app.layersUrl, { redirect: "error", signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return validateLayerList(await res.json());
}

export async function runChecks(app, net) {
  const { fetch, resolveTxt, lookup } = net;
  const checks = [], layers = [], notes = [];
  let list;
  const at = new Date().toISOString();
  const done = () => {
    const failed = checks.some(c => c.result === "fail") || layers.some(l => l.result === "fail");
    return { at, version: CHECKS_VERSION, passed: !failed, checks, layers, notes, list };
  };

  // 1. Domain ownership
  const token = `geovive-verify=${app.verifyToken}`;
  let owned = false, how = "";
  try {
    const recs = (await resolveTxt(`_geovive.${app.domain}`)).map(r => r.join(""));
    if (recs.includes(token)) { owned = true; how = `DNS TXT _geovive.${app.domain} matches the issued token`; }
  } catch { /* no record */ }
  if (!owned) {
    try {
      await publicHost(app.domain, lookup);
      const res = await fetch(`https://${app.domain}/.well-known/geovive.txt`, { redirect: "error", signal: AbortSignal.timeout(10_000) });
      if (res.ok && (await res.text()).includes(app.verifyToken)) { owned = true; how = `https://${app.domain}/.well-known/geovive.txt contains the issued token`; }
    } catch { /* no file */ }
  }
  checks.push(check("domain", "Domain ownership", owned ? "pass" : "fail", owned ? how
    : `Publish TXT _geovive.${app.domain} = "${token}", or put the token in https://${app.domain}/.well-known/geovive.txt`));
  if (!owned) return done();

  // 2. Layer list
  const listHost = hostOf(app.layersUrl);
  if (!app.layersUrl?.startsWith("https://") || !onDomain(listHost, app.domain)) {
    checks.push(check("list", "Layer list", "fail", `The layer list must be served over HTTPS from ${app.domain}`));
    return done();
  }
  let raw;
  const got = await timed(async () => {
    await publicHost(listHost, lookup);
    const res = await fetch(app.layersUrl, { redirect: "error", signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  });
  if (got.error) {
    checks.push(check("list", "Layer list", "fail", `Couldn't load ${app.layersUrl} (${got.error.message})`));
    return done();
  }
  raw = got.value;
  try { list = validateLayerList(raw); }
  catch (e) {
    checks.push(check("list", "Layer list", "fail", e instanceof LayerListError ? e.message : "The layer list isn't valid"));
    return done();
  }
  if (!list.layers.length) {
    checks.push(check("list", "Layer list", "fail", "The layer list has no layers"));
    return done();
  }
  checks.push(check("list", "Layer list", "pass", `Found on your verified domain; valid format, ${list.layers.length} layers, IDs unique`));

  // Required credits and display settings (checked on the raw list, since validation fills defaults)
  const missing = [];
  raw.layers.forEach(l => {
    for (const k of ["group", "label", "attribution", "license"]) if (!(typeof l[k] === "string" && l[k].trim())) missing.push(`${l.id}: ${k}`);
  });
  checks.push(check("fields", "Required fields", missing.length ? "fail" : "pass",
    missing.length ? `Missing ${missing.slice(0, 6).join(", ")}${missing.length > 6 ? ` and ${missing.length - 6} more` : ""}`
      : "Every layer has a name, group, label, attribution and license"));

  // 3–5. Each source
  const results = await pool(list.layers, 4, layer => checkLayer(layer, raw.layers.find(l => l.id === layer.id) || {}, net));
  layers.push(...results);

  const n = layers.length, ok = layers.filter(l => l.features > 0).length;
  const direct = layers.filter(l => l.delivery === "direct");
  checks.push(check("sources", "Sources and shapes", ok === n ? "pass" : "fail", `${ok} of ${n} sources returned labelled shapes from public hosts`));
  if (direct.length) {
    const good = direct.filter(l => l.cors).length;
    checks.push(check("cors", "Direct layers (CORS)", good === direct.length ? "pass" : "fail", `${good} of ${direct.length} direct layers allow browser requests from geovive.link`));
  }
  const piiRows = layers.filter(l => l.issues.some(i => i.startsWith("Shown fields")));
  checks.push(check("pii", "Personal information", piiRows.length ? "fail" : "pass",
    piiRows.length ? `${piiRows.length} layer(s) show fields that look like personal information` : "No shown field looks like names, emails, phone numbers or addresses"));

  const reviews = layers.filter(l => l.result === "review");
  checks.push(check("review", "Human review", reviews.length ? "note" : "pass",
    reviews.length ? `${reviews.length} layer(s) will be shown after a GeoVivé reviewer looks at them (up to 5 business days)`
      : "No layer needs a person's review"));

  // Return addresses
  const bad = (app.returnOrigins || []).filter(o => { const h = hostOf(o); return !(o.startsWith("https://") && onDomain(h, app.domain)) && !/^http:\/\/localhost(:\d+)?$/.test(o); });
  const local = (app.returnOrigins || []).filter(o => /^http:\/\/localhost/.test(o));
  checks.push(check("origins", "Return addresses", bad.length ? "fail" : local.length ? "note" : "pass",
    bad.length ? `Not on ${app.domain}: ${bad.join(", ")}`
      : local.length ? `${local.join(", ")} works for sandbox testing only and is ignored once live` : `All on ${app.domain}`));

  const slow = layers.filter(l => l.ms > SLOW_MS).length;
  if (slow) notes.push(`${slow} slow source(s); see layer results`);
  return done();
}
