import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { upRegistrationLines } from "../src/cli.js";
import { prepareLogFile, tokenFile, tokenRef } from "../src/config.js";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "mpa-tok-")); dirs.push(d); return d; };

const TOKEN = "s3cr3t-proxy-token-value";
const CFG = { rps: [{ alias: "briefick", url: "https://briefick.example.com" }, { alias: "minipaas", url: "https://m.example.com/api" }] };

describe("the proxy token stays out of service logs (metapass-saas, 2026-10-18)", () => {
  it("🔴 under a service (no TTY), up's registration lines never contain the token", () => {
    const dir = tmp();
    const out = upRegistrationLines(CFG, 8787, TOKEN, dir, false).join("\n");
    expect(out, "the clear token reached a log").not.toContain(TOKEN);
    expect(out).toContain(`Bearer ${tokenRef(dir)}`);
  });

  it("on a terminal, the lines are copy-paste ready with the token itself", () => {
    expect(upRegistrationLines(CFG, 8787, TOKEN, tmp(), true).join("\n")).toContain(`Bearer ${TOKEN}`);
  });

  it("the reference reads the token file when the printed command runs in a shell", () => {
    const dir = tmp();
    writeFileSync(tokenFile(dir), TOKEN + "\n", { mode: 0o600 });
    expect(execFileSync("sh", ["-c", `printf %s "${tokenRef(dir)}"`], { encoding: "utf8" })).toBe(TOKEN);
  });

  it("🔴 the daemon log is created owner-only, and an existing world-readable one is tightened", () => {
    const dir = tmp();
    const fresh = join(dir, "daemon.log");
    prepareLogFile(fresh);
    expect(statSync(fresh).mode & 0o777, "a new daemon.log is readable by others").toBe(0o600);
    const old = join(dir, "old.log");
    writeFileSync(old, "x", { mode: 0o644 });
    prepareLogFile(old);
    expect(statSync(old).mode & 0o777, "an existing 0644 daemon.log was left readable").toBe(0o600);
  });
});

describe("every unit install tightens the log first", () => {
  it("🔴 each installUnit(<log>) in the CLI is preceded by prepareLogFile(<same log>)", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../src/cli.ts", import.meta.url), "utf8");
    const installs = [...src.matchAll(/(?<![A-Za-z])installUnit\(([^)]*\))\)/g)];
    expect(installs.length, "no installUnit call found: the check reads nothing").toBeGreaterThan(0);
    for (const m of installs) {
      const before = src.slice(Math.max(0, m.index! - 200), m.index);
      expect(before, `installUnit(${m[1]}) runs without tightening that log to 0600`).toContain(`prepareLogFile(${m[1]});`);
    }
  });
});

describe("no command prints the token in clear off a terminal (metapass-saas on #65)", () => {
  it("🔴 status and rotate-token, run without a TTY (as an AI agent or a pipe does), print a file reference", async () => {
    const { main } = await import("../src/cli.js");
    const { saveConfig } = await import("../src/config.js");
    const { vi } = await import("vitest");
    const dir = tmp();
    const keyFile = join(dir, "key.json");
    saveConfig(dir, { rps: [{ alias: "minipaas", url: "https://m.example.com/api", verifierUrl: "https://sso.example.com" }] });
    const out: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void out.push(a.join(" ")));
    try {
      expect(await main(["rotate-token", "--key-file", keyFile])).toBe(0);
      const token = (await import("node:fs")).readFileSync(tokenFile(dir), "utf8").trim();
      expect(await main(["status", "--port", "1", "--key-file", keyFile])).toBe(0);
      const all = out.join("\n");
      expect(all, "a command printed the clear token off a terminal").not.toContain(token);
      expect(all).toContain(`Bearer ${tokenRef(dir)}`);
    } finally {
      spy.mockRestore();
    }
  });

  it("every claude mcp add line in the CLI takes the shown token, never the raw one", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../src/cli.ts", import.meta.url), "utf8");
    const calls = [...src.matchAll(/mcpAdd(?:Route)?Command\(([^;]*?)\)(?=[`}])/g)].map((m) => m[1]);
    expect(calls.length, "no call found: the check reads nothing").toBeGreaterThan(0);
    for (const args of calls) {
      expect(args, `a registration line is built from the raw token: mcpAddCommand(${args})`).not.toMatch(/,\s*token\s*[,)]|,\s*token$/);
    }
  });
});
