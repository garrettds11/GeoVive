// Export tests: format converters and the export route (mocked AWS).
import assert from "node:assert/strict";
Object.assign(process.env, { USER_POOL_ID: "us-east-1_TEST123", USER_POOL_CLIENT_ID: "abc",
  AWS_REGION: "us-east-1", AWS_ACCESS_KEY_ID: "test", AWS_SECRET_ACCESS_KEY: "test",
  DATASETS_TABLE: "d", FEATURES_TABLE: "f", GEOMETRY_BUCKET: "g", ALLOWED_ORIGINS: "https://geovive.link" });
const { toGeoJSON, toKML, toGPX, fileName } = await import("../src/export.mjs");
const { DynamoDBDocumentClient } = await import("@aws-sdk/lib-dynamodb");
const { S3Client } = await import("@aws-sdk/client-s3");

const ds = { datasetId: "ds1", name: "Élk 2027 — GMU 61!", description: "Scouting", visibility: "public", ownerId: "user-1",
  imports: [{ url: "https://gis.example.gov/FeatureServer/0", title: "Hunt units", attribution: "State wildlife agency", fetchedAt: "2026-09-26T00:00:00Z" }] };
const feats = [
  { type: "Feature", id: "a", geometry: { type: "Point", coordinates: [-105.5, 39.1] }, properties: { name: "Camp <1>", category: "camp", color: "#f59e0b", description: "Flat & dry", id: "a", datasetId: "ds1" } },
  { type: "Feature", id: "b", geometry: { type: "LineString", coordinates: [[-105.5, 39.1], [-105.4, 39.2]] }, properties: { name: "Trail", id: "b" } },
  { type: "Feature", id: "c", geometry: { type: "Polygon", coordinates: [[[-106, 39], [-105, 39], [-105, 40], [-106, 39]], [[-105.8, 39.2], [-105.7, 39.2], [-105.7, 39.3], [-105.8, 39.2]]] }, properties: { name: "Unit 61", sourceId: "61" } }
];

// File names are safe
assert.equal(fileName(ds.name, "kml"), "elk-2027-gmu-61.kml");
assert.equal(fileName("", "gpx"), "geovive-map.gpx");

// GeoJSON keeps geometry and records provenance
const gj = JSON.parse(toGeoJSON(ds, feats));
assert.equal(gj.features.length, 3);
assert.equal(gj.geovive.imports[0].attribution, "State wildlife agency");

// KML: escaped text, styles, inner rings, extended data
const kml = toKML(ds, feats);
assert.match(kml, /<name>Camp &lt;1&gt;<\/name>/);
assert.match(kml, /<description>Flat &amp; dry<\/description>/);
assert.match(kml, /<color>ff0b9ef5<\/color>/);              // #f59e0b as aabbggrr
assert.match(kml, /<innerBoundaryIs>/);
assert.match(kml, /<Data name="sourceId"><value>61<\/value>/);
assert.doesNotMatch(kml, /name="datasetId"/);
assert.match(kml, /State wildlife agency/);

// GPX: waypoint, track, polygon outline; attribution in metadata
const gpx = toGPX(ds, feats);
assert.equal((gpx.match(/<wpt /g) || []).length, 1);
assert.equal((gpx.match(/<trk>/g) || []).length, 2);
assert.match(gpx, /<wpt lat="39.1" lon="-105.5"><name>Camp &lt;1&gt;<\/name><desc>Flat &amp; dry<\/desc><type>camp<\/type>/);
assert.match(gpx, /copyright author="State wildlife agency"/);

// ---- route
const datasets = { ds1: ds, priv: { ...ds, datasetId: "priv", visibility: "private" } };
const items = [
  { datasetId: "ds1", featureId: "a", geometry: feats[0].geometry, properties: { name: "Camp" } },
  { datasetId: "ds1", featureId: "big", geometry: { type: "Polygon", coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] },
    geometryRef: { key: "geometry/ds1/big.json" }, bbox: [0, 0, 2, 2], properties: { name: "Big" } }
];
const full = { type: "Polygon", coordinates: [[[0, 0], [2, 0], [2, 2], [0, 2], [0, 0]]] };
const objects = { "geometry/ds1/big.json": JSON.stringify(full) };
DynamoDBDocumentClient.prototype.send = async function (c) {
  const n = c.constructor.name, i = c.input;
  if (i.TableName === "d" && n === "GetCommand") return { Item: datasets[i.Key.datasetId] };
  if (n === "QueryCommand") return { Items: items.filter(x => x.datasetId === i.ExpressionAttributeValues[":d"]) };
  return {};
};
S3Client.prototype.send = async function (c) {
  const n = c.constructor.name, i = c.input;
  if (n === "PutObjectCommand") { objects[i.Key] = { body: i.Body, disp: i.ContentDisposition, type: i.ContentType }; return {}; }
  if (n === "GetObjectCommand") return { Body: { transformToString: async () => objects[i.Key] } };
  return {};
};
const { handler } = await import("../src/handler.mjs");
const call = async (id, body, sub) => {
  const r = await handler({ routeKey: "POST /v1/datasets/{datasetId}/exports", pathParameters: { datasetId: id },
    headers: {}, requestContext: sub ? { authorizer: { jwt: { claims: { sub } } } } : {}, body: body && JSON.stringify(body) });
  return { status: r.statusCode, body: JSON.parse(r.body) };
};

// Public dataset, no sign-in, full geometry in the file
let r = await call("ds1", { format: "geojson" });
assert.equal(r.status, 200, JSON.stringify(r.body));
assert.equal(r.body.featureCount, 2);
assert.equal(r.body.fileName, "elk-2027-gmu-61.geojson");
assert.match(r.body.url, /^https:\/\/.*exports%2Fds1|^https:\/\/.*exports\/ds1/);
const stored = Object.entries(objects).find(([k]) => k.startsWith("exports/ds1/"))[1];
assert.equal(stored.disp, 'attachment; filename="elk-2027-gmu-61.geojson"');
const out = JSON.parse(stored.body);
assert.deepEqual(out.features.find(f => f.properties.name === "Big").geometry, full, "full detail, not the preview");
assert.equal(out.features[0].properties.geometryDetail, undefined);

// Other formats and errors
assert.equal((await call("ds1", { format: "kml" })).body.fileName, "elk-2027-gmu-61.kml");
assert.equal((await call("ds1", { format: "gpx" })).status, 200);
assert.equal((await call("ds1", { format: "shp" })).status, 400);
assert.equal((await call("priv", { format: "gpx" })).status, 404, "private map hidden from others");
assert.equal((await call("priv", { format: "gpx" }, "user-2")).status, 404);
assert.equal((await call("priv", { format: "gpx" }, "user-1")).status, 200, "owner can export");
console.log("export ok");
