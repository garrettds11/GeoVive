// Unit tests for geometry.mjs (no AWS).
import assert from "node:assert/strict";
import { validateGeometry, bboxOf, byteSize, simplifyToFit, GeometryError } from "../src/geometry.mjs";

// A wiggly circle with many vertices, like a detailed boundary.
export function bigPolygon(n = 60000, cx = -106, cy = 39) {
  const ring = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * 2 * Math.PI, r = 0.5 + 0.02 * Math.sin(i * 0.37) + 0.01 * Math.cos(i * 1.3);
    ring.push([+(cx + r * Math.cos(a)).toFixed(7), +(cy + r * Math.sin(a)).toFixed(7)]);
  }
  ring.push(ring[0]);
  return { type: "Polygon", coordinates: [ring] };
}

assert.equal(validateGeometry({ type: "Point", coordinates: [-106, 39] }), 1);
assert.throws(() => validateGeometry({ type: "Point", coordinates: [200, 39] }), GeometryError);
assert.throws(() => validateGeometry({ type: "LineString", coordinates: [[0, 0], [0, 95]] }), GeometryError);
assert.throws(() => validateGeometry({ type: "Polygon", coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1]]] }), /closed/);
assert.throws(() => validateGeometry({ type: "Circle", coordinates: [] }), GeometryError);

const big = bigPolygon();
validateGeometry(big);
const bb = bboxOf(big);
assert.ok(bb[0] < -106.4 && bb[2] > -105.6 && bb[1] < 38.6 && bb[3] > 39.4);
const size = byteSize(big);
const prev = simplifyToFit(big);
assert.equal(prev.type, "Polygon");
assert.ok(byteSize(prev) <= 60000, "preview fits");
validateGeometry(prev);                                   // still a valid closed polygon
assert.ok(prev.coordinates[0].length > 100, "preview keeps the shape");
console.log(`geometry ok: ${size} bytes -> preview ${byteSize(prev)} bytes, ${prev.coordinates[0].length} vertices`);
