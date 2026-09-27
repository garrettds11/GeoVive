// editor.js — "My datasets" and pin editing for signed-in users (Phase 1).
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
  await window.GeoVive.applyDataset(window.GeoVive.currentDataset);
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

// ------------------------------------------------------------ UI: My datasets panel

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
    btn.textContent = on ? "Click the map to place a pin… (Esc to cancel)" : "📍 Add pin";
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
    setStatus(`Created "${ds.name}". Click 📍 Add pin to start.`);
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

// Pin types: the dataset's own (set by a connected app), else the defaults.
function categoriesFor(ds) {
  const types = ds?.featureTypes;
  return Array.isArray(types) && types.length
    ? types.map(t => ({ value: t.key, label: t.label, color: t.color }))
    : PIN_CATEGORIES;
}

function pinFormHtml(props = {}) {
  const cat = props.category || "location";
  return `
    <form class="pin-form">
      <label>Name<span class="field-row"><input name="name" required maxlength="120" value="${esc(props.name)}"><button type="button" class="emoji-btn" data-emoji-for="name" title="Insert emoji" aria-label="Insert emoji">😀</button></span></label>
      <label>Type
        <select name="category">
          ${categoriesFor(currentDataset()).map(c => `<option value="${c.value}" ${c.value === cat ? "selected" : ""}>${c.label}</option>`).join("")}
        </select>
      </label>
      <label>Notes <span class="hint">(Markdown: **bold**, *italic*, - lists, links)</span><span class="field-row"><textarea name="description" rows="4" maxlength="2000">${esc(props.description)}</textarea><button type="button" class="emoji-btn" data-emoji-for="description" title="Insert emoji" aria-label="Insert emoji">😀</button></span></label>
      <div class="emoji-pop" hidden></div>
      <div class="pin-form-actions">
        ${props.id ? `<button type="button" class="btn danger" data-action="delete">Delete</button>` : ""}
        <button type="button" class="btn" data-action="cancel">Cancel</button>
        <button type="submit" class="btn primary">Save</button>
      </div>
      <p class="pin-form-error" hidden></p>
    </form>`;
}

// ------------------------------------------------------------ emoji picker
// A small picker for desktop (phones have emoji keyboards). Also: Win + . or Ctrl + Cmd + Space.
const EMOJI = [
  ["Places", "🏠 home house|🏡 house garden|🏕️ camp camping tent|⛺ tent camp|🏔️ mountain snow|⛰️ mountain|🌲 tree forest pine|🌳 tree|🌊 water wave|🏞️ park|🏖️ beach|🏜️ desert|🌋 volcano|🏢 office building|🏫 school|🏥 hospital|🏛️ government|⛪ church|🏪 store shop|🏨 hotel|🏭 factory|🌉 bridge|🗼 tower|⛽ fuel gas|🅿️ parking|🚏 bus stop|⚓ anchor harbor port|🛖 hut cabin|🗻 mount fuji"],
  ["Map", "📍 pin location|📌 pushpin|🗺️ map|🧭 compass|🚩 flag|🏁 finish flag|⭐ star|❗ important|❓ question|⚠️ warning caution|⛔ no entry|🚫 prohibited|✅ done check|❌ cross no|🔴 red|🟠 orange|🟡 yellow|🟢 green|🔵 blue|🟣 purple|⚫ black|⚪ white|🔺 up triangle|🔻 down triangle|➡️ right arrow|⬆️ up arrow|🎯 target|🔒 locked|🔑 key access|📷 camera photo"],
  ["Outdoors", "🦌 deer|🐻 bear|🐺 wolf|🦃 turkey|🦆 duck|🐟 fish|🦅 eagle|🐗 boar hog|🐾 tracks paws|🏹 bow arrow hunt|🎣 fishing|🥾 boot hike|🚶 walk|🚴 bike|🛶 canoe|🚤 boat|🔥 fire|💧 water drop|☀️ sun|🌧️ rain|❄️ snow|🌙 moon night|🌿 plant|🍂 leaves|🍄 mushroom|🌾 field|🪨 rock|🌵 cactus"],
  ["Transport", "🚗 car|🛻 truck pickup|🚙 suv|🚌 bus|🚆 train|✈️ plane airport|🚁 helicopter|🚀 rocket|🛣️ highway road|🛤️ railway|🚦 traffic light|🚧 construction|🏍️ motorcycle|🚲 bicycle|🛴 scooter|🚢 ship"],
  ["People & events", "👤 person|👥 people group|🧑‍🤝‍🧑 meet|🎉 party event|📅 calendar date|⏰ alarm time|🎓 graduation|💼 work|🛒 shopping|🍽️ food restaurant|☕ coffee|🍺 beer bar|🎵 music|🏆 trophy|⚽ soccer|🏈 football|⚾ baseball|🏀 basketball|❤️ heart love|👍 thumbs up|📞 phone call|✉️ mail|💡 idea|📝 note|🆘 sos help|🚑 ambulance|🚒 fire engine|🚓 police"]
].map(([cat, list]) => [cat, list.split("|").map(x => { const i = x.indexOf(" "); return { ch: x.slice(0, i), words: x.slice(i + 1) }; })]);

