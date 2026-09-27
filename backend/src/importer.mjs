// importer.mjs — background worker that imports outside data into a dataset.
//
// Started by POST /v1/datasets/{id}/imports (handler.mjs), which stores a job in
// the imports table and invokes this function asynchronously with { importId }.
//
// Sources:
//   upload  a GeoJSON file the user uploaded to S3 (uploads/<sub>/…)
//   url     a GeoJSON file at an https URL
//   arcgis  an ArcGIS REST layer (…/FeatureServer/<n> or …/MapServer/<n>), paged
//
// Every feature goes through the same checks as the API (featureItem), so
// large shapes land in S3 with a preview. The dataset keeps a provenance record
// (source, fetched-at, license/attribution) for each import.

import "./safelog.mjs";   // first: keeps personal information out of logs
import { GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { S3Client, GetObjectCommand, HeadObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { randomUUID } from "node:crypto";
import { toCategory } from "./model.mjs";
import {
  ddb, featureItem, batchWrite, deleteAllFeatures, deleteDatasetGeometry, loadDataset
} from "./handler.mjs";

const DATASETS_TABLE = process.env.DATASETS_TABLE;
const IMPORTS_TABLE = process.env.IMPORTS_TABLE;
const GEOMETRY_BUCKET = process.env.GEOMETRY_BUCKET;
const s3 = new S3Client({});

export const MAX_BYTES = 50_000_000;
export const MAX_FEATURES = 20_000;
const FETCH_TIMEOUT_MS = 60_000;
const NAME_FIELDS = ["name", "NAME", "Name", "title", "TITLE", "Title", "label", "LABEL",
  "UNIT_NAME", "UnitName", "unit_name", "FORESTNAME", "NAMELSAD", "STATE_NAME", "COUNTY_NAME"];

class ImportError extends Error {}

// Short provenance label stored on each imported feature (source field of the model)
function sourceLabel(job, meta) {
  if (meta?.title) return `import: ${meta.title}`;
  if (job.source.type === "upload") return `import: ${job.source.fileName || "uploaded file"}`;
  try { return `import: ${new URL(job.source.url).hostname}`; } catch { return "import"; }
}

// ------------------------------------------------------------------ job state

async function updateJob(importId, fields) {
  const names = {}, values = { ":u": new Date().toISOString() };
  const sets = ["updatedAt = :u"];
  Object.entries(fields).forEach(([k, v], i) => {
    names[`#f${i}`] = k; values[`:v${i}`] = v; sets.push(`#f${i} = :v${i}`);
  });
  await ddb.send(new UpdateCommand({
    TableName: IMPORTS_TABLE, Key: { importId },
    UpdateExpression: `SET ${sets.join(", ")}`, ExpressionAttributeNames: names, ExpressionAttributeValues: values
  }));
}

// ------------------------------------------------------------------ fetching

async function fetchJson(url, what) {
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), redirect: "follow" });
  if (!res.ok) throw new ImportError(`${what} returned HTTP ${res.status}`);
  const len = Number(res.headers.get("content-length") || 0);
  if (len > MAX_BYTES) throw new ImportError(`${what} is larger than 50 MB`);
  const text = await res.text();
  if (text.length > MAX_BYTES) throw new ImportError(`${what} is larger than 50 MB`);
  try { return JSON.parse(text); } catch { throw new ImportError(`${what} is not valid JSON`); }
}

async function readUpload(key) {
  const head = await s3.send(new HeadObjectCommand({ Bucket: GEOMETRY_BUCKET, Key: key }))
    .catch(() => { throw new ImportError("The uploaded file was not found (uploads expire after 15 minutes)"); });
  if (head.ContentLength > MAX_BYTES) throw new ImportError("The uploaded file is larger than 50 MB");
  const res = await s3.send(new GetObjectCommand({ Bucket: GEOMETRY_BUCKET, Key: key }));
  const text = await res.Body.transformToString();
  try { return JSON.parse(text); } catch { throw new ImportError("The uploaded file is not valid JSON"); }
}

