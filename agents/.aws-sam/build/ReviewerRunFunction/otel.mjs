// Minimal, dependency-free OpenTelemetry OTLP/HTTP exporter for the agent Lambdas (build-order
// item 10 / readiness doc Section 9.1: "Observability through OpenTelemetry to Grafana Cloud.
// No X-Ray and no CloudWatch dashboard or custom metrics.").
//
// Deliberately NOT the AWS Distro for OpenTelemetry (ADOT) Lambda layer: that path defaults to
// (.or couples closely with) CloudWatch/X-Ray, which 9.1 explicitly rules out, and pinning an
// exact ADOT layer ARN/version per region would be one more moving part to keep current. This
// module instead POSTs plain OTLP/HTTP JSON spans straight to Grafana Cloud's OTLP endpoint using
// Node 22's built-in fetch -- no extra npm dependency, so it needs no build/bundle step, matching
// every other file in agents/src (CodeUri: src/, zipped as-is).
//
// Grafana Cloud credentials come from Secrets Manager (GRAFANA_OTEL_SECRET_ARN), exactly like
// Tavily's key (curator-run.mjs): the stack ships with a placeholder secret so `sam deploy` and
// every agent run work before Garrett creates a Grafana Cloud account. Until he sets the real
// value, every span export is a silent no-op -- telemetry is strictly best-effort and must never
// be able to break or slow down an agent run.

import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";

const secretsClient = new SecretsManagerClient({});
const SERVICE_NAME = process.env.OTEL_SERVICE_NAME || "geovive-agents";

let cachedCreds; // undefined = not loaded yet; null = unusable/placeholder; object = real creds

async function loadCreds() {
  if (cachedCreds !== undefined) return cachedCreds;
  try {
    const arn = process.env.GRAFANA_OTEL_SECRET_ARN;
    if (!arn) { cachedCreds = null; return cachedCreds; }
    const { SecretString } = await secretsClient.send(new GetSecretValueCommand({ SecretId: arn }));
    const creds = JSON.parse(SecretString || "{}");
    if (!creds.otlpEndpoint || !creds.instanceId || !creds.apiKey || creds.apiKey === "REPLACE_ME") {
      cachedCreds = null; // still the deploy-time placeholder -- Garrett hasn't set up Grafana Cloud yet
    } else {
      const auth = Buffer.from(`${creds.instanceId}:${creds.apiKey}`).toString("base64");
      cachedCreds = { endpoint: creds.otlpEndpoint.replace(/\/+$/, ""), authHeader: `Basic ${auth}` };
    }
  } catch (err) {
    console.warn("otel: could not load Grafana credentials, telemetry disabled for this invocation:", String(err?.message || err));
    cachedCreds = null;
  }
  return cachedCreds;
}

function hex(byteLength) {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
  return [...bytes].map(b => b.toString(16).padStart(2, "0")).join("");
}

function toAnyValue(value) {
  if (typeof value === "number") return { doubleValue: value };
  if (typeof value === "boolean") return { boolValue: value };
  return { stringValue: String(value) };
}

function toAttributes(attrs) {
  return Object.entries(attrs || {})
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([key, value]) => ({ key, value: toAnyValue(value) }));
}

// Starts a span. Call endSpan (or use withSpan) exactly once to close and export it.
export function startSpan(name, attributes = {}) {
  return {
    name,
    traceId: hex(16),
    spanId: hex(8),
    startNs: BigInt(Date.now()) * 1_000_000n,
    attributes: { ...attributes }
  };
}

// Ends a span and best-effort exports it as one OTLP/HTTP JSON POST. Never throws -- a broken or
// unreachable telemetry backend must never fail an agent run.
export async function endSpan(span, { status = "OK", error, attributes = {} } = {}) {
  const endNs = BigInt(Date.now()) * 1_000_000n;
  const creds = await loadCreds();
  if (!creds) return;

  const body = {
    resourceSpans: [{
      resource: { attributes: toAttributes({ "service.name": SERVICE_NAME }) },
      scopeSpans: [{
        scope: { name: "geovive-agents" },
        spans: [{
          traceId: span.traceId,
          spanId: span.spanId,
          name: span.name,
          kind: 1, // SPAN_KIND_INTERNAL
          startTimeUnixNano: span.startNs.toString(),
          endTimeUnixNano: endNs.toString(),
          attributes: toAttributes({ ...span.attributes, ...attributes }),
          status: status === "ERROR" ? { code: 2, message: String(error || "").slice(0, 500) } : { code: 1 }
        }]
      }]
    }]
  };

  try {
    const res = await fetch(`${creds.endpoint}/v1/traces`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: creds.authHeader },
      body: JSON.stringify(body)
    });
    if (!res.ok) console.warn("otel: export rejected:", res.status, await res.text().catch(() => ""));
  } catch (err) {
    console.warn("otel: export failed:", String(err?.message || err));
  }
}

// Convenience wrapper for a child span around a single async step (e.g. one Bedrock call).
// Re-throws whatever fn() throws after recording it, so callers keep their own error handling.
export async function withSpan(name, attributes, fn) {
  const span = startSpan(name, attributes);
  try {
    const result = await fn(span);
    await endSpan(span);
    return result;
  } catch (err) {
    await endSpan(span, { status: "ERROR", error: String(err?.message || err) });
    throw err;
  }
}
