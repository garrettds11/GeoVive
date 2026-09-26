// Writes config.js, the runtime settings the site reads as window.GEOVIVE_CONFIG.
// Values come from environment variables (set in Amplify for deploys), with
// defaults for the current GeoVivé environment. Only public values belong here:
// everything in config.js is visible to anyone who opens the site.
import { writeFileSync } from "node:fs";

const env = (name, fallback) => process.env[name] || fallback;

const token = process.env.MAPBOX_ACCESS_TOKEN;
if (!token) {
  throw new Error("MAPBOX_ACCESS_TOKEN is not set.");
}

const config = {
  MAPBOX_ACCESS_TOKEN: token,
  API_BASE: env("GEOVIVE_API_BASE", "https://api.geovive.link"),
  COGNITO_AUTHORITY: env("GEOVIVE_COGNITO_AUTHORITY", "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_cLqbEZJhi"),
  COGNITO_CLIENT_ID: env("GEOVIVE_COGNITO_CLIENT_ID", "hfchi8fm98nberrcj43ge2ipu"),
  COGNITO_DOMAIN: env("GEOVIVE_COGNITO_DOMAIN", "https://auth.geovive.link")
};

writeFileSync(
  "config.js",
  `window.GEOVIVE_CONFIG = ${JSON.stringify(config, null, 2)};\n`
);
console.log("Wrote config.js");
