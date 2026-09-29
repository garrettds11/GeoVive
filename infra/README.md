# GeoVivé infrastructure (CloudFormation)

| Stack | Template | Contents | Status |
|---|---|---|---|
| `geovive-dev-backend` | `backend/template.yaml` (SAM) | API, Lambdas (API + pre sign-up), DynamoDB tables | Managed |
| `geovive-dev-identity` | `infra/identity.yaml` | Cognito user pool, web app client, `auth.geovive.link` + prefix domains, Google provider | Managed (imported 2026-09-26) |
| `geovive-dev-web` | `infra/web.yaml` | Amplify app, `dev` branch, `geovive.link` domain | **Not imported yet**: needs a GitHub token (see below) |

## Updating the identity stack

Edit `identity.yaml`, then deploy a change set and review it before executing:

```bash
aws cloudformation deploy --stack-name geovive-dev-identity \
  --template-file infra/identity.yaml --no-execute-changeset
```

Cognito changes can lock users out, so always read the change set. Everything has
`DeletionPolicy: Retain`: deleting the stack never deletes the user pool.

The Google client secret is not in the template. It is read at deploy time from
Secrets Manager (`geovive/google-oauth`, keys `client_id` and `client_secret`).

Not in the template (managed in the console/API): the managed-login branding
(colors and logo), and SES (`geovive.link` identity).

## Amplify (pending)

CloudFormation can only manage the Amplify app with a GitHub access token. To finish:
1. Create a fine-grained GitHub token with access to `garrettds11/GeoVive`
   (Contents: read, Webhooks: read/write).
2. Store it in Secrets Manager as `geovive/github-token`.
3. Add `AccessToken: '{{resolve:secretsmanager:geovive/github-token}}'` to `WebApp` and import
   `web.yaml` as `geovive-dev-web` (resource import: App, Branch, Domain).

## Addresses kept out of the repo

Amplify branch addresses (dev, stage) are allowed at deploy time rather than written in the templates:

- `geovive-dev-identity`: parameter `PrivateAppUrls` (comma-separated, each URL with and without a trailing slash) is added to the sign-in and sign-out URLs.
- `geovive-dev-backend`: parameter `AllowedOrigins` holds the full list of site origins. The template default lists only the public ones. The demo app's allowed return addresses use the same list.

When deploying, reuse the stack's previous values for these parameters (or pass them explicitly). Don't deploy with the defaults, or sign-in and the API stop working on dev and stage.

## mail.yaml

Inbound mail for the domain. Mail to `admin@geovive.link` is received by Amazon SES (spam and virus scanned), stored in a private S3 bucket for 90 days, and forwarded by a small Lambda to the admin inbox (parameter `ForwardTo`). Forwarded copies come from `admin@geovive.link` with the original sender as Reply-To. Stack: `geovive-mail`. After creating it, activate the rule set once: `aws ses set-active-receipt-rule-set --rule-set-name geovive-inbound`. To add addresses, change the `Recipients` parameter.
