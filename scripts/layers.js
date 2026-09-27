// layers.js — the Layers panel (#19 dataset layers, #22 external overlays).
//
// The active dataset (Dataset menu) is drawn by index.html and is the one you
// browse and edit. This module adds, on top of it:
//   - more GeoVivé datasets at once, each with its own category colors
//   - external overlays from the catalog (scripts/catalog.js)
// Choices are remembered per browser and survive map style changes.

import { CATALOG, tileUrl } from "./catalog.js";
import { loadVector, addVector, removeVector, setVectorOpacity, boundsOf } from "./vector-overlays.js";

const STATE_KEY = "geovive:layers";
const state = loadState();          // { datasets: [id], overlays: { id: { on, opacity } }, groups: { name: open } }
const GROUPS_OPEN_BY_DEFAULT = new Set(["Base & terrain", "Water", "Land & boundaries"]);
const status = new Map();           // overlay id -> "loading" | error message
let appEntries = [];                // layers brought by a connected app (scripts/app-layers.js)
let appInfo = null;                 // { appId, appName, error }
const allEntries = () => CATALOG.concat(appEntries);
const loaded = new Map();          // datasetId -> { geojson, categories }
const listening = new Set();                 // layer ids with click/hover handlers

const $ = (id) => document.getElementById(id);
const map = () => window.GeoVive.map;

