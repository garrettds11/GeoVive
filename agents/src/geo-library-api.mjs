// Shared client every agent (Curator, Reviewer, Governor) uses to call the public /v1 API as
// geo-library -- readiness doc Section 3.5: agents write through the exact same auth/validation
// path as any human user, never a direct table write, never a shared in-process validation module.
//
// Auth: geo-library is a real Cognito user (see geo-library-account.mjs) signed in through the
// same WebClient as any human sign-up, using the newer USER_AUTH InitiateAuth flow with PASSWORD
// as the first factor (infra/identity.yaml's SignInPolicy.AllowedFirstAuthFactors already allows
// this) -- a non-interactive, non-OAuth-redirect sign-in that needs zero changes to the existing
// auth stack. We cache the ACCESS token (not the ID token): the backend's inline verifier on
// routes with an optional Bearer token -- GET /datasets, GET .../features/{id}, etc. -- is
// configured with tokenUse: "access" and rejects an ID token outright. The access token is
// cached in-memory for the life of the Lambda execution environment and refreshed a minute
// before it expires (AccessTokenValidity is 1 day, so in practice one sign-in covers many runs
// on a warm container, and a cold start just signs in again).

import { CognitoIdentityProviderClient, InitiateAuthCommand, RespondToAuthChallengeCommand } from "@aws-sdk/client-cognito-identity-provider";
import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";

const cognito = new CognitoIdentityProviderClient({});
const secrets = new SecretsManagerClient({});

const API_BASE = process.env.GEOVIVE_API_BASE || "https://api.geovive.link/v1";
const USER_POOL_CLIENT_ID = process.env.USER_POOL_CLIENT_ID || "hfchi8fm98nberrcj43ge2ipu";
const CREDENTIALS_SECRET_ARN = process.env.GEO_LIBRARY_CREDENTIALS_SECRET_ARN;

let cachedToken = null;   // { accessToken, expiresAt }
let cachedCreds = null;   // { email, password } -- one Secrets Manager read per cold start

async function loadCredentials() {
  if (cachedCreds) return cachedCreds;
  if (!CREDENTIALS_SECRET_ARN) throw new Error("GEO_LIBRARY_CREDENTIALS_SECRET_ARN not set");
  const { SecretString } = await secrets.send(new GetSecretValueCommand({ SecretId: CREDENTIALS_SECRET_ARN }));
  cachedCreds = JSON.parse(SecretString);
  return cachedCreds;
}

async function signIn() {
  const { email, password } = await loadCredentials();

  // USER_AUTH, PASSWORD as the first factor -- see file header. Unlike an out-of-band factor
  // (EMAIL_OTP, SMS_OTP, WEB_AUTHN), Cognito's USER_AUTH flow expects PASSWORD supplied
  // directly in AuthParameters on this same initial call when you already have it -- there is
  // no separate PASSWORD challenge round-trip to respond to. Passing only USERNAME +
  // PREFERRED_CHALLENGE: "PASSWORD" (the original approach here) gets rejected server-side
  // with InvalidParameterException: "Missing required parameter PASSWORD", confirmed against
  // the live pool (us-east-1_cLqbEZJhi) and client (GeoVive, ALLOW_USER_AUTH) -- both are
  // correctly configured, so this was purely a request-shape bug, not an infra one.
  const initiate = await cognito.send(new InitiateAuthCommand({
    AuthFlow: "USER_AUTH",
    ClientId: USER_POOL_CLIENT_ID,
    AuthParameters: { USERNAME: email, PASSWORD: password, PREFERRED_CHALLENGE: "PASSWORD" }
  }));

  let result = initiate.AuthenticationResult;
  // Defensive fallback: if some future config change reintroduces a real PASSWORD challenge,
  // still answer it rather than failing outright.
  if (!result && initiate.ChallengeName === "PASSWORD") {
    const respond = await cognito.send(new RespondToAuthChallengeCommand({
      ClientId: USER_POOL_CLIENT_ID,
      ChallengeName: "PASSWORD",
      Session: initiate.Session,
      ChallengeResponses: { USERNAME: email, PASSWORD: password }
    }));
    result = respond.AuthenticationResult;
  }
  // The backend's inline verifier (used on routes that accept an optional Bearer token
  // rather than an API Gateway JWT authorizer -- GET /datasets, GET .../features/{id}, etc.)
  // is configured with tokenUse: "access" and rejects an ID token outright (401). We were
  // caching and sending the ID token here; every one of those calls failed auth, and every
  // caller in this file wraps its list/get calls in a .catch() that quietly falls back to an
  // empty result -- so Reviewer/Governor silently saw zero of their own review-visibility
  // datasets (only public ones) instead of erroring loudly. Use the access token instead.
  if (!result?.AccessToken) throw new Error("geo-library sign-in did not return tokens");

  const expiresAt = Date.now() + (Number(result.ExpiresIn || 3600) - 60) * 1000; // refresh 60s early
  cachedToken = { accessToken: result.AccessToken, expiresAt };
  return cachedToken.accessToken;
}

