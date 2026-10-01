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
 * immediate check would fail on every release. It runs on a schedule instead.
 *
 * 🔴 **A daily job would not have caught 0.5.7, and that is not what it is for.** Measured by
 * `[Briefick]`: release 00:41:53, their `npx` 404 at ~00:51, npm publish 00:54:26 — a 12m33s gap
 * that a consumer hit in ten minutes and this job would have slept through. An earlier draft of
 * this file claimed the schedule finds a miss *"before a consumer pins the version"*; that was
 * wrong, and the consumer is faster than any schedule worth running.
 *
 * ⇒ What this catches is the **0.5.5 class: a version nobody pins.** 0.5.7 was found because
 * someone wanted it; 0.5.5 was wanted by no one, so nothing looked, and it stayed missing for four
 * releases. A consumer's check only fires on versions a consumer reaches for — this one sweeps the
 * ones nobody does.
 */
import { execFileSync } from "node:child_process";

const run = (cmd, args) => execFileSync(cmd, args, { encoding: "utf8" });

const PKG = "@metadium-did/platform-agent-js";

/**
 * Auditing starts here.
 *
 * 🔴 Three historical facts sit below this floor, and none of them is worth carrying as a live
 * exception (measured 2026-10-01):
 *
 * ```
 * 0.5.5   tagged, never published to npm — unnoticed for four releases
 * 0.5.3   npm published from 01a0531e1, one commit past tag 9061c25b4 (+30min, `fix(install)`)
 *         ⇒ npm's 0.5.3 carries an install.sh fix the Release binaries do not
 * 0.5.4   npm published from 9fe39fd65, one commit past tag 237587ef5 (+5min, `docs`)
 * ```
 *
 * ⇒ A floor rather than a list of excused versions (`[Briefick]`, review of #27). I first argued
 * for the list, on the grounds that a floor at 0.5.6 leaves **6 of 8** tags unaudited — which is
 * true and was the wrong thing to weigh. There is no external consumer and no compatibility
 * obligation to versions below it, so that coverage buys nothing, while a list of excused versions
 * is a place to put the *next* miss.
 *
 * ⚠️ Raising this floor is how you make an unpublished release stop being an error. Do not raise
 * it to quiet a release you have not published — publish it.
 */
const AUDIT_FROM = "0.5.6";

const cmp = (a, b) => {
  const pa = a.split(".").map(Number), pb = b.split(".").map(Number);
  return pa[0] - pb[0] || pa[1] - pb[1] || pa[2] - pb[2];
};

const tags = execFileSync("git", ["tag", "--list", "v*"], { encoding: "utf8" })
  .split("\n").map((t) => t.trim()).filter(Boolean)
  .map((t) => t.replace(/^v/, ""))
  .filter((v) => /^\d+\.\d+\.\d+$/.test(v))
  .filter((v) => cmp(v, AUDIT_FROM) >= 0);

if (tags.length === 0) {
  console.error("no release tags found — this check read nothing, which is not the same as finding nothing");
  process.exit(1);
}

const published = new Set(JSON.parse(execFileSync("npm", ["view", PKG, "versions", "--json"], { encoding: "utf8" })));
if (published.size === 0) {
  console.error(`npm returned no versions for ${PKG} — treating as an instrument failure, not an empty registry`);
  process.exit(1);
}

const missing = tags.filter((v) => !published.has(v));

/**
 * 🟢 Each published version records the commit it was packed from. Comparing it to the tag
 * catches **a manual publish from the wrong checkout** — right version number, wrong tree
 * (`[Briefick]`, review of #27). Presence alone cannot see that: the version is there and the
 * number is right.
 *
 * ⚠️ It is not a reproducibility check. A dirty working tree publishes with the same `gitHead`
 * as a clean one, so this pins **which commit** was checked out, not **what was in the tarball**.
 *
 * 🔴 It found two on its first run, and both are real: 0.5.3 and 0.5.4 were published from a
 * commit **one ahead of their tag**, 30 and 5 minutes after tagging. npm's 0.5.3 therefore carries
 * `01a0531 fix(install): …` — a change the v0.5.3 GitHub Release binaries do not have. Same
 * version number, two different trees, depending on where you got it.
 */
const wrongCommit = [];
for (const v of tags) {
  if (!published.has(v)) continue;
  const head = run("npm", ["view", `${PKG}@${v}`, "gitHead"]).trim();
  if (!head) continue;  // older publishes predate npm recording it — absence is not a mismatch
  const tagCommit = run("git", ["rev-parse", `v${v}^{commit}`]).trim();
  if (head !== tagCommit) wrongCommit.push(`${v}: npm ${head.slice(0, 9)} ≠ tag ${tagCommit.slice(0, 9)}`);
}

console.log(`tags from ${AUDIT_FROM}: ${tags.length}  on npm: ${tags.length - missing.length}`);

if (missing.length > 0) {
  console.error(
    `\nreleased but NOT on npm: ${missing.join(", ")}\n` +
      `  A GitHub Release is only half of a release here — \`npm publish\` is manual.\n` +
      `  \`npx ${PKG}@${missing[0]}\` fails for everyone, and a consumer pinning this version breaks.\n` +
      `  Fix by publishing it, not by raising AUDIT_FROM.`
  );
  process.exit(1);
}
if (wrongCommit.length > 0) {
  console.error(
    `\npublished from a different commit than the tag:\n  ${wrongCommit.join("\n  ")}\n` +
      `  npm publish is manual here, so this is what a publish from the wrong checkout looks like.`
  );
  process.exit(1);
}
console.log("every release tag is on npm, from the commit its tag points at");
