import { describe, it, expect, afterEach, vi } from "vitest";
import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { format } from "node:util";
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
    // util.format, as console does: "%s"/"%o" and extra arguments are rendered, not dropped (metapass-saas, #48).
    const grab = (...a: unknown[]) => void out.push(format(...a));
    for (const m of ["log", "error", "warn", "info", "debug"] as const) vi.spyOn(console, m).mockImplementation(grab);
    for (const stream of [process.stdout, process.stderr]) {
      const write = stream.write.bind(stream);
      vi.spyOn(stream, "write").mockImplementation(((chunk: unknown, ...rest: unknown[]) => {
        out.push(String(chunk));
        return (write as (...x: unknown[]) => boolean)(chunk, ...rest);
      }) as typeof stream.write);
    }

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

describe("the refused VC is the one presented (metapass-saas, #48)", () => {
  it("a refusal of the presented VC doesn't delete a newer one already in memory", async () => {
    const { recoverSessionFailure } = await import("../src/cli.js");
    const { AgentClientError } = await import("../src/briefick.js");
    const { store, key, data } = await fileStore();
    updateStore(store, data, (s) => { s.credentials = { A: "a-newer" }; });   // e.g. the watch loop replaced it
    const client = { waitForDelegation: async () => { throw new Error("timeout"); } } as unknown as Parameters<typeof recoverSessionFailure>[1];
    const refusal = new AgentClientError("세션 거부: constraints_missing", 403, { reasons: ["constraints_missing"] });
    await expect(recoverSessionFailure(refusal, client, data, "A", store, key, "a1")).rejects.toThrow("timeout");
    expect(store.load()!.credentials?.A, "the refusal of a1 deleted a-newer").toBe("a-newer");
  });
});

describe("register saves through a fresh read (metapass-saas, #48)", () => {
  it("a delegation the daemon stored during the register request survives", async () => {
    const { main } = await import("../src/cli.js");
    const d = mkdtempSync(join(tmpdir(), "mpa-reg-"));
    closers.push(() => rmSync(d, { recursive: true, force: true }));
    const keyFile = join(d, "key.json");
    const key = await AgentKey.generate();
    const store = openStore({ backend: "file", keyFile });
    store.save({ privateJwk: key.exportPrivateJwk() });
    const url = await new Promise<string>((resolve) => {
      const srv = http.createServer((req, res) => {
        req.resume();
        req.on("end", () => {
          // While register is in flight, the daemon stores a delegation for another RP.
          store.save({ ...store.load()!, credentials: { "https://other": "vc-from-daemon" } });
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ registered: true }));
        });
      });
      srv.listen(0, "127.0.0.1", () => {
        closers.push(() => new Promise<void>((r) => srv.close(() => r())));
        resolve(`http://127.0.0.1:${(srv.address() as { port: number }).port}`);
      });
    });
    vi.spyOn(console, "log").mockImplementation(() => {});
    expect(await main(["register", "--url", url, "--code", "C1", "--key-file", keyFile])).toBe(0);
    const after = store.load()!;
    expect(after.credentials?.["https://other"], "register's stale copy erased the daemon's delegation").toBe("vc-from-daemon");
    expect(after.registrations?.[url]).toBe(true);
  });
});
