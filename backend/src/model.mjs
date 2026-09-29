// model.mjs — enforces the data model (datamodel.yaml at the repo root).
//
// Every write of a dataset or feature, from any path (app, imports, AppConnect,
// account-linked apps, agents), goes through these checks. src/datamodel.json is
// generated from datamodel.yaml by scripts/build-datamodel.mjs, and a test fails
// if they differ, so the rules here are always the published rules.

import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import model from "./datamodel.json" with { type: "json" };

export const MODEL_VERSION = model.version;
export const CATEGORIES = model.$defs.FeatureProperties.properties.category.enum;
export const FEATURE_FIELDS = Object.keys(model.$defs.FeatureProperties.properties);
const SERVER_FIELDS = ["id", "datasetId", "createdAt", "updatedAt", "geometryDetail"];

const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
ajv.addSchema(model, "datamodel");
const checkFeature = ajv.getSchema("datamodel#/$defs/Feature");
const checkDataset = ajv.getSchema("datamodel#/$defs/Dataset");
const checkLayerList = ajv.getSchema("datamodel#/$defs/LayerList");

export class ModelError extends Error {
  constructor(message, details) { super(message); this.details = details; this.status = 400; }
}

// Plain-language message from the first few schema errors.
function explain(errors, what) {
  const lines = (errors || []).slice(0, 5).map(e => {
    const where = e.instancePath.replace(/^\//, "").replace(/\//g, ".") || what;
    if (e.keyword === "additionalProperties") return `${where}: "${e.params.additionalProperty}" isn't part of the data model`;
    if (e.keyword === "enum") return `${where} must be one of: ${e.params.allowedValues.join(", ")}`;
    if (e.keyword === "required") return `${where}: ${e.params.missingProperty} is required`;
    if (e.keyword === "not") return `${where}: severity is only for alerts`;
    return `${where} ${e.message}`;
  });
  return [...new Set(lines)].join("; ");
}

// A feature as the client sends it: server-set fields are ignored, everything else must fit.
export function validateFeature(body) {
  if (!body || body.type !== "Feature") throw new ModelError("Body must be a GeoJSON Feature");
  const properties = { ...(body.properties || {}) };
  SERVER_FIELDS.forEach(k => delete properties[k]);
  // Empty optional strings mean "not set"
  for (const [k, v] of Object.entries(properties)) if (v === "" || v === null) delete properties[k];
  const feature = { type: "Feature", geometry: body.geometry, properties };
  if (!checkFeature(feature)) throw new ModelError(explain(checkFeature.errors, "feature"), checkFeature.errors);
  return feature;
}

// Dataset fields a client may set (name, description, tags, visibility); the rest is server-owned.
export function validateDatasetFields(fields, { partial = false } = {}) {
  const probe = { ...(partial ? { name: fields.name ?? "x" } : {}), ...fields };
  for (const [k, v] of Object.entries(probe)) if (v === undefined) delete probe[k];
  if (!checkDataset(probe)) throw new ModelError(explain(checkDataset.errors, "dataset"), checkDataset.errors);
  return fields;
}

export function validateLayerListSchema(json) {
  if (!checkLayerList(json)) throw new ModelError(explain(checkLayerList.errors, "layer list"), checkLayerList.errors);
  return json;
}

// Map a category from outside data onto the model's three (unknown → location).
export function toCategory(value) {
  const v = String(value ?? "").trim().toLowerCase();
  return CATEGORIES.includes(v) ? v : "location";
}
