// pin-view.js — the read-only pin card: name, type, notes rendered as Markdown,
// and actions: edit (owners), copy as Markdown, copy as JSON.
// Also turns "U+1F3E0"-style codes into the characters they name, wherever pin
// text is shown (the stored text is left as the user typed it).
(function () {
  const esc = v => String(v ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  // U+1F3E0, U+{1F3E0}, \u{1F3E0}, ❤ -> the character
  function uni(text) {
    const cp = (h) => { const n = parseInt(h, 16); return n > 0 && n <= 0x10FFFF && !(n >= 0xD800 && n <= 0xDFFF) ? String.fromCodePoint(n) : null; };
    return String(text ?? "")
      .replace(/U\+\{?([0-9A-Fa-f]{4,6})\}?/g, (m, h) => cp(h) ?? m)
      .replace(/\\u\{([0-9A-Fa-f]{1,6})\}/g, (m, h) => cp(h) ?? m)
      .replace(/\\u([0-9A-Fa-f]{4})/g, (m, h) => cp(h) ?? m);
  }

  // Small, safe Markdown: text is escaped first, then **bold**, *italic*, `code`,
  // [links](https://…), # headings, - / 1. lists, and paragraphs.
  function inline(s) {
    return s
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>")
      .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
      .replace(/(^|\s)(https?:\/\/[^\s<]+)/g, '$1<a href="$2" target="_blank" rel="noopener noreferrer">$2</a>');
  }
  function markdown(src) {
    const lines = esc(uni(src)).split(/\r?\n/);
    const out = []; let list = null, para = [];
    const flushPara = () => { if (para.length) { out.push(`<p>${inline(para.join("<br>"))}</p>`); para = []; } };
    const flushList = () => { if (list) { out.push(`<${list.tag}>${list.items.map(i => `<li>${inline(i)}</li>`).join("")}</${list.tag}>`); list = null; } };
    for (const line of lines) {
      let m;
      if (!line.trim()) { flushPara(); flushList(); continue; }
      if ((m = line.match(/^(#{1,3})\s+(.*)$/))) { flushPara(); flushList(); out.push(`<div class="md-h md-h${m[1].length}">${inline(m[2])}</div>`); continue; }
      if ((m = line.match(/^\s*[-*]\s+(.*)$/)) || (m = line.match(/^\s*\d+[.)]\s+(.*)$/))) {
        flushPara();
        const tag = /^\s*\d/.test(line) ? "ol" : "ul";
        if (!list || list.tag !== tag) { flushList(); list = { tag, items: [] }; }
        list.items.push(m[1]); continue;
      }
      flushList(); para.push(line);
    }
    flushPara(); flushList();
    return out.join("");
  }

  const ICONS = {
    save: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3h12v18l-6-4-6 4z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M12 7v6M9 10h6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
    edit: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16v4z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M13.5 6.5l4 4" stroke="currentColor" stroke-width="2"/></svg>',
    md: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="2" y="5" width="20" height="14" rx="2.5" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M5.5 15V9l2.5 3 2.5-3v6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M16.5 9v5.5M14.2 12.3l2.3 2.4 2.3-2.4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>',
    json: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 4c-2 0-2.5 1-2.5 3v2c0 1.2-.8 2-2 2v2c1.2 0 2 .8 2 2v2c0 2 .5 3 2.5 3M16 4c2 0 2.5 1 2.5 3v2c0 1.2.8 2 2 2v2c-1.2 0-2 .8-2 2v2c0 2-.5 3-2.5 3" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><circle cx="9.5" cy="12" r="1.1" fill="currentColor"/><circle cx="12" cy="12" r="1.1" fill="currentColor"/><circle cx="14.5" cy="12" r="1.1" fill="currentColor"/></svg>',
    share: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="18" cy="5" r="2.6" fill="none" stroke="currentColor" stroke-width="1.8"/><circle cx="6" cy="12" r="2.6" fill="none" stroke="currentColor" stroke-width="1.8"/><circle cx="18" cy="19" r="2.6" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M8.2 10.7l7.6-4.4M8.2 13.3l7.6 4.4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>'
  };

  function coordsOf(feature) {
    const c = feature?.geometry?.type === "Point" ? feature.geometry.coordinates : null;
    return c ? `${(+c[1]).toFixed(6)}, ${(+c[0]).toFixed(6)}` : "";
  }

  // Issue #57: shareable pin links. The URL carries only the two IDs needed to
  // resolve the feature server-side (dataset-search.js's deep-link handler calls
  // the same GET /v1/datasets/{id}/features/{id} the app already uses, which already
  // enforces the dataset's visibility) -- never name/description/coordinates, so a
  // copied link can't leak more than the recipient would see by opening it anyway.
  function shareUrl(props) {
    if (!props?.datasetId || !props?.id) return null;
    const u = new URL(location.origin + location.pathname);
    u.searchParams.set("dataset", props.datasetId);
    u.searchParams.set("feature", props.id);
    return u.toString();
  }

  // External-map handoff degrades gracefully to plain coordinates, since Google Maps
  // (etc.) has no notion of a GeoVivé feature id -- a place name mixed into the same
  // query param isn't reliably recognized, so this deliberately keeps it to lat,lng.
  function googleMapsUrl(feature) {
    const c = feature?.geometry?.type === "Point" ? feature.geometry.coordinates : null;
    return c ? `https://www.google.com/maps/search/?api=1&query=${(+c[1])},${(+c[0])}` : null;
  }

  function toMarkdown(props, feature) {
    const lines = [`### ${uni(props.name || "Untitled")}`, "", `**Type:** ${uni(props.category || "location")}`];
    const at = coordsOf(feature);
    if (at) lines.push(`**Location:** ${at}`);
    const notes = uni(props.description || "").trim();
    if (notes) lines.push("", notes);
    return lines.join("\n");
  }

  function toJson(props, feature) {
    const keep = {};
    for (const [k, v] of Object.entries(props || {})) if (v !== undefined && v !== null && v !== "") keep[k] = typeof v === "string" ? uni(v) : v;
    return JSON.stringify({ type: "Feature", geometry: feature?.geometry || null, properties: keep }, null, 2);
  }

  function html(props, { editable = false, category, savable = false } = {}) {
    const notes = props.description || props.country || "";
    const canShare = !!shareUrl(props);
    return `
      <div class="pin-card">
        <div class="popup-title">${esc(uni(props.name || "Untitled"))}</div>
        <div class="popup-category">${esc(uni(category || props.category || "location")).toUpperCase()}</div>
        ${notes ? `<div class="popup-desc md">${markdown(notes)}</div>` : ""}
        ${/^Saved from /.test(props.source || "") ? `<div class="pin-from">${esc(props.source)}</div>` : ""}
        <div class="pin-actions">
          ${savable ? `<button type="button" class="pin-save" data-act="save" title="Save a copy to one of your maps">${ICONS.save}<span>Save to my map</span></button>` : ""}
          ${editable ? `<button type="button" class="pin-act" data-act="edit" title="Edit pin" aria-label="Edit pin">${ICONS.edit}</button>` : ""}
          ${canShare ? `<span class="pin-share-wrap">
            <button type="button" class="pin-act" data-act="share" title="Share this pin" aria-label="Share this pin" aria-haspopup="true" aria-expanded="false">${ICONS.share}</button>
            <div class="pin-share-menu" role="menu" hidden>
              <button type="button" role="menuitem" data-share="copy">Copy link</button>
              <button type="button" role="menuitem" data-share="gmaps">Open in Google Maps</button>
            </div>
          </span>` : ""}
          <button type="button" class="pin-act" data-act="md" title="Copy as Markdown" aria-label="Copy as Markdown">${ICONS.md}</button>
          <button type="button" class="pin-act" data-act="json" title="Copy as JSON" aria-label="Copy as JSON">${ICONS.json}</button>
          <span class="pin-copied" role="status" aria-live="polite"></span>
        </div>
        <div class="pin-save-panel" hidden></div>
      </div>`;
  }

  async function copy(text) {
    try { await navigator.clipboard.writeText(text); return true; }
    catch {
      const ta = document.createElement("textarea"); ta.value = text; ta.style.position = "fixed"; ta.style.opacity = "0";
      document.body.appendChild(ta); ta.select();
      let ok = false; try { ok = document.execCommand("copy"); } catch { /* ignore */ }
      ta.remove(); return ok;
    }
  }

  // Wire the buttons inside a popup element.
  function bind(root, props, feature, { onEdit, onSave } = {}) {
    root.querySelector('[data-act="save"]')?.addEventListener("click", () => onSave?.(root));
    const note = root.querySelector(".pin-copied");
    let t;
    const flash = (msg) => { if (!note) return; note.textContent = msg; clearTimeout(t); t = setTimeout(() => { note.textContent = ""; }, 1600); };
    root.querySelector('[data-act="edit"]')?.addEventListener("click", () => onEdit?.());
    root.querySelector('[data-act="md"]')?.addEventListener("click", async () => flash(await copy(toMarkdown(props, feature)) ? "Copied Markdown" : "Copy failed"));
    root.querySelector('[data-act="json"]')?.addEventListener("click", async () => flash(await copy(toJson(props, feature)) ? "Copied JSON" : "Copy failed"));

    const shareBtn = root.querySelector('[data-act="share"]');
    const menu = root.querySelector(".pin-share-menu");
    if (shareBtn && menu) {
      const url = shareUrl(props);
      const closeMenu = () => { menu.hidden = true; shareBtn.setAttribute("aria-expanded", "false"); };
      shareBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        // Mobile-native share sheet when available -- skip our own menu entirely.
        if (navigator.share) {
          try { await navigator.share({ title: uni(props.name || "A GeoVivé pin"), url }); }
          catch { /* user cancelled -- not an error */ }
          return;
        }
        const willOpen = menu.hidden;
        document.querySelectorAll(".pin-share-menu").forEach(m => { m.hidden = true; });
        menu.hidden = !willOpen;
        shareBtn.setAttribute("aria-expanded", String(willOpen));
      });
      menu.querySelector('[data-share="copy"]')?.addEventListener("click", async (e) => {
        e.stopPropagation();
        flash(await copy(url) ? "Link copied" : "Copy failed");
        closeMenu();
      });
      const gmaps = googleMapsUrl(feature);
      const gmapsBtn = menu.querySelector('[data-share="gmaps"]');
      if (gmaps) gmapsBtn?.addEventListener("click", (e) => { e.stopPropagation(); closeMenu(); window.open(gmaps, "_blank", "noopener"); });
      else gmapsBtn?.remove();
      document.addEventListener("click", closeMenu);
      root.addEventListener("keydown", (e) => { if (e.key === "Escape") closeMenu(); });
      // The popup element is discarded when the popup closes, but the document-level
      // listener above isn't -- give the caller a way to remove it (show() does, below).
      root.__pinShareCleanup = () => document.removeEventListener("click", closeMenu);
    }
  }

  // Show a pin card popup at lngLat. Returns the popup.
  function show(map, lngLat, props, feature, opts = {}) {
    const editable = !!window.GeoViveEditor?.canEdit?.(props);
    // Any pin you can't edit here can be copied into one of your own maps
    const savable = !editable && !!props.datasetId && !!window.GeoViveEditor?.saveTo;
    const popup = new mapboxgl.Popup({ closeOnMove: false, maxWidth: "300px" })
      .setLngLat(lngLat).setHTML(html(props, { editable, savable, category: opts.category })).addTo(map);
    const root = popup.getElement();
    bind(root, props, feature, {
      onEdit: () => { popup.remove(); window.GeoViveEditor.edit(feature); },
      onSave: (root) => window.GeoViveEditor.saveTo(root, props, feature)
    });
    popup.on("close", () => root.__pinShareCleanup?.());
    return popup;
  }

  window.GeoVivePin = { uni, markdown, html, bind, show, toMarkdown, toJson, shareUrl, googleMapsUrl };
})();
