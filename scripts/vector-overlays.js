// vector-overlays.js — clickable layers that connected apps bring to GeoVivé.
//
// Each layer comes from the app's layer list (scripts/app-layers.js):
//   relay   GET /v1/relay/{appId}/{layerId} returns a link to a cached,
//           simplified GeoJSON file with a `_label` per feature and readable fields
//   direct  the browser loads the source itself and shapes it the same way
// Each layer is drawn as a fill, an outline and labels; clicking a feature
// shows its details.

const cache = new Map();        // id -> Promise<FeatureCollection>
const active = new Map();       // id -> entry (currently shown)
let clickWired = false;

const ids = (id) => ({ fill: `ov-${id}-fill`, line: `ov-${id}-line`, label: `ov-${id}-label`, source: `ov-${id}` });
const FOCUS = "ov-focus";

function esc(v) {
  return String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ------------------------------------------------------------ data

// Direct layers: the browser fetches the source (for sources whose terms don't
// allow GeoVivé to keep a copy) and shapes it like relay output.
const clean = (v) => (v === null || v === undefined || String(v).trim() === "" || /^<?null>?$/i.test(String(v).trim()) ? undefined : v);
const getField = (p, k) => (k in p ? p[k] : p[Object.keys(p).find(x => x.toLowerCase() === k.toLowerCase())]);

async function loadDirect(entry) {
  const d = entry.direct;
  const fields = [...new Set([...d.label.matchAll(/\{(\w+)\}/g)].map(m => m[1]).concat(Object.keys(d.fields || {})))];
  let url = d.source.url;
  if (d.source.type === "arcgis") {
    url += `/query?where=${encodeURIComponent(d.source.where || "1=1")}&outFields=${encodeURIComponent(fields.join(","))}` +
      `&returnGeometry=true&outSR=4326&maxAllowableOffset=${d.tolerance || 0.001}&geometryPrecision=5&f=geojson`;
  } else if (d.source.type === "wfs") {
    url += `${url.includes("?") ? "&" : "?"}service=WFS&version=2.0.0&request=GetFeature&typeNames=${encodeURIComponent(d.source.typeName)}` +
      `&outputFormat=application/json&srsName=EPSG:4326`;
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Layer unavailable (${res.status})`);
  const fc = await res.json();
  if (fc.error) throw new Error(fc.error.message || "Layer unavailable");
  const features = fc.type === "Feature" ? [fc] : (fc.features || []);
  return {
    type: "FeatureCollection",
    features: features.filter(f => f.geometry).map(f => {
      const p = f.properties || {};
      const props = { _label: d.label.replace(/\{(\w+)\}/g, (_, k) => clean(getField(p, k)) ?? "").replace(/\s+/g, " ").trim() };
      Object.entries(d.fields || {}).forEach(([k, title]) => { const v = clean(getField(p, k)); if (v !== undefined) props[title] = v; });
      return { type: "Feature", geometry: f.geometry, properties: props };
    }).filter(f => f.properties._label)
  };
}

export function loadVector(entry) {
  if (!cache.has(entry.id)) {
    const p = entry.direct ? loadDirect(entry) : (async () => {
      const res = await fetch(`${window.GeoVive.apiBase}/v1/relay/${encodeURIComponent(entry.appId)}/${encodeURIComponent(entry.layerId)}`);
      const info = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(info.message || `Layer unavailable (${res.status})`);
      const data = await fetch(info.url);
      if (!data.ok) throw new Error(`Layer download failed (${data.status})`);
      return data.json();
    })();
    p.catch(() => cache.delete(entry.id));   // allow a retry after a failure
    cache.set(entry.id, p);
  }
  return cache.get(entry.id);
}

export function boundsOf(fc) {
  const b = new mapboxgl.LngLatBounds();
  const walk = (c) => typeof c[0] === "number" ? b.extend(c) : c.forEach(walk);
  fc.features.forEach(f => f.geometry && walk(f.geometry.coordinates));
  return b;
}

// ------------------------------------------------------------ drawing

function beforeUserData(map) {
  return map.getLayer("GeoVivé-fill") ? "GeoVivé-fill" : undefined;
}

export function addVector(map, entry, fc, opacity) {
  const n = ids(entry.id);
  if (!map.getSource(n.source)) map.addSource(n.source, { type: "geojson", data: fc, attribution: entry.attribution });
  const before = beforeUserData(map);
  const color = entry.color || "#f59e0b";
  if (!map.getLayer(n.fill)) map.addLayer({ id: n.fill, type: "fill", source: n.source,
    paint: { "fill-color": color, "fill-opacity": 0.12 * opacity } }, before);
  if (!map.getLayer(n.line)) map.addLayer({ id: n.line, type: "line", source: n.source,
    paint: { "line-color": color, "line-width": ["interpolate", ["linear"], ["zoom"], 4, 0.8, 10, 2], "line-opacity": opacity } }, before);
  if (!map.getLayer(n.label)) map.addLayer({ id: n.label, type: "symbol", source: n.source, minzoom: entry.labelMinZoom ?? 5.5,
    layout: { "text-field": ["get", "_label"], "text-size": 11, "text-max-width": 8, "text-allow-overlap": false },
    paint: { "text-color": "#f8fafc", "text-halo-color": "#020617", "text-halo-width": 1.4, "text-opacity": Math.min(1, opacity + 0.2) } }, before);
  active.set(entry.id, entry);
  wireClicks(map);
}

export function removeVector(map, entry) {
  const n = ids(entry.id);
  [n.label, n.line, n.fill].forEach(l => { if (map.getLayer(l)) map.removeLayer(l); });
  if (map.getSource(n.source)) map.removeSource(n.source);
  active.delete(entry.id);
}

export function setVectorOpacity(map, entry, opacity) {
  const n = ids(entry.id);
  if (map.getLayer(n.fill)) map.setPaintProperty(n.fill, "fill-opacity", 0.12 * opacity);
  if (map.getLayer(n.line)) map.setPaintProperty(n.line, "line-opacity", opacity);
  if (map.getLayer(n.label)) map.setPaintProperty(n.label, "text-opacity", Math.min(1, opacity + 0.2));
}

// ------------------------------------------------------------ clicks

function valueHtml(v) {
  const s = String(v);
  if (/^https?:\/\//i.test(s)) return `<a href="${esc(s)}" target="_blank" rel="noopener">Open ↗</a>`;
  if (s.length > 160) return `<details><summary>${esc(s.slice(0, 80))}…</summary>${esc(s)}</details>`;
  return esc(s);
}

function popupHtml(entry, props) {
  const rows = Object.entries(props).filter(([k]) => k !== "_label")
    .map(([k, v]) => `<tr><th>${esc(k)}</th><td>${valueHtml(v)}</td></tr>`).join("");
  return `
    <div class="popup-title">${esc(props._label)}</div>
    <div class="popup-category">${esc(entry.name)}</div>
    ${rows ? `<table class="ov-table">${rows}</table>` : ""}
    <div class="ov-source">${esc(entry.publisher || entry.attribution || "")}. Boundaries simplified for display; check official regulations.</div>`;
}

// One handler for all overlays: the topmost overlay under the cursor wins,
// and GeoVivé's own pins and shapes take priority over overlays.
function wireClicks(map) {
  if (clickWired) return;
  clickWired = true;
  map.on("click", (e) => {
    const own = ["GeoVivé-layer", "GeoVivé-line", "GeoVivé-fill"].filter(l => map.getLayer(l));
    if (own.length && map.queryRenderedFeatures(e.point, { layers: own }).length) return;
    const layers = [...active.keys()].map(id => ids(id).fill).filter(l => map.getLayer(l));
    if (!layers.length) return;
    const hit = map.queryRenderedFeatures(e.point, { layers })[0];
    if (!hit) return;
    const entry = active.get(hit.layer.id.slice(3, -5));
    new mapboxgl.Popup({ closeOnMove: true, maxWidth: "320px" })
      .setLngLat(e.lngLat).setHTML(popupHtml(entry, hit.properties)).addTo(map);
  });
  map.on("mousemove", (e) => {
    const layers = [...active.keys()].map(id => ids(id).fill).filter(l => map.getLayer(l));
    if (!layers.length) return;
    const over = map.queryRenderedFeatures(e.point, { layers }).length > 0;
    if (over) map.getCanvas().style.cursor = "pointer";
    else if (map.getCanvas().style.cursor === "pointer" && !map.queryRenderedFeatures(e.point).some(f => f.layer.id.startsWith("GeoVivé"))) map.getCanvas().style.cursor = "";
  });
}

// ------------------------------------------------------------ focus

// Zoom to a feature of a layer by its label (e.g. "GMU 61") and outline it.
export async function focusFeature(map, entry, text) {
  const fc = await loadVector(entry);
  const want = String(text).trim().toLowerCase();
  const f = fc.features.find(x => String(x.properties._label).toLowerCase() === want)
    || fc.features.find(x => String(x.properties._label).toLowerCase().includes(want));
  if (!f) return false;
  const one = { type: "FeatureCollection", features: [f] };
  if (map.getSource(FOCUS)) map.getSource(FOCUS).setData(one);
  else {
    map.addSource(FOCUS, { type: "geojson", data: one });
    map.addLayer({ id: FOCUS, type: "line", source: FOCUS, paint: { "line-color": "#facc15", "line-width": 3 } });
  }
  const b = boundsOf(one);
  if (!b.isEmpty()) map.fitBounds(b, { padding: 60, maxZoom: 12 });
  return true;
}
