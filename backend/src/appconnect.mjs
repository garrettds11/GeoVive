// appconnect.mjs — semi-self-service AppConnect signup, checks and payment.
//
//   POST /v1/appconnect/apps                          sign up an app (signed-in user becomes its owner)
//   GET  /v1/appconnect/apps                          the caller's apps
//   GET  /v1/appconnect/apps/{appId}                  one app: record, history, reports
//   POST /v1/appconnect/apps/{appId}/checks           run the connection checks (async worker)
//   GET  /v1/appconnect/apps/{appId}/reports/{id}     a short-lived link to a report PDF
//   POST /v1/appconnect/stripe/webhook                Stripe: payment completed -> start the yearly term
//
// The check worker (runAppChecks) verifies the domain, validates the layer list
// and sources, writes a PDF report to S3, emails it, and moves the app to
// checks_failed or awaiting_payment (with a Stripe payment link).

import { PutCommand, QueryCommand, UpdateCommand, DeleteCommand } from "@aws-sdk/lib-dynamodb";
import { PutObjectCommand, GetObjectCommand, ListObjectsV2Command, DeleteObjectsCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { randomBytes, createHmac, timingSafeEqual } from "node:crypto";
import { getAppRecord, setStatus, addEvent, listEvents, startTerm, isActive } from "./appstore.mjs";
import { runChecks, checkLayer, fetchLayerList } from "./appcheck.mjs";
import { aiReviewLayer } from "./aireview.mjs";
import { CATEGORIES, categoryOfIssue } from "./findings.mjs";
import { applyResults, changedLayers, changeKey, decide, signReview, verifyReview, businessDaysBetween, REVIEW_BUSINESS_DAYS } from "./approvals.mjs";
import { validationReportPdf, liveNoticePdf, offboardingCertificatePdf, fmtDate } from "./report.mjs";
import { sendMail, emailHtml } from "./mailer.mjs";

export const TERMS_VERSION = "AppConnect Terms v1.0";
const APPS_TABLE = process.env.APPS_TABLE;
const BUCKET = process.env.GEOMETRY_BUCKET;
const SITE = process.env.SITE_URL || "https://geovive.link";
const MAX_APPS_PER_OWNER = 5;
const CHECK_COOLDOWN_MS = 2 * 60 * 1000;

export const STATUS_LABELS = {
  registered: "Registered", verifying: "Checking", checks_failed: "Checks need fixes",
  checks_passed: "Checks passed", awaiting_payment: "Awaiting payment", sandbox: "Sandbox",
  live: "Live", expired: "Expired", suspended: "Suspended"
};

export class AppConnectError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// ------------------------------------------------------------------ settings

const secrets = new SecretsManagerClient({});
let stripeCfg;
export async function stripeSettings() {
  if (stripeCfg) return stripeCfg;
  const res = await secrets.send(new GetSecretValueCommand({ SecretId: process.env.STRIPE_SECRET_ID || "geovive/stripe" }));
  stripeCfg = JSON.parse(res.SecretString);
  return stripeCfg;
}
export function _setStripeSettings(v) { stripeCfg = v; }   // tests

// Reviewer settings: { reviewKey, reviewerEmail }
let reviewCfg;
export async function reviewSettings() {
  if (reviewCfg) return reviewCfg;
  const res = await secrets.send(new GetSecretValueCommand({ SecretId: process.env.APPCONNECT_SECRET_ID || "geovive/appconnect" }));
  reviewCfg = JSON.parse(res.SecretString);
  return reviewCfg;
}
export function _setReviewSettings(v) { reviewCfg = v; }   // tests
const API_BASE = process.env.API_BASE || "https://api.geovive.link";

// ------------------------------------------------------------------ validation

const HOST = /^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const EMAIL = /^[^\s@<>()",;]{1,64}@[a-z0-9.-]{1,253}\.[a-z]{2,63}$/i;
const onDomain = (host, domain) => host === domain || host.endsWith("." + domain);

export function validateSignup(body) {
  const bad = m => { throw new AppConnectError(400, m); };
  const str = (v, max) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : "");
  const appId = str(body.appId, 41).toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{2,40}$/.test(appId)) bad("App ID must be 3–41 lowercase letters, numbers or dashes");
  if (/^geovive/.test(appId)) bad("That app ID is reserved");
  const name = str(body.name, 80); if (!name) bad("App name is required");
  const domain = str(body.domain, 253).toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  if (!HOST.test(domain)) bad("Domain must be a host name like app.example.com");
  if (onDomain(domain, "geovive.link") || domain.endsWith("amplifyapp.com")) bad("That domain can't be registered");
  const contactEmail = str(body.contactEmail, 254);
  if (!EMAIL.test(contactEmail)) bad("A valid contact email is required");
  let layersUrl;
  try { layersUrl = new URL(str(body.layersUrl, 500)); } catch { bad("Layer list address must be a URL"); }
  if (layersUrl.protocol !== "https:" || !onDomain(layersUrl.hostname, domain)) bad(`Layer list must be an https address on ${domain}`);
  const returnOrigins = [...new Set((Array.isArray(body.returnOrigins) ? body.returnOrigins : []).slice(0, 10).map(o => {
    let u; try { u = new URL(String(o)); } catch { bad(`Return address ${o} isn't a URL`); }
    const local = u.protocol === "http:" && u.hostname === "localhost";
    if (!local && !(u.protocol === "https:" && onDomain(u.hostname, domain))) bad(`Return address ${u.origin} must be https on ${domain}`);
    return u.origin;
  }))];
  if (!returnOrigins.length) returnOrigins.push(`https://${domain}`);
  const featureTypes = (Array.isArray(body.featureTypes) ? body.featureTypes : []).slice(0, 20).map(t => ({
    key: str(t?.key, 40).toLowerCase().replace(/[^a-z0-9_-]/g, ""), label: str(t?.label, 40),
    color: /^#[0-9a-f]{6}$/i.test(t?.color) ? t.color : "#3b82f6"
  })).filter(t => t.key && t.label);
  if (body.acceptTerms !== true) bad("You must accept the AppConnect terms");
  return { appId, name, domain, contactEmail, layersUrl: layersUrl.toString(), returnOrigins, areaOrigins: returnOrigins, featureTypes };
}

// ------------------------------------------------------------------ views

function ownerView(app) {
  return {
    appId: app.appId, name: app.name, domain: app.domain, contactEmail: app.contactEmail, layersUrl: app.layersUrl,
    returnOrigins: app.returnOrigins, featureTypes: app.featureTypes, status: app.status,
    statusLabel: STATUS_LABELS[app.status] || app.status, active: isActive(app.status, app.termEndsAt),
    verification: { dnsName: `_geovive.${app.domain}`, dnsValue: `geovive-verify=${app.verifyToken}`,
      fileUrl: `https://${app.domain}/.well-known/geovive.txt`, fileContents: app.verifyToken },
    paymentUrl: app.status === "awaiting_payment" ? app.paymentUrl : undefined,
    termStartsAt: app.termStartsAt, termEndsAt: app.termEndsAt, termsVersion: app.termsVersion,
    lastReportId: app.lastReportId, lastCheckAt: app.lastCheckAt, createdAt: app.createdAt, updatedAt: app.updatedAt,
    disconnectAt: app.disconnectAt, disconnectedAt: app.disconnectedAt, closedAt: app.closedAt, purgeAt: app.purgeAt, disconnectReason: app.disconnectReason,
    layers: Object.entries(app.layerState || {}).map(([id, st]) => ({ id, state: st.state, at: st.at, findings: st.findings }))
  };
}

async function ownedApp(ddb, appId, caller) {
  const app = await getAppRecord(ddb, appId, { fresh: true });
  if (!app || app.ownerId !== caller.sub) throw new AppConnectError(404, "App not found");
  return app;
}