function wireEmojiPicker(form) {
  const pop = form.querySelector(".emoji-pop");
  let target = null;
  const render = (q = "") => {
    const ql = q.trim().toLowerCase();
    const cats = EMOJI.map(([cat, items]) => [cat, items.filter(e => !ql || e.words.includes(ql) || cat.toLowerCase().includes(ql))]).filter(([, i]) => i.length);
    pop.querySelector(".emoji-list").innerHTML = cats.map(([cat, items]) =>
      `<div class="emoji-cat">${cat}</div><div class="emoji-grid">${items.map(e => `<button type="button" title="${e.words}" data-ch="${e.ch}">${e.ch}</button>`).join("")}</div>`).join("") || `<p class="hint">No match</p>`;
  };
  pop.innerHTML = `<input type="search" placeholder="Search emoji (e.g. deer, camp, warning)" aria-label="Search emoji"><div class="emoji-list"></div>`;
  const search = pop.querySelector("input");
  search.addEventListener("input", () => render(search.value));
  form.querySelectorAll(".emoji-btn").forEach(btn => btn.addEventListener("click", () => {
    const same = !pop.hidden && target === btn.dataset.emojiFor;
    target = btn.dataset.emojiFor;
    pop.hidden = same;
    if (!pop.hidden) { search.value = ""; render(); search.focus(); }
  }));
  pop.addEventListener("click", (e) => {
    const ch = e.target.closest("button[data-ch]")?.dataset.ch;
    if (!ch || !target) return;
    const el = form.elements[target];
    const start = el.selectionStart ?? el.value.length, end = el.selectionEnd ?? el.value.length;
    if (el.value.length + ch.length > (el.maxLength > 0 ? el.maxLength : 1e9)) return;
    el.value = el.value.slice(0, start) + ch + el.value.slice(end);
    el.focus();
    el.setSelectionRange(start + ch.length, start + ch.length);
  });
  pop.addEventListener("keydown", (e) => { if (e.key === "Escape") { e.stopPropagation(); pop.hidden = true; form.elements[target]?.focus(); } });
}

