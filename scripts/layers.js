// layers.js — the Layers panel (#19 dataset layers, #22 external overlays).
//
// The active dataset (Dataset menu) is drawn by index.html and is the one you
// browse and edit. This module adds, on top of it:
//   - more GeoVivé datasets at once, each with its own category colors
//   - external overlays from the catalog (scripts/catalog.js)
// Choices are remembered per browser and survive map style changes.

import { CATALOG, tileUrl } from "./catalog.js";

const STATE_KEY = "geovive:layers";
const state = loadState();          // { datasets: [id], overlays: { id: { on, opacity } } }
const loaded = new Map();           // datasetId -> { geojson, categories }

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

function addOverlay(entry) {
  const m = map();
  if (!m.isStyleLoaded()) return;
  const cfg = state.overlays[entry.id] || {};
  const opacity = cfg.opacity ?? entry.opacity;
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
  if (!m.getLayer(dsSource(id))) {
    m.addLayer({
      id: dsSource(id), type: "circle", source: dsSource(id),
      paint: {
        "circle-radius": 5.5,
        "circle-color": ["coalesce", ["get", "color"], "#94a3b8"],
        "circle-stroke-width": 1.2,
        "circle-stroke-color": "#020617",
        "circle-opacity": 0.85
      }
    }, m.getLayer("GeoVivé-layer") ? "GeoVivé-layer" : undefined);
    m.on("click", dsSource(id), (e) => showDatasetPopup(id, e));
    m.on("mouseenter", dsSource(id), () => { m.getCanvas().style.cursor = "pointer"; });
    m.on("mouseleave", dsSource(id), () => { m.getCanvas().style.cursor = ""; });
  }
  m.setLayoutProperty(dsSource(id), "visibility", hidden ? "none" : "visible");
}

function removeDataset(id) {
  const m = map();
  if (m.getLayer(dsSource(id))) m.removeLayer(dsSource(id));
  if (m.getSource(dsSource(id))) m.removeSource(dsSource(id));
}

function showDatasetPopup(id, e) {
  const f = e.features?.[0];
  if (!f) return;
  const p = f.properties || {};
  const meta = window.GeoVive.datasets.find(d => d.datasetId === id);
  new mapboxgl.Popup({ closeOnMove: true })
    .setLngLat(f.geometry.coordinates)
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
  if (!others.length) { box.innerHTML = ""; return; }
  box.innerHTML = `<div class="layer-group-title">More datasets</div>`;
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

function renderOverlays() {
  const box = $("layers-overlays");
  if (!box) return;
  box.innerHTML = "";
  const groups = [...new Set(CATALOG.map(e => e.group))];
  groups.forEach(g => {
    const title = document.createElement("div");
    title.className = "layer-group-title";
    title.textContent = g;
    box.appendChild(title);
    CATALOG.filter(e => e.group === g).forEach(entry => {
      const cfg = state.overlays[entry.id] || {};
      const on = !!cfg.on;
      const opacity = cfg.opacity ?? entry.opacity;
      const row = document.createElement("div");
      row.className = "layer-row";
      row.innerHTML = `
        <label class="layer-toggle"><input type="checkbox" ${on ? "checked" : ""} /> ${esc(entry.name)}</label>
        <div class="layer-meta">${esc(entry.description)}
          <a href="${esc(entry.source)}" target="_blank" rel="noopener">Source</a> · ${esc(entry.license)}</div>
        <div class="layer-opacity" ${on ? "" : "hidden"}>
          Opacity <input type="range" min="0.1" max="1" step="0.05" value="${opacity}" aria-label="${esc(entry.name)} opacity" />
        </div>`;
      const [toggle, slider] = row.querySelectorAll("input");
      toggle.addEventListener("change", () => {
        setOverlay(entry, toggle.checked);
        row.querySelector(".layer-opacity").hidden = !toggle.checked;
      });
      slider.addEventListener("input", () => setOverlayOpacity(entry, Number(slider.value)));
      box.appendChild(row);
    });
  });
}

// Re-create everything after a style switch (setStyle drops custom layers).
function reapplyAll() {
  CATALOG.forEach(e => { if (state.overlays[e.id]?.on) addOverlay(e); });
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
