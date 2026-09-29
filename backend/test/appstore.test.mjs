// Unit tests for app setup stages and the Apps table access.
import assert from "node:assert/strict";
process.env.ALLOWED_ORIGINS = "https://geovive.link";
const { canTransition, isActive, getAppRecord, seedItems } = await import("../src/appstore.mjs");

assert.ok(canTransition("registered", "verifying"));
assert.ok(canTransition("verifying", "checks_passed"));
assert.ok(canTransition("checks_passed", "awaiting_payment"));
assert.ok(canTransition("awaiting_payment", "live"));
assert.ok(canTransition("live", "suspended"));
assert.ok(!canTransition("registered", "live"), "can't skip the checks");
assert.ok(!canTransition("checks_failed", "awaiting_payment"), "no payment after failed checks");
assert.ok(!canTransition("suspended", "live"), "suspended apps are re-checked first");
assert.ok(!canTransition("suspended", "suspended"));
assert.ok(isActive("live") && isActive("sandbox") && !isActive("checks_passed") && !isActive("suspended"));

// Seed fallback (no table)
const demo = await getAppRecord(null, "geovive-demo");
assert.deepEqual(demo.returnOrigins, ["https://geovive.link"]);
assert.equal(demo.status, "live");
assert.equal(await getAppRecord(null, "nope"), null);
assert.equal(await getAppRecord(null, "../x"), null);

// Seed items: demo stores the flag, not the origins
const items = seedItems("2026-01-01T00:00:00Z");
const d = items.find(i => i.appId === "geovive-demo"), b = items.find(i => i.appId === "bowandarrow-hunt");
assert.equal(d.siteOrigins, true); assert.equal(d.returnOrigins, undefined);
assert.equal(b.sk, "APP"); assert.equal(b.domain, "hunt.bowandarrow.fyi"); assert.ok(b.returnOrigins.length);
// Yearly term
assert.ok(canTransition("live", "expired") && canTransition("expired", "awaiting_payment"));
assert.ok(!canTransition("expired", "live"), "renewal goes through payment");
const now = Date.parse("2026-06-01T00:00:00Z");
assert.ok(isActive("live", "2026-12-31T00:00:00Z", now));
assert.ok(!isActive("live", "2026-05-31T00:00:00Z", now), "lapsed term turns the app off");
assert.ok(isActive("live", undefined, now));
const { termEnd } = await import("../src/appstore.mjs");
assert.equal(termEnd(new Date("2026-01-01T00:00:00Z")), "2027-01-01T00:00:00.000Z");
console.log("appstore tests passed");
