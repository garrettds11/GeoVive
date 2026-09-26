// app-layers.js — show a connected app's layers while the user is working with that app.
//
// GeoVivé keeps no subject-matter layers of its own. A connected app publishes a
// layer list (GET /v1/apps/{appId}/layers). Its layers appear in the Layers panel,
// under the app's name, when:
//   - the user arrived through the app's "Open in GeoVivé" link (open.js sends
//     "geovive:app-context" with the layers to turn on and an optional focus), or
//   - the map being viewed was created by that app (dataset.origin.appId).
// They disappear when the user moves on to something unrelated to the app.

import { focusFeature } from "./vector-overlays.js";

let contextApp = null;          // from an open link: { appId, layers: [ids], focus }
let shownApp = null;            // appId whose layers are listed now
const lists = new Map();        // appId -> Promise<{ appName, layers }>

function currentDatasetMeta() {
  const key = window.GeoVive.currentDataset;
  const id = key && key.startsWith("api:") ? key.slice(4) : null;
  return window.GeoVive.datasets.find(d => d.datasetId === id);
}

function fetchList(appId) {
  if (!lists.has(appId)) {
    const p = fetch(`${window.GeoVive.apiBase}/v1/apps/${encodeURIComponent(appId)}/layers`)
      .then(async r => { const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.message || `HTTP ${r.status}`); return j; });
    p.catch(() => lists.delete(appId));
    lists.set(appId, p);
  }
  return lists.get(appId);
}

// Layer list entry -> Layers panel entry
function toEntry(appId, appName, l) {
  const entry = {
    id: `${appId}:${l.id}`, appId, layerId: l.id, type: "vector", app: appName,
    group: l.group ? `${appName} · ${l.group}` : appName,
    name: l.name, color: l.color, description: l.description || "",
    publisher: l.attribution, attribution: l.attribution, license: l.license || "", source: null
  };
  if (l.delivery === "direct" && l.source) entry.direct = { source: l.source, label: l.label, fields: l.fields, tolerance: l.tolerance };
  return entry;
}

async function update() {
  const appId = contextApp?.appId || currentDatasetMeta()?.origin?.appId || null;
  if (appId === shownApp) return;
  shownApp = appId;
  if (!appId) { window.dispatchEvent(new CustomEvent("geovive:app-layers", { detail: { appId: null, entries: [] } })); return; }
  try {
    const list = await fetchList(appId);
    if (shownApp !== appId) return;
    const entries = list.layers.map(l => toEntry(appId, list.appName, l));
    const turnOn = (contextApp?.appId === appId ? contextApp.layers : []).map(id => `${appId}:${id}`);
    window.dispatchEvent(new CustomEvent("geovive:app-layers", { detail: { appId, appName: list.appName, entries, turnOn } }));
    const focus = contextApp?.appId === appId && contextApp.focus;
    if (focus) {
      const [layerId, ...rest] = focus.split(":");
      const entry = entries.find(e => e.layerId === layerId);
      if (entry && rest.length) focusFeature(window.GeoVive.map, entry, rest.join(":")).catch(console.error);
      contextApp.focus = null;   // only once
    }
  } catch (e) {
    console.error("App layers unavailable", e);
    window.dispatchEvent(new CustomEvent("geovive:app-layers", { detail: { appId, entries: [], error: e.message } }));
  }
}

async function init() {
  await window.GeoVive.ready;
  window.addEventListener("geovive:app-context", (e) => { contextApp = e.detail?.appId ? { ...e.detail } : null; shownApp = undefined; update(); });
  window.addEventListener("geovive:dataset-applied", () => { update(); });
  window.addEventListener("geovive:datasets-listed", () => { update(); });
  update();
}

init().catch(e => console.error("App layers init failed", e));
