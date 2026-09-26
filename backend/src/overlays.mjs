// overlays.mjs — the relay for hunting-unit (and other vector) overlays.
//
// Each source is an official agency map service. The relay fetches the whole
// layer once, simplifies shapes for display, keeps only useful fields (with
// readable names), cleans values, and caches the result in S3 for a day.
// Browsers then load one small file, whether or not the agency allows
// cross-site requests.
//
// Only sources listed here can be relayed (no open proxy).

import { simplifyGeometry } from "./geometry.mjs";

const H = 60 * 60 * 1000;
export const CACHE_MS = 24 * H;
const FETCH_TIMEOUT_MS = 20_000;
const TOLERANCE = 0.0005;            // degrees (~50 m): fine for viewing, not for legal boundaries

// label: text template using {FIELD}; fields: FIELD -> label shown in the popup (order kept)
export const SOURCES = {
  // ---------------- United States
  // Alaska (ak-gmu) is not relayed: ADF&G's terms allow display only, not
  // redistribution, so browsers load it straight from ADF&G (see scripts/catalog.js).
  "az-gmu": { kind: "arcgis", url: "https://services8.arcgis.com/KyZIQDOsXnGaTxj2/arcgis/rest/services/AZ_Game_and_Fish_Hunt_Units/FeatureServer/0",
    label: "Unit {GMU}", fields: { REG_NAME: "Region", LANDOWN: "Land ownership", SQ_MILES: "Square miles", AGFDLink: "AZGFD unit page" } },
  "co-gmu": { kind: "arcgis", url: "https://services5.arcgis.com/ttNGmDvKQA7oeDQ3/arcgis/rest/services/CPWAdminData/FeatureServer/6",
    label: "GMU {GMUID}", fields: { COUNTY: "County", DEERDAU: "Deer DAU", ELKDAU: "Elk DAU", ANTDAU: "Pronghorn DAU", MOOSEDAU: "Moose DAU", BEARDAU: "Bear DAU", LIONDAU: "Lion DAU", SqMilesGIS: "Square miles" } },
  "co-sheep": { kind: "arcgis", url: "https://services5.arcgis.com/ttNGmDvKQA7oeDQ3/arcgis/rest/services/CPWAdminData/FeatureServer/7",
    label: "{BSGMU} {GMU_NAME}", fields: { DAU_NAME: "DAU", HUNTING: "Open to hunting" } },
  "co-goat": { kind: "arcgis", url: "https://services5.arcgis.com/ttNGmDvKQA7oeDQ3/arcgis/rest/services/CPWAdminData/FeatureServer/8",
    label: "{MGGMU} {MGGMUNAME}", fields: { MGDAU: "DAU", HUNTING: "Open to hunting" } },
  "id-gmu": { kind: "arcgis", url: "https://services.arcgis.com/FjJI5xHF2dUPVrgK/arcgis/rest/services/GameManagementUnits/FeatureServer/0",
    label: "Unit {NAME}", fields: { Elk_Zone: "Elk zone", regular_deer_url: "Deer seasons", elkZone_url_1: "Elk seasons", gmu_wtd_url: "White-tailed deer seasons" } },
  "ks-dmu": { kind: "arcgis", url: "https://services1.arcgis.com/q2CglofYX6ACNEeu/arcgis/rest/services/Kansas_Deer_Management_Units/FeatureServer/0",
    label: "{DMU}", fields: { AreaSQMile: "Square miles" } },
  "ks-waterfowl": { kind: "arcgis", url: "https://services1.arcgis.com/q2CglofYX6ACNEeu/arcgis/rest/services/Waterfowl_Zones/FeatureServer/0",
    label: "{Duck_Zones}", fields: { season_dates: "Season dates" } },
  "la-deer": { kind: "arcgis", url: "https://services1.arcgis.com/6euNCaGPCgCzgAVF/arcgis/rest/services/HuntingAreas/FeatureServer/3",
    label: "Deer Area {Area_ID}", fields: { Acres: "Acres", Link: "More info" } },
  "la-turkey": { kind: "arcgis", url: "https://services1.arcgis.com/6euNCaGPCgCzgAVF/arcgis/rest/services/HuntingAreas/FeatureServer/5",
    label: "Turkey Area {Area}", fields: { PARISH: "Parish" } },
  "la-waterfowl": { kind: "arcgis", url: "https://services1.arcgis.com/6euNCaGPCgCzgAVF/arcgis/rest/services/HuntingAreas/FeatureServer/4",
    label: "{Zone} Zone", fields: {} },
  "la-wma": { kind: "arcgis", url: "https://services1.arcgis.com/6euNCaGPCgCzgAVF/arcgis/rest/services/LDWF_WMA_Refuge/FeatureServer/0",
    label: "{NAME}", fields: { GIS_Acres: "Acres", Lease: "Lease", Link: "More info" } },
  "mo-lands": { kind: "arcgis", url: "https://gisblue.mdc.mo.gov/arcgis/rest/services/Boundaries/MDC_Administrative_Boundaries/MapServer/0",
    label: "{Area_Name}", fields: { County: "County", Acreage: "Acres", Map_Link: "Area map", Reg_Link: "Regulations", Brochure_Link: "Brochure" } },
  "mo-bear": { kind: "arcgis", url: "https://gisblue.mdc.mo.gov/arcgis/rest/services/Boundaries/Hunting_Zones/MapServer/0",
    label: "Bear Zone {Zones}", fields: {} },
  "mo-waterfowl": { kind: "arcgis", url: "https://gisblue.mdc.mo.gov/arcgis/rest/services/Boundaries/Hunting_Zones/MapServer/1",
    label: "{Zone}", fields: {} },
  "nm-gmu": { kind: "arcgis", url: "https://services2.arcgis.com/CjbW1bVhK4dB3WOa/arcgis/rest/services/NMDGF_Game_Management_Units_I_E__v2_WFL1/FeatureServer/0",
    label: "GMU {GMU}", fields: { BearZone: "Bear zone", Cougar_Zone: "Cougar zone", GMU_PDF: "Unit map (PDF)", HUNT_INFO: "Hunting info", GMU_Desc: "Boundary description" } },
  "ok-wma": { kind: "arcgis", url: "https://services1.arcgis.com/jRf8jjFwxedITdFe/arcgis/rest/services/Public_WMA_Boundaries/FeatureServer/1",
    label: "{WMANAME}", fields: { WMATYPE: "Type", OWNERSHIP: "Owner", ACRES: "Acres", REGION: "Region" } },
  "tx-wtdmu": { kind: "arcgis", url: "https://tpwd.texas.gov/arcgis/rest/services/Wildlife/TPWD_WL_WTDMU/MapServer/0", paging: false,
    label: "Deer Unit {UnitNumber}", fields: {} },
  "tx-mdmu": { kind: "arcgis", url: "https://tpwd.texas.gov/arcgis/rest/services/Wildlife/TPWD_WL_MDMU/MapServer/0", paging: false,
    label: "Mule Deer Unit {UnitNumber}", fields: {} },
  "tx-public": { kind: "arcgis", url: "https://tpwd.texas.gov/arcgis/rest/services/Wildlife/TPWD_PublicHuntLocatorMap/MapServer/9",
    label: "{LocName}", fields: { Class: "Type", Name: "Unit", Acres: "Acres", Active: "Active" } },
  // ---------------- Canada
  "ab-wmu": { kind: "arcgis", url: "https://geospatial.alberta.ca/mimas/rest/services/boundaries/fishwild_wildlife_mgmt_unit_public/FeatureServer/0",
    label: "WMU {WMUNIT_CODE} {WMUNIT_NAME}", fields: {} },
  "bc-wmu": { kind: "wfs", tolerance: 0.001, url: "https://openmaps.gov.bc.ca/geo/pub/wfs", typeName: "pub:WHSE_WILDLIFE_MANAGEMENT.WAA_WILDLIFE_MGMT_UNITS_SVW", geometryField: "GEOMETRY",
    label: "MU {WILDLIFE_MGMT_UNIT_ID}", fields: { GAME_MANAGEMENT_ZONE_NAME: "Game management zone", REGION_RESPONSIBLE_NAME: "Region" } },
  "mb-gha": { kind: "arcgis", url: "https://services.arcgis.com/mMUesHYPkXjaFGfS/arcgis/rest/services/Manitoba_Game_Hunting_Areas/FeatureServer/0",
    label: "GHA {GHA}", fields: {} },
  "on-wmu": { kind: "arcgis", url: "https://ws.lioservices.lrc.gov.on.ca/arcgis2/rest/services/LIO_OPEN_DATA/LIO_Open05/MapServer/5",
    label: "WMU {OFFICIAL_NAME}", fields: {} },
  "sk-wmz": { kind: "arcgis", url: "https://gis.saskatchewan.ca/arcgis/rest/services/WildlifeManagement/MapServer/0",
    label: "Zone {ZONE_NUM}", fields: { DA_NAME: "Name" } },
  "yt-gma": { kind: "arcgis", tolerance: 0.001, url: "https://mapservices.gov.yk.ca/arcgis/rest/services/GeoYukon/GY_AdministrativeBoundaries/MapServer/7",
    label: "Area {GAME_MGMT_AREA_ID}", fields: {} }
};

