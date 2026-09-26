// Cognito pre sign-up trigger: one GeoVivé user per email address.
//
// - Signing in with a social provider (Google, …) when a verified email+password
//   user already has that email: link the provider to the existing user, so both
//   sign-in methods reach the same account (same `sub`, same maps).
// - Signing up with email+password when a social-provider user already has that
//   email: refuse and tell them which button to use.
//
// Note: on the very first linked sign-in Cognito may show an error once; signing
// in again with the same provider then works. This is a known Cognito behavior.

import {
  CognitoIdentityProviderClient,
  ListUsersCommand,
  AdminLinkProviderForUserCommand,
  AdminDeleteUserCommand
} from "@aws-sdk/client-cognito-identity-provider";

const cognito = new CognitoIdentityProviderClient({});

// Cognito prefixes external usernames with the provider name in lower case.
const PROVIDER_NAMES = {
  google: "Google",
  facebook: "Facebook",
  loginwithamazon: "LoginWithAmazon",
  signinwithapple: "SignInWithApple"
};

function attr(user, name) {
  return user.Attributes?.find(a => a.Name === name)?.Value;
}

async function usersWithEmail(userPoolId, email) {
  const safe = email.replace(/["\\]/g, "");
  const res = await cognito.send(new ListUsersCommand({
    UserPoolId: userPoolId,
    Filter: `email = "${safe}"`
  }));
  return res.Users || [];
}

function providerLabel(user) {
  const prefix = user.Username.split("_")[0];
  return PROVIDER_NAMES[prefix] || "your social account";
}

export const handler = async (event) => {
  const email = event.request.userAttributes?.email?.toLowerCase();
  if (!email) return event;

  const pool = event.userPoolId;
  const existing = await usersWithEmail(pool, email);

  if (event.triggerSource === "PreSignUp_ExternalProvider") {
    const underscore = event.userName.indexOf("_");
    const prefix = event.userName.slice(0, underscore);
    const providerUserId = event.userName.slice(underscore + 1);
    const providerName = PROVIDER_NAMES[prefix];

    const native = existing.filter(u => u.UserStatus !== "EXTERNAL_PROVIDER");
    for (const u of native) {
      const verified = attr(u, "email_verified") === "true" && u.UserStatus === "CONFIRMED";
      if (verified && providerName) {
        await cognito.send(new AdminLinkProviderForUserCommand({
          UserPoolId: pool,
          DestinationUser: { ProviderName: "Cognito", ProviderAttributeValue: u.Username },
          SourceUser: {
            ProviderName: providerName,
            ProviderAttributeName: "Cognito_Subject",
            ProviderAttributeValue: providerUserId
          }
        }));
        console.log(`Linked ${providerName} sign-in to existing user for ${email}`);
        return event;
      }
      if (!verified) {
        // An email+password sign-up that was never confirmed: the person who
        // controls the inbox is now proving it through the provider, so the
        // unconfirmed registration is discarded rather than linked.
        await cognito.send(new AdminDeleteUserCommand({ UserPoolId: pool, Username: u.Username }));
        console.log(`Removed unconfirmed email sign-up for ${email}`);
      }
    }
    // Provider emails (Google) are verified by the provider.
    event.response.autoVerifyEmail = true;
    event.response.autoConfirmUser = true;
    return event;
  }

  if (event.triggerSource === "PreSignUp_SignUp") {
    const external = existing.find(u => u.UserStatus === "EXTERNAL_PROVIDER");
    if (external) {
      throw new Error(`An account with this email already exists. Please use "Continue with ${providerLabel(external)}".`);
    }
  }

  return event;
};
