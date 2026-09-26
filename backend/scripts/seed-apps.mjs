// Writes the seed app records to the Apps table (only apps not already there).
// Usage: APPS_TABLE=geovive-dev-apps ALLOWED_ORIGINS=... node scripts/seed-apps.mjs
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";
import { seedItems } from "../src/appstore.mjs";
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } });
for (const Item of seedItems()) {
  try {
    await ddb.send(new PutCommand({ TableName: process.env.APPS_TABLE, Item, ConditionExpression: "attribute_not_exists(appId)" }));
    console.log("added", Item.appId);
  } catch (e) { console.log(Item.appId, e.name === "ConditionalCheckFailedException" ? "already there" : e.message); }
}
