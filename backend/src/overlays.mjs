// overlays.mjs — layers that connected apps bring to GeoVivé, and the relay.
//
// GeoVivé keeps no subject-matter layers of its own. A connected app publishes
// a layer list (JSON) describing its layers: where each layer's data comes
// from, how to label it, which fields to show, credits and license. When a
// user arrives from that app (an "Open in GeoVivé" link, or one of the app's
// maps), GeoVivé shows the app's layers under the app's name.
//
// Delivery per layer:
//   relay   GeoVivé's server fetches the source, simplifies shapes for display,
//           keeps the listed fields, cleans values, and caches the result
//           (default a day) so browsers get one small file.
//   direct  the browser loads the source itself (for sources whose terms don't
//           allow a cached copy, or that the app hosts for browsers).
//
// Source types: arcgis (FeatureServer/MapServer layer), wfs (OGC WFS 2.0),
// geojson (a GeoJSON file URL).

import { simplifyGeometry } from "./geometry.mjs";

const TOLERANCE = 0.0005;            // degrees (~50 m): fine for viewing, not for legal boundaries
const FETCH_TIMEOUT_MS = 20_000;
export const MAX_LAYERS = 200;
const SOURCE_TYPES = new Set(["arcgis", "wfs", "geojson"]);
const COLOR = /^#[0-9a-f]{6}$/i;

export class LayerListError extends Error {}

const str = (v, max) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined);

function httpsUrl(v, what) {
  let u;
  try { u = new URL(v); } catch { throw new LayerListError(`${what} is not a valid URL`); }
  if (u.protocol !== "https:") throw new LayerListError(`${what} must use https`);
  if (/^(\d+\.){3}\d+$|^\[|^localhost$/i.test(u.hostname)) throw new LayerListError(`${what} must use a public host name`);
  return u.toString().replace(/\/$/, "");
}

// Validate an app's layer list; returns normalized layers (unknown keys dropped).
export function validateLayerList(json) {
  if (!json || typeof json !== "object" || !Array.isArray(json.layers)) throw new LayerListError("Layer list must have a layers array");
  if (json.layers.length > MAX_LAYERS) throw new LayerListError(`Layer list has more than ${MAX_LAYERS} layers`);
  const seen = new Set();
  const layers = json.layers.map((l, i) => {
    const where = `layers[${i}]`;
    const id = str(l?.id, 64);
    if (!id || !/^[a-z0-9][a-z0-9_-]*$/i.test(id)) throw new LayerListError(`${where}.id must be letters, numbers, - or _`);
    if (seen.has(id)) throw new LayerListError(`Duplicate layer id ${id}`);
    seen.add(id);
    const name = str(l.name, 120);
    if (!name) throw new LayerListError(`${where}.name is required`);
    const s = l.source || {};
    if (!SOURCE_TYPES.has(s.type)) throw new LayerListError(`${where}.source.type must be arcgis, wfs or geojson`);
    const source = { type: s.type, url: httpsUrl(s.url, `${where}.source.url`) };
    if (s.type === "arcgis" && !/\/(FeatureServer|MapServer)\/\d+$/i.test(source.url)) {
      throw new LayerListError(`${where}.source.url must end in /FeatureServer/<n> or /MapServer/<n>`);
    }
    if (s.type === "wfs") {
      source.typeName = str(s.typeName, 200);
      if (!source.typeName) throw new LayerListError(`${where}.source.typeName is required for wfs`);
      source.geometryField = str(s.geometryField, 64);
    }
    if (str(s.where, 1000)) source.where = str(s.where, 1000);
    if (s.paging === false) source.paging = false;
    const label = str(l.label, 200);
    if (!label || !/\{\w+\}/.test(label)) throw new LayerListError(`${where}.label must use at least one {FIELD}`);
    const fields = {};
    Object.entries(l.fields && typeof l.fields === "object" ? l.fields : {}).slice(0, 40)
      .forEach(([k, v]) => { if (/^[\w.]{1,64}$/.test(k) && str(v, 80)) fields[k] = str(v, 80); });
    const tol = Number(l.tolerance);
    return {
      id, name,
      group: str(l.group, 80),
      color: COLOR.test(l.color || "") ? l.color : undefined,
      description: str(l.description, 500),
      attribution: str(l.attribution, 200),
      license: str(l.license, 200),
      source, label, fields,
      tolerance: Number.isFinite(tol) && tol > 0 && tol <= 0.01 ? tol : undefined,
      delivery: l.delivery === "direct" ? "direct" : "relay",
      cacheHours: Math.min(168, Math.max(1, Number(l.cacheHours) || 24))
    };
  });
  return { title: str(json.title, 120), layers };
}

// What browsers get: display settings; the source only for direct layers
// (relayed sources stay between the app and GeoVivé's server).
export function publicLayer(l) {
  const out = {
    id: l.id, name: l.name, group: l.group, color: l.color, description: l.description,
    attribution: l.attribution, license: l.license, delivery: l.delivery
  };
  if (l.delivery === "direct") Object.assign(out, { source: l.source, label: l.label, fields: l.fields, tolerance: l.tolerance });
  return out;
}

// ------------------------------------------------------------------ values

// Clean a field value: drop blanks/placeholders, pull URLs out of <a href>, strip tags.
export function cleanValue(v) {
  if (v === null || v === undefined) return undefined;
  if (typeof v === "number") return Number.isFinite(v) ? Math.round(v * 100) / 100 : undefined;
  let s = String(v).trim();
  if (!s || /^<?null>?$/i.test(s)) return undefined;
  const href = /<a\s[^>]*href\s*=\s*["']([^"']+)["']/i.exec(s);
  if (href) s = href[1];
  s = s.replace(/<[^>]*>/g, "").replace(/\s+\r?\n/g, "\n").trim();
  if (!s) return undefined;
  if (/^(https?:)?\/\//i.test(s) && !/^https?:\/\//i.test(s)) s = `https:${s}`;
  return s.slice(0, 4000);
}

function getField(props, name) {
  if (name in props) return props[name];
  const k = Object.keys(props).find(k => k.toLowerCase() === name.toLowerCase());
  return k === undefined ? undefined : props[k];
}

export function renderLabel(template, props) {
  const out = template.replace(/\{(\w+)\}/g, (_, f) => {
    const v = cleanValue(getField(props, f));
    return v === undefined ? "" : String(v);
  }).replace(/\s+/g, " ").trim();
  return out;
}

// Keep only what the overlay shows; returns null for features without geometry or label.
export function toOverlayFeature(src, f) {
  const g = f?.geometry;
  if (!g || !/Polygon|LineString|Point/.test(g.type || "")) return null;
  const props = f.properties || {};
  const label = renderLabel(src.label, props);
  // A label with no field values (template text only) means an empty record
  const fieldsInLabel = [...src.label.matchAll(/\{(\w+)\}/g)].map(m => cleanValue(getField(props, m[1])));
  if (!label || fieldsInLabel.every(v => v === undefined)) return null;
  const out = { _label: label };
  for (const [field, title] of Object.entries(src.fields)) {
    const v = cleanValue(getField(props, field));
    if (v !== undefined) out[title] = v;
  }
  return { type: "Feature", geometry: g.type.includes("Point") ? g : simplifyGeometry(g, src.tolerance || TOLERANCE), properties: out };
}

// ------------------------------------------------------------------ fetching

async function getJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`source returned HTTP ${res.status}`);
  const j = await res.json();
  if (j.error) throw new Error(`source error: ${j.error.message || "unknown"}`);
  return j;
}

