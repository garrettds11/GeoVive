// Custom-resource Lambda: creates (and keeps in sync) the "geo-library" Cognito user --
// the agents' service account (readiness doc Section 3.4). It is a real user in the same
// pool as everyone else, signed in through the same client, so agent writes go through the
// exact same auth/validation path as any human's (Section 3.5). This resource never deletes
// the account on stack delete/replace -- losing it would strand every agent-created dataset's
// ownerId, so cleanup is deliberately a human decision, not an automatic one.
//
// On success it writes the account's Cognito `sub` to SSM Parameter Store at
// /geovive/agents/geo-library-sub, which backend/template.yaml reads at deploy time
// (AWS::SSM::Parameter::Value<String>) to enforce review-only visibility for this caller.

import {
  CognitoIdentityProviderClient,
  AdminCreateUserCommand,
  AdminSetUserPasswordCommand,
  AdminGetUserCommand,
  UsernameExistsException
} from "@aws-sdk/client-cognito-identity-provider";
import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import { SSMClient, PutParameterCommand } from "@aws-sdk/client-ssm";
import https from "node:https";
import { URL } from "node:url";

const cognito = new CognitoIdentityProviderClient({});
const secrets = new SecretsManagerClient({});
const ssm = new SSMClient({});

function send(event, context, status, data, reason) {
  const body = JSON.stringify({
    Status: status,
    Reason: reason || `See CloudWatch Logs: ${context.logGroupName}`,
    PhysicalResourceId: data.PhysicalResourceId || event.PhysicalResourceId || context.logStreamName,
    StackId: event.StackId,
    RequestId: event.RequestId,
    LogicalResourceId: event.LogicalResourceId,
    NoEcho: false,
    Data: data
  });
  const { hostname, pathname, search } = new URL(event.ResponseURL);
  return new Promise((resolve, reject) => {
    const req = https.request(
      { hostname, path: pathname + search, method: "PUT", headers: { "content-type": "", "content-length": body.length } },
      res => res.on("data", () => {}).on("end", resolve)
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

async function sub(userPoolId, username) {
  const { UserAttributes } = await cognito.send(new AdminGetUserCommand({ UserPoolId: userPoolId, Username: username }));
  return UserAttributes.find(a => a.Name === "sub")?.Value;
}

export const handler = async (event, context) => {
  const { UserPoolId, Email, SecretArn, SubParamName } = event.ResourceProperties;
  try {
    if (event.RequestType === "Delete") {
      // Deliberately not deleting the Cognito user or the SSM parameter -- see file header.
      await send(event, context, "SUCCESS", { PhysicalResourceId: event.PhysicalResourceId });
      return;
    }

    const { SecretString } = await secrets.send(new GetSecretValueCommand({ SecretId: SecretArn }));
    const { password } = JSON.parse(SecretString);

    try {
      await cognito.send(new AdminCreateUserCommand({
        UserPoolId,
        Username: Email,
        // preferred_username is Required: true on the pool (infra/identity.yaml) -- every human
        // sign-up sets one (via Google OIDC's `name` mapping, or presignup.mjs for email sign-up),
        // so geo-library needs one too or AdminCreateUser rejects the whole call.
        UserAttributes: [
          { Name: "email", Value: Email },
          { Name: "email_verified", Value: "true" },
          { Name: "preferred_username", Value: "geo-library" }
        ],
        MessageAction: "SUPPRESS"
      }));
    } catch (e) {
      if (!(e instanceof UsernameExistsException)) throw e;
      // Already exists (e.g. a stack update re-running this resource) -- fine, just re-sync the password below.
    }

    await cognito.send(new AdminSetUserPasswordCommand({ UserPoolId, Username: Email, Password: password, Permanent: true }));
    const userSub = await sub(UserPoolId, Email);

    await ssm.send(new PutParameterCommand({
      Name: SubParamName, // reused as the geo-library-sub parameter name, passed in by the template
      Value: userSub,
      Type: "String",
      Overwrite: true
    }));

    await send(event, context, "SUCCESS", { PhysicalResourceId: userSub, Sub: userSub });
  } catch (err) {
    console.error(err);
    await send(event, context, "FAILED", { PhysicalResourceId: event.PhysicalResourceId || "geo-library-account" }, err.message);
  }
};
