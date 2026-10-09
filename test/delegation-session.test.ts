/** The `/1` call path: session token upkeep (spec §9.1) and the per-call request proof (§10, §11). */
import http from "node:http";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { decodeJwt, decodeProtectedHeader, importJWK, jwtVerify } from "jose";
import { AgentKey } from "../src/key.js";
import { BACKOFF_MAX_MS, DelegationSessionAuth, REFRESH_AHEAD_MS, SessionUnavailable } from "../src/delegation-session.js";
import { SessionExchangeError, type SessionToken } from "../src/session.js";
import { startDaemon, type RunningDaemon } from "../src/daemon.js";

const sha = (b: Uint8Array | string) => createHash("sha256").update(b).digest("base64url");

function clock(start = 1_700_000_000_000) {
  let now = start;
  const scheduled: number[] = [];
  let pending: (() => void) | undefined;
  return {
    now: () => now,
    advance: (ms: number) => (now += ms),
    scheduled,
    schedule: (ms: number, fn: () => void) => {
      scheduled.push(ms);
      pending = fn;
      return () => (pending = undefined);
    },
    fire: async () => {
      const f = pending;
      pending = undefined;
      f?.();
      await new Promise((r) => setImmediate(r));
    },
  };
}

const token = (c: { now(): number }, seconds: number, value = "header.payload.sig"): SessionToken => ({
  accessToken: value,
  expiresIn: seconds,
  expiresAt: new Date(c.now() + seconds * 1000),
});

describe("DelegationSessionAuth", () => {
  it("signs each call with htm, htu, ath over the token and bh over the exact body", async () => {
    const key = await AgentKey.generate();
    const c = clock();
    const s = new DelegationSessionAuth({ key, verifier: "https://sso.example", exchange: async () => token(c, 300), now: c.now, schedule: c.schedule });
    await s.start();
    const body = Buffer.from('{"jsonrpc":"2.0","method":"tools/call"}');
    const h = await s.callHeaders("POST", "https://rp.example/api/mcp", body);
    expect(h.authorization).toBe("Delegation header.payload.sig");
    const proof = h["agent-proof"];
    await jwtVerify(proof, await importJWK(key.publicJwk, "ES256"));
    expect(decodeProtectedHeader(proof)).toMatchObject({ typ: "agent-request+jwt", kid: key.did + "#0" });
    const p = decodeJwt(proof);
    expect(p).toMatchObject({ htm: "POST", htu: "https://rp.example/api/mcp", ath: sha("header.payload.sig"), bh: sha(body) });
    expect(p.iat).toBe(Math.floor(c.now() / 1000));
    expect(decodeJwt((await s.callHeaders("GET", "https://rp.example/api/mcp", new Uint8Array()))["agent-proof"]).bh,
      "a request without a body carries no bh").toBeUndefined();
  });

  it("refreshes 60 s before exp", async () => {
    const c = clock();
    const s = new DelegationSessionAuth({ key: await AgentKey.generate(), verifier: "v", exchange: async () => token(c, 300), now: c.now, schedule: c.schedule });
    await s.start();
    expect(c.scheduled).toEqual([300_000 - REFRESH_AHEAD_MS]);
  });

  it("a token capped under 60 s refreshes once, then stops when exp can't move (no spin in the last minute)", async () => {
    const c = clock();
    const capped = new Date(c.now() + 30_000);
    let exchanges = 0;
    const s = new DelegationSessionAuth({
      key: await AgentKey.generate(), verifier: "v", now: c.now, schedule: c.schedule,
      exchange: async () => { exchanges++; return { accessToken: "a.b.c", expiresIn: 30, expiresAt: capped }; },
    });
    await s.start();
    expect(c.scheduled).toEqual([15_000]);
    await c.fire();
    await c.fire();
    expect(exchanges, "the refresh kept exchanging a token it can't extend").toBe(2);
    expect(c.scheduled).toEqual([15_000]);
  });

  it("backs off 1, 2, 4 … s up to 30 s while the verifier is down, and keeps retrying", async () => {
    const c = clock();
    let fail = false;
    const s = new DelegationSessionAuth({
      key: await AgentKey.generate(), verifier: "v", now: c.now, schedule: c.schedule,
      exchange: async () => {
        if (fail) throw new SessionExchangeError(503, "temporarily_unavailable", []);
        return token(c, 300);
      },
    });
    await s.start();
    fail = true;
    for (let i = 0; i < 7; i++) await c.fire();
    expect(c.scheduled.slice(1)).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, BACKOFF_MAX_MS, BACKOFF_MAX_MS]);
    expect(s.state().status).toBe("retrying");
  });

  it("uses the token until exp and never past it", async () => {
    const c = clock();
    const s = new DelegationSessionAuth({ key: await AgentKey.generate(), verifier: "https://sso.example", exchange: async () => token(c, 300), now: c.now, schedule: c.schedule });
    await s.start();
    c.advance(299_000);
    await s.callHeaders("POST", "https://rp.example/mcp", new Uint8Array());
    c.advance(1_000);
    const e = await s.callHeaders("POST", "https://rp.example/mcp", new Uint8Array()).catch((x) => x);
    expect(e).toBeInstanceOf(SessionUnavailable);
    expect((e as SessionUnavailable).error).toBe("verifier_unreachable");
    expect((e as Error).message).toContain("https://sso.example");
  });

  it("stops on invalid_delegation, the only terminal answer (§9)", async () => {
    const c = clock();
    const s = new DelegationSessionAuth({
      key: await AgentKey.generate(), verifier: "v", now: c.now, schedule: c.schedule,
      exchange: async () => { throw new SessionExchangeError(400, "invalid_delegation", ["revoked"]); },
    });
    await s.start();
    expect(s.state().status).toBe("dropped");
    expect(c.scheduled, "a dropped delegation was retried").toEqual([]);
    const e = await s.callHeaders("POST", "https://rp.example/mcp", new Uint8Array()).catch((x) => x);
    expect((e as SessionUnavailable).error).toBe("delegation_dropped");
  });

  it("applies the clock offset to iat", async () => {
    const c = clock();
    const s = new DelegationSessionAuth({ key: await AgentKey.generate(), verifier: "v", exchange: async () => token(c, 300), now: c.now, schedule: c.schedule });
    await s.start();
    s.setClockOffset(120);
    const p = decodeJwt((await s.callHeaders("POST", "https://rp.example/mcp", new Uint8Array()))["agent-proof"]);
    expect(p.iat).toBe(Math.floor(c.now() / 1000) + 120);
  });
});

