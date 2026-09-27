// Admin: GeoVivé sign-in → admins group (else "not found") → authenticator code → the console.
// Every check is enforced by the API (/v1/admin/*); this page only shows what the API allows.
import { UserManager, WebStorageStateStore } from "oidc-client-ts";

const CONFIG = window.GEOVIVE_CONFIG || {};
const API = CONFIG.API_BASE;
const root = document.getElementById("ad-root");
const users = new UserManager({
  authority: CONFIG.COGNITO_AUTHORITY, client_id: CONFIG.COGNITO_CLIENT_ID,
  redirect_uri: `${location.origin}/`, response_type: "code", scope: "openid email profile",
  userStore: new WebStorageStateStore({ store: window.localStorage })
});
const esc = v => String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const when = iso => iso ? new Date(iso).toLocaleString() : "";
const usd = n => `$${Number(n || 0).toFixed(2)}`;
const SESSION_KEY = "geovive:admin-session";   // sessionStorage: gone when the tab closes
const S = { maps: [], f: { q: "", vis: "", owner: "" }, open: null };

let session = null;
try { session = sessionStorage.getItem(SESSION_KEY); } catch {}

async function token() { const u = await users.getUser(); return u && !u.expired ? u.access_token : null; }
async function api(method, path, body) {
  const t = await token();
  if (!t) throw Object.assign(new Error("Please sign in again"), { status: 401 });
  const res = await fetch(`${API}${path}`, { method, headers: { Authorization: `Bearer ${t}`,
    ...(session ? { "x-admin-session": session } : {}), ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined });
  const data = res.status === 204 ? null : await res.json().catch(() => ({}));
  if (!res.ok) {
    if (data?.code === "session") { setSession(null); return gate(); }
    throw Object.assign(new Error(data?.message || `Request failed (${res.status})`), { status: res.status });
  }
  return data;
}
function setSession(t) { session = t; try { t ? sessionStorage.setItem(SESSION_KEY, t) : sessionStorage.removeItem(SESSION_KEY); } catch {} }

// ------------------------------------------------------------------ gate

async function start() {
  const u = await users.getUser();
  if (!u || u.expired) {
    root.innerHTML = `<div class="ad-gate"><h2>Sign in</h2><p class="muted">Sign in with your GeoVivé account.</p>
      <p><button class="btn2 primary" id="ad-signin">Sign in</button></p></div>`;
    document.getElementById("ad-signin").onclick = () => { sessionStorage.setItem("geovive:after-signin", "/admin/"); users.signinRedirect({ prompt: "select_account" }); };
    return;
  }
  let me;
  try { me = await api("GET", "/v1/admin/me"); }
  catch (e) {
    root.innerHTML = e.status === 404
      ? `<div class="ad-gate"><h2>Page not found</h2><p><a href="/">Back to the map</a></p></div>`
      : `<p class="ad-err">${esc(e.message)}</p>`;
    return;
  }
  if (!me.session) return gate(me.authenticator);
  console_();
}

async function gate(status) {
  if (!status) status = (await api("GET", "/v1/admin/me")).authenticator;
  let setup = "";
  if (status === "setup") {
    const s = await api("POST", "/v1/admin/mfa/setup");
    let img = "";
    try { const mod = await import("qrcode"); const QR = mod.toDataURL ? mod : mod.default; img = `<img alt="QR code for your authenticator app" src="${await QR.toDataURL(s.otpauth, { width: 200, margin: 1 })}">`; } catch {}
    setup = `<p class="muted">Scan this with an authenticator app (Google Authenticator, 1Password, Authy…), then enter the 6-digit code it shows.</p>
      ${img}<p class="muted">Can't scan? Enter this key: <code>${esc(s.secret)}</code></p>`;
  }
  root.innerHTML = `<form class="ad-gate" id="ad-code-form">
      <h2>${status === "setup" ? "Set up your authenticator" : "Enter your authenticator code"}</h2>${setup}
      <p><input class="ad-code" id="ad-code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" pattern="\\d{6}" required aria-label="6-digit code"></p>
      <p class="ad-err" id="ad-err"></p>
      <p><button class="btn2 primary">Continue</button></p>
      <p class="muted" style="font-size:0.8rem">Admin stays unlocked for 12 hours in this tab.</p></form>`;
  const input = document.getElementById("ad-code"); input.focus();
  document.getElementById("ad-code-form").onsubmit = async e => {
    e.preventDefault();
    try { const r = await api("POST", "/v1/admin/mfa/verify", { code: input.value }); setSession(r.token); console_(); }
    catch (err) { document.getElementById("ad-err").textContent = err.message; input.select(); }
  };
}

// ------------------------------------------------------------------ console

async function console_() {
  root.innerHTML = `<p class="muted">Loading…</p>`;
  const [ov, ds, au] = await Promise.all([api("GET", "/v1/admin/overview"), api("GET", "/v1/admin/datasets"), api("GET", "/v1/admin/audit")]);
  if (!ov) return;
  S.maps = ds.datasets; S.audit = au.entries;
  const v = ov.mapsByVisibility || {};
  const cost = ov.cost?.error ? `<span class="muted">Cost unavailable (${esc(ov.cost.error)})</span>`
    : `<ul class="ad-cost">${(ov.cost.services || []).slice(0, 6).map(x => `<li>${esc(x.service)}: ${usd(x.usd)}</li>`).join("")}</ul>`;
  root.innerHTML = `
    <div class="md-cards">
      <div class="md-card"><b>${ov.users}</b><span>users</span></div>
      <div class="md-card"><b>${ov.maps}</b><span>maps · ${v.public || 0} public · ${v.private || 0} private</span></div>
      <div class="md-card"><b>${ov.pins}</b><span>pins</span></div>
      <div class="md-card ${ov.cost?.totalUsd > 20 ? "warn" : ""}"><b>${ov.cost?.error ? "—" : usd(ov.cost.totalUsd)}</b><span>AWS this month (since ${esc(ov.cost?.from || "")})</span></div>
    </div>

    <section class="md-section" id="ad-review"></section>

    <section class="md-section"><h2>Maps</h2>
      <div class="ad-bar">
        <input type="search" id="ad-q" placeholder="Search name or owner" value="${esc(S.f.q)}">
        <select id="ad-vis"><option value="">All visibility</option><option value="public">Public</option><option value="private">Private</option><option value="review">In review</option></select>
        <select id="ad-owner"><option value="">All owners</option>${[...new Set(S.maps.map(m => m.owner))].sort().map(o => `<option>${esc(o)}</option>`).join("")}</select>
      </div>
      <div id="ad-maps"></div>
    </section>

    <section class="md-section"><h2>Agents</h2>
      <p class="muted">${esc(ov.agents?.note || "")} Controls for on/off, limits, runs and spend against the $20/month cap appear here once they're deployed.</p>
    </section>

    <section class="md-section"><h2>Apps</h2>
      ${ov.apps.length ? `<table class="ad-table"><thead><tr><th>App</th><th>Status</th><th>Term ends</th></tr></thead><tbody>
        ${ov.apps.map(a => `<tr><td class="n">${esc(a.name || a.appId)}</td><td>${esc(a.status)}</td><td>${esc((a.termEndsAt || "").slice(0, 10))}</td></tr>`).join("")}</tbody></table>`
        : `<p class="muted">No connected apps.</p>`}
    </section>

    <section class="md-section"><h2>Costs this month</h2>${cost}
      <div class="ad-links">
        <a class="btn2" href="https://us-east-1.console.aws.amazon.com/costmanagement/home#/home" target="_blank" rel="noopener">AWS billing ↗</a>
        <a class="btn2" href="https://us-east-1.console.aws.amazon.com/cloudformation/home?region=us-east-1" target="_blank" rel="noopener">AWS console ↗</a>
        <a class="btn2" href="https://dashboard.stripe.com/" target="_blank" rel="noopener">Stripe ↗</a>
        <span class="btn2" aria-disabled="true" title="Set up with the agents">Grafana (not set up yet)</span>
      </div>
    </section>

    <section class="md-section"><h2>Audit log</h2><div id="ad-audit"></div></section>

    <dialog class="ad-dlg" id="ad-dlg"><form method="dialog" id="ad-dlg-form"></form></dialog>`;
  document.getElementById("ad-vis").value = S.f.vis;
  document.getElementById("ad-owner").value = S.f.owner;
  document.getElementById("ad-q").oninput = e => { S.f.q = e.target.value; renderMaps(); };
  document.getElementById("ad-vis").onchange = e => { S.f.vis = e.target.value; renderMaps(); };
  document.getElementById("ad-owner").onchange = e => { S.f.owner = e.target.value; renderMaps(); };
  renderReview(); renderMaps(); renderAudit();
}

const visBadge = v => `<span class="vis ${esc(v)}">${v === "review" ? "In review" : esc(v)}</span>`;

function mapRow(m, review) {
  return `<tr data-id="${esc(m.datasetId)}">
    <td><div class="n">${esc(m.name)}</div><div class="s">${esc(m.description || "").slice(0, 140)}</div></td>
    <td class="s">${esc(m.owner)}</td>
    <td>${visBadge(m.visibility)}</td>
    <td class="s">${m.featureCount || 0} pins<br>${esc((m.updatedAt || "").slice(0, 10))}</td>
    <td><div class="ad-actions">
      <button class="btn2" data-act="preview">Preview</button>
      ${review ? `<button class="btn2 primary" data-act="public">Approve</button><button class="btn2" data-act="private">Reject</button>`
        : `<select class="btn2" data-act="vis" aria-label="Visibility">${["public", "private", "review"].map(v => `<option value="${v}" ${v === m.visibility ? "selected" : ""}>${v === "review" ? "In review" : v[0].toUpperCase() + v.slice(1)}</option>`).join("")}</select>`}
      <button class="btn2 danger" data-act="delete">🗑️</button>
    </div></td></tr>`;
}
function table(rows) { return `<table class="ad-table"><thead><tr><th>Map</th><th>Owner</th><th>Visibility</th><th>Size</th><th></th></tr></thead><tbody>${rows}</tbody></table>`; }

function renderReview() {
  const q = S.maps.filter(m => m.visibility === "review");
  const el = document.getElementById("ad-review");
  el.innerHTML = `<h2>Review queue</h2>` + (q.length ? table(q.map(m => mapRow(m, true)).join("")) : `<p class="muted">Nothing waiting for review.</p>`);
  wire(el);
}
function renderMaps() {
  const { q, vis, owner } = S.f, ql = q.trim().toLowerCase();
  const hits = S.maps.filter(m => (!vis || m.visibility === vis) && (!owner || m.owner === owner)
    && (!ql || `${m.name} ${m.owner} ${m.description || ""}`.toLowerCase().includes(ql)));
  const el = document.getElementById("ad-maps");
  el.innerHTML = hits.length ? table(hits.map(m => mapRow(m, false)).join("")) : `<p class="muted">No maps match.</p>`;
  wire(el);
}
function renderAudit() {
  const el = document.getElementById("ad-audit");
  el.innerHTML = S.audit.length ? `<table class="ad-table"><thead><tr><th>When</th><th>Who</th><th>What</th><th>Details</th></tr></thead><tbody>
    ${S.audit.map(a => `<tr><td class="s">${esc(when(a.at))}</td><td class="s">${esc(a.actorEmail || a.actor)}</td><td>${esc(a.action)}</td>
      <td class="s">${esc([a.detail?.name, a.detail?.from && `${a.detail.from} → ${a.detail.to}`, a.detail?.reason].filter(Boolean).join(" · "))}</td></tr>`).join("")}</tbody></table>`
    : `<p class="muted">No entries yet.</p>`;
}

function wire(el) {
  el.querySelectorAll("tr[data-id]").forEach(tr => {
    const m = S.maps.find(x => x.datasetId === tr.dataset.id);
    tr.querySelectorAll("[data-act]").forEach(b => {
      const act = b.dataset.act;
      if (act === "vis") b.onchange = () => changeVis(m, b.value, b);
      else b.onclick = () => act === "preview" ? preview(m, tr) : act === "delete" ? del(m) : changeVis(m, act);
    });
  });
}

async function preview(m, tr) {
  const next = tr.nextElementSibling;
  if (next?.classList.contains("ad-preview")) { next.remove(); return; }
  const row = document.createElement("tr"); row.className = "ad-preview";
  row.innerHTML = `<td colspan="5" class="muted">Loading pins…</td>`; tr.after(row);
  try {
    const fc = await api("GET", `/v1/admin/datasets/${encodeURIComponent(m.datasetId)}/features?limit=100`);
    const f = fc.features || [];
    row.innerHTML = `<td colspan="5">${f.length ? `<ul>${f.map(x => `<li>${esc(x.properties?.name)} <span class="s">(${esc(x.properties?.category)})</span></li>`).join("")}</ul>` : "<span class='muted'>No pins.</span>"}
      ${fc.nextToken ? `<p class="s">Showing the first 100.</p>` : ""}</td>`;
  } catch (e) { row.innerHTML = `<td colspan="5" class="ad-err">${esc(e.message)}</td>`; }
}

function ask(html) {
  const dlg = document.getElementById("ad-dlg"), form = document.getElementById("ad-dlg-form");
  form.innerHTML = html + `<p class="ad-err" id="ad-dlg-err"></p><div class="ad-actions"><button class="btn2" value="cancel" formnovalidate>Cancel</button><button class="btn2 primary" value="ok">Confirm</button></div>`;
  dlg.showModal();
  return new Promise(res => dlg.addEventListener("close", () => res(dlg.returnValue === "ok" ? new FormData(form) : null), { once: true }));
}

async function changeVis(m, visibility, select) {
  const fd = await ask(`<h3>Make "${esc(m.name)}" ${visibility === "review" ? "in review" : visibility}?</h3>
    <label>Reason (saved in the audit log)<input name="reason" maxlength="300"></label>`);
  if (!fd) { if (select) select.value = m.visibility; return; }
  try {
    await api("PATCH", `/v1/admin/datasets/${encodeURIComponent(m.datasetId)}`, { visibility, reason: fd.get("reason") });
    await console_();
  } catch (e) { alertErr(e); if (select) select.value = m.visibility; }
}

async function del(m) {
  const fd = await ask(`<h3>Delete "${esc(m.name)}"?</h3>
    <p class="muted">This removes the map and its ${m.featureCount || 0} pins for ${esc(m.owner)}. It can't be undone.</p>
    <label>Type the map's name to confirm<input name="confirm" required autocomplete="off"></label>
    <label>Reason (saved in the audit log)<input name="reason" maxlength="300"></label>`);
  if (!fd) return;
  try {
    await api("DELETE", `/v1/admin/datasets/${encodeURIComponent(m.datasetId)}`, { confirm: fd.get("confirm"), reason: fd.get("reason") });
    await console_();
  } catch (e) { alertErr(e); }
}
function alertErr(e) {
  const p = document.createElement("p"); p.className = "ad-err"; p.textContent = e.message;
  root.prepend(p); setTimeout(() => p.remove(), 6000);
}

start().catch(e => { root.innerHTML = `<p class="ad-err">${esc(e.message)}</p>`; });
