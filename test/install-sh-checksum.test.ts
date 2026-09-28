import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, symlinkSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * `install.sh` decides whether a downloaded binary is the one we signed. Nothing ever ran it.
 *
 * 🔴 The line this file exists for shipped in v0.5.1 through v0.5.4:
 *
 *     ACTUAL="$(shasum -a 256 "$f" 2>/dev/null | cut -d' ' -f1 || sha256sum "$f" | cut -d' ' -f1)"
 *
 * `||` binds to the **pipeline**, not to `shasum`. Where `shasum` is absent the left side produces
 * nothing, `cut` succeeds on empty input, and the fallback never runs — so `ACTUAL` is `""`, the
 * comparison fails, and the installer prints **"체크섬 불일치"**. On Rocky Linux 10.2 (`shasum`
 * absent, `sha256sum` present) that made every install fail, with the message saying the binary had
 * been tampered with.
 *
 * ⚠️ That is the part worth keeping in mind: an integrity check whose "I cannot check" and whose
 * "this failed the check" are the same screen. A real substitution and a missing package are
 * indistinguishable to the person reading it, and the honest reading of the message — "someone
 * changed the binary" — was the wrong one.
 *
 * These tests extract `sha256_of` from the shipped script and run it, rather than restating it, so
 * that editing `install.sh` changes what is measured here.
 */

const INSTALL_SH = new URL("../scripts/install.sh", import.meta.url);

/** Pull one shell function out of install.sh by name, so the test exercises the shipped text. */
function extractFunction(name: string): string {
  const src = readFileSync(INSTALL_SH, "utf8");
  const start = src.indexOf(`${name}() {`);
  expect(start, `${name}() not found in install.sh`).toBeGreaterThan(-1);
  const end = src.indexOf("\n}\n", start);
  expect(end, `${name}() has no closing brace at column 0`).toBeGreaterThan(start);
  return src.slice(start, end + 3);
}

/** A PATH holding only the named tools, so "absent" can actually be arranged. */
function pathWithOnly(tools: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "agent-bin-"));
  for (const tool of tools) {
    const real = execFileSync("sh", ["-c", `command -v ${tool}`], { encoding: "utf8" }).trim();
    symlinkSync(real, join(dir, tool));
  }
  // The function body uses `command -v`, `cut` and `sed`; a PATH with no shell utilities at all
  // would fail for reasons that have nothing to do with what is being measured.
  for (const tool of ["cut", "sed", "env"]) {
    try {
      const real = execFileSync("sh", ["-c", `command -v ${tool}`], { encoding: "utf8" }).trim();
      symlinkSync(real, join(dir, tool));
    } catch {
      /* not present here either; the assertions below will say so */
    }
  }
  return dir;
}

type Run = { status: number; stdout: string; stderr: string };

function runSha256Of(body: string, path: string, target: string): Run {
  const script = `${body}\nsha256_of "$1"\n`;
  const file = join(mkdtempSync(join(tmpdir(), "agent-sh-")), "probe.sh");
  writeFileSync(file, script);
  chmodSync(file, 0o755);
  try {
    // 🔴 An absolute path. Resolving "sh" would go through the PATH we are deliberately
    //    emptying, so the process would fail to spawn and every case would look like a failure
    //    of the code under test. Measured: status -1 with no stderr on all four.
    const stdout = execFileSync("/bin/sh", [file, target], {
      encoding: "utf8",
      env: { PATH: path },
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, stdout, stderr: "" };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { status: err.status ?? -1, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
  }
}

describe("install.sh computes a checksum, or says it could not", () => {
  const body = extractFunction("sha256_of");
  const payload = mkdtempSync(join(tmpdir(), "agent-payload-"));
  const target = join(payload, "metapass-agent");
  writeFileSync(target, "not really a binary, but it hashes the same way");
  const expected = createHash("sha256").update(readFileSync(target)).digest("hex");

  const available = ["sha256sum", "shasum"].filter((tool) => {
    try {
      execFileSync("sh", ["-c", `command -v ${tool}`], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  });

  // 🔴 Not `it.skipIf`. If neither tool exists on the machine running the suite, the two cases
  //    below would silently vanish and the file would still report green — the exact shape of
  //    failure this file was written about.
  it("the machine running this suite has at least one SHA-256 tool", () => {
    expect(available, "no sha256sum and no shasum: the cases below cannot be measured").not
      .toHaveLength(0);
  });

  for (const only of available) {
    it(`computes the hash with ${only} alone on PATH`, () => {
      const run = runSha256Of(body, pathWithOnly([only]), target);
      expect(run.status, run.stderr).toBe(0);
      expect(run.stdout.trim()).toBe(expected);
    });
  }

  it("fails, and says the tool is missing, when neither tool is on PATH", () => {
    const run = runSha256Of(body, pathWithOnly([]), target);
    expect(run.status).not.toBe(0);
    expect(run.stdout.trim()).toBe("");
    // The message has to separate "cannot check" from "failed the check". If it ever starts
    // reading like a checksum mismatch, that is the defect coming back in words.
    expect(run.stderr).toMatch(/sha256sum/);
    expect(run.stderr).not.toMatch(/불일치/);
  });

  /**
   * 🟢 The control. Four passing cases above do not show that any of them can fail — so the
   * version that shipped is run through the same assertions, and must be caught.
   */
  it("catches the shipped v0.5.1-v0.5.4 line, which returned empty and succeeded", () => {
    const broken = [
      "sha256_of() {",
      `  shasum -a 256 "$1" 2>/dev/null | cut -d' ' -f1 || sha256sum "$1" | cut -d' ' -f1`,
      "}",
      "",
    ].join("\n");

    const run = runSha256Of(broken, pathWithOnly(["sha256sum"]), target);

    // This is what the user saw: exit 0, no hash, no explanation. The caller then compared "" to
    // the real hash and reported a checksum mismatch.
    expect(run.status).toBe(0);
    expect(run.stdout.trim()).toBe("");
    expect(run.stdout.trim()).not.toBe(expected);
  });
});
