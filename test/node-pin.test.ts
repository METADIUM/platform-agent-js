import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * 🔴 The single-file binary embeds a whole Node runtime, so **the release workflow's Node version
 * is part of the shipped artifact** — it decides which OpenSSL, and therefore whether Ed25519 and
 * BLAKE2b-512 (what `upgrade` verifies signatures with) are present and behave the same.
 *
 * The workflow said `node-version: 22`, a floating major. Measured 2026-09-30: `v0.5.5` and
 * `v0.5.6` both got 22.23.2, so nothing had drifted **yet** — but the next runner image moves it
 * with no commit here, and no test would have noticed.
 *
 * ⚠️ What this pins is the workflow reading `.nvmrc`. It does **not** prove the built binary
 * embeds that version; that can only be read out of the artifact
 * (`strings metapass-agent | grep '^v22\\.'` gives v22.23.2 for 0.5.4). Stated so the green is not
 * read as more than it is.
 */
const root = join(import.meta.dirname, "..");

describe("the Node version the release is built with", () => {
  const nvmrc = readFileSync(join(root, ".nvmrc"), "utf8").trim();
  const wf = (f: string) => readFileSync(join(root, ".github/workflows", f), "utf8");
  const workflow = wf("release-binaries.yml");
  // The same binary checks on the pull request, so they do not first run after the release is public.
  const prCheck = wf("sea-check.yml");
  const binaryWorkflows = { "release-binaries.yml": workflow, "sea-check.yml": prCheck };

  it("is pinned to an exact patch version, not a floating major", () => {
    expect(nvmrc).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it.each(Object.entries(binaryWorkflows))("🔴 is taken from .nvmrc by %s, so the pin is the one that ships", (_, w) => {
    expect(w).toContain("node-version-file: .nvmrc");
    // A literal `node-version:` alongside it would win or conflict depending on ordering.
    expect(w).not.toMatch(/^\s*node-version:\s*\S/m);
  });

  // The first patch of each line that fixes the October 2026 Node security release
  // (CVE-2026-111497 Brotli, CVE-2026-106074 SEA entropy). A new major needs its own entry.
  const FIXED_IN: Record<string, string> = { "22": "22.23.4", "24": "24.22.1" };
  const num = (v: string) => v.split(".").map(Number);
  const atLeast = (v: string, min: string) => {
    const [a, b] = [num(v), num(min)];
    for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
    return true;
  };

  it("🔴 is not older than the October 2026 security release for its line", () => {
    const min = FIXED_IN[nvmrc.split(".")[0]];
    expect(min, `no known fixed version for Node ${nvmrc}; add the line to FIXED_IN`).toBeDefined();
    expect(atLeast(nvmrc, min), `.nvmrc ${nvmrc} predates ${min}, which the release binaries need`).toBe(true);
  });

  it.each(Object.entries(binaryWorkflows))("🔴 %s builds all four binaries and runs the probe, the control and the binary checks", (_, w) => {
    expect(w).toMatch(/^\s*- run: node scripts\/build-sea\.mjs --all\s*$/m);
    expect(w).toMatch(/^\s*- run: node scripts\/check-sea-entropy\.mjs\s*$/m);
    expect(w, "the control run (snapshot taken after both are called) is what shows the fix")
      .toMatch(/SEA_OPTIONS_OVERRIDE: '\{"useSnapshot":true\}'\s*\n\s*SEA_SNAPSHOT_WARMUP: "1"/);
    expect(w).toMatch(/run: bash scripts\/check-sea-binaries\.sh\s*$/m);
  });

  it("🔴 sea-check runs on pull requests that can change the binary, read-only, on a GitHub-hosted runner", () => {
    expect(prCheck).toMatch(/^on:\s*\n\s+pull_request:/m);
    for (const p of [".nvmrc", '"scripts/**"', '"package*.json"', "tsconfig.json", '"src/**"', ".github/workflows/sea-check.yml",
      ".github/workflows/release-binaries.yml"]) expect(prCheck, `paths must include ${p}`).toContain(`- ${p}`);
    expect(prCheck).toMatch(/^permissions:\s*\n\s+contents: read\s*$/m);
    expect(prCheck, "this repo is public: no secrets in a pull_request workflow").not.toMatch(/\bsecrets\b/);
    expect(prCheck, "pull_request_target/workflow_run run fork code with the base repo's token").not.toMatch(/pull_request_target|workflow_run/);
    expect(prCheck).not.toMatch(/:\s*write\b/);
    expect(prCheck).toMatch(/persist-credentials: false/);
    expect(prCheck).toMatch(/runs-on: macos-14\b/);
    expect(prCheck).not.toMatch(/self-hosted/);
  });

  it("🔴 the entropy probe measures the options build-sea ships", async () => {
    const { SEA_OPTIONS } = await import(pathToFileURL(join(root, "scripts", "sea-options.mjs")).href);
    const env = { ...process.env };
    delete env.SEA_OPTIONS_OVERRIDE;
    for (const f of ["build-sea.mjs", "check-sea-entropy.mjs"]) {
      const out = execFileSync(process.execPath, [join(root, "scripts", f), "--config-only"], { env, encoding: "utf8" });
      const { main: _m, output: _o, ...options } = JSON.parse(out);
      expect(options, `${f} writes a sea-config whose options are not SEA_OPTIONS`).toEqual({ ...SEA_OPTIONS });
    }
    const probe = readFileSync(join(root, "scripts", "check-sea-entropy.mjs"), "utf8");
    for (const v of ["SEA_OPTIONS_OVERRIDE", "SEA_SNAPSHOT_WARMUP"]) expect(probe).toContain(`process.env.${v}`);
  });
});
