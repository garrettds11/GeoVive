// Unit test for the /v1/apps routes with mocked DynamoDB and caller.
process.env.USER_POOL_ID = "us-east-1_TEST123"; process.env.USER_POOL_CLIENT_ID = "abc";
process.env.DATASETS_TABLE = "d"; process.env.FEATURES_TABLE = "f"; process.env.ALLOWED_ORIGINS = "https://geovive.link";
const { DynamoDBDocumentClient } = await import("@aws-sdk/lib-dynamodb");
let store = [];
DynamoDBDocumentClient.prototype.send = async function (c) {
  const n = c.constructor.name, i = c.input;
  if (n === "QueryCommand") return { Items: store.filter(x => x.originKey === i.ExpressionAttributeValues[":k"]) };
  if (n === "PutCommand") { store = store.filter(x => x.datasetId !== i.Item.datasetId); store.push(i.Item); return {}; }
  return {};
};
const { handler } = await import("../src/handler.mjs");
const ev = (routeKey, pathParameters, body) => ({
  routeKey, pathParameters, headers: { origin: "https://geovive.link" },
  requestContext: { authorizer: { jwt: { claims: { sub: "user-1" } } } },
  body: body && JSON.stringify(body)
});
const show = r => console.log(r.statusCode, r.body.slice(0, 140));
show(await handler(ev("GET /v1/apps/{appId}", { appId: "bowandarrow-hunt" })));
show(await handler(ev("GET /v1/apps/{appId}", { appId: "nope" })));
const body = { title: "Elk 2027 – GMU 61", externalUrl: "https://hunt.bowandarrow.fyi/plans/8f2c", referenceArea: "https://hunt.bowandarrow.fyi/data/gmu-61.geojson" };
const a = await handler(ev("PUT /v1/apps/{appId}/maps/{externalRef}", { appId: "bowandarrow-hunt", externalRef: "plan_8f2c" }, body)); show(a);
const b = await handler(ev("PUT /v1/apps/{appId}/maps/{externalRef}", { appId: "bowandarrow-hunt", externalRef: "plan_8f2c" }, body)); show(b);
console.log("same map reused:", JSON.parse(a.body).datasetId === JSON.parse(b.body).datasetId, "maps stored:", store.length);
show(await handler(ev("PUT /v1/apps/{appId}/maps/{externalRef}", { appId: "bowandarrow-hunt", externalRef: "x" }, { externalUrl: "https://evil.example/steal" })));
show(await handler(ev("PUT /v1/apps/{appId}/maps/{externalRef}", { appId: "bowandarrow-hunt", externalRef: "x" }, { referenceArea: "https://evil.example/a.geojson" })));