// Accept a FeatureCollection, a Feature, or a bare geometry. GeoJSON must be WGS84.
export function toFeatures(gj) {
  if (!gj || typeof gj !== "object") throw new ImportError("Not a GeoJSON object");
  const crs = gj.crs?.properties?.name;
  if (crs && !/CRS84|EPSG::?4326|WGS ?84/i.test(crs)) {
    throw new ImportError(`Coordinates are in ${crs}; GeoVivé needs WGS 84 longitude/latitude (EPSG:4326)`);
  }
  if (gj.type === "FeatureCollection" && Array.isArray(gj.features)) return gj.features;
  if (gj.type === "Feature") return [gj];
  if (typeof gj.type === "string" && Array.isArray(gj.coordinates)) return [{ type: "Feature", geometry: gj, properties: {} }];
  throw new ImportError("Expected a GeoJSON FeatureCollection, Feature or geometry");
}

// ArcGIS REST layer: read its description, then page through features as GeoJSON in WGS84.
export function arcgisLayerUrl(raw) {
  const u = new URL(raw);
  u.search = ""; u.hash = "";
  u.pathname = u.pathname.replace(/\/(query|info)\/?$/i, "").replace(/\/+$/, "");
  if (!/\/(FeatureServer|MapServer)\/\d+$/i.test(u.pathname)) {
    throw new ImportError("ArcGIS URL must point to a layer, e.g. …/FeatureServer/0 or …/MapServer/2");
  }
  return u.toString();
}

async function readArcgis(source, onProgress) {
  const layerUrl = arcgisLayerUrl(source.url);
  const info = await fetchJson(`${layerUrl}?f=json`, "The ArcGIS layer");
  if (info.error) throw new ImportError(`ArcGIS: ${info.error.message || "layer error"}`);
  if (info.type && !/Feature Layer/i.test(info.type)) throw new ImportError(`That ArcGIS item is a ${info.type}, not a feature layer`);
  const where = source.where || "1=1";
  const pageSize = Math.min(info.maxRecordCount || 1000, 2000);
  const common = `where=${encodeURIComponent(where)}&outFields=*&returnGeometry=true&outSR=4326&geometryPrecision=6&f=geojson`;
  const features = [];
  const canPage = info.advancedQueryCapabilities?.supportsPagination ?? info.supportsPagination;

  if (canPage) {
    for (let offset = 0; ; offset += pageSize) {
      const page = await fetchJson(`${layerUrl}/query?${common}&resultOffset=${offset}&resultRecordCount=${pageSize}`, "The ArcGIS query");
      if (page.error) throw new ImportError(`ArcGIS: ${page.error.message || "query error"}`);
      const got = page.features || [];
      features.push(...got);
      await onProgress(features.length);
      if (features.length > MAX_FEATURES) break;
      if (!got.length || !(page.exceededTransferLimit || page.properties?.exceededTransferLimit || got.length === pageSize)) break;
    }
  } else {
    const ids = await fetchJson(`${layerUrl}/query?where=${encodeURIComponent(where)}&returnIdsOnly=true&f=json`, "The ArcGIS query");
    if (ids.error) throw new ImportError(`ArcGIS: ${ids.error.message || "query error"}`);
    const all = (ids.objectIds || []).sort((a, b) => a - b);
    if (all.length > MAX_FEATURES) throw new ImportError(`The layer has ${all.length} features; the limit is ${MAX_FEATURES}. Narrow it with a filter.`);
    for (let i = 0; i < all.length; i += pageSize) {
      const page = await fetchJson(`${layerUrl}/query?objectIds=${all.slice(i, i + pageSize).join(",")}&outFields=*&returnGeometry=true&outSR=4326&geometryPrecision=6&f=geojson`, "The ArcGIS query");
      if (page.error) throw new ImportError(`ArcGIS: ${page.error.message || "query error"}`);
      features.push(...(page.features || []));
      await onProgress(features.length);
    }
  }
  return {
    features,
    meta: {
      title: info.name,
      attribution: (info.copyrightText || "").slice(0, 500) || undefined,
      idField: info.objectIdField
    }
  };
}

