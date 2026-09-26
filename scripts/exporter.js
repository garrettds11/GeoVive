// exporter.js — download the active dataset as GeoJSON, KML or GPX.
// The API builds the file (full-detail shapes) and returns a short-lived link.

const FORMATS = [
  { value: "geojson", label: "GeoJSON",
    help: "Standard map data file. Use it with GIS software (QGIS, ArcGIS), other web maps, or to import back into GeoVivé." },
  { value: "kml", label: "KML (Google Earth)",
    help: "Opens in Google Earth, Google My Maps and most mapping apps. Keeps pin colors and details." },
  { value: "gpx", label: "GPX (GPS apps)",
    help: "For GPS units and phone apps like onX, Gaia GPS, CalTopo and Garmin. Pins become waypoints; lines and area edges become tracks." }
];

function currentDatasetId() {
  const key = window.GeoVive.currentDataset;
  return key && key.startsWith("api:") ? key.slice(4) : null;
}

async function init() {
  await window.GeoVive.ready;
  const bar = document.querySelector(".dataset-actions");
  if (!bar) return;

  const select = document.createElement("select");
  select.id = "export-format";
  select.className = "export-format";
  select.setAttribute("aria-label", "Export format");
  select.innerHTML = FORMATS.map(f => `<option value="${f.value}">${f.label}</option>`).join("");

  const btn = document.createElement("button");
  btn.type = "button";
  btn.id = "export-btn";
  btn.className = "btn";
  btn.textContent = "Export";

  const status = document.createElement("span");
  status.className = "export-status";
  status.setAttribute("role", "status");

  const help = document.createElement("p");
  help.className = "hint export-help";
  const showHelp = () => { help.textContent = FORMATS.find(f => f.value === select.value)?.help || ""; };
  select.addEventListener("change", showHelp);
  showHelp();

  bar.append(select, btn, status, help);

  const sync = () => { btn.disabled = select.disabled = !currentDatasetId(); };
  window.addEventListener("geovive:dataset-applied", sync);
  sync();

  btn.addEventListener("click", async () => {
    const id = currentDatasetId();
    if (!id) return;
    btn.disabled = true;
    status.textContent = "Preparing…";
    try {
      const headers = { ...(await window.GeoVive.authHeaders()), "Content-Type": "application/json" };
      const res = await fetch(`${window.GeoVive.apiBase}/v1/datasets/${encodeURIComponent(id)}/exports`, {
        method: "POST", headers, body: JSON.stringify({ format: select.value })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.message || `Export failed (${res.status})`);
      window.location.assign(data.url);   // the file is served as a download
      status.textContent = `${data.featureCount} feature${data.featureCount === 1 ? "" : "s"}`;
      setTimeout(() => { status.textContent = ""; }, 4000);
    } catch (e) {
      status.textContent = e.message;
    } finally {
      btn.disabled = false;
    }
  });
}

init().catch(e => console.error("Export init failed", e));
