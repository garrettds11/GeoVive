# GeoVivé

A map for exploring places and keeping your own collections of pinned locations: https://geovive.link

- User guide: https://geovive.link/docs/
- API reference: https://geovive.link/docs/developers/

## Repository layout

| Path | What it is |
|---|---|
| `index.html` | The map app (static HTML + Mapbox GL JS) |
| `scripts/auth.js`, `scripts/main.js` | Google sign-in via Cognito (oidc-client-ts, loaded from a CDN) |
| `scripts/editor.js` | My maps and pin editing |
| `scripts/build-config.mjs` | Writes `config.js` from environment variables at build time |
| `docs/` | Public user guide and developer docs, served at `/docs/` |
| `backend/` | API, Lambda and DynamoDB tables as AWS SAM (see `backend/README.md`) |
| `amplify.yml` | Amplify build settings |

## Running locally

1. Create a Mapbox public token restricted to `http://localhost:8080` (the production token only works on geovive.link).
2. Generate the config and serve the folder:

   ```bash
   MAPBOX_ACCESS_TOKEN=pk.xxx node scripts/build-config.mjs
   python -m http.server 8080
   ```

3. Open http://localhost:8080. The local site uses the dev API; signing in requires `http://localhost:8080/` to be added to the Cognito app client's callback and sign-out URLs.

`config.js` is generated and ignored by git. Never commit tokens.

## Deploying

- **Frontend:** pushing to `dev` triggers an Amplify build (app `d24kp6zzj6jjwt`), which runs `npm run build` to generate `config.js` from the `MAPBOX_ACCESS_TOKEN` environment variable. Changing that variable requires a redeploy.
- **Backend:** `cd backend && npm ci && npm run build && sam deploy --config-env dev`.

## Infrastructure (us-east-1)

| Piece | Where |
|---|---|
| Site | Amplify, custom domain `geovive.link` |
| API | `api.geovive.link` (SAM stack `geovive-dev-backend`) |
| Sign-in | Cognito pool `us-east-1_cLqbEZJhi`, domain `auth.geovive.link`, Google identity provider |
| DNS / certificate | Route 53 zone for `geovive.link`; ACM certificate for `geovive.link` and `*.geovive.link` |

Cognito and Amplify are configured in AWS directly (not yet in the SAM template).