// ------------------------------------------------------------------ mapping

// Property lookup that ignores letter case (ArcGIS GeoJSON often lowercases field names).
export function getProp(props, field) {
  if (!field) return undefined;
  if (field in props) return props[field];
  const k = Object.keys(props).find(k => k.toLowerCase() === field.toLowerCase());
  return k === undefined ? undefined : props[k];
}

const filled = (x) => x !== undefined && x !== null && String(x).trim() !== "";

export function pickName(props, nameField, index) {
  const v = nameField ? getProp(props, nameField)
    : NAME_FIELDS.map(f => getProp(props, f)).find(filled)
      ?? Object.entries(props).find(([k, x]) => /name$/i.test(k) && typeof x === "string" && filled(x))?.[1];
  const s = v === undefined || v === null ? "" : String(v).trim();
  return s ? s.slice(0, 200) : `Feature ${index + 1}`;
}

// Source columns that aren't part of the data model become a short "Details" list
// at the end of the description (up to 15 fields), so nothing is silently lost
// and no new fields are created.
const DESC_FIELDS = ["description", "DESCRIPTION", "Description", "desc", "notes", "NOTES", "Notes", "summary"];
const MAX_EXTRA = 15;
export function toModelProperties(props, { nameField, categoryField, sourceId, sourceLabel, index }) {
  const name = pickName(props, nameField, index);
  const used = new Set(Object.keys(props).filter(k => [nameField, categoryField].some(f => f && k.toLowerCase() === f.toLowerCase())));
  NAME_FIELDS.forEach(f => { if (getProp(props, f) === name) used.add(Object.keys(props).find(k => k.toLowerCase() === f.toLowerCase())); });
  const descKey = DESC_FIELDS.map(f => Object.keys(props).find(k => k === f)).find(Boolean);
  if (descKey) used.add(descKey);
  const rawCategory = categoryField ? getProp(props, categoryField) : undefined;
  const extras = Object.entries(props).filter(([k, v]) => !used.has(k) && filled(v) && !/^(objectid|fid|shape_?(area|length|leng)|globalid)$/i.test(k));
  const lines = extras.slice(0, MAX_EXTRA).map(([k, v]) => `- **${k}:** ${String(v).slice(0, 200)}`);
  if (filled(rawCategory) && toCategory(rawCategory) !== String(rawCategory).trim().toLowerCase()) lines.unshift(`- **Type:** ${String(rawCategory).slice(0, 100)}`);
  const parts = [descKey ? String(props[descKey]).trim() : "", lines.length ? lines.join("\n") : ""].filter(Boolean);
  const out = { name, category: toCategory(rawCategory) };
  const description = parts.join("\n\n").slice(0, 5000);
  if (description) out.description = description;
  if (sourceId !== undefined && filled(sourceId)) out.externalId = String(sourceId).slice(0, 200);
  if (sourceLabel) out.source = String(sourceLabel).slice(0, 200);
  return out;
}

function cleanProps(raw) {
  const out = {};
  for (const [k, v] of Object.entries(raw || {})) {
    if (v === null || v === undefined || v === "") continue;
    if (typeof v === "object") { out[k] = JSON.stringify(v).slice(0, 2000); continue; }
    out[k] = typeof v === "string" ? v.slice(0, 2000) : v;
  }
  return out;
}

// ------------------------------------------------------------------ run