// ------------------------------------------------------------------ routes

export async function signup(ddb, caller, body) {
  const v = validateSignup(body);
  const mine = await ddb.send(new QueryCommand({
    TableName: APPS_TABLE, IndexName: "byOwner", KeyConditionExpression: "ownerId = :o",
    ExpressionAttributeValues: { ":o": caller.sub }, Select: "COUNT"
  }));
  if ((mine.Count || 0) >= MAX_APPS_PER_OWNER) throw new AppConnectError(429, `You can register up to ${MAX_APPS_PER_OWNER} apps`);
  const now = new Date().toISOString();
  const item = {
    ...v, sk: "APP", status: "registered", ownerId: caller.sub, verifyToken: randomBytes(16).toString("hex"),
    termsAcceptedAtSignup: TERMS_VERSION, createdAt: now, updatedAt: now
  };
  try {
    // A closed record stays reserved for its owner, who may register the same ID again
    await ddb.send(new PutCommand({ TableName: APPS_TABLE, Item: item,
      ConditionExpression: "attribute_not_exists(appId) OR (#s = :closed AND ownerId = :me)",
      ExpressionAttributeNames: { "#s": "status" }, ExpressionAttributeValues: { ":closed": "closed", ":me": caller.sub } }));
  } catch (e) {
    if (e.name === "ConditionalCheckFailedException") throw new AppConnectError(409, "That app ID is taken");
    throw e;
  }
  await addEvent(ddb, v.appId, { type: "status", from: "none", to: "registered", termsVersion: TERMS_VERSION });
  const view = ownerView(item);
  try {
    await sendMail({
      to: v.contactEmail, subject: `Verify ${v.domain} for GeoVivé AppConnect`,
      text: `Thanks for signing up ${v.name} for GeoVivé AppConnect.\n\nTo prove you control ${v.domain}, publish ONE of these:\n\n  DNS TXT record  ${view.verification.dnsName}  =  ${view.verification.dnsValue}\n  or a file at    ${view.verification.fileUrl}  containing  ${view.verification.fileContents}\n\nThen run the checks from your AppConnect page: ${SITE}/appconnect/?app=${v.appId}\n\nRequirements: ${SITE}/docs/developers/appconnect/`,
      html: emailHtml({ heading: `Verify ${v.domain}`, paragraphs: [
        `Thanks for signing up ${v.name} for GeoVivé AppConnect. To prove you control ${v.domain}, publish one of these:`,
        `DNS TXT record ${view.verification.dnsName} with the value ${view.verification.dnsValue}`,
        `or a file at ${view.verification.fileUrl} containing ${view.verification.fileContents}`,
        "Then run the checks from your AppConnect page. You'll get a PDF report with the results."
      ], button: { label: "Open AppConnect", url: `${SITE}/appconnect/?app=${v.appId}` } })
    });
  } catch (e) { console.error("Signup email failed", e); }
  return view;
}

export async function listMine(ddb, caller) {
  const res = await ddb.send(new QueryCommand({
    TableName: APPS_TABLE, IndexName: "byOwner", KeyConditionExpression: "ownerId = :o",
    ExpressionAttributeValues: { ":o": caller.sub }
  }));
  return { apps: (res.Items || []).filter(i => i.sk === "APP").map(ownerView) };
}

export async function getMine(ddb, caller, appId) {
  const app = await ownedApp(ddb, appId, caller);
  const events = await listEvents(ddb, appId, 50);
  return { ...ownerView(app), history: events.map(({ checks, ...e }) => e) };
}

export async function requestChecks(ddb, caller, appId, invokeWorker) {
  const app = await ownedApp(ddb, appId, caller);
  if (app.status === "suspended") throw new AppConnectError(409, "This app is suspended; contact GeoVivé");
  if (app.status === "verifying") throw new AppConnectError(409, "Checks are already running");
  if (app.lastCheckAt && Date.now() - Date.parse(app.lastCheckAt) < CHECK_COOLDOWN_MS) {
    throw new AppConnectError(429, "Checks ran moments ago; try again in a couple of minutes");
  }
  const reportId = newId("VR");
  // Active apps are re-checked without going offline; others move to "verifying".
  if (!isActive(app.status, app.termEndsAt)) await setStatus(ddb, appId, app.status, "verifying", { reportId });
  await invokeWorker({ appId, reportId });
  return { appId, reportId, status: isActive(app.status, app.termEndsAt) ? app.status : "verifying" };
}

export async function reportLink(ddb, s3, caller, appId, reportId) {
  await ownedApp(ddb, appId, caller);
  if (!/^(VR|LN|OB)-[A-Z0-9-]{6,40}$/.test(reportId)) throw new AppConnectError(400, "Invalid report ID");
  const url = await getSignedUrl(s3, new GetObjectCommand({
    Bucket: BUCKET, Key: `appconnect/${appId}/${reportId}.pdf`,
    ResponseContentDisposition: `inline; filename="${reportId}.pdf"`
  }), { expiresIn: 600 });
  return { url, expiresIn: 600 };
}

function newId(prefix) {
  const d = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  return `${prefix}-${d}-${randomBytes(3).toString("hex").toUpperCase()}`;
}

// ------------------------------------------------------------------ worker

