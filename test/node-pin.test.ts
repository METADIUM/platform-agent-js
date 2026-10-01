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
});
