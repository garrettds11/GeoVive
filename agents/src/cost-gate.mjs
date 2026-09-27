// Cost gate (build-order item 4 / readiness doc Section 4.4, 9.2). Checked before any run
// starts, and (once model calls happen -- item 9) before every individual model call too.
// Two independent stops, either one blocks:
//   1. the run flag (9.2) -- an admin-controlled kill switch, off by default
//   2. month-to-date tagged spend >= the $20/month limit
// AWS Budgets (BudgetAlarm below) is the backstop that hard-stops Bedrock itself at 100% --
// this gate is meant to catch it first, with a clean "blocked" result instead of a thrown error.

import { SSMClient, GetParameterCommand } from "@aws-sdk/client-ssm";
import { CostExplorerClient, GetCostAndUsageCommand } from "@aws-sdk/client-cost-explorer";

const ssm = new SSMClient({});
const ce = new CostExplorerClient({ region: "us-east-1" }); // Cost Explorer API is us-east-1 only

const RUN_PARAM = "/geovive/agents/run";
const MONTHLY_LIMIT_USD = Number(process.env.MONTHLY_LIMIT_USD || 20);

function monthStartISO() {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), 1).toISOString().slice(0, 10);
}
function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

export async function checkGate() {
  const { Parameter } = await ssm.send(new GetParameterCommand({ Name: RUN_PARAM }));
  if (Parameter?.Value !== "true") {
    return { allowed: false, reason: "run flag is off (/geovive/agents/run != \"true\")" };
  }

  // Cost Explorer's data lags by a few hours; that's an accepted imprecision for a soft gate --
  // AWS Budgets (see below) is the hard backstop against the rare burst it might miss.
  const { ResultsByTime } = await ce.send(new GetCostAndUsageCommand({
    TimePeriod: { Start: monthStartISO(), End: todayISO() },
    Granularity: "MONTHLY",
    Metrics: ["UnblendedCost"],
    Filter: {
      Tags: { Key: "component", Values: ["agents"] }
    }
  }));
  const spent = Number(ResultsByTime?.[0]?.Total?.UnblendedCost?.Amount || 0);
  if (spent >= MONTHLY_LIMIT_USD) {
    return { allowed: false, reason: `month-to-date tagged cost $${spent.toFixed(2)} >= $${MONTHLY_LIMIT_USD} limit` };
  }
  return { allowed: true, spentUsd: spent };
}
