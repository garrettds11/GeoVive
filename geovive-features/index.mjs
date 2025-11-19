// index.mjs - GeoVive Lambda (Node.js 22, AWS SDK v3)
// Handles:
//   - GET /v1/features   -> list features as GeoJSON FeatureCollection
//   - POST /v1/features  -> create a new feature from GeoJSON Feature

import {
  DynamoDBClient,
  ScanCommand,
  PutItemCommand
} from "@aws-sdk/client-dynamodb";

import {
  unmarshall,
  marshall
} from "@aws-sdk/util-dynamodb";

import { randomUUID } from "crypto";

const client = new DynamoDBClient({});
const TABLE_NAME = process.env.TABLE_NAME || "geoviveFeatureCollection";

// ------------------------
// Utility helpers
// ------------------------

function parseLimit(raw) {
  if (!raw) return 200;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return 200;
  return Math.min(1000, Math.max(1, Math.floor(n)));
}

function parseBbox(raw) {
  if (!raw) return null;
  const parts = raw.split(",").map(s => s.trim());
  if (parts.length !== 4) {
    throw new Error("bbox must be minLon,minLat,maxLon,maxLat");
  }
  const [minLon, minLat, maxLon, maxLat] = parts.map(Number);
  if (
    [minLon, minLat, maxLon, maxLat].some(v => !Number.isFinite(v)) ||
    minLon >= maxLon ||
    minLat >= maxLat
  ) {
    throw new Error("bbox values are invalid");
  }
  return { minLon, minLat, maxLon, maxLat };
}

function decodeNextToken(raw) {
  if (!raw) return undefined;
  try {
    const json = Buffer.from(raw, "base64").toString("utf8");
    return JSON.parse(json);
  } catch {
    throw new Error("Invalid nextToken");
  }
}

function encodeNextToken(key) {
  if (!key) return undefined;
  return Buffer.from(JSON.stringify(key), "utf8").toString("base64");
}

function parseJsonBody(event) {
  let body = event.body;
  if (!body) return {};
  if (event.isBase64Encoded && typeof body === "string") {
    body = Buffer.from(body, "base64").toString("utf8");
  }
  if (typeof body === "string") {
    return JSON.parse(body);
  }
  return body;
}

// ------------------------
// Geometry helpers
// ------------------------

function itemToGeometry(item) {
  const gType = item.geometryType || (item.geometry && item.geometry.type) || "Point";

  // Point: use lat/lng
  if (gType === "Point") {
    const lat = Number(item.lat);
    const lng = Number(item.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return null;
    }
    return {
      type: "Point",
      coordinates: [lng, lat]
    };
  }

  // Non-point: expect a GeoJSON-ish geometry map on the item
  if (item.geometry && item.geometry.type && item.geometry.coordinates) {
    return {
      type: item.geometry.type,
      coordinates: item.geometry.coordinates
    };
  }

  // If we don't have enough info, skip the feature
  return null;
}

function itemsToGeoJSON(items) {
  const features = items
    .map(item => {
      const geometry = itemToGeometry(item);
      if (!geometry) return null;

      return {
        type: "Feature",
        geometry,
        properties: {
          id: item.id,
          mapId: item.mapId,
          name: item.name || item.id,
          description: item.description || "",
          category: item.category || "location",
          tags: item.tags || [],
          createdAt: item.createdAt,
          updatedAt: item.updatedAt,
          eventTime: item.eventTime,
          status: item.status || "active",
          source: item.source,
          externalId: item.externalId,
          severity: item.severity,
          icon: item.icon,
          color: item.color
        }
      };
    })
    .filter(Boolean);

  return {
    type: "FeatureCollection",
    features
  };
}

// ------------------------
// Filtering helpers
// ------------------------

function filterItems(items, { mapId, category, bbox }) {
  return items.filter(item => {
    if (mapId && item.mapId !== mapId) return false;
    if (category && item.category !== category) return false;

    if (bbox) {
      const lat = Number(item.lat);
      const lng = Number(item.lng);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false;
      if (
        lng < bbox.minLon ||
        lng > bbox.maxLon ||
        lat < bbox.minLat ||
        lat > bbox.maxLat
      ) {
        return false;
      }
    }

    return true;
  });
}

// ------------------------
// DynamoDB scan for GET
// ------------------------

async function scanFeatures({ mapId, category, bbox, limit, startKey }) {
  const rawItems = [];
  let ExclusiveStartKey = startKey;
  let LastEvaluatedKey = undefined;

  do {
    const params = {
      TableName: TABLE_NAME,
      ExclusiveStartKey,
      Limit: limit
    };

    const response = await client.send(new ScanCommand(params));

    if (response.Items) {
      for (const raw of response.Items) {
        const item = unmarshall(raw);
        rawItems.push(item);
      }
    }

    LastEvaluatedKey = response.LastEvaluatedKey;
    ExclusiveStartKey = LastEvaluatedKey;

    const filtered = filterItems(rawItems, { mapId, category, bbox });
    if (filtered.length >= limit || !LastEvaluatedKey) {
      const trimmed = filtered.slice(0, limit);
      return { items: trimmed, lastKey: LastEvaluatedKey };
    }
  } while (ExclusiveStartKey);

  const filtered = filterItems(rawItems, { mapId, category, bbox });
  return { items: filtered.slice(0, limit), lastKey: LastEvaluatedKey };
}

