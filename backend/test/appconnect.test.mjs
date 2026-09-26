// AppConnect signup, checks, report, payment webhook — with in-memory DynamoDB, S3, SES and network.
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
process.env.APPS_TABLE = "apps"; process.env.GEOMETRY_BUCKET = "b"; process.env.ALLOWED_ORIGINS = "https://geovive.link";
process.env.AWS_ACCESS_KEY_ID = "x"; process.env.AWS_SECRET_ACCESS_KEY = "y"; process.env.AWS_REGION = "us-east-1";

// ---- fakes
const items = new Map();                       // "appId|sk" -> item
const key = (a, s) => `${a}|${s}`;
const ddb = { async send(c) {
  const n = c.constructor.name, i = c.input;
  if (n === "GetCommand") return { Item: structuredClone(items.get(key(i.Key.appId, i.Key.sk))) };
  if (n === "PutCommand") {
    if (i.ConditionExpression && items.has(key(i.Item.appId, i.Item.sk))) { const e = new Error("x"); e.name = "ConditionalCheckFailedException"; throw e; }
    items.set(key(i.Item.appId, i.Item.sk), structuredClone(i.Item)); return {};
  }
  if (n === "QueryCommand") {
    const v = i.ExpressionAttributeValues; let all = [...items.values()];
    if (i.IndexName === "byOwner") all = all.filter(x => x.ownerId === v[":o"]);
    else if (i.IndexName === "byStatus") all = all.filter(x => x.sk === "APP" && x.status === v[":s"]);
    else all = all.filter(x => x.appId === v[":a"] && x.sk.startsWith(v[":e"])).sort((a, b) => b.sk.localeCompare(a.sk));
    return i.Select === "COUNT" ? { Count: all.length } : { Items: all.map(x => structuredClone(x)) };
  }
  if (n === "UpdateCommand") { applyUpdate(i); return {}; }
  if (n === "TransactWriteCommand") {
    for (const t of i.TransactItems) {
      if (t.Update) {
        const cur = items.get(key(t.Update.Key.appId, t.Update.Key.sk));
        if (t.Update.ConditionExpression === "#s = :from" && cur.status !== t.Update.ExpressionAttributeValues[":from"]) throw new Error("condition");
      }
    }
    for (const t of i.TransactItems) t.Update ? applyUpdate(t.Update) : items.set(key(t.Put.Item.appId, t.Put.Item.sk), structuredClone(t.Put.Item));
    return {};
  }
  throw new Error("unexpected " + n);
} };
function applyUpdate(u) {
  const cur = items.get(key(u.Key.appId, u.Key.sk)); const v = u.ExpressionAttributeValues; const names = u.ExpressionAttributeNames || {};
  for (const part of u.UpdateExpression.replace(/^SET /, "").split(/,\s*(?![^()]*\))/)) {
    const [lhs, rhs] = part.split(/\s*=\s*/); const f = names[lhs] || lhs;
    const m = rhs.match(/^if_not_exists\((\w+), (:\w+)\)$/);
    cur[f] = m ? (cur[m[1]] ?? v[m[2]]) : v[rhs];
  }
}
const s3objs = new Map();
const s3 = { async send(c) {
  if (c.constructor.name === "GetObjectCommand") {
    if (!s3objs.has(c.input.Key)) { const e = new Error("no"); e.name = "NoSuchKey"; throw e; }
    const body = s3objs.get(c.input.Key);
    return { Body: { transformToString: async () => Buffer.isBuffer(body) ? body.toString() : String(body) } };
  }
  s3objs.set(c.input.Key, c.input.Body); return {};
} };
const mails = [];
const { SESv2Client } = await import("@aws-sdk/client-sesv2");
SESv2Client.prototype.send = async c => { mails.push(Buffer.from(c.input.Content.Raw.Data).toString()); return { MessageId: "m" + mails.length }; };

const ac = await import("../src/appconnect.mjs");
const { runChecks, isPrivateAddress } = await import("../src/appcheck.mjs");
ac._setReviewSettings({ reviewKey: "rk", reviewerEmail: "reviewer@example.com" });
ac._setStripeSettings({ webhookSecret: "whsec_test", paymentLinkId: "plink_1", paymentLinkUrl: "https://buy.stripe.com/test_abc", feeDisplay: "$499.00 per year" });

// ---- validation
const good = { appId: "trail-maps", name: "Trail Maps", domain: "trails.example.com", contactEmail: "ops@example.com",
  layersUrl: "https://trails.example.com/geovive-layers.json", returnOrigins: ["https://trails.example.com", "http://localhost:5173"], acceptTerms: true };
