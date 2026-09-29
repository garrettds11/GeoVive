import assert from "node:assert/strict";
const { scrub } = await import("../src/safelog.mjs");
const s = scrub("owner jo.smith@example.com at 555-123-4567, 1200 Pine Ridge Rd; Bearer abc.def-1 X-Amz-Signature=deadbeef&x=1 whsec_ABC123");
assert.ok(!/example\.com|555-123|Pine Ridge|abc\.def|deadbeef|ABC123/.test(s), s);
assert.ok(scrub("x".repeat(5000)).length < 2100);
// console is wrapped
let out = ""; const w = process.stdout.write.bind(process.stdout);
process.stdout.write = (c, ...r) => { out += c; return true; };
console.log("contact", { email: "a@b.co" }, new Error("bad value 303-555-0100"));
process.stdout.write = w;
assert.ok(!out.includes("a@b.co") && !out.includes("303-555-0100"), out);
console.log("safelog tests passed");
