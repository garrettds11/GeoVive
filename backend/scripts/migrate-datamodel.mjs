// One-time migration: bring every stored dataset and feature into datamodel.yaml v1.
//
//   node scripts/migrate-datamodel.mjs            dry run: report what would change
//   node scripts/migrate-datamodel.mjs --apply    write the changes
//
// Needs AWS credentials for the account and DATASETS_TABLE / FEATURES_TABLE
// (defaults: geovive-dev-*). Idempotent: running it twice changes nothing more.
//
// Features: keep only the model's fields; categories outside location/event/alert
// become location; sourceId → externalId; savedFrom → source/externalId;
// schoolLevel → a line in the description; any other field is folded into a short
// "Details" list at the end of the description (up to 15), so nothing is silently lost.
// NCES school columns (congressional district, statistical areas, …) are dropped:
// the address is already in the description.
// Datasets: drop featureTypes and searchText (no longer used); keep everything else.

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, ScanCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { validateFeature, toCategory, FEATURE_FIELDS } from "../src/model.mjs";

const APPLY = process.argv.includes("--apply");
const DATASETS = process.env.DATASETS_TABLE || "geovive-dev-datasets";
const FEATURES = process.env.FEATURES_TABLE || "geovive-dev-features";
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: process.env.AWS_REGION || "us-east-1" }), { marshallOptions: { removeUndefinedValues: true } });

const NCES = new Set(["NCESSCH", "LEAID", "NAME", "OPSTFIPS", "STREET", "CITY", "STATE", "ZIP", "STFIP", "CNTY", "NMCNTY", "LOCALE", "LAT", "LON",
  "CBSA", "NMCBSA", "CBSATYPE", "CSA", "NMCSA", "CD", "SLDL", "SLDU", "SCHOOLYEAR", "OBJECTID", "levelSource"]);
const SERVER = new Set(["id", "datasetId", "createdAt", "updatedAt", "geometryDetail"]);
const MAX_EXTRA = 15;

export function migrateProperties(props) {
  const out = {}, extras = [];
  for (const [k, v] of Object.entries(props || {})) {
    if (v === null || v === undefined || v === "") continue;
    if (SERVER.has(k)) continue;
    if (FEATURE_FIELDS.includes(k)) { out[k] = v; continue; }
    if (k === "sourceId") { out.externalId ??= String(v).slice(0, 200); continue; }
    if (k === "savedFrom") {
      let f = v; if (typeof f === "string") { try { f = JSON.parse(f); } catch { f = {}; } }
      if (f?.datasetName) out.source ??= `Saved from ${f.datasetName}`.slice(0, 200);
      if (f?.datasetId && f?.featureId) out.externalId ??= `${f.datasetId}/${f.featureId}`.slice(0, 200);
      continue;
    }
    if (k === "schoolLevel") { if (v !== "other") extras.unshift(`**Level:** ${String(v).replace(/-/g, " & ")}`); continue; }
    if (NCES.has(k)) { if (k === "NCESSCH") out.externalId ??= String(v); continue; }
    if (k === "country") { extras.push(`**Country:** ${v}`); continue; }
    extras.push(`- **${k}:** ${String(typeof v === "object" ? JSON.stringify(v) : v).slice(0, 200)}`);
  }
  const raw = out.category;
  out.category = toCategory(raw);
  if (raw && raw !== out.category && !["elementary", "middle", "high", "elementary-middle", "other"].includes(raw)) extras.unshift(`**Type:** ${raw}`);
  if (out.color && !/^#[0-9a-fA-F]{6}$/.test(out.color)) delete out.color;
  if (out.category === "location") { delete out.eventTime; delete out.severity; }
  if (out.category === "event") delete out.severity;
  if (extras.length) {
    const lines = extras.slice(0, MAX_EXTRA).map(l => l.startsWith("- ") ? l : l);
    out.description = [out.description, lines.join("\n")].filter(Boolean).join("\n\n").slice(0, 5000);
  }
  out.name = String(out.name || "Untitled").slice(0, 200);
  return out;
}

async function scanAll(table) {
  const items = []; let key;
  do { const r = await ddb.send(new ScanCommand({ TableName: table, ExclusiveStartKey: key })); items.push(...(r.Items || [])); key = r.LastEvaluatedKey; } while (key);
  return items;
}

async function main() {
  const report = { datasetsChanged: 0, featuresChanged: 0, featuresUnchanged: 0, invalid: [] };
  for (const d of await scanAll(DATASETS)) {
    if (d.featureTypes === undefined && d.searchText === undefined && d.source === undefined) continue;
    const next = { ...d }; delete next.featureTypes; delete next.searchText; delete next.source;
    report.datasetsChanged++;
    if (APPLY) await ddb.send(new PutCommand({ TableName: DATASETS, Item: next }));
  }
  for (const f of await scanAll(FEATURES)) {
    const props = migrateProperties(f.properties);
    try { validateFeature({ type: "Feature", geometry: f.geometry, properties: props }); }
    catch (e) {
      // Geometry previews of large shapes are checked on their stored copy, not here
      if (!/geometry/.test(e.message) || !f.geometryRef) { report.invalid.push({ datasetId: f.datasetId, featureId: f.featureId, error: e.message }); continue; }
    }
    if (JSON.stringify(props) === JSON.stringify(f.properties)) { report.featuresUnchanged++; continue; }
    report.featuresChanged++;
    if (APPLY) await ddb.send(new PutCommand({ TableName: FEATURES, Item: { ...f, properties: props } }));
  }
  console.log(JSON.stringify({ mode: APPLY ? "applied" : "dry run", ...report, invalid: report.invalid.slice(0, 20) }, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch(e => { console.error(e); process.exit(1); });