export async function runAppChecks(ddb, s3, { appId, reportId }, net) {
  const app = await getAppRecord(ddb, appId, { fresh: true });
  if (!app) return;
  const wasActive = isActive(app.status, app.termEndsAt);
  let checks;
  try { checks = await runChecks(app, net); }
  catch (e) {
    console.error("Checks crashed", appId, e);
    checks = { at: new Date().toISOString(), version: "AppConnect checks 1.0", passed: false, layers: [], notes: [],
      checks: [{ key: "internal", name: "Checks", result: "fail", detail: "GeoVivé couldn't finish the checks. Try again shortly." }] };
  }

  let layerOutcome = { approved: [], review: [], rejected: [] };
  if (checks.list) {
    await assessRows(ddb, s3, app, checks.layers);
    layerOutcome = await applyResults(ddb, s3, app, checks.layers, checks.list);
    await ddb.send(new UpdateCommand({ TableName: APPS_TABLE, Key: { appId, sk: "APP" },
      UpdateExpression: "SET layerCheckKey = :k", ExpressionAttributeValues: { ":k": changeKey(checks.list.layers) } }));
    if (layerOutcome.review.length) await emailReviewer(ddb, app, checks.layers.filter(l => l.result === "review"));
  }

  const stripe = await stripeSettings();
  let status = app.status, paymentUrl;
  if (wasActive) {
    if (!checks.passed && app.status === "live") { await setStatus(ddb, appId, "live", "sandbox", { reportId, reason: "re-check failed" }); status = "sandbox"; }
    else if (checks.passed && app.status === "sandbox" && app.termEndsAt) { await setStatus(ddb, appId, "sandbox", "live", { reportId, reason: "re-check passed" }); status = "live"; }
  } else if (checks.passed) {
    await setStatus(ddb, appId, "verifying", "checks_passed", { reportId });
    const u = new URL(stripe.paymentLinkUrl);
    u.searchParams.set("client_reference_id", appId);
    u.searchParams.set("prefilled_email", app.contactEmail);
    paymentUrl = u.toString();
    await setStatus(ddb, appId, "checks_passed", "awaiting_payment", { reportId });
    status = "awaiting_payment";
  } else {
    await setStatus(ddb, appId, "verifying", "checks_failed", { reportId });
    status = "checks_failed";
  }

  const pdf = await validationReportPdf(app, checks, {
    reportId, termsVersion: TERMS_VERSION, paymentUrl, fee: stripe.feeDisplay, status, statusLabel: STATUS_LABELS[status],
    previewUrl: checks.passed ? `${SITE}/open?app=${appId}&layers=${checks.layers.slice(0, 3).map(l => l.id).join(",")}` : undefined
  });
  await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: `appconnect/${appId}/${reportId}.pdf`, Body: pdf, ContentType: "application/pdf" }));

  const summary = checks.checks.map(c => ({ key: c.key, result: c.result }));
  await ddb.send(new UpdateCommand({
    TableName: APPS_TABLE, Key: { appId, sk: "APP" },
    UpdateExpression: paymentUrl ? "SET lastReportId = :r, lastCheckAt = :t, lastChecksPassed = :p, paymentUrl = :u"
      : "SET lastReportId = :r, lastCheckAt = :t, lastChecksPassed = :p",
    ExpressionAttributeValues: { ":r": reportId, ":t": checks.at, ":p": checks.passed, ...(paymentUrl ? { ":u": paymentUrl } : {}) }
  }));
  await addEvent(ddb, appId, { type: "checks", reportId, passed: checks.passed, summary, layerOutcome,
    layers: checks.layers.length, failedLayers: checks.layers.filter(l => l.result === "fail").map(l => l.id) });

  const subject = checks.passed
    ? (wasActive ? `Re-check passed: ${app.name}` : `${app.name} passed AppConnect checks — complete payment to connect`)
    : `${app.name}: AppConnect checks need attention`;
  const paras = checks.passed
    ? [wasActive ? "Your app passed its scheduled re-check. Nothing to do." : `${app.name} passed every required check. Your validation report is attached.`,
       ...(paymentUrl ? [`Complete payment (${stripe.feeDisplay}) and accept the ${TERMS_VERSION} to start your one-year connection. Promo codes are applied at checkout.`] : [])]
    : ["Some checks failed. The attached report lists each problem and how to fix it.",
       ...(status === "sandbox" ? ["Your app has moved to sandbox until it passes again."] : []),
       "When you've fixed them, run the checks again from your AppConnect page."];
  try {
    await sendMail({
      to: app.contactEmail, subject,
      text: paras.join("\n\n") + (paymentUrl ? `\n\nPay and connect: ${paymentUrl}` : `\n\nAppConnect: ${SITE}/appconnect/?app=${appId}`),
      html: emailHtml({ heading: subject, paragraphs: paras,
        button: paymentUrl ? { label: "Pay & connect", url: paymentUrl } : { label: "Open AppConnect", url: `${SITE}/appconnect/?app=${appId}` } }),
      attachment: { filename: `${reportId}.pdf`, content: pdf }
    });
    await addEvent(ddb, appId, { type: "email", what: "validation report", reportId, to: app.contactEmail });
  } catch (e) { console.error("Report email failed", e); await addEvent(ddb, appId, { type: "email-failed", reportId, error: e.message }); }
  return { status, reportId, passed: checks.passed };
}

// ------------------------------------------------------------------ Stripe webhook

// Verify a Stripe-Signature header (t=...,v1=...) against the raw body.
export function verifyStripeSignature(raw, header, secret, toleranceSec = 300, now = Date.now()) {
  const parts = Object.fromEntries(String(header || "").split(",").map(p => p.split("=")).filter(p => p.length === 2)
    .map(([k, v]) => [k, v]));
  const sigs = String(header || "").split(",").filter(p => p.startsWith("v1=")).map(p => p.slice(3));
  const t = Number(parts.t);
  if (!t || !sigs.length) return false;
  if (Math.abs(now / 1000 - t) > toleranceSec) return false;
  const expected = createHmac("sha256", secret).update(`${t}.${raw}`).digest("hex");
  return sigs.some(s => s.length === expected.length && timingSafeEqual(Buffer.from(s), Buffer.from(expected)));
}

const money = (cents, cur) => new Intl.NumberFormat("en-US", { style: "currency", currency: (cur || "usd").toUpperCase() }).format((cents || 0) / 100);

export async function stripeWebhook(ddb, s3, raw, signature) {
  const stripe = await stripeSettings();
  if (!verifyStripeSignature(raw, signature, stripe.webhookSecret)) throw new AppConnectError(400, "Bad signature");
  const evt = JSON.parse(raw);
  if (!["checkout.session.completed", "checkout.session.async_payment_succeeded"].includes(evt.type)) return { ignored: evt.type };
  const s = evt.data.object;
  if (s.payment_link !== stripe.paymentLinkId) return { ignored: "not an AppConnect payment" };
  if (!["paid", "no_payment_required"].includes(s.payment_status)) return { ignored: `payment ${s.payment_status}` };
  const appId = s.client_reference_id;
  const app = appId && await getAppRecord(ddb, appId, { fresh: true });
  if (!app) { console.error("Payment for unknown app", appId, s.id); return { ignored: "unknown app" }; }

  // Idempotent: one term per checkout session
  const seen = await listEvents(ddb, appId, 100);
  if (seen.some(e => e.type === "payment" && e.sessionId === s.id)) return { duplicate: true };

  const discount = s.total_details?.amount_discount || 0;
  const amount = discount ? `${money(s.amount_total, s.currency)} (was ${money(s.amount_subtotal, s.currency)})` : money(s.amount_total, s.currency);
  const promo = discount ? (s.discounts?.map(d => d.promotion_code || d.coupon).filter(Boolean).join(", ") || "Promotion applied") : "";
  await addEvent(ddb, appId, { type: "payment", sessionId: s.id, amountTotal: s.amount_total, amountDiscount: discount,
    currency: s.currency, livemode: s.livemode, promo, email: s.customer_details?.email });

  const ends = await startTerm(ddb, appId, TERMS_VERSION, { sessionId: s.id });
  const fresh = await getAppRecord(ddb, appId, { fresh: true });
  if (fresh.status === "awaiting_payment" || fresh.status === "expired") {
    await setStatus(ddb, appId, fresh.status === "expired" ? "expired" : "awaiting_payment",
      fresh.status === "expired" ? "awaiting_payment" : "live", { sessionId: s.id });
    if (fresh.status === "expired") await setStatus(ddb, appId, "awaiting_payment", "live", { sessionId: s.id });
  }
  const app2 = await getAppRecord(ddb, appId, { fresh: true });

  const noticeId = newId("LN");
  const pdf = await liveNoticePdf(app2, { noticeId, at: new Date().toISOString(), termsVersion: TERMS_VERSION,
    payment: { amount, promo, sessionId: s.id } });
  await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: `appconnect/${appId}/${noticeId}.pdf`, Body: pdf, ContentType: "application/pdf" }));
  await addEvent(ddb, appId, { type: "notice", noticeId, termEndsAt: ends });
  try {
    await sendMail({
      to: app2.contactEmail, subject: `${app2.name} is live on GeoVivé`,
      text: `Your AppConnect connection is live until ${fmtDate(ends)}. Your notice is attached.\n\n${SITE}/appconnect/?app=${appId}`,
      html: emailHtml({ heading: `${app2.name} is live on GeoVivé`, paragraphs: [
        `Your AppConnect connection is active until ${fmtDate(ends)}.`,
        `Links from ${app2.domain} now open GeoVivé with your layers. Your “connection is live” notice is attached.`
      ], button: { label: "Open AppConnect", url: `${SITE}/appconnect/?app=${appId}` } }),
      attachment: { filename: `${noticeId}.pdf`, content: pdf }
    });
  } catch (e) { console.error("Live email failed", e); }
  return { appId, status: app2.status, termEndsAt: ends };
}

// ------------------------------------------------------------------ daily upkeep

const RECHECK_DAYS = 7;
const DAY = 86400_000;
const REMINDERS = [30, 7];

function renewalUrl(stripe, app) {
  const u = new URL(stripe.paymentLinkUrl);
  u.searchParams.set("client_reference_id", app.appId);
  u.searchParams.set("prefilled_email", app.contactEmail);
  return u.toString();
}

