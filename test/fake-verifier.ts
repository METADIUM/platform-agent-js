import { vi } from "vitest";
import { CompactSign, exportJWK, generateKeyPair } from "jose";

/**
 * Stubs global `fetch` as a verifier at https://sso.example.com that serves `GET /rp/<alias>` (spec §17) for
 * `resource`, and its did.json; `pair` answers the RP's pairing. Every other URL is a 404. Push the returned
 * `restore` into the test's cleanup.
 */
export async function fakeVerifier(alias: string, resource: string, pair?: (body: Record<string, unknown>) => Response) {
  const v1 = await generateKeyPair("ES256");
  const now = Math.floor(Date.now() / 1000);
  const jws = await new CompactSign(new TextEncoder().encode(JSON.stringify({
    iss: "did:web:sso.example.com", iat: now, exp: now + 300, alias, resource, protocol: "agent-delegation/1",
    pairing: "/agent/pair", pickup: "/agent/delegation/pickup", mcp: "/mcp", requireBodyHash: true,
  }))).setProtectedHeader({ alg: "ES256", typ: "delegation-rp-entry+jwt", kid: "did:web:sso.example.com#v1" }).sign(v1.privateKey);
  const didJson = { id: "did:web:sso.example.com", verificationMethod: [{ id: "#v1", publicKeyJwk: await exportJWK(v1.publicKey) }] };
  const pairs: Record<string, unknown>[] = [];
  const calls: string[] = [];
  vi.stubGlobal("fetch", (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    calls.push(u);
    if (u === `https://sso.example.com/rp/${alias}`) return new Response(jws, { status: 200 });
    if (u === "https://sso.example.com/.well-known/did.json") return Response.json(didJson);
    if (pair && u === resource + "/agent/pair") {
      const body = JSON.parse(Buffer.from(init!.body as Uint8Array).toString("utf8"));
      pairs.push(body);
      return pair(body);
    }
    return new Response("", { status: 404 });
  }) as typeof fetch);
  return { pairs, calls, restore: () => vi.unstubAllGlobals() };
}
