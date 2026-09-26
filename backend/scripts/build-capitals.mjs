// Builds seed/world-capitals.json from Natural Earth 10m populated places (public domain).
// Usage: node scripts/build-capitals.mjs   (downloads source, writes seed file)
import { writeFileSync, mkdirSync } from "node:fs";

const SRC = "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_populated_places_simple.geojson";
const now = new Date().toISOString();

const src = await (await fetch(SRC)).json();
const items = src.features
  .filter(f => ["Admin-0 capital", "Admin-0 capital alt"].includes(f.properties.featurecla))
  .map(f => {
    const p = f.properties;
    return {
      datasetId: "world-capitals",
      featureId: `ne-${p.ne_id}`,
      geometry: { type: "Point", coordinates: [Number(p.longitude.toFixed(6)), Number(p.latitude.toFixed(6))] },
      properties: {
        name: p.name,
        category: "location",
        capitalType: p.featurecla === "Admin-0 capital" ? "national" : "alternate",
        country: p.adm0name,
        countryCode: p.adm0_a3,
        isoA2: p.iso_a2 && p.iso_a2 !== "-99" ? p.iso_a2 : undefined,
        population: p.pop_max > 0 ? p.pop_max : undefined,
        note: p.note || undefined,
        source: "Natural Earth 10m populated places",
        externalId: String(p.ne_id),
        license: "Public domain"
      },
      createdAt: now,
      updatedAt: now
    };
  });

const dataset = {
  datasetId: "world-capitals",
  name: "World Capitals",
  description: "National capitals of the world (Natural Earth). Alternate capitals marked capitalType=alternate.",
  visibility: "public",
  ownerId: "system",
  source: "https://www.naturalearthdata.com/",
  featureCount: items.length,
  createdAt: now,
  updatedAt: now
};

mkdirSync("seed", { recursive: true });
writeFileSync("seed/world-capitals.json", JSON.stringify({ dataset, items }));
console.log(`Wrote ${items.length} capitals to seed/world-capitals.json`);