// ------------------------
// Create feature (POST)
// ------------------------

function validateAndNormalizeFeature(body) {
  if (!body || body.type !== "Feature") {
    throw new Error("Payload must be a GeoJSON Feature");
  }

  const geometry = body.geometry;
  if (!geometry || !geometry.type || !geometry.coordinates) {
    throw new Error("Feature.geometry.type and .coordinates are required");
  }

  const props = body.properties || {};
  const mapId = props.mapId;
  const name = props.name;
  const category = props.category;

  if (!mapId) throw new Error("properties.mapId is required");
  if (!name) throw new Error("properties.name is required");
  if (!category) throw new Error("properties.category is required");

  const now = new Date().toISOString();
  const id = props.id || randomUUID();
  const createdAt = props.createdAt || now;
  const updatedAt = now;

  // Build Dynamo item
  const geometryType = geometry.type;
  const dynamoItem = {
    id,
    mapId,
    geometryType,
    name,
    description: props.description,
    category,
    tags: props.tags,
    createdAt,
    updatedAt,
    eventTime: props.eventTime,
    status: props.status || "active",
    source: props.source,
    externalId: props.externalId,
    severity: props.severity,
    icon: props.icon,
    color: props.color,
    geometry // full geometry map for non-point or general use
  };

  // If it is a Point, also store lat/lng separately
  if (geometryType === "Point" && Array.isArray(geometry.coordinates)) {
    const [lng, lat] = geometry.coordinates;
    if (Number.isFinite(lat) && Number.isFinite(lng)) {
      dynamoItem.lat = lat;
      dynamoItem.lng = lng;
    }
  }

  // Return both the item for Dynamo and the canonical Feature we will respond with
  const feature = {
    type: "Feature",
    geometry,
    properties: {
      id,
      mapId,
      name,
      description: props.description,
      category,
      tags: props.tags || [],
      createdAt,
      updatedAt,
      eventTime: props.eventTime,
      status: dynamoItem.status,
      source: props.source,
      externalId: props.externalId,
      severity: props.severity,
      icon: props.icon,
      color: props.color
    }
  };

  return { dynamoItem, feature };
}

async function createFeature(body) {
  const { dynamoItem, feature } = validateAndNormalizeFeature(body);

  const cmd = new PutItemCommand({
    TableName: TABLE_NAME,
    Item: marshall(dynamoItem),
    ConditionExpression: "attribute_not_exists(#id)",
    ExpressionAttributeNames: {
      "#id": "id"
    }
  });

  try {
    await client.send(cmd);
  } catch (err) {
    if (err.name === "ConditionalCheckFailedException") {
      const conflictError = new Error("Feature with this id already exists");
      conflictError.code = "CONFLICT";
      throw conflictError;
    }
    throw err;
  }

  return feature;
}

// ------------------------
// Main handler
// ------------------------

export const handler = async (event) => {
  console.log("Event:", JSON.stringify(event));

  const method =
    event.requestContext?.http?.method ||
    event.httpMethod ||
    "GET";

  try {
    if (method === "GET") {
      // List features
      const qs = event.queryStringParameters || {};

      const mapId = qs.mapId || undefined;
      const category = qs.category || undefined;
      const limit = parseLimit(qs.limit);
      const bbox = parseBbox(qs.bbox || null);
      const startKey = decodeNextToken(qs.nextToken || null);

      const { items, lastKey } = await scanFeatures({
        mapId,
        category,
        bbox,
        limit,
        startKey
      });

      const geojson = itemsToGeoJSON(items);
      const nextToken = encodeNextToken(lastKey);
      if (nextToken) {
        geojson.nextToken = nextToken;
      }

      return {
        statusCode: 200,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*"
        },
        body: JSON.stringify(geojson)
      };
    }

    if (method === "POST") {
      // Create feature
      const body = parseJsonBody(event);
      const createdFeature = await createFeature(body);

      return {
        statusCode: 201,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*"
        },
        body: JSON.stringify(createdFeature)
      };
    }

    // Method not allowed
    return {
      statusCode: 405,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*"
      },
      body: JSON.stringify({
        message: `Method ${method} not allowed`
      })
    };
  } catch (err) {
    console.error("Handler error:", err);

    // 400-ish errors
    if (
      err.message &&
      (
        err.message.includes("bbox") ||
        err.message.includes("nextToken") ||
        err.message.includes("required") ||
        err.message.includes("GeoJSON Feature")
      ) &&
      err.code !== "CONFLICT"
    ) {
      return {
        statusCode: 400,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*"
        },
        body: JSON.stringify({
          message: "Invalid request",
          error: err.message
        })
      };
    }

    // 409 conflict
    if (err.code === "CONFLICT") {
      return {
        statusCode: 409,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*"
        },
        body: JSON.stringify({
          message: "Feature already exists",
          error: err.message
        })
      };
    }

    // 500 fallback
    return {
      statusCode: 500,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*"
      },
      body: JSON.stringify({
        message: "Failed to process request",
        error: err.message
      })
    };
  }
};
