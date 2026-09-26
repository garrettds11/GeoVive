// auth.js
import { UserManager, WebStorageStateStore } from "oidc-client-ts";

// Sign-in returns to whichever GeoVive address the user is on
// (must be listed in the Cognito app client's callback URLs).
const APP_URL = `${window.location.origin}/`;
const COGNITO_DOMAIN = window.location.hostname.endsWith("geovive.link")
  ? "https://auth.geovive.link"
  : "https://us-east-1clqbezjhi.auth.us-east-1.amazoncognito.com";

const cognitoAuthConfig = {
  // Cognito *issuer* (user pool OIDC authority)
  authority: "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_cLqbEZJhi",

  // Your SPA app client ID
  client_id: "hfchi8fm98nberrcj43ge2ipu",

  // Must exactly match a Callback URL in your app client settings
  redirect_uri: APP_URL,

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
  // Opens the GeoVivé sign-in page (email + password, or Continue with Google).
  // prompt=select_account makes Google show its account chooser, so users can
  // switch Google accounts at every sign-in.
  await userManager.signinRedirect({ prompt: "select_account" });
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
  const clientId = "hfchi8fm98nberrcj43ge2ipu";
  const logoutUri = APP_URL;
  const cognitoDomain = COGNITO_DOMAIN;

  // 1) Revoke the refresh token at Cognito, so it can't mint new access tokens
  //    even if it was copied. (Access tokens already issued expire on their own.)
  const user = await userManager.getUser();
  if (user?.refresh_token) {
    try {
      await fetch(`${cognitoDomain}/oauth2/revoke`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token: user.refresh_token, client_id: clientId })
      });
    } catch (e) {
      console.warn("Token revocation failed", e);
    }
  }

  // 2) Clear the local user from oidc-client-ts (localStorage)
  await userManager.removeUser();

  // 3) Redirect to Cognito to clear its sign-in session cookie
  const url =
    `${cognitoDomain}/logout?client_id=${encodeURIComponent(clientId)}` +
    `&logout_uri=${encodeURIComponent(logoutUri)}`;

  window.location.href = url;
}

// Convenience getter for the access token
export async function getAccessToken() {
  const user = await getCurrentUser();
  return user?.access_token || null;
}
