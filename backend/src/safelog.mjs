// safelog.mjs — keep personal information out of CloudWatch logs.
//
// Imported first by every Lambda entry point. It wraps console.log/info/warn/error
// so that anything written to the logs is:
//   - reduced to a message (errors keep name + message + a short stack; objects are
//     JSON-stringified and cut to 2 KB, so feature collections or request bodies
//     can't be dumped whole),
//   - scrubbed of values that look like emails, phone numbers, street addresses,
//     bearer tokens, presigned-URL signatures and Stripe secrets.
// Code should still log IDs and counts, never layer values, pin contents or bodies.

const RULES = [
  [/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email]"],
  [/(?:\+?1[\s.-]?)?\(?\b\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b/g, "[phone]"],
  [/\b\d{1,6}\s+(?:[NSEW]\.?\s+)?[A-Z][a-z]+(?:\s[A-Z][a-z]+)*\s(?:St|Street|Ave|Avenue|Rd|Road|Dr|Drive|Ln|Lane|Ct|Court|Blvd|Way|Pl|Place)\b/g, "[address]"],
  [/Bearer\s+[A-Za-z0-9._-]+/g, "Bearer [token]"],
  [/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, "[jwt]"],
  [/(X-Amz-(?:Signature|Security-Token|Credential)=)[^&\s"]+/g, "$1[redacted]"],
  [/\b(?:whsec|sk_live|sk_test|rk_live|rk_test)_[A-Za-z0-9]+/g, "[stripe-secret]"]
];
const MAX = 2048;

export function scrub(text) {
  let s = String(text);
  for (const [re, to] of RULES) s = s.replace(re, to);
  return s.length > MAX ? s.slice(0, MAX) + "…[truncated]" : s;
}

function flatten(arg) {
  if (arg instanceof Error) {
    const stack = (arg.stack || "").split("\n").slice(1, 4).map(l => l.trim()).join(" | ");
    return `${arg.name}: ${arg.message}${stack ? ` (${stack})` : ""}`;
  }
  if (arg && typeof arg === "object") { try { return JSON.stringify(arg); } catch { return "[object]"; } }
  return String(arg);
}

if (!globalThis.__geoviveSafeLog) {
  globalThis.__geoviveSafeLog = true;
  for (const level of ["log", "info", "warn", "error"]) {
    const orig = console[level].bind(console);
    console[level] = (...args) => orig(scrub(args.map(flatten).join(" ")));
  }
}
