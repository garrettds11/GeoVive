// Dataset metadata and search, with an in-memory table.
import assert from "node:assert/strict";
const { cleanTags, searchTextOf, terms, searchPublic, fold } = await import("../src/search.mjs");

assert.deepEqual(cleanTags(" Hiking, CAMPING,hiking , Café Spots "), ["hiking", "camping", "cafe spots"]);
assert.throws(() => cleanTags(Array.from({ length: 11 }, (_, i) => "t" + i)), /Up to 10/);
assert.equal(cleanTags(undefined), undefined);
assert.deepEqual(terms("  Élk  hunting, CO a "), ["elk", "hunting", "co"]);
assert.equal(fold("Réserve"), "reserve");
assert.equal(searchTextOf({ name: "Colorado Trails", description: "Best hikes", tags: ["hiking"] }), "colorado trails best hikes hiking");

const rows = [
  { datasetId: "1", name: "Colorado Trailheads", description: "Parking and trailheads", tags: ["hiking", "colorado"], featureCount: 120 },
  { datasetId: "2", name: "Coffee in Denver", description: "Cafés near trails", tags: ["food"], featureCount: 30 },
  { datasetId: "3", name: "World Capitals", description: "National capitals", tags: ["reference"], featureCount: 200 },
  { datasetId: "4", name: "Hiking huts", description: "Backcountry huts in Colorado", tags: ["hiking"], featureCount: 5 }
].map(d => ({ ...d, visibility: "public", searchText: searchTextOf(d) }));
const ddb = { async send(c) {
  const i = c.input; const v = i.ExpressionAttributeValues;
  let items = rows.filter(r => r.visibility === v[":v"]);
  if (i.FilterExpression) items = items.filter(r => Object.entries(v).filter(([k]) => /^:w/.test(k)).every(([, w]) => r.searchText.includes(w))
    && (!v[":tag"] || (r.tags || []).includes(v[":tag"])));
  return { Items: items, ScannedCount: rows.length };
} };
let r = await searchPublic(ddb, "t", { q: "colorado hiking" });
assert.deepEqual(r.results.map(d => d.datasetId), ["1", "4"], "name match ranks first");
r = await searchPublic(ddb, "t", { q: "trail" });
assert.equal(r.results[0].datasetId, "1");
assert.ok(r.results.some(d => d.datasetId === "2"), "description match found");
r = await searchPublic(ddb, "t", { tag: "hiking" });
assert.deepEqual(r.results.map(d => d.datasetId).sort(), ["1", "4"]);
r = await searchPublic(ddb, "t", {});
assert.equal(r.results[0].datasetId, "3", "empty query: biggest first");
assert.ok(r.tags.find(t => t.name === "hiking").count === 2, "tag facets");
console.log("search tests passed");