// Runs once a day (EventBridge schedule):
//   - re-checks sandbox/live apps whose last check is older than a week
//   - sends renewal reminders 30 and 7 days before the term ends (once per term)
//   - expires apps whose term has ended
export async function runDaily(ddb, { now = Date.now(), invokeWorker, net, s3 }) {
  const offboarding = s3 ? await runOffboarding(ddb, s3, { now }) : null;
  const stripe = await stripeSettings();
  const apps = [...await listByStatusSafe(ddb, "live"), ...await listByStatusSafe(ddb, "sandbox")].filter(a => a.ownerId);
  const done = { rechecks: [], reminders: [], expired: [], layerChanges: [], reviewReminders: [] };
  for (const app of apps) {
    const ends = app.termEndsAt ? Date.parse(app.termEndsAt) : null;

    if (ends && ends <= now) {
      await setStatus(ddb, app.appId, app.status, "expired", { reason: "term ended" });
      const url = renewalUrl(stripe, app);
      await safeMail(ddb, app.appId, "expiry notice", {
        to: app.contactEmail, subject: `${app.name}'s GeoVivé connection has expired`,
        text: `Your AppConnect term ended on ${fmtDate(app.termEndsAt)}, so your layers no longer show in GeoVivé.\n\nRenew to reconnect: ${url}`,
        html: emailHtml({ heading: "Your connection has expired", paragraphs: [
          `${app.name}'s AppConnect term ended on ${fmtDate(app.termEndsAt)}, so your layers no longer show in GeoVivé.`,
          `Renew (${stripe.feeDisplay}) to reconnect. Your app record is kept for 90 days, so you won't need to sign up again.`
        ], button: { label: "Renew now", url } })
      });
      done.expired.push(app.appId);
      continue;
    }

    if (ends) {
      const daysLeft = Math.ceil((ends - now) / DAY);
      for (const d of REMINDERS) {
        const flag = `reminded${d}`;
        if (daysLeft <= d && app[flag] !== app.termEndsAt && !(d === 30 && daysLeft <= 7)) {
          const url = renewalUrl(stripe, app);
          await safeMail(ddb, app.appId, `${d}-day renewal reminder`, {
            to: app.contactEmail, subject: `Renew ${app.name} on GeoVivé — ${daysLeft} day${daysLeft === 1 ? "" : "s"} left`,
            text: `Your AppConnect connection for ${app.name} ends on ${fmtDate(app.termEndsAt)}.\n\nRenew (${stripe.feeDisplay}) to keep your layers showing; renewing early adds a year to your current end date.\n\n${url}`,
            html: emailHtml({ heading: `${daysLeft} day${daysLeft === 1 ? "" : "s"} left on your connection`, paragraphs: [
              `Your AppConnect connection for ${app.name} ends on ${fmtDate(app.termEndsAt)}.`,
              `Renew (${stripe.feeDisplay}) and accept the current ${TERMS_VERSION} to keep your layers showing. Renewing early adds a year to your current end date.`
            ], button: { label: "Renew now", url } })
          });
          await ddb.send(new UpdateCommand({ TableName: APPS_TABLE, Key: { appId: app.appId, sk: "APP" },
            UpdateExpression: `SET ${flag} = :e`, ExpressionAttributeValues: { ":e": app.termEndsAt } }));
          if (d === 7) await ddb.send(new UpdateCommand({ TableName: APPS_TABLE, Key: { appId: app.appId, sk: "APP" },
            UpdateExpression: "SET reminded30 = :e", ExpressionAttributeValues: { ":e": app.termEndsAt } }));
          done.reminders.push(`${app.appId}:${d}`);
          break;
        }
      }
    }

    // New or changed layers on the app's site, even when nobody opened the map today
    if (net) {
      try {
        const list = await fetchLayerList(app, net);
        const d = await detectChanges(ddb, app, list, invokeWorker);
        if (d) done.layerChanges.push(app.appId);
      } catch (e) { console.warn("Daily list read failed", app.appId, e.message); }
    }

    if (!app.lastCheckAt || now - Date.parse(app.lastCheckAt) >= RECHECK_DAYS * DAY) {
      const reportId = newId("VR");
      await addEvent(ddb, app.appId, { type: "scheduled-check", reportId });
      await invokeWorker({ appId: app.appId, reportId });
      done.rechecks.push(app.appId);
    }
  }
  done.reviewReminders = await reviewReminders(ddb, apps.filter(a => !done.expired.includes(a.appId)), now);
  done.weeklyNotices = await sendWeeklyNotices(ddb, apps, new Date(now));
  if (offboarding) done.offboarding = offboarding;
  return done;
}

async function listByStatusSafe(ddb, status) {
  const res = await ddb.send(new QueryCommand({
    TableName: APPS_TABLE, IndexName: "byStatus", KeyConditionExpression: "#s = :s",
    ExpressionAttributeNames: { "#s": "status" }, ExpressionAttributeValues: { ":s": status }
  }));
  return (res.Items || []).filter(i => i.sk === "APP");
}

async function safeMail(ddb, appId, what, msg) {
  try { await sendMail(msg); await addEvent(ddb, appId, { type: "email", what, to: msg.to }); }
  catch (e) { console.error("Email failed", appId, what, e); await addEvent(ddb, appId, { type: "email-failed", what, error: e.message }); }
}


// ------------------------------------------------------------------ layer changes and review

// Called when an app's live list is read: queue checks for new or changed layers (once per change).
export async function detectChanges(ddb, app, list, invokeWorker) {
  const changed = changedLayers(app, list);
  if (!changed.length) return null;
  const key = changeKey(changed);
  if (app.layerCheckKey === key) return null;
  try {
    await ddb.send(new UpdateCommand({ TableName: APPS_TABLE, Key: { appId: app.appId, sk: "APP" },
      UpdateExpression: "SET layerCheckKey = :k", ConditionExpression: "attribute_not_exists(layerCheckKey) OR layerCheckKey <> :k",
      ExpressionAttributeValues: { ":k": key } }));
  } catch (e) { if (e.name === "ConditionalCheckFailedException") return null; throw e; }
  const reportId = newId("VR");
  await addEvent(ddb, app.appId, { type: "layer-change", reportId, layers: changed.map(l => l.id) });
  await invokeWorker({ appId: app.appId, reportId, mode: "layers" });
  return { reportId, layers: changed.map(l => l.id) };
}

