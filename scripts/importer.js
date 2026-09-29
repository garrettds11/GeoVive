// importer.js — "Import data" into one of your maps (GeoJSON file/URL, ArcGIS layer).
//
// The backend does the work in the background (POST …/imports, then poll
// GET …/imports/{id}); files go straight to S3 with a presigned upload URL.

const $ = (id) => document.getElementById(id);
const MAX_FILE = 50_000_000;

function esc(v) {
  return String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

async function api(method, path, body) {
  const headers = await window.GeoVive.authHeaders();
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(`${window.GeoVive.apiBase}${path}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || `Request failed (${res.status})`);
  return data;
}

function currentDatasetId() {
  const key = window.GeoVive.currentDataset;
  return key && key.startsWith("api:") ? key.slice(4) : null;
}

// ------------------------------------------------------------ dialog

function buildDialog() {
  const dlg = document.createElement("dialog");
  dlg.id = "import-dialog";
  dlg.className = "import-dialog";
  dlg.innerHTML = `
    <form method="dialog" class="import-form">
      <h3>Import data into <span id="import-target"></span></h3>

      <fieldset class="import-sources">
        <label><input type="radio" name="src" value="upload" checked> GeoJSON file</label>
        <label><input type="radio" name="src" value="url"> GeoJSON link</label>
        <label><input type="radio" name="src" value="arcgis"> ArcGIS layer</label>
      </fieldset>

      <div data-src="upload">
        <input type="file" id="import-file" accept=".geojson,.json,application/geo+json,application/json">
        <p class="hint">A <strong>.geojson</strong> or <strong>.json</strong> map data file, the common format that open-data sites, GIS software and many map apps export. Up to 50 MB, in regular latitude/longitude.</p>
      </div>
      <div data-src="url" hidden>
        <input type="url" id="import-url" placeholder="https://…/data.geojson">
        <p class="hint">A web address that downloads a GeoJSON file, e.g. the "GeoJSON" download link on a government or open-data site.</p>
      </div>
      <div data-src="arcgis" hidden>
        <input type="url" id="import-arcgis" placeholder="https://…/FeatureServer/0">
        <input type="text" id="import-where" placeholder="Optional filter, e.g. STATE = 'CO'">
        <p class="hint">Many state and federal agencies publish map layers on ArcGIS servers. Paste the address of one layer; it ends in <strong>FeatureServer/0</strong> or <strong>MapServer/2</strong> (any number). Up to 20,000 features.</p>
      </div>

      <details class="import-options">
        <summary>Options</summary>
        <label>Name field <input type="text" id="import-name-field" list="import-fields" placeholder="Automatic"></label>
        <label>Category field <input type="text" id="import-category-field" list="import-fields" placeholder="None"></label>
        <p class="hint">Fields are the columns of information each feature carries, like UNIT_NAME or TYPE. Leave blank and GeoVivé picks a name field for you.</p>
        <datalist id="import-fields"></datalist>
        <label class="inline"><input type="checkbox" id="import-replace"> Replace everything in this map</label>
      </details>

      <p id="import-status" class="import-status" role="status"></p>
      <div class="import-actions">
        <button type="button" class="btn" data-action="close">Close</button>
        <button type="button" class="btn primary" data-action="start">Import</button>
      </div>
    </form>`;
  document.body.appendChild(dlg);

  dlg.querySelectorAll("input[name=src]").forEach(r => r.addEventListener("change", () => {
    dlg.querySelectorAll("[data-src]").forEach(d => { d.hidden = d.dataset.src !== r.value || !r.checked; });
    showSource(dlg);
  }));
  dlg.querySelector("[data-action=close]").addEventListener("click", () => dlg.close());
  dlg.querySelector("[data-action=start]").addEventListener("click", () => start(dlg));
  $("import-file").addEventListener("change", () => suggestFields($("import-file").files[0]));
  return dlg;
}

function showSource(dlg) {
  const src = dlg.querySelector("input[name=src]:checked").value;
  dlg.querySelectorAll("[data-src]").forEach(d => { d.hidden = d.dataset.src !== src; });
}

// Offer the file's property names for the name/category fields.
async function suggestFields(file) {
  const list = $("import-fields");
  list.innerHTML = "";
  if (!file || file.size > 5_000_000) return;   // only peek at small files
  try {
    const gj = JSON.parse(await file.text());
    const feats = gj.type === "FeatureCollection" ? gj.features : [gj];
    const keys = new Set();
    feats.slice(0, 50).forEach(f => Object.keys(f?.properties || {}).forEach(k => keys.add(k)));
    list.innerHTML = [...keys].map(k => `<option value="${esc(k)}">`).join("");
  } catch { /* the backend reports real problems */ }
}

function setStatus(msg, kind = "") {
  const el = $("import-status");
  el.textContent = msg || "";
  el.dataset.kind = kind;
}

function setBusy(dlg, busy) {
  dlg.querySelector("[data-action=start]").disabled = busy;
  dlg.querySelectorAll("input").forEach(i => { i.disabled = busy; });
}

// ------------------------------------------------------------ run

async function start(dlg) {
  const datasetId = currentDatasetId();
  if (!datasetId) return;
  const src = dlg.querySelector("input[name=src]:checked").value;
  const body = {
    mode: $("import-replace").checked ? "replace" : "append",
    nameField: $("import-name-field").value.trim() || undefined,
    categoryField: $("import-category-field").value.trim() || undefined
  };
  const base = `/v1/datasets/${encodeURIComponent(datasetId)}/imports`;

  setBusy(dlg, true);
  try {
    if (src === "upload") {
      const file = $("import-file").files[0];
      if (!file) throw new Error("Choose a GeoJSON file first.");
      if (file.size > MAX_FILE) throw new Error("That file is larger than 50 MB.");
      setStatus("Uploading…");
      const up = await api("POST", `${base}/upload-url`);
      const put = await fetch(up.uploadUrl, { method: "PUT", headers: { "Content-Type": up.contentType }, body: file });
      if (!put.ok) throw new Error(`Upload failed (${put.status}).`);
      body.source = { type: "upload", key: up.key, fileName: file.name };
    } else if (src === "url") {
      const url = $("import-url").value.trim();
      if (!url) throw new Error("Paste a link to a GeoJSON file.");
      body.source = { type: "url", url };
    } else {
      const url = $("import-arcgis").value.trim();
      if (!url) throw new Error("Paste an ArcGIS layer URL.");
      body.source = { type: "arcgis", url, where: $("import-where").value.trim() || undefined };
    }
    if (body.mode === "replace" && !confirm("Replace everything in this map with the imported data? This can't be undone.")) {
      setStatus(""); return;
    }

    setStatus("Starting…");
    let job = await api("POST", base, body);
    while (job.status === "queued" || job.status === "running") {
      setStatus(job.message || "Working…");
      await new Promise(r => setTimeout(r, 1500));
      job = await api("GET", `${base}/${encodeURIComponent(job.importId)}`);
    }

    if (job.status === "succeeded") {
      const extra = job.errors?.length ? ` First problem: ${job.errors[0]}` : "";
      setStatus(`${job.message}${extra}`, job.skipped ? "warn" : "ok");
      await window.GeoVive.refreshDatasetOptions();
      await window.GeoVive.applyDataset(`api:${datasetId}`);
      window.dispatchEvent(new CustomEvent("geovive:datasets-changed"));
      window.GeoVive.zoomToData();
    } else {
      setStatus(job.message || "The import failed.", "error");
    }
  } catch (e) {
    setStatus(e.message, "error");
  } finally {
    setBusy(dlg, false);
  }
}

// ------------------------------------------------------------ init

async function init() {
  await window.GeoVive.ready;
  const actions = document.querySelector("#edit-bar .edit-actions");
  if (!actions) return;
  const btn = document.createElement("button");
  btn.type = "button";
  btn.id = "import-btn";
  btn.className = "btn";
  btn.textContent = "Import";
  btn.title = "Import data (GeoJSON file or link, ArcGIS layer) into this map";
  actions.insertBefore(btn, $("delete-map-btn"));

  let dlg;
  btn.addEventListener("click", () => {
    dlg = dlg || buildDialog();
    const ds = window.GeoVive.datasets.find(d => d.datasetId === currentDatasetId());
    $("import-target").textContent = ds?.name || "this map";
    setStatus("");
    showSource(dlg);
    dlg.showModal();
  });
}

init().catch(e => console.error("Import init failed", e));