function esc(v) {
  return String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function loadState() {
  try {
    const s = JSON.parse(localStorage.getItem(STATE_KEY) || "null");
    if (s && Array.isArray(s.datasets) && s.overlays) return s;
  } catch { /* ignore */ }
  return { datasets: [], overlays: {} };
}
function saveState() {
  try { localStorage.setItem(STATE_KEY, JSON.stringify(state)); } catch { /* ignore */ }
}

function activeDatasetId() {
  const key = window.GeoVive.currentDataset;
  return key && key.startsWith("api:") ? key.slice(4) : null;
}

// Layers go under the map's labels, and under GeoVivé's own points.
function beforeLabels() {
  const layers = map().getStyle()?.layers || [];
  return layers.find(l => l.type === "symbol")?.id;
}

// ------------------------------------------------------------ overlays

const overlaySource = (id) => `overlay-${id}`;

const opacityOf = (entry) => state.overlays[entry.id]?.opacity ?? entry.opacity ?? 0.9;

// Vector overlays load through the relay first, then draw (unless turned off meanwhile).
async function addVectorOverlay(entry) {
  status.set(entry.id, "loading"); updateRow(entry);
  try {
    const fc = await loadVector(entry);
    status.delete(entry.id);
    if (state.overlays[entry.id]?.on && map().isStyleLoaded()) addVector(map(), entry, fc, opacityOf(entry));
  } catch (e) {
    console.error(e);
    status.set(entry.id, e.message || "Couldn't load this layer.");
  }
  updateRow(entry);
}

function addOverlay(entry) {
  const m = map();
  if (!m.isStyleLoaded()) return;
  if (entry.type === "vector") { addVectorOverlay(entry); return; }
  const opacity = opacityOf(entry);
  if (!m.getSource(overlaySource(entry.id))) {
    m.addSource(overlaySource(entry.id), {
      type: "raster",
      tiles: [tileUrl(entry)],
      tileSize: 256,
      minzoom: entry.minzoom ?? 0,
      maxzoom: entry.maxzoom ?? 22,
      attribution: entry.attribution
    });
  }
  if (!m.getLayer(overlaySource(entry.id))) {
    m.addLayer({
      id: overlaySource(entry.id), type: "raster", source: overlaySource(entry.id),
      paint: { "raster-opacity": opacity, "raster-fade-duration": 150 }
    }, beforeLabels());
  }
}

function removeOverlay(entry) {
  const m = map();
  if (entry.type === "vector") { removeVector(m, entry); status.delete(entry.id); updateRow(entry); return; }
  if (m.getLayer(overlaySource(entry.id))) m.removeLayer(overlaySource(entry.id));
  if (m.getSource(overlaySource(entry.id))) m.removeSource(overlaySource(entry.id));
}

function setOverlay(entry, on) {
  state.overlays[entry.id] = { ...(state.overlays[entry.id] || {}), on };
  saveState();
  on ? addOverlay(entry) : removeOverlay(entry);
}

function setOverlayOpacity(entry, opacity) {
  state.overlays[entry.id] = { ...(state.overlays[entry.id] || {}), opacity };
  saveState();
  if (entry.type === "vector") { setVectorOpacity(map(), entry, opacity); return; }
  if (map().getLayer(overlaySource(entry.id))) {
    map().setPaintProperty(overlaySource(entry.id), "raster-opacity", opacity);
  }
}

// ------------------------------------------------------------ extra datasets

const dsSource = (id) => `ds-${id}`;

async function ensureDatasetLoaded(id) {
  if (!loaded.has(id)) loaded.set(id, await window.GeoVive.loadDatasetFeatures(id));
  return loaded.get(id);
}

function drawDataset(id) {
  const m = map();
  const data = loaded.get(id);
  if (!data || !m.isStyleLoaded()) return;
  const hidden = id === activeDatasetId();  // the active dataset is already drawn
  if (!m.getSource(dsSource(id))) m.addSource(dsSource(id), { type: "geojson", data: data.geojson });
  else m.getSource(dsSource(id)).setData(data.geojson);
  const color = ["coalesce", ["get", "color"], "#94a3b8"];
  const before = m.getLayer("GeoVivé-fill") ? "GeoVivé-fill" : undefined;   // under the active dataset
  const layers = [
    { id: `${dsSource(id)}-fill`, type: "fill", filter: ["match", ["geometry-type"], ["Polygon", "MultiPolygon"], true, false],
      paint: { "fill-color": color, "fill-opacity": 0.15 } },
    { id: `${dsSource(id)}-line`, type: "line", filter: ["match", ["geometry-type"], ["LineString", "MultiLineString", "Polygon", "MultiPolygon"], true, false],
      paint: { "line-color": color, "line-width": 1.5, "line-opacity": 0.85 } },
    { id: dsSource(id), type: "circle", filter: ["match", ["geometry-type"], ["Point", "MultiPoint"], true, false],
      paint: {
        "circle-radius": 5.5,
        "circle-color": color,
        "circle-stroke-width": 1.2,
        "circle-stroke-color": "#020617",
        "circle-opacity": 0.85
      } }
  ];
  layers.forEach(layer => {
    if (m.getLayer(layer.id)) return;
    m.addLayer({ ...layer, source: dsSource(id) }, before);
    if (listening.has(layer.id)) return;   // map listeners outlive style switches
    listening.add(layer.id);
    m.on("click", layer.id, (e) => showDatasetPopup(id, e));
    m.on("mouseenter", layer.id, () => { m.getCanvas().style.cursor = "pointer"; });
    m.on("mouseleave", layer.id, () => { m.getCanvas().style.cursor = ""; });
  });
  layers.forEach(layer => m.setLayoutProperty(layer.id, "visibility", hidden ? "none" : "visible"));
}

function removeDatasetLayers(id) {
  const m = map();
  [dsSource(id), `${dsSource(id)}-line`, `${dsSource(id)}-fill`].forEach(l => { if (m.getLayer(l)) m.removeLayer(l); });
}

function removeDataset(id) {
  const m = map();
  removeDatasetLayers(id);
  if (m.getSource(dsSource(id))) m.removeSource(dsSource(id));
}

function showDatasetPopup(id, e) {
  const f = e.features?.[0];
  if (!f) return;
  const p = f.properties || {};
  const meta = window.GeoVive.datasets.find(d => d.datasetId === id);
  new mapboxgl.Popup({ closeOnMove: true })
    .setLngLat(f.geometry.type === "Point" ? f.geometry.coordinates : e.lngLat)
    .setHTML(`
      <div class="popup-title">${esc(p.name || "Untitled")}</div>
      <div class="popup-category">${esc(String(p.category || "").toUpperCase())} · ${esc(meta?.name || "")}</div>
      <div class="popup-desc">${esc(p.description || p.country || "")}</div>`)
    .addTo(map());
}

async function setDataset(id, on) {
  state.datasets = state.datasets.filter(x => x !== id);
  if (on) state.datasets.push(id);
  saveState();
  if (on) {
    try { await ensureDatasetLoaded(id); drawDataset(id); }
    catch (e) { console.error(e); }
  } else {
    removeDataset(id);
  }
  renderDatasets();
}

// ------------------------------------------------------------ panel

function renderDatasets() {
  const box = $("layers-datasets");
  if (!box) return;
  const active = activeDatasetId();
  const others = window.GeoVive.datasets.filter(d => d.datasetId !== active);
  if (!others.length) { box.innerHTML = `<p class="hint">No other datasets yet. Create one, or open a public one with search.</p>`; return; }
  box.innerHTML = "";
  others.forEach(d => {
    const on = state.datasets.includes(d.datasetId);
    const cats = loaded.get(d.datasetId)?.categories || [];
    const row = document.createElement("div");
    row.className = "layer-row";
    row.innerHTML = `
      <label class="layer-toggle"><input type="checkbox" ${on ? "checked" : ""} />
        ${esc(d.name)}${d.visibility === "private" ? " <span class=\"legend-count\">private</span>" : ""}
        <span class="legend-count">${d.featureCount || 0}</span></label>
      ${on && cats.length ? `<div class="layer-legend">${cats.map(c =>
        `<span><span class="legend-swatch" style="background:${c.color}"></span>${esc(c.label)}</span>`).join("")}</div>` : ""}`;
    row.querySelector("input").addEventListener("change", e => setDataset(d.datasetId, e.target.checked));
    box.appendChild(row);
  });
}

const rowEls = new Map();            // overlay id -> row element

// Status line and Zoom button of a vector overlay row
function updateRow(entry) {
  const row = rowEls.get(entry.id);
  if (!row) return;
  const st = status.get(entry.id);
  const el = row.querySelector(".layer-status");
  if (el) {
    el.textContent = st === "loading" ? "Loading…" : (st || "");
    el.dataset.kind = st && st !== "loading" ? "error" : "";
  }
  const zoom = row.querySelector(".layer-zoom");
  if (zoom) zoom.hidden = !(state.overlays[entry.id]?.on && !st);
}

function groupCount(g) {
  return allEntries().filter(e => e.group === g && state.overlays[e.id]?.on).length;
}

function renderOverlays() {
  const box = $("layers-overlays");
  if (!box) return;
  box.innerHTML = "";
  rowEls.clear();
  state.groups = state.groups || {};
  const groups = [...new Set(allEntries().map(e => e.group))];
  if (appInfo?.error) {
    const note = document.createElement("p");
    note.className = "hint layer-status";
    note.dataset.kind = "error";
    note.textContent = `Layers from this app couldn't be loaded: ${appInfo.error}`;
    box.appendChild(note);
  }
  // Connected apps share one AppConnect section, whatever app handed layers over.
  if (appEntries.length) box.appendChild(groupSection("AppConnect", appEntries, {
    app: true, intro: `From ${appInfo?.appName || "a connected app"} · shown for this visit only`
  }));
  groups.filter(g => g !== "AppConnect").forEach(g => box.appendChild(groupSection(g, allEntries().filter(e => e.group === g))));
}

function groupSection(g, entries, { app = false, intro } = {}) {
  const details = document.createElement("details");
  details.className = "layer-group" + (app ? " layer-appconnect" : "");
  const count = document.createElement("span");
  count.className = "legend-count";
  const setCount = () => { const n = entries.filter(e => state.overlays[e.id]?.on).length; count.textContent = n ? `${n} on` : ""; };
  details.open = state.groups[g] ?? (GROUPS_OPEN_BY_DEFAULT.has(g) || (app && entries.some(e => state.overlays[e.id]?.on)));
  const summary = document.createElement("summary");
  summary.className = "layer-group-title";
  summary.append(document.createTextNode(g + " "), count);
  details.appendChild(summary);
  details.addEventListener("toggle", () => { state.groups[g] = details.open; saveState(); });
  if (intro) {
    const p = document.createElement("div");
    p.className = "layer-app-title";
    p.textContent = intro;
    details.appendChild(p);
  }
  let sub = null;
  entries.forEach(entry => {
    if (app && entry.subgroup !== sub) {
      sub = entry.subgroup;
      const h = document.createElement("div");
      h.className = "layer-subgroup-title";
      h.textContent = sub;
      details.appendChild(h);
    }
    details.appendChild(layerRow(entry, setCount));
  });
  setCount();
  return details;
}

function layerRow(entry, setCount) {
      const on = !!state.overlays[entry.id]?.on;
      const row = document.createElement("div");
      row.className = "layer-row";
      row.innerHTML = `
        <label class="layer-toggle"><input type="checkbox" ${on ? "checked" : ""} />
          ${entry.color ? `<span class="legend-swatch" style="background:${esc(entry.color)}"></span>` : ""}${esc(entry.name)}</label>
        <div class="layer-meta">${esc(entry.description)}
          ${entry.source ? `<a href="${esc(entry.source)}" target="_blank" rel="noopener">Source</a> · ` : (entry.publisher ? `${esc(entry.publisher)} · ` : "")}${esc(entry.license)}</div>
        ${entry.type === "vector" ? `<div class="layer-actions"><span class="layer-status"></span>
          <button type="button" class="link-btn layer-zoom" hidden>Zoom to layer</button></div>` : ""}
        <div class="layer-opacity" ${on ? "" : "hidden"}>
          Opacity <input type="range" min="0.1" max="1" step="0.05" value="${opacityOf(entry)}" aria-label="${esc(entry.name)} opacity" />
        </div>`;
      const [toggle, slider] = row.querySelectorAll("input");
      toggle.addEventListener("change", () => {
        setOverlay(entry, toggle.checked);
        row.querySelector(".layer-opacity").hidden = !toggle.checked;
        setCount();
        updateRow(entry);
      });
      slider.addEventListener("input", () => setOverlayOpacity(entry, Number(slider.value)));
      row.querySelector(".layer-zoom")?.addEventListener("click", async () => {
        const b = boundsOf(await loadVector(entry));
        if (!b.isEmpty()) map().fitBounds(b, { padding: 40 });
      });
      rowEls.set(entry.id, row);
      queueMicrotask(() => updateRow(entry));
      return row;
}

// Re-create everything after a style switch (setStyle drops custom layers).
function reapplyAll() {
  allEntries().forEach(e => { if (state.overlays[e.id]?.on) addOverlay(e); });
  state.datasets.forEach(id => drawDataset(id));
}

// ------------------------------------------------------------ init

async function init() {
  await window.GeoVive.ready;
  const m = map();

  renderOverlays();
  renderDatasets();
  reapplyAll();

  m.on("style.load", () => setTimeout(reapplyAll, 0));

  // A connected app's layers come and go with the app (scripts/app-layers.js)
  window.addEventListener("geovive:app-layers", (e) => {
    const { appId, appName, entries = [], turnOn = [], error } = e.detail || {};
    appEntries.forEach(old => { if (!entries.some(n => n.id === old.id)) removeOverlay(old); });
    appEntries = entries;
    appInfo = appId ? { appId, appName, error } : null;
    if (turnOn.length) {
      turnOn.forEach(id => { state.overlays[id] = { ...(state.overlays[id] || {}), on: true }; });
      saveState();
    }
    renderOverlays();
    appEntries.forEach(entry => { if (state.overlays[entry.id]?.on) addOverlay(entry); });
    if (turnOn.length) { const panel = document.getElementById("layers-panel"); if (panel) panel.open = true; }
  });

  // Dataset list changes (sign-in, new maps): drop layers the user can no longer see
  window.addEventListener("geovive:datasets-listed", async (e) => {
    const visible = new Set(e.detail.datasets.map(d => d.datasetId));
    state.datasets.filter(id => !visible.has(id)).forEach(removeDataset);
    state.datasets = state.datasets.filter(id => visible.has(id));
    saveState();
    for (const id of state.datasets) {
      try { await ensureDatasetLoaded(id); drawDataset(id); } catch (err) { console.error(err); }
    }
    renderDatasets();
  });

  // Active dataset changed: don't draw it twice; refresh the list
  window.addEventListener("geovive:dataset-applied", () => {
    loaded.delete(activeDatasetId());   // pick up edits next time it's an extra layer
    state.datasets.forEach(id => drawDataset(id));
    renderDatasets();
  });

  for (const id of state.datasets) {
    try { await ensureDatasetLoaded(id); drawDataset(id); } catch (err) { console.error(err); }
  }
  renderDatasets();
}

init().catch(e => console.error("Layers init failed", e));
