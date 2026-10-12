import { describe, it, expect, afterEach, vi } from "vitest";
import http from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectV1Target, main, sessionLine } from "../src/cli.js";
import { startDaemon, type DaemonTarget, type RunningDaemon } from "../src/daemon.js";
import { loadConfig, saveConfig } from "../src/config.js";
import { AgentKey } from "../src/key.js";
import { openStore } from "../src/keystore.js";

const closers: Array<() => unknown> = [];
afterEach(async () => {
  for (const f of closers.splice(0).reverse()) await f();
});

function tmpKeyFile(): string {
  const d = mkdtempSync(join(tmpdir(), "mpa-v1-"));
  closers.push(() => rmSync(d, { recursive: true, force: true }));
  return join(d, "key.json");
}

function vc(note = "x"): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "ES256", typ: "dc+sd-jwt" })}.${b64({ iss: "did:jwk:x", _sd: [] })}.sig~${b64(["s", "note", note])}~`;
}

function server(handler: (path: string, body: string, res: http.ServerResponse) => void) {
  const hits: string[] = [];
  return new Promise<{ url: string; hits: string[] }>((resolve) => {
    const srv = http.createServer((req, res) => {
      let b = "";
      req.on("data", (c) => (b += c));
      req.on("end", () => {
        hits.push(req.url ?? "");
        handler(req.url ?? "", b, res);
      });
    });
    srv.listen(0, "127.0.0.1", () => {
      closers.push(() => new Promise<void>((r) => srv.close(() => r())));
      resolve({ url: `http://127.0.0.1:${(srv.address() as { port: number }).port}`, hits });
    });
  });
}

const verifier = () =>
  server((path, body, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    if (path === "/agent/nonce") return res.end(JSON.stringify({ c_nonce: "n", expires_in: 60 }));
    expect(JSON.parse(body).rp, "the registry alias wasn't sent").toBe("minipaas");
    res.end(JSON.stringify({ access_token: "a.b.c", expires_in: 300 }));
  });

const rpRefusing = (reason: string, keys?: string[]) =>
  server((_p, _b, res) => {
    res.writeHead(403, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "constraint_denied", reason, ...(keys ? { keys } : {}) }));
  });

async function setup(reason: string, keys?: string[]) {
  const keyFile = tmpKeyFile();
  const key = await AgentKey.generate();
  const store = openStore({ backend: "file", keyFile });
  const rpUp = await rpRefusing(reason, keys);
  const v = await verifier();
  const credential = vc();
  store.save({ privateJwk: key.exportPrivateJwk(), credentials: { [rpUp.url]: credential } });
  const rp = { alias: "minipaas", url: rpUp.url, verifierUrl: v.url, verifierRp: "minipaas" };
  return { store, key, rp, rpUp, v, credential };
}

async function connect(s: Awaited<ReturnType<typeof setup>>) {
  const data = s.store.load()!;
  const target: DaemonTarget = { alias: "minipaas", targetMcpUrl: s.rp.url + "/api/mcp", auth: null };
  const auth = await connectV1Target(target, data, s.rp, s.store, s.key);
  if (auth) closers.push(() => auth.stop());
  return target;
}

async function call(target: DaemonTarget) {
  const daemon: RunningDaemon = await startDaemon({ targets: [target], token: "t", port: 0 });
  closers.push(() => daemon.close());
  const r = await fetch(`http://127.0.0.1:${daemon.port}/mcp`, {
    method: "POST", headers: { authorization: "Bearer t", "content-type": "application/json" }, body: "{}",
  });
  await r.text();
  return r.status;
}

