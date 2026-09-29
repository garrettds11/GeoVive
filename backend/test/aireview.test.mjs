// AI review pipeline with a mocked Bedrock call (no AWS cost).
import assert from "node:assert/strict";
process.env.APPS_TABLE = "apps"; process.env.GEOMETRY_BUCKET = "b"; process.env.EVIDENCE_BUCKET = "ev";
process.env.AWS_ACCESS_KEY_ID = "x"; process.env.AWS_SECRET_ACCESS_KEY = "y"; process.env.AWS_REGION = "us-east-1";
const { buildReviewInput, parseFindings, aiReviewLayer, SYSTEM_PROMPT } = await import("../src/aireview.mjs");
const ac = await import("../src/appconnect.mjs");

const layer = { id: "stewards", name: "Trail stewards", group: "Parks", label: "{NAME}", fields: { NOTE: "Note" },
  attribution: "Example Parks", license: "CC BY 4.0", source: { type: "geojson", url: "https://data.example.org/s.geojson" } };
const feats = [{ properties: { _label: "Ridge", Note: "call jo@example.com" }, geometry: { type: "Point", coordinates: [1, 2] } }];

// Input: untrusted wrapper, values present, no geometry
const input = buildReviewInput(layer, feats);
assert.ok(input.startsWith("<layer_data>") && input.includes("jo@example.com") && !input.includes("coordinates"));
assert.match(SYSTEM_PROMPT, /untrusted data/);

// Parsing: invalid categories and low confidence dropped
const p = parseFindings('noise {"findings":[{"category":"personal_info","severity":"high","confidence":0.9,"field":"Note","reason":"email of a private person","evidence":"jo@"},{"category":"made_up","confidence":1},{"category":"offensive","confidence":0.2}]}');
assert.equal(p.findings.length, 1); assert.equal(p.findings[0].category, "personal_info");
assert.deepEqual(parseFindings("not json").findings, []);

// Budget + off switch
const items = new Map();
const ddb = { async send(c) {
  const n = c.constructor.name, i = c.input, k = `${i.Key?.appId}|${i.Key?.sk}`;
  if (n === "UpdateCommand" && i.Key.appId === "_system") {
    const cur = items.get(k)?.used || 0;
    if (cur >= i.ExpressionAttributeValues[":max"]) { const e = new Error("c"); e.name = "ConditionalCheckFailedException"; throw e; }
    items.set(k, { used: cur + 1 }); return {};
  }
  if (n === "GetCommand") return { Item: structuredClone(items.get(k)) };
  if (n === "UpdateCommand") { const cur = items.get(k) || {}; for (const part of i.UpdateExpression.replace(/^SET /, "").split(/,\s*/)) { const [l, r] = part.split(/\s*=\s*/); cur[l] = i.ExpressionAttributeValues[r]; } items.set(k, cur); return {}; }
  if (n === "PutCommand") { items.set(`${i.Item.appId}|${i.Item.sk}`, i.Item); return {}; }
  return {};
} };
let calls = 0;
const reply = findings => async () => { calls++; return { output: { message: { content: [{ text: JSON.stringify({ findings }) }] } }, usage: { inputTokens: 900, outputTokens: 80 } }; };
assert.deepEqual(await aiReviewLayer(ddb, layer, feats, { enabled: false }), { skipped: "AI review is off" });
const cfg = { enabled: true, modelId: "m", maxPerDay: 2 };
await aiReviewLayer(ddb, layer, feats, cfg, { send: reply([]) });
await aiReviewLayer(ddb, layer, feats, cfg, { send: reply([]) });
assert.equal((await aiReviewLayer(ddb, layer, feats, cfg, { send: reply([]) })).skipped, "daily AI review limit reached");
assert.equal(calls, 2, "cap stops the third call");

// assessRows: owner findings -> notice + review; GeoVivé-only -> held, evidence, owner not told the reason
items.clear();
items.set("app1|APP", { appId: "app1", sk: "APP", name: "Trail Maps", contactEmail: "ops@example.com", ownerId: "u" });
ac._setReviewSettings({ reviewKey: "rk", reviewerEmail: "rev@example.com", bedrock: { enabled: true, modelId: "m", maxPerDay: 10 } });
const s3puts = [];
const s3 = { async send(c) { s3puts.push(c.input); return {}; } };
const mails = [];
const { SESv2Client } = await import("@aws-sdk/client-sesv2");
SESv2Client.prototype.send = async c => { mails.push(Buffer.from(c.input.Content.Raw.Data).toString()); return {}; };
const mk = (id) => { const r = { id, name: id, result: "pass", issues: [], hash: "h" + id }; Object.defineProperty(r, "_features", { value: feats }); Object.defineProperty(r, "_layer", { value: { ...layer, id } }); return r; };
const rows = [mk("a"), mk("b")];
let n = 0;
const send = async () => (n++ === 0
  ? reply([{ category: "personal_info", severity: "high", confidence: 0.95, field: "Note", reason: "private email", evidence: "jo@" }])()
  : reply([{ category: "criminal", severity: "high", confidence: 0.9, field: "Note", reason: "offers illegal goods", evidence: "x" }])());
await ac.assessRows(ddb, s3, items.get("app1|APP"), rows, { send });
assert.equal(rows[0].result, "review"); assert.ok(rows[0].issues.some(i => /Personal information: private email/.test(i)));
assert.equal(rows[1].result, "review"); assert.ok(rows[1].retained);
assert.ok(!rows[1].issues.some(i => /illegal/.test(i)), "owner never sees GeoVivé-only reasons");
assert.ok(rows[1].issues.includes("Held for a GeoVivé review"));
const ev = s3puts.find(x => x.Bucket === "ev");
assert.ok(ev && ev.Key.startsWith("app1/b/") && ev.Body.includes("illegal goods"), "evidence preserved");
assert.equal(mails.length, 1, "immediate notice for personal info");
const rec = items.get("app1|APP");
assert.ok(rec.noticedKeys.includes("a|personal_info|Note"));
assert.ok(!rec.noticedKeys.some(k => k.startsWith("b|")), "no notice for GeoVivé-only finding");
// Same finding again isn't re-sent
await ac.queueNotices(ddb, rec, [{ layerId: "a", category: "personal_info", field: "Note", reason: "private email" }]);
assert.equal(mails.length, 1);
// Weekly categories wait for Monday
await ac.queueNotices(ddb, items.get("app1|APP"), [{ layerId: "a", category: "data_quality", field: "Note", reason: "placeholder text" }]);
assert.equal(mails.length, 1); assert.equal(items.get("app1|APP").pendingNotices.length, 1);
assert.deepEqual(await ac.sendWeeklyNotices(ddb, [items.get("app1|APP")], new Date("2026-09-29T15:00:00Z")), [], "Tuesday: nothing");
assert.deepEqual(await ac.sendWeeklyNotices(ddb, [items.get("app1|APP")], new Date("2026-09-28T15:00:00Z")), ["app1"], "Monday digest");
assert.equal(mails.length, 2);
console.log("AI review tests passed");
