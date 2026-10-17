import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addNeedsVerifier, daemonTargetFor, invocation, main, v0TargetMessage, V0_REMOVED_ON } from "../src/cli.js";
import { loadConfig, saveConfig, type DaemonRp } from "../src/config.js";
import { startDaemon } from "../src/daemon.js";
import { AgentKey } from "../src/key.js";
import { openStore } from "../src/keystore.js";

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
});

function tmpKeyFile(): string {
  const d = mkdtempSync(join(tmpdir(), "mpa-v0gone-"));
  cleanup.push(() => rmSync(d, { recursive: true, force: true }));
  return join(d, "key.json");
}

/** Records every URL fetched through the global `fetch`; answers nothing (connection refused). */
function recordFetch(): string[] {
  const urls: string[] = [];
  vi.stubGlobal("fetch", (async (u: string | URL) => {
    urls.push(String(u));
    throw new TypeError("fetch failed");
  }) as typeof fetch);
  cleanup.push(() => vi.unstubAllGlobals());
  return urls;
}

function captured(stream: "log" | "error"): string[] {
  const out: string[] = [];
  const spy = vi.spyOn(console, stream).mockImplementation((...a: unknown[]) => void out.push(a.join(" ")));
  cleanup.push(() => spy.mockRestore());
  return out;
}

const V0: DaemonRp = { alias: "briefick", url: "https://briefick.example.com" };

describe("v0 was removed (spec §20)", () => {
  it("names the target, the date and the re-add command", () => {
    expect(v0TargetMessage(V0, "mpa")).toBe(
      `'briefick' is a v0 target; v0 was removed (${V0_REMOVED_ON}). Re-add it with: ` +
        "mpa add https://briefick.example.com --verifier <verifier-url> --verifier-rp <alias at the verifier> " +
        "(the exact line is on the RP's agents page; add --code <code> only if the RP asks for one)",
    );
    // An alias the URL wouldn't give must be passed again, or the re-add creates a second entry beside the v0 one.
    expect(v0TargetMessage({ alias: "bf", url: V0.url }, "mpa")).toContain("--verifier-rp <alias at the verifier> --alias bf (");
    // A key already paired there converts without a code (Briefick): the re-add must not demand one.
    expect(v0TargetMessage(V0, "mpa"), "the re-add demands a code an already-paired key doesn't need").not.toMatch(/--code <code> \(/);
  });

  it("🔴 add without --verifier is refused before any network call or config change", async () => {
    const keyFile = tmpKeyFile();
    const urls = recordFetch();
    const err = captured("error");
    expect(await main(["add", V0.url, "--code", "C0DE1234", "--key-file", keyFile])).toBe(1);
    expect(err.join("\n")).toContain(addNeedsVerifier(V0.url));
    expect(err.join("\n")).toContain("--verifier is required");
    expect(err.join("\n"), "a new pairing must be told it needs a code").toContain("--verifier-rp <alias at the verifier> --code <code>");
    expect(urls, "add without --verifier still went to the network").toEqual([]);
    expect(loadConfig(join(keyFile, "..")).rps).toEqual([]);
  });

  it.each(["register", "session", "proxy"])("%s says it was removed and what replaces it", async (cmd) => {
    const err = captured("error");
    expect(await main([cmd, "--url", V0.url, "--key-file", tmpKeyFile()])).toBe(1);
    expect(err.join("\n")).toContain(`'${cmd}' was removed with v0 (${V0_REMOVED_ON})`);
    expect(err.join("\n")).toContain("--verifier");
  });

  it("🔴 up: a v0 entry is never contacted, and its route answers 503 with the re-add command", async () => {
    const key = await AgentKey.generate();
    const store = openStore({ backend: "file", keyFile: tmpKeyFile() });
    store.save({ privateJwk: key.exportPrivateJwk() });
    const urls = recordFetch();
    const err = captured("error");
    const pickup = vi.fn(async () => ({ ok: true as const, delegations: [] }));
    const target = daemonTargetFor(V0, store.load()!, store, key, { pickup });
    expect(target.pendingReason).toBe(v0TargetMessage(V0));
    expect(err.join("\n")).toContain(v0TargetMessage(V0));
    await new Promise((r) => setTimeout(r, 20));
    expect(pickup, "the v0 entry was picked up from").not.toHaveBeenCalled();
    expect(urls, "the v0 entry went to the network").toEqual([]);
    vi.unstubAllGlobals();

    const daemon = await startDaemon({ targets: [target], token: "t", port: 0, audit: () => {} });
    cleanup.push(() => daemon.close());
    const r = await fetch(`http://127.0.0.1:${daemon.port}/briefick/mcp`, { method: "POST", headers: { authorization: "Bearer t" }, body: "{}" });
    expect(r.status).toBe(503);
    expect(((await r.json()) as { message: string }).message).toBe(v0TargetMessage(V0));
  });

  it("control: a /1 entry is picked up from", async () => {
    const key = await AgentKey.generate();
    const store = openStore({ backend: "file", keyFile: tmpKeyFile() });
    store.save({ privateJwk: key.exportPrivateJwk() });
    captured("error");
    const pickup = vi.fn(async () => ({ ok: true as const, delegations: [] }));
    daemonTargetFor({ ...V0, verifierUrl: "https://sso.example.com" }, store.load()!, store, key, { pickup, sleep: () => new Promise(() => {}) });
    await new Promise((r) => setTimeout(r, 20));
    expect(pickup).toHaveBeenCalled();
  });

  it("🔴 status prints the v0 message for that entry and no MCP registration for it", async () => {
    const keyFile = tmpKeyFile();
    saveConfig(join(keyFile, ".."), { port: 1, rps: [V0, { alias: "minipaas", url: "https://minipaas.example.com", verifierUrl: "https://sso.example.com" }] });
    const out = captured("log");
    expect(await main(["status", "--key-file", keyFile])).toBe(0);
    const text = out.join("\n");
    expect(text).toContain(v0TargetMessage(V0, invocation()));
    expect(text).not.toMatch(/claude mcp add --transport http briefick /);
    expect(text, "the /1 entry beside it lost its registration line").toMatch(/claude mcp add --transport http minipaas /);
  });
});
