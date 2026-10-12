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
