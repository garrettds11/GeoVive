// auth.js
import { UserManager, WebStorageStateStore } from "oidc-client-ts";

const cognitoAuthConfig = {
  authority: "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_cLqbEZJhi",
  client_id: "hfchi8fm98nberrcj43ge2ipu",
  redirect_uri: "https://d84l1y8p4kdic.cloudfront.net", // must exactly match Cognito callback URL
  response_type: "code",
  scope: "openid email openid phone profile".replace(/\s+openid/, "openid"), // or just "openid email profile"
  userStore: new WebStorageStateStore({ store: window.localStorage }) // keep session across reloads
};

// create a UserManager instance
export const userManager = new UserManager(cognitoAuthConfig);

export async function signOutRedirect() {
  const clientId = "hfchi8fm98nberrcj43ge2ipu";
  const logoutUri = "https://d84l1y8p4kdic.cloudfront.net"; // <-- use your app URL here
  const cognitoDomain = "https://us-east-1clqbezjhi.auth.us-east-1.amazoncognito.com";

  window.location.href =
    `${cognitoDomain}/logout?client_id=${clientId}` +
    `&logout_uri=${encodeURIComponent(logoutUri)}`;
}

export async function login() {
  await userManager.signinRedirect();
}

export async function handleRedirectCallback() {
  try {
    const user = await userManager.signinCallback();
    return user;
  } catch (e) {
    // If we're not actually on the callback URL (no ?code=?state=), this will usually throw
    // It's safe to just ignore in that case.
    return null;
  }
}

export async function getCurrentUser() {
  return userManager.getUser(); // returns user or null
}

export async function logout() {
  // Optional: you can call signOutRedirect or userManager.signoutRedirect directly
  await signOutRedirect();
}