function openPinForm(lngLat, feature) {
  closePopup();
  const props = feature ? { ...feature.properties } : {};
  const popup = new datasetboxgl.Popup({ closeOnClick: false, maxWidth: "300px" })
    .setLngLat(lngLat)
    .setHTML(pinFormHtml(props))
    .addTo(window.GeoVive.map);
  state.popup = popup;

  const form = popup.getElement().querySelector(".pin-form");
  wireEmojiPicker(form);
  const errEl = form.querySelector(".pin-form-error");
  if (!feature) form.querySelector("input[name=name]").focus();

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
        color: categoriesFor(currentDataset()).find(c => c.value === fd.get("category"))?.color,
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
// Existing pins open as a read-only card (pin-view.js); editing starts from its pencil.
function onFeatureClick(feature, e) {
  return !!state.addMode && canEditCurrent();
}

function canEditPin(props) {
  return canEditCurrent() && (!props?.datasetId || props.datasetId === currentDatasetId());
}

function editPin(feature) {
  const [lng, lat] = feature.geometry.coordinates;
  openPinForm({ lng, lat }, feature);
}

// Add a pin at the device's current location (asks the browser for permission).
// The position is only used to place the pin form; it's saved only if the user saves the pin.
function pinMyLocation() {
  const btn = $("pin-here-btn");
  if (!navigator.geolocation) { setStatus("This browser can't share your location."); return; }
  if (btn) { btn.disabled = true; btn.textContent = "Finding you…"; }
  navigator.geolocation.getCurrentPosition(pos => {
    if (btn) { btn.disabled = false; btn.textContent = "📍 Pin my location"; }
    const lngLat = { lng: pos.coords.longitude, lat: pos.coords.latitude };
    const map = window.GeoVive.map;
    map.flyTo({ center: [lngLat.lng, lngLat.lat], zoom: Math.max(map.getZoom(), 15) });
    setAddMode(false);
    openPinForm(lngLat, null);
    const acc = Math.round(pos.coords.accuracy || 0);
    if (acc) setStatus(`Location found (within about ${acc} m). Adjust the name and save the pin.`);
  }, err => {
    if (btn) { btn.disabled = false; btn.textContent = "📍 Pin my location"; }
    setStatus(err.code === err.PERMISSION_DENIED ? "Location sharing is off for this site. Allow it in your browser settings to pin your location."
      : "Couldn't get your location. Try again, or place the pin by clicking the map.");
  }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 30000 });
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
  $("pin-here-btn")?.addEventListener("click", pinMyLocation);
  $("details-map-btn")?.addEventListener("click", toggleDetails);
  $("map-details")?.addEventListener("submit", saveDetails);
  $("map-details")?.querySelector("[data-cancel]")?.addEventListener("click", () => { $("map-details").hidden = true; });
  $("delete-map-btn")?.addEventListener("click", deleteCurrentMap);
  $("dataset-select")?.addEventListener("change", () => { closePopup(); setTimeout(updateEditBar, 0); });
  window.addEventListener("geovive:dataset-applied", updateEditBar);
  window.addEventListener("geovive:datasets-changed", refreshDatasets);

  updateEditBar();
}

// ------------------------------------------------------------ map details (name, description, tags, visibility)

function toggleDetails() {
  const form = $("map-details"), ds = currentDataset();
  if (!form || !ds) return;
  if (!form.hidden) { form.hidden = true; return; }
  form.name.value = ds.name || "";
  form.description.value = ds.description || "";
  form.tags.value = (ds.tags || []).join(", ");
  form.public.checked = ds.visibility === "public";
  form.hidden = false;
  form.name.focus();
}

async function saveDetails(e) {
  e.preventDefault();
  const form = e.currentTarget, ds = currentDataset();
  if (!ds) return;
  try {
    setStatus("Saving details…");
    await api("PATCH", `/v1/datasets/${encodeURIComponent(ds.datasetId)}`, {
      name: form.name.value.trim(), description: form.description.value.trim(),
      tags: form.tags.value.split(",").map(t => t.trim()).filter(Boolean),
      visibility: form.public.checked ? "public" : "private"
    });
    form.hidden = true;
    await refreshDatasets();
    updateEditBar();
    setStatus("Details saved.");
  } catch (err) { setStatus(err.message, true); }
}

// ------------------------------------------------------------ save a pin to my map
// From any pin card: pick one of your datasets (or name a new one) and a copy is added
// there, with a note of where it came from.

const LAST_TARGET_KEY = "geovive:saveTarget";

