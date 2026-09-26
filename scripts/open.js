// open.js — "Open in GeoVivé" links (Connected Apps, phase 2).
//
// A connected app sends the user to:
//   https://geovive.link/open?app=<appId>&ref=<itemId>&title=<text>&area=<geojson url>&return=<url>
//                             &layers=<layerId,…>&focus=<layerId>:<label>
//
// With ref: GeoVivé signs the user in if needed, finds or creates their map for
// that item, draws the app's reference area, and shows a banner with a Done
// button that returns to the app with ?geovive_map=<datasetId>.
// Without ref (view link): no sign-in and no map; GeoVivé just shows the app's
// layers (layers=…), optionally zoomed to one feature (focus=…).
// Either way the app's own layers appear under its name (scripts/app-layers.js).

import { getCurrentUser, login } from "./auth.js";

const PENDING_KEY = "geovive:open:pending";   // link waiting for sign-in
const SESSION_KEY = "geovive:open:session";   // active scouting session (survives reloads)

const $ = (id) => document.getElementById(id);

function esc(v) {
  return String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function readJson(storage, key) {
  try { return JSON.parse(storage.getItem(key) || "null"); } catch { return null; }
}
function writeJson(storage, key, value) {
  try { value ? storage.setItem(key, JSON.stringify(value)) : storage.removeItem(key); } catch { /* ignore */ }
}

function originAllowed(url, allowed) {
  try {
    const u = new URL(url);
    return (u.protocol === "https:" || u.protocol === "http:") && allowed.includes(u.origin);
  } catch { return false; }
}

// ------------------------------------------------------------ banner

function showBanner(html) {
  let el = $("open-banner");
  if (!el) {
    el = document.createElement("div");
    el.id = "open-banner";
    el.className = "open-banner";
    el.setAttribute("role", "status");
    document.body.appendChild(el);
  }
  el.innerHTML = html;
  el.hidden = false;
  return el;
}

function hideBanner() {
  const el = $("open-banner");
  if (el) el.hidden = true;
}

function showError(message) {
  const el = showBanner(`
    <span class="open-banner-text">${esc(message)}</span>
    <button type="button" class="btn" data-action="dismiss">Dismiss</button>`);
  el.querySelector("[data-action=dismiss]").addEventListener("click", hideBanner);
}

// ------------------------------------------------------------ reference area

const AREA_SOURCE = "open-reference-area";
let areaData = null;

function drawReferenceArea() {
  const map = window.GeoVive.map;
  if (!areaData || !map.isStyleLoaded()) return;
  if (map.getSource(AREA_SOURCE)) {
    map.getSource(AREA_SOURCE).setData(areaData);
  } else {
    map.addSource(AREA_SOURCE, { type: "geojson", data: areaData });
    const beforeId = map.getLayer("GeoVivé-layer") ? "GeoVivé-layer" : undefined;
    map.addLayer({ id: `${AREA_SOURCE}-fill`, type: "fill", source: AREA_SOURCE,
      paint: { "fill-color": "#facc15", "fill-opacity": 0.08 } }, beforeId);
    map.addLayer({ id: `${AREA_SOURCE}-line`, type: "line", source: AREA_SOURCE,
      paint: { "line-color": "#facc15", "line-width": 2.5, "line-dasharray": [2, 1] } }, beforeId);
  }
}

async function loadReferenceArea(url, { fit }) {
  if (!url) return;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${res.status}`);
    areaData = await res.json();
    drawReferenceArea();
    if (fit) {
      const bounds = new mapboxgl.LngLatBounds();
      const walk = (c) => typeof c[0] === "number" ? bounds.extend(c) : c.forEach(walk);
      const geoms = areaData.type === "FeatureCollection" ? areaData.features.map(f => f.geometry)
        : areaData.type === "Feature" ? [areaData.geometry] : [areaData];
      geoms.forEach(g => g?.coordinates && walk(g.coordinates));
      if (!bounds.isEmpty()) window.GeoVive.map.fitBounds(bounds, { padding: 60 });
    }
  } catch (e) {
    console.warn("Reference area could not be loaded", e);
  }
}

// ------------------------------------------------------------ session

function returnUrlFor(session) {
  const u = new URL(session.returnUrl);
  if (session.datasetId) u.searchParams.set("geovive_map", session.datasetId);
  return u.toString();
}

const splitList = (v) => (v || "").split(",").map(x => x.trim()).filter(Boolean).slice(0, 50);

function announceApp(session) {
  window.dispatchEvent(new CustomEvent("geovive:app-context", {
    detail: session ? { appId: session.appId, layers: session.layers || [], focus: session.focus } : null
  }));
}

function showSessionBanner(session) {
  const el = showBanner(`
    <span class="open-banner-text">
      <strong>${esc(session.title)}</strong>
      <span class="open-banner-app">from ${esc(session.appName)}</span>
    </span>
    <button type="button" class="btn primary" data-action="done">Done — back to ${esc(session.appName)}</button>
    <button type="button" class="link-btn" data-action="close" title="Stay in GeoVivé">Stay here</button>`);
  el.querySelector("[data-action=done]").addEventListener("click", () => {
    writeJson(sessionStorage, SESSION_KEY, null);
    announceApp(null);
    window.location.assign(returnUrlFor(session));
  });
  el.querySelector("[data-action=close]").addEventListener("click", () => {
    writeJson(sessionStorage, SESSION_KEY, null);
    hideBanner();
  });
}

async function startSession(pending) {
  const api = window.GeoVive.apiBase;
  const headers = await window.GeoVive.authHeaders();

  // App registration decides which return and area addresses are allowed.
  const appRes = await fetch(`${api}/v1/apps/${encodeURIComponent(pending.app)}`);
  if (!appRes.ok) throw new Error("This link comes from an app GeoVivé doesn't recognize.");
  const app = await appRes.json();
  if (pending.returnUrl && !originAllowed(pending.returnUrl, app.returnOrigins)) {
    throw new Error("This link's return address isn't allowed for this app.");
  }

  headers["Content-Type"] = "application/json";
  const res = await fetch(
    `${api}/v1/apps/${encodeURIComponent(pending.app)}/maps/${encodeURIComponent(pending.ref)}`,
    { method: "PUT", headers, body: JSON.stringify({
        title: pending.title || undefined,
        externalUrl: pending.returnUrl || undefined,
        referenceArea: pending.area || undefined
      }) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || `Could not open the map (${res.status}).`);

  const session = {
    datasetId: data.datasetId,
    title: data.name,
    appId: pending.app,
    appName: app.name,
    returnUrl: pending.returnUrl,
    area: data.referenceArea,
    layers: pending.layers,
    focus: pending.focus
  };
  if (session.returnUrl) writeJson(sessionStorage, SESSION_KEY, session);
  return session;
}

// View link: show the app's layers only (no sign-in, no map created)
async function startView(pending) {
  const appRes = await fetch(`${window.GeoVive.apiBase}/v1/apps/${encodeURIComponent(pending.app)}`);
  if (!appRes.ok) throw new Error("This link comes from an app GeoVivé doesn't recognize.");
  const app = await appRes.json();
  if (pending.returnUrl && !originAllowed(pending.returnUrl, app.returnOrigins)) {
    throw new Error("This link's return address isn't allowed for this app.");
  }
  const session = {
    view: true, appId: pending.app, appName: app.name, title: pending.title || `${app.name} layers`,
    returnUrl: pending.returnUrl, layers: pending.layers, focus: pending.focus
  };
  writeJson(sessionStorage, SESSION_KEY, session);
  return session;
}

async function enterSession(session, { fit }) {
  if (session.view) {
    announceApp(session);
    if (session.returnUrl) showSessionBanner(session);
    session.focus = null;
    writeJson(sessionStorage, SESSION_KEY, session);   // focus only once
    return;
  }
  await window.GeoVive.refreshDatasetOptions();
  const key = `api:${session.datasetId}`;
  const select = $("dataset-select");
  if (select) select.value = key;
  await window.GeoVive.applyDataset(key);
  window.dispatchEvent(new CustomEvent("geovive:datasets-changed"));
  await loadReferenceArea(session.area, { fit });
  announceApp(session);
  if (session.returnUrl) showSessionBanner(session);
  if (session.focus) { session.focus = null; if (session.returnUrl) writeJson(sessionStorage, SESSION_KEY, session); }
}

// ------------------------------------------------------------ init

async function init() {
  // 1. A fresh /open link: remember it and clean the address bar.
  if (window.location.pathname.replace(/\/+$/, "") === "/open") {
    const q = new URLSearchParams(window.location.search);
    const pending = {
      app: q.get("app"), ref: q.get("ref"), title: q.get("title"),
      area: q.get("area"), returnUrl: q.get("return"),
      layers: splitList(q.get("layers")), focus: q.get("focus") || undefined
    };
    writeJson(sessionStorage, SESSION_KEY, null);
    if (pending.app && (pending.ref || pending.layers.length)) writeJson(sessionStorage, PENDING_KEY, pending);
    else showError("This GeoVivé link is missing information (it needs app, plus ref or layers).");
    history.replaceState(null, "", "/");
  }

  await window.GeoVive.ready;
  await window.GeoViveAuthReady;

  // Re-draw the outline after map style changes.
  window.GeoVive.map.on("style.load", () => setTimeout(drawReferenceArea, 0));

  const pending = readJson(sessionStorage, PENDING_KEY);
  const user = await getCurrentUser();
  const signedIn = user && !user.expired;

  if (pending && !pending.ref) {
    writeJson(sessionStorage, PENDING_KEY, null);
    try { await enterSession(await startView(pending), { fit: true }); }
    catch (e) { console.error(e); showError(e.message); }
    return;
  }

  if (pending) {
    if (!signedIn) {
      const el = showBanner(`
        <span class="open-banner-text">Sign in to open <strong>${esc(pending.title || "your map")}</strong> in GeoVivé.</span>
        <button type="button" class="btn primary" data-action="signin">Sign in</button>
        <button type="button" class="link-btn" data-action="cancel">Cancel</button>`);
      el.querySelector("[data-action=signin]").addEventListener("click", () => login());
      el.querySelector("[data-action=cancel]").addEventListener("click", () => {
        writeJson(sessionStorage, PENDING_KEY, null);
        hideBanner();
      });
      return;
    }
    writeJson(sessionStorage, PENDING_KEY, null);
    try {
      const session = await startSession(pending);
      await enterSession(session, { fit: true });
    } catch (e) {
      console.error(e);
      showError(e.message);
    }
    return;
  }

  // 2. Reload during an active session: restore banner and outline, keep the view.
  const session = readJson(sessionStorage, SESSION_KEY);
  if (session && (signedIn || session.view)) {
    try { await enterSession(session, { fit: false }); }
    catch (e) { console.error(e); writeJson(sessionStorage, SESSION_KEY, null); }
  }
}

init().catch(e => console.error("Open link init failed", e));
