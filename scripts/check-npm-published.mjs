#!/usr/bin/env node
/**
 * Every release tag must exist on npm.
 *
 * 🔴 The release is automated in halves. `release-binaries.yml` builds and signs the SEA binaries
 * and attaches them to the GitHub Release; **`npm publish` is manual** and nothing runs it. So a
 * release can be complete by every signal this repository produces — CI green, all seven assets
 * present, signature verifiable — and still be absent from the registry that `npx` reads.
 *
 * That is not hypothetical: **0.5.5 has a tag and was never published**, and nobody noticed until
 * 0.5.7 hit the same gap four releases later. It was found by a consumer (briefick) holding back a
 * version pin, not by anything here.
 *
 * ⇒ This check exists so the missing half is loud. It does not publish anything.
 *
 * ⚠️ It cannot run at release time: npm publish happens *after* the GitHub Release, so an
 * immediate check would fail on every release. It runs on a schedule instead, which finds a miss
 * within a day — before a consumer pins the version, which is the event that turns the miss into a
 * broken `npx` for someone else.
 */
import { execFileSync } from "node:child_process";

const PKG = "@metadium-did/platform-agent-js";

/**
 * Tags deliberately absent from npm, each with the reason.
 *
 * 🔴 This list is the point, not an escape hatch. Without it the check is red from its first run
 * because of 0.5.5, and **a check that is always red is a check someone turns off** — so the
 * historical gap would end up silencing the guard against its own recurrence. Naming it keeps the
 * check green today and red on anything new.
 *
 * ⚠️ Adding an entry here is a decision that a version will never be on npm. It is not the way to
 * quiet a release you have not published yet — publish it.
 */
const NEVER_PUBLISHED = new Map([
  ["0.5.5", "never published to npm; discovered 2026-10-01, four releases late. Left unpublished rather than filling the hole with a different artefact under an old version number."],
]);

const tags = execFileSync("git", ["tag", "--list", "v*"], { encoding: "utf8" })
  .split("\n").map((t) => t.trim()).filter(Boolean)
  .map((t) => t.replace(/^v/, ""))
  .filter((v) => /^\d+\.\d+\.\d+$/.test(v));

if (tags.length === 0) {
  console.error("no release tags found — this check read nothing, which is not the same as finding nothing");
  process.exit(1);
}

const published = new Set(JSON.parse(execFileSync("npm", ["view", PKG, "versions", "--json"], { encoding: "utf8" })));
if (published.size === 0) {
  console.error(`npm returned no versions for ${PKG} — treating as an instrument failure, not an empty registry`);
  process.exit(1);
}

const missing = tags.filter((v) => !published.has(v) && !NEVER_PUBLISHED.has(v));
const excused = tags.filter((v) => !published.has(v) && NEVER_PUBLISHED.has(v));

console.log(`tags: ${tags.length}  on npm: ${tags.length - missing.length - excused.length}  excused: ${excused.length}`);
for (const v of excused) console.log(`  excused ${v} — ${NEVER_PUBLISHED.get(v)}`);

if (missing.length > 0) {
  console.error(
    `\nreleased but NOT on npm: ${missing.join(", ")}\n` +
      `  A GitHub Release is only half of a release here — \`npm publish\` is manual.\n` +
      `  \`npx ${PKG}@${missing[0]}\` fails for everyone, and a consumer pinning this version breaks.\n` +
      `  Fix by publishing it, not by adding it to NEVER_PUBLISHED.`
  );
  process.exit(1);
}
console.log("\nevery release tag is on npm");
