// AppConnect: sign up an app, verify its domain, run checks, get the report, pay.
import { UserManager, WebStorageStateStore } from "oidc-client-ts";

const CONFIG = window.GEOVIVE_CONFIG || {};
const API = CONFIG.API_BASE;
const root = document.getElementById("ac-root");
const params = new URLSearchParams(location.search);

// Same session store as the map, so a sign-in there works here.
const users = new UserManager({
  authority: CONFIG.COGNITO_AUTHORITY, client_id: CONFIG.COGNITO_CLIENT_ID,
  redirect_uri: `${location.origin}/`, response_type: "code", scope: "openid email profile",
  userStore: new WebStorageStateStore({ store: window.localStorage })
});

const LAYER_STATE = { approved: "Approved", review: "In review", rejected: "Not approved", checking: "Checking" };
const STEPS = [
  ["registered", "Registered"], ["domain", "Domain verified"], ["checks", "Checks passed"],
  ["payment", "Payment"], ["live", "Live"]
];

const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const date = iso => iso ? new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : "—";

async function token() {
  const u = await users.getUser();
  return u && !u.expired ? u.access_token : null;
}

async function api(path, opts = {}) {
  const t = await token();
  if (!t) throw Object.assign(new Error("Please sign in again"), { status: 401 });
  const res = await fetch(`${API}${path}`, { ...opts, headers: { Authorization: `Bearer ${t}`, "Content-Type": "application/json", ...(opts.headers || {}) } });
  const body = res.status === 204 ? null : await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(body?.message || `Request failed (${res.status})`), { status: res.status });
  return body;
}

function signInView() {
  root.innerHTML = `
    <h2>Sign in to connect an app</h2>
    <p>AppConnect lets your app bring its own map layers to GeoVivé for your users. Sign in with your GeoVivé account to register an app, verify your domain and run the connection checks.</p>
    <p>Before you start, read <a href="/docs/developers/appconnect/">what you need to connect</a>.</p>
    <p><button class="ac-btn" id="ac-signin">Sign in</button></p>`;
  document.getElementById("ac-signin").onclick = () => {
    sessionStorage.setItem("geovive:after-signin", location.pathname + location.search);
    users.signinRedirect({ prompt: "select_account" });
  };
}

function msg(el, text, kind = "err") { el.innerHTML = text ? `<div class="ac-msg ${kind}">${esc(text)}</div>` : ""; }

async function listView() {
  const { apps } = await api("/v1/appconnect/apps");
  root.innerHTML = `
    ${params.get("paid") ? `<div class="ac-msg ok">Payment received. Your connection goes live within a minute; you'll get an email with your notice.</div>` : ""}
    <h2>Your apps</h2>
    <div class="ac-apps">${apps.length ? apps.map(a => `
      <a class="ac-app" href="?app=${encodeURIComponent(a.appId)}"><span><strong>${esc(a.name)}</strong><br><small>${esc(a.domain)} · ${esc(a.appId)}</small></span>
      <span class="ac-badge ${esc(a.status)}">${esc(a.statusLabel)}</span></a>`).join("") : "<p>No apps yet.</p>"}</div>
    <h2>Register an app</h2>
    ${formHtml()}`;
  bindForm();
}

function formHtml() {
  return `
  <form class="ac-form" id="ac-form">
    <label>App name<input name="name" required maxlength="80" placeholder="Trail Maps"></label>
    <label>App ID (used in links; lowercase, numbers and dashes)<input name="appId" required pattern="[a-z0-9][a-z0-9-]{2,40}" placeholder="trail-maps"></label>
    <label>Your domain (you'll prove you control it)<input name="domain" required placeholder="trails.example.com"></label>
    <label>Layer list address (on your domain)<input name="layersUrl" type="url" required placeholder="https://trails.example.com/geovive-layers.json"></label>
    <label>Return addresses, one per line (on your domain; http://localhost works in sandbox only)<textarea name="returnOrigins" rows="2" placeholder="https://trails.example.com"></textarea></label>
    <label>Contact email (reports and renewal notices go here)<input name="contactEmail" type="email" required></label>
    <label class="check"><input type="checkbox" name="acceptTerms" required> <span>I accept the <a href="/docs/terms/appconnect/" target="_blank" rel="noopener">AppConnect Terms v1.0</a> and confirm I have the right to display the data my layer list describes, and that it contains no personal information about individuals.</span></label>
    <div id="ac-form-msg"></div>
    <div><button class="ac-btn" type="submit">Register app</button></div>
  </form>`;
}

function bindForm() {
  const form = document.getElementById("ac-form");
  form.domain.addEventListener("change", () => {
    const d = form.domain.value.trim().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
    if (d && !form.layersUrl.value) form.layersUrl.value = `https://${d}/geovive-layers.json`;
    if (d && !form.returnOrigins.value) form.returnOrigins.value = `https://${d}`;
  });
  form.name.addEventListener("input", () => {
    if (!form.appId.dataset.touched) form.appId.value = form.name.value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 41);
  });
  form.appId.addEventListener("input", () => { form.appId.dataset.touched = "1"; });
  form.onsubmit = async e => {
    e.preventDefault();
    const out = document.getElementById("ac-form-msg"); msg(out, "");
    const btn = form.querySelector("button"); btn.disabled = true;
    try {
      const body = {
        name: form.name.value, appId: form.appId.value, domain: form.domain.value, layersUrl: form.layersUrl.value,
        contactEmail: form.contactEmail.value, acceptTerms: form.acceptTerms.checked,
        returnOrigins: form.returnOrigins.value.split(/\s+/).filter(Boolean)
      };
      const app = await api("/v1/appconnect/apps", { method: "POST", body: JSON.stringify(body) });
      location.search = `?app=${encodeURIComponent(app.appId)}`;
    } catch (err) { msg(out, err.message); btn.disabled = false; }
  };
}

