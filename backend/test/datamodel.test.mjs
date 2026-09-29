// The data model: datamodel.yaml (repo root) is enforced exactly, on every write path.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import yaml from "js-yaml";
const { validateFeature, validateDatasetFields, toCategory, CATEGORIES, FEATURE_FIELDS } = await import("../src/model.mjs");
const { toModelProperties } = await import("../src/importer.mjs").catch(() => ({}));

// 1. The Lambdas use exactly what datamodel.yaml says (run `npm run build` after editing it)
const fromYaml = yaml.load(readFileSync(new URL("../../datamodel.yaml", import.meta.url), "utf8"));
const bundled = JSON.parse(readFileSync(new URL("../src/datamodel.json", import.meta.url), "utf8"));
assert.deepEqual(bundled, fromYaml, "src/datamodel.json is out of date: run npm run build");
assert.deepEqual(CATEGORIES, ["location", "event", "alert"]);

const pt = (properties) => ({ type: "Feature", geometry: { type: "Point", coordinates: [-93.7, 32.5] }, properties });
const bad = (f, re) => assert.throws(() => validateFeature(f), re);

// 2. Features
validateFeature(pt({ name: "Airline High School", category: "location", description: "High school", source: "nces", externalId: "220015" }));
validateFeature(pt({ name: "x", category: "location", id: "ignored", datasetId: "ignored", createdAt: "x", updatedAt: "x" }));  // server fields ignored
bad(pt({ name: "x", category: "location", schoolLevel: "high" }), /"schoolLevel" isn't part of the data model/);
bad(pt({ name: "x", category: "school" }), /category must be one of: location, event, alert/);
bad(pt({ name: "x" }), /category is required/);
bad(pt({ category: "location" }), /name is required/);
bad(pt({ name: "x", category: "location", tags: ["a"] }), /"tags" isn't part of the data model/);
bad(pt({ name: "Flood", category: "alert", severity: "critical" }), /eventTime is required/);
validateFeature(pt({ name: "Flood", category: "alert", severity: "critical", eventTime: "2026-09-27T12:00:00Z" }));
bad(pt({ name: "Fair", category: "event", eventTime: "2026-09-27T12:00:00Z", severity: "info" }), /severity is only for alerts/);
bad(pt({ name: "x", category: "location", color: "red" }), /color/);
bad({ type: "Feature", geometry: { type: "Point", coordinates: [200, 32] }, properties: { name: "x", category: "location" } }, /geometry/);
bad({ type: "Feature", geometry: { type: "Blob", coordinates: [] }, properties: { name: "x", category: "location" } }, /geometry/);
assert.ok(!FEATURE_FIELDS.includes("tags"));

// 3. Datasets
validateDatasetFields({ name: "Schools", description: "All public schools", tags: ["education", "us-la"] });
assert.throws(() => validateDatasetFields({ name: "x", featureTypes: [] }), /"featureTypes" isn't part/);
assert.throws(() => validateDatasetFields({ name: "" }), /name/);
assert.throws(() => validateDatasetFields({ description: "ok", tags: ["BAD TAG!"] }, { partial: true }), /tags/);

// 4. Outside categories map onto the three
assert.equal(toCategory("Event"), "event"); assert.equal(toCategory("school"), "location"); assert.equal(toCategory(undefined), "location");

// 5. Imports keep only model fields; the rest becomes a short Details list in the description
if (toModelProperties) {
  const p = toModelProperties({ NAME: "Airline High School", STREET: "2801 Airline Dr", CITY: "Bossier City", CBSA: "43340", OBJECTID: 5, kind: "school" },
    { nameField: "NAME", categoryField: "kind", sourceId: "220015000123", sourceLabel: "import: Public School Locations", index: 0 });
  assert.deepEqual(Object.keys(p).sort(), ["category", "description", "externalId", "name", "source"]);
  assert.equal(p.category, "location");
  assert.match(p.description, /\*\*STREET:\*\* 2801 Airline Dr/);
  assert.match(p.description, /\*\*Type:\*\* school/);
  assert.doesNotMatch(p.description, /OBJECTID/);
  validateFeature(pt(p));
}

console.log("data model tests passed");
