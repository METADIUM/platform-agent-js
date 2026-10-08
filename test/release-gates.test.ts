import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AGENT_COMPAT } from "../src/wire-surface.js";

const WORKFLOWS = ".github/workflows";

/** Every `run:` body in a workflow, with `${{ … }}` replaced, as bash would receive it. */
function runBlocks(yml: string): { line: number; script: string }[] {
  const lines = yml.split("\n");
  const out: { line: number; script: string }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)(?:-\s+)?run:\s*(.*)$/.exec(lines[i]);
    if (!m) continue;
    const indent = m[1].length;
    let script: string;
    // Only a plain `|` block is read; any other block indicator (`|-`, `|+`, `>`, …) would be read wrong.
    if (/^[|>]/.test(m[2]) && m[2] !== "|") throw new Error(`line ${i + 1}: unsupported run block indicator ${m[2]}`);
    if (m[2] === "|") {
      const body: string[] = [];
      for (let j = i + 1; j < lines.length; j++) {
        const l = lines[j];
        if (l.trim() !== "" && l.length - l.trimStart().length <= indent) break;
        body.push(l);
      }
      script = body.join("\n");
    } else {
      script = m[2];
    }
    out.push({ line: i + 1, script: script.replace(/\$\{\{[^}]*\}\}/g, "x") });
  }
  return out;
}

const bashN = (script: string) => spawnSync("bash", ["-n"], { input: script, encoding: "utf8" });

describe("workflow run blocks parse as bash", () => {
  it("control: bash -n rejects the shape that broke the v0.6.0 gate", () => {
    expect(bashN("node -e '\n  // the receiver's repo\n  console.log(\"x\");\n'").status).not.toBe(0);
  });

  it("control: an unsupported block indicator fails loudly", () => {
    expect(() => runBlocks("    - run: >-\n        echo hi\n")).toThrow(/unsupported/);
  });

  for (const f of readdirSync(WORKFLOWS).filter((n) => /\.ya?ml$/.test(n))) {
    it(f, () => {
      const yml = readFileSync(join(WORKFLOWS, f), "utf8");
      expect(yml, `${f} runs a step under a shell this test does not check`).not.toMatch(/^\s*(?:-\s+)?shell:\s*(?!bash\b)/m);
      const blocks = runBlocks(yml);
      expect(blocks.length, `no run: blocks found in ${f} — the extractor is blind`).toBeGreaterThan(0);
      for (const b of blocks) {
        const r = bashN(b.script);
        expect(r.status, `${f}:${b.line} does not parse as bash: ${r.stderr}`).toBe(0);
      }
    });
  }
});

describe("release-compat-gate.mjs", () => {
  /** A repo-shaped temp dir: scripts/, dist/wire-surface.js, package.json, and a fake `gh`. */
  function layout(agentCompat: string, releaseBody: string) {
    const root = mkdtempSync(join(tmpdir(), "gate-"));
    mkdirSync(join(root, "scripts"));
    mkdirSync(join(root, "dist"));
    mkdirSync(join(root, "bin"));
    cpSync("scripts/release-compat-gate.mjs", join(root, "scripts/release-compat-gate.mjs"));
    writeFileSync(join(root, "dist/wire-surface.js"), `export const AGENT_COMPAT = ${JSON.stringify(AGENT_COMPAT)};\n`);
    writeFileSync(join(root, "package.json"), JSON.stringify({ agentCompat }));
    writeFileSync(join(root, "body.txt"), releaseBody);
    writeFileSync(join(root, "bin/gh"), `#!/bin/sh\ncat "${join(root, "body.txt")}"\n`);
    chmodSync(join(root, "bin/gh"), 0o755);
    return (cwd = tmpdir()) =>
      spawnSync("node", [join(root, "scripts/release-compat-gate.mjs")], {
        cwd,
        encoding: "utf8",
        env: { ...process.env, RELEASE_TAG: "v9.9.9", PATH: `${join(root, "bin")}:${process.env.PATH}` },
      });
  }

  it("local passes, from any working directory", () => {
    const r = layout("local", "")();
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("agentCompat = local");
  });

  it("an unknown class fails", () => {
    expect(layout("sideways", "")().status).toBe(1);
  });

  it("receiver-first needs a receiver-confirmed line in the release notes", () => {
    expect(layout("receiver-first", "notes without it")().status).toBe(1);
    const ok = layout("receiver-first", "- receiver-confirmed: briefick 30cf66f on 2026-10-01\n")();
    expect(ok.status, ok.stderr).toBe(0);
  });
});
