// export.mjs — turn a dataset's features into downloadable files.
//
//   geojson  FeatureCollection with full-detail geometry and a "geovive" block
//            (dataset name, export time, provenance/attribution of imports)
//   kml      Google Earth / most mapping apps (points, lines, polygons)
//   gpx      GPS units and outdoor apps: points → waypoints, lines → tracks,
//            polygons → closed tracks along their outer rings (GPX has no areas)

export const FORMATS = {
  geojson: { ext: "geojson", type: "application/geo+json" },
  kml: { ext: "kml", type: "application/vnd.google-earth.kml+xml" },
  gpx: { ext: "gpx", type: "application/gpx+xml" }
};

const INTERNAL = new Set(["id", "datasetId", "createdAt", "updatedAt", "geometryDetail", "color"]);

const xml = (v) => String(v ?? "").replace(/[<>&'"]/g, c => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" }[c]));

export function fileName(name, ext) {
  const base = String(name || "geovive-map").normalize("NFKD").replace(/[^\w\s-]/g, "").trim().replace(/\s+/g, "-").toLowerCase().slice(0, 60);
  return `${base || "geovive-map"}.${ext}`;
}

// Dataset-level metadata, including where imported data came from.
function metaOf(dataset, count) {
  return {
    dataset: dataset.name,
    datasetId: dataset.datasetId,
    description: dataset.description || undefined,
    source: dataset.source || undefined,
    exportedAt: new Date().toISOString(),
    featureCount: count,
    imports: (dataset.imports || []).map(i => ({
      source: i.url || i.fileName, title: i.title, attribution: i.attribution, fetchedAt: i.fetchedAt
    }))
  };
}

export function toGeoJSON(dataset, features) {
  return JSON.stringify({ type: "FeatureCollection", geovive: metaOf(dataset, features.length), features });
}

// ------------------------------------------------------------------ KML

const coordStr = (ring) => ring.map(([x, y]) => `${x},${y}`).join(" ");

function kmlGeometry(g) {
  switch (g.type) {
    case "Point": return `<Point><coordinates>${g.coordinates[0]},${g.coordinates[1]}</coordinates></Point>`;
    case "LineString": return `<LineString><tessellate>1</tessellate><coordinates>${coordStr(g.coordinates)}</coordinates></LineString>`;
    case "Polygon": return `<Polygon>${g.coordinates.map((r, i) =>
      `<${i ? "innerBoundaryIs" : "outerBoundaryIs"}><LinearRing><coordinates>${coordStr(r)}</coordinates></LinearRing></${i ? "innerBoundaryIs" : "outerBoundaryIs"}>`).join("")}</Polygon>`;
    case "MultiPoint": return `<MultiGeometry>${g.coordinates.map(c => kmlGeometry({ type: "Point", coordinates: c })).join("")}</MultiGeometry>`;
    case "MultiLineString": return `<MultiGeometry>${g.coordinates.map(c => kmlGeometry({ type: "LineString", coordinates: c })).join("")}</MultiGeometry>`;
    case "MultiPolygon": return `<MultiGeometry>${g.coordinates.map(c => kmlGeometry({ type: "Polygon", coordinates: c })).join("")}</MultiGeometry>`;
    default: return "";
  }
}

// KML colors are aabbggrr
function kmlColor(hex, alpha = "ff") {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex || "");
  return m ? `${alpha}${m[3]}${m[2]}${m[1]}`.toLowerCase() : null;
}

export function toKML(dataset, features) {
  const meta = metaOf(dataset, features.length);
  const credits = meta.imports.filter(i => i.attribution || i.source).map(i => [i.title, i.attribution, i.source].filter(Boolean).join(" — "));
  const placemarks = features.map(f => {
    const p = f.properties || {};
    const color = kmlColor(p.color);
    const style = color
      ? `<Style><IconStyle><color>${color}</color></IconStyle><LineStyle><color>${color}</color><width>2</width></LineStyle><PolyStyle><color>${kmlColor(p.color, "40")}</color></PolyStyle></Style>`
      : "";
    const data = Object.entries(p).filter(([k, v]) => !INTERNAL.has(k) && k !== "name" && k !== "description" && v !== undefined && v !== null)
      .map(([k, v]) => `<Data name="${xml(k)}"><value>${xml(typeof v === "object" ? JSON.stringify(v) : v)}</value></Data>`).join("");
    return `<Placemark><name>${xml(p.name)}</name>${p.description ? `<description>${xml(p.description)}</description>` : ""}${style}${data ? `<ExtendedData>${data}</ExtendedData>` : ""}${kmlGeometry(f.geometry)}</Placemark>`;
  }).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2"><Document>
<name>${xml(dataset.name)}</name>
<description>${xml([dataset.description, `Exported from GeoVivé ${meta.exportedAt}`, ...credits].filter(Boolean).join("\n"))}</description>
${placemarks}
</Document></kml>
`;
}

// ------------------------------------------------------------------ GPX

const pt = (tag, [lon, lat]) => `<${tag} lat="${lat}" lon="${lon}"/>`;

export function toGPX(dataset, features) {
  const meta = metaOf(dataset, features.length);
  const wpts = [], trks = [];
  for (const f of features) {
    const p = f.properties || {}, g = f.geometry;
    const head = `<name>${xml(p.name)}</name>${p.description ? `<desc>${xml(p.description)}</desc>` : ""}${p.category ? `<type>${xml(p.category)}</type>` : ""}`;
    const segs = (lines) => lines.map(l => `<trkseg>${l.map(c => pt("trkpt", c)).join("")}</trkseg>`).join("");
    switch (g.type) {
      case "Point": wpts.push(`<wpt lat="${g.coordinates[1]}" lon="${g.coordinates[0]}">${head}</wpt>`); break;
      case "MultiPoint": g.coordinates.forEach(c => wpts.push(`<wpt lat="${c[1]}" lon="${c[0]}">${head}</wpt>`)); break;
      case "LineString": trks.push(`<trk>${head}${segs([g.coordinates])}</trk>`); break;
      case "MultiLineString": trks.push(`<trk>${head}${segs(g.coordinates)}</trk>`); break;
      case "Polygon": trks.push(`<trk>${head}${segs([g.coordinates[0]])}</trk>`); break;
      case "MultiPolygon": trks.push(`<trk>${head}${segs(g.coordinates.map(poly => poly[0]))}</trk>`); break;
    }
  }
  const credits = meta.imports.filter(i => i.attribution).map(i => i.attribution).join("; ");
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="GeoVivé" xmlns="http://www.topografix.com/GPX/1/1">
<metadata><name>${xml(dataset.name)}</name>${dataset.description ? `<desc>${xml(dataset.description)}</desc>` : ""}${credits ? `<copyright author="${xml(credits)}"/>` : ""}<time>${meta.exportedAt}</time></metadata>
${wpts.join("\n")}
${trks.join("\n")}
</gpx>
`;
}

export function render(format, dataset, features) {
  if (format === "kml") return toKML(dataset, features);
  if (format === "gpx") return toGPX(dataset, features);
  return toGeoJSON(dataset, features);
}
