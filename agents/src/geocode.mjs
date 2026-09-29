// AWS Location Service Places geocoding (readiness doc 2.10, build-order item 7 -- deliberately
// deferred until the Curator itself was built, per the standing decision, and now built alongside
// it). Curator-only: an extracted record that comes with an address/place name instead of
// coordinates (common from the unstructured web-search fallback, and from some structured
// sources that publish addresses rather than lat/lon) gets geocoded here before it's written as a
// feature. Not Google Maps/Places -- standing decision, Google's ToS caching restrictions don't
// fit a dataset meant to be stored and served indefinitely.
//
// Uses the newer, standalone Places API (`geo-places`) rather than the older PlaceIndex-based
// Location Service API: no PlaceIndex resource to create/manage, and its IAM actions are
// resource-agnostic (Resource: "*" -- AWS doesn't support resource-level ARNs for geo-places
// actions), which is why the permissions boundary's entry for this looks different from the
// commented-out PlaceIndex stub it replaces.

import { GeoPlacesClient, GeocodeCommand } from "@aws-sdk/client-geo-places";

const geoPlaces = new GeoPlacesClient({});

// Returns { lat, lon } for the best match, or null if nothing came back. Callers decide what to
// do with null (skip the record) -- this module never throws for a no-match result, only for a
// genuine API/network failure, which the caller's own try/catch handles same as any other step.
export async function geocode(queryText) {
  const text = String(queryText || "").trim();
  if (!text) return null;
  const resp = await geoPlaces.send(new GeocodeCommand({ QueryText: text, MaxResults: 1 }));
  const top = resp.ResultItems?.[0];
  const point = top?.Position; // [lon, lat] per the Places API's own GeoJSON-style ordering
  if (!Array.isArray(point) || point.length !== 2) return null;
  return { lon: point[0], lat: point[1] };
}
