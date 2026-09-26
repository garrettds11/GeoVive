# GeoVivé

A map for exploring places and keeping your own collections of pinned locations: https://geovive.link

GeoVivé is meant to be a neutral map-data platform. It stores places, shapes, time, source information and stable IDs, and other apps can build on it. Everyone signs in to GeoVivé, and GeoVivé holds the master copy of each map.

- User guide: https://geovive.link/docs/
- API reference and "Open in GeoVivé" links: https://geovive.link/docs/developers/
- API spec: `openapi.yaml`

## Features

- **Browse** public maps without signing in. World Capitals (from Natural Earth) is the default.
- **Sign in** with email and password or with Google. Accounts with the same email are linked.
- **My maps:** create public or private maps and add, edit or delete pins.
- **Layers:**
  - Show several datasets at once. Each has its own categories and legend.
  - Turn on live government overlays: USGS topo, relief, imagery and water; BLM land ownership; National Forest boundaries; states and counties.
- **Map controls:** scale bars, compass, north lock and a 3D view (terrain and buildings). The map keeps its view when you switch datasets or styles.
- **Open in GeoVivé links:** a connected app sends a user to `/open?app=&ref=&title=&area=&return=`. GeoVivé finds or creates that user's map for the item, shows the app's area, and sends the user back with `?geovive_map=<id>`. Apps are registered in `backend/src/apps.mjs`.

## Repository layout

| Path | What it is |
|---|---|
| `index.html` | The map app (static HTML + Mapbox GL JS) |
| `scripts/auth.js`, `scripts/main.js` | Sign-in via Cognito (oidc-client-ts, loaded from a CDN) |
| `scripts/editor.js` | My maps and pin editing |
| `scripts/layers.js` | Layers panel: extra datasets and overlays |
| `scripts/catalog.js` | Catalog of approved external overlays (source, license, attribution) |
| `scripts/open.js` | "Open in GeoVivé" links from connected apps |
| `scripts/build-config.mjs` | Writes `config.js` from environment variables at build time |
| `docs/` | Public user guide and developer docs, served at `/docs/` |
| `backend/` | API, Lambdas and DynamoDB tables as AWS SAM (see `backend/README.md`) |
| `infra/` | CloudFormation for Cognito (`identity.yaml`) and Amplify (`web.yaml`); see `infra/README.md` |
| `openapi.yaml` | API specification |
| `amplify.yml` | Amplify build settings |

## Running locally

1. Create a Mapbox public token restricted to `http://localhost:8080`. The production token only works on geovive.link.
2. Generate the config and serve the folder:

   ```bash
   MAPBOX_ACCESS_TOKEN=pk.xxx node scripts/build-config.mjs
   python -m http.server 8080
   ```

3. Open http://localhost:8080.
   - The local site uses the shared API.
   - Signing in locally requires adding `http://localhost:8080/` to the Cognito app client's callback and sign-out URLs in `infra/identity.yaml`.
   - The `/open` path needs a server that falls back to `index.html`. Amplify does this; `python -m http.server` doesn't.

`config.js` is generated and ignored by git. Never commit tokens or secrets.

## Branches and releases

| Branch | Site | Amplify stage |
|---|---|---|
| `main` | https://geovive.link (and www) | Production |
| `dev` | https://dev.geovive.link | Development |

To release: work on `dev`, push, test on dev.geovive.link, then open a pull request from `dev` to `main`. Amplify builds each branch on push, running `npm run build` to generate `config.js` from the `MAPBOX_ACCESS_TOKEN` environment variable. Changing that variable requires a redeploy.

Both sites currently share one API and user pool. A separate dev backend is planned before real users arrive.

## Backend and infrastructure (us-east-1)

| Piece | Where |
|---|---|
| Site | Amplify app `d24kp6zzj6jjwt`, custom domains `geovive.link` and `dev.geovive.link` |
| API | `api.geovive.link`, SAM stack `geovive-dev-backend` (`backend/template.yaml`) |
| Sign-in | Cognito pool `us-east-1_cLqbEZJhi`, domain `auth.geovive.link`, email/password and Google; stack `geovive-dev-identity` (`infra/identity.yaml`) |
| Email | SES, sent from `no-reply@geovive.link` |
| DNS / certificate | Route 53 zone for `geovive.link`; ACM certificate for `geovive.link` and `*.geovive.link` |

- **Deploy the backend:** `cd backend && npm ci && npm test && sam deploy --config-env dev`.
- **Secrets:** the Google client secret lives in AWS Secrets Manager (`geovive/google-oauth`), never in the repo.
- **Not yet managed as code:** Amplify (the template in `infra/web.yaml` is ready but needs a GitHub token to import), managed-login branding, SES, and DNS records.
