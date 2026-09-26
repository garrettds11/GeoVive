// geometry.mjs — GeoJSON geometry checks, bounding boxes and simplification.
//
// Large shapes (a detailed hunting unit or forest boundary can be megabytes)
// don't fit in a DynamoDB item (400 KB). The API stores the full geometry in
// S3 and keeps a simplified preview in the table for drawing the map.

export const GEOMETRY_TYPES = new Set(["Point", "MultiPoint", "LineString", "MultiLineString", "Polygon", "MultiPolygon"]);

export const INLINE_LIMIT = 100_000;      // bytes of geometry JSON kept in the table as-is
export const PREVIEW_TARGET = 60_000;     // simplified preview must fit under this
export const MAX_GEOMETRY = 5_000_000;    // largest accepted geometry (Lambda request limit is 6 MB)
export const MAX_VERTICES = 500_000;

export class GeometryError extends Error {}

const DEPTH = { Point: 0, MultiPoint: 1, LineString: 1, MultiLineString: 2, Polygon: 2, MultiPolygon: 3 };

function checkPosition(p) {
  if (!Array.isArray(p) || p.length < 2) throw new GeometryError("Each position must be [lng, lat]");
  const [lng, lat] = p;
  if (!Number.isFinite(lng) || !Number.isFinite(lat) || lng < -180 || lng > 180 || lat < -90 || lat > 90) {
    throw new GeometryError("Coordinates must be [lng, lat] in WGS84 degrees within valid ranges");
  }
}

// Visit every position; `depth` is how many array levels sit above positions.
function eachPosition(coords, depth, fn) {
  if (depth === 0) return fn(coords);
  if (!Array.isArray(coords)) throw new GeometryError("Malformed coordinates");
  for (const c of coords) eachPosition(c, depth - 1, fn);
}

export function validateGeometry(g) {
  if (!g || typeof g !== "object" || !GEOMETRY_TYPES.has(g.type) || !Array.isArray(g.coordinates)) {
    throw new GeometryError(`geometry must be a GeoJSON geometry of type ${[...GEOMETRY_TYPES].join(", ")}`);
  }
  let n = 0;
  eachPosition(g.coordinates, DEPTH[g.type], p => {
    checkPosition(p);
    if (++n > MAX_VERTICES) throw new GeometryError(`geometry has more than ${MAX_VERTICES} vertices`);
  });
  if (n === 0) throw new GeometryError("geometry has no coordinates");
  const rings = g.type === "Polygon" ? g.coordinates : g.type === "MultiPolygon" ? g.coordinates.flat() : [];
  for (const r of rings) {
    const a = r[0], b = r[r.length - 1];
    if (r.length < 4 || a[0] !== b[0] || a[1] !== b[1]) throw new GeometryError("Polygon rings must be closed and have at least 4 positions");
  }
  return n;
}

export function bboxOf(g) {
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  eachPosition(g.coordinates, DEPTH[g.type], ([x, y]) => {
    if (x < w) w = x; if (x > e) e = x; if (y < s) s = y; if (y > n) n = y;
  });
  return [w, s, e, n];
}

export const byteSize = (g) => Buffer.byteLength(JSON.stringify(g));

// ---------------------------------------------------------------- simplify

function sqSegDist(p, a, b) {
  let x = a[0], y = a[1], dx = b[0] - x, dy = b[1] - y;
  if (dx || dy) {
    const t = ((p[0] - x) * dx + (p[1] - y) * dy) / (dx * dx + dy * dy);
    if (t > 1) { x = b[0]; y = b[1]; } else if (t > 0) { x += dx * t; y += dy * t; }
  }
  dx = p[0] - x; dy = p[1] - y;
  return dx * dx + dy * dy;
}

// Douglas–Peucker, iterative.
function simplifyLine(pts, sqTol) {
  if (pts.length <= 2) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [first, last] = stack.pop();
    let max = sqTol, idx = -1;
    for (let i = first + 1; i < last; i++) {
      const d = sqSegDist(pts[i], pts[first], pts[last]);
      if (d > max) { max = d; idx = i; }
    }
    if (idx > -1) { keep[idx] = 1; stack.push([first, idx], [idx, last]); }
  }
  return pts.filter((_, i) => keep[i]);
}

function simplifyRing(ring, sqTol) {
  const r = simplifyLine(ring, sqTol);
  return r.length >= 4 ? r : null;   // rings that collapse are dropped
}

const round = (p) => [Math.round(p[0] * 1e6) / 1e6, Math.round(p[1] * 1e6) / 1e6];

function simplifyWith(g, tol) {
  const sq = tol * tol;
  const line = (l) => simplifyLine(l.map(round), sq);
  const poly = (rings) => {
    const out = [];
    rings.forEach((r, i) => {
      const s = simplifyRing(r.map(round), sq);
      if (s) out.push(s); else if (i === 0) out.push(null);   // lost outer ring
    });
    return out[0] ? out : null;
  };
  switch (g.type) {
    case "Point": case "MultiPoint": return { type: g.type, coordinates: g.type === "Point" ? round(g.coordinates) : g.coordinates.map(round) };
    case "LineString": return { type: g.type, coordinates: line(g.coordinates) };
    case "MultiLineString": return { type: g.type, coordinates: g.coordinates.map(line) };
    case "Polygon": { const p = poly(g.coordinates); return p ? { type: g.type, coordinates: p } : null; }
    case "MultiPolygon": {
      const ps = g.coordinates.map(poly).filter(Boolean);
      return ps.length ? { type: g.type, coordinates: ps } : null;
    }
  }
}

// Simplify until the geometry fits in `target` bytes. Falls back to the bbox outline.
export function simplifyToFit(g, target = PREVIEW_TARGET) {
  const [w, s, e, n] = bboxOf(g);
  const span = Math.max(e - w, n - s) || 1e-6;
  for (let tol = span / 1e5; tol < span; tol *= 2) {
    const out = simplifyWith(g, tol);
    if (out && byteSize(out) <= target) return out;
  }
  return { type: "Polygon", coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] };
}