async function getToken() {
  if (cachedToken && Date.now() < cachedToken.expiresAt) return cachedToken.accessToken;
  return signIn();
}

// Thin fetch wrapper: JSON in, JSON out, throws on non-2xx with the response body attached.
async function call(method, path, body) {
  const token = await getToken();
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const err = new Error(`${method} ${path} -> ${res.status}: ${json?.message || text}`);
    err.status = res.status;
    err.body = json;
    throw err;
  }
  return json;
}

// ------------------------------------------------------------------ dataset operations

export const createDataset = (fields) => call("POST", "/datasets", fields);
export const getDataset = (datasetId) => call("GET", `/datasets/${datasetId}`);
export const updateDataset = (datasetId, fields) => call("PATCH", `/datasets/${datasetId}`, fields);

// ------------------------------------------------------------------ feature operations

export function listFeatures(datasetId, { limit, nextToken } = {}) {
  const qs = new URLSearchParams();
  if (limit) qs.set("limit", String(limit));
  if (nextToken) qs.set("nextToken", nextToken);
  const q = qs.toString();
  return call("GET", `/datasets/${datasetId}/features${q ? `?${q}` : ""}`);
}
export const createFeature = (datasetId, feature) => call("POST", `/datasets/${datasetId}/features`, feature);
export const updateFeature = (datasetId, featureId, feature) => call("PUT", `/datasets/${datasetId}/features/${featureId}`, feature);
export const deleteFeature = (datasetId, featureId) => call("DELETE", `/datasets/${datasetId}/features/${featureId}`);
// NOTE: /features/batch is delete/move/copy only (openapi.yaml) -- it does NOT bulk-create.
// Bulk creation goes through the async import API below (getImportUploadUrl -> PUT -> startImport -> poll).

// ------------------------------------------------------------------ bulk import (async)

export const getImportUploadUrl = (datasetId) => call("POST", `/datasets/${datasetId}/imports/upload-url`);

// Raw PUT to the presigned URL -- not through call(): no bearer auth (the URL itself is the
// authorization) and the content-type must exactly match what upload-url returned.
async function uploadToPresignedUrl(uploadUrl, contentType, bodyText) {
  const res = await fetch(uploadUrl, { method: "PUT", headers: { "content-type": contentType }, body: bodyText });
  if (!res.ok) throw new Error(`Presigned upload PUT failed: ${res.status} ${res.statusText}`);
}

export const startImport = (datasetId, importRequest) => call("POST", `/datasets/${datasetId}/imports`, importRequest);
export const getImport = (datasetId, importId) => call("GET", `/datasets/${datasetId}/imports/${importId}`);

// Orchestrates the full bulk-create path for a FeatureCollection Curator has already built and
// mapped deterministically: get a presigned upload slot, PUT the GeoJSON, start the import, and
// poll until it leaves queued/running (bounded by maxWaitMs so a slow import can't blow through
// Curator's own MAX_RUN_MS budget -- on timeout the import keeps running server-side and the
// caller gets back a "still running" status rather than a false failure).
export async function importFeatureCollection(datasetId, featureCollection, { mode = "append", nameField, categoryField, maxWaitMs = 120_000, pollMs = 3000 } = {}) {
  const { key, uploadUrl, contentType } = await getImportUploadUrl(datasetId);
  await uploadToPresignedUrl(uploadUrl, contentType || "application/geo+json", JSON.stringify(featureCollection));

  let imp = await startImport(datasetId, {
    source: { type: "upload", key, fileName: "curator-structured-import.geojson" },
    mode,
    ...(nameField ? { nameField } : {}),
    ...(categoryField ? { categoryField } : {})
  });

  const deadline = Date.now() + maxWaitMs;
  while ((imp.status === "queued" || imp.status === "running") && Date.now() < deadline) {
    await new Promise(r => setTimeout(r, pollMs));
    imp = await getImport(datasetId, imp.importId);
  }
  return imp; // status: succeeded | failed | (still queued/running if maxWaitMs was hit)
}

// ------------------------------------------------------------------ read paths used for topic dedup (Curator)

export const listAllDatasets = () => call("GET", "/datasets"); // public listing; geo-library sees only public+its own per existing auth rules -- fine for dedup, which only needs published topics