// Worker: check only the new or changed layers, approve / send to review / reject, report to the owner.
export async function runLayerReview(ddb, s3, { appId, reportId }, net) {
  const app = await getAppRecord(ddb, appId, { fresh: true });
  if (!app) return;
  let list;
  try { list = await fetchLayerList(app, net); }
  catch (e) { await addEvent(ddb, appId, { type: "layer-review-skipped", reportId, error: e.message }); return { skipped: e.message }; }
  const changed = changedLayers(app, list);
  if (!changed.length) return { nothing: true };
  const rows = [];
  for (const l of changed) rows.push(await checkLayer(l, l, net));
  await assessRows(ddb, s3, app, rows);
  const outcome = await applyResults(ddb, s3, app, rows, list);
  if (outcome.review.length) await emailReviewer(ddb, app, rows.filter(r => r.result === "review"));

  const at = new Date().toISOString();
  const checks = { at, version: "AppConnect checks 1.0", passed: !outcome.rejected.length, layers: rows, notes: [], checks: [
    { key: "approved", name: "Approved", result: "pass", detail: outcome.approved.length ? `Now showing: ${outcome.approved.join(", ")}` : "None in this update" },
    { key: "review", name: "Human review", result: outcome.review.length ? "note" : "pass",
      detail: outcome.review.length ? `Waiting for a GeoVivé reviewer (up to ${REVIEW_BUSINESS_DAYS} business days): ${outcome.review.join(", ")}` : "None needed" },
    { key: "rejected", name: "Not approved", result: outcome.rejected.length ? "fail" : "pass",
      detail: outcome.rejected.length ? `Fix and republish: ${outcome.rejected.join(", ")}. Earlier approved versions keep showing.` : "None" }
  ] };
  const pdf = await validationReportPdf(app, checks, { reportId, termsVersion: TERMS_VERSION, status: app.status,
    statusLabel: STATUS_LABELS[app.status], mode: "layers", outcome });
  await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: `appconnect/${appId}/${reportId}.pdf`, Body: pdf, ContentType: "application/pdf" }));
  await ddb.send(new UpdateCommand({ TableName: APPS_TABLE, Key: { appId, sk: "APP" },
    UpdateExpression: "SET lastReportId = :r", ExpressionAttributeValues: { ":r": reportId } }));
  await addEvent(ddb, appId, { type: "layer-review", reportId, ...outcome });
  const paras = [
    `GeoVivé checked ${rows.length} new or changed layer${rows.length > 1 ? "s" : ""} from ${app.name}.`,
    outcome.approved.length ? `Approved and now showing: ${outcome.approved.join(", ")}.` : "",
    outcome.review.length ? `Waiting for a GeoVivé reviewer, up to ${REVIEW_BUSINESS_DAYS} business days: ${outcome.review.join(", ")}. Earlier approved versions keep showing meanwhile.` : "",
    outcome.rejected.length ? `Not approved: ${outcome.rejected.join(", ")}. The attached report says why; fix them and republish your list.` : ""
  ].filter(Boolean);
  try {
    await sendMail({ to: app.contactEmail, subject: `Layer update for ${app.name}: ${outcome.approved.length} approved, ${outcome.review.length} in review, ${outcome.rejected.length} not approved`,
      text: paras.join("\n\n"), html: emailHtml({ heading: "Your layer update was checked", paragraphs: paras,
        button: { label: "Open AppConnect", url: `${SITE}/appconnect/?app=${appId}` } }),
      attachment: { filename: `${reportId}.pdf`, content: pdf } });
  } catch (e) { console.error("Layer review email failed", e); }
  return outcome;
}

async function reviewLink(app, row, exp) {
  const { reviewKey } = await reviewSettings();
  const q = { appId: app.appId, layerId: row.id, hash: row.hash, exp: String(exp) };
  q.sig = signReview(reviewKey, q);
  return `${API_BASE}/v1/appconnect/review?${new URLSearchParams(q)}`;
}

export async function emailReviewer(ddb, app, rows, { reminder = false } = {}) {
  const { reviewerEmail } = await reviewSettings();
  const exp = Math.floor(Date.now() / 1000) + 30 * 86400;
  const items = [];
  for (const r of rows) items.push({ r, url: await reviewLink(app, r, exp) });
  const retained = rows.some(r => r.retained);
  const heading = `${retained ? "GeoVivé-only finding — " : ""}${reminder ? "Reminder: " : ""}${rows.length} layer${rows.length > 1 ? "s" : ""} from ${app.name} need${rows.length > 1 ? "" : "s"} review`;
  const html = emailHtml({ heading,
    paragraphs: [`App ${app.appId} (${app.domain}), contact ${app.contactEmail}. The owner was told review takes up to ${REVIEW_BUSINESS_DAYS} business days.`,
      ...items.map(({ r }) => `${r.id} — ${r.name}: ${r.issues.join("; ")}`)],
    button: items.length === 1 ? { label: "Review layer", url: items[0].url } : undefined })
    .replace("</h1>", `</h1>${items.length > 1 ? items.map(({ r, url }) => `<p><a href="${url}">Review ${r.id}</a></p>`).join("") : ""}`);
  try {
    await sendMail({ to: reviewerEmail, subject: `${retained ? "[Restricted] " : ""}${reminder ? "Reminder: " : ""}AppConnect review needed — ${app.name} (${rows.length})`,
      text: items.map(({ r, url }) => `${r.id} (${r.name}): ${r.issues.join("; ")}\nReview: ${url}`).join("\n\n"), html });
    await addEvent(ddb, app.appId, { type: "email", what: reminder ? "review reminder" : "review request", to: "reviewer", layers: rows.map(r => r.id) });
  } catch (e) { console.error("Reviewer email failed", e); }
}

const page = (title, body) => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escHtml(title)}</title>
<style>body{font-family:system-ui,sans-serif;background:#020617;color:#e5e7eb;max-width:720px;margin:40px auto;padding:0 16px}h1{font-size:20px}
.card{border:1px solid #1f2937;border-radius:8px;padding:14px;margin:12px 0}button{font:inherit;padding:9px 14px;border-radius:6px;border:0;margin-right:8px;cursor:pointer}
.ok{background:#22c55e;color:#02130a}.no{background:#ef4444;color:#fff}code{background:#0f172a;padding:1px 4px;border-radius:4px}li{margin:4px 0}</style></head><body>${body}</body></html>`;
function escHtml(s) { return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]); }

// GET: show the pending layer and its findings with Approve / Reject buttons.
export async function reviewPage(ddb, s3, q) {
  const { reviewKey } = await reviewSettings();
  if (!verifyReview(reviewKey, q)) return page("Link expired", "<h1>This review link is invalid or expired</h1>");
  const app = await getAppRecord(ddb, q.appId, { fresh: true });
  const st = app?.layerState?.[q.layerId];
  if (!st || st.hash !== q.hash || st.state !== "review") return page("Already decided", `<h1>Nothing to review</h1><p>This layer version is ${escHtml(st?.state || "no longer listed")}.</p>`);
  const res = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: `appconnect-pending/${q.appId}/${q.layerId}-${q.hash}.json` }));
  const pending = JSON.parse(await res.Body.transformToString());
  const L = pending.layer;
  const hidden = ["appId", "layerId", "hash", "exp", "sig"].map(k => `<input type="hidden" name="${k}" value="${escHtml(q[k])}">`).join("");
  return page(`Review ${q.layerId}`, `<h1>Review layer <code>${escHtml(q.layerId)}</code> from ${escHtml(app.name)}</h1>
<div class="card"><p><strong>${escHtml(L.name)}</strong> · ${escHtml(L.group || "")}</p><p>${escHtml(L.description || "")}</p>
<ul><li>Source: <code>${escHtml(L.source.url)}</code> (${escHtml(L.source.type)}, ${escHtml(L.delivery)})</li><li>Label: <code>${escHtml(L.label)}</code></li>
<li>Shown fields: ${escHtml(Object.entries(L.fields || {}).map(([k, v]) => `${k} → ${v}`).join(", ") || "none")}</li>
<li>Attribution: ${escHtml(L.attribution)} · License: ${escHtml(L.license)}</li><li>Shapes: ${escHtml(pending.features)}</li></ul></div>
${pending.retained ? `<div class="card" style="border-color:#ef4444"><strong>GeoVivé-only finding.</strong> The owner has only been told this layer is held for review. Evidence is preserved in the restricted evidence store for possible escalation.</div>` : ""}
<div class="card"><strong>Findings</strong><ul>${pending.findings.map(f => `<li>${escHtml(f)}</li>`).join("")}
${(pending.retainedFindings || []).map(f => `<li style="color:#fca5a5">GeoVivé-only · ${escHtml(CATEGORIES[f.category]?.label || f.category)} (${escHtml(f.severity)}, ${escHtml(f.confidence)}): ${escHtml(f.reason)} ${f.evidence ? `“${escHtml(f.evidence)}”` : ""}</li>`).join("")}
${(pending.aiFindings || []).map(f => `<li>AI · ${escHtml(CATEGORIES[f.category]?.label || f.category)} (${escHtml(f.severity)}, ${escHtml(f.confidence)}): ${escHtml(f.reason)} ${f.field ? `[${escHtml(f.field)}]` : ""} ${f.evidence ? `“${escHtml(f.evidence)}”` : ""}</li>`).join("")}</ul></div>
<div class="card"><strong>Sample values</strong> (as users would see them; up to 25 features)
<table style="width:100%;border-collapse:collapse;font-size:13px;margin-top:8px">${(pending.samples || []).map(p => `<tr>${Object.entries(p || {}).map(([k, v]) => `<td style="border-top:1px solid #1f2937;padding:4px;vertical-align:top"><span style="color:#9ca3af">${escHtml(k === "_label" ? "label" : k)}</span><br>${escHtml(v)}</td>`).join("")}</tr>`).join("")}</table></div>
<p>App ${escHtml(app.appId)} · ${escHtml(app.domain)} · contact ${escHtml(app.contactEmail)} · waiting ${businessDaysBetween(st.at)} business day(s)</p>
<form method="post" action="${API_BASE}/v1/appconnect/review">${hidden}
<button class="ok" name="decision" value="approve">Approve and show</button><button class="no" name="decision" value="reject">Reject</button></form>`);
}

