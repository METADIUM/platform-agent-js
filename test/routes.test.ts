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
import { routeFor, sanitizeRoute, slotKey, vcScope } from "../src/routes.js";
import { latest } from "../src/pickup.js";

const closers: Array<() => unknown> = [];
afterEach(async () => {
  for (const f of closers.splice(0).reverse()) await f();
});

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
/** An SD-JWT VC with a plain `scope` claim (§5.1) and an `exp`. */
const vc = (scope: string[], exp: number, n = "", iat?: number) =>
  `${b64({ alg: "ES256" })}.${b64({ iss: "did:jwk:x", scope, exp, n, ...(iat !== undefined ? { iat } : {}) })}.sig~`;

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
  it("route names are path segments, never `mcp`, and a changed name never collides", () => {
    expect(sanitizeRoute("paas.deploy")).toBe("paas.deploy");
    expect(sanitizeRoute("")).toBe("default");
    expect(sanitizeRoute("a b/c")).toMatch(/^a-b-c-[0-9a-f]{6}$/);
    expect(sanitizeRoute("..")).toMatch(/^r-[0-9a-f]{6}$/);
    expect(sanitizeRoute("mcp")).toMatch(/^mcp-[0-9a-f]{6}$/);
    const names = ["read:x", "read/x", "read-x", "읽기", "쓰기"].map(sanitizeRoute);
    expect(new Set(names).size, `routes collided: ${names}`).toBe(5);
    for (const n of names) expect(n).toMatch(/^[A-Za-z0-9._-]+$/);
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

describe("§15 review fixes (Briefick, #54)", () => {
  it("newer means issued later: a later, shorter delegation wins; a tie keeps the current", async () => {
    const broad = vc(["paas.deploy"], 900, "broad", 100);
    const narrow = vc(["paas.deploy"], 300, "narrow", 200);   // issued later, ends sooner: the user's latest intent
    const pick = (c: string, exp: number) => ({ delegationId: c.slice(-6), credential: c, scope: ["paas.deploy"], exp });
    expect(latest([pick(broad, 900), pick(narrow, 300)])?.credential, "latest preferred the longer one").toBe(narrow);
    const twin = vc(["paas.deploy"], 900, "twin", 100);
    expect(latest([pick(broad, 900), pick(twin, 900)])?.credential, "a tie didn't keep the first").toBe(broad);

    const s = await setup();
    const answers: PickupResult[] = [
      { ok: true, delegations: [pick(broad, 900)] },
      { ok: true, delegations: [pick(broad, 900), pick(narrow, 300)] },
    ];
    const c = clock();
    const v1 = await connectV1Target(s.target, s.store.load()!, { alias: "m", url: s.rp, verifierUrl: s.verifier }, s.store, s.key, {
      pickup: async () => answers.shift()!, sleep: c.sleep,
    });
    closers.push(() => v1.stop());
    await c.tick();
    expect(s.store.load()!.credentials?.[slotKey(s.rp, "paas.deploy")], "a later, narrower delegation was ignored").toBe(narrow);
  });

  it("a dropped route isn't a choice: with one live route left, the RP path serves it", async () => {
    const s = await setup();
    const keep = vc(["paas.deploy"], 9, "keep");
    const refused = vc(["paas.read"], 9, "refused");
    // The verifier refuses the `paas.read` VC, so that route is dropped at its first exchange.
    const verifier = await server((req, body, res) => {
      res.writeHead(req.url === "/agent/nonce" ? 200 : JSON.parse(body).vp_token.startsWith(refused) ? 400 : 200,
        { "content-type": "application/json" });
      if (req.url === "/agent/nonce") return res.end(JSON.stringify({ c_nonce: "n" }));
      res.end(JSON.stringify(JSON.parse(body).vp_token.startsWith(refused)
        ? { error: "invalid_delegation" } : { access_token: "a.b.c", expires_in: 300 }));
    });
    const c = clock();
    const v1 = await connectV1Target(s.target, s.store.load()!, { alias: "m", url: s.rp, verifierUrl: verifier }, s.store, s.key, {
      pickup: async () => ({ ok: true, delegations: [
        { delegationId: "k", credential: keep, scope: ["paas.deploy"], exp: 9 },
        { delegationId: "r", credential: refused, scope: ["paas.read"], exp: 9 },
      ] }),
      sleep: c.sleep,
    });
    closers.push(() => v1.stop());
    expect(v1.routes.size, "the dropped route left status").toBe(2);
    const post = await daemonFor(s.target);
    expect((await post("/m/mcp")).status, "a dropped route made the RP path ambiguous").toBe(200);
  });

  it("a scope whose default name was taken by a rename gets its own route; rename refuses known names", async () => {
    expect(routeFor(["b"], { a: "b" }), "scope b would share route b with renamed scope a").toBe("b-2");
    const s = await setup();
    s.store.save({ ...s.store.load()!, credentials: {
      [slotKey(s.rp, "a")]: vc(["a"], 9), [slotKey(s.rp, "x")]: vc(["b"], 9),   // x holds a scope-b VC (imported --route x)
    } });
    expect(await main(["route", "rename", "--url", s.rp, "a", "b", "--key-file", s.keyFile]),
      "renamed onto a scope's default route that is stored here").toBe(1);
    expect(await main(["route", "rename", "--url", s.rp, "a", "c", "--key-file", s.keyFile])).toBe(0);
  });
});

describe("§15 follow-ups (metapass-saas, #54)", () => {
  const pick = (credential: string, scope: string[], exp = 9) => ({ delegationId: credential.slice(-8), credential, scope, exp });

  it("migration keeps the newer VC when the route already holds one (downgrade → re-upgrade)", async () => {
    const s = await setup();
    const legacy = vc(["read"], 9, "legacy-0.7.0", 100);
    const newer = vc(["read"], 9, "already-routed", 200);
    s.store.save({ ...s.store.load()!, credentials: { [s.rp]: legacy, [slotKey(s.rp, "read")]: newer } });
    const v1 = await connectV1Target(s.target, s.store.load()!, { alias: "m", url: s.rp, verifierUrl: s.verifier }, s.store, s.key);
    closers.push(() => v1.stop());
    expect(s.store.load()!.credentials, "migration overwrote the newer routed VC").toEqual({ [slotKey(s.rp, "read")]: newer });
  });

  it("an in-memory migration followed by a write doesn't bring the old VC back on restart", async () => {
    const s = await setup();
    const legacy = vc(["read"], 9, "legacy", 100);
    const picked = vc(["read"], 9, "picked", 200);
    // The legacy key is still on disk (the first run migrated only in memory), next to the route a pickup wrote.
    s.store.save({ ...s.store.load()!, credentials: { [s.rp]: legacy, [slotKey(s.rp, "read")]: picked } });
    const v1 = await connectV1Target(s.target, s.store.load()!, { alias: "m", url: s.rp, verifierUrl: s.verifier }, s.store, s.key);
    closers.push(() => v1.stop());
    expect(s.store.load()!.credentials?.[slotKey(s.rp, "read")], "a restart put the older VC back").toBe(picked);
  });

  it("a held legacy VC stays held on its route", async () => {
    const s = await setup();
    const legacy = vc(["read"], 9, "held");
    const record = { credential: legacy, reason: "constraints_unknown_key", keys: ["k"] };
    s.store.save({ ...s.store.load()!, credentials: { [s.rp]: legacy }, held: { [s.rp]: record } });
    const v1 = await connectV1Target(s.target, s.store.load()!, { alias: "m", url: s.rp, verifierUrl: s.verifier }, s.store, s.key);
    closers.push(() => v1.stop());
    expect(s.store.load()!.held, "the hold was lost in migration").toEqual({ [slotKey(s.rp, "read")]: record });
    expect(v1.routes.get("read")?.auth, "a held VC was presented after migration").toBeNull();
    expect(s.exchanged.length).toBe(0);
  });

  it("the route name comes from the VC's own scope, not the pickup body's", async () => {
    const s = await setup();
    const c = clock();
    const credential = vc(["read"], 9, "claim");
    const v1 = await connectV1Target(s.target, s.store.load()!, { alias: "m", url: s.rp, verifierUrl: s.verifier }, s.store, s.key, {
      pickup: async () => ({ ok: true, delegations: [pick(credential, ["something-else"])] }), sleep: c.sleep,
    });
    closers.push(() => v1.stop());
    expect([...v1.routes.keys()]).toEqual(["read"]);
  });

  it("a delegation that doesn't change isn't re-exchanged on every pickup pass", async () => {
    const s = await setup();
    const c = clock();
    const credential = vc(["read"], 9, "stable");
    const v1 = await connectV1Target(s.target, s.store.load()!, { alias: "m", url: s.rp, verifierUrl: s.verifier }, s.store, s.key, {
      pickup: async () => ({ ok: true, delegations: [pick(credential, ["read"])] }), sleep: c.sleep,
    });
    closers.push(() => v1.stop());
    for (let i = 0; i < 3; i++) await c.tick();
    expect(s.exchanged.length, "each pass reconnected the same delegation").toBe(1);
  });

  it("a stored VC already refused is not connected at startup", async () => {
    const { vcDigest } = await import("../src/cli.js");
    const s = await setup();
    const refused = vc(["read"], 9, "refused");
    s.store.save({ ...s.store.load()!, credentials: { [slotKey(s.rp, "read")]: refused },
      dropped: { [s.rp]: [{ digest: vcDigest(refused), exp: null }] } });
    const v1 = await connectV1Target(s.target, s.store.load()!, { alias: "m", url: s.rp, verifierUrl: s.verifier }, s.store, s.key);
    closers.push(() => v1.stop());
    expect(v1.routes.size, "a refused VC got a route at startup").toBe(0);
    expect(s.exchanged.length).toBe(0);
  });

  it("stop() ends pickup", async () => {
    const s = await setup();
    const c = clock();
    let pickups = 0;
    const v1 = await connectV1Target(s.target, s.store.load()!, { alias: "m", url: s.rp, verifierUrl: s.verifier }, s.store, s.key, {
      pickup: async () => { pickups++; return { ok: false, error: "authorization_pending" }; }, sleep: c.sleep,
    });
    v1.stop();
    await c.tick();
    await c.tick();
    expect(pickups, "pickup kept running after stop()").toBe(1);
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
