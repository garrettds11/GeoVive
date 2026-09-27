// My data: every pin you own, across your datasets. Filter, review public exposure,
// edit, create, delete, and bulk delete / move / copy (POST /features/batch).
import { UserManager, WebStorageStateStore } from "oidc-client-ts";

const CONFIG = window.GEOVIVE_CONFIG || {};
const API = CONFIG.API_BASE;
const root = document.getElementById("md-root");
const users = new UserManager({
  authority: CONFIG.COGNITO_AUTHORITY, client_id: CONFIG.COGNITO_CLIENT_ID,
  redirect_uri: `${location.origin}/`, response_type: "code", scope: "openid email profile",
  userStore: new WebStorageStateStore({ store: window.localStorage })
});
const uni = window.GeoVivePin?.uni || (v => v);
const esc = v => String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const PAGE = 50;
const TYPES = ["location", "event", "alert"];   // the data model's only categories

const S = { user: null, maps: [], pins: [], apps: [], appEdit: null, sel: new Set(), editing: null, page: 0, sort: ["updatedAt", -1],
  f: { q: "", map: "", vis: "", type: "" } };

async function token() { const u = await users.getUser(); return u && !u.expired ? u.access_token : null; }
async function api(method, path, body) {
  const t = await token();
  if (!t) throw Object.assign(new Error("Please sign in again"), { status: 401 });
  const res = await fetch(`${API}${path}`, { method, headers: { Authorization: `Bearer ${t}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.message || `Request failed (${res.status})`), { status: res.status });
  return data;
}

// ------------------------------------------------------------------ load

async function load() {
  const { datasets } = await api("GET", "/v1/datasets?scope=mine");
  S.maps = datasets.filter(d => d.ownerId === S.user.profile.sub).sort((a, b) => a.name.localeCompare(b.name));
  const all = await Promise.all(S.maps.map(async m => {
    const out = []; let next = "";
    do {
      const fc = await api("GET", `/v1/datasets/${encodeURIComponent(m.datasetId)}/features?limit=1000${next ? `&nextToken=${encodeURIComponent(next)}` : ""}`);
      out.push(...fc.features); next = fc.nextToken || "";
    } while (next);
    return out.map(f => ({ f, map: m }));
  }));
  S.pins = all.flat();
  try { S.apps = (await api("GET", "/v1/connections")).connections; } catch { S.apps = []; }
  S.sel = new Set([...S.sel].filter(k => S.pins.some(p => key(p) === k)));
}

const key = p => `${p.map.datasetId}|${p.f.properties.id}`;
const coords = f => {
  const g = f.geometry;
  if (g?.type === "Point") return g.coordinates;
  const b = f.bbox; return b ? [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2] : null;
};

// ------------------------------------------------------------------ render

function filtered() {
  const q = S.f.q.trim().toLowerCase();
  let list = S.pins.filter(p => {
    const pr = p.f.properties;
    if (S.f.map && p.map.datasetId !== S.f.map) return false;
    if (S.f.vis && p.map.visibility !== S.f.vis) return false;
    if (S.f.type && (pr.category || "location") !== S.f.type) return false;
    if (q && !`${uni(pr.name)} ${uni(pr.description)} ${p.map.name}`.toLowerCase().includes(q)) return false;
    return true;
  });
  const [k, dir] = S.sort;
  const val = p => k === "name" ? uni(p.f.properties.name).toLowerCase() : k === "map" ? p.map.name.toLowerCase()
    : k === "type" ? (p.f.properties.category || "") : (p.f.properties.updatedAt || p.f.properties.createdAt || "");
  return list.sort((a, b) => (val(a) < val(b) ? -1 : val(a) > val(b) ? 1 : 0) * dir);
}

function render() {
  const pubMaps = S.maps.filter(m => m.visibility === "public");
  const pubPins = S.pins.filter(p => p.map.visibility === "public");
  const list = filtered();
  const pages = Math.max(1, Math.ceil(list.length / PAGE));
  S.page = Math.min(S.page, pages - 1);
  const rows = list.slice(S.page * PAGE, S.page * PAGE + PAGE);
  const allOnPage = rows.length && rows.every(p => S.sel.has(key(p)));
  const types = [...new Set([...TYPES, ...S.pins.map(p => p.f.properties.category).filter(Boolean)])];
  root.innerHTML = `
    <div class="md-cards">
      <div class="md-card"><b>${S.maps.length}</b><span>datasets</span></div>
      <div class="md-card"><b>${S.pins.length}</b><span>pins in total</span></div>
      <div class="md-card ${pubMaps.length ? "warn" : ""}"><b>${pubMaps.length}</b><span>public datasets</span></div>
      <div class="md-card ${pubPins.length ? "warn" : ""}"><b>${pubPins.length}</b><span>pins anyone can see</span>
        ${pubPins.length ? `<div><button class="btn2" data-a="review-public">Review them</button></div>` : ""}</div>
    </div>
    ${pubPins.length ? `<div class="md-alert"><span aria-hidden="true">⚠️</span><p><strong>${pubPins.length} pin${pubPins.length > 1 ? "s are" : " is"} public</strong> because ${pubMaps.length > 1 ? "their datasets are" : "its dataset is"} public. Anyone can see ${pubPins.length > 1 ? "them" : "it"}, signed in or not. Check nothing personal is exposed: make the dataset private, or move the pins to a private dataset.</p></div>` : ""}

    <section class="md-section">
      <h2>Your datasets</h2>
      ${S.maps.length ? `<div class="md-maps">${S.maps.map(m => `
        <div class="md-map">
          <div><div class="n">${esc(m.name)}</div><div class="s">${m.featureCount || 0} pins${m.tags?.length ? ` · ${m.tags.map(t => "#" + esc(t)).join(" ")}` : ""}</div></div>
          <span class="vis ${m.visibility}">${m.visibility === "public" ? "Public" : "Private"}</span>
          <label class="switch" title="Anyone can view a public dataset"><input type="checkbox" data-a="vis" data-id="${esc(m.datasetId)}" ${m.visibility === "public" ? "checked" : ""}> Public</label>
          <span><button class="icon-btn" data-a="only" data-id="${esc(m.datasetId)}">Show pins</button><a class="icon-btn" href="/?dataset=${encodeURIComponent(m.datasetId)}">Open ↗</a></span>
        </div>`).join("")}</div>` : `<p class="muted">No datasets yet. <a href="/">Create one on the map.</a></p>`}
    </section>

    <section class="md-section" id="connected-apps">
      <h2>Connected apps</h2>
      ${S.apps.length ? `<div class="md-maps">${S.apps.map(appHtml).join("")}</div>` : `<p class="muted">No apps are linked to your account. When an app asks to link, you'll see what it wants and can say no; linked apps show up here, where you can remove them.</p>`}
    </section>

    <section class="md-section">
      <h2>Your pins <button class="btn2 primary" data-a="new">＋ New pin</button></h2>
      <form class="md-form" id="md-new" hidden>
        <label>Map<select name="map" required>${S.maps.map(m => `<option value="${esc(m.datasetId)}">${esc(m.name)}${m.visibility === "public" ? " (public)" : ""}</option>`).join("")}</select></label>
        <label>Name<input name="name" required maxlength="120"></label>
        <label>Latitude<input name="lat" required inputmode="decimal" placeholder="39.7392"></label>
        <label>Longitude<input name="lng" required inputmode="decimal" placeholder="-104.9903"></label>
        <label>Type<select name="category">${TYPES.map(t => `<option value="${esc(t)}">${esc(t)}</option>`).join("")}</select></label>
        <label class="wide">Notes (Markdown)<textarea name="description" rows="3" maxlength="2000"></textarea></label>
        <div class="wide" style="display:flex;gap:0.5rem;justify-content:flex-end"><button type="button" class="btn2" data-a="new-cancel">Cancel</button><button class="btn2 primary">Create pin</button></div>
      </form>
      <div class="md-toolbar">
        <input type="search" id="md-q" placeholder="Search names, notes and datasets" value="${esc(S.f.q)}">
        <select id="md-map"><option value="">All datasets</option>${S.maps.map(m => `<option value="${esc(m.datasetId)}" ${S.f.map === m.datasetId ? "selected" : ""}>${esc(m.name)}</option>`).join("")}</select>
        <select id="md-vis"><option value="">Public and private</option><option value="public" ${S.f.vis === "public" ? "selected" : ""}>In public datasets</option><option value="private" ${S.f.vis === "private" ? "selected" : ""}>In private datasets</option></select>
        <select id="md-type"><option value="">All types</option>${types.map(t => `<option ${S.f.type === t ? "selected" : ""}>${esc(t)}</option>`).join("")}</select>
      </div>
      <div class="md-bulk" ${S.sel.size ? "" : "hidden"}>
        <strong>${S.sel.size} selected</strong>
        <select id="md-target"><option value="">Move or copy to…</option>${S.maps.map(m => `<option value="${esc(m.datasetId)}">${esc(m.name)}${m.visibility === "public" ? " (public)" : " (private)"}</option>`).join("")}</select>
        <button class="btn2" data-a="bulk-move">Move</button><button class="btn2" data-a="bulk-copy">Copy</button>
        <button class="btn2 danger" data-a="bulk-delete">Delete ${S.sel.size}</button>
        <button class="icon-btn" data-a="clear">Clear selection</button>
      </div>
      <p class="md-msg" id="md-msg" role="status"></p>
      <div class="md-table-wrap"><table class="md-table">
        <thead><tr>
          <th><input type="checkbox" data-a="all" ${allOnPage ? "checked" : ""} aria-label="Select all on this page"></th>
          <th data-sort="name">Pin${arrow("name")}</th><th data-sort="map">Dataset${arrow("map")}</th><th data-sort="type" class="hide-sm">Type${arrow("type")}</th>
          <th class="hide-sm">Location</th><th data-sort="updatedAt" class="hide-sm">Updated${arrow("updatedAt")}</th><th></th>
        </tr></thead>
        <tbody>${rows.length ? rows.map(rowHtml).join("") : `<tr><td colspan="7" class="md-empty">${S.pins.length ? "No pins match these filters." : "No pins yet."}</td></tr>`}</tbody>
      </table></div>
      <div class="md-pager">${list.length} pin${list.length === 1 ? "" : "s"}
        ${pages > 1 ? `<button class="icon-btn" data-a="prev" ${S.page ? "" : "disabled"}>‹ Prev</button> Page ${S.page + 1} of ${pages} <button class="icon-btn" data-a="next" ${S.page < pages - 1 ? "" : "disabled"}>Next ›</button>` : ""}</div>
    </section>`;
  bind();
}

const SCOPE_SHORT = { profile: "Your name", "maps:read": "Read its datasets", "maps:write": "Edit its datasets" };
function appHtml(c) {
  const shared = S.maps.filter(m => c.sharedDatasets.includes(m.datasetId));
  const made = S.maps.filter(m => m.origin?.appId === c.appId);
  const used = c.lastUsedAt ? `last used ${new Date(c.lastUsedAt).toLocaleDateString()}` : "not used yet";
  return `<div class="md-app" data-app="${esc(c.appId)}">
    <div class="md-map">
      <div><div class="n">${esc(c.appName)} <span class="s">${esc(c.appDomain || "")}</span></div>
        <div class="s">${c.scopes.map(x => SCOPE_SHORT[x] || x).join(" · ")} · linked ${new Date(c.createdAt).toLocaleDateString()} · ${used}</div>
        <div class="s">${made.length} dataset${made.length === 1 ? "" : "s"} it created${shared.length ? ` · shared with it: ${shared.map(m => esc(m.name)).join(", ")}` : ""}</div></div>
      <span></span><span></span>
      <span><button class="icon-btn" data-a="app-share">Shared datasets</button><button class="icon-btn del" data-a="app-remove">Remove</button></span>
    </div>
    ${S.appEdit === c.appId ? `<div class="md-appshare">
      <p class="s">Maps ${esc(c.appName)} can read (it can't change them). Maps it created are always available to it.</p>
      ${S.maps.filter(m => m.origin?.appId !== c.appId).map(m => `<label><input type="checkbox" value="${esc(m.datasetId)}" ${c.sharedDatasets.includes(m.datasetId) ? "checked" : ""}> ${esc(m.name)} <span class="vis ${m.visibility}">${m.visibility === "public" ? "Public" : "Private"}</span></label>`).join("") || `<p class="s">You have no other datasets.</p>`}
      <div class="row"><button class="btn2" data-a="app-share-cancel">Cancel</button><button class="btn2 primary" data-a="app-share-save">Save</button></div>
    </div>` : ""}
  </div>`;
}

function arrow(k) { return S.sort[0] === k ? (S.sort[1] > 0 ? " ▲" : " ▼") : ""; }

function rowHtml(p) {
  const pr = p.f.properties, k = key(p), c = coords(p.f);
  if (S.editing === k) {
    const isPoint = p.f.geometry?.type === "Point";
    return `<tr class="md-edit" data-k="${esc(k)}"><td></td><td colspan="6">
      <div class="grid">
        <input name="name" value="${esc(pr.name)}" maxlength="120" aria-label="Name">
        <input name="category" value="${esc(pr.category || "location")}" list="md-types" aria-label="Type">
        <input name="lat" value="${isPoint ? c[1] : ""}" ${isPoint ? "" : "disabled title='Shapes keep their geometry'"} aria-label="Latitude" placeholder="lat">
        <input name="lng" value="${isPoint ? c[0] : ""}" ${isPoint ? "" : "disabled"} aria-label="Longitude" placeholder="lng">
      </div>
      <textarea name="description" rows="3" maxlength="2000" aria-label="Notes">${esc(pr.description || "")}</textarea>
      <div class="row"><button class="btn2" data-a="cancel-edit">Cancel</button><button class="btn2 primary" data-a="save-edit">Save</button></div>
      <datalist id="md-types">${TYPES.map(t => `<option value="${t}">`).join("")}</datalist>
    </td></tr>`;
  }
  return `<tr class="${S.sel.has(k) ? "sel" : ""} ${p.map.visibility === "public" ? "in-public" : ""}" data-k="${esc(k)}">
    <td><input type="checkbox" data-a="sel" ${S.sel.has(k) ? "checked" : ""} aria-label="Select ${esc(uni(pr.name))}"></td>
    <td><div class="nm">${esc(uni(pr.name || "Untitled"))}</div>${pr.description ? `<div class="nt">${esc(uni(pr.description))}</div>` : ""}</td>
    <td>${esc(p.map.name)}<br><span class="vis ${p.map.visibility}">${p.map.visibility === "public" ? "Public" : "Private"}</span></td>
    <td class="hide-sm">${esc(pr.category || "location")}</td>
    <td class="co hide-sm">${c ? `${(+c[1]).toFixed(5)}, ${(+c[0]).toFixed(5)}` : "—"}${p.f.geometry?.type && p.f.geometry.type !== "Point" ? `<br>${esc(p.f.geometry.type)}` : ""}</td>
    <td class="hide-sm">${pr.updatedAt ? new Date(pr.updatedAt).toLocaleDateString() : ""}</td>
    <td class="acts"><a class="icon-btn" href="/?dataset=${encodeURIComponent(p.map.datasetId)}${c ? `&lng=${c[0]}&lat=${c[1]}` : ""}" title="See on the map">Map ↗</a><button class="icon-btn" data-a="edit">Edit</button><button class="icon-btn del" data-a="del">Delete</button></td>
  </tr>`;
}

function msg(text, kind = "ok") { const el = document.getElementById("md-msg"); if (el) { el.textContent = text; el.className = `md-msg ${kind}`; } }

// ------------------------------------------------------------------ actions

function bind() {
  const on = (sel, ev, fn) => document.querySelectorAll(sel).forEach(el => el.addEventListener(ev, fn));
  const set = (k) => (e) => { S.f[k] = e.target.value; S.page = 0; render(); };
  let qt; document.getElementById("md-q").addEventListener("input", e => { clearTimeout(qt); qt = setTimeout(() => { S.f.q = e.target.value; S.page = 0; render(); const q = document.getElementById("md-q"); q.focus(); q.setSelectionRange(q.value.length, q.value.length); }, 200); });
  on("#md-map", "change", set("map")); on("#md-vis", "change", set("vis")); on("#md-type", "change", set("type"));
  on("th[data-sort]", "click", e => { const k = e.currentTarget.dataset.sort; S.sort = [k, S.sort[0] === k ? -S.sort[1] : 1]; render(); });
  root.onclick = onClick;
  root.onchange = onChange;
  document.getElementById("md-new")?.addEventListener("submit", createPin);
}

async function onChange(e) {
  const a = e.target.dataset.a;
  if (a === "sel") { const k = e.target.closest("tr").dataset.k; e.target.checked ? S.sel.add(k) : S.sel.delete(k); render(); }
  if (a === "all") { const ks = [...document.querySelectorAll("tbody tr[data-k]")].map(r => r.dataset.k); ks.forEach(k => e.target.checked ? S.sel.add(k) : S.sel.delete(k)); render(); }
  if (a === "vis") {
    const m = S.maps.find(x => x.datasetId === e.target.dataset.id);
    const toPublic = e.target.checked;
    if (toPublic && !confirm(`Make "${m.name}" public?\n\nAnyone will be able to see its ${m.featureCount || 0} pins, signed in or not.`)) { e.target.checked = false; return; }
    try { await api("PATCH", `/v1/datasets/${encodeURIComponent(m.datasetId)}`, { visibility: toPublic ? "public" : "private" }); m.visibility = toPublic ? "public" : "private"; render(); msg(`"${m.name}" is now ${m.visibility}.`); }
    catch (err) { e.target.checked = !toPublic; msg(err.message, "err"); }
  }
}

async function onClick(e) {
  const b = e.target.closest("[data-a]"); if (!b || b.tagName === "INPUT") return;
  const a = b.dataset.a, tr = b.closest("tr"), k = tr?.dataset.k;
  const pin = k && S.pins.find(p => key(p) === k);
  const appEl = b.closest("[data-app]"), app = appEl && S.apps.find(x => x.appId === appEl.dataset.app);
  if (a === "app-share") { S.appEdit = S.appEdit === app.appId ? null : app.appId; render(); document.getElementById("connected-apps").scrollIntoView({ block: "nearest" }); }
  if (a === "app-share-cancel") { S.appEdit = null; render(); }
  if (a === "app-share-save") {
    const ids = [...appEl.querySelectorAll(".md-appshare input:checked")].map(i => i.value);
    try { const g = await api("PATCH", `/v1/connections/${encodeURIComponent(app.appId)}`, { sharedDatasets: ids }); Object.assign(app, g); S.appEdit = null; render(); msg(`Updated what ${app.appName} can see.`); }
    catch (err) { msg(err.message, "err"); }
  }
  if (a === "app-remove") {
    if (!confirm(`Remove ${app.appName}? It loses access to your GeoVivé account right away. Maps it created stay in your account.`)) return;
    try { await api("DELETE", `/v1/connections/${encodeURIComponent(app.appId)}`); S.apps = S.apps.filter(x => x !== app); render(); msg(`${app.appName} is no longer linked.`); }
    catch (err) { msg(err.message, "err"); }
  }
  if (a === "review-public") { S.f.vis = "public"; S.page = 0; render(); document.querySelector(".md-toolbar")?.scrollIntoView({ behavior: "smooth" }); }
  if (a === "only") { S.f.map = b.dataset.id; S.page = 0; render(); document.querySelector(".md-toolbar")?.scrollIntoView({ behavior: "smooth" }); }
  if (a === "new") { const f = document.getElementById("md-new"); f.hidden = !f.hidden; if (!f.hidden) f.name.focus(); }
  if (a === "new-cancel") document.getElementById("md-new").hidden = true;
  if (a === "prev") { S.page--; render(); } if (a === "next") { S.page++; render(); }
  if (a === "clear") { S.sel.clear(); render(); }
  if (a === "edit") { S.editing = k; render(); }
  if (a === "cancel-edit") { S.editing = null; render(); }
  if (a === "save-edit") return saveEdit(tr, pin);
  if (a === "del") {
    if (!confirm(`Delete "${uni(pin.f.properties.name)}"? This can't be undone.`)) return;
    try { await api("DELETE", `/v1/datasets/${encodeURIComponent(pin.map.datasetId)}/features/${encodeURIComponent(pin.f.properties.id)}`); await refresh(`Deleted "${uni(pin.f.properties.name)}".`); }
    catch (err) { msg(err.message, "err"); }
  }
  if (a === "bulk-delete") {
    if (!confirm(`Delete ${S.sel.size} pin${S.sel.size > 1 ? "s" : ""}? This can't be undone.`)) return;
    await bulk("delete");
  }
  if (a === "bulk-move" || a === "bulk-copy") {
    const target = document.getElementById("md-target").value;
    if (!target) { msg("Choose a dataset to move or copy to.", "err"); return; }
    const t = S.maps.find(m => m.datasetId === target);
    if (t.visibility === "public" && !confirm(`"${t.name}" is public. Anyone will be able to see these pins. Continue?`)) return;
    await bulk(a === "bulk-move" ? "move" : "copy", target);
  }
}

// Group the selection by map and send batches of up to 100
async function bulk(action, target) {
  const byMap = new Map();
  for (const k of S.sel) { const [ds, id] = k.split("|"); if (ds === target) continue; (byMap.get(ds) || byMap.set(ds, []).get(ds)).push(id); }
  let done = 0, failed = 0;
  msg("Working…");
  try {
    for (const [ds, ids] of byMap) for (let i = 0; i < ids.length; i += 100) {
      const r = await api("POST", `/v1/datasets/${encodeURIComponent(ds)}/features/batch`, { action, ids: ids.slice(i, i + 100), targetDatasetId: target });
      done += r.done.length; failed += r.failed.length;
    }
  } catch (err) { msg(err.message, "err"); }
  if (action !== "copy") S.sel.clear();
  await refresh(`${{ delete: "Deleted", move: "Moved", copy: "Copied" }[action]} ${done} pin${done === 1 ? "" : "s"}${failed ? `; ${failed} couldn't be processed` : ""}.`, failed ? "err" : "ok");
}

async function saveEdit(tr, pin) {
  const val = n => tr.querySelector(`[name=${n}]`).value.trim();
  const name = val("name");
  if (!name) { msg("A pin needs a name.", "err"); return; }
  let geometry = pin.f.geometry;
  if (geometry?.type === "Point") {
    const lat = Number(val("lat")), lng = Number(val("lng"));
    if (!(lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180)) { msg("Latitude must be −90 to 90 and longitude −180 to 180.", "err"); return; }
    geometry = { type: "Point", coordinates: [lng, lat] };
  } else {
    geometry = (await api("GET", `/v1/datasets/${encodeURIComponent(pin.map.datasetId)}/features/${encodeURIComponent(pin.f.properties.id)}`)).geometry;
  }
  const MODEL = ["name", "category", "description", "eventTime", "status", "severity", "source", "externalId", "icon", "color"];
  const props = Object.fromEntries(MODEL.filter(k => pin.f.properties[k] != null && pin.f.properties[k] !== "").map(k => [k, pin.f.properties[k]]));
  Object.assign(props, { name, category: val("category") || "location", description: val("description") });
  if (!props.description) delete props.description;
  if (props.category !== "location" && !props.eventTime) { msg("Events and alerts need a date and time. Set it on the map with the pin's ✏️ editor.", "err"); return; }
  if (props.category !== "alert") delete props.severity;
  try {
    await api("PUT", `/v1/datasets/${encodeURIComponent(pin.map.datasetId)}/features/${encodeURIComponent(pin.f.properties.id)}`, { type: "Feature", geometry, properties: props });
    S.editing = null;
    await refresh(`Saved "${uni(name)}".`);
  } catch (err) { msg(err.message, "err"); }
}

async function createPin(e) {
  e.preventDefault();
  const f = e.currentTarget, lat = Number(f.lat.value), lng = Number(f.lng.value);
  if (!(lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180)) { msg("Latitude must be −90 to 90 and longitude −180 to 180.", "err"); return; }
  const m = S.maps.find(x => x.datasetId === f.map.value);
  if (m.visibility === "public" && !confirm(`"${m.name}" is public. Anyone will see this pin. Continue?`)) return;
  try {
    await api("POST", `/v1/datasets/${encodeURIComponent(m.datasetId)}/features`, { type: "Feature", geometry: { type: "Point", coordinates: [lng, lat] },
      properties: { name: f.name.value.trim(), category: f.category.value, description: f.description.value.trim() } });
    await refresh(`Created "${f.name.value.trim()}".`);
  } catch (err) { msg(err.message, "err"); }
}

async function refresh(text, kind = "ok") { await load(); render(); msg(text, kind); }

// ------------------------------------------------------------------ start

(async () => {
  try {
    S.user = await users.getUser();
    if (!S.user || S.user.expired) {
      root.innerHTML = `<h2>Sign in to see your data</h2><p class="muted">This page lists every pin in your datasets so you can review, fix and tidy them.</p>
        <p><button class="btn2 primary" id="md-signin">Sign in</button></p>`;
      document.getElementById("md-signin").onclick = () => { sessionStorage.setItem("geovive:after-signin", "/mydata/"); users.signinRedirect({ prompt: "select_account" }); };
      return;
    }
    await load();
    const q = new URLSearchParams(location.search);
    if (q.get("vis")) S.f.vis = q.get("vis");
    render();
    if (location.hash === "#connected-apps") document.getElementById("connected-apps")?.scrollIntoView();
  } catch (e) {
    if (e.status === 401) { await users.removeUser(); location.reload(); return; }
    root.innerHTML = `<p class="md-msg err">${esc(e.message)}</p>`;
  }
})();
