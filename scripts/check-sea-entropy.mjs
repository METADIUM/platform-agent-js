#!/usr/bin/env node
/**
 * CVE-2026-106074: Node could save the crypto.randomUUID()/randomInt() entropy cache into startup
 * snapshots and SEAs, so every run of the same binary repeats the same "random" values. `key.ts`
 * takes a `jti` from randomUUID(), so a repeat would hand out the same jti on every run.
 *
 * This builds a throwaway SEA with the running node and the release's SEA_OPTIONS, runs it three
 * times, and exits 1 if any two runs print the same value. The release workflow runs it with the
 * same `.nvmrc` node the shipped binaries are built from.
 *
 *   node scripts/check-sea-entropy.mjs
 *   SEA_OPTIONS_OVERRIDE='{"useSnapshot":true}' SEA_SNAPSHOT_WARMUP=1 node scripts/check-sea-entropy.mjs   # control
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { SEA_OPTIONS } from "./sea-options.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
const RUNS = 3;
const options = { ...SEA_OPTIONS, ...JSON.parse(process.env.SEA_OPTIONS_OVERRIDE ?? "{}") };
const dir = mkdtempSync(join(tmpdir(), "sea-entropy-"));
const run = (cmd, args) => execFileSync(cmd, args, { cwd: dir, stdio: ["ignore", "pipe", "inherit"] });

try {
  const probe = `
const c = require("node:crypto");
const print = () => process.stdout.write(JSON.stringify({
  randomUUID: c.randomUUID(), randomInt: c.randomInt(2 ** 47) }));
${options.useSnapshot
    ? `const v8 = require("node:v8");
${process.env.SEA_SNAPSHOT_WARMUP ? "c.randomUUID(); c.randomInt(2 ** 47);" : ""}
v8.startupSnapshot.setDeserializeMainFunction(print);`
    : "print();"}
`;
  writeFileSync(join(dir, "probe.cjs"), probe);
  writeFileSync(join(dir, "sea-config.json"), JSON.stringify({ main: "probe.cjs", output: "probe.blob", ...options }));
  run(process.execPath, ["--experimental-sea-config", "sea-config.json"]);

  const bin = join(dir, "probe");
  copyFileSync(process.execPath, bin);
  chmodSync(bin, 0o755);
  const darwin = process.platform === "darwin";
  if (darwin) run("codesign", ["--remove-signature", bin]);
  run(join(ROOT, "node_modules/.bin/postject"), [bin, "NODE_SEA_BLOB", "probe.blob",
    "--sentinel-fuse", "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2",
    ...(darwin ? ["--macho-segment-name", "NODE_SEA"] : [])]);
  if (darwin) run("codesign", ["-s", "-", bin]);

  const outs = Array.from({ length: RUNS }, () => JSON.parse(execFileSync(bin, { encoding: "utf8" })));
  const label = process.env.SEA_OPTIONS_OVERRIDE ? "CONTROL (not the release options)" : "release options";
  console.log(`node ${process.version} · ${label} ${JSON.stringify(options)}`);
  for (const o of outs) console.log(`  ${JSON.stringify(o)}`);
  const repeated = ["randomUUID", "randomInt"].filter((k) => new Set(outs.map((o) => o[k])).size < RUNS);
  if (repeated.length > 0) {
    console.error(`🔴 ${repeated.join(", ")} repeated across runs of one SEA (CVE-2026-106074).`);
    console.error("   Build with a Node that fixes it (22.23.4+), or stop calling these before the snapshot.");
    process.exitCode = 1; // not exit(): the finally below must still remove the probe
  } else {
    console.log(`🟢 ${RUNS} runs of one SEA gave ${RUNS} different randomUUID and randomInt values.`);
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
