// search.mjs — dataset metadata: tags, the search text, and search over public datasets.
//
// Each dataset stores `searchText`: its name, description and tags, lowercased and
// accent-folded, kept in sync on every create/update. Search reads the public
// datasets from the byVisibility index a page at a time, filters on the server
// with DynamoDB `contains` for each query word, then ranks the matches here:
// name matches first, then tags, then description.
//
// This is fast and free at the current scale (thousands of public datasets).
// If public datasets grow to tens of thousands, move ranking to a search index
// (for example OpenSearch Serverless) fed from the table's stream; the API
// below doesn't need to change.

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

// Relevance: every term must appear somewhere (the query already ensures that).
export function score(d, words, tag) {
  const name = fold(d.name), desc = fold(d.description), tags = (d.tags || []).map(fold);
  let s = 0;
  for (const w of words) {
    if (name === w) s += 12;
    else if (name.startsWith(w)) s += 8;
    else if (new RegExp(`\\b${w}`).test(name)) s += 6;
    else if (name.includes(w)) s += 4;
    if (tags.includes(w)) s += 5; else if (tags.some(t => t.includes(w))) s += 3;
    if (new RegExp(`\\b${w}`).test(desc)) s += 1.5; else if (desc.includes(w)) s += 1;
  }
  if (tag && tags.includes(tag)) s += 2;
  s += Math.min(2, Math.log10((d.featureCount || 0) + 1) / 2);   // gentle nudge toward maps with content
  return s;
}

const SCAN_LIMIT = 5000;   // public datasets examined per search (index pages of up to 1 MB)

export async function searchPublic(ddb, table, { q = "", tag = "", limit = 20 } = {}) {
  const words = terms(q);
  const t = tag ? cleanTags([tag])[0] : "";
  const names = { "#v": "visibility" }, values = { ":v": "public" };
  const filters = [];
  words.forEach((w, i) => { filters.push(`contains(searchText, :w${i})`); values[`:w${i}`] = w; });
  if (t) { filters.push("contains(tags, :tag)"); values[":tag"] = t; }
  let key, examined = 0;
  const hits = [];
  do {
    const res = await ddb.send(new QueryCommand({
      TableName: table, IndexName: "byVisibility",
      KeyConditionExpression: "#v = :v", ExpressionAttributeNames: names, ExpressionAttributeValues: values,
      ...(filters.length ? { FilterExpression: filters.join(" AND ") } : {}),
      ExclusiveStartKey: key
    }));
    examined += res.ScannedCount || 0;
    hits.push(...(res.Items || []));
    key = res.LastEvaluatedKey;
  } while (key && examined < SCAN_LIMIT);

  const ranked = words.length
    ? hits.map(d => ({ d, s: score(d, words, t) })).sort((a, b) => b.s - a.s || a.d.name.localeCompare(b.d.name))
    : hits.map(d => ({ d, s: 0 })).sort((a, b) => (b.d.featureCount || 0) - (a.d.featureCount || 0) || a.d.name.localeCompare(b.d.name));
  // Tag suggestions from everything that matched
  const counts = new Map();
  hits.forEach(d => (d.tags || []).forEach(x => counts.set(x, (counts.get(x) || 0) + 1)));
  const topTags = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 12).map(([name, count]) => ({ name, count }));
  return { total: hits.length, complete: !key, results: ranked.slice(0, Math.min(50, limit)).map(x => x.d), tags: topTags };
}