assert.equal(ac.validateSignup(good).appId, "trail-maps");
assert.throws(() => ac.validateSignup({ ...good, acceptTerms: false }), /accept/);
assert.throws(() => ac.validateSignup({ ...good, layersUrl: "https://evil.com/l.json" }), /on trails.example.com/);
assert.throws(() => ac.validateSignup({ ...good, returnOrigins: ["https://evil.com"] }), /must be https/);
assert.throws(() => ac.validateSignup({ ...good, appId: "geovive-x" }), /reserved/);
assert.throws(() => ac.validateSignup({ ...good, domain: "x.geovive.link" }), /can't be registered/);
assert.ok(isPrivateAddress("10.1.2.3") && isPrivateAddress("169.254.169.254") && isPrivateAddress("::1") && !isPrivateAddress("8.8.8.8"));

// ---- signup
const caller = { sub: "user-1" };
const view = await ac.signup(ddb, caller, good);
assert.equal(view.status, "registered");
assert.match(view.verification.dnsValue, /^geovive-verify=[0-9a-f]{32}$/);
assert.equal(mails.length, 1, "verification email sent");
await assert.rejects(ac.signup(ddb, caller, good), /taken/);
await assert.rejects(ac.getMine(ddb, { sub: "someone-else" }, "trail-maps"), /not found/);

// ---- network fakes: source + list
const list = { version: 1, layers: [
  { id: "trails", name: "Trails", group: "Parks", color: "#22c55e", attribution: "Example Parks", license: "CC BY 4.0",
    source: { type: "geojson", url: "https://data.example.org/trails.geojson" }, label: "{NAME}", fields: { LEN: "Length" } },
  { id: "owners", name: "Owners", group: "Parks", attribution: "Example Parks", license: "Official agency data",
    source: { type: "geojson", url: "https://data.example.org/owners.geojson" }, label: "{NAME}", fields: { OWNER_NAME: "Owner" } }
] };
const fc = { type: "FeatureCollection", features: [{ type: "Feature", properties: { NAME: "Ridge", LEN: 3, OWNER_NAME: "A. Person" },
  geometry: { type: "Polygon", coordinates: [[[-105, 39], [-104.9, 39], [-104.9, 39.1], [-105, 39]]] } }] };
const json = o => new Response(JSON.stringify(o), { headers: { "content-type": "application/json" } });
let txt = [];
globalThis.fetch = async (url) => {
  const u = String(url);
  if (u.endsWith("/geovive-layers.json")) return json(list);
  if (u.includes("data.example.org")) return json(fc);
  if (u.endsWith("/.well-known/geovive.txt")) return new Response("nope", { status: 404 });
  throw new Error("unexpected fetch " + u);
};
const net = { fetch: (...a) => globalThis.fetch(...a), resolveTxt: async () => txt, lookup: async () => [{ address: "93.184.216.34" }] };

// ---- checks fail without the domain token
let invoked;
await ac.requestChecks(ddb, caller, "trail-maps", async p => { invoked = p; });
assert.equal((await ac.getMine(ddb, caller, "trail-maps")).status, "verifying");
let out = await ac.runAppChecks(ddb, s3, invoked, net);
assert.equal(out.status, "checks_failed");
assert.ok(s3objs.has(`appconnect/trail-maps/${invoked.reportId}.pdf`), "report stored");
assert.match(mails.at(-1), /need attention/i.test(mails.at(-1)) ? /./ : /=\?UTF-8\?B\?/);

// ---- publish token; the PII field fails the owners layer
const app = [...items.values()].find(i => i.sk === "APP");
txt = [[`geovive-verify=${app.verifyToken}`]];
let r = await runChecks({ ...app }, net);
assert.equal(r.checks[0].result, "pass");
assert.equal(r.passed, false, "PII field blocks");
assert.ok(r.layers.find(l => l.id === "owners").issues.some(i => /personal information/.test(i)));
assert.ok(r.layers.find(l => l.id === "owners").issues.some(i => /generic/.test(i)));

// fix the list, re-run through the worker
list.layers[1].fields = { ACRES: "Acres" };
items.get(key("trail-maps", "APP")).lastCheckAt = "2000-01-01T00:00:00Z";
await ac.requestChecks(ddb, caller, "trail-maps", async p => { invoked = p; });
out = await ac.runAppChecks(ddb, s3, invoked, net);
assert.equal(out.status, "awaiting_payment");
const v2 = await ac.getMine(ddb, caller, "trail-maps");
assert.match(v2.paymentUrl, /client_reference_id=trail-maps/);
assert.ok(mails.at(-1).includes("application/pdf"), "report attached");

// ---- Stripe webhook
const session = { id: "cs_test_1", payment_link: "plink_1", client_reference_id: "trail-maps", payment_status: "no_payment_required",
  amount_total: 0, amount_subtotal: 49900, currency: "usd", livemode: false, total_details: { amount_discount: 49900 },
  discounts: [{ promotion_code: "promo_1" }], customer_details: { email: "ops@example.com" } };
const body = JSON.stringify({ type: "checkout.session.completed", data: { object: session } });
const t = Math.floor(Date.now() / 1000);
const sig = `t=${t},v1=${createHmac("sha256", "whsec_test").update(`${t}.${body}`).digest("hex")}`;
await assert.rejects(ac.stripeWebhook(ddb, s3, body, `t=${t},v1=deadbeef`), /signature/i);
const res = await ac.stripeWebhook(ddb, s3, body, sig);
assert.equal(res.status, "live");
const live = await ac.getMine(ddb, caller, "trail-maps");
assert.equal(live.status, "live"); assert.ok(live.active);
const days = (Date.parse(live.termEndsAt) - Date.parse(live.termStartsAt)) / 86400000;
assert.ok(days > 364.9 && days < 365.1, "one-year term");
assert.equal(live.termsVersion, ac.TERMS_VERSION);
assert.deepEqual(items.get(key("trail-maps", "APP")).returnOrigins.length, 2);
const { getActiveApp } = await import("../src/appstore.mjs");
assert.deepEqual((await getActiveApp(ddb, "trail-maps")).returnOrigins, ["https://trails.example.com"], "localhost dropped once live");
assert.ok([...s3objs.keys()].some(k => /LN-/.test(k)), "live notice stored");
assert.deepEqual(await ac.stripeWebhook(ddb, s3, body, sig), { duplicate: true }, "webhook is idempotent");

// unrelated payment link is ignored
const other = JSON.stringify({ type: "checkout.session.completed", data: { object: { ...session, id: "cs_2", payment_link: "plink_other" } } });
const sig2 = `t=${t},v1=${createHmac("sha256", "whsec_test").update(`${t}.${other}`).digest("hex")}`;
assert.ok((await ac.stripeWebhook(ddb, s3, other, sig2)).ignored);

console.log("appconnect tests passed:", mails.length, "emails,", s3objs.size, "PDFs");

// ---- daily upkeep: reminders, re-checks, expiry
{
  const rec = items.get(key("trail-maps", "APP"));
  const endMs = Date.parse(rec.termEndsAt);
  const invoked2 = [];
  const inv = async p => invoked2.push(p);
  const before = mails.length;
  // 31 days before the end, last check recent: nothing to do
  rec.lastCheckAt = new Date(endMs - 37 * 86400000).toISOString();
  let d = await ac.runDaily(ddb, { now: endMs - 31 * 86400000, invokeWorker: inv });
  assert.deepEqual(d, { rechecks: [], reminders: [], expired: [], layerChanges: [], reviewReminders: [] });
  // 29 days before: 30-day reminder, and a re-check (last check > 7 days ago)
  d = await ac.runDaily(ddb, { now: endMs - 29 * 86400000, invokeWorker: inv });
  assert.deepEqual(d.reminders, ["trail-maps:30"]); assert.deepEqual(d.rechecks, ["trail-maps"]);
  const plain = Buffer.from(mails.at(-1).split("text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n")[1].split("\r\n--")[0].replace(/\r\n/g, ""), "base64").toString();
  assert.match(plain, /client_reference_id=trail-maps/);
  // next day: no duplicate reminder
  d = await ac.runDaily(ddb, { now: endMs - 28 * 86400000, invokeWorker: inv });
  assert.deepEqual(d.reminders, []);
  // 6 days before: 7-day reminder once
  d = await ac.runDaily(ddb, { now: endMs - 6 * 86400000, invokeWorker: inv });
  assert.deepEqual(d.reminders, ["trail-maps:7"]);
  d = await ac.runDaily(ddb, { now: endMs - 5 * 86400000, invokeWorker: inv });
  assert.deepEqual(d.reminders, []);
  // after the end: expired, layers stop
  d = await ac.runDaily(ddb, { now: endMs + 1000, invokeWorker: inv });
  assert.deepEqual(d.expired, ["trail-maps"]);
  assert.equal(items.get(key("trail-maps", "APP")).status, "expired");
  assert.equal(mails.length - before, 3, "30-day, 7-day and expiry emails");
  // renewal payment brings it back live with a new year
  const b2 = JSON.stringify({ type: "checkout.session.completed", data: { object: { ...session, id: "cs_renew" } } });
  const s2 = `t=${t},v1=${createHmac("sha256", "whsec_test").update(`${t}.${b2}`).digest("hex")}`;
  const r2 = await ac.stripeWebhook(ddb, s3, b2, s2);
  assert.equal(r2.status, "live");
  assert.ok(Date.parse(items.get(key("trail-maps", "APP")).termEndsAt) > endMs);
  console.log("daily upkeep tests passed");
}

// ---- approved layers: new and changed layers are checked before they show
{
  const { loadApproved, visibleLayers, verifyReview, businessDaysBetween } = await import("../src/approvals.mjs");
  const { validateLayerList } = await import("../src/overlays.mjs");
  let approved = await loadApproved(s3, "trail-maps", { fresh: true });
  assert.deepEqual(Object.keys(approved.layers).sort(), ["owners", "trails"], "full checks approved passing layers");

  // The owner publishes a new layer whose values contain an email address, and edits an existing one
  list.layers.push({ id: "contacts", name: "Trail stewards", group: "Parks", attribution: "Example Parks", license: "CC BY 4.0",
    source: { type: "geojson", url: "https://data.example.org/stewards.geojson" }, label: "{NAME}", fields: { NOTE: "Note" } });
  list.layers[0].name = "Trails (2027)";
  const stewards = { type: "FeatureCollection", features: [{ type: "Feature", properties: { NAME: "Ridge", NOTE: "call jo@example.com" },
    geometry: { type: "Point", coordinates: [-105, 39] } }] };
  const prevFetch = globalThis.fetch;
  globalThis.fetch = async (url, o) => String(url).includes("stewards") ? json(stewards) : prevFetch(url, o);

  let app2 = await (await import("../src/appstore.mjs")).getAppRecord(ddb, "trail-maps", { fresh: true });
  const vlist = validateLayerList(list);
  const queued = [];
  const d1 = await ac.detectChanges(ddb, app2, vlist, async p => queued.push(p));
  assert.deepEqual(d1.layers.sort(), ["contacts", "trails"]);
  app2 = await (await import("../src/appstore.mjs")).getAppRecord(ddb, "trail-maps", { fresh: true });
  assert.equal(await ac.detectChanges(ddb, app2, vlist, async p => queued.push(p)), null, "same change queued once");
  assert.equal(queued[0].mode, "layers");

  // Until checks run, users still see the approved copies (old trails name, no contacts)
  approved = await loadApproved(s3, "trail-maps", { fresh: true });
  let vis = visibleLayers(approved, vlist);
  assert.deepEqual(vis.map(l => l.name), ["Trails", "Owners"]);

  const before = mails.length;
  const outcome = await ac.runLayerReview(ddb, s3, queued[0], net);
  assert.deepEqual(outcome, { approved: ["trails"], review: ["contacts"], rejected: [] });
  approved = await loadApproved(s3, "trail-maps", { fresh: true });
  vis = visibleLayers(approved, vlist);
  assert.deepEqual(vis.map(l => l.name), ["Trails (2027)", "Owners"], "changed layer approved; flagged layer held");
  const sent = mails.slice(before);
  assert.ok(sent.some(m => m.includes("reviewer@example.com")), "reviewer emailed");
  assert.ok(sent.some(m => m.includes("ops@example.com") && m.includes("application/pdf")), "owner gets the report");

  // Reviewer opens the signed link and approves
  const rev = sent.find(m => m.includes("reviewer@example.com"));
  const plain = Buffer.from(rev.split("text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n")[1].split("\r\n--")[0].replace(/\r\n/g, ""), "base64").toString();
  const link = new URL(plain.match(/Review: (\S+)/)[1]);
  const q = Object.fromEntries(link.searchParams);
  assert.ok(verifyReview("rk", q));
  assert.ok(!verifyReview("rk", { ...q, layerId: "trails" }), "signature covers the layer");
  const pageHtml = await ac.reviewPage(ddb, s3, q);
  assert.match(pageHtml, /Approve and show/); assert.match(pageHtml, /email address in Note/i);
  const done = await ac.reviewDecision(ddb, s3, { ...q, decision: "approve" });
  assert.match(done, /Approved/);
  approved = await loadApproved(s3, "trail-maps", { fresh: true });
  assert.ok(approved.layers.contacts, "approved after review");
  assert.match(await ac.reviewDecision(ddb, s3, { ...q, decision: "reject" }), /Already decided/);
  assert.equal(businessDaysBetween("2026-09-25T10:00:00Z", Date.parse("2026-09-29T10:00:00Z")), 2, "Fri to Tue is 2 business days");
  console.log("approved-layer tests passed");
}
