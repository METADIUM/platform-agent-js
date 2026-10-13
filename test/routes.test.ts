import { describe, it, expect, afterEach, vi } from "vitest";
import http from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentKey } from "../src/key.js";
import { connectV1Target, main } from "../src/cli.js";
import { startDaemon, type DaemonTarget } from "../src/daemon.js";
import { openStore } from "../src/keystore.js";
import { saveConfig } from "../src/config.js";
import type { PickupResult } from "../src/pickup.js";
import { sanitizeRoute, slotKey, vcScope } from "../src/routes.js";

const closers: Array<() => unknown> = [];
afterEach(async () => {
  for (const f of closers.splice(0).reverse()) await f();
});

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
/** An SD-JWT VC with a plain `scope` claim (§5.1) and an `exp`. */
const vc = (scope: string[], exp: number, n = "") => `${b64({ alg: "ES256" })}.${b64({ iss: "did:jwk:x", scope, exp, n })}.sig~`;

function server(handler: (req: http.IncomingMessage, body: string, res: http.ServerResponse) => void) {
  return new Promise<string>((resolve) => {
    const srv = http.createServer((req, res) => {
      let b = "";
      req.on("data", (c) => (b += c));
      req.on("end", () => handler(req, b, res));
    });
    srv.listen(0, "127.0.0.1", () => {
      closers.push(() => new Promise<void>((r) => srv.close(() => r())));
      resolve(`http://127.0.0.1:${(srv.address() as { port: number }).port}`);
    });
  });
}

function clock() {
  let wake: (() => void) | undefined;
  let asleep: (() => void) | undefined;
  return {
    sleep: (_ms: number) => new Promise<void>((r) => { wake = r; asleep?.(); asleep = undefined; }),
    async tick(): Promise<void> {
      const next = new Promise<void>((r) => (asleep = r));
      const w = wake;
      wake = undefined;
      w?.();
      await Promise.race([next, new Promise((r) => setTimeout(r, 1000))]);
    },
  };
}

