// index.mjs or index.js

// Node 18 still has aws-sdk v2 preinstalled in Lambda
const AWS = require("aws-sdk");
const dynamo = new AWS.DynamoDB.DocumentClient();

// Use env var so you can reuse in other stages/regions
const TABLE_NAME = process.env.TABLE_NAME || "geoboardFeatureCollection";

/**
 * Lambda handler for fetching all features and returning GeoJSON.
 * Designed for Lambda Proxy integration (API Gateway / Function URL).
 */
exports.handler = async (event) => {
  console.log("Incoming event:", JSON.stringify(event));

  try {
    const items = await scanAllItems(TABLE_NAME);

    const features = items
      .filter((item) => item.lat != null && item.lng != null)
      .map((item) => {
        const lat = Number(item.lat);
        const lng = Number(item.lng);

        return {
          type: "Feature",
          properties: {
            id: item.id,
            name: item.name || item.id,
            category: item.category || "location",
            description: item.description || "",
            // pass through any extra props you want:
            // tags: item.tags,
          },
          geometry: {
            type: "Point",
            coordinates: [lng, lat]
          }
        };
      });

    const geojson = {
      type: "FeatureCollection",
      features
    };

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json",
        // CORS – good to have once we hook a browser up to this
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Content-Type"
      },
      body: JSON.stringify(geojson)
    };
  } catch (err) {
    console.error("Error building GeoJSON:", err);

    return {
      statusCode: 500,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*"
      },
      body: JSON.stringify({
        message: "Failed to load GeoBoard features",
        error: err.message || "Unknown error"
      })
    };
  }
};

/**
 * Scan the entire table (handles pagination).
 */
async function scanAllItems(tableName) {
  const items = [];
  let ExclusiveStartKey;

  do {
    const params = {
      TableName: tableName,
      ExclusiveStartKey
    };

    const res = await dynamo.scan(params).promise();
    if (res.Items) {
      items.push(...res.Items);
    }
    ExclusiveStartKey = res.LastEvaluatedKey;
  } while (ExclusiveStartKey);

  return items;
}
