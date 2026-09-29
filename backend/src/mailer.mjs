// mailer.mjs — AppConnect emails through Amazon SES, with an optional PDF attachment.

import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
import { randomBytes } from "node:crypto";

const ses = new SESv2Client({});
const FROM = process.env.MAIL_FROM || "GeoVivé AppConnect <appconnect@geovive.link>";

const b64 = s => Buffer.from(s, "utf8").toString("base64");
const wrap76 = s => s.replace(/.{1,76}/g, "$&\r\n").trimEnd();
const encHeader = s => (/^[\x20-\x7E]*$/.test(s) ? s : `=?UTF-8?B?${b64(s)}?=`);

// Build a MIME message (text + HTML alternative, plus attachment). Exported for tests.
export function buildMime({ to, subject, text, html, attachment, attachments }) {
  const files = [...(attachments || []), ...(attachment ? [attachment] : [])];
  const mixed = "mixed_" + randomBytes(8).toString("hex"), alt = "alt_" + randomBytes(8).toString("hex");
  const fromName = FROM.match(/^(.*)<(.+)>$/);
  const from = fromName ? `${encHeader(fromName[1].trim())} <${fromName[2]}>` : FROM;
  const lines = [
    `From: ${from}`, `To: ${to}`, `Subject: ${encHeader(subject)}`, "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${mixed}"`, "",
    `--${mixed}`, `Content-Type: multipart/alternative; boundary="${alt}"`, "",
    `--${alt}`, "Content-Type: text/plain; charset=UTF-8", "Content-Transfer-Encoding: base64", "", wrap76(b64(text)),
    `--${alt}`, "Content-Type: text/html; charset=UTF-8", "Content-Transfer-Encoding: base64", "", wrap76(b64(html)),
    `--${alt}--`
  ];
  for (const f of files) {
    lines.push(`--${mixed}`, `Content-Type: ${f.contentType || "application/pdf"}; name="${f.filename}"`,
      `Content-Disposition: attachment; filename="${f.filename}"`, "Content-Transfer-Encoding: base64", "",
      wrap76(Buffer.from(f.content).toString("base64")));
  }
  lines.push(`--${mixed}--`, "");
  return lines.join("\r\n");
}

export async function sendMail(msg) {
  const raw = buildMime(msg);
  const res = await ses.send(new SendEmailCommand({ Content: { Raw: { Data: Buffer.from(raw) } } }));
  return res.MessageId;
}

const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

// Simple branded HTML email: a heading, paragraphs, and an optional button.
export function emailHtml({ heading, paragraphs, button }) {
  const btn = button ? `<p style="margin:24px 0"><a href="${esc(button.url)}" style="background:#1d5c8f;color:#fff;text-decoration:none;padding:12px 20px;border-radius:6px;font-weight:bold;display:inline-block">${esc(button.label)}</a></p>` : "";
  return `<!doctype html><html><body style="margin:0;background:#f1f5f9;font-family:Helvetica,Arial,sans-serif;color:#111827">
<table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:24px 12px">
<table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;background:#fff;border-radius:8px;overflow:hidden">
<tr><td style="background:#020617;padding:18px 24px;border-bottom:3px solid #16a34a;color:#fff;font-size:20px;font-weight:bold">GeoVivé <span style="font-weight:normal;color:#cbd5e1;font-size:14px">AppConnect</span></td></tr>
<tr><td style="padding:24px"><h1 style="font-size:20px;margin:0 0 12px">${esc(heading)}</h1>
${paragraphs.map(p => `<p style="font-size:14px;line-height:1.5;margin:0 0 12px">${esc(p)}</p>`).join("")}${btn}
<p style="font-size:12px;color:#6b7280;margin-top:24px">GeoVivé · geovive.link · You're receiving this because this address is the contact for an AppConnect app.</p></td></tr>
</table></td></tr></table></body></html>`;
}
