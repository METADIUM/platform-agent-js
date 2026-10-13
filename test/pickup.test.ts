import { describe, it, expect, afterEach } from "vitest";
import http from "node:http";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeJwt, decodeProtectedHeader } from "jose";
import { AgentKey } from "../src/key.js";
import { latest, pickup, pickupMessage, type PickupResult } from "../src/pickup.js";
import { connectV1Target } from "../src/cli.js";
import { startDaemon, type DaemonTarget } from "../src/daemon.js";
import { openStore } from "../src/keystore.js";

const closers: Array<() => unknown> = [];
afterEach(async () => {
  for (const f of closers.splice(0).reverse()) await f();
});

function server(handler: (req: http.IncomingMessage, body: Buffer, res: http.ServerResponse) => void) {
  return new Promise<string>((resolve) => {
    const srv = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => handler(req, Buffer.concat(chunks), res));
    });
    srv.listen(0, "127.0.0.1", () => {
      closers.push(() => new Promise<void>((r) => srv.close(() => r())));
      resolve(`http://127.0.0.1:${(srv.address() as { port: number }).port}`);
    });
  });
}
const json = (res: http.ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const vc = (n: string) => `${b64({ alg: "ES256" })}.${b64({ iss: "did:jwk:x", n })}.sig~`;

describe("pickup (spec §8)", () => {
  it("signs a proof with no token over the exact body, htu = origin + path", async () => {
    const key = await AgentKey.generate();
    let seen: { proof: string; body: Buffer; url?: string } | undefined;
    const url = await server((req, body, res) => {
      seen = { proof: String(req.headers["agent-proof"]), body, url: req.url };
      json(res, 200, { delegations: [{ delegationId: "d1", credential: "c1", scope: ["read"], exp: 10 }] });
    });
    const r = await pickup({ url: url + "/", key, version: "0.7.0" });
    expect(r).toEqual({ ok: true, delegations: [{ delegationId: "d1", credential: "c1", scope: ["read"], exp: 10 }] });
    expect(seen!.url).toBe("/api/agent/pickup");
    expect(decodeProtectedHeader(seen!.proof)).toMatchObject({ typ: "agent-request+jwt", kid: key.did + "#0" });
    const p = decodeJwt(seen!.proof);
    expect(p).toMatchObject({ htm: "POST", htu: url + "/api/agent/pickup", bh: createHash("sha256").update(seen!.body).digest("base64url") });
    expect(p.ath, "pickup carries no token").toBeUndefined();
    expect(JSON.parse(seen!.body.toString())).toEqual({ version: "0.7.0" });
  });

  it("reads the §8 refusals and throws on anything else", async () => {
    const key = await AgentKey.generate();
    const pending = await server((_q, _b, res) => json(res, 400, { error: "authorization_pending", interval: 90, lastRequest: { status: "awaiting_link" } }));
    expect(await pickup({ url: pending, key })).toEqual({ ok: false, error: "authorization_pending", interval: 90, lastRequest: { status: "awaiting_link" } });
    const broken = await server((_q, _b, res) => { res.writeHead(502); res.end("bad gateway"); });
    await expect(pickup({ url: broken, key })).rejects.toThrow("pickup 502");
  });

  it("says a different thing for each refusal", () => {
    expect(pickupMessage({ error: "authorization_pending", lastRequest: { status: "awaiting_link" } }, "u")).toContain("지갑 지문");
    expect(pickupMessage({ error: "expired_token", lastRequest: { status: "delivery_expired" } }, "u")).toContain("받을 기한");
    expect(pickupMessage({ error: "expired_token" }, "u")).toContain("요청이 만료");
    expect(pickupMessage({ error: "unknown_agent" }, "https://rp")).toContain("add https://rp --verifier");
  });

  it("latest picks the delegation that lasts longest", () => {
    expect(latest([{ delegationId: "a", credential: "a", scope: [], exp: 5 }, { delegationId: "b", credential: "b", scope: [], exp: 9 }])?.delegationId).toBe("b");
    expect(latest([])).toBeNull();
  });
});

describe("a /1 target picks up its delegation (spec §8 → §9 → §10)", () => {
  async function setup(rpStatus: (n: number) => [number, unknown]) {
    const d = mkdtempSync(join(tmpdir(), "mpa-pick-"));
    closers.push(() => rmSync(d, { recursive: true, force: true }));
    const store = openStore({ backend: "file", keyFile: join(d, "key.json") });
    const key = await AgentKey.generate();
    store.save({ privateJwk: key.exportPrivateJwk() });
    const verifier = await server((req, _b, res) =>
      json(res, 200, req.url === "/agent/nonce" ? { c_nonce: "n" } : { access_token: "a.b.c", expires_in: 300 }));
    let calls = 0;
    const rp = await server((_q, _b, res) => { calls++; const [s, b] = rpStatus(calls); json(res, s, b); });
    const target: DaemonTarget = { alias: "m", targetMcpUrl: rp + "/api/mcp", auth: null };
    return { store, key, verifier, rp, target, data: store.load()! };
  }
  const call = async (target: DaemonTarget) => {
    const daemon = await startDaemon({ targets: [target], token: "t", port: 0 });
    closers.push(() => daemon.close());
    const r = await fetch(`http://127.0.0.1:${daemon.port}/mcp`, { method: "POST", headers: { authorization: "Bearer t" }, body: "{}" });
    await r.text();
    return r.status;
  };

  it("waits while pending, then stores the delegation and connects", async () => {
    const s = await setup(() => [200, {}]);
    const answers: PickupResult[] = [
      { ok: false, error: "authorization_pending", interval: 1 },
      { ok: true, delegations: [{ delegationId: "d1", credential: vc("1"), scope: [], exp: 1 }] },
    ];
    const slept: number[] = [];
    const auth = await connectV1Target(s.target, s.data, { alias: "m", url: s.rp, verifierUrl: s.verifier }, s.store, s.key, {
      pickup: async () => answers.shift()!,
      sleep: async (ms) => void slept.push(ms),
    });
    closers.push(() => auth?.stop());
    expect(slept, "pickup polled faster than the default 60 s").toEqual([60_000]);
    expect(s.store.load()!.credentials?.[s.rp], "the picked-up VC wasn't stored").toBe(vc("1"));
    expect(await call(s.target)).toBe(200);
  });

  it("never re-adopts a VC the RP dropped; picks up the next one", async () => {
    const s = await setup((n) => (n === 1 ? [403, { error: "constraint_denied", reason: "constraints_missing" }] : [200, {}]));
    const old = vc("old");
    const fresh = vc("new");
    let pickups = 0;
    const deps = {
      // The RP keeps handing back the refused VC (§8: repeatable) until the new one is delivered.
      pickup: async (): Promise<PickupResult> => {
        pickups++;
        return { ok: true, delegations: pickups < 3 ? [{ delegationId: "old", credential: old, scope: [], exp: 1 }]
          : [{ delegationId: "old", credential: old, scope: [], exp: 1 }, { delegationId: "new", credential: fresh, scope: [], exp: 0 }] };
      },
      sleep: async () => {},
    };
    const auth = await connectV1Target(s.target, s.data, { alias: "m", url: s.rp, verifierUrl: s.verifier }, s.store, s.key, deps);
    closers.push(() => auth?.stop());
    expect(await call(s.target)).toBe(403);   // drop
    await new Promise((r) => setTimeout(r, 200));
    expect(pickups, "the dropped VC was re-adopted instead of waiting").toBe(3);
    expect(s.store.load()!.credentials?.[s.rp]).toBe(fresh);
    closers.push(() => (s.target.auth as { stop?: () => void } | null)?.stop?.());
  });
});

describe("pickup follow-ups (minipaas, Briefick, metapass-saas on #48/#49)", () => {
  async function store() {
    const d = mkdtempSync(join(tmpdir(), "mpa-pick2-"));
    closers.push(() => rmSync(d, { recursive: true, force: true }));
    const s = openStore({ backend: "file", keyFile: join(d, "key.json") });
    const key = await AgentKey.generate();
    s.save({ privateJwk: key.exportPrivateJwk() });
    return { s, key };
  }

  it("a restart doesn't re-adopt a VC dropped before it (persisted digest)", async () => {
    const { vcDigest } = await import("../src/cli.js");
    const { s, key } = await store();
    const old = vc("dropped-before-restart");
    const fresh = vc("next");
    s.save({ ...s.load()!, dropped: { "https://rp": [{ digest: vcDigest(old), exp: null }] } });
    const answers: PickupResult[] = [
      { ok: true, delegations: [{ delegationId: "old", credential: old, scope: [], exp: 9 }] },
      { ok: true, delegations: [{ delegationId: "old", credential: old, scope: [], exp: 9 }, { delegationId: "new", credential: fresh, scope: [], exp: 1 }] },
    ];
    const target: DaemonTarget = { alias: "m", targetMcpUrl: "https://rp/api/mcp", auth: null };
    // The verifier is unreachable on purpose: only which VC was adopted matters here.
    const auth = await connectV1Target(target, s.load()!, { alias: "m", url: "https://rp", verifierUrl: "http://127.0.0.1:9" }, s, key, {
      pickup: async () => answers.shift()!, sleep: async () => {},
    });
    closers.push(() => auth?.stop());
    expect(answers.length, "the dropped VC was adopted on the first pickup").toBe(0);
    expect(s.load()!.credentials?.["https://rp"]).toBe(fresh);
  });

  it("an RP without §8 (pickup 404) stops polling and says credentials import", async () => {
    const key = await AgentKey.generate();
    const url = await server((_q, _b, res) => { res.writeHead(404); res.end("not found"); });
    expect(await pickup({ url, key })).toEqual({ ok: false, error: "no_pickup" });
    const { s } = await store();
    let calls = 0;
    let sleeps = 0;
    const target: DaemonTarget = { alias: "b", targetMcpUrl: url + "/api/mcp", auth: null };
    const auth = await connectV1Target(target, s.load()!, { alias: "b", url, verifierUrl: url }, s, key, {
      pickup: async () => { calls++; return pickup({ url, key }); },
      sleep: async () => { if (++sleeps > 1) throw new Error("it kept polling after two 404s"); },
    });
    expect(auth).toBeNull();
    expect(calls, "it gave up on one 404 (a deploy can produce one) or polled past two").toBe(2);
    expect(target.pendingReason).toContain("credentials import");
  });
});

it("one 404 between answers doesn't park pickup (Briefick, #51)", async () => {
  const d = mkdtempSync(join(tmpdir(), "mpa-pick3-"));
  closers.push(() => rmSync(d, { recursive: true, force: true }));
  const s = openStore({ backend: "file", keyFile: join(d, "key.json") });
  const key = await AgentKey.generate();
  s.save({ privateJwk: key.exportPrivateJwk() });
  const answers: PickupResult[] = [
    { ok: false, error: "no_pickup" },
    { ok: false, error: "authorization_pending" },
    { ok: false, error: "no_pickup" },
    { ok: true, delegations: [{ delegationId: "d", credential: vc("after-404s"), scope: [], exp: 1 }] },
  ];
  const target: DaemonTarget = { alias: "m", targetMcpUrl: "https://rp/api/mcp", auth: null };
  const auth = await connectV1Target(target, s.load()!, { alias: "m", url: "https://rp", verifierUrl: "http://127.0.0.1:9" }, s, key, {
    pickup: async () => answers.shift()!, sleep: async () => {},
  });
  closers.push(() => auth?.stop());
  expect(s.load()!.credentials?.["https://rp"], "two non-consecutive 404s parked pickup").toBe(vc("after-404s"));
});

describe("metapass-saas's #51 findings", () => {
  async function fresh() {
    const d = mkdtempSync(join(tmpdir(), "mpa-b1-"));
    closers.push(() => rmSync(d, { recursive: true, force: true }));
    const s = openStore({ backend: "file", keyFile: join(d, "key.json") });
    const key = await AgentKey.generate();
    s.save({ privateJwk: key.exportPrivateJwk() });
    return { s, key };
  }

  it("B1: a VC dropped while the store no longer holds it is not re-presented in a loop", async () => {
    const { s, key } = await fresh();
    let tokenCalls = 0;
    const verifier = await server((req, _b, res) => {
      if (req.url === "/agent/nonce") return json(res, 200, { c_nonce: "n" });
      tokenCalls++;
      json(res, 400, { error: "invalid_delegation" });
    });
    const refused = vc("refused");
    const data = { ...s.load()!, credentials: { "https://rp": refused } };   // in memory only: `credentials clear` ran
    const target: DaemonTarget = { alias: "m", targetMcpUrl: "https://rp/api/mcp", auth: null };
    const sleeps: number[] = [];
    await connectV1Target(target, data, { alias: "m", url: "https://rp", verifierUrl: verifier }, s, key, {
      pickup: async () => ({ ok: true, delegations: [{ delegationId: "r", credential: refused, scope: [], exp: 1 }] }),
      sleep: async (ms) => { sleeps.push(ms); if (sleeps.length > 3) await new Promise(() => {}); },
    });
    await new Promise((r) => setTimeout(r, 300));
    expect(tokenCalls, "the refused VC was exchanged again and again").toBe(1);
    expect(sleeps[0], "the reconnect after a drop didn't wait an interval").toBe(60_000);
  });

  it("B2: an error between two 404s breaks the run", async () => {
    const { s, key } = await fresh();
    const answers: Array<PickupResult | Error> = [
      { ok: false, error: "no_pickup" }, new Error("502"), { ok: false, error: "no_pickup" },
      { ok: true, delegations: [{ delegationId: "d", credential: vc("b2"), scope: [], exp: 1 }] },
    ];
    const target: DaemonTarget = { alias: "m", targetMcpUrl: "https://rp/api/mcp", auth: null };
    const auth = await connectV1Target(target, s.load()!, { alias: "m", url: "https://rp", verifierUrl: "http://127.0.0.1:9" }, s, key, {
      pickup: async () => { const a = answers.shift()!; if (a instanceof Error) throw a; return a; }, sleep: async () => {},
    });
    closers.push(() => auth?.stop());
    expect(s.load()!.credentials?.["https://rp"], "404 → error → 404 parked pickup").toBe(vc("b2"));
  });

  it.each([Infinity, NaN, -5, 0, 1e9])("A2: interval %s never takes the poll below 60 s or above an hour", async (bad) => {
    const { s, key } = await fresh();
    const answers: PickupResult[] = [
      { ok: false, error: "slow_down", interval: bad },
      { ok: true, delegations: [{ delegationId: "d", credential: vc("a2"), scope: [], exp: 1 }] },
    ];
    const slept: number[] = [];
    const target: DaemonTarget = { alias: "m", targetMcpUrl: "https://rp/api/mcp", auth: null };
    const auth = await connectV1Target(target, s.load()!, { alias: "m", url: "https://rp", verifierUrl: "http://127.0.0.1:9" }, s, key, {
      pickup: async () => answers.shift()!, sleep: async (ms) => void slept.push(ms),
    });
    closers.push(() => auth?.stop());
    expect(slept[0]).toBeGreaterThanOrEqual(60_000);
    expect(slept[0]).toBeLessThanOrEqual(3_600_000);
  });

  it("21 dropped, still-live VCs are all remembered: none is re-adopted", async () => {
    const { vcDigest } = await import("../src/cli.js");
    const { s, key } = await fresh();
    const many = Array.from({ length: 21 }, (_, i) => vc("d" + i));
    s.save({ ...s.load()!, dropped: { "https://rp": many.map((c) => ({ digest: vcDigest(c), exp: null })) } });
    let pickups = 0;
    const target: DaemonTarget = { alias: "m", targetMcpUrl: "https://rp/api/mcp", auth: null };
    const run = connectV1Target(target, s.load()!, { alias: "m", url: "https://rp", verifierUrl: "http://127.0.0.1:9" }, s, key, {
      pickup: async () => { pickups++; return { ok: true, delegations: many.map((c, i) => ({ delegationId: "d" + i, credential: c, scope: [], exp: 1 })) }; },
      sleep: async () => { if (pickups >= 3) await new Promise(() => {}); },
    });
    void run;
    await new Promise((r) => setTimeout(r, 100));
    expect(s.load()!.credentials?.["https://rp"], "a dropped VC beyond a count cap was re-adopted").toBeUndefined();
  });
});

describe("metapass-saas's #51 follow-ups", () => {
  async function fresh() {
    const d = mkdtempSync(join(tmpdir(), "mpa-f2-"));
    closers.push(() => rmSync(d, { recursive: true, force: true }));
    const s = openStore({ backend: "file", keyFile: join(d, "key.json") });
    const key = await AgentKey.generate();
    s.save({ privateJwk: key.exportPrivateJwk() });
    return { s, key };
  }

  it("a store that can't be read at the drop still keeps the dropped VC from coming back", async () => {
    const { s, key } = await fresh();
    let tokenCalls = 0;
    const verifier = await server((req, _b, res) => {
      if (req.url === "/agent/nonce") return json(res, 200, { c_nonce: "n" });
      tokenCalls++;
      json(res, 400, { error: "invalid_delegation" });
    });
    const refused = vc("refused-unreadable-store");
    const data = { ...s.load()!, credentials: { "https://rp": refused } };
    const unreadable = { ...s, load: () => null, save: () => {} };
    const target: DaemonTarget = { alias: "m", targetMcpUrl: "https://rp/api/mcp", auth: null };
    let sleeps = 0;
    await connectV1Target(target, data, { alias: "m", url: "https://rp", verifierUrl: verifier }, unreadable, key, {
      pickup: async () => ({ ok: true, delegations: [{ delegationId: "r", credential: refused, scope: [], exp: 1 }] }),
      sleep: async () => { if (++sleeps > 4) await new Promise(() => {}); },
    });
    await new Promise((r) => setTimeout(r, 300));
    expect(tokenCalls, "with an unreadable store the dropped VC was exchanged again").toBe(1);
  });

  it("a pickup that throws waits the interval before the next try", async () => {
    const { s, key } = await fresh();
    const slept: number[] = [];
    const answers: Array<PickupResult | Error> = [new Error("ECONNRESET"),
      { ok: true, delegations: [{ delegationId: "d", credential: vc("after-throw"), scope: [], exp: 1 }] }];
    const target: DaemonTarget = { alias: "m", targetMcpUrl: "https://rp/api/mcp", auth: null };
    const auth = await connectV1Target(target, s.load()!, { alias: "m", url: "https://rp", verifierUrl: "http://127.0.0.1:9" }, s, key, {
      pickup: async () => { const a = answers.shift()!; if (a instanceof Error) throw a; return a; },
      sleep: async (ms) => void slept.push(ms),
    });
    closers.push(() => auth?.stop());
    expect(slept, "a thrown pickup retried without waiting").toEqual([60_000]);
  });

  it("an expired dropped VC is forgotten; never-expiring ones are capped", async () => {
    const { vcDigest, DROPPED_WITHOUT_EXP_KEPT } = await import("../src/cli.js");
    const { s, key } = await fresh();
    const past = Math.floor(Date.now() / 1000) - 10;
    const nulls = Array.from({ length: DROPPED_WITHOUT_EXP_KEPT + 5 }, (_, i) => ({ digest: "n" + i, exp: null }));
    s.save({ ...s.load()!, dropped: { "https://rp": [{ digest: "expired", exp: past }, ...nulls] } });
    let tokenCalls = 0;
    const verifier = await server((req, _b, res) => {
      if (req.url === "/agent/nonce") return json(res, 200, { c_nonce: "n" });
      tokenCalls++;
      json(res, 400, { error: "invalid_delegation" });
    });
    const refused = vc("newest");
    const target: DaemonTarget = { alias: "m", targetMcpUrl: "https://rp/api/mcp", auth: null };
    await connectV1Target(target, { ...s.load()!, credentials: { "https://rp": refused } },
      { alias: "m", url: "https://rp", verifierUrl: verifier }, s, key, {
        pickup: async () => ({ ok: false, error: "authorization_pending" }),
        sleep: async () => { await new Promise(() => {}); },
      });
    await new Promise((r) => setTimeout(r, 200));
    const kept = s.load()!.dropped!["https://rp"];
    expect(kept.some((d) => d.digest === "expired"), "an expired entry was kept").toBe(false);
    expect(kept.filter((d) => d.exp === null).length).toBeLessThanOrEqual(DROPPED_WITHOUT_EXP_KEPT);
    expect(kept.at(-1)?.digest, "the newest drop wasn't kept").toBe(vcDigest(refused));
    expect(tokenCalls).toBe(1);
  });
});