// POST: record the decision and tell the owner.
export async function reviewDecision(ddb, s3, form) {
  const { reviewKey } = await reviewSettings();
  if (!verifyReview(reviewKey, form) || !["approve", "reject"].includes(form.decision)) return page("Invalid", "<h1>This review link is invalid or expired</h1>");
  const app = await getAppRecord(ddb, form.appId, { fresh: true });
  const r = await decide(ddb, s3, app, form.layerId, form.hash, form.decision, "GeoVivé reviewer");
  if (r.stale) return page("Already decided", `<h1>Already decided</h1><p>This layer version is ${escHtml(r.state || "no longer listed")}.</p>`);
  await addEvent(ddb, app.appId, { type: "layer-decision", layerId: form.layerId, decision: form.decision });
  const approved = form.decision === "approve";
  const text = approved ? `A GeoVivé reviewer approved ${form.layerId}. It's now showing for your users.`
    : `A GeoVivé reviewer didn't approve ${form.layerId}. Check the findings in your last report, fix the layer and republish your list; the change will be checked again. Any earlier approved version keeps showing.`;
  try {
    await sendMail({ to: app.contactEmail, subject: `Layer ${form.layerId} ${approved ? "approved" : "not approved"} for ${app.name}`, text,
      html: emailHtml({ heading: `Layer ${form.layerId} ${approved ? "approved" : "not approved"}`, paragraphs: [text],
        button: { label: "Open AppConnect", url: `${SITE}/appconnect/?app=${app.appId}` } }) });
  } catch (e) { console.error("Decision email failed", e); }
  return page("Done", `<h1>${approved ? "Approved" : "Rejected"}: <code>${escHtml(form.layerId)}</code></h1><p>The owner has been emailed.</p>`);
}

// Daily: remind the reviewer about reviews waiting 3+ business days (once per layer version).
export async function reviewReminders(ddb, apps, now = Date.now()) {
  const sent = [];
  for (const app of apps) {
    const waiting = Object.entries(app.layerState || {}).filter(([, st]) => st.state === "review" && !st.reminded && businessDaysBetween(st.at, now) >= 3);
    if (!waiting.length) continue;
    await emailReviewer(ddb, app, waiting.map(([id, st]) => ({ id, name: id, hash: st.hash, issues: st.findings || [] })), { reminder: true });
    const state = { ...app.layerState };
    waiting.forEach(([id]) => { state[id] = { ...state[id], reminded: true }; });
    await ddb.send(new UpdateCommand({ TableName: APPS_TABLE, Key: { appId: app.appId, sk: "APP" },
      UpdateExpression: "SET layerState = :s", ExpressionAttributeValues: { ":s": state } }));
    sent.push(app.appId);
  }
  return sent;
}


// ------------------------------------------------------------------ AI review, notices, evidence

const EVIDENCE_BUCKET = process.env.EVIDENCE_BUCKET;
const SEVERITY_RANK = { low: 0, medium: 1, high: 2 };

// Add AI findings (when enabled) to each checked layer and decide what they mean:
// owner categories become notices and may hold the layer for review; GeoVivé-only
// categories hold the layer, preserve evidence and are never shown to the owner.
export async function assessRows(ddb, s3, app, rows, { send } = {}) {
  const cfg = (await reviewSettings()).bedrock || {};
  const notices = [];
  for (const row of rows) {
    // Rule-based findings map onto the same categories
    for (const text of row.issues) {
      const category = categoryOfIssue(text);
      if (category && CATEGORIES[category].audience === "owner") notices.push({ layerId: row.id, category, reason: text, source: "checks" });
    }
    if (row.result === "fail" || !row._features?.length) continue;
    let ai;
    try { ai = await aiReviewLayer(ddb, row._layer, row._features, cfg, { send }); }
    catch (e) { console.error("AI review failed", app.appId, row.id, e.name); ai = { skipped: "AI review unavailable" }; }
    row.ai = { skipped: ai.skipped, model: ai.model, count: ai.findings?.length || 0 };
    const worse = r => { const o = { pass: 0, note: 1, review: 2, fail: 3 }; if (o[r] > o[row.result]) row.result = r; };
    for (const f of ai.findings || []) {
      const cat = CATEGORIES[f.category];
      if (cat.audience === "geovive") {
        row.retained = true;
        (row.retainedFindings ||= []).push(f);
        worse("review");
      } else {
        (row.aiFindings ||= []).push(f);
        row.issues.push(`${cat.label}: ${f.reason}${f.field ? ` (${f.field})` : ""}`);
        worse(cat.hold === "review" && SEVERITY_RANK[f.severity] >= 1 ? "review" : "note");
        notices.push({ layerId: row.id, category: f.category, reason: f.reason, field: f.field, severity: f.severity, source: "ai" });
      }
    }
    if (row.retained) {
      row.issues.push("Held for a GeoVivé review");
      await preserveEvidence(s3, app, row);
    }
  }
  await queueNotices(ddb, app, notices);
  return rows;
}

// Restricted evidence store: versioned, encrypted, write-once from the worker.
async function preserveEvidence(s3, app, row) {
  if (!EVIDENCE_BUCKET) return;
  const at = new Date().toISOString();
  await s3.send(new PutObjectCommand({
    Bucket: EVIDENCE_BUCKET, Key: `${app.appId}/${row.id}/${at}.json`, ContentType: "application/json",
    Body: JSON.stringify({ at, app: { appId: app.appId, name: app.name, domain: app.domain, ownerId: app.ownerId, contactEmail: app.contactEmail },
      layer: row._layer || null, hash: row.hash, findings: row.retainedFindings,
      samples: (row._features || []).slice(0, 100).map(f => f.properties) })
  }));
}