function stepState(app) {
  const s = app.status, hist = app.history || [];
  const domainOk = hist.some(h => h.type === "checks" && h.summary?.find(c => c.key === "domain")?.result === "pass");
  const order = { registered: 0, verifying: 1, checks_failed: 1, checks_passed: 3, awaiting_payment: 3, sandbox: 4, live: 5, expired: 4, suspended: 1 };
  const reached = Math.max(order[s] ?? 0, domainOk ? 2 : 1);
  return STEPS.map(([k, label], i) => [label, i < reached ? "done" : i === reached ? "now" : ""]);
}

async function appView(appId) {
  let app;
  try { app = await api(`/v1/appconnect/apps/${encodeURIComponent(appId)}`); }
  catch (e) { if (e.status === 404) { root.innerHTML = `<div class="ac-msg err">App not found.</div><p><a href="/appconnect/">Your apps</a></p>`; return; } throw e; }
  if (app.status === "disconnected" || app.status === "closed") return offboardedView(app);
  const v = app.verification;
  const running = app.status === "verifying";
  root.innerHTML = `
    <p><a href="/appconnect/">← Your apps</a></p>
    ${params.get("paid") ? `<div class="ac-msg ok">Payment received. Your connection goes live within a minute; you'll get an email with your notice.</div>` : ""}
    <div class="ac-row" style="justify-content:space-between">
      <h2 style="margin:0">${esc(app.name)}</h2><span class="ac-badge ${esc(app.status)}">${esc(app.statusLabel)}</span>
    </div>
    <p style="color:var(--muted)">${esc(app.domain)} · App ID <code>${esc(app.appId)}</code> · Contact ${esc(app.contactEmail)}</p>
    <div class="ac-steps">${stepState(app).map(([l, c]) => `<div class="ac-step ${c}">${esc(l)}</div>`).join("")}</div>

    ${app.status === "live" ? `<div class="ac-msg ok">Live until ${date(app.termEndsAt)} (${esc(app.termsVersion || "")}). Renew any time before then to add a year.</div>` : ""}
    ${app.status === "awaiting_payment" && app.paymentUrl ? `
      <div class="card"><p style="margin-top:0"><strong>All required checks passed.</strong> Pay the yearly fee and accept the terms to go live. Promo codes are applied at checkout.</p>
      <a class="ac-btn pay" href="${esc(app.paymentUrl)}">Pay &amp; connect →</a></div>` : ""}

    <h3>1. Verify your domain</h3>
    <p>Publish <strong>one</strong> of these, then run the checks:</p>
    <p>DNS TXT record <span class="ac-copy">${esc(v.dnsName)}</span> with value <span class="ac-copy">${esc(v.dnsValue)}</span></p>
    <p>or a file at <span class="ac-copy">${esc(v.fileUrl)}</span> containing <span class="ac-copy">${esc(v.fileContents)}</span></p>

    <h3>2. Host your layer list</h3>
    <p>At <span class="ac-copy">${esc(app.layersUrl)}</span> — see the <a href="/docs/developers/#layer-lists">format</a>.</p>

    <h3>3. Run the checks</h3>
    <div class="ac-row">
      <button class="ac-btn" id="ac-run" ${running ? "disabled" : ""}>${running ? "Checking…" : app.lastReportId ? "Run checks again" : "Run checks"}</button>
      ${app.lastReportId ? `<button class="ac-btn secondary" id="ac-report">View latest report (PDF)</button>` : ""}
    </div>
    <div id="ac-run-msg"></div>
    ${running ? `<p style="color:var(--muted)">Checking your domain, layer list and every source. This usually takes under a minute; the report is also emailed to ${esc(app.contactEmail)}.</p>` : ""}

    ${app.layers?.length ? `<h3>Layers</h3>
    <p style="color:var(--muted)">Only approved layers are shown to your users. New or changed layers are checked automatically; any needing a person are reviewed within 5 business days.</p>
    <ul class="ac-hist">${app.layers.sort((a, b) => a.id.localeCompare(b.id)).map(l => `<li><code>${esc(l.id)}</code> · <span class="ac-badge ${l.state === "approved" ? "live" : l.state === "rejected" ? "checks_failed" : "verifying"}">${esc(LAYER_STATE[l.state] || l.state)}</span>${l.findings?.length && l.state !== "approved" ? ` · ${esc(l.findings.join("; "))}` : ""}</li>`).join("")}</ul>` : ""}

    <h3>Account linking <small style="color:var(--muted);font-weight:400">(optional)</small></h3>
    <p style="color:var(--muted)">Let your users link their GeoVivé account to your app, so it can read and add to their maps with their consent. See the <a href="/docs/developers/#account-linking">developer guide</a>.</p>
    <div class="card">
      <p style="margin-top:0">Client ID <span class="ac-copy">${esc(app.oauth?.clientId || app.appId)}</span></p>
      <p>Client secret: ${app.oauth?.hasSecret ? `set, ends in <code>…${esc(app.oauth.secretHint)}</code> (created ${date(app.oauth.secretCreatedAt)})` : "not created yet"}
        <button class="ac-btn secondary" id="ac-secret" style="margin-left:6px">${app.oauth?.hasSecret ? "Replace secret" : "Create secret"}</button></p>
      <div id="ac-secret-out"></div>
      <form class="ac-form" id="ac-oauth-form">
        <label>Redirect URIs (one per line, https on ${esc(app.domain)}${app.status === "sandbox" ? " or http://localhost while in the sandbox" : ""}; up to 5)
          <textarea name="uris" rows="3" spellcheck="false" placeholder="https://${esc(app.domain)}/geovive/callback">${esc((app.oauth?.redirectUris || []).join("\n"))}</textarea></label>
        <div id="ac-oauth-msg"></div>
        <div class="ac-row"><button class="ac-btn" type="submit">Save redirect URIs</button></div>
      </form>
    </div>

    <h3>History</h3>
    <ul class="ac-hist">${(app.history || []).map(h => `<li>${date(h.at)} · ${esc(describe(h))}</li>`).join("")}</ul>

    <details class="ac-leave">
      <summary>Leave AppConnect</summary>
      ${app.disconnectAt ? `<div class="ac-msg">Disconnection scheduled for ${date(app.disconnectAt)}. Your app stays live until then. <button class="ac-btn secondary" id="ac-cancel-leave">Cancel it</button></div>` : `
      <p>Disconnecting is clean and immediate: your layers stop showing, GeoVivé deletes its copies, and you get a certificate plus an export of your settings. You can reconnect within 90 days. Nothing is refunded for the rest of a paid term (see the <a href="/docs/terms/appconnect/#t10">terms</a>).</p>
      <form class="ac-form" id="ac-leave-form">
        <label class="check"><input type="radio" name="when" value="now" checked> <span>Disconnect now</span></label>
        ${app.status === "live" && app.termEndsAt ? `<label class="check"><input type="radio" name="when" value="term_end"> <span>Stay live until ${date(app.termEndsAt)}, then disconnect</span></label>` : ""}
        <label>Why are you leaving? (optional, helps us improve)
          <select name="reason" style="background:var(--code-bg);color:var(--text);border:1px solid var(--border);border-radius:6px;padding:8px">
            <option value="not_needed">We no longer need it</option><option value="cost">Cost</option><option value="another_platform">Moving to another platform</option>
            <option value="missing_features">Missing features</option><option value="business_closed">Our business or product is closing</option><option value="other" selected>Other</option>
          </select></label>
        <label>Anything else? (optional)<textarea name="note" rows="2" maxlength="500"></textarea></label>
        <label>Type <code>${esc(app.appId)}</code> to confirm<input name="confirm" autocomplete="off" required></label>
        <div id="ac-leave-msg"></div>
        <div class="ac-row"><button class="ac-btn danger" type="submit">Disconnect</button> <button class="ac-btn secondary" type="button" id="ac-export">Download settings (JSON)</button></div>
      </form>`}
    </details>`;

  document.getElementById("ac-export")?.addEventListener("click", () => downloadExport(appId));
  const oauthForm = document.getElementById("ac-oauth-form");
  if (oauthForm) oauthForm.onsubmit = async e => {
    e.preventDefault();
    const out = document.getElementById("ac-oauth-msg");
    const redirectUris = oauthForm.uris.value.split(/\s+/).map(x => x.trim()).filter(Boolean);
    try {
      await api(`/v1/appconnect/apps/${encodeURIComponent(appId)}/oauth`, { method: "PUT", body: JSON.stringify({ redirectUris }) });
      msg(out, `Saved ${redirectUris.length} redirect URI${redirectUris.length === 1 ? "" : "s"}.`, "ok");
    } catch (err) { msg(out, err.message); }
  };
  document.getElementById("ac-secret")?.addEventListener("click", async () => {
    if (app.oauth?.hasSecret && !confirm("Replace the client secret? The old one stops working immediately, so update your server first or right after.")) return;
    const out = document.getElementById("ac-secret-out");
    try {
      const r = await api(`/v1/appconnect/apps/${encodeURIComponent(appId)}/oauth/secret`, { method: "POST" });
      out.innerHTML = `<div class="ac-msg ok"><strong>Copy this secret now. GeoVivé won't show it again.</strong><br>
        <span class="ac-copy" id="ac-secret-val">${esc(r.clientSecret)}</span> <button class="ac-btn secondary" id="ac-secret-copy">Copy</button><br>
        Keep it on your server only (never in a browser or mobile app).</div>`;
      document.getElementById("ac-secret-copy").onclick = () => navigator.clipboard.writeText(r.clientSecret);
      document.getElementById("ac-secret").textContent = "Replace secret";
      app.oauth = { ...(app.oauth || {}), hasSecret: true, secretHint: r.secretHint, secretCreatedAt: r.secretCreatedAt };
    } catch (err) { msg(out, err.message); }
  });
  document.getElementById("ac-cancel-leave")?.addEventListener("click", async () => {
    await api(`/v1/appconnect/apps/${encodeURIComponent(appId)}/disconnect`, { method: "DELETE" }); appView(appId);
  });
  const leave = document.getElementById("ac-leave-form");
  if (leave) leave.onsubmit = async (e) => {
    e.preventDefault();
    const out = document.getElementById("ac-leave-msg"); msg(out, "");
    if (leave.confirm.value.trim() !== app.appId) { msg(out, "Type the app ID exactly to confirm."); return; }
    const btn = leave.querySelector("button[type=submit]"); btn.disabled = true;
    try {
      await api(`/v1/appconnect/apps/${encodeURIComponent(appId)}/disconnect`, { method: "POST", body: JSON.stringify({
        when: leave.when.value, reason: leave.reason.value, note: leave.note.value, confirm: leave.confirm.value.trim() }) });
      appView(appId);
    } catch (err) { msg(out, err.message); btn.disabled = false; }
  };

  const run = document.getElementById("ac-run");
  if (run) run.onclick = async () => {
    run.disabled = true;
    try { await api(`/v1/appconnect/apps/${encodeURIComponent(appId)}/checks`, { method: "POST" }); appView(appId); }
    catch (e) { msg(document.getElementById("ac-run-msg"), e.message); run.disabled = false; }
  };
  const rep = document.getElementById("ac-report");
  if (rep) rep.onclick = async () => {
    const w = window.open("", "_blank");
    try { const { url } = await api(`/v1/appconnect/apps/${encodeURIComponent(appId)}/reports/${encodeURIComponent(app.lastReportId)}`); if (w) w.location = url; else location.href = url; }
    catch (e) { if (w) w.close(); msg(document.getElementById("ac-run-msg"), e.message); }
  };
  if (running || (params.get("paid") && app.status !== "live")) setTimeout(() => appView(appId), 5000);
}

async function downloadExport(appId) {
  const data = await api(`/v1/appconnect/apps/${encodeURIComponent(appId)}/export`);
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
  a.download = `${appId}-appconnect-export.json`; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

function offboardedView(app) {
  const cert = (app.history || []).find(h => h.type === "disconnected")?.certId;
  if (app.status === "closed") {
    root.innerHTML = `<p><a href="/appconnect/">← Your apps</a></p><h2>${esc(app.name)}</h2>
      <div class="ac-msg">This connection was closed on ${date(app.closedAt)}. Its reports and history have been deleted. The app ID <code>${esc(app.appId)}</code> stays reserved for you.</div>
      <p>To connect again, register it as a new app below.</p><p><a class="ac-btn" href="/appconnect/">Register again</a></p>`;
    return;
  }
  root.innerHTML = `<p><a href="/appconnect/">← Your apps</a></p>
    <div class="ac-row" style="justify-content:space-between"><h2 style="margin:0">${esc(app.name)}</h2><span class="ac-badge checks_failed">Disconnected</span></div>
    <div class="card">
      <p style="margin-top:0"><strong>Disconnected on ${date(app.disconnectedAt)}.</strong> Your layers no longer show, and GeoVivé has deleted its display copies. Your certificate and a settings export were emailed to ${esc(app.contactEmail)}.</p>
      <p>You can reconnect until <strong>${date(app.purgeAt)}</strong>. After that, reports and history are deleted and the record is closed.</p>
      <div class="ac-row">
        <button class="ac-btn" id="ac-reconnect">Reconnect</button>
        ${cert ? `<button class="ac-btn secondary" id="ac-cert">Certificate (PDF)</button>` : ""}
        <button class="ac-btn secondary" id="ac-export">Settings (JSON)</button>
      </div><div id="ac-off-msg"></div>
    </div>
    <h3>History</h3>
    <ul class="ac-hist">${(app.history || []).map(h => `<li>${date(h.at)} · ${esc(describe(h))}</li>`).join("")}</ul>`;
  document.getElementById("ac-export").onclick = () => downloadExport(app.appId);
  document.getElementById("ac-reconnect").onclick = async () => {
    try { await api(`/v1/appconnect/apps/${encodeURIComponent(app.appId)}/reconnect`, { method: "POST" }); appView(app.appId); }
    catch (e) { msg(document.getElementById("ac-off-msg"), e.message); }
  };
  const c = document.getElementById("ac-cert");
  if (c) c.onclick = async () => {
    const w = window.open("", "_blank");
    try { const { url } = await api(`/v1/appconnect/apps/${encodeURIComponent(app.appId)}/reports/${encodeURIComponent(cert)}`); if (w) w.location = url; }
    catch (e) { if (w) w.close(); msg(document.getElementById("ac-off-msg"), e.message); }
  };
}

function describe(h) {
  if (h.type === "disconnected") return `Disconnected (certificate ${h.certId})`;
  if (h.type === "disconnect-scheduled") return `Disconnection scheduled for ${date(h.at2)}`;
  if (h.type === "disconnect-cancelled") return "Scheduled disconnection cancelled";
  if (h.type === "status") return `Stage: ${h.from === "none" ? "" : h.from.replace(/_/g, " ") + " → "}${h.to.replace(/_/g, " ")}`;
  if (h.type === "checks") return `Checks ${h.passed ? "passed" : "failed"} (${h.reportId})`;
  if (h.type === "email") return `Emailed ${h.what}`;
  if (h.type === "payment") return `Payment received${h.promo ? " with a promotion" : ""}`;
  if (h.type === "term") return `Term runs to ${date(h.termEndsAt)} (${h.termsVersion})`;
  if (h.type === "notice") return `“Connection is live” notice sent`;
  if (h.type === "layer-change") return `Layer changes found: ${(h.layers || []).join(", ")}`;
  if (h.type === "layer-review") return `Layer update checked: ${(h.approved || []).length} approved, ${(h.review || []).length} in review, ${(h.rejected || []).length} not approved`;
  if (h.type === "oauth-redirects") return `Account linking: ${h.count} redirect URI${h.count === 1 ? "" : "s"} saved`;
  if (h.type === "oauth-secret") return `Account linking: client secret created (…${h.hint})`;
  if (h.type === "layer-decision") return `Reviewer ${h.decision === "approve" ? "approved" : "rejected"} ${h.layerId}`;
  return h.type;
}

(async () => {
  try {
    if (!(await token())) return signInView();
    const appId = params.get("app");
    if (appId) await appView(appId); else await listView();
  } catch (e) {
    if (e.status === 401) return signInView();
    root.innerHTML = `<div class="ac-msg err">${esc(e.message)}</div>`;
  }
})();