describe("daemon with a /1 target", () => {
  let daemon: RunningDaemon | undefined;
  const closers: Array<() => void> = [];
  afterEach(async () => {
    await daemon?.close();
    daemon = undefined;
    for (const f of closers.splice(0)) f();
  });

  type Seen = { authorization?: string; proof?: string; url?: string };
  function rp(answer: (n: number) => { status: number; headers?: Record<string, string> }) {
    const seen: Seen[] = [];
    return new Promise<{ url: string; seen: Seen[] }>((resolve) => {
      const server = http.createServer((req, res) => {
        seen.push({ authorization: req.headers.authorization, proof: req.headers["agent-proof"] as string, url: req.url });
        req.resume();
        const a = answer(seen.length);
        res.writeHead(a.status, { "content-type": "application/json", ...a.headers });
        res.end("{}");
      });
      server.listen(0, "127.0.0.1", () => {
        closers.push(() => server.close());
        resolve({ url: `http://127.0.0.1:${(server.address() as { port: number }).port}/api/mcp`, seen });
      });
    });
  }

  async function session() {
    const s = new DelegationSessionAuth({
      key: await AgentKey.generate(), verifier: "v",
      exchange: async () => ({ accessToken: "a.b.c", expiresIn: 300, expiresAt: new Date(Date.now() + 300_000) }),
    });
    await s.start();
    closers.push(() => s.stop());
    return s;
  }

  async function post(path: string, headers: Record<string, string> = {}) {
    const r = await fetch(`http://127.0.0.1:${daemon!.port}${path}`, {
      method: "POST", headers: { authorization: "Bearer t", "content-type": "application/json", ...headers },
      body: '{"method":"tools/list"}',
    });
    return { status: r.status, body: await r.json() };
  }

  it("sends the session token and a proof whose htu is the public URL without the query; drops a client's own proof", async () => {
    const up = await rp(() => ({ status: 200 }));
    daemon = await startDaemon({ targets: [{ alias: "a", targetMcpUrl: up.url + "?x=1", auth: await session() }], token: "t" });
    const r = await post("/mcp", { "agent-proof": "forged" });
    expect(r.status).toBe(200);
    expect(up.seen[0].authorization).toBe("Delegation a.b.c");
    expect(up.seen[0].proof).not.toBe("forged");
    expect(decodeJwt(up.seen[0].proof!)).toMatchObject({ htm: "POST", htu: up.url, ath: sha("a.b.c"), bh: sha('{"method":"tools/list"}') });
  });

  it("retries once on use_fresh_time with the RP's Date, and not twice", async () => {
    const ahead = new Date(Date.now() + 120_000).toUTCString();
    const fresh = { status: 401, headers: { "www-authenticate": 'Delegation error="use_fresh_time"', date: ahead } };
    const up = await rp(() => fresh);
    daemon = await startDaemon({ targets: [{ alias: "a", targetMcpUrl: up.url, auth: await session() }], token: "t" });
    const r = await post("/mcp");
    expect(r.status).toBe(401);
    expect(up.seen.length, "use_fresh_time was retried more than once").toBe(2);
    const iat0 = decodeJwt(up.seen[0].proof!).iat!;
    const iat1 = decodeJwt(up.seen[1].proof!).iat!;
    expect(Math.abs(iat1 - iat0 - 120)).toBeLessThanOrEqual(2);
  });

  it("answers 503 locally when no token is usable", async () => {
    const up = await rp(() => ({ status: 200 }));
    const s = new DelegationSessionAuth({
      key: await AgentKey.generate(), verifier: "https://sso.example",
      exchange: async () => { throw new SessionExchangeError(400, "invalid_delegation", []); },
    });
    await s.start();
    daemon = await startDaemon({ targets: [{ alias: "a", targetMcpUrl: up.url, auth: s }], token: "t" });
    const r = await post("/mcp");
    expect(r.status).toBe(503);
    expect(r.body).toMatchObject({ error: "delegation_dropped", alias: "a" });
    expect(up.seen.length).toBe(0);
  });
});
