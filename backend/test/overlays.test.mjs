// App layers and relay: layer-list validation, fetching (mocked), routes and caching.
import assert from "node:assert/strict";
Object.assign(process.env, { USER_POOL_ID: "us-east-1_TEST123", USER_POOL_CLIENT_ID: "abc",
  AWS_REGION: "us-east-1", AWS_ACCESS_KEY_ID: "test", AWS_SECRET_ACCESS_KEY: "test",
  DATASETS_TABLE: "d", FEATURES_TABLE: "f", GEOMETRY_BUCKET: "g", ALLOWED_ORIGINS: "https://geovive.link" });
const ov = await import("../src/overlays.mjs");
const { S3Client } = await import("@aws-sdk/client-s3");

// Values and labels
assert.equal(ov.cleanValue(" "), undefined);
assert.equal(ov.cleanValue("<Null>"), undefined);
assert.equal(ov.cleanValue('<a href="http://www.azgfd.gov/unit_1.shtml">Unit 1</a>'), "http://www.azgfd.gov/unit_1.shtml");
assert.equal(ov.cleanValue(12.3456), 12.35);
assert.equal(ov.renderLabel("GMU {gmuid}", { GMUID: 61 }), "GMU 61", "case-insensitive fields");

// Layer lists: validation
const good = { title: "Hunt layers", layers: [
  { id: "co-gmu", name: "GMUs", group: "Colorado", color: "#f59e0b", attribution: "CPW",
    source: { type: "arcgis", url: "https://services5.arcgis.com/x/arcgis/rest/services/CPW/FeatureServer/6" },
    label: "GMU {GMUID}", fields: { COUNTY: "County", "bad key!": "x" }, extra: "ignored" },
  { id: "bc", name: "BC WMUs", source: { type: "wfs", url: "https://openmaps.gov.bc.ca/geo/pub/wfs", typeName: "pub:WMU" }, label: "MU {ID}" },
  { id: "ak", name: "AK", source: { type: "arcgis", url: "https://gis.adfg.alaska.gov/ags/rest/services/x/FeatureServer/4" }, label: "Unit {SubLabel}", delivery: "direct" }
] };
const list = ov.validateLayerList(good);
assert.equal(list.layers.length, 3);
assert.deepEqual(list.layers[0].fields, { COUNTY: "County" });
assert.equal(list.layers[0].extra, undefined);
assert.equal(list.layers[0].delivery, "relay");
assert.equal(list.layers[0].cacheHours, 24);
const bad = (layers, re) => assert.throws(() => ov.validateLayerList({ layers }), re);
bad([{ id: "x", name: "x", source: { type: "arcgis", url: "http://insecure.gov/FeatureServer/0" }, label: "{A}" }], /https/);
bad([{ id: "x", name: "x", source: { type: "arcgis", url: "https://10.0.0.1/FeatureServer/0" }, label: "{A}" }], /public host/);
bad([{ id: "x", name: "x", source: { type: "arcgis", url: "https://a.gov/rest/services/Foo" }, label: "{A}" }], /FeatureServer/);
bad([{ id: "x", name: "x", source: { type: "ftp", url: "https://a.gov/x" }, label: "{A}" }], /source.type/);
bad([{ id: "x", name: "x", source: { type: "geojson", url: "https://a.gov/x.json" }, label: "no fields" }], /label/);
bad([{ id: "x y", name: "x", source: { type: "geojson", url: "https://a.gov/x.json" }, label: "{A}" }], /id/);
bad([good.layers[0], good.layers[0]], /Duplicate/);
assert.throws(() => ov.validateLayerList({}), /layers array/);

// Browsers get display settings; sources only for direct layers
const pub = list.layers.map(ov.publicLayer);
assert.equal(pub[0].source, undefined);
assert.equal(pub[2].source.url, "https://gis.adfg.alaska.gov/ags/rest/services/x/FeatureServer/4");

// Features: empty records dropped, fields renamed, polygons simplified
const ring = Array.from({ length: 400 }, (_, i) => [-106 + Math.cos(i / 400 * 2 * Math.PI), 35 + Math.sin(i / 400 * 2 * Math.PI)]);
ring.push(ring[0]);
const layer = ov.validateLayerList({ layers: [{ id: "nm", name: "NM", source: { type: "geojson", url: "https://a.gov/x.json" },
  label: "GMU {GMU}", fields: { BearZone: "Bear zone", GMU_PDF: "Unit map" } }] }).layers[0];
const f = ov.toOverlayFeature(layer, { type: "Feature", geometry: { type: "Polygon", coordinates: [ring] }, properties: { GMU: "10", BearZone: "9", GMU_PDF: "<Null>" } });
assert.equal(f.properties._label, "GMU 10");
assert.deepEqual(Object.keys(f.properties), ["_label", "Bear zone"]);
assert.ok(f.geometry.coordinates[0].length < ring.length, "simplified");
assert.equal(ov.toOverlayFeature(layer, { type: "Feature", geometry: { type: "Polygon", coordinates: [ring] }, properties: { GMU: " " } }), null);