async function setup() {
  const d = mkdtempSync(join(tmpdir(), "mpa-routes-"));
  closers.push(() => rmSync(d, { recursive: true, force: true }));
  const keyFile = join(d, "key.json");
  const store = openStore({ backend: "file", keyFile });
  const key = await AgentKey.generate();
  store.save({ privateJwk: key.exportPrivateJwk() });
  /** The VC each `/agent/token` exchange presented, in order. */
  const exchanged: string[] = [];
  const verifier = await server((req, body, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    if (req.url === "/agent/nonce") return res.end(JSON.stringify({ c_nonce: "n" }));
    exchanged.push(JSON.parse(body).vp_token);
    res.end(JSON.stringify({ access_token: "a.b.c", expires_in: 300 }));
  });
  /** Which daemon route each RP call came through, by its path. */
  const hits: string[] = [];
  const rp = await server((req, _b, res) => {
    hits.push(req.url ?? "");
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
  const target: DaemonTarget = { alias: "m", targetMcpUrl: rp + "/api/mcp", auth: null };
  return { keyFile, store, key, verifier, rp, target, exchanged, hits };
}

async function daemonFor(target: DaemonTarget) {
  const d = await startDaemon({ targets: [target], token: "t", port: 0 });
  closers.push(() => d.close());
  return async (path: string) => {
    const r = await fetch(`http://127.0.0.1:${d.port}${path}`, { method: "POST", headers: { authorization: "Bearer t" }, body: "{}" });
    return { status: r.status, body: await r.text() };
  };
}

describe("§15 multiple delegations: one daemon route each", () => {
  it("route names are path segments, never `mcp`", () => {
    expect(sanitizeRoute("paas.deploy")).toBe("paas.deploy");
    expect(sanitizeRoute("a b/c")).toBe("a-b-c");
    expect(sanitizeRoute("")).toBe("default");
    expect(sanitizeRoute("..")).toBe("default");
    expect(sanitizeRoute("mcp")).toBe("mcp-route");
  });

  it("reads scope from the plain claim, else from a disclosure", () => {
    expect(vcScope(vc(["paas.deploy"], 1))).toEqual(["paas.deploy"]);
    const disclosed = `${b64({ alg: "ES256" })}.${b64({ iss: "x", _sd: [] })}.sig~${b64(["salt", "scope", ["w.read"]])}~`;
    expect(vcScope(disclosed)).toEqual(["w.read"]);
    expect(vcScope("not a vc")).toEqual([]);
  });

  it("two delegations with different scopes become two routes; the RP path is then ambiguous", async () => {
    const s = await setup();
    const deploy = vc(["paas.deploy"], 100);
    const read = vc(["paas.read"], 100);
    const c = clock();
    const v1 = await connectV1Target(s.target, s.store.load()!, { alias: "m", url: s.rp, verifierUrl: s.verifier }, s.store, s.key, {
      pickup: async (): Promise<PickupResult> => ({ ok: true, delegations: [
        { delegationId: "d", credential: deploy, scope: ["paas.deploy"], exp: 100 },
        { delegationId: "r", credential: read, scope: ["paas.read"], exp: 100 },
      ] }),
      sleep: c.sleep,
    });
    closers.push(() => v1.stop());
    expect([...v1.routes.keys()].sort()).toEqual(["paas.deploy", "paas.read"]);
    const stored = s.store.load()!.credentials!;
    expect(stored[slotKey(s.rp, "paas.deploy")]).toBe(deploy);
    expect(stored[slotKey(s.rp, "paas.read")]).toBe(read);

    const post = await daemonFor(s.target);
    expect((await post("/m/paas.deploy/mcp")).status).toBe(200);
    expect((await post("/m/paas.read/mcp")).status).toBe(200);
    expect(s.hits, "a route didn't reach the RP's MCP").toEqual(["/api/mcp", "/api/mcp"]);
    const amb = await post("/m/mcp");
    expect(amb.status, "the RP-level path chose a delegation itself").toBe(410);
    expect(JSON.parse(amb.body)).toMatchObject({ error: "ambiguous_route", routes: expect.arrayContaining(["paas.deploy", "paas.read"]) });
    expect((await post("/m/nope/mcp")).status).toBe(404);
  });

  it("a newer delegation on the same route replaces the older; an older one never displaces it", async () => {
    const s = await setup();
    const older = vc(["paas.deploy"], 100, "older");
    const newer = vc(["paas.deploy"], 200, "newer");
    const answers: PickupResult[] = [
      { ok: true, delegations: [{ delegationId: "o", credential: older, scope: ["paas.deploy"], exp: 100 }] },
      { ok: true, delegations: [
        { delegationId: "o", credential: older, scope: ["paas.deploy"], exp: 100 },
        { delegationId: "n", credential: newer, scope: ["paas.deploy"], exp: 200 },
      ] },
      { ok: true, delegations: [{ delegationId: "o", credential: older, scope: ["paas.deploy"], exp: 100 }] },
    ];
    const c = clock();
    const v1 = await connectV1Target(s.target, s.store.load()!, { alias: "m", url: s.rp, verifierUrl: s.verifier }, s.store, s.key, {
      pickup: async () => answers.shift()!, sleep: c.sleep,
    });
    closers.push(() => v1.stop());
    const first = v1.routes.get("paas.deploy")!.auth as { stop(): void };
    const stopped = vi.spyOn(first, "stop");
    await c.tick();
    expect(s.store.load()!.credentials?.[slotKey(s.rp, "paas.deploy")], "the newer delegation didn't replace").toBe(newer);
    expect(stopped, "the replaced session kept refreshing").toHaveBeenCalled();
    expect(v1.routes.get("paas.deploy")!.auth).not.toBe(first);
    expect(v1.routes.size).toBe(1);
    await c.tick();
    expect(s.store.load()!.credentials?.[slotKey(s.rp, "paas.deploy")], "an older delegation displaced the newer").toBe(newer);
    // vp_token = the VC + a KB-JWT, so match by the VC it starts with.
    const which = s.exchanged.map((t) => (t.startsWith(older) ? "older" : t.startsWith(newer) ? "newer" : "?"));
    expect(which, "the older VC was exchanged again after being replaced").toEqual(["older", "newer"]);
  });

  it("a renamed route keeps its name for the next delegation of that scope", async () => {
    const s = await setup();
    s.store.save({ ...s.store.load()!, routeNames: { [s.rp]: { "paas.deploy": "deploy" } } });
    const c = clock();
    const v1 = await connectV1Target(s.target, s.store.load()!, { alias: "m", url: s.rp, verifierUrl: s.verifier }, s.store, s.key, {
      pickup: async () => ({ ok: true, delegations: [{ delegationId: "d", credential: vc(["paas.deploy"], 9), scope: ["paas.deploy"], exp: 9 }] }),
      sleep: c.sleep,
    });
    closers.push(() => v1.stop());
    expect([...v1.routes.keys()]).toEqual(["deploy"]);
  });

  it("a pre-§15 credential moves to the route its scope names, and keeps serving the RP path", async () => {
    const s = await setup();
    const legacy = vc(["paas.deploy"], 9);
    s.store.save({ ...s.store.load()!, credentials: { [s.rp]: legacy } });
    const v1 = await connectV1Target(s.target, s.store.load()!, { alias: "m", url: s.rp, verifierUrl: s.verifier }, s.store, s.key);
    closers.push(() => v1.stop());
    const stored = s.store.load()!.credentials!;
    expect(stored[s.rp], "the legacy key was left behind").toBeUndefined();
    expect(stored[slotKey(s.rp, "paas.deploy")]).toBe(legacy);
    const post = await daemonFor(s.target);
    expect((await post("/m/mcp")).status, "an existing /<alias>/mcp registration broke with one route").toBe(200);
  });
});

describe("§15 CLI", () => {
  it("credentials import --route, route rename, and status prints one registration per route", async () => {
    const s = await setup();
    const dir = join(s.keyFile, "..");
    saveConfig(dir, { rps: [{ alias: "m", url: s.rp, verifierUrl: s.verifier }] });
    const f1 = join(dir, "a.txt");
    const f2 = join(dir, "b.txt");
    writeFileSync(f1, vc(["paas.deploy"], 9_999_999_999));
    writeFileSync(f2, vc(["paas.read"], 9_999_999_999));
    expect(await main(["credentials", "import", "--url", s.rp, f1, "--key-file", s.keyFile])).toBe(0);
    expect(await main(["credentials", "import", "--url", s.rp, f2, "--route", "reader", "--key-file", s.keyFile])).toBe(0);
    let creds = s.store.load()!.credentials!;
    expect(Object.keys(creds).sort()).toEqual([slotKey(s.rp, "paas.deploy"), slotKey(s.rp, "reader")]);

    expect(await main(["route", "rename", "--url", s.rp, "paas.deploy", "deploy", "--key-file", s.keyFile])).toBe(0);
    const after = s.store.load()!;
    creds = after.credentials!;
    expect(creds[slotKey(s.rp, "deploy")], "rename didn't move the VC").toBeDefined();
    expect(creds[slotKey(s.rp, "paas.deploy")]).toBeUndefined();
    expect(after.routeNames?.[s.rp]).toEqual({ "paas.deploy": "deploy" });
    expect(await main(["route", "rename", "--url", s.rp, "deploy", "reader", "--key-file", s.keyFile]), "renamed onto a taken route").toBe(1);

    const out: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...a) => void out.push(a.join(" ")));
    closers.push(() => spy.mockRestore());
    expect(await main(["status", "--port", "1", "--key-file", s.keyFile])).toBe(0);
    const text = out.join("\n");
    expect(text).toMatch(/m-deploy http:\/\/127\.0\.0\.1:\d+\/m\/deploy\/mcp/);
    expect(text).toMatch(/m-reader http:\/\/127\.0\.0\.1:\d+\/m\/reader\/mcp/);
  });

  it("credentials clear --url removes every route of the RP", async () => {
    const s = await setup();
    s.store.save({ ...s.store.load()!, credentials: { [slotKey(s.rp, "a")]: "x", [slotKey(s.rp, "b")]: "y", other: "z" } });
    expect(await main(["credentials", "clear", "--url", s.rp, "--key-file", s.keyFile])).toBe(0);
    expect(s.store.load()!.credentials).toEqual({ other: "z" });
  });
});