describe("CLI /1 targets (spec §9–§11.1)", () => {
  it("drop: deletes the stored VC, so a restart doesn't present it again", async () => {
    const s = await setup("constraints_missing");
    const target = await connect(s);
    expect(await call(target)).toBe(403);
    expect(s.store.load()!.credentials?.[s.rp.url], "the dropped VC is still stored").toBeUndefined();

    const tokenCalls = s.v.hits.filter((h) => h === "/agent/token").length;
    const again = await connect(s);
    expect(again.auth, "a restart presented a dropped VC").toBeNull();
    expect(again.pendingReason).toContain("credentials import");
    expect(s.v.hits.filter((h) => h === "/agent/token").length, "a restart exchanged a dropped VC").toBe(tokenCalls);
  });

  it("keep: holds the VC across a restart, names the keys, and unhold presents it again", async () => {
    const s = await setup("constraints_unknown_key", ["maxAmount"]);
    const target = await connect(s);
    expect(await call(target)).toBe(403);
    const data = s.store.load()!;
    expect(data.credentials?.[s.rp.url], "keep deleted the VC").toBe(s.credential);
    expect(data.held?.[s.rp.url]).toEqual({ credential: s.credential, reason: "constraints_unknown_key", keys: ["maxAmount"] });

    const again = await connect(s);
    expect(again.auth, "a restart presented a held VC").toBeNull();
    expect(again.pendingReason).toContain("maxAmount");

    expect(await main(["credentials", "unhold", "--url", s.rp.url, "--key-file", (s.store.location)])).toBe(0);
    expect((await connect(s)).auth, "unhold didn't release the VC").not.toBeNull();
  });

  it.each(["constraints_missing", "constraints_unknown_key"])(
    "a VC imported while the daemon runs survives a %s refusal of the old one (metapass-saas F1)", async (reason) => {
      const s = await setup(reason, ["k"]);
      const target = await connect(s);
      const fresh = vc("new");
      s.store.save({ ...s.store.load()!, credentials: { [s.rp.url]: fresh } });
      expect(await call(target)).toBe(403);
      const after = s.store.load()!;
      expect(after.credentials?.[s.rp.url], "the refusal of the old VC clobbered the imported one").toBe(fresh);
      expect(after.held?.[s.rp.url], "the imported VC was marked held").toBeUndefined();
    });

  it("status shows a held delegation even when the daemon is stopped (metapass-saas F5)", async () => {
    const s = await setup("constraints_unknown_key", ["maxAmount"]);
    const keyFile = s.store.location;
    saveConfig(join(keyFile, ".."), { rps: [{ alias: "minipaas", url: s.rp.url, verifierUrl: s.rp.verifierUrl }] });
    s.store.save({ ...s.store.load()!, held: { [s.rp.url]: { credential: s.credential, reason: "constraints_unknown_key", keys: ["maxAmount"] } } });
    const out: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...a) => void out.push(a.join(" ")));
    closers.push(() => spy.mockRestore());
    expect(await main(["status", "--port", "1", "--key-file", keyFile])).toBe(0);
    expect(out.join("\n")).toContain("위임 보류(constraints_unknown_key: maxAmount)");
  });

  it("a held record for an older VC doesn't hold a newly imported one", async () => {
    const s = await setup("constraints_unknown_key", ["k"]);
    const data = s.store.load()!;
    s.store.save({ ...data, held: { [s.rp.url]: { credential: vc("old"), reason: "constraints_unknown_key", keys: ["k"] } } });
    expect((await connect(s)).auth).not.toBeNull();
  });

  it("add --verifier saves a /1 RP without pairing, and import stores the VC", async () => {
    const keyFile = tmpKeyFile();
    const url = "https://minipaas.example.com";
    expect(await main(["add", url, "--verifier", "https://sso.example.com/", "--key-file", keyFile])).toBe(0);
    expect(loadConfig(join(keyFile, "..")).rps).toEqual([
      { alias: "minipaas", url, verifierUrl: "https://sso.example.com", verifierRp: "minipaas" },
    ]);
    const file = join(keyFile, "..", "vc.txt");
    writeFileSync(file, vc() + "\n");
    expect(await main(["credentials", "import", "--url", url + "/", file, "--key-file", keyFile])).toBe(0);
    expect(openStore({ backend: "file", keyFile }).load()!.credentials?.[url]).toBe(vc());
  });

  it("add --verifier won't silently convert a v0 RP; --force does (Briefick)", async () => {
    const keyFile = tmpKeyFile();
    const dir = join(keyFile, "..");
    const url = "https://briefick.example.com";
    saveConfig(dir, { rps: [{ alias: "briefick", url }] });
    expect(await main(["add", url, "--verifier", "https://sso.example.com", "--key-file", keyFile])).toBe(1);
    expect(loadConfig(dir).rps, "a refused conversion still changed the config").toEqual([{ alias: "briefick", url }]);
    expect(await main(["add", url, "--verifier", "https://sso.example.com", "--force", "--key-file", keyFile])).toBe(0);
    expect(loadConfig(dir).rps[0]).toMatchObject({ verifierUrl: "https://sso.example.com" });
  });

  it("a store that can't be written doesn't reject the connect when the exchange drops the VC (Briefick)", async () => {
    const keyFile = tmpKeyFile();
    const key = await AgentKey.generate();
    const store = openStore({ backend: "file", keyFile });
    const v = await server((path, _b, res) => {
      const [status, body] = path === "/agent/nonce" ? [200, { c_nonce: "n" }] : [400, { error: "invalid_delegation" }];
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    });
    const url = "https://minipaas.example.com";
    store.save({ privateJwk: key.exportPrivateJwk(), credentials: { [url]: vc() } });
    const broken = { ...store, save: () => { throw new Error("disk full"); } };
    const target: DaemonTarget = { alias: "minipaas", targetMcpUrl: url + "/api/mcp", auth: null };
    const auth = await connectV1Target(target, store.load()!, { alias: "minipaas", url, verifierUrl: v.url }, broken, key);
    closers.push(() => auth?.stop());
    expect(auth?.state()).toMatchObject({ status: "dropped" });
  });

  it("import refuses a file that isn't an SD-JWT VC", async () => {
    const keyFile = tmpKeyFile();
    const file = join(keyFile, "..", "bad.txt");
    writeFileSync(file, "not a vc");
    expect(await main(["credentials", "import", "--url", "https://x", file, "--key-file", keyFile])).toBe(1);
  });
});

describe("status: the /1 session line", () => {
  const line = (session: Parameters<typeof sessionLine>[0] extends infer T ? T extends { session?: infer S } ? S : never : never) =>
    sessionLine({ alias: "m", connected: true, session });
  it("names each state, and prints nothing while active", () => {
    expect(line({ status: "active", expiresAt: "e" })).toBeNull();
    expect(line({ status: "retrying", lastError: "fetch failed" })).toBe("⚠ 세션 발급 재시도 중: fetch failed");
    expect(line({ status: "dropped", error: "constraint_denied: constraints_missing" }))
      .toBe("✗ 위임 폐기 — 새 위임 필요: constraint_denied: constraints_missing");
    expect(line({ status: "held", reason: "constraints_unknown_key", keys: ["a", "b"], keysTotal: 5 })).toContain("a, b 외 3개");
    expect(line({ status: "ending", expiresAt: "e" })).toContain("새 위임");
  });
});