// Fetching: ArcGIS with paging, WFS, GeoJSON
const poly = (x) => ({ type: "Polygon", coordinates: [[[x, 0], [x + 1, 0], [x + 1, 1], [x, 0]]] });
const calls = [];
const hunt = { title: "Hunt", layers: [
  { id: "mo-lands", name: "MO lands", source: { type: "arcgis", url: "https://gisblue.mdc.mo.gov/arcgis/rest/services/B/MapServer/0" }, label: "{Area_Name}", fields: { County: "County" } },
  { id: "bc-wmu", name: "BC", source: { type: "wfs", url: "https://openmaps.gov.bc.ca/geo/pub/wfs", typeName: "pub:WMU" }, label: "MU {ID}" },
  { id: "own", name: "Own", source: { type: "geojson", url: "https://hunt.bowandarrow.fyi/data/own.geojson" }, label: "{name}" },
  { id: "ak", name: "AK", source: { type: "arcgis", url: "https://gis.adfg.alaska.gov/x/FeatureServer/4" }, label: "Unit {U}", delivery: "direct" }
] };
let listVersion = hunt;
globalThis.fetch = async (url) => {
  calls.push(String(url));
  const u = new URL(url);
  let body;
  if (u.pathname === "/geovive-layers.json") body = listVersion;
  else if (u.hostname === "openmaps.gov.bc.ca") body = { type: "FeatureCollection", features: [{ type: "Feature", geometry: poly(-120), properties: { ID: "3-17" } }] };
  else if (u.hostname === "hunt.bowandarrow.fyi") body = { type: "FeatureCollection", features: [{ type: "Feature", geometry: poly(-105), properties: { name: "Camp spot" } }] };
  else {
    const off = Number(u.searchParams.get("resultOffset"));
    assert.equal(u.searchParams.get("outSR"), "4326");
    const n = off === 0 ? 1000 : 54;
    body = { type: "FeatureCollection", features: Array.from({ length: n }, (_, i) => ({ type: "Feature", geometry: poly(-92), properties: { Area_Name: `Area ${off + i}`, County: "Boone" } })) };
  }
  return new Response(JSON.stringify(body), { status: 200 });
};
const hl = ov.validateLayerList(hunt).layers;
assert.equal((await ov.buildLayer(hl[0])).features.length, 1054, "paged");
assert.equal((await ov.buildLayer(hl[1])).features[0].properties._label, "MU 3-17");
assert.match(calls.find(c => c.includes("openmaps")), /srsName=EPSG:4326/);
assert.equal((await ov.buildLayer(hl[2])).features[0].properties._label, "Camp spot");

// Routes
const objects = {};
S3Client.prototype.send = async function (c) {
  const n = c.constructor.name, i = c.input;
  if (n === "HeadObjectCommand") { if (!objects[i.Key]) throw new Error("NotFound"); return { LastModified: objects[i.Key].at }; }
  if (n === "PutObjectCommand") { objects[i.Key] = { body: i.Body, at: new Date() }; return {}; }
  return {};
};
const { handler } = await import("../src/handler.mjs");
const get = async (routeKey, pathParameters) => { const r = await handler({ routeKey, pathParameters, headers: {} }); return { status: r.statusCode, body: JSON.parse(r.body) }; };

// The app's list is read from its own site; browsers get no relayed source URLs
let r = await get("GET /v1/apps/{appId}/layers", { appId: "bowandarrow-hunt" });
assert.equal(r.status, 200, JSON.stringify(r.body));
assert.equal(r.body.appName, "Bow & Arrow Hunt");
assert.equal(r.body.layers.length, 4);
assert.equal(r.body.layers[0].source, undefined);
assert.equal(r.body.layers[3].delivery, "direct");
assert.ok(calls.includes("https://hunt.bowandarrow.fyi/geovive-layers.json"));
assert.equal((await get("GET /v1/apps/{appId}", { appId: "bowandarrow-hunt" })).body.hasLayers, true);

// Relay: builds once, then serves from cache
calls.length = 0;
r = await get("GET /v1/relay/{appId}/{layerId}", { appId: "bowandarrow-hunt", layerId: "bc-wmu" });
assert.equal(r.status, 200, JSON.stringify(r.body)); assert.match(r.body.url, /overlays\/v3\/bowandarrow-hunt\/bc-wmu/); assert.equal(r.body.count, 1);
const n1 = calls.length;
await get("GET /v1/relay/{appId}/{layerId}", { appId: "bowandarrow-hunt", layerId: "bc-wmu" });
assert.equal(calls.length, n1, "served from cache");
assert.equal((await get("GET /v1/relay/{appId}/{layerId}", { appId: "bowandarrow-hunt", layerId: "nope" })).status, 404);
assert.equal((await get("GET /v1/relay/{appId}/{layerId}", { appId: "bowandarrow-hunt", layerId: "ak" })).status, 400, "direct layers aren't relayed");
assert.equal((await get("GET /v1/relay/{appId}/{layerId}", { appId: "nobody", layerId: "x" })).status, 404);

// The demo app's inline list works without fetching anything
r = await get("GET /v1/apps/{appId}/layers", { appId: "geovive-demo" });
assert.equal(r.body.layers[0].id, "national-forests");

// A source that's down is a 502
globalThis.fetch = async () => new Response("down", { status: 503 });
assert.equal((await get("GET /v1/relay/{appId}/{layerId}", { appId: "bowandarrow-hunt", layerId: "mo-lands" })).status, 502);
console.log("overlays ok");
