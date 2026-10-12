import { describe, it, expect, afterEach, vi } from "vitest";
import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearCredential, connectV1Target, updateStore } from "../src/cli.js";
import { startDaemon, type DaemonTarget } from "../src/daemon.js";
import { AgentKey } from "../src/key.js";
import { openStore, type KeyStore } from "../src/keystore.js";

const closers: Array<() => unknown> = [];
afterEach(async () => {
  for (const f of closers.splice(0).reverse()) await f();
  vi.restoreAllMocks();
});

async function fileStore() {
  const d = mkdtempSync(join(tmpdir(), "mpa-upd-"));
  closers.push(() => rmSync(d, { recursive: true, force: true }));
  const store = openStore({ backend: "file", keyFile: join(d, "key.json") });
  const key = await AgentKey.generate();
  store.save({ privateJwk: key.exportPrivateJwk(), credentials: { A: "a1" } });
  return { store, key, data: store.load()! as KeyStore };
}

/** Briefick's 🔵 on #44: a daemon write must not undo what `credentials import`/`unhold` wrote meanwhile. */
describe("daemon store writes go through a fresh read (Briefick, #44)", () => {
  it("a daemon write for one RP keeps a VC another process imported meanwhile", async () => {
    const { store, data } = await fileStore();
    store.save({ ...store.load()!, credentials: { A: "a1", B: "b-imported" } });   // `credentials import`, elsewhere
    updateStore(store, data, (s) => { s.credentials = { ...(s.credentials ?? {}), A: "a2" }; });
    expect(store.load()!.credentials, "the daemon's stale copy overwrote the import").toEqual({ A: "a2", B: "b-imported" });
    expect(data.credentials?.B, "the daemon's copy didn't pick up the import").toBe("b-imported");
  });

  it("clearing a refused VC leaves a newer one imported meanwhile", async () => {
    const { store, data } = await fileStore();
    store.save({ ...store.load()!, credentials: { A: "a-new" } });
    expect(clearCredential(store, data, "A", "a1")).toBe(false);
    expect(store.load()!.credentials?.A, "the refusal of the old VC deleted the new one").toBe("a-new");
    expect(clearCredential(store, data, "A", "a-new")).toBe(true);
    expect(store.load()!.credentials?.A).toBeUndefined();
  });
});

/** metapass-saas on #44: pin that the session token never reaches the logs. */
describe("the session token is never logged", () => {
  it("not on exchange, a forwarded call, or the daemon's audit line", async () => {
    const TOKEN = "eyJTOKEN.never-logged.sig";
    const listen = (h: http.RequestListener) => new Promise<string>((r) => {
      const srv = http.createServer(h);
      srv.listen(0, "127.0.0.1", () => {
        closers.push(() => new Promise<void>((c) => srv.close(() => c())));
        r(`http://127.0.0.1:${(srv.address() as { port: number }).port}`);
      });
    });
    const verifier = await listen((req, res) => {
      req.resume();
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(req.url === "/agent/nonce" ? { c_nonce: "n" } : { access_token: TOKEN, expires_in: 300 }));
    });
    const rp = await listen((req, res) => { req.resume(); res.writeHead(200, { "content-type": "application/json" }); res.end("{}"); });

    const out: string[] = [];
    const grab = (...a: unknown[]) => void out.push(a.map(String).join(" "));
    for (const m of ["log", "error", "warn", "info", "debug"] as const) vi.spyOn(console, m).mockImplementation(grab);

    const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const vc = `${b64({ alg: "ES256" })}.${b64({ iss: "did:jwk:x" })}.sig~`;
    const key = await AgentKey.generate();
    const data: KeyStore = { privateJwk: key.exportPrivateJwk(), credentials: { [rp]: vc } };
    const store = { backend: "file" as const, location: "mem", load: () => data, save: () => {} };
    const target: DaemonTarget = { alias: "m", targetMcpUrl: rp + "/api/mcp", auth: null };
    const auth = await connectV1Target(target, data, { alias: "m", url: rp, verifierUrl: verifier }, store, key);
    closers.push(() => auth?.stop());
    const daemon = await startDaemon({ targets: [target], token: "t", port: 0, audit: grab });
    closers.push(() => daemon.close());
    const r = await fetch(`http://127.0.0.1:${daemon.port}/mcp`, { method: "POST", headers: { authorization: "Bearer t" }, body: "{}" });
    expect(r.status).toBe(200);

    expect(out.length, "nothing was logged, so the check below proves nothing").toBeGreaterThan(0);
    expect(out.join("\n")).not.toContain(TOKEN);
  });
});

describe("the v0 refused path with no VC in memory (Briefick, #48)", () => {
  it("doesn't delete a VC that reached the store from elsewhere", async () => {
    const { recoverSessionFailure } = await import("../src/cli.js");
    const { AgentClientError } = await import("../src/briefick.js");
    const { store, key, data } = await fileStore();
    data.credentials = {};                                             // nothing in memory was presented
    store.save({ ...store.load()!, credentials: { A: "a-imported" } });  // imported meanwhile
    // The retrieve that follows fails, so whatever the clear did is what stays on disk.
    const client = { waitForDelegation: async () => { throw new Error("timeout"); } } as unknown as Parameters<typeof recoverSessionFailure>[1];
    const refusal = new AgentClientError("세션 거부: constraints_missing", 403, { reasons: ["constraints_missing"] });
    await expect(recoverSessionFailure(refusal, client, data, "A", store, key)).rejects.toThrow("timeout");
    expect(store.load()!.credentials?.A, "the refusal deleted a VC it never presented").toBe("a-imported");
  });
});