function outFieldsFor(src) {   // src = a validated layer
  const names = new Set([...src.label.matchAll(/\{(\w+)\}/g)].map(m => m[1]));
  Object.keys(src.fields).forEach(f => names.add(f));
  return [...names].join(",");
}

async function fetchArcgis(src) {
  const base = `${src.source.url}/query?where=${encodeURIComponent(src.source.where || "1=1")}&outFields=${encodeURIComponent(outFieldsFor(src))}` +
    `&returnGeometry=true&outSR=4326&maxAllowableOffset=${src.tolerance || TOLERANCE}&geometryPrecision=5&f=geojson`;
  if (src.source.paging === false) return (await getJson(base)).features || [];
  const features = [];
  const size = 1000;
  for (let offset = 0; offset < 50_000; offset += size) {
    const page = await getJson(`${base}&resultOffset=${offset}&resultRecordCount=${size}`);
    const got = page.features || [];
    features.push(...got);
    if (got.length < size && !page.exceededTransferLimit && !page.properties?.exceededTransferLimit) break;
    if (!got.length) break;
  }
  return features;
}

async function fetchWfs(src) {
  const s = src.source;
  const props = [...new Set([...outFieldsFor(src).split(","), s.geometryField].filter(Boolean))].join(",");
  const url = `${s.url}${s.url.includes("?") ? "&" : "?"}service=WFS&version=2.0.0&request=GetFeature&typeNames=${encodeURIComponent(s.typeName)}` +
    `&outputFormat=application/json&srsName=EPSG:4326&propertyName=${encodeURIComponent(props)}`;
  return (await getJson(url)).features || [];
}

async function fetchGeojson(src) {
  const j = await getJson(src.source.url);
  if (j.type === "FeatureCollection") return j.features || [];
  if (j.type === "Feature") return [j];
  throw new Error("source is not GeoJSON");
}

// Fetch, simplify and clean one relayed layer.
export async function buildLayer(layer) {
  const t = layer.source.type;
  const raw = t === "wfs" ? await fetchWfs(layer) : t === "geojson" ? await fetchGeojson(layer) : await fetchArcgis(layer);
  const features = raw.map(f => toOverlayFeature(layer, f)).filter(Boolean);
  if (!features.length) throw new Error("source returned no usable features");
  return { type: "FeatureCollection", geovive: { layer: layer.id, fetchedAt: new Date().toISOString(), count: features.length }, features };
}
