#!/usr/bin/env node
/**
 * Release gate: the release declares its compatibility class (`package.json` `agentCompat`), and a
 * class that needs the receiver first names that confirmation in the release notes.
 * Run by `release-binaries.yml` after `npm run build` (reads ../dist and ../package.json), with RELEASE_TAG and GH_TOKEN.
 * A file, not `node -e '…'` in the workflow: an apostrophe in that inline script ended bash's quote.
 */
const { AGENT_COMPAT } = await import(new URL("../dist/wire-surface.js", import.meta.url).href);
const { readFileSync } = await import("node:fs");
const c = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).agentCompat ?? "";
const spec = AGENT_COMPAT[c];
if (!spec) {
  console.error(`package.json agentCompat is missing or unknown: ${JSON.stringify(c)}`);
  console.error(`  expected one of: ${Object.keys(AGENT_COMPAT).join(" | ")}`);
  console.error("  read platform-docs/43-agent-cli-wire-compatibility.md before setting it —");
  console.error("  which class this is decides the deploy order.");
  process.exit(1);
}
console.log(`agentCompat = ${c} (coexists=${spec.coexists}, releaseAfterReceiverConfirmed=${spec.releaseAfterReceiverConfirmed})`);
if (!spec.releaseAfterReceiverConfirmed) process.exit(0);
// The receiver cannot be probed from here: briefick deploys on user approval with no
// window, and other organisations run their own installs. So the gate requires the
// release notes to say which receiver was confirmed, at what version.
//
// 🔴 Read the body LIVE, not from `github.event.release.body`: a **Re-run** replays the
//    ORIGINAL payload, so an author who adds the line and clicks "Re-run jobs" would
//    stay red and be blamed for a line they did write ([Briefick], review of #34).
// 🔵 Fetched INSIDE this branch, so `local` and `additive` releases never depend on
//    `gh` at all — the lookup used to run before the class was known, which made that
//    claim in #34's description false ([Briefick] again, review of 8a3cfc8).
// ⚠️ Wrapped: every other failure in this gate hands the operator a diagnosis and a
//    next action, and the ONE path that did not was the gate failing to read its own
//    input — which is exactly the "could not measure" vs "failed" distinction this
//    estate keeps trying to hold ([minipaas], review of de4badb). Still fail-closed.
const { execFileSync } = await import("node:child_process");
let body;
try {
  body = execFileSync("gh",
    ["release", "view", process.env.RELEASE_TAG, "--json", "body", "-q", ".body"],
    { encoding: "utf8" });
} catch (e) {
  console.error(`Could not READ the release notes for ${process.env.RELEASE_TAG}.`);
  console.error("  This is not a compatibility failure — the gate never saw its input.");
  console.error(`  gh exited ${e.status ?? "?"}: ${String(e.stderr ?? e.message).trim()}`);
  console.error("  Check GH_TOKEN and that the release is published, then re-publish.");
  process.exit(1);
}
// Requires a receiver, a commit sha and a date, so `receiver-confirmed: TODO` does not
// pass; the optional bullet accepts the markdown form ([Briefick], review of #34).
const CONFIRMED = /^\s*(?:[-*]\s+)?receiver-confirmed:\s*\S+\s+[0-9a-f]{7,40}\s+on\s+\d{4}-\d{2}-\d{2}/mi;
if (!CONFIRMED.test(body)) {
  console.error(`agentCompat = ${c} requires the receiver to be confirmed BEFORE this release.`);
  console.error("  Add a line to the release notes and RE-PUBLISH (a workflow Re-run");
  console.error("  replays the old payload; this gate re-reads live, but re-publish is safer):");
  console.error("    receiver-confirmed: briefick 30cf66f on 2026-10-01");
  console.error("  The commit must CONTAIN the widening, not merely be newer:");
  console.error("    git merge-base --is-ancestor <widening> <running>   # in the receiver repo");
  console.error("  If the receiver cannot be queried at all, do not force this: re-cut the");
  console.error("  change as `additive` (new field beside the old one) — nothing needs ordering.");
  console.error("  See platform-docs/43-agent-cli-wire-compatibility.md section 2.3.");
  process.exit(1);
}
console.log("receiver confirmation present in the release notes.");
// What this gate did NOT check: that the class is the right one. `agentCompat` is a
// human judgement — a replacement labelled `receiver-first` passes here with
// `coexists: true` recorded against it falsely. Green means the declared class was
// handled, not that it was declared correctly.
console.log(`NOT CHECKED: that ${c} is the correct class for this change. Nothing can.`);
console.log("NOT CHECKED: that the named commit CONTAINS the widening — confirm with");
console.log("  `git merge-base --is-ancestor <widening> <running>` in the receiver's repo.");
console.log("NOT CHECKED: any receiver the line does not name. Independent installs are");
console.log("  unconfirmed by construction — see platform-docs/43 section 2.3.");
console.log("NOT CHECKED: that a confirmation HAPPENED. This gate measures that a line");
console.log("  exists and is well-formed. The sha and date make it re-checkable by a");
console.log("  third party against the receiver; they do not make it true.");
console.log("NOT CHECKED: that the sha and date RESOLVE. They are matched as shapes and");
console.log("  never looked up — `deadbeef` and `2026-13-45` both pass this gate.");
