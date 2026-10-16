import { describe, it, expect } from "vitest";
import { CompactSign, decodeProtectedHeader, exportJWK, generateKeyPair, type KeyLike } from "jose";
import { AgentKey } from "../src/key.js";
import { fetchRpEntry, legUrl, pairV1, requireV1, RpEntryError, RP_ENTRY_TYP } from "../src/rp-entry.js";

const VERIFIER = "https://sso.example.com";
const VDID = "did:web:sso.example.com";
const RP = "https://minipaas.example.com/api"; // a resource with a path (minipaas)
const NOW = 1_800_000_000;

async function world(over: { header?: Record<string, unknown>; payload?: Record<string, unknown>; signer?: KeyLike } = {}) {
  const v1 = await generateKeyPair("ES256");
  const signer = over.signer ?? v1.privateKey;
  const payload = {
    iss: VDID, iat: NOW, exp: NOW + 300, alias: "minipaas", resource: RP, protocol: "agent-delegation/1",
    pairing: "/agent/register", pickup: "/agent/pickup", mcp: "/mcp", requireBodyHash: false, ...over.payload,
  };
  const jws = await new CompactSign(new TextEncoder().encode(JSON.stringify(payload)))
    .setProtectedHeader({ alg: "ES256", typ: RP_ENTRY_TYP, kid: `${VDID}#v1`, ...over.header } as never)
    .sign(signer);
  const didJson = { id: VDID, verificationMethod: [{ id: "#v1", publicKeyJwk: await exportJWK(v1.publicKey) }] };
  const seen: string[] = [];
  const fetchImpl = (async (url: string | URL) => {
    const u = String(url);
    seen.push(u);
    if (u === `${VERIFIER}/rp/minipaas`) return new Response(jws, { status: 200, headers: { "content-type": "application/jwt" } });
    if (u === `${VERIFIER}/.well-known/did.json`) return Response.json(didJson);
    return new Response("", { status: 404 });
  }) as typeof fetch;
  return { fetchImpl, seen };
}

const get = (w: { fetchImpl: typeof fetch }, rpUrl = RP) =>
  fetchRpEntry({ verifierUrl: VERIFIER + "/", alias: "minipaas", rpUrl, fetchImpl: w.fetchImpl, now: () => NOW });

describe("fetchRpEntry (spec §17)", () => {
  it("accepts the verifier-signed entry and keeps the resource's path", async () => {
    const e = await get(await world());
    expect(e).toEqual({ alias: "minipaas", resource: RP, protocol: "agent-delegation/1", pairing: "/agent/register",
      pickup: "/agent/pickup", mcp: "/mcp", requireBodyHash: false });
    expect(legUrl(e.resource, e.pickup!)).toBe("https://minipaas.example.com/api/agent/pickup");
    // The trap legUrl avoids: URL resolution drops /api and lands on the frontend (minipaas).
    expect(new URL(e.pickup!, e.resource).href).toBe("https://minipaas.example.com/agent/pickup");
  });

  it("accepts a trailing slash on what the user typed", async () => {
    await expect(get(await world(), RP + "/")).resolves.toMatchObject({ resource: RP });
  });

  it.each([
    ["another typ", { header: { typ: "delegation-revoke+jwt" } }, "typ"],
    ["a kid outside the verifier", { header: { kid: "did:web:evil.example#v1" } }, "kid"],
    ["another iss", { payload: { iss: "did:web:evil.example" } }, "iss"],
    ["another alias", { payload: { alias: "briefick" } }, "is for 'briefick'"],
    ["an expired entry", { payload: { exp: NOW } }, "expired"],
    ["an entry from the future", { payload: { iat: NOW + 120 } }, "future"],
    ["a resource other than the URL typed", { payload: { resource: "https://evil.example.com/api" } }, "registers"],
    ["a path that names another host", { payload: { pickup: "//evil.example.com/x" } }, "not a path"],
    ["a path that climbs out", { payload: { pairing: "/a/../admin" } }, "not a path"],
  ])("refuses %s", async (_n, over, msg) => {
    await expect(get(await world(over as never))).rejects.toThrow(msg);
  });

  it("refuses an entry signed by any key but the verifier's #v1 in did.json", async () => {
    const rogue = await generateKeyPair("ES256");
    await expect(get(await world({ signer: rogue.privateKey }))).rejects.toThrow("signature");
  });

  it("says plainly when the verifier doesn't know the RP", async () => {
    const w = await world();
    await expect(fetchRpEntry({ verifierUrl: VERIFIER, alias: "nosuch", rpUrl: RP, fetchImpl: w.fetchImpl, now: () => NOW }))
      .rejects.toThrow("not a registered RP");
  });
});

describe("requireV1", () => {
  it("refuses an RP that doesn't advertise /1", async () => {
    const e = await get(await world({ payload: { protocol: undefined } }));
    expect(() => requireV1(e)).toThrow("does not advertise");
  });

  it.each(["pairing", "pickup"])("refuses /1 without %s instead of falling back to a default path (Briefick)", async (k) => {
    const e = await get(await world({ payload: { [k]: undefined } }));
    expect(() => requireV1(e)).toThrow(`without ${k}`);
  });
});

describe("pairV1 (spec §7)", () => {
  async function rp(answer: (body: Record<string, unknown>) => Response) {
    const calls: { url: string; proof: string; body: Record<string, unknown> }[] = [];
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      const body = JSON.parse(Buffer.from(init!.body as Uint8Array).toString("utf8"));
      calls.push({ url: String(url), proof: (init!.headers as Record<string, string>)["agent-proof"], body });
      return answer(body);
    }) as typeof fetch;
    return { fetchImpl, calls };
  }

  it("posts the code with an Agent-Proof bound to resource + path, and checks the fingerprint", async () => {
    const key = await AgentKey.generate();
    const r = await rp(() => Response.json({ paired: true, agent_fingerprint: key.fingerprint }));
    await expect(pairV1({ resource: RP, path: "/agent/register", key, code: "C0DE1234", label: "host", version: "0.9.0",
      fetchImpl: r.fetchImpl })).resolves.toEqual({ fingerprint: key.fingerprint });
    expect(r.calls[0].url).toBe("https://minipaas.example.com/api/agent/register");
    expect(r.calls[0].body).toEqual({ code: "C0DE1234", label: "host", version: "0.9.0" });
    expect(decodeProtectedHeader(r.calls[0].proof).typ).toBe("agent-request+jwt");
    const htu = JSON.parse(Buffer.from(r.calls[0].proof.split(".")[1], "base64url").toString("utf8")).htu;
    expect(htu).toBe("https://minipaas.example.com/api/agent/register");
  });

  it("refuses when the RP paired a different fingerprint", async () => {
    const key = await AgentKey.generate();
    const r = await rp(() => Response.json({ paired: true, agent_fingerprint: "0000000000" }));
    await expect(pairV1({ resource: RP, path: "/agent/register", key, code: "C", fetchImpl: r.fetchImpl }))
      .rejects.toThrow(RpEntryError);
  });

  it("surfaces the RP's refusal", async () => {
    const key = await AgentKey.generate();
    const r = await rp(() => Response.json({ error: "paired_elsewhere", error_description: "another account" }, { status: 409 }));
    await expect(pairV1({ resource: RP, path: "/agent/register", key, code: "C", fetchImpl: r.fetchImpl }))
      .rejects.toThrow("paired_elsewhere: another account");
  });
});
