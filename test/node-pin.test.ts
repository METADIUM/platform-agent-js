import { readFileSync } from "node:fs";
import { join } from "node:path";
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
  const workflow = readFileSync(join(root, ".github/workflows/release-binaries.yml"), "utf8");

  it("is pinned to an exact patch version, not a floating major", () => {
    expect(nvmrc).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("🔴 is taken from .nvmrc by the workflow, so the pin is the one that ships", () => {
    expect(workflow).toContain("node-version-file: .nvmrc");
    // A literal `node-version:` alongside it would win or conflict depending on ordering.
    expect(workflow).not.toMatch(/^\s*node-version:\s*\S/m);
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

  it("🔴 the entropy probe runs in the release and measures the options build-sea ships", () => {
    expect(workflow).toMatch(/^\s*- run: node scripts\/check-sea-entropy\.mjs\s*$/m);
    expect(workflow, "the control run (snapshot taken after both are called) is what shows the fix")
      .toMatch(/SEA_OPTIONS_OVERRIDE: '\{"useSnapshot":true\}'\s*\n\s*SEA_SNAPSHOT_WARMUP: "1"/);
    const probe = readFileSync(join(root, "scripts", "check-sea-entropy.mjs"), "utf8");
    for (const v of ["SEA_OPTIONS_OVERRIDE", "SEA_SNAPSHOT_WARMUP"]) expect(probe).toContain(`process.env.${v}`);
    for (const f of ["build-sea.mjs", "check-sea-entropy.mjs"]) {
      const src = readFileSync(join(root, "scripts", f), "utf8");
      expect(src, `${f} must take its SEA options from sea-options.mjs`).toContain('from "./sea-options.mjs"');
      expect(src, `${f} sets useSnapshot itself, so the probe may not measure the release`).not.toMatch(/useSnapshot\s*:/);
    }
  });
});