function saveTo(root, props, feature) {
  const panel = root.querySelector(".pin-save-panel");
  const actions = root.querySelector(".pin-actions");
  if (!panel) return;
  if (!state.user) {
    panel.innerHTML = `<p class="pin-save-note">Sign in to save pins to your own datasets.</p>
      <div class="pin-save-row"><button type="button" class="btn primary" data-s="signin">Sign in</button><button type="button" class="btn" data-s="cancel">Cancel</button></div>`;
  } else {
    const mine = state.datasets.filter(isMine).filter(d => d.datasetId !== props.datasetId);
    let last = null; try { last = localStorage.getItem(LAST_TARGET_KEY); } catch { /* ignore */ }
    const selected = mine.some(d => d.datasetId === last) ? last : (mine[0]?.datasetId || "__new");
    panel.innerHTML = `
      <label class="pin-save-label">Save a copy to
        <select data-s="target">
          ${mine.map(d => `<option value="${esc(d.datasetId)}" ${d.datasetId === selected ? "selected" : ""}>${esc(d.name)} (${d.featureCount || 0})</option>`).join("")}
          <option value="__new" ${selected === "__new" ? "selected" : ""}>＋ New dataset…</option>
        </select>
      </label>
      <input type="text" data-s="newname" maxlength="80" placeholder="New dataset name" value="Saved places" ${selected === "__new" ? "" : "hidden"}>
      <div class="pin-save-row"><button type="button" class="btn primary" data-s="go">Save</button><button type="button" class="btn" data-s="cancel">Cancel</button></div>
      <p class="pin-save-note" data-s="msg" role="status"></p>`;
    const sel = panel.querySelector("[data-s=target]"), nameEl = panel.querySelector("[data-s=newname]");
    sel.addEventListener("change", () => { nameEl.hidden = sel.value !== "__new"; if (!nameEl.hidden) nameEl.focus(); });
    panel.querySelector("[data-s=go]").addEventListener("click", async (ev) => {
      const btn = ev.currentTarget, msg = panel.querySelector("[data-s=msg]");
      btn.disabled = true; msg.textContent = "Saving…";
      try {
        let target = sel.value, targetName;
        if (target === "__new") {
          const name = nameEl.value.trim() || "Saved places";
          const ds = await api("POST", "/v1/datasets", { name, visibility: "private" });
          target = ds.datasetId; targetName = ds.name;
        } else targetName = mine.find(d => d.datasetId === target)?.name;
        await copyFeature(props, feature, target);
        try { localStorage.setItem(LAST_TARGET_KEY, target); } catch { /* ignore */ }
        await refreshDatasets();
        panel.innerHTML = `<p class="pin-save-note ok">Saved to <strong>${esc(targetName)}</strong>.</p>
          <div class="pin-save-row"><button type="button" class="btn" data-s="open">Open that dataset</button><button type="button" class="btn" data-s="cancel">Done</button></div>`;
        panel.querySelector("[data-s=open]").addEventListener("click", () => { closeAllPopups(); selectDataset(target); });
        panel.querySelector("[data-s=cancel]").addEventListener("click", () => { panel.hidden = true; actions.hidden = false; });
      } catch (e) { msg.textContent = e.message; btn.disabled = false; }
    });
  }
  panel.querySelector("[data-s=signin]")?.addEventListener("click", () => document.getElementById("signIn")?.click());
  panel.querySelector("[data-s=cancel]")?.addEventListener("click", () => { panel.hidden = true; actions.hidden = false; });
  actions.hidden = true;
  panel.hidden = false;
}

function closeAllPopups() { document.querySelectorAll(".mapboxgl-popup").forEach(p => p.remove()); }

async function copyFeature(props, feature, targetId) {
  let geometry = feature.geometry;
  // Shapes drawn on the map can be simplified or cut at tile edges: copy the stored one
  if (geometry?.type !== "Point" && props.datasetId && props.id) {
    const full = await api("GET", `/v1/datasets/${encodeURIComponent(props.datasetId)}/features/${encodeURIComponent(props.id)}`);
    geometry = full.geometry;
  }
  const source = state.datasets.find(d => d.datasetId === props.datasetId);
  const copy = {};
  for (const k of ["name", "category", "color", "description"]) if (props[k] !== undefined && props[k] !== null && props[k] !== "") copy[k] = props[k];
  copy.name ||= "Saved place";
  copy.savedFrom = { datasetId: props.datasetId, datasetName: source?.name || props.datasetId, featureId: props.id, savedAt: new Date().toISOString() };
  return api("POST", `/v1/datasets/${encodeURIComponent(targetId)}/features`, { type: "Feature", geometry, properties: copy });
}

window.GeoViveEditor = { onFeatureClick, canEdit: canEditPin, edit: editPin, saveTo };
init().catch(e => console.error("Editor init failed", e));
