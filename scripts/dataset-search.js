// dataset-search.js — find public maps by name, description and tags.
// Results come from GET /v1/datasets/search; picking one opens it and adds it
// to the Dataset menu's "Public maps" (recently opened) list.

const input = document.getElementById("ds-search-input");
const box = document.getElementById("ds-search-results");
let tag = "", timer = 0, seq = 0, results = [], active = -1;

const esc = v => String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fold = s => String(s ?? "").normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase();

// Highlight query words (matching accent-insensitively) in already-escaped text
function mark(text, words) {
  let out = esc(text);
  if (!words.length) return out;
  const f = fold(out);
  const spans = [];
  words.forEach(w => { let i = f.indexOf(w); while (i !== -1) { spans.push([i, i + w.length]); i = f.indexOf(w, i + w.length); } });
  spans.sort((a, b) => b[0] - a[0]).forEach(([a, b]) => {
    if (out.slice(a, b).includes("&") || out.slice(a, b).includes(";")) return;   // don't cut entities
    out = out.slice(0, a) + "<mark>" + out.slice(a, b) + "</mark>" + out.slice(b);
  });
  return out;
}

async function run() {
  const q = input.value.trim();
  if (!q && !tag) { box.hidden = true; box.innerHTML = ""; return; }
  const my = ++seq;
  const url = `${window.GeoVive.apiBase}/v1/datasets/search?limit=12&q=${encodeURIComponent(q)}${tag ? `&tag=${encodeURIComponent(tag)}` : ""}`;
  let data;
  try { const res = await fetch(url); data = await res.json(); if (!res.ok) throw new Error(data.message); }
  catch (e) { if (my === seq) { box.hidden = false; box.innerHTML = `<div class="ds-empty">Search isn't available right now.</div>`; } return; }
  if (my !== seq) return;   // a newer search finished first
  results = data.results; active = -1;
  const words = fold(q).split(/\s+/).filter(w => w.length >= 2);
  const tags = data.tags.slice(0, 10);
  box.hidden = false;
  box.innerHTML = `
    ${tags.length ? `<div class="ds-tags">${tags.map(t => `<button type="button" class="ds-tag${t.name === tag ? " on" : ""}" data-tag="${esc(t.name)}">#${esc(t.name)} <small>${t.count}</small></button>`).join("")}</div>` : ""}
    ${results.length ? results.map((d, i) => `
      <button type="button" class="ds-result" role="option" id="ds-r${i}" data-i="${i}" aria-selected="false">
        <div class="t"><span>${mark(d.name, words)}</span><small>${d.featureCount || 0} places</small></div>
        ${d.description ? `<div class="d">${mark(d.description, words)}</div>` : ""}
        ${d.tags?.length ? `<div class="tg">${d.tags.map(t => `<span>#${mark(t, words)}</span>`).join("")}</div>` : ""}
      </button>`).join("")
      : `<div class="ds-empty">No public maps match${q ? ` “${esc(q)}”` : ""}${tag ? ` with #${esc(tag)}` : ""}.</div>`}
    ${data.total > results.length ? `<div class="ds-more">Showing ${results.length} of ${data.total}. Add a word or pick a tag to narrow it down.</div>` : ""}`;
}

async function pick(i) {
  const d = results[i];
  if (!d) return;
  box.hidden = true;
  input.value = "";
  tag = "";
  await window.GeoVive.openDataset(d.datasetId, { fit: true });
}

input.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(run, 220); });
input.addEventListener("focus", () => { if (input.value.trim() || tag) run(); });
input.addEventListener("keydown", e => {
  const items = [...box.querySelectorAll(".ds-result")];
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    if (!items.length) return;
    active = (active + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
    items.forEach((el, k) => el.setAttribute("aria-selected", String(k === active)));
    items[active].scrollIntoView({ block: "nearest" });
    input.setAttribute("aria-activedescendant", items[active].id);
  } else if (e.key === "Enter") {
    e.preventDefault();
    pick(active >= 0 ? active : 0);
  } else if (e.key === "Escape") {
    box.hidden = true;
  }
});
box.addEventListener("click", e => {
  const t = e.target.closest("[data-tag]");
  if (t) { tag = tag === t.dataset.tag ? "" : t.dataset.tag; run(); input.focus(); return; }
  const r = e.target.closest(".ds-result");
  if (r) pick(Number(r.dataset.i));
});
document.addEventListener("click", e => { if (!e.target.closest("#ds-search")) box.hidden = true; });