// ------------------------------------------------------------------ values

// Clean a field value: drop blanks/placeholders, pull URLs out of <a href>, strip tags.
export function cleanValue(v) {
  if (v === null || v === undefined) return undefined;
  if (typeof v === "number") return Number.isFinite(v) ? Math.round(v * 100) / 100 : undefined;
  let s = String(v).trim();
  if (!s || /^<?null>?$/i.test(s)) return undefined;
  const href = /<a\s[^>]*href\s*=\s*["']([^"']+)["']/i.exec(s);
  if (href) s = href[1];
  s = s.replace(/<[^>]*>/g, "").replace(/\s+\r?\n/g, "\n").trim();
  if (!s) return undefined;
  if (/^(https?:)?\/\//i.test(s) && !/^https?:\/\//i.test(s)) s = `https:${s}`;
  return s.slice(0, 4000);
}

function getField(props, name) {
  if (name in props) return props[name];
  const k = Object.keys(props).find(k => k.toLowerCase() === name.toLowerCase());
  return k === undefined ? undefined : props[k];
}

export function renderLabel(template, props) {
  const out = template.replace(/\{(\w+)\}/g, (_, f) => {
    const v = cleanValue(getField(props, f));
    return v === undefined ? "" : String(v);
  }).replace(/\s+/g, " ").trim();
  return out;
}

// Keep only what the overlay shows; returns null for features without geometry or label.
export function toOverlayFeature(src, f) {
  const g = f?.geometry;
  if (!g || !/Polygon|LineString|Point/.test(g.type || "")) return null;
  const props = f.properties || {};
  const label = renderLabel(src.label, props);
  // A label with no field values (template text only) means an empty record
  const fieldsInLabel = [...src.label.matchAll(/\{(\w+)\}/g)].map(m => cleanValue(getField(props, m[1])));
  if (!label || fieldsInLabel.every(v => v === undefined)) return null;
  const out = { _label: label };
  for (const [field, title] of Object.entries(src.fields)) {
    const v = cleanValue(getField(props, field));
    if (v !== undefined) out[title] = v;
  }
  return { type: "Feature", geometry: g.type.includes("Point") ? g : simplifyGeometry(g, src.tolerance || TOLERANCE), properties: out };
}

// ------------------------------------------------------------------ fetching

async function getJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`source returned HTTP ${res.status}`);
  const j = await res.json();
  if (j.error) throw new Error(`source error: ${j.error.message || "unknown"}`);
  return j;
}

