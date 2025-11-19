// auth.js
import { UserManager, WebStorageStateStore } from "oidc-client-ts";

const cognitoAuthConfig = {
  // Cognito *issuer* (user pool OIDC authority)
  authority: "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_cLqbEZJhi",

  // Your SPA app client ID
  client_id: "hfchi8fm98nberrcj43ge2ipu",

  // Must exactly match a Callback URL in your app client settings
  redirect_uri: "https://d84l1y8p4kdic.cloudfront.net/",

  response_type: "code",

  // Must be allowed in your Cognito app client
  scope: "openid email profile",

  // Store session in localStorage so it survives reloads
  userStore: new WebStorageStateStore({ store: window.localStorage })
};

// Central auth engine
export const userManager = new UserManager(cognitoAuthConfig);

// Make it available to inline scripts like index.html
window.userManager = userManager;

// ========== Basic auth helpers ==========

export async function login() {
  // Redirects to Cognito Hosted UI (which then shows Google)
  await userManager.signinRedirect();
}

export async function handleRedirectCallback() {
  // Called on page load to process ?code=...&state=... if present
  try {
    const user = await userManager.signinCallback();
    return user;
  } catch (e) {
    // If we're not actually on the callback URL, this will often throw.
    // That's normal; just ignore it.
    return null;
  }
}

export async function getCurrentUser() {
  return userManager.getUser(); // returns user or null
}

export async function logout() {
  // Easiest: redirect through Cognito logout
  const clientId = "hfchi8fm98nberrcj43ge2ipu";
  const logoutUri = "https://d84l1y8p4kdic.cloudfront.net/"; // same as your SPA root
  const cognitoDomain = "https://us-east-1clqbezjhi.auth.us-east-1.amazoncognito.com";

  window.location.href =
    `${cognitoDomain}/logout?client_id=${clientId}` +
    `&logout_uri=${encodeURIComponent(logoutUri)}`;
}

// Convenience getter for the access token
export async function getAccessToken() {
  const user = await getCurrentUser();
  return user?.access_token || null;
}
