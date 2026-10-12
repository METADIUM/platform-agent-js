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

  /** A refusal while an exchange is in flight stays: the late answer doesn't bring the session back (metapass-saas). */
  it("stays dropped when an exchange in flight answers after a refusal", async () => {
    const c = clock();
    let release!: (t: SessionToken) => void;
    let calls = 0;
    const s = new DelegationSessionAuth({
      key: await AgentKey.generate(), verifier: "v", now: c.now, schedule: c.schedule,
      exchange: () => (++calls === 1 ? Promise.resolve(token(c, 300)) : new Promise<SessionToken>((r) => (release = r))),
    });
    await s.start();
    await c.fire();   // the scheduled refresh starts and waits on its exchange
    s.refused("drop", "constraints_missing", []);
    release(token(c, 300));
    await new Promise((r) => setImmediate(r));
    expect(s.state(), "an in-flight refresh revived a refused session").toMatchObject({ status: "dropped" });
    await expect(s.callHeaders("POST", "https://rp.example/api/mcp", new Uint8Array())).rejects.toMatchObject({ error: "delegation_dropped" });
  });

  /** After a refusal no refresh is scheduled: the session stops talking to the verifier. */
  it("cancels the refresh timer on a refusal", async () => {
    const c = clock();
    let calls = 0;
    const s = new DelegationSessionAuth({ key: await AgentKey.generate(), verifier: "v", now: c.now, schedule: c.schedule,
      exchange: async () => (calls++, token(c, 300)) });
    await s.start();
    s.refused("keep", "constraints_unknown_key", ["k"]);
    await c.fire();
    expect(calls, "a held session kept exchanging").toBe(1);
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
    expect(s.state().status).toBe("ending");
    c.advance(30_000);
    const e = await s.callHeaders("POST", "https://rp.example/mcp", new Uint8Array()).catch((x) => x);
    expect((e as SessionUnavailable).error, "past the cap the user was told it was retrying").toBe("delegation_ended");
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
  function rp(answer: (n: number) => { status: number; headers?: Record<string, string>; body?: string }) {
    const seen: Seen[] = [];
    return new Promise<{ url: string; seen: Seen[] }>((resolve) => {
      const server = http.createServer((req, res) => {
        seen.push({ authorization: req.headers.authorization, proof: req.headers["agent-proof"] as string, url: req.url });
        req.resume();
        const a = answer(seen.length);
        res.writeHead(a.status, { "content-type": "application/json", ...a.headers });
        res.end(a.body ?? "{}");
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

  const denied = (reason: string, keys?: string[]) =>
    ({ status: 403, body: JSON.stringify({ error: "constraint_denied", reason, ...(keys ? { keys } : {}) }) });

  /** §10/§11.1: missing, malformed and not_atomic make the VC unusable; the refusal reaches the client unchanged. */
  it.each(["constraints_missing", "constraints_malformed", "constraints_not_atomic"])(
    "drops the delegation on a 403 constraint_denied %s, and stops calling the RP", async (reason) => {
      const up = await rp(() => denied(reason));
      const s = await session();
      daemon = await startDaemon({ targets: [{ alias: "a", targetMcpUrl: up.url, auth: s }], token: "t" });
      const first = await post("/mcp");
      expect(first.status).toBe(403);
      expect(first.body, "the RP's refusal wasn't passed through").toMatchObject({ error: "constraint_denied", reason });
      expect(s.state()).toMatchObject({ status: "dropped" });
      const second = await post("/mcp");
      expect(second.status).toBe(503);
      expect(second.body).toMatchObject({ error: "delegation_dropped" });
      expect(up.seen.length, "a dropped delegation was presented again").toBe(1);
    });

  /** §11.1 keep: the RP lags the vct version; the VC stays, but isn't presented again, and the keys are named. */
  it("holds the delegation on constraints_unknown_key and names the keys", async () => {
    const up = await rp(() => denied("constraints_unknown_key", ["maxAmount"]));
    const s = await session();
    daemon = await startDaemon({ targets: [{ alias: "a", targetMcpUrl: up.url, auth: s }], token: "t" });
    expect((await post("/mcp")).status).toBe(403);
    expect(s.state()).toEqual({ status: "held", reason: "constraints_unknown_key", keys: ["maxAmount"] });
    const second = await post("/mcp");
    expect(second.status).toBe(503);
    expect(second.body).toMatchObject({ error: "delegation_held" });
    expect(String(second.body.message)).toContain("maxAmount");
    expect(up.seen.length).toBe(1);
  });

  /** A body past the read cap still reaches the client whole; only the reading stops (Briefick). */
  it("passes a 403 body over 64 KiB through whole, without acting on it", async () => {
    const big = JSON.stringify({ error: "constraint_denied", reason: "constraints_missing", pad: "x".repeat(64 * 1024) });
    const up = await rp(() => ({ status: 403, body: big }));
    const s = await session();
    daemon = await startDaemon({ targets: [{ alias: "a", targetMcpUrl: up.url, auth: s }], token: "t" });
    const r = await fetch(`http://127.0.0.1:${daemon.port}/mcp`, { method: "POST", headers: { authorization: "Bearer t" }, body: "{}" });
    expect(r.status).toBe(403);
    expect((await r.text()).length, "the body was truncated").toBe(big.length);
    expect(s.state(), "a body past the read cap was acted on").toMatchObject({ status: "active" });
  });

  it("names how many keys there were when keys is capped (keysTotal)", async () => {
    const up = await rp(() => ({ status: 403, body: JSON.stringify({ error: "constraint_denied", reason: "constraints_unknown_key", keys: ["a", "b"], keysTotal: 5 }) }));
    const s = await session();
    daemon = await startDaemon({ targets: [{ alias: "a", targetMcpUrl: up.url, auth: s }], token: "t" });
    await post("/mcp");
    const second = await post("/mcp");
    expect(String(second.body.message)).toContain("a,b and 3 more");
  });

  it("asks a /1 RP for an identity body, so a 403 can be read", async () => {
    const seen: (string | undefined)[] = [];
    const server = http.createServer((req, res) => { seen.push(req.headers["accept-encoding"] as string | undefined); req.resume(); res.end("{}"); });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    closers.push(() => server.close());
    daemon = await startDaemon({ targets: [{ alias: "a", targetMcpUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/api/mcp`,
      auth: await session() }], token: "t" });
    await fetch(`http://127.0.0.1:${daemon.port}/mcp`, { method: "POST", headers: { authorization: "Bearer t", "accept-encoding": "gzip" }, body: "{}" });
    expect(seen[0], "the client's accept-encoding reached the /1 RP").toBeUndefined();
  });

  /** Only constraint_denied with a §11.1 code acts; other refusals keep the session (§10 insufficient_scope etc.). */
  it.each([
    ["insufficient_scope", JSON.stringify({ error: "insufficient_scope" })],
    ["an unknown reason", JSON.stringify({ error: "constraint_denied", reason: "something_else" })],
    ["a non-JSON body", "forbidden"],
  ])("leaves the session alone on a 403 with %s", async (_label, body) => {
    const up = await rp(() => ({ status: 403, body }));
    const s = await session();
    daemon = await startDaemon({ targets: [{ alias: "a", targetMcpUrl: up.url, auth: s }], token: "t" });
    const r = await fetch(`http://127.0.0.1:${daemon.port}/mcp`, { method: "POST", headers: { authorization: "Bearer t" }, body: "{}" });
    expect(r.status).toBe(403);
    expect(await r.text(), "the body wasn't passed through unchanged").toBe(body);
    expect(s.state()).toMatchObject({ status: "active" });
    await fetch(`http://127.0.0.1:${daemon.port}/mcp`, { method: "POST", headers: { authorization: "Bearer t" }, body: "{}" });
    expect(up.seen.length, "the session stopped on a refusal it shouldn't act on").toBe(2);
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