// Owner notices: each finding (layer + category + field) is sent once. Immediate
// categories go out now; the rest in a weekly digest (Mondays).
export async function queueNotices(ddb, app, notices, { now = new Date() } = {}) {
  if (!notices.length) return { sent: 0, queued: 0 };
  const fresh = await getAppRecord(ddb, app.appId, { fresh: true });
  const seen = new Set(fresh?.noticedKeys || []);
  const queue = [...(fresh?.pendingNotices || [])];
  const immediate = [];
  for (const n of notices) {
    const key = `${n.layerId}|${n.category}|${n.field || ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const item = { ...n, key, at: now.toISOString() };
    if (CATEGORIES[n.category].schedule === "immediate") immediate.push(item); else queue.push(item);
  }
  if (immediate.length) await sendNotices(ddb, fresh || app, immediate, "Findings to fix now");
  await ddb.send(new UpdateCommand({ TableName: APPS_TABLE, Key: { appId: app.appId, sk: "APP" },
    UpdateExpression: "SET noticedKeys = :k, pendingNotices = :q",
    ExpressionAttributeValues: { ":k": [...seen].slice(-500), ":q": queue.slice(-200) } }));
  return { sent: immediate.length, queued: queue.length };
}

async function sendNotices(ddb, app, items, title) {
  const byCat = {};
  items.forEach(i => (byCat[i.category] ||= []).push(i));
  const paras = [`GeoVivé found the following in ${app.name}'s layers. Please fix them in your own data; GeoVivé only reports what it detects.`];
  for (const [cat, list] of Object.entries(byCat)) {
    paras.push(`${CATEGORIES[cat].label} — ${CATEGORIES[cat].guidance}`);
    list.slice(0, 20).forEach(i => paras.push(`• ${i.layerId}${i.field ? ` (${i.field})` : ""}: ${i.reason}`));
  }
  try {
    await sendMail({ to: app.contactEmail, subject: `${title}: ${items.length} finding${items.length > 1 ? "s" : ""} in ${app.name}'s layers`,
      text: paras.join("\n\n"), html: emailHtml({ heading: title, paragraphs: paras,
        button: { label: "Open AppConnect", url: `${SITE}/appconnect/?app=${app.appId}` } }) });
    await addEvent(ddb, app.appId, { type: "notice-sent", what: title, count: items.length, categories: Object.keys(byCat) });
  } catch (e) { console.error("Notice email failed", app.appId, e.name); }
}

// Weekly digest of queued (non-urgent) findings, sent on Mondays by the daily job.
export async function sendWeeklyNotices(ddb, apps, now = new Date()) {
  if (now.getUTCDay() !== 1) return [];
  const sent = [];
  for (const app of apps) {
    if (!app.pendingNotices?.length) continue;
    await sendNotices(ddb, app, app.pendingNotices, "Weekly layer findings");
    await ddb.send(new UpdateCommand({ TableName: APPS_TABLE, Key: { appId: app.appId, sk: "APP" },
      UpdateExpression: "SET pendingNotices = :e", ExpressionAttributeValues: { ":e": [] } }));
    sent.push(app.appId);
  }
  return sent;
}


// ------------------------------------------------------------------ offboarding

export const DISCONNECT_REASONS = {
  not_needed: "We no longer need it",
  cost: "Cost",
  another_platform: "Moving to another platform",
  missing_features: "Missing features",
  business_closed: "Our business or product is closing",
  other: "Other",
  expired: "The yearly term ended without renewal",
  geovive: "Ended by GeoVivé under the terms"
};
const RECONNECT_DAYS = 90;
const EVENTS_KEEP_DAYS = 365;

// Owner asks to disconnect. when: "now" | "term_end". The owner must type the app ID to confirm.
export async function requestDisconnect(ddb, s3, caller, appId, body = {}) {
  const app = await ownedApp(ddb, appId, caller);
  if (["disconnected", "closed"].includes(app.status)) throw new AppConnectError(409, "This app is already disconnected");
  if (body.confirm !== appId) throw new AppConnectError(400, "Type the app ID to confirm");
  const reason = DISCONNECT_REASONS[body.reason] && !["expired", "geovive"].includes(body.reason) ? body.reason : "other";
  const note = typeof body.note === "string" ? body.note.trim().slice(0, 500) : "";
  const termLeft = app.termEndsAt && Date.parse(app.termEndsAt) > Date.now() && isActive(app.status, app.termEndsAt);
  if (body.when === "term_end" && termLeft) {
    await ddb.send(new UpdateCommand({ TableName: APPS_TABLE, Key: { appId, sk: "APP" },
      UpdateExpression: "SET disconnectAt = :t, disconnectReason = :r, disconnectNote = :n",
      ExpressionAttributeValues: { ":t": app.termEndsAt, ":r": reason, ":n": note } }));
    await addEvent(ddb, appId, { type: "disconnect-scheduled", at2: app.termEndsAt, reason });
    await safeMail(ddb, appId, "disconnect scheduled", {
      to: app.contactEmail, subject: `${app.name} will disconnect from GeoVivé on ${fmtDate(app.termEndsAt)}`,
      text: `Your AppConnect connection stays live until ${fmtDate(app.termEndsAt)}, then disconnects automatically. You can cancel this any time before then from your AppConnect page.`,
      html: emailHtml({ heading: "Disconnection scheduled", paragraphs: [
        `${app.name} stays live until ${fmtDate(app.termEndsAt)}, then disconnects automatically: your layers stop showing and GeoVivé deletes its copies.`,
        "Changed your mind? Cancel it any time before then from your AppConnect page."],
        button: { label: "Open AppConnect", url: `${SITE}/appconnect/?app=${appId}` } })
    });
    return { appId, scheduled: app.termEndsAt };
  }
  return disconnectApp(ddb, s3, app, { reason, note, by: "App owner" });
}

export async function cancelScheduledDisconnect(ddb, caller, appId) {
  const app = await ownedApp(ddb, appId, caller);
  if (!app.disconnectAt) throw new AppConnectError(409, "No disconnection is scheduled");
  await ddb.send(new UpdateCommand({ TableName: APPS_TABLE, Key: { appId, sk: "APP" },
    UpdateExpression: "REMOVE disconnectAt, disconnectReason, disconnectNote" }));
  await addEvent(ddb, appId, { type: "disconnect-cancelled" });
  return { appId, cancelled: true };
}

async function deletePrefix(s3, prefix) {
  let token, n = 0;
  do {
    const res = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: prefix, ContinuationToken: token }));
    const keys = (res.Contents || []).map(o => ({ Key: o.Key }));
    if (keys.length) { await s3.send(new DeleteObjectsCommand({ Bucket: BUCKET, Delete: { Objects: keys, Quiet: true } })); n += keys.length; }
    token = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (token);
  return n;
}

