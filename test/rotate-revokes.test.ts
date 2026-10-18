import { describe, it, expect, afterEach } from "vitest";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDaemon, type RunningDaemon } from "../src/daemon.js";
import { ensureToken, readToken, rotateToken } from "../src/config.js";

const cleanup: Array<() => unknown> = [];
afterEach(async () => { for (const f of cleanup.splice(0).reverse()) await f(); });

async function daemonOn(dir: string): Promise<RunningDaemon> {
  // An unreachable target: only the auth gate matters here, and a passed gate answers something other than 401.
  const d = await startDaemon({ targets: [{ alias: "rp", targetMcpUrl: "http://127.0.0.1:9/mcp", auth: null, pendingReason: "waiting" }],
    token: () => readToken(dir), port: 0, audit: () => {} });
  cleanup.push(() => d.close());
  return d;
}
const call = async (d: RunningDaemon, token: string) =>
  (await fetch(`http://127.0.0.1:${d.port}/rp/mcp`, { method: "POST", headers: { authorization: `Bearer ${token}` }, body: "{}" })).status;

describe("rotate-token revokes the old token without a restart (metapass-saas, 2026-10-18)", () => {
  it("🔴 after a rotation the running daemon refuses the old token and accepts the new one", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mpa-rot-"));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const old = ensureToken(dir);
    const d = await daemonOn(dir);
    expect(await call(d, old), "the current token was refused before any rotation").not.toBe(401);
    const fresh = rotateToken(dir);
    expect(await call(d, old), "the old token still works after rotate-token: the leak isn't revoked").toBe(401);
    expect(await call(d, fresh), "the new token is refused until a restart").not.toBe(401);
  });

  it("🔴 fails closed when the token file is missing or loosened", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mpa-rot-"));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const token = ensureToken(dir);
    const d = await daemonOn(dir);
    chmodSync(join(dir, "proxy-token"), 0o644);
    expect(await call(d, token), "a world-readable token file was still honoured").toBe(401);
    rmSync(join(dir, "proxy-token"));
    expect(await call(d, token), "a deleted token file was still honoured").toBe(401);
  });
});

describe("up wires the per-request token", () => {
  it("🔴 the CLI's startDaemon gets a token function, not a value read once at start", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../src/cli.ts", import.meta.url), "utf8");
    const calls = [...src.matchAll(/startDaemon\(\{([^}]*)\}\)/g)].map((m) => m[1]);
    expect(calls.length, "no startDaemon call found: the check reads nothing").toBeGreaterThan(0);
    for (const c of calls) expect(c, `startDaemon({${c}}) snapshots the token: a rotation won't revoke it`).toMatch(/token:\s*\(\)\s*=>/);
  });
});