export async function runImport(importId) {
  const { Item: job } = await ddb.send(new GetCommand({ TableName: IMPORTS_TABLE, Key: { importId } }));
  if (!job || job.status !== "queued") return;
  await updateJob(importId, { status: "running", message: "Reading the source…" });

  try {
    const dataset = await loadDataset(job.datasetId);
    if (dataset.ownerId !== job.ownerId) throw new ImportError("Only the dataset owner can import into it");

    // 1. Read
    let features, meta = {};
    const progress = (n) => updateJob(importId, { message: `Read ${n} features…` });
    if (job.source.type === "upload") features = toFeatures(await readUpload(job.source.key));
    else if (job.source.type === "url") features = toFeatures(await fetchJson(job.source.url, "The GeoJSON URL"));
    else ({ features, meta } = await readArcgis(job.source, progress));
    if (!features.length) throw new ImportError("The source has no features");
    if (features.length > MAX_FEATURES) throw new ImportError(`The source has ${features.length} features; the limit is ${MAX_FEATURES}`);

    // 2. Replace mode clears the dataset first
    if (job.mode === "replace") {
      await updateJob(importId, { message: "Clearing the existing features…" });
      await deleteAllFeatures(job.datasetId);
      await deleteDatasetGeometry(job.datasetId);
    }

    // 3. Validate and write, 25 at a time
    const errors = [];
    let imported = 0, skipped = 0, batch = [];
    const flush = async () => { if (batch.length) { await batchWrite(batch.map(Item => ({ PutRequest: { Item } }))); batch = []; } };
    for (let i = 0; i < features.length; i++) {
      const f = features[i];
      const props = cleanProps(f?.properties);
      const sourceId = f?.id ?? getProp(props, meta.idField);
      const properties = toModelProperties(props, { nameField: job.nameField, categoryField: job.categoryField,
        sourceId, sourceLabel: sourceLabel(job, meta), index: i });
      try {
        batch.push(await featureItem(job.datasetId, randomUUID(), { type: "Feature", geometry: f?.geometry, properties }));
        imported++;
      } catch (e) {
        skipped++;
        if (errors.length < 10) errors.push(`Feature ${i + 1}: ${e.message}`);
      }
      if (batch.length === 25) await flush();
      if ((i + 1) % 500 === 0) await updateJob(importId, { message: `Saved ${imported} of ${features.length}…`, imported, skipped });
    }
    await flush();

    // 4. Count and provenance on the dataset
    const record = {
      importId, type: job.source.type,
      url: job.source.url, fileName: job.source.fileName,
      title: meta.title, attribution: meta.attribution,
      mode: job.mode, imported, skipped, fetchedAt: new Date().toISOString()
    };
    Object.keys(record).forEach(k => record[k] === undefined && delete record[k]);
    const history = [record, ...(dataset.imports || [])].slice(0, 20);
    await ddb.send(new UpdateCommand({
      TableName: DATASETS_TABLE, Key: { datasetId: job.datasetId },
      UpdateExpression: job.mode === "replace"
        ? "SET featureCount = :n, imports = :h, updatedAt = :u"
        : "SET imports = :h, updatedAt = :u ADD featureCount :n",
      ExpressionAttributeValues: { ":n": imported, ":h": history, ":u": new Date().toISOString() }
    }));

    await updateJob(importId, {
      status: imported ? "succeeded" : "failed", imported, skipped, errors,
      message: imported ? `Imported ${imported} feature${imported === 1 ? "" : "s"}${skipped ? `, skipped ${skipped}` : ""}.` : "No features could be imported."
    });
  } catch (e) {
    console.error("Import failed", importId, e);
    await updateJob(importId, { status: "failed", message: e instanceof ImportError ? e.message : "The import failed unexpectedly." });
  } finally {
    if (job.source.type === "upload") {
      await s3.send(new DeleteObjectCommand({ Bucket: GEOMETRY_BUCKET, Key: job.source.key })).catch(() => {});
    }
  }
}

export const handler = async (event) => runImport(event.importId);