// The structured disconnect, used for owner requests, scheduled ends, expiry and GeoVivé terminations.
export async function disconnectApp(ddb, s3, app, { reason = "other", note = "", by = "App owner", now = new Date() } = {}) {
  const appId = app.appId;
  await setStatus(ddb, appId, app.status, "disconnected", { reason, by });
  // 1. Delete display copies and pending review copies (reports and evidence are kept)
  let approvedLayers = 0;
  try {
    const res = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: `appconnect/${appId}/approved.json` }));
    approvedLayers = Object.keys(JSON.parse(await res.Body.transformToString()).layers || {}).length;
  } catch { /* none */ }
  const deleted = {
    approvedLayers,
    relayFiles: await deletePrefix(s3, `overlays/v3/${appId}/`),
    pendingFiles: await deletePrefix(s3, `appconnect-pending/${appId}/`)
  };
  await deletePrefix(s3, `appconnect/${appId}/approved.json`);
  const at = now.toISOString();
  const purgeAt = new Date(now.getTime() + RECONNECT_DAYS * 86400_000).toISOString();
  await ddb.send(new UpdateCommand({ TableName: APPS_TABLE, Key: { appId, sk: "APP" },
    UpdateExpression: "SET disconnectedAt = :at, disconnectReason = :r, disconnectNote = :n, disconnectedBy = :by, purgeAt = :p, layerState = :e, pendingNotices = :l REMOVE disconnectAt, paymentUrl",
    ExpressionAttributeValues: { ":at": at, ":r": reason, ":n": note, ":by": by, ":p": purgeAt, ":e": {}, ":l": [] } }));

  // 2. Certificate + settings export for the owner
  const certId = newId("OB");
  const kept = [
    { item: "App record, settings and history", until: fmtDate(purgeAt), why: "So you can reconnect without signing up again; then reduced to a minimal closed record" },
    { item: "Reports and notices (PDF)", until: fmtDate(purgeAt), why: "Your records of checks and payments" },
    { item: "Payment records", until: "As required by law", why: "Held by Stripe and GeoVivé for tax and accounting" },
    { item: "Records GeoVivé must keep", until: "Up to 2 years", why: "Only where the terms (section 7) require preserving evidence" }
  ];
  const pdf = await offboardingCertificatePdf(app, { certId, at, by, reason: DISCONNECT_REASONS[reason] || reason, termsVersion: TERMS_VERSION, purgeAt, deleted, kept });
  await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: `appconnect/${appId}/${certId}.pdf`, Body: pdf, ContentType: "application/pdf" }));
  const exportJson = await buildExport(ddb, appId);
  await addEvent(ddb, appId, { type: "disconnected", certId, reason, by, deleted });

  const paras = [
    `${app.name} is now disconnected from GeoVivé. Your layers no longer show, and GeoVivé has deleted its display copies (${deleted.approvedLayers} layers, ${deleted.relayFiles} cached files).`,
    "Your disconnection certificate and a JSON export of your app's settings and history are attached.",
    `Changed your mind? You can reconnect until ${fmtDate(purgeAt)} from your AppConnect page.`
  ];
  await safeMail(ddb, appId, "disconnection certificate", {
    to: app.contactEmail, subject: `${app.name} is disconnected from GeoVivé`, text: paras.join("\n\n"),
    html: emailHtml({ heading: "You're disconnected", paragraphs: paras, button: { label: "Open AppConnect", url: `${SITE}/appconnect/?app=${appId}` } }),
    attachments: [{ filename: `${certId}.pdf`, content: pdf },
      { filename: `${appId}-appconnect-export.json`, content: Buffer.from(JSON.stringify(exportJson, null, 2)), contentType: "application/json" }]
  });
  // 3. Tell GeoVivé (turnover signal)
  try {
    const { reviewerEmail } = await reviewSettings();
    await sendMail({ to: reviewerEmail, subject: `AppConnect: ${app.name} disconnected (${DISCONNECT_REASONS[reason] || reason})`,
      text: `${app.name} (${appId}, ${app.domain}) disconnected by ${by}.\nReason: ${DISCONNECT_REASONS[reason] || reason}${note ? `\nNote: ${note}` : ""}\nTerm ended/ends: ${app.termEndsAt || "—"}\nCertificate: ${certId}`,
      html: emailHtml({ heading: `${app.name} disconnected`, paragraphs: [`App ${appId} (${app.domain}), by ${by}.`, `Reason: ${DISCONNECT_REASONS[reason] || reason}`, ...(note ? [`Note: ${note}`] : []), `Certificate ${certId}. Record closes ${fmtDate(purgeAt)}.`] }) });
  } catch (e) { console.error("Admin notice failed", e.name); }
  return { appId, status: "disconnected", certId, deleted, purgeAt };
}

// Settings and history the owner can keep (no secrets, no evidence).
export async function buildExport(ddb, appId) {
  const app = await getAppRecord(ddb, appId, { fresh: true });
  const events = await listEvents(ddb, appId, 500);
  return {
    exportedAt: new Date().toISOString(),
    app: { appId, name: app.name, domain: app.domain, contactEmail: app.contactEmail, layersUrl: app.layersUrl,
      returnOrigins: app.returnOrigins, featureTypes: app.featureTypes, status: app.status, createdAt: app.createdAt,
      termStartsAt: app.termStartsAt, termEndsAt: app.termEndsAt, termsVersion: app.termsVersion },
    history: events.map(({ checks, ...e }) => e)
  };
}

export async function exportMine(ddb, caller, appId) {
  await ownedApp(ddb, appId, caller);
  return buildExport(ddb, appId);
}

// Reconnect inside the 90-day window: back to "registered"; checks and payment start a new term.
export async function reconnect(ddb, caller, appId) {
  const app = await ownedApp(ddb, appId, caller);
  if (app.status !== "disconnected") throw new AppConnectError(409, "Only disconnected apps can reconnect");
  await setStatus(ddb, appId, "disconnected", "registered", { reason: "reconnect" });
  await ddb.send(new UpdateCommand({ TableName: APPS_TABLE, Key: { appId, sk: "APP" },
    UpdateExpression: "REMOVE disconnectedAt, disconnectReason, disconnectNote, disconnectedBy, purgeAt, termEndsAt, termStartsAt, lastCheckAt, layerCheckKey" }));
  return getMine(ddb, caller, appId);
}

// After the reconnect window: delete reports and history, keep a minimal closed record so the
// app ID can't be taken over by someone else (the same owner can register it again).
export async function closeApp(ddb, s3, app, { now = new Date() } = {}) {
  const appId = app.appId;
  await deletePrefix(s3, `appconnect/${appId}/`);
  const raw = await ddb.send(new QueryCommand({ TableName: APPS_TABLE, KeyConditionExpression: "appId = :a AND begins_with(sk, :e)",
    ExpressionAttributeValues: { ":a": appId, ":e": "EVENT#" }, ProjectionExpression: "appId, sk" }));
  for (const k of raw.Items || []) await ddb.send(new DeleteCommand({ TableName: APPS_TABLE, Key: { appId: k.appId, sk: k.sk } }));
  await ddb.send(new PutCommand({ TableName: APPS_TABLE, Item: {
    appId, sk: "APP", status: "closed", name: app.name, ownerId: app.ownerId, domain: app.domain,
    createdAt: app.createdAt, disconnectedAt: app.disconnectedAt, closedAt: now.toISOString(), updatedAt: now.toISOString(),
    disconnectReason: app.disconnectReason
  } }));
  try {
    await sendMail({ to: app.contactEmail, subject: `${app.name}'s GeoVivé AppConnect record is closed`,
      text: `The reconnect window for ${app.name} has ended, so GeoVivé has deleted its reports and history. The app ID ${appId} stays reserved for your account if you ever want to connect again.`,
      html: emailHtml({ heading: "Your AppConnect record is closed", paragraphs: [
        `The reconnect window for ${app.name} has ended, so GeoVivé has deleted its reports and history.`,
        `The app ID ${appId} stays reserved for your account if you ever want to connect again.`] }) });
  } catch (e) { console.error("Closure email failed", e.name); }
  return { appId, closed: true };
}

// Daily offboarding duties: scheduled disconnects, passive expiry after the renewal window, closures.
export async function runOffboarding(ddb, s3, { now = Date.now() } = {}) {
  const done = { disconnected: [], expiredDisconnected: [], closed: [] };
  const active = [...await listByStatusSafe(ddb, "live"), ...await listByStatusSafe(ddb, "sandbox")].filter(a => a.ownerId);
  for (const app of active) {
    if (app.disconnectAt && Date.parse(app.disconnectAt) <= now) {
      await disconnectApp(ddb, s3, app, { reason: app.disconnectReason || "other", note: app.disconnectNote || "", by: "Scheduled by app owner", now: new Date(now) });
      done.disconnected.push(app.appId);
    }
  }
  for (const app of (await listByStatusSafe(ddb, "expired")).filter(a => a.ownerId)) {
    if (app.disconnectAt || (app.termEndsAt && Date.parse(app.termEndsAt) + RECONNECT_DAYS * 86400_000 <= now)) {
      await disconnectApp(ddb, s3, app, { reason: app.disconnectReason || "expired", by: app.disconnectAt ? "Scheduled by app owner" : "GeoVivé (not renewed)", now: new Date(now) });
      done.expiredDisconnected.push(app.appId);
    }
  }
  for (const app of await listByStatusSafe(ddb, "disconnected")) {
    if (app.purgeAt && Date.parse(app.purgeAt) <= now) { await closeApp(ddb, s3, app, { now: new Date(now) }); done.closed.push(app.appId); }
  }
  return done;
}
