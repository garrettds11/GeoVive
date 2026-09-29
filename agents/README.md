# GeoVive agents infra

Sidecar SAM stack (`geovive-dev-agents`) to `geovive-dev-backend` — see
`claude/AGENTS_READINESS.md` in the project for the full decision record this is built from.

## Status (build-order item 2 of 9)

This piece is the control-plane shell only. No Curator/reviewer sourcing logic exists yet
(that's item 9) — `curator-run.mjs` and `reviewer-run.mjs` are stubs that prove the schedule,
kill switch, cost gate, audit log and notification path all work end to end, then stop.

Built so far:
- **geo-library service account** — a real Cognito user in the same pool as everyone else
  (`geo-library@geovive.link`), created by a custom resource. Agents authenticate as this user
  through the normal sign-in flow, exactly like a human, and write through the public `/v1` API.
- **Backend change (in `../backend`)**: `handler.mjs` now forces every dataset geo-library
  creates into `review` visibility, and blocks it from ever changing that visibility itself —
  only an admin approval (existing review-queue flow) moves it further. `template.yaml` reads
  geo-library's Cognito `sub` from SSM Parameter Store at deploy time.
- **`sourceClass` field** — added to `datamodel.yaml`'s `FeatureProperties` (`managed` /
  `unmanaged`), and `datamodel.json` regenerated. Per-pin, not per-dataset — see the readiness
  doc's Section 2.6 entry for why.
- **Kill switch** — SSM Parameter `/geovive/agents/run`, defaults to `"false"`.
- **Permissions boundary** — `geovive-dev-agents-boundary`, an allow-list every agent Lambda
  role is capped by, regardless of what its own policy grants.
- **Agent-action audit log** — `geovive-dev-agents-audit` DynamoDB table.
- **Status emails** — SES, from `agents@geovive.link` to `admin@geovive.link`.
- **Cost gate + AWS Budgets backstop** — `cost-gate.mjs` checks the run flag and month-to-date
  tagged spend before either stub function does anything; `AgentsBudget` is the hard-stop
  tripwire at 100% of the $20/month limit.
- **Schedules** — EventBridge Scheduler, Curator daily / reviewers every 4 hours, both pointed
  at the stub functions above.

Not yet built (later items):
- AWS Location Service Places integration (item 7) — deliberately deferred; no API key exists
  yet per the readiness doc, and the boundary policy has its permissions commented out until then.
- Web-search provider client (2.6's fallback path) — provider choice itself is deferred to when
  this is actually built.
- Admin page fill-ins (item 8) — kill switch toggle, limits editor, recent-runs panel.
- The Curator/reviewer harness itself (item 9) — tools, prompts, the actual sourcing loop.

## Deploy order — read before deploying

**Deploy this stack (`agents/`) before redeploying `backend/`.** `backend/template.yaml`'s new
`GeoLibrarySub` parameter is `Type: AWS::SSM::Parameter::Value<String>` reading
`/geovive/agents/geo-library-sub` — that parameter doesn't exist until this stack's custom
resource creates the geo-library account and writes it. Deploying `backend/` first (or any
`backend/` deploy right now, before `agents/` has run at least once) will fail parameter
resolution.

```
cd agents && sam build && sam deploy
cd ../backend && sam build && sam deploy
```

## Deliberate non-features

- No Lambda function here ever gets AWS credentials to write DynamoDB directly, touch S3, or
  call any AWS write API outside its own narrow allow-list. Every dataset/feature write goes
  through the public API as geo-library, same as any user (readiness doc 3.5).
- The account-creation custom resource never deletes the geo-library Cognito user or its SSM
  parameter on stack delete/update-replace — see the comment in `src/geo-library-account.mjs`.
