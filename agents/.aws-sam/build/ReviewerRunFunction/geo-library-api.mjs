// Shared client every agent (Curator, Reviewer, Governor) uses to call the public /v1 API as
// geo-library -- readiness doc Section 3.5: agents write through the exact same auth/validation
// path as any human user, never a direct table write, never a shared in-process validation module.
//
// Auth: geo-library is a real Cognito user (see geo-library-account.mjs) signed in through the
// same WebClient as any human sign-up, using the newer USER_AUTH InitiateAuth flow with PASSWORD
// as the first factor (infra/identity.yaml's SignInPolicy.AllowedFirstAuthFactors already allows
// this) -- a non-interactive, non-OAuth-redirect sign-in that needs zero changes to the existing
// auth stack. The resulting ID token is cached in-memory for the life of the Lambda execution
// environment and refreshed a minute before it expires (IdTokenValidity is 1 day, so in practice
// one sign-in covers many runs on a warm container, and a cold start just signs in again).

import { CognitoIdentityProviderClient, InitiateAuthCommand, RespondToAuthChallengeCommand } from "@aws-sdk/client-cognito-identity-provider";
import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";

const cognito = new CognitoIdentityProviderClient({});
const secrets = new SecretsManagerClient({});

const API_BASE = process.env.GEOVIVE_API_BASE || "https://api.geovive.link/v1";
const USER_POOL_CLIENT_ID = process.env.USER_POOL_CLIENT_ID || "hfchi8fm98nberrcj43ge2ipu";
const CREDENTIALS_SECRET_ARN = process.env.GEO_LIBRARY_CREDENTIALS_SECRET_ARN;

let cachedToken = null;   // { idToken, expiresAt }
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

  // USER_AUTH with PASSWORD as the first (and only) factor -- see file header.
  const initiate = await cognito.send(new InitiateAuthCommand({
    AuthFlow: "USER_AUTH",
    ClientId: USER_POOL_CLIENT_ID,
    AuthParameters: { USERNAME: email, PREFERRED_CHALLENGE: "PASSWORD" }
  }));

  let result = initiate.AuthenticationResult;
  if (!result && initiate.ChallengeName === "PASSWORD") {
    const respond = await cognito.send(new RespondToAuthChallengeCommand({
      ClientId: USER_POOL_CLIENT_ID,
      ChallengeName: "PASSWORD",
      Session: initiate.Session,
      ChallengeResponses: { USERNAME: email, PASSWORD: password }
    }));
    result = respond.AuthenticationResult;
  }
  if (!result?.IdToken) throw new Error("geo-library sign-in did not return tokens");

  const expiresAt = Date.now() + (Number(result.ExpiresIn || 3600) - 60) * 1000; // refresh 60s early
  cachedToken = { idToken: result.IdToken, expiresAt };
  return cachedToken.idToken;
}

async function getToken() {
  if (cachedToken && Date.now() < cachedToken.expiresAt) return cachedToken.idToken;
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

export const listFeatures = (datasetId) => call("GET", `/datasets/${datasetId}/features`);
export const createFeature = (datasetId, feature) => call("POST", `/datasets/${datasetId}/features`, feature);
export const updateFeature = (datasetId, featureId, feature) => call("PUT", `/datasets/${datasetId}/features/${featureId}`, feature);
export const deleteFeature = (datasetId, featureId) => call("DELETE", `/datasets/${datasetId}/features/${featureId}`);
export const batchFeatures = (datasetId, features) => call("POST", `/datasets/${datasetId}/features/batch`, { features });

// ------------------------------------------------------------------ read paths used for topic dedup (Curator)

export const listAllDatasets = () => call("GET", "/datasets"); // public listing; geo-library sees only public+its own per existing auth rules -- fine for dedup, which only needs published topics
