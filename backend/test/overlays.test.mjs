// Relay tests: value cleaning, labels, fetching (mocked), and S3 caching.
import assert from "node:assert/strict";
Object.assign(process.env, { USER_POOL_ID: "us-east-1_TEST123", USER_POOL_CLIENT_ID: "abc",
  AWS_REGION: "us-east-1", AWS_ACCESS_KEY_ID: "test", AWS_SECRET_ACCESS_KEY: "test",
  DATASETS_TABLE: "d", FEATURES_TABLE: "f", GEOMETRY_BUCKET: "g", ALLOWED_ORIGINS: "https://geovive.link" });
const ov = await import("../src/overlays.mjs");
const { S3Client } = await import("@aws-sdk/client-s3");

// Values
assert.equal(ov.cleanValue(" "), undefined);
assert.equal(ov.cleanValue("<Null>"), undefined);
assert.equal(ov.cleanValue('<a href="http://www.azgfd.gov/h_f/unit_1.shtml">Unit 1</a>'), "http://www.azgfd.gov/h_f/unit_1.shtml");
assert.equal(ov.cleanValue("<b>WMZ</b> No. 1"), "WMZ No. 1");
assert.equal(ov.cleanValue(12.3456), 12.35);
assert.equal(ov.renderLabel("WMU {WMUNIT_CODE} {WMUNIT_NAME}", { WMUNIT_CODE: "00102", WMUNIT_NAME: "Pakowi" }), "WMU 00102 Pakowi");
assert.equal(ov.renderLabel("GMU {gmuid}", { GMUID: 61 }), "GMU 61", "case-insensitive fields");

// Features: empty records dropped, fields renamed, polygons simplified
const src = ov.SOURCES["nm-gmu"];
const ring = Array.from({ length: 400 }, (_, i) => [-106 + Math.cos(i / 400 * 2 * Math.PI), 35 + Math.sin(i / 400 * 2 * Math.PI)]);
ring.push(ring[0]);
const f = ov.toOverlayFeature(src, { type: "Feature", geometry: { type: "Polygon", coordinates: [ring] },
  properties: { GMU: "10", BearZone: "9", GMU_PDF: "<Null>", HUNT_INFO: "http://www.wildlife.state.nm.us/hunting/" } });
assert.equal(f.properties._label, "GMU 10");
assert.deepEqual(Object.keys(f.properties), ["_label", "Bear zone", "Hunting info"]);
assert.ok(f.geometry.coordinates[0].length < ring.length, "simplified");
assert.equal(ov.toOverlayFeature(src, { type: "Feature", geometry: { type: "Polygon", coordinates: [ring] }, properties: { GMU: " " } }), null);
assert.equal(ov.toOverlayFeature(src, { type: "Feature", geometry: null, properties: { GMU: "1" } }), null);

// Every source is well-formed
for (const [id, s] of Object.entries(ov.SOURCES)) {
  assert.match(s.url, /^https:\/\//, id);
  assert.ok(/\{\w+\}/.test(s.label), `${id} label uses a field`);
  if (s.kind === "arcgis") assert.match(s.url, /\/(FeatureServer|MapServer)\/\d+$/, id);
}

// Fetching: ArcGIS with paging, without paging, and WFS
const poly = (x) => ({ type: "Polygon", coordinates: [[[x, 0], [x + 1, 0], [x + 1, 1], [x, 0]]] });
const calls = [];
globalThis.fetch = async (url) => {
  calls.push(url);
  const u = new URL(url);
  let body;
  if (u.hostname === "openmaps.gov.bc.ca") {
    body = { type: "FeatureCollection", features: [{ type: "Feature", geometry: poly(-120), properties: { WILDLIFE_MGMT_UNIT_ID: "3-17", REGION_RESPONSIBLE_NAME: "Thompson" } }] };
  } else if (u.pathname.includes("TPWD_WL_WTDMU")) {
    assert.equal(u.searchParams.get("resultOffset"), null, "no paging for TX");
    body = { type: "FeatureCollection", features: [{ type: "Feature", geometry: poly(-100), properties: { UnitNumber: "31 East" } }] };
  } else {
    const off = Number(u.searchParams.get("resultOffset"));
    assert.equal(u.searchParams.get("outSR"), "4326");
    const n = off === 0 ? 1000 : 54;
    body = { type: "FeatureCollection", features: Array.from({ length: n }, (_, i) => ({ type: "Feature", geometry: poly(-92), properties: { Area_Name: `Area ${off + i}`, County: "Boone", Map_Link: "https://mdc.mo.gov/x" } })) };
  }
  return new Response(JSON.stringify(body), { status: 200 });
};
const mo = await ov.buildOverlay("mo-lands");
assert.equal(mo.features.length, 1054, "paged");
assert.equal(mo.features[0].properties["Area map"], "https://mdc.mo.gov/x");
assert.equal((await ov.buildOverlay("tx-wtdmu")).features[0].properties._label, "Deer Unit 31 East");
const bc = await ov.buildOverlay("bc-wmu");
assert.equal(bc.features[0].properties._label, "MU 3-17");
assert.match(calls.find(c => c.includes("openmaps")), /srsName=EPSG:4326/);

// Route: builds once, then serves from cache; unknown ids are 404
const objects = {};
S3Client.prototype.send = async function (c) {
  const n = c.constructor.name, i = c.input;
  if (n === "HeadObjectCommand") { if (!objects[i.Key]) throw new Error("NotFound"); return { LastModified: objects[i.Key].at }; }
  if (n === "PutObjectCommand") { objects[i.Key] = { body: i.Body, at: new Date() }; return {}; }
  return {};
};
const { handler } = await import("../src/handler.mjs");
const relay = async (id) => { const r = await handler({ routeKey: "GET /v1/relay/{sourceId}", pathParameters: { sourceId: id }, headers: {} }); return { status: r.statusCode, body: JSON.parse(r.body) }; };
calls.length = 0;
let r = await relay("tx-wtdmu");
assert.equal(r.status, 200); assert.match(r.body.url, /overlays\/v2/); assert.equal(r.body.count, 1);
assert.equal(calls.length, 1);
r = await relay("tx-wtdmu");
assert.equal(calls.length, 1, "second request served from cache");
assert.equal((await relay("nope")).status, 404);
globalThis.fetch = async () => new Response("down", { status: 503 });
assert.equal((await relay("ks-dmu")).status, 502);
console.log("overlays ok");
