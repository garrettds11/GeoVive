// Consent page for account linking (OAuth 2.0). An app sends the user here with
// client_id, redirect_uri, scope, state and a PKCE code_challenge. GeoVivé checks the
// request; the user approves (and may share some maps read-only) or cancels, and is
// sent back to the app's registered address.
import { UserManager, WebStorageStateStore } from "oidc-client-ts";

const CONFIG = window.GEOVIVE_CONFIG || {};
const API = CONFIG.API_BASE;
const root = document.getElementById("cx-root");
const users = new UserManager({
  authority: CONFIG.COGNITO_AUTHORITY, client_id: CONFIG.COGNITO_CLIENT_ID,
  redirect_uri: `${location.origin}/`, response_type: "code", scope: "openid email profile",
  userStore: new WebStorageStateStore({ store: window.localStorage })
});
const esc = v => String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const KEYS = ["client_id", "redirect_uri", "response_type", "scope", "state", "code_challenge", "code_challenge_method"];
const q = new URLSearchParams(location.search);
const params = Object.fromEntries(KEYS.filter(k => q.has(k)).map(k => [k, q.get(k)]));

async function api(method, path, body) {
  const u = await users.getUser();
  if (!u || u.expired) throw Object.assign(new Error("Please sign in"), { status: 401 });
  const res = await fetch(`${API}${path}`, { method, headers: { Authorization: `Bearer ${u.access_token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.message || `Request failed (${res.status})`), { status: res.status });
  return data;
}

const initial = n => esc((n || "?").trim()[0].toUpperCase());
function fail(text) {
  root.innerHTML = `<div class="cx-card"><div class="cx-err"><strong>This link can't be used.</strong><br>${esc(text)}</div>
    <p class="cx-note">Nothing was shared. Go back to the app and try again, or contact the app's developer.</p></div>`;
}

function signIn() {
  root.innerHTML = `<div class="cx-card">
    <div class="cx-apps"><div class="cx-logo">?</div><span class="cx-link">⇄</span><div class="cx-logo gv">G</div></div>
    <h2>Sign in to GeoVivé</h2>
    <p class="cx-sub">An app wants to link to your GeoVivé account. Sign in to see what it's asking for. Nothing is shared until you approve.</p>
    <div class="cx-actions"><button class="btn2 primary" id="cx-signin">Sign in</button></div></div>`;
  document.getElementById("cx-signin").onclick = () => {
    sessionStorage.setItem("geovive:after-signin", location.pathname + location.search);
    users.signinRedirect({ prompt: "select_account" });
  };
}

function render(info, user) {
  const { app, scopes, grant, maps } = info;
  const readScope = scopes.some(s => s.scope === "maps:read");
  const shareable = maps.filter(m => !m.fromThisApp);
  const shared = new Set(grant?.sharedDatasets || []);
  const fromApp = maps.filter(m => m.fromThisApp).length;
  root.innerHTML = `<div class="cx-card">
    <div class="cx-apps"><div class="cx-logo">${initial(app.name)}</div><span class="cx-link">⇄</span><div class="cx-logo gv">G</div></div>
    <h2>${esc(app.name)} wants to link to your GeoVivé account</h2>
    <p class="cx-sub">${esc(app.domain)} · a verified AppConnect app${grant ? " · <b>already linked</b>" : ""}</p>
    <div class="cx-h">It will be able to</div>
    <ul class="cx-scopes">${scopes.map(s => `<li>${esc(s.label)}</li>`).join("")}</ul>
    <p class="cx-never">It won't see your email address or password, your other maps, or anything you don't share below. ${fromApp ? `You have ${fromApp} map${fromApp > 1 ? "s" : ""} it created.` : ""}</p>
    ${readScope && shareable.length ? `
      <div class="cx-h">Share other maps (optional, read-only)</div>
      <div class="cx-maps">${shareable.map(m => `<label><input type="checkbox" value="${esc(m.datasetId)}" ${shared.has(m.datasetId) ? "checked" : ""}>
        <span class="n">${esc(m.name)}</span><span class="vis ${m.visibility}">${m.visibility === "public" ? "Public" : "Private"}</span></label>`).join("")}</div>
      <p class="cx-note">The app can read these maps but not change them. You can change this later in My data.</p>` : ""}
    <div class="cx-actions">
      <button class="btn2" id="cx-deny">Cancel</button>
      <button class="btn2 primary" id="cx-allow">Allow</button>
    </div>
    <p class="cx-who">Signed in as ${esc(user.profile.email || user.profile.preferred_username || "you")} · <a href="#" id="cx-switch">Not you?</a></p>
  </div>`;
  const decide = async approve => {
    root.querySelectorAll("button").forEach(b => (b.disabled = true));
    const sharedDatasets = [...root.querySelectorAll(".cx-maps input:checked")].map(i => i.value);
    try {
      const out = await api("POST", "/v1/oauth/authorize", { params, approve, sharedDatasets });
      location.replace(out.redirect);
    } catch (e) { fail(e.message); }
  };
  document.getElementById("cx-allow").onclick = () => decide(true);
  document.getElementById("cx-deny").onclick = () => decide(false);
  document.getElementById("cx-switch").onclick = async e => {
    e.preventDefault(); await users.removeUser();
    sessionStorage.setItem("geovive:after-signin", location.pathname + location.search);
    users.signinRedirect({ prompt: "select_account" });
  };
}

(async () => {
  if (!params.client_id || !params.redirect_uri) return fail("It's missing the app's details.");
  try {
    const user = await users.getUser();
    if (!user || user.expired) return signIn();
    const info = await api("GET", `/v1/oauth/authorize?${new URLSearchParams(params)}`);
    if (info.redirect) return location.replace(info.redirect);   // the request had a problem the app should hear about
    render(info, user);
  } catch (e) {
    if (e.status === 401) { await users.removeUser(); return signIn(); }
    fail(e.message);
  }
})();
