// report.mjs — branded AppConnect PDFs: the validation report and the
// "your connection is live" notice. Built with pdf-lib and the standard
// Helvetica fonts (WinAnsi text only: no emoji or check-mark glyphs).

import { PDFDocument, StandardFonts, rgb, PDFName, PDFString } from "pdf-lib";
import { LOGO_PNG_BASE64 } from "./logo.mjs";

const hex = h => rgb(parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255);
const C = {
  navy: hex("#020617"), slate: hex("#0f172a"), green: hex("#16a34a"), greenSoft: hex("#dcfce7"),
  blue: hex("#1d5c8f"), blueSoft: hex("#e0edf8"), amber: hex("#b45309"), amberSoft: hex("#fef3c7"),
  red: hex("#b91c1c"), redSoft: hex("#fee2e2"), ink: hex("#111827"), muted: hex("#6b7280"),
  line: hex("#e5e7eb"), panel: hex("#f8fafc"), white: rgb(1, 1, 1), light: hex("#cbd5e1"), dim: hex("#94a3b8")
};
const RESULT = {
  pass: { label: "PASS", fg: C.green, bg: C.greenSoft },
  review: { label: "REVIEW", fg: C.blue, bg: C.blueSoft },
  done: { label: "DONE", fg: C.green, bg: C.greenSoft },
  note: { label: "NOTE", fg: C.amber, bg: C.amberSoft },
  fail: { label: "FAIL", fg: C.red, bg: C.redSoft }
};

const W = 612, H = 792, M = 50;

// Keep text inside WinAnsi (pdf-lib standard fonts can't encode other characters).
const safe = s => String(s ?? "").replace(/[‘’]/g, "'").replace(/[→➜]/g, "›")
  .replace(/[✓✔]/g, "").replace(/[^\x20-\x7E\xA0-\xFF“”–—•…·›€]/g, "?");

