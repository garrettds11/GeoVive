// Dataset metadata and search, with an in-memory table.
import assert from "node:assert/strict";
const { cleanTags, searchTextOf, terms, searchPublic, fold, stem, _resetSearchCache } = await import("../src/search.mjs");

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
rows.push({ datasetId: "5", name: "Public Schools – Caddo & Bossier Parishes, LA", description: "Every public school in the two parishes", tags: ["education", "us-la"], featureCount: 93, visibility: "public" });
rows.push({ datasetId: "6", name: "Secret notes", description: "colorado", tags: [], featureCount: 1, visibility: "private" });
const ddb = { async send(c) { return { Items: rows.filter(r => r.visibility === c.input.ExpressionAttributeValues[":v"]) }; } };
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
// Robust matching
const ids = async (q, o = {}) => (await searchPublic(ddb, "t", { q, ...o })).results.map(d => d.datasetId);
assert.equal((await ids("high schools"))[0] ?? (await ids("schools"))[0], "5", "plural and partial words");
assert.deepEqual(await ids("schools louisiana"), ["5"], "falls back to any word when not all match");
assert.equal((await ids("colrado"))[0], "1", "typo tolerated");
assert.ok((await ids("capital")).includes("3"), "singular finds plural");
assert.ok((await ids("CAFE")).includes("2"), "accents and case ignored");
assert.ok(!(await ids("secret")).includes("6"), "private datasets never searched");
assert.equal(stem("schools"), "school"); assert.equal(stem("hiking"), "hik"); assert.equal(stem("categories"), "category");
console.log("search tests passed");
