# GeoVivé

**A neutral map-data platform.** GeoVivé stores real-world places and shapes, along with their time, source and stable IDs, and shows them on an interactive map. People can browse public maps and keep their own. Other apps can build on the same data.

Live at https://geovive.link · [User guide](https://geovive.link/docs/) · [Developer docs](https://geovive.link/docs/developers/)

## Purpose

GeoVivé is the "reality spine": the neutral store of geospatial truth. It keeps each feature's geometry, time, metadata, provenance and stable ID. It deliberately doesn't interpret the data. Analysis, context and alerts belong in products built on top of it, such as Watchfield (intelligence overlays) and connected apps like Bow & Arrow Hunt.

Principles:

- GeoVivé holds the master copy of map data.
- Everyone signs in to GeoVivé, and apps connect to it.
- Datasets define their own categories; GeoVivé imposes no fixed vocabulary.
- External sources are shown with their attribution and license.

## What it does

- **Explore:**
  - Browse public datasets on a Mapbox map, then filter by category and inspect features.
  - Switch between map styles, with a 3D terrain view.
  - Show several datasets together, plus live government overlays (topography, land ownership, boundaries, water).
- **Own your maps:** sign in with email and password or with Google, then create public or private maps and add, edit and delete pins.
- **Connect apps:** a registered app can send a user to GeoVivé with an "Open in GeoVivé" link. The user works on their map there and returns to the app with a reference to it. A public REST API (`openapi.yaml`) serves datasets and features.

## Architecture

```
Browser (static site, Mapbox GL JS)
   │  sign-in (OIDC)            │  REST (JWT)
   ▼                            ▼
Cognito ── Google          API Gateway ─► Lambda ─► DynamoDB
auth.geovive.link          api.geovive.link          (datasets, features)
```

- **Frontend:**
  - A static site on AWS Amplify: plain HTML with ES modules and no framework or bundler.
  - `config.js` is generated at build time from environment variables.
- **Backend:** AWS SAM on Node.js (one API Lambda and a Cognito pre sign-up Lambda that links accounts by email), with DynamoDB tables for datasets and features.
- **Identity:** a Cognito user pool with a branded hosted sign-in page (email + password and Google). SES sends the emails.
- **Region:** everything runs in AWS us-east-1. Resources are tagged `project=geovive`.

## Repository layout

| Path | Contents |
|---|---|
| `index.html` | The map app |
| `scripts/` | Front-end modules:<br>• `auth.js` / `main.js`: sign-in<br>• `editor.js`: my maps, pins<br>• `layers.js` / `catalog.js`: layers and overlays<br>• `open.js`: app links<br>• `build-config.mjs`: config generator |
| `docs/` | Public user guide and developer docs (served at `/docs/`) |
| `backend/` | SAM template, Lambda source, tests, data scripts (see `backend/README.md`) |
| `infra/` | CloudFormation for Cognito and Amplify (see `infra/README.md`) |
| `openapi.yaml` | API specification |
| `amplify.yml` | Amplify build settings |

## Development

**Run locally:**

```bash
MAPBOX_ACCESS_TOKEN=pk.xxx node scripts/build-config.mjs   # token restricted to localhost
python -m http.server 8080
```

- The local site uses the shared API.
- Signing in locally requires adding `http://localhost:8080/` to the Cognito client's callback and sign-out URLs.

**Branches and releases:**

- `dev` deploys to https://dev.geovive.link, which is password-protected (Amplify basic auth; ask the owner for access).
- `stage-d24kp6zzj6jjwt` deploys to https://stage-d24kp6zzj6jjwt.d24kp6zzj6jjwt.amplifyapp.com (no password; used for automated checks).
- `main` deploys to https://geovive.link.
- The release flow: work on `dev`, test on the dev site, then open a pull request from `dev` to `main`.

**Backend:** `cd backend && npm ci && npm test && sam deploy --config-env dev`

**Secrets:** never commit tokens or secrets.

- `config.js` is generated and git-ignored.
- The Google client secret is kept in AWS Secrets Manager.

## Status

This is an early beta. Browsing, sign-in, personal maps, layers and app links work in production.

Next up:

- storing large shapes
- importing data from external sources, with provenance
- upload and export
- a separate dev backend
- full connected-app authorization (consent screen and per-app access)
- shared maps
