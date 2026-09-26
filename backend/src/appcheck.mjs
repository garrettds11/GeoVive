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

export async function runChecks(app, net) {
  const { fetch, resolveTxt, lookup } = net;
  const checks = [], layers = [], notes = [];
  const at = new Date().toISOString();
  const done = () => {
    const failed = checks.some(c => c.result === "fail") || layers.some(l => l.result === "fail");
    return { at, version: CHECKS_VERSION, passed: !failed, checks, layers, notes };
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
  let raw, list;
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
  const results = await pool(list.layers, 4, async layer => {
    const row = { id: layer.id, name: layer.name, group: layer.group, type: layer.source.type, delivery: layer.delivery, result: "pass", issues: [] };
    const run = await timed(async () => {
      await publicHost(hostOf(layer.source.url), lookup);
      return buildLayer(layer);
    });
    row.ms = run.ms;
    if (run.error) { row.result = "fail"; row.issues.push(`Source didn't respond with shapes (${run.error.message})`); return row; }
    row.features = run.value.features.length;
    if (!row.features) { row.result = "fail"; row.issues.push("No shapes returned, or the label didn't fill in on any feature"); }
    if (run.ms > SLOW_MS) { row.result = row.result === "fail" ? "fail" : "note"; row.issues.push(`Source took ${(run.ms / 1000).toFixed(1)} s${layer.delivery === "relay" ? "; relay caching hides this from users" : ""}`); }
    if (layer.delivery === "direct") {
      try {
        const probe = layer.source.type === "arcgis" ? `${layer.source.url}?f=json` : layer.source.url;
        const res = await fetch(probe, { headers: { Origin: "https://geovive.link" }, signal: AbortSignal.timeout(10_000) });
        const acao = res.headers.get("access-control-allow-origin");
        row.cors = acao === "*" || acao === "https://geovive.link";
        if (!row.cors) { row.result = "fail"; row.issues.push("Direct layer's source doesn't allow browser requests from geovive.link (CORS)"); }
      } catch (e) { row.result = "fail"; row.issues.push(`CORS check failed (${e.message})`); }
    }
    const pii = Object.keys(layer.fields || {}).filter(f => PII.test(f));
    if (pii.length) { row.result = "fail"; row.issues.push(`Shown fields look like personal information: ${pii.join(", ")}`); }
    const rawLayer = raw.layers.find(l => l.id === layer.id) || {};
    if (GENERIC_LICENSE.test((rawLayer.license || "").trim())) {
      if (row.result === "pass") row.result = "note";
      row.issues.push(`License text “${rawLayer.license}” is generic; name the source's terms or link to them`);
    }
    return row;
  });
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
