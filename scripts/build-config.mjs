import { writeFileSync } from "node:fs";

const token = process.env.MAPBOX_ACCESS_TOKEN;

if (!token) {
  throw new Error("MAPBOX_ACCESS_TOKEN is not set.");
}

const config = {
  MAPBOX_ACCESS_TOKEN: token
};

writeFileSync(
  "config.js",
  `window.GEOVIVE_CONFIG = ${JSON.stringify(config, null, 2)};\n`
);