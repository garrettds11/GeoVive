# GeoVive backend

Infrastructure-as-code (AWS SAM) for the GeoVive API. `template.yaml` is the source of truth for:

| Resource | Name (dev) |
|---|---|
| HTTP API | `geovive-dev-backend` stack → `https://gb9ylm02sb.execute-api.us-east-1.amazonaws.com/dev` |
| Lambda | `geovive-dev-api` (all routes, `src/handler.mjs`) |
| DynamoDB | `geovive-dev-datasets` (PK `datasetId`; GSIs `byVisibility`, `byOwner`) |
| DynamoDB | `geovive-dev-features` (PK `datasetId`, SK `featureId`) |

Cognito (pool `us-east-1_cLqbEZJhi`) is referenced by parameter, not managed here.

## Access model
- **Reads are public at the gateway.** The handler returns public datasets to anyone; private datasets only to their owner (verified Cognito access token, optional `Authorization: Bearer`). Non-owners get 404.
- **Writes require sign-in** (API Gateway JWT authorizer) and the handler checks the caller owns the dataset.

## Routes (`/v1`)
| Method | Path | Auth |
|---|---|---|
| GET | `/datasets` | optional (adds your private datasets) |
| POST | `/datasets` | required |
| GET | `/datasets/{datasetId}` | optional |
| PATCH / DELETE | `/datasets/{datasetId}` | required, owner |
| GET | `/datasets/{datasetId}/features` | optional (`limit`, `nextToken`) |
| POST | `/datasets/{datasetId}/features` | required, owner |
| GET | `/datasets/{datasetId}/features/{featureId}` | optional |
| PUT / DELETE | `/datasets/{datasetId}/features/{featureId}` | required, owner |

## Deploy
```bash
npm ci
npm run build          # bundles src/ -> dist/index.mjs
sam deploy --config-env dev
```
Requires the AWS SAM CLI and credentials for account 666993265047.

## Seed data
`node scripts/build-capitals.mjs` writes `seed/world-capitals.json` (215 national + alternate capitals from Natural Earth, public domain) into the public `world-capitals` dataset, owned by `system`.