function outFieldsFor(src) {
  const names = new Set([...src.label.matchAll(/\{(\w+)\}/g)].map(m => m[1]));
  Object.keys(src.fields).forEach(f => names.add(f));
  return [...names].join(",");
}

async function fetchArcgis(src) {
  const base = `${src.url}/query?where=${encodeURIComponent(src.where || "1=1")}&outFields=${encodeURIComponent(outFieldsFor(src))}` +
    `&returnGeometry=true&outSR=4326&maxAllowableOffset=${src.tolerance || TOLERANCE}&geometryPrecision=5&f=geojson`;
  if (src.paging === false) return (await getJson(base)).features || [];
  const features = [];
  const size = 1000;
  for (let offset = 0; offset < 50_000; offset += size) {
    const page = await getJson(`${base}&resultOffset=${offset}&resultRecordCount=${size}`);
    const got = page.features || [];
    features.push(...got);
    if (got.length < size && !page.exceededTransferLimit && !page.properties?.exceededTransferLimit) break;
    if (!got.length) break;
  }
  return features;
}

async function fetchWfs(src) {
  const props = [...new Set([...outFieldsFor(src).split(","), src.geometryField].filter(Boolean))].join(",");
  const url = `${src.url}?service=WFS&version=2.0.0&request=GetFeature&typeNames=${encodeURIComponent(src.typeName)}` +
    `&outputFormat=application/json&srsName=EPSG:4326&propertyName=${encodeURIComponent(props)}`;
  return (await getJson(url)).features || [];
}

export async function buildOverlay(id) {
  const src = SOURCES[id];
  if (!src) throw new Error(`Unknown overlay ${id}`);
  const raw = src.kind === "wfs" ? await fetchWfs(src) : await fetchArcgis(src);
  const features = raw.map(f => toOverlayFeature(src, f)).filter(Boolean);
  if (!features.length) throw new Error("source returned no usable features");
  return { type: "FeatureCollection", geovive: { overlay: id, source: src.url, fetchedAt: new Date().toISOString(), count: features.length }, features };
}
