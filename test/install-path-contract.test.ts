import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Where `install.sh` puts the binary is a **cross-repo contract**, and nothing enforced it.
 *
 * 🔴 briefick's agent page prints the installed command with a hardcoded path
 * (`agent-cli.ts`: `AGENT_CLI_BIN_DIR = "~/.metapass-agent/bin"`). If this repo changes `DEST`,
 * that page tells users to run a path that does not exist and they get `command not found` — and
 * briefick's own test cannot catch it, because it asserts
 * `BIN_PATH === BIN_DIR + "/" + BIN`, which restates its own construction and stays green.
 *
 * ⚠️ This test cannot prevent the change, and is not trying to. It makes the change **deliberate**
 * and names who has to be told. A tripwire with a consumer's name on it is the only guard available
 * when the two halves live in different repositories.
 *
 * Known consumers of `defaultBinDir` as of 2026-09-30:
 *   - briefick `src/lib/agent-cli.ts` — AGENT_CLI_BIN_DIR / AGENT_CLI_BIN
 */
const sh = readFileSync(new URL("../scripts/install.sh", import.meta.url), "utf8");
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

describe("install.sh's destination is a published contract", () => {
  it("package.json records the same default directory install.sh uses", () => {
    const m = sh.match(/^DEST="\$\{([A-Z_]+):-(.+?)\}"$/m);
    expect(m, "DEST assignment not found — if its shape changed, this check must change with it").not.toBeNull();
    const [, env, dflt] = m!;
    expect(env).toBe(pkg.metapassAgent.binDirEnv);
    // install.sh writes $HOME; package.json publishes the ~ form a consumer prints to a user.
    expect(dflt).toBe(pkg.metapassAgent.defaultBinDir.replace("~", "$HOME"));
  });

  it("package.json records the same binary name install.sh installs", () => {
    expect(sh).toContain(`"$DEST/${pkg.metapassAgent.binName}"`);
  });

  it("the installer prints the full path, so a user can always recover it from the install output", () => {
    expect(sh).toMatch(new RegExp(`\\$DEST/${pkg.metapassAgent.binName}`));
    expect(sh.split(`$DEST/${pkg.metapassAgent.binName}`).length - 1, "0-based assertion guard").toBeGreaterThan(1);
  });

  it("⚠️ control — this test can actually fail", () => {
    // If the regex above stopped matching anything, the first case would throw on m!, not pass.
    // This asserts the file we read is the file we think: it has to contain the installer's banner.
    expect(sh).toContain("#!/bin/sh");
    expect(sh.length).toBeGreaterThan(1000);
  });
});