export function fmtDate(iso, withTime = false) {
  const d = new Date(iso);
  const opts = { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" };
  if (withTime) Object.assign(opts, { hour: "numeric", minute: "2-digit", timeZoneName: "short" });
  return d.toLocaleString("en-US", opts);
}

class Doc {
  static async create(meta) {
    const d = new Doc();
    d.pdf = await PDFDocument.create();
    d.pdf.setTitle(meta.title); d.pdf.setAuthor("GeoVivé"); d.pdf.setSubject(meta.subject || meta.title);
    d.pdf.setCreator("GeoVivé AppConnect"); d.pdf.setProducer("GeoVivé");
    d.f = await d.pdf.embedFont(StandardFonts.Helvetica);
    d.b = await d.pdf.embedFont(StandardFonts.HelveticaBold);
    d.mono = await d.pdf.embedFont(StandardFonts.Courier);
    d.logo = await d.pdf.embedPng(Buffer.from(LOGO_PNG_BASE64, "base64"));
    d.meta = meta; d.pages = [];
    return d;
  }

  width(t, size, font = this.f) { return font.widthOfTextAtSize(safe(t), size); }

  wrap(text, size, maxW, font = this.f) {
    const lines = [];
    for (const para of safe(text).split("\n")) {
      let line = "";
      for (const word of para.split(/\s+/)) {
        const tryLine = line ? `${line} ${word}` : word;
        if (font.widthOfTextAtSize(tryLine, size) <= maxW) { line = tryLine; continue; }
        if (line) lines.push(line);
        // break very long words (URLs)
        let w = word;
        while (font.widthOfTextAtSize(w, size) > maxW) {
          let k = w.length; while (k > 1 && font.widthOfTextAtSize(w.slice(0, k), size) > maxW) k--;
          lines.push(w.slice(0, k)); w = w.slice(k);
        }
        line = w;
      }
      lines.push(line);
    }
    return lines;
  }

  text(t, x, y, { size = 9.5, font = this.f, color = C.ink } = {}) {
    this.page.drawText(safe(t), { x, y, size, font, color });
  }

  para(t, { x = M, width = W - 2 * M, size = 9.5, font = this.f, color = C.ink, leading = size * 1.4, gap = 4 } = {}) {
    const lines = this.wrap(t, size, width, font);
    this.ensure(lines.length * leading + gap);
    for (const l of lines) { this.text(l, x, this.y - size, { size, font, color }); this.y -= leading; }
    this.y -= gap;
  }

  newPage(first = false) {
    this.page = this.pdf.addPage([W, H]); this.pages.push(this.page);
    const p = this.page;
    if (first) {
      p.drawRectangle({ x: 0, y: H - 112, width: W, height: 112, color: C.navy });
      p.drawRectangle({ x: 0, y: H - 112, width: W, height: 3, color: C.green });
      p.drawImage(this.logo, { x: M - 6, y: H - 102, width: 84, height: 84 });
      this.text("GeoVivé", M + 86, H - 52, { size: 22, font: this.b, color: C.white });
      this.text(this.meta.heading, M + 86, H - 72, { size: 12, color: C.light });
      let yy = H - 50;
      for (const line of this.meta.headerRight) {
        this.text(line, W - M - this.width(line, 8.5), yy, { size: 8.5, color: C.dim }); yy -= 13;
      }
      this.y = H - 140;
    } else {
      p.drawRectangle({ x: 0, y: H - 36, width: W, height: 36, color: C.navy });
      p.drawRectangle({ x: 0, y: H - 36, width: W, height: 2, color: C.green });
      p.drawImage(this.logo, { x: M - 4, y: H - 33, width: 30, height: 30 });
      this.text(`GeoVivé  ·  ${this.meta.heading}`, M + 32, H - 22, { size: 10, font: this.b, color: C.white });
      const r = this.meta.short;
      this.text(r, W - M - this.width(r, 8), H - 22, { size: 8, color: C.dim });
      this.y = H - 62;
    }
  }

  ensure(h) { if (this.y - h < 62) this.newPage(); }

  h1(t) { this.ensure(40); this.y -= 6; this.text(t, M, this.y - 15, { size: 15, font: this.b }); this.y -= 26; }
  h2(t) { this.ensure(80); this.y -= 8; this.text(t, M, this.y - 11.5, { size: 11.5, font: this.b, color: C.blue }); this.y -= 20; }

  pill(kind, x, yTop) {
    const r = RESULT[kind]; const w = this.width(r.label, 7.5, this.b) + 12;
    this.page.drawRectangle({ x, y: yTop - 12, width: w, height: 12, color: r.bg });
    this.text(r.label, x + 6, yTop - 9, { size: 7.5, font: this.b, color: r.fg });
  }

  // Key/value grid (label over value), n columns
  kv(rows, cols = 3) {
    const cw = (W - 2 * M) / cols;
    for (let i = 0; i < rows.length; i += cols) {
      const slice = rows.slice(i, i + cols);
      const heights = slice.map(([, v]) => this.wrap(v, 10, cw - 10, this.b).length * 13);
      const h = 12 + Math.max(...heights) + 8;
      this.ensure(h);
      slice.forEach(([k, v], j) => {
        const x = M + j * cw;
        this.text(String(k).toUpperCase(), x, this.y - 8, { size: 7.5, color: C.muted });
        this.wrap(v, 10, cw - 10, this.b).forEach((l, n) => this.text(l, x, this.y - 22 - n * 13, { size: 10, font: this.b }));
      });
      this.y -= h;
    }
  }

  // Table: columns [{ title, width, mono?, bold?, pill? }], rows of cell values
  table(columns, rows, { headBg = C.slate, size = 8.3, rowBg } = {}) {
    const pad = 5, leading = size * 1.3;
    const head = () => {
      this.ensure(20 + leading * 2);
      this.page.drawRectangle({ x: M, y: this.y - 18, width: W - 2 * M, height: 18, color: headBg });
      let x = M;
      for (const c of columns) { this.text(c.title, x + pad, this.y - 12.5, { size: 8, font: this.b, color: C.white }); x += c.width; }
      this.y -= 18;
    };
    head();
    rows.forEach((row, r) => {
      const cells = columns.map((c, i) => c.pill ? null : this.wrap(row[i], c.mono ? size - 0.5 : size, c.width - 2 * pad, c.mono ? this.mono : c.bold ? this.b : this.f));
      const h = Math.max(16, ...cells.map(l => (l ? l.length * leading : 0) + 2 * pad - 2));
      if (this.y - h < 62) { this.newPage(); head(); }
      const bg = rowBg?.(r) || (r % 2 ? C.panel : null);
      if (bg) this.page.drawRectangle({ x: M, y: this.y - h, width: W - 2 * M, height: h, color: bg });
      let x = M;
      columns.forEach((c, i) => {
        if (c.pill) this.pill(row[i], x + pad, this.y - pad + 1);
        else cells[i].forEach((l, n) => this.text(l, x + pad, this.y - pad - size + 1 - n * leading,
          { size: c.mono ? size - 0.5 : size, font: c.mono ? this.mono : c.bold ? this.b : this.f }));
        x += c.width;
      });
      this.y -= h;
      this.page.drawLine({ start: { x: M, y: this.y }, end: { x: W - M, y: this.y }, thickness: 0.4, color: C.line });
    });
    this.y -= 6;
  }

  // Colored callout box with a bold title and body text
  callout({ title, body, fg, bg, bar = fg }) {
    const w = W - 2 * M - 24;
    const lines = this.wrap(body, 9.5, w);
    const h = 16 + 18 + lines.length * 13 + 10;
    this.ensure(h + 6);
    this.page.drawRectangle({ x: M, y: this.y - h, width: W - 2 * M, height: h, color: bg });
    this.page.drawRectangle({ x: M, y: this.y - h, width: 4, height: h, color: bar });
    this.text(title, M + 14, this.y - 24, { size: 15, font: this.b, color: fg });
    lines.forEach((l, i) => this.text(l, M + 14, this.y - 44 - i * 13));
    this.y -= h + 12;
  }

  button({ title, body, label, url, note }) {
    const bw = 150, w = W - 2 * M - bw - 24;
    const lines = this.wrap(body, 9.5, w);
    const top = 14 + 14 + lines.length * 13 + 8;
    const noteLines = note ? this.wrap(note, 8, W - 2 * M - 20) : [];
    const h = top + (noteLines.length ? noteLines.length * 11 + 12 : 0);
    this.ensure(h + 8);
    const y0 = this.y;
    this.page.drawRectangle({ x: M, y: y0 - h, width: W - 2 * M, height: h, borderColor: C.blue, borderWidth: 0.8 });
    this.page.drawRectangle({ x: W - M - bw, y: y0 - top, width: bw, height: top, color: C.blue });
    this.text(title, M + 12, y0 - 20, { size: 10, font: this.b });
    lines.forEach((l, i) => this.text(l, M + 12, y0 - 36 - i * 13));
    const lw = this.width(label, 11, this.b);
    this.text(label, W - M - bw / 2 - lw / 2, y0 - top / 2 - 4, { size: 11, font: this.b, color: C.white });
    if (url) this.link(W - M - bw, y0 - top, bw, top, url);
    if (noteLines.length) {
      this.page.drawLine({ start: { x: M, y: y0 - top }, end: { x: W - M, y: y0 - top }, thickness: 0.4, color: C.line });
      noteLines.forEach((l, i) => this.text(l, M + 12, y0 - top - 14 - i * 11, { size: 8, color: C.muted }));
    }
    this.y -= h + 12;
  }

  link(x, y, w, h, url) {
    const annot = this.pdf.context.obj({
      Type: "Annot", Subtype: "Link", Rect: [x, y, x + w, y + h], Border: [0, 0, 0],
      A: { Type: "Action", S: "URI", URI: PDFString.of(url) }
    });
    const ref = this.pdf.context.register(annot);
    const annots = this.page.node.lookup(PDFName.of("Annots"));
    if (annots) annots.push(ref); else this.page.node.set(PDFName.of("Annots"), this.pdf.context.obj([ref]));
  }

  timeline(stages) {
    const cw = (W - 2 * M) / stages.length, h = 50;
    this.ensure(h + 8);
    this.page.drawRectangle({ x: M, y: this.y - h, width: W - 2 * M, height: h, color: C.panel });
    stages.forEach(([name, when, st], i) => {
      const cx = M + cw * i + cw / 2;
      const col = st === "done" ? C.green : st === "now" ? C.blue : st === "bad" ? C.red : C.dim;
      if (st === "todo") this.page.drawCircle({ x: cx, y: this.y - 13, size: 5, borderColor: col, borderWidth: 1.2 });
      else this.page.drawCircle({ x: cx, y: this.y - 13, size: 5, color: col });
      this.text(name, cx - this.width(name, 8, this.b) / 2, this.y - 30, { size: 8, font: this.b });
      this.text(when, cx - this.width(when, 7.5) / 2, this.y - 41, { size: 7.5, color: C.muted });
    });
    this.y -= h + 8;
  }

  bullets(items, { numbered = false } = {}) {
    items.forEach((t, i) => {
      const lead = numbered ? `${i + 1}.` : "•";
      const lines = this.wrap(t, 9.5, W - 2 * M - 16);
      this.ensure(lines.length * 13 + 4);
      this.text(lead, M, this.y - 9.5, { size: 9.5, font: numbered ? this.b : this.f });
      lines.forEach((l, n) => this.text(l, M + 16, this.y - 9.5 - n * 13));
      this.y -= lines.length * 13 + 4;
    });
  }

  async finish(footerNote) {
    const n = this.pages.length;
    this.pages.forEach((p, i) => {
      this.page = p;
      p.drawLine({ start: { x: M, y: 44 }, end: { x: W - M, y: 44 }, thickness: 0.5, color: C.line });
      this.text("GeoVivé · geovive.link · " + footerNote, M, 31, { size: 7.5, color: C.muted });
      const pg = `Page ${i + 1} of ${n}`;
      this.text(pg, W - M - this.width(pg, 7.5), 31, { size: 7.5, color: C.muted });
    });
    return Buffer.from(await this.pdf.save());
  }
}

// ------------------------------------------------------------------ validation report

// app: the app record; checks: runChecks() result; ctx: { reportId, termsVersion, paymentUrl, fee, previewUrl, status }
export async function validationReportPdf(app, checks, ctx) {
  const d = await Doc.create({
    title: `AppConnect Validation Report — ${app.name}`, heading: "AppConnect Validation Report",
    headerRight: [`Report ${ctx.reportId}`, fmtDate(checks.at, true), ctx.termsVersion],
    short: `${app.name}  ·  ${ctx.reportId}`
  });
  d.newPage(true);

  const n = checks.layers.length;
  const noteCount = checks.checks.filter(c => c.result === "note").length + checks.layers.filter(l => l.result === "note").length;
  const failed = checks.checks.filter(c => c.result === "fail");
  const failedLayers = checks.layers.filter(l => l.result === "fail");
  if (ctx.mode === "layers") {
    const o = ctx.outcome;
    d.callout({ title: "Layer update checked", fg: o.rejected.length ? C.amber : C.green, bg: o.rejected.length ? C.amberSoft : C.greenSoft,
      body: `${o.approved.length} approved and showing, ${o.review.length} waiting for a GeoVivé reviewer (up to 5 business days), ${o.rejected.length} not approved. Earlier approved versions keep showing until a change is approved.` });
  } else if (checks.passed) {
    d.callout({ title: "All required checks passed", fg: C.green, bg: C.greenSoft,
      body: `${app.name} is ready to connect. ${n} of ${n} layers validated${noteCount ? `, with ${noteCount} note${noteCount > 1 ? "s" : ""} worth fixing (they don't block the connection)` : ""}. ` +
        (ctx.paymentUrl ? "Complete payment to start your one-year term." : "Your connection will be approved shortly.") });
  } else {
    d.callout({ title: "Some checks need attention", fg: C.red, bg: C.redSoft,
      body: `${failed.length + failedLayers.length} item${failed.length + failedLayers.length > 1 ? "s" : ""} must be fixed before ${app.name} can connect. ` +
        "Fix them, then choose “Run checks again” on your AppConnect page. There's nothing to pay until every required check passes." });
  }

  d.h2("Connection");
  const direct = checks.layers.filter(l => l.delivery === "direct").length;
  d.kv([
    ["App", app.name], ["App ID", app.appId], ["Verified domain", app.domain],
    ["Contact", app.contactEmail || "—"], ["Layers", n ? `${n} (${n - direct} relay, ${direct} direct)` : "—"],
    ["Stage", ctx.statusLabel]
  ]);

  if (checks.passed && ctx.paymentUrl) {
    d.button({
      title: "Next step: complete payment",
      body: `Accept the ${ctx.termsVersion} and pay the yearly connection fee (${ctx.fee}). Your app goes live as soon as payment clears, and you'll get a “Your connection is live” notice.`,
      label: "Pay & connect  ›", url: ctx.paymentUrl,
      note: `Payment link: ${ctx.paymentUrl}   ·   Promo codes are applied at checkout.`
    });
  }

  d.h2("Checks at a glance");
  d.table([
    { title: "Check", width: 125, bold: true }, { title: "Result", width: 55, pill: true }, { title: "Details", width: W - 2 * M - 180 }
  ], checks.checks.map(c => [c.name, c.result, c.detail]));

  if (checks.layers.length) {
    d.newPage();
    d.h1("Layer results");
    d.para("Each source was fetched from GeoVivé's servers from a public address. Feature counts are shapes with a label after simplification; time is the full fetch.", { size: 8, color: C.muted });
    const rowBg = r => ({ note: C.amberSoft, review: C.blueSoft, fail: C.redSoft })[checks.layers[r].result];
    d.table([
      { title: "Layer ID", width: 82, mono: true }, { title: "Name", width: 118 }, { title: "Group", width: 80 },
      { title: "Source", width: 48 }, { title: "Delivery", width: 48 }, { title: "Features", width: 48 },
      { title: "Time", width: 40 }, { title: "Result", width: W - 2 * M - 464, pill: true }
    ], checks.layers.map(l => [l.id, l.name, l.group || "", { arcgis: "ArcGIS", wfs: "WFS", geojson: "GeoJSON" }[l.type] || l.type,
      l.delivery === "direct" ? "Direct" : "Relay", l.features != null ? l.features.toLocaleString("en-US") : "—",
      `${(l.ms / 1000).toFixed(1)} s`, l.result]), { rowBg });

    const issues = checks.layers.filter(l => l.issues.length);
    if (issues.length) {
      d.h2("What to fix");
      d.table([
        { title: "Layer", width: 90, mono: true }, { title: "Result", width: 55, pill: true }, { title: "Issue", width: W - 2 * M - 145 }
      ], issues.map(l => [l.id, l.result, l.issues.join(" · ")]), { headBg: C.amber });
    }
  }

  d.ensure(260);
  if (ctx.previewUrl && checks.passed) {
    d.h2("Preview");
    d.para(`See your layers exactly as your users will, in the AppConnect section of the Layers panel: ${ctx.previewUrl}`, { color: C.blue });
  }

  if (ctx.mode === "layers") {
    d.h2("What happens next");
    d.bullets([
      "Approved layers are showing now in the AppConnect section for your users.",
      "Layers marked REVIEW are shown after a GeoVivé reviewer approves them, within 5 business days. You'll get an email either way.",
      "Layers marked FAIL aren't shown. Fix the issues listed above and republish your layer list; the change is checked automatically.",
      "Until a change is approved, the previously approved version of that layer keeps showing."
    ], { numbered: true });
    d.para("Terms: geovive.link/docs/terms/appconnect  ·  Requirements: geovive.link/docs/developers/appconnect", { size: 8, color: C.blue });
    return d.finish("This report reflects checks at the time shown. Your app's data remains yours.");
  }

  d.h2("Where your connection stands");
  const s = ctx.status;
  d.timeline([
    ["Registered", fmtShort(app.createdAt), "done"],
    ["Domain verified", checks.checks[0]?.result === "pass" ? fmtShort(checks.at) : "Pending", checks.checks[0]?.result === "pass" ? "done" : "bad"],
    ["Checks", checks.passed ? "Passed" : "Needs fixes", checks.passed ? "done" : "bad"],
    ["Payment", s === "live" ? "Paid" : checks.passed ? "Pending" : "—", s === "live" ? "done" : checks.passed ? "now" : "todo"],
    ["Live", s === "live" ? fmtShort(app.termStartsAt) : "—", s === "live" ? "done" : "todo"],
    ["Renewal due", app.termEndsAt ? fmtShort(app.termEndsAt) : "1 year after live", "todo"]
  ]);

  d.h2("What happens next");
  d.bullets(checks.passed ? [
    ctx.paymentUrl ? "Pay and accept the terms using the link on page 1. Promo codes are applied at checkout." : "GeoVivé approves your connection.",
    "Your connection goes live as soon as payment clears. We email a “Your connection is live” notice with your term dates.",
    `Add “Open in GeoVivé” links to your site, for example https://geovive.link/open?app=${app.appId}&layers=<layerId>`,
    "We keep checking. When your layer list changes, and on a schedule, we re-run these checks. If something breaks you get a new report and your app moves to sandbox until it's fixed.",
    "Renew yearly. We remind you 30 and 7 days before your term ends. Renewal is a payment plus acceptance of the current terms."
  ] : [
    "Fix each item marked FAIL above. Notes are optional.",
    "Open your AppConnect page and choose “Run checks again”. You'll get a new report.",
    "When every required check passes, the report includes your payment link."
  ], { numbered: true });

  d.h2("Your data and these terms");
  d.bullets([
    "You keep all rights to your data. GeoVivé displays it only to your users, only inside GeoVivé.",
    "Relay layers are cached for display for no more than 7 days; direct layers are never copied.",
    "GeoVivé doesn't sell, list, export or train on your data, and deletes cached copies within 7 days of the connection ending.",
    "You confirm you have the right to show each source as your layer list describes, with accurate credits.",
    "The connection runs for one year from going live and renews with payment and the current terms."
  ]);
  d.para("Full terms: geovive.link/docs/terms/appconnect  ·  Requirements: geovive.link/docs/developers/appconnect", { size: 8, color: C.blue });

  d.h2("Report details");
  d.table([{ title: "Item", width: 150 }, { title: "Value", width: W - 2 * M - 150 }], [
    ["Report ID", ctx.reportId], ["Generated", fmtDate(checks.at, true)], ["Layer list checked", app.layersUrl || "—"],
    ["Terms version", ctx.termsVersion], ["Checks version", checks.version]
  ]);

  return d.finish("This report reflects checks at the time shown. Your app's data remains yours.");
}

function fmtShort(iso) {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

// ------------------------------------------------------------------ live notice

// payment: { amount, currency, promo, sessionId }
export async function liveNoticePdf(app, ctx) {
  const d = await Doc.create({
    title: `Your AppConnect connection is live — ${app.name}`, heading: "Your connection is live",
    headerRight: [`Notice ${ctx.noticeId}`, fmtDate(ctx.at, true), ctx.termsVersion],
    short: `${app.name}  ·  ${ctx.noticeId}`
  });
  d.newPage(true);
  d.callout({ title: `${app.name} is live on GeoVivé`, fg: C.green, bg: C.greenSoft,
    body: `Your AppConnect connection is active until ${fmtDate(app.termEndsAt)}. Links from ${app.domain} now open GeoVivé with your layers in the AppConnect section.` });

  d.h2("Connection");
  d.kv([
    ["App", app.name], ["App ID", app.appId], ["Verified domain", app.domain],
    ["Term starts", fmtDate(app.termStartsAt)], ["Term ends", fmtDate(app.termEndsAt)], ["Terms accepted", ctx.termsVersion]
  ]);

  d.h2("Payment");
  d.table([{ title: "Item", width: 150 }, { title: "Value", width: W - 2 * M - 150 }], [
    ["Description", "GeoVivé AppConnect — yearly connection"],
    ["Amount paid", ctx.payment.amount],
    ["Promotion", ctx.payment.promo || "None"],
    ["Payment reference", ctx.payment.sessionId || "—"]
  ]);

  d.h2("Start linking");
  d.para("Send your users to GeoVivé with your layers turned on. Add focus= to zoom to one feature:");
  d.para(`https://geovive.link/open?app=${app.appId}&layers=<layerId>,<layerId>&focus=<layerId>:<label>&return=https://${app.domain}/`, { size: 8.5, font: d.mono, color: C.blue });
  d.bullets([
    "Change your layer list any time; GeoVivé picks up the change and re-checks it.",
    "If a re-check fails, we email a new report and your app moves to sandbox until it's fixed.",
    `We'll remind you 30 and 7 days before ${fmtDate(app.termEndsAt)}. Renewing adds a year to your current end date.`
  ]);
  d.para("Terms: geovive.link/docs/terms/appconnect  ·  Docs: geovive.link/docs/developers/appconnect", { size: 8, color: C.blue });
  return d.finish("Keep this notice for your records.");
}

// ------------------------------------------------------------------ offboarding certificate

// ctx: { certId, at, by, reason, termsVersion, purgeAt, deleted: { relayFiles, approvedLayers, pendingFiles }, kept: [..] }
export async function offboardingCertificatePdf(app, ctx) {
  const d = await Doc.create({
    title: `AppConnect disconnection certificate — ${app.name}`, heading: "Disconnection certificate",
    headerRight: [`Certificate ${ctx.certId}`, fmtDate(ctx.at, true), ctx.termsVersion],
    short: `${app.name}  ·  ${ctx.certId}`
  });
  d.newPage(true);
  d.callout({ title: `${app.name} is disconnected from GeoVivé`, fg: C.blue, bg: C.blueSoft, bar: C.blue,
    body: `As of ${fmtDate(ctx.at, true)}, GeoVivé no longer shows ${app.name}'s layers, and the copies GeoVivé held for display have been deleted. This certificate records what was removed and what is kept, and why.` });

  d.h2("Connection");
  d.kv([
    ["App", app.name], ["App ID", app.appId], ["Verified domain", app.domain],
    ["Disconnected", fmtDate(ctx.at)], ["Requested by", ctx.by], ["Reason", ctx.reason || "Not given"]
  ]);

  d.h2("Removed now");
  d.table([{ title: "Item", width: 190 }, { title: "Result", width: 55, pill: true }, { title: "Details", width: W - 2 * M - 245 }], [
    ["Layers shown to users", "done", "Turned off. Links from your site open GeoVivé without your layers."],
    ["Approved layer copies", "done", `${ctx.deleted.approvedLayers} layer setting${ctx.deleted.approvedLayers === 1 ? "" : "s"} deleted`],
    ["Relay display copies", "done", `${ctx.deleted.relayFiles} cached file${ctx.deleted.relayFiles === 1 ? "" : "s"} deleted`],
    ["Layers waiting for review", "done", `${ctx.deleted.pendingFiles} file${ctx.deleted.pendingFiles === 1 ? "" : "s"} deleted`],
    ["Checks, re-checks and reminders", "done", "Stopped. No further emails except this one and the final closure notice."],
    ["Renewals", "done", "None. AppConnect never renews automatically; no further payments are due."]
  ]);

  d.h2("Kept, and for how long");
  d.table([{ title: "Item", width: 190 }, { title: "Until", width: 110 }, { title: "Why", width: W - 2 * M - 300 }], ctx.kept.map(k => [k.item, k.until, k.why]));

  d.h2("What changes for your users");
  d.bullets([
    "Maps your users made through your app belong to them and stay in their GeoVivé accounts. They can keep, export or delete them.",
    "Open links from your site still open GeoVivé, but without your layers or your pin types.",
    "Nothing on your own site or in your own data is changed by GeoVivé."
  ]);

  d.h2("Coming back");
  d.para(`Until ${fmtDate(ctx.purgeAt)} you can reconnect from your AppConnect page: the checks run again and a new yearly term starts after payment. After that date the record is closed; your app ID stays reserved for your account, and you can register it again as a new connection.`);
  d.para("Your app's settings and history are attached to the email as JSON.", { size: 8.5, color: C.muted });
  d.para("Terms: geovive.link/docs/terms/appconnect  ·  Security: geovive.link/docs/security  ·  Questions: admin@geovive.link", { size: 8, color: C.blue });
  return d.finish("Keep this certificate for your records.");
}
