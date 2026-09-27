// search.mjs — dataset metadata: tags, the search text, and search over public datasets.
//
// Tags are dataset-level (datamodel.yaml). Search is full-text: see searchPublic below.

import { QueryCommand } from "@aws-sdk/lib-dynamodb";

export const MAX_TAGS = 10;
const TAG = /^[a-z0-9][a-z0-9 -]{0,30}[a-z0-9]$|^[a-z0-9]$/;

export class MetaError extends Error {}

export const fold = s => String(s ?? "").normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase();

// Tags: lowercase words or short phrases (letters, numbers, spaces, dashes), up to 10.
export function cleanTags(input) {
  if (input === undefined || input === null) return undefined;
  const list = Array.isArray(input) ? input : String(input).split(",");
  const out = [];
  for (const raw of list) {
    const t = fold(raw).replace(/[^a-z0-9 -]/g, "").replace(/\s+/g, " ").trim().slice(0, 32).replace(/[- ]+$/, "");
    if (!t) continue;
    if (!TAG.test(t)) throw new MetaError(`Tag "${raw}" should be letters, numbers, spaces or dashes`);
    if (!out.includes(t)) out.push(t);
  }
  if (out.length > MAX_TAGS) throw new MetaError(`Up to ${MAX_TAGS} tags`);
  return out;
}

export function searchTextOf(d) {
  return fold([d.name, d.description, ...(d.tags || [])].filter(Boolean).join(" ")).replace(/\s+/g, " ").trim().slice(0, 2000);
}

export function terms(q) {
  return [...new Set(fold(q).replace(/[^a-z0-9 -]/g, " ").split(/\s+/).filter(w => w.length >= 2))].slice(0, 6);
}

// ------------------------------------------------------------------ full-text search
//
// A full-text index (MiniSearch) over every public dataset's name (weighted most), tags
// and description. It matches partial words ("trail" finds "Trailheads"), small typos
// ("colrado"), simple word forms ("schools" finds "school"), ignores accents and case,
// and ranks by relevance. The index is rebuilt from the table at most once a minute per
// Lambda instance: fine for thousands of public datasets. Past that, the same interface
// moves to a stored index or a search service (see DECISIONS).

import MiniSearch from "minisearch";

const STOP = new Set(["the", "of", "in", "and", "a", "an", "for", "to", "on", "at", "by", "with"]);
// Light English stemming: plural and common endings, enough for "schools"/"school", "hiking"/"hike"
export function stem(w) {
  if (w.length > 5 && w.endsWith("ies")) return w.slice(0, -3) + "y";
  if (w.length > 4 && /(ches|shes|sses|xes)$/.test(w)) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) return w.slice(0, -1);
  if (w.length > 5 && w.endsWith("ing")) return w.slice(0, -3);
  if (w.length > 4 && w.endsWith("ed")) return w.slice(0, -2);
  return w;
}
const processTerm = (t) => { const w = fold(t).replace(/[^a-z0-9]/g, ""); return !w || STOP.has(w) ? null : stem(w); };

const INDEX_TTL_MS = 60_000;
let cached = { at: 0, index: null, docs: [] };

async function publicDatasets(ddb, table) {
  const items = []; let key;
  do {
    const res = await ddb.send(new QueryCommand({ TableName: table, IndexName: "byVisibility",
      KeyConditionExpression: "#v = :v", ExpressionAttributeNames: { "#v": "visibility" }, ExpressionAttributeValues: { ":v": "public" },
      ExclusiveStartKey: key }));
    items.push(...(res.Items || [])); key = res.LastEvaluatedKey;
  } while (key);
  return items;
}

export function buildIndex(docs) {
  const index = new MiniSearch({
    idField: "datasetId",
    fields: ["name", "tagsText", "description"],
    extractField: (d, f) => f === "tagsText" ? (d.tags || []).join(" ") : d[f],
    processTerm,
    searchOptions: { boost: { name: 3, tagsText: 2, description: 1 }, prefix: (t) => t.length >= 3, fuzzy: (t) => t.length >= 5 ? 0.2 : false, processTerm }
  });
  index.addAll(docs);
  return index;
}

export function _resetSearchCache() { cached = { at: 0, index: null, docs: [] }; }

export async function searchPublic(ddb, table, { q = "", tag = "", limit = 20 } = {}) {
  if (!cached.index || Date.now() - cached.at > INDEX_TTL_MS) {
    const docs = await publicDatasets(ddb, table);
    cached = { at: Date.now(), index: buildIndex(docs), docs };
  }
  const t = tag ? cleanTags([tag])[0] : "";
  const byId = new Map(cached.docs.map(d => [d.datasetId, d]));
  const tagOk = (d) => !t || (d.tags || []).includes(t);
  let hits;
  const query = String(q).trim();
  if (query) {
    // Every word should match; if nothing does, fall back to any word
    let found = cached.index.search(query, { combineWith: "AND" });
    if (!found.length) found = cached.index.search(query, { combineWith: "OR" });
    hits = found.map(r => byId.get(r.id)).filter(d => d && tagOk(d));
  } else {
    hits = cached.docs.filter(tagOk).sort((a, b) => (b.featureCount || 0) - (a.featureCount || 0) || a.name.localeCompare(b.name));
  }
  const counts = new Map();
  hits.forEach(d => (d.tags || []).forEach(x => counts.set(x, (counts.get(x) || 0) + 1)));
  const topTags = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 12).map(([name, count]) => ({ name, count }));
  return { total: hits.length, complete: true, results: hits.slice(0, Math.min(50, limit)), tags: topTags };
}
