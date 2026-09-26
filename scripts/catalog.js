// catalog.js — GeoVivé's catalog of approved external map layers (#22).
//
// Each entry is shown live from its publisher's server; GeoVivé stores nothing.
// Every source here was checked to allow use from other websites (CORS).
//
// Fields:
//   id           stable ID (used in saved settings)
//   name         shown in the Layers panel
//   group        heading in the panel
//   type         "raster-tiles" (a z/y/x tile cache), "raster-export" (an
//                ArcGIS MapServer drawn per view via its export endpoint), or
//                "vector" (clickable shapes from GeoVivé's relay, /v1/relay/{id};
//                the relay's source list is backend/src/overlays.mjs)
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
  },
  {
    id: "ak-gmu", type: "vector", group: "Hunting units · United States", color: "#f59e0b",
    name: "Alaska · Game Management Units",
    publisher: "Alaska Department of Fish and Game", attribution: "Alaska Department of Fish and Game",
    source: "https://gis.adfg.alaska.gov/ags/rest/services/wc_public/GMUSubunits/FeatureServer/4",
    license: "Display only; not for redistribution (ADF&G)",
    description: "26 units and their subunits. Loaded directly from ADF&G, whose terms allow display only.",
    direct: {
      url: "https://gis.adfg.alaska.gov/ags/rest/services/wc_public/GMUSubunits/FeatureServer/4",
      label: "Unit {SubLabel}", tolerance: 0.001,
      fields: { UnitSub: "Unit/subunit", Region: "Region", SqMi: "Square miles" }
    }
  },
  {
    id: "az-gmu", type: "vector", group: "Hunting units · United States", color: "#f59e0b",
    name: "Arizona · Game Management Units",
    publisher: "Arizona Game and Fish Department", attribution: "Arizona Game and Fish Department",
    source: "https://services8.arcgis.com/KyZIQDOsXnGaTxj2/arcgis/rest/services/AZ_Game_and_Fish_Hunt_Units/FeatureServer/0",
    license: "Reference only; legal boundaries are in Commission Rule R12-4-108",
    description: "Hunt units with region and land ownership. Published copy credited to AZGFD (the agency's own server is currently unreachable)."
  },
  {
    id: "co-gmu", type: "vector", group: "Hunting units · United States", color: "#f59e0b",
    name: "Colorado · GMUs (big game)",
    publisher: "Colorado Parks and Wildlife", attribution: "Colorado Parks and Wildlife",
    source: "https://services5.arcgis.com/ttNGmDvKQA7oeDQ3/arcgis/rest/services/CPWAdminData/FeatureServer/6",
    license: "Official agency data",
    description: "Big game units with deer, elk, pronghorn, moose, bear and lion DAUs."
  },
  {
    id: "co-sheep", type: "vector", group: "Hunting units · United States", color: "#e879f9",
    name: "Colorado · Bighorn sheep units",
    publisher: "Colorado Parks and Wildlife", attribution: "Colorado Parks and Wildlife",
    source: "https://services5.arcgis.com/ttNGmDvKQA7oeDQ3/arcgis/rest/services/CPWAdminData/FeatureServer/7",
    license: "Official agency data",
    description: "Bighorn sheep GMUs (S-units)."
  },
  {
    id: "co-goat", type: "vector", group: "Hunting units · United States", color: "#e879f9",
    name: "Colorado · Mountain goat units",
    publisher: "Colorado Parks and Wildlife", attribution: "Colorado Parks and Wildlife",
    source: "https://services5.arcgis.com/ttNGmDvKQA7oeDQ3/arcgis/rest/services/CPWAdminData/FeatureServer/8",
    license: "Official agency data",
    description: "Mountain goat GMUs (G-units)."
  },
  {
    id: "id-gmu", type: "vector", group: "Hunting units · United States", color: "#f59e0b",
    name: "Idaho · Game Management Units",
    publisher: "Idaho Department of Fish and Game", attribution: "Idaho Department of Fish and Game",
    source: "https://services.arcgis.com/FjJI5xHF2dUPVrgK/arcgis/rest/services/GameManagementUnits/FeatureServer/0",
    license: "Official agency data",
    description: "Units with elk zones and links to season pages."
  },
  {
    id: "ks-dmu", type: "vector", group: "Hunting units · United States", color: "#f59e0b",
    name: "Kansas · Deer Management Units",
    publisher: "Kansas Department of Wildlife and Parks", attribution: "Kansas Department of Wildlife and Parks",
    source: "https://services1.arcgis.com/q2CglofYX6ACNEeu/arcgis/rest/services/Kansas_Deer_Management_Units/FeatureServer/0",
    license: "Official agency data",
    description: "The state's 18 deer management units."
  },
  {
    id: "ks-waterfowl", type: "vector", group: "Hunting units · United States", color: "#38bdf8",
    name: "Kansas · Duck zones",
    publisher: "Kansas Department of Wildlife and Parks", attribution: "Kansas Department of Wildlife and Parks",
    source: "https://services1.arcgis.com/q2CglofYX6ACNEeu/arcgis/rest/services/Waterfowl_Zones/FeatureServer/0",
    license: "Official agency data",
    description: "Duck zones with season dates."
  },
  {
    id: "la-deer", type: "vector", group: "Hunting units · United States", color: "#f59e0b",
    name: "Louisiana · Deer areas",
    publisher: "Louisiana Department of Wildlife and Fisheries", attribution: "Louisiana Department of Wildlife and Fisheries",
    source: "https://services1.arcgis.com/6euNCaGPCgCzgAVF/arcgis/rest/services/HuntingAreas/FeatureServer/3",
    license: "Official agency data",
    description: "Deer hunting areas 1–10."
  },
  {
    id: "la-turkey", type: "vector", group: "Hunting units · United States", color: "#fb923c",
    name: "Louisiana · Turkey areas",
    publisher: "Louisiana Department of Wildlife and Fisheries", attribution: "Louisiana Department of Wildlife and Fisheries",
    source: "https://services1.arcgis.com/6euNCaGPCgCzgAVF/arcgis/rest/services/HuntingAreas/FeatureServer/5",
    license: "Official agency data",
    description: "Turkey hunting areas by parish."
  },
  {
    id: "la-waterfowl", type: "vector", group: "Hunting units · United States", color: "#38bdf8",
    name: "Louisiana · Waterfowl zones",
    publisher: "Louisiana Department of Wildlife and Fisheries", attribution: "Louisiana Department of Wildlife and Fisheries",
    source: "https://services1.arcgis.com/6euNCaGPCgCzgAVF/arcgis/rest/services/HuntingAreas/FeatureServer/4",
    license: "Official agency data",
    description: "East and West waterfowl zones."
  },
  {
    id: "la-wma", type: "vector", group: "Hunting units · United States", color: "#22c55e",
    name: "Louisiana · WMAs and refuges",
    publisher: "Louisiana Department of Wildlife and Fisheries", attribution: "Louisiana Department of Wildlife and Fisheries",
    source: "https://services1.arcgis.com/6euNCaGPCgCzgAVF/arcgis/rest/services/LDWF_WMA_Refuge/FeatureServer/0",
    license: "Official agency data",
    description: "Wildlife management areas and refuges."
  },
  {
    id: "mo-lands", type: "vector", group: "Hunting units · United States", color: "#22c55e",
    name: "Missouri · Conservation areas",
    publisher: "Missouri Department of Conservation", attribution: "Missouri Department of Conservation",
    source: "https://gisblue.mdc.mo.gov/arcgis/rest/services/Boundaries/MDC_Administrative_Boundaries/MapServer/0",
    license: "Official agency data",
    description: "MDC lands with links to area maps and regulations."
  },
  {
    id: "mo-bear", type: "vector", group: "Hunting units · United States", color: "#fb923c",
    name: "Missouri · Bear management zones",
    publisher: "Missouri Department of Conservation", attribution: "Missouri Department of Conservation",
    source: "https://gisblue.mdc.mo.gov/arcgis/rest/services/Boundaries/Hunting_Zones/MapServer/0",
    license: "Official agency data",
    description: "Black bear hunting zones."
  },
  {
    id: "mo-waterfowl", type: "vector", group: "Hunting units · United States", color: "#38bdf8",
    name: "Missouri · Waterfowl zones",
    publisher: "Missouri Department of Conservation", attribution: "Missouri Department of Conservation",
    source: "https://gisblue.mdc.mo.gov/arcgis/rest/services/Boundaries/Hunting_Zones/MapServer/1",
    license: "Official agency data",
    description: "North, Middle and South waterfowl zones."
  },
  {
    id: "nm-gmu", type: "vector", group: "Hunting units · United States", color: "#f59e0b",
    name: "New Mexico · Game Management Units",
    publisher: "New Mexico Department of Game and Fish", attribution: "New Mexico Department of Game and Fish",
    source: "https://services2.arcgis.com/CjbW1bVhK4dB3WOa/arcgis/rest/services/NMDGF_Game_Management_Units_I_E__v2_WFL1/FeatureServer/0",
    license: "Official agency data",
    description: "Units with bear and cougar zones, unit maps and boundary descriptions."
  },
  {
    id: "ok-wma", type: "vector", group: "Hunting units · United States", color: "#22c55e",
    name: "Oklahoma · Wildlife management areas",
    publisher: "Oklahoma Department of Wildlife Conservation", attribution: "Oklahoma Department of Wildlife Conservation",
    source: "https://services1.arcgis.com/jRf8jjFwxedITdFe/arcgis/rest/services/Public_WMA_Boundaries/FeatureServer/1",
    license: "Official agency data",
    description: "Public WMAs and other public hunting lands."
  },
  {
    id: "tx-wtdmu", type: "vector", group: "Hunting units · United States", color: "#f59e0b",
    name: "Texas · White-tailed deer units",
    publisher: "Texas Parks and Wildlife Department", attribution: "Texas Parks and Wildlife Department",
    source: "https://tpwd.texas.gov/arcgis/rest/services/Wildlife/TPWD_WL_WTDMU/MapServer/0",
    license: "Official agency data",
    description: "White-tailed deer management units."
  },
  {
    id: "tx-mdmu", type: "vector", group: "Hunting units · United States", color: "#f59e0b",
    name: "Texas · Mule deer units",
    publisher: "Texas Parks and Wildlife Department", attribution: "Texas Parks and Wildlife Department",
    source: "https://tpwd.texas.gov/arcgis/rest/services/Wildlife/TPWD_WL_MDMU/MapServer/0",
    license: "Official agency data",
    description: "Mule deer management units."
  },
  {
    id: "tx-public", type: "vector", group: "Hunting units · United States", color: "#22c55e",
    name: "Texas · Public hunting lands",
    publisher: "Texas Parks and Wildlife Department", attribution: "Texas Parks and Wildlife Department",
    source: "https://tpwd.texas.gov/arcgis/rest/services/Wildlife/TPWD_PublicHuntLocatorMap/MapServer/9",
    license: "Official agency data",
    description: "Public hunt areas, including no-hunt zones and sanctuaries."
  },
  {
    id: "ab-wmu", type: "vector", group: "Hunting units · Canada", color: "#f59e0b",
    name: "Alberta · Wildlife Management Units",
    publisher: "Government of Alberta", attribution: "Government of Alberta",
    source: "https://geospatial.alberta.ca/mimas/rest/services/boundaries/fishwild_wildlife_mgmt_unit_public/FeatureServer/0",
    license: "Open Government Licence – Alberta",
    description: "WMUs with names and numbers."
  },
  {
    id: "bc-wmu", type: "vector", group: "Hunting units · Canada", color: "#f59e0b",
    name: "British Columbia · Wildlife Management Units",
    publisher: "Government of British Columbia", attribution: "Government of British Columbia",
    source: "https://openmaps.gov.bc.ca/geo/pub/wfs",
    license: "Government of British Columbia open data",
    description: "Management units with game management zones."
  },
  {
    id: "mb-gha", type: "vector", group: "Hunting units · Canada", color: "#f59e0b",
    name: "Manitoba · Game Hunting Areas",
    publisher: "Government of Manitoba", attribution: "Government of Manitoba",
    source: "https://services.arcgis.com/mMUesHYPkXjaFGfS/arcgis/rest/services/Manitoba_Game_Hunting_Areas/FeatureServer/0",
    license: "OpenMB Information and Data Use Licence",
    description: "Game hunting areas (GHAs)."
  },
  {
    id: "on-wmu", type: "vector", group: "Hunting units · Canada", color: "#f59e0b",
    name: "Ontario · Wildlife Management Units",
    publisher: "Ontario Ministry of Natural Resources", attribution: "Ontario Ministry of Natural Resources",
    source: "https://ws.lioservices.lrc.gov.on.ca/arcgis2/rest/services/LIO_OPEN_DATA/LIO_Open05/MapServer/5",
    license: "Open Government Licence – Ontario",
    description: "WMUs from Land Information Ontario."
  },
  {
    id: "sk-wmz", type: "vector", group: "Hunting units · Canada", color: "#f59e0b",
    name: "Saskatchewan · Wildlife Management Zones",
    publisher: "Government of Saskatchewan", attribution: "Government of Saskatchewan",
    source: "https://gis.saskatchewan.ca/arcgis/rest/services/WildlifeManagement/MapServer/0",
    license: "Saskatchewan Standard Unrestricted Use Data Licence",
    description: "Wildlife management zones."
  },
  {
    id: "yt-gma", type: "vector", group: "Hunting units · Canada", color: "#f59e0b",
    name: "Yukon · Game Management Areas",
    publisher: "Government of Yukon", attribution: "Government of Yukon",
    source: "https://mapservices.gov.yk.ca/arcgis/rest/services/GeoYukon/GY_AdministrativeBoundaries/MapServer/7",
    license: "Open Government Licence – Yukon",
    description: "Game management areas (zone and subzone)."
  }];

// Tile URL template Mapbox can request for an entry.
export function tileUrl(entry) {
  if (entry.type === "raster-tiles") return entry.url;
  // ArcGIS dynamic map service: draw the current tile's box on request.
  return `${entry.url}/export?bbox={bbox-epsg-3857}&bboxSR=3857&imageSR=3857&size=256,256&format=png32&transparent=true&f=image`;
}
