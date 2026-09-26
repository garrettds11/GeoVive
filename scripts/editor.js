// editor.js — "My maps" and pin editing for signed-in users (Phase 1).
// Depends on window.GeoVive (exposed by the inline script in index.html)
// and on the signed-in user from auth.js.

import { getCurrentUser } from "./auth.js";

const PIN_CATEGORIES = [
  { value: "location", label: "Location" },
  { value: "event", label: "Event" },
  { value: "alert", label: "Alert" }
];

const state = {
  user: null,        // oidc-client-ts user (null when signed out)
  datasets: [],      // datasets visible to this user
  addMode: false,
  popup: null
};

// ------------------------------------------------------------ helpers

const $ = (id) => document.getElementById(id);

function esc(v) {
  return String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

async function api(method, path, body) {
  const headers = await window.GeoVive.authHeaders();
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(`${window.GeoVive.apiBase}${path}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body)
  });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || `Request failed (${res.status})`);
  return data;
}

function currentDatasetId() {
  const key = window.GeoVive.currentDataset;
  return key && key.startsWith("api:") ? key.slice(4) : null;
}

function isMine(dataset) {
  return !!(state.user && dataset && dataset.ownerId === state.user.profile?.sub);
}

function currentDataset() {
  const id = currentDatasetId();
  return state.datasets.find(d => d.datasetId === id) || null;
}

function canEditCurrent() {
  return isMine(currentDataset());
}

function setStatus(msg, isError = false) {
  const el = $("editor-status");
  if (!el) return;
  el.textContent = msg || "";
  el.style.color = isError ? "#f87171" : "var(--muted)";
}

function closePopup() {
  if (state.popup) { state.popup.remove(); state.popup = null; }
}

async function reloadCurrent() {
  await window.GeoVive.applyDataset(window.GeoVive.currentDataset, { keepView: true });
}

async function refreshDatasets() {
  state.datasets = await window.GeoVive.refreshDatasetOptions();
  renderMyMaps();
}

async function selectDataset(datasetId) {
  const key = `api:${datasetId}`;
  $("dataset-select").value = key;
  await window.GeoVive.applyDataset(key);
  updateEditBar();
}

// ------------------------------------------------------------ UI: My maps panel

function renderMyMaps() {
  const panel = $("my-maps");
  if (!panel) return;
  panel.hidden = !state.user;
  if (!state.user) return;

  const list = $("my-maps-list");
  const mine = state.datasets.filter(isMine);
  list.innerHTML = mine.length
    ? mine.map(d => `
        <button type="button" class="my-map-item" data-id="${esc(d.datasetId)}">
          <span class="my-map-name">${esc(d.name)}</span>
          <span class="my-map-meta">${d.featureCount || 0} pins · ${esc(d.visibility)}</span>
        </button>`).join("")
    : `<p class="hint">No maps yet. Create one to start pinning places.</p>`;

  list.querySelectorAll(".my-map-item").forEach(btn =>
    btn.addEventListener("click", () => selectDataset(btn.dataset.id)));
  updateEditBar();
}

function updateEditBar() {
  const bar = $("edit-bar");
  if (!bar) return;
  const ds = currentDataset();
  const editable = canEditCurrent();
  bar.hidden = !editable;
  if (!editable) setAddMode(false);
  if (editable) $("edit-bar-title").textContent = ds.name;
  document.querySelectorAll(".my-map-item").forEach(b =>
    b.classList.toggle("active", b.dataset.id === currentDatasetId()));
}

function setAddMode(on) {
  state.addMode = on;
  const btn = $("add-pin-btn");
  if (btn) {
    btn.textContent = on ? "Click the map to place a pin… (Esc to cancel)" : "+ Add pin";
    btn.classList.toggle("active", on);
  }
  const canvas = window.GeoVive?.map?.getCanvas();
  if (canvas) canvas.style.cursor = on ? "crosshair" : "";
}

async function createMap() {
  const nameEl = $("new-map-name");
  const name = nameEl.value.trim();
  if (!name) { nameEl.focus(); return; }
  const visibility = $("new-map-public").checked ? "public" : "private";
  try {
    setStatus("Creating map…");
    const ds = await api("POST", "/v1/datasets", { name, visibility });
    nameEl.value = "";
    await refreshDatasets();
    await selectDataset(ds.datasetId);
    setStatus(`Created "${ds.name}". Click + Add pin to start.`);
  } catch (e) {
    setStatus(e.message, true);
  }
}

async function deleteCurrentMap() {
  const ds = currentDataset();
  if (!ds) return;
  const ok = window.confirm(`Delete the map "${ds.name}" and all ${ds.featureCount || 0} pins? This cannot be undone.`);
  if (!ok) return;
  try {
    await api("DELETE", `/v1/datasets/${encodeURIComponent(ds.datasetId)}`);
    await refreshDatasets();
    const first = state.datasets[0];
    if (first) await selectDataset(first.datasetId);
    setStatus(`Deleted "${ds.name}".`);
  } catch (e) {
    setStatus(e.message, true);
  }
}

// ------------------------------------------------------------ pin form popup

function pinFormHtml(props = {}) {
  const cat = props.category || "location";
  return `
    <form class="pin-form">
      <label>Name<input name="name" required maxlength="120" value="${esc(props.name)}"></label>
      <label>Type
        <select name="category">
          ${PIN_CATEGORIES.map(c => `<option value="${c.value}" ${c.value === cat ? "selected" : ""}>${c.label}</option>`).join("")}
        </select>
      </label>
      <label>Notes<textarea name="description" rows="3" maxlength="2000">${esc(props.description)}</textarea></label>
      <div class="pin-form-actions">
        ${props.id ? `<button type="button" class="btn danger" data-action="delete">Delete</button>` : ""}
        <button type="button" class="btn" data-action="cancel">Cancel</button>
        <button type="submit" class="btn primary">Save</button>
      </div>
      <p class="pin-form-error" hidden></p>
    </form>`;
}

function openPinForm(lngLat, feature) {
  closePopup();
  const props = feature ? { ...feature.properties } : {};
  const popup = new mapboxgl.Popup({ closeOnClick: false, maxWidth: "280px" })
    .setLngLat(lngLat)
    .setHTML(pinFormHtml(props))
    .addTo(window.GeoVive.map);
  state.popup = popup;

  const form = popup.getElement().querySelector(".pin-form");
  const errEl = form.querySelector(".pin-form-error");
  form.querySelector("input[name=name]").focus();

  const fail = (msg) => { errEl.textContent = msg; errEl.hidden = false; };

  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const fd = new FormData(form);
    const body = {
      type: "Feature",
      geometry: feature ? feature.geometry : { type: "Point", coordinates: [lngLat.lng, lngLat.lat] },
      properties: {
        name: fd.get("name").trim(),
        category: fd.get("category"),
        description: fd.get("description").trim()
      }
    };
    const id = encodeURIComponent(currentDatasetId());
    try {
      if (props.id) await api("PUT", `/v1/datasets/${id}/features/${encodeURIComponent(props.id)}`, body);
      else await api("POST", `/v1/datasets/${id}/features`, body);
      closePopup();
      setAddMode(false);
      await reloadCurrent();
      await refreshDatasets();
      setStatus(props.id ? "Pin updated." : "Pin added.");
    } catch (e) {
      fail(e.message);
    }
  });

  form.querySelector("[data-action=cancel]").addEventListener("click", closePopup);
  form.querySelector("[data-action=delete]")?.addEventListener("click", async () => {
    if (!window.confirm(`Delete "${props.name}"?`)) return;
    try {
      await api("DELETE", `/v1/datasets/${encodeURIComponent(currentDatasetId())}/features/${encodeURIComponent(props.id)}`);
      closePopup();
      await reloadCurrent();
      await refreshDatasets();
      setStatus("Pin deleted.");
    } catch (e) {
      fail(e.message);
    }
  });
}

// ------------------------------------------------------------ map hooks

// Called by the inline script before it shows its read-only popup.
// Returns true when the editor handled the click.
function onFeatureClick(feature, e) {
  if (!canEditCurrent() || state.addMode) return state.addMode;
  const [lng, lat] = feature.geometry.coordinates;
  openPinForm({ lng, lat }, feature);
  return true;
}

function wireMap() {
  const map = window.GeoVive.map;
  map.on("click", (e) => {
    if (!state.addMode || !canEditCurrent()) return;
    openPinForm(e.lngLat, null);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { setAddMode(false); closePopup(); }
  });
}

// ------------------------------------------------------------ init

async function init() {
  // Wait for the inline script to expose its API and finish the first load.
  await window.GeoVive.ready;
  await window.GeoViveAuthReady;

  state.user = await getCurrentUser();
  if (state.user?.expired) state.user = null;

  await refreshDatasets();
  wireMap();

  $("create-map-btn")?.addEventListener("click", createMap);
  $("new-map-name")?.addEventListener("keydown", (e) => { if (e.key === "Enter") createMap(); });
  $("add-pin-btn")?.addEventListener("click", () => setAddMode(!state.addMode));
  $("delete-map-btn")?.addEventListener("click", deleteCurrentMap);
  $("dataset-select")?.addEventListener("change", () => { closePopup(); setTimeout(updateEditBar, 0); });
  window.addEventListener("geovive:dataset-applied", updateEditBar);

  updateEditBar();
}

window.GeoViveEditor = { onFeatureClick };
init().catch(e => console.error("Editor init failed", e));
