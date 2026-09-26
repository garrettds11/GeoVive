// catalog.js — GeoVivé's catalog of approved external map layers (#22).
//
// Each entry is shown live from its publisher's server; GeoVivé stores nothing.
// Every source here was checked to allow use from other websites (CORS).
//
// Fields:
//   id           stable ID (used in saved settings)
//   name         shown in the Layers panel
//   group        heading in the panel
//   type         "raster-tiles" (a z/y/x tile cache) or "raster-export" (an
//                ArcGIS MapServer drawn per view via its export endpoint)
//   url          tile URL template, or the MapServer base URL for exports
//   minzoom/maxzoom  zoom range the service provides (the map scales tiles beyond it)
//   opacity      default opacity (0–1)
//   attribution  credit shown on the map (required by most publishers)
//   source       human-readable publisher page / service URL
//   license      short license note
//   description  one line for the panel

export const CATALOG = [
  {
    id: "usgs-topo",
    name: "USGS Topo",
    group: "Base & terrain",
    type: "raster-tiles",
    url: "https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer/tile/{z}/{y}/{x}",
    minzoom: 0, maxzoom: 16, opacity: 0.85,
    attribution: "USGS The National Map",
    source: "https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer",
    license: "Public domain (US Government)",
    description: "Topographic map: contours, trails, place names."
  },
  {
    id: "usgs-relief",
    name: "Shaded relief",
    group: "Base & terrain",
    type: "raster-tiles",
    url: "https://basemap.nationalmap.gov/arcgis/rest/services/USGSShadedReliefOnly/MapServer/tile/{z}/{y}/{x}",
    minzoom: 0, maxzoom: 16, opacity: 0.45,
    attribution: "USGS The National Map",
    source: "https://basemap.nationalmap.gov/arcgis/rest/services/USGSShadedReliefOnly/MapServer",
    license: "Public domain (US Government)",
    description: "Hillshade of the terrain; blends over any style."
  },
  {
    id: "usgs-imagery-topo",
    name: "USGS Imagery + Topo",
    group: "Base & terrain",
    type: "raster-tiles",
    url: "https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryTopo/MapServer/tile/{z}/{y}/{x}",
    minzoom: 0, maxzoom: 16, opacity: 1,
    attribution: "USGS The National Map",
    source: "https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryTopo/MapServer",
    license: "Public domain (US Government)",
    description: "Aerial imagery with topo labels."
  },
  {
    id: "usgs-hydro",
    name: "Water (streams, lakes)",
    group: "Water",
    type: "raster-tiles",
    url: "https://basemap.nationalmap.gov/arcgis/rest/services/USGSHydroCached/MapServer/tile/{z}/{y}/{x}",
    minzoom: 0, maxzoom: 16, opacity: 0.9,
    attribution: "USGS National Hydrography",
    source: "https://basemap.nationalmap.gov/arcgis/rest/services/USGSHydroCached/MapServer",
    license: "Public domain (US Government)",
    description: "Streams, rivers and water bodies."
  },
  {
    id: "blm-land-ownership",
    name: "Land ownership (BLM)",
    group: "Land & boundaries",
    type: "raster-tiles",
    url: "https://gis.blm.gov/arcgis/rest/services/lands/BLM_Natl_SMA_Cached_without_PriUnk/MapServer/tile/{z}/{y}/{x}",
    minzoom: 0, maxzoom: 14, opacity: 0.55,
    attribution: "BLM Surface Management Agency",
    source: "https://gis.blm.gov/arcgis/rest/services/lands/BLM_Natl_SMA_Cached_without_PriUnk/MapServer",
    license: "Public domain (US Government)",
    description: "Who manages the land surface: BLM, Forest Service, state, tribal, etc. (private land left clear)."
  },
  {
    id: "usfs-boundaries",
    name: "National Forest boundaries",
    group: "Land & boundaries",
    type: "raster-export",
    url: "https://apps.fs.usda.gov/arcx/rest/services/EDW/EDW_ForestSystemBoundaries_01/MapServer",
    minzoom: 4, maxzoom: 22, opacity: 0.8,
    attribution: "USDA Forest Service",
    source: "https://apps.fs.usda.gov/arcx/rest/services/EDW/EDW_ForestSystemBoundaries_01/MapServer",
    license: "Public domain (US Government)",
    description: "Administrative boundaries of National Forests and Grasslands."
  },
  {
    id: "usgs-govunits",
    name: "States & counties",
    group: "Land & boundaries",
    type: "raster-export",
    url: "https://carto.nationalmap.gov/arcgis/rest/services/govunits/MapServer",
    minzoom: 3, maxzoom: 22, opacity: 0.9,
    attribution: "USGS National Boundaries Dataset",
    source: "https://carto.nationalmap.gov/arcgis/rest/services/govunits/MapServer",
    license: "Public domain (US Government)",
    description: "State, county and other government unit boundaries with labels."
  }
];

// Tile URL template Mapbox can request for an entry.
export function tileUrl(entry) {
  if (entry.type === "raster-tiles") return entry.url;
  // ArcGIS dynamic map service: draw the current tile's box on request.
  return `${entry.url}/export?bbox={bbox-epsg-3857}&bboxSR=3857&imageSR=3857&size=256,256&format=png32&transparent=true&f=image`;
}
