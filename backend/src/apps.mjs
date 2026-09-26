// Registry of connected apps allowed to send users to GeoVivé with /open links.
//
// Phase 2: a static list reviewed in code. Phase 3 moves this to a table with
// OAuth clients and a consent screen.
//
// returnOrigins: where "Done" may send the user back to (exact origins only).
// areaOrigins:   where reference-area GeoJSON may be loaded from.
// featureTypes:  the app's pin vocabulary (GeoVivé stores it, the app defines it).

const SITE_ORIGINS = (process.env.ALLOWED_ORIGINS || "https://geovive.link")
  .split(",").map(s => s.trim()).filter(Boolean);

export const APPS = {
  "geovive-demo": {
    name: "GeoVivé demo",
    // GeoVivé's own sites: the API's allowed origins (set at deploy time)
    returnOrigins: SITE_ORIGINS,
    areaOrigins: SITE_ORIGINS,
    featureTypes: [
      { key: "location", label: "Location", color: "#3b82f6" },
      { key: "event", label: "Event", color: "#22c55e" },
      { key: "alert", label: "Alert", color: "#f97316" }
    ]
  },
  "bowandarrow-hunt": {
    name: "Bow & Arrow Hunt",
    returnOrigins: ["https://hunt.bowandarrow.fyi", "http://localhost:5173"],
    areaOrigins: ["https://hunt.bowandarrow.fyi", "http://localhost:5173"],
    featureTypes: [
      { key: "glassing", label: "Glassing spot", color: "#22c55e" },
      { key: "camp", label: "Camp", color: "#f59e0b" },
      { key: "water", label: "Water", color: "#3b82f6" },
      { key: "access", label: "Access / trailhead", color: "#a855f7" },
      { key: "sign", label: "Sign", color: "#ef4444" }
    ]
  }
};

export function getApp(appId) {
  return Object.prototype.hasOwnProperty.call(APPS, appId) ? APPS[appId] : null;
}

// True when url is http(s) and its origin is exactly one of the allowed origins.
export function originAllowed(url, allowed) {
  try {
    const u = new URL(url);
    return (u.protocol === "https:" || u.protocol === "http:") && allowed.includes(u.origin);
  } catch {
    return false;
  }
}
