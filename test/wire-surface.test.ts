import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { CompactSign, exportJWK, generateKeyPair } from "jose";
import { WIRE_SURFACE, AGENT_COMPAT, AGENT_COMPAT_CLASSES, type WireRequest } from "../src/wire-surface.js";
import { AgentKey } from "../src/key.js";
import { fetchRpEntry, pairV1 } from "../src/rp-entry.js";
import { pickup } from "../src/pickup.js";
import { exchangeSessionToken } from "../src/session.js";
import { DelegationSessionAuth } from "../src/delegation-session.js";

const VERIFIER = "https://sso.example.com";
const RP = "https://rp.example.com/api";

/** Which declared row a URL is. A URL with no row fails the test: an undeclared request. */
function rowOf(url: string): string {
  const routes: Record<string, string> = {
    [`${VERIFIER}/rp/rp`]: "rpEntry",
    [`${VERIFIER}/.well-known/did.json`]: "verifierDidJson",
    [`${RP}/agent/pair`]: "pairing",
    [`${RP}/agent/pickup`]: "pickup",
    [`${VERIFIER}/agent/nonce`]: "sessionNonce",
    [`${VERIFIER}/agent/token`]: "sessionToken",
  };
  return routes[url] ?? `undeclared ${url}`;
}

/** The receiver class is the host the request actually went to: the verifier's or the RP's. */
const receiverOf = (url: string): WireRequest["receiver"] => (new URL(url).origin === new URL(VERIFIER).origin ? "verifier" : "rp");

function shape(init: RequestInit | undefined, url: string): WireRequest {
  const raw = init?.body;
  const body = raw === undefined || raw === null
    ? null
    : Object.keys(JSON.parse(Buffer.from(raw as Uint8Array).toString("utf8")) as object).sort();
  const headers = Object.keys((init?.headers ?? {}) as Record<string, string>).map((h) => h.toLowerCase()).sort();
  return { receiver: receiverOf(url), method: (init?.method ?? "GET") as WireRequest["method"], body, headers };
}

/** Drives every `/1` request this CLI sends through one recording `fetch`; returns what each receiver saw. */
async function drive(opts: { label?: string; version?: string }): Promise<Record<string, WireRequest>> {
  const key = await AgentKey.generate();
  const v1 = await generateKeyPair("ES256");
  const now = Math.floor(Date.now() / 1000);
  const entry = await new CompactSign(new TextEncoder().encode(JSON.stringify({
    iss: "did:web:sso.example.com", iat: now, exp: now + 300, alias: "rp", resource: RP, protocol: "agent-delegation/1",
    pairing: "/agent/pair", pickup: "/agent/pickup", requireBodyHash: true,
  }))).setProtectedHeader({ alg: "ES256", typ: "delegation-rp-entry+jwt", kid: "did:web:sso.example.com#v1" }).sign(v1.privateKey);
  const didJson = { id: "did:web:sso.example.com", verificationMethod: [{ id: "#v1", publicKeyJwk: await exportJWK(v1.publicKey) }] };
  const replies: Record<string, () => Response> = {
    rpEntry: () => new Response(entry),
    verifierDidJson: () => Response.json(didJson),
    pairing: () => Response.json({ paired: true, agent_fingerprint: key.fingerprint }),
    pickup: () => Response.json({ delegations: [] }),
    sessionNonce: () => Response.json({ c_nonce: "n" }),
    sessionToken: () => Response.json({ access_token: "a.b.c", expires_in: 300 }),
  };

  const seen: Record<string, WireRequest> = {};
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const row = rowOf(String(url));
    seen[row] = shape(init, String(url));
    return (replies[row] ?? (() => new Response("", { status: 404 })))();
  }) as typeof fetch;

  await fetchRpEntry({ verifierUrl: VERIFIER, alias: "rp", rpUrl: RP, fetchImpl });
  await pairV1({ resource: RP, path: "/agent/pair", key, code: "C0DE1234", ...opts, fetchImpl });
  await pickup({ url: RP, path: "/agent/pickup", key, version: opts.version, fetchImpl });
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const vc = `${b64({ alg: "ES256", typ: "dc+sd-jwt" })}.${b64({ iss: "did:jwk:x", _sd: [] })}.sig~`;
  const token = await exchangeSessionToken({ verifierUrl: VERIFIER, vc, rp: "rp", key, fetchImpl });

  // The forwarded MCP call: method and body are the MCP client's, so only the headers this CLI adds are recorded.
  const auth = new DelegationSessionAuth({ key, verifier: VERIFIER, exchange: async () => token });
  await auth.start();
  const headers = await auth.callHeaders("POST", RP + "/mcp", Buffer.from("{}"));
  auth.stop();
  seen.mcpCall = { receiver: receiverOf(RP + "/mcp"), method: "forwarded", body: "forwarded", headers: Object.keys(headers).map((h) => h.toLowerCase()).sort() };
  return seen;
}

describe("the wire surface this release declares", () => {
  it("🔴 package.json's agentCompat is present and is one of the declared classes", () => {
    // The release workflow refuses without it. Asserted here too so the failure is local and
    // immediate rather than only at tag time, when it is most expensive.
    const pkg = JSON.parse(readFileSync(join(import.meta.dirname, "..", "package.json"), "utf8"));
    expect(pkg.agentCompat, "package.json has no agentCompat — which class is this release?").toBeDefined();
    expect(AGENT_COMPAT_CLASSES, `agentCompat "${pkg.agentCompat}" is not a declared class`).toContain(pkg.agentCompat);
  });

  it("🔴 the two classes that can silently drop a field are the ones the gate holds back", () => {
    // The release workflow reads `releaseAfterReceiverConfirmed` off this table and refuses a
    // release in those classes unless the notes name the receiver that was confirmed first.
    const gated = AGENT_COMPAT_CLASSES.filter((c) => AGENT_COMPAT[c].releaseAfterReceiverConfirmed);
    expect(gated, "a class that reorders a deploy is not gated").toEqual(["receiver-first", "breaking"]);

    const coexist = AGENT_COMPAT_CLASSES.filter((c) => AGENT_COMPAT[c].coexists);
    expect(coexist, "breaking is the only class an older agent cannot survive").toEqual([
      "local",
      "additive",
      "receiver-first",
    ]);
  });

  it("🔴 every request the client sends, and every field in it, matches WIRE_SURFACE", async () => {
    // Adding, removing or renaming a request, a body field or a header fails here — and that failure is
    // the moment someone has to decide the release's `agentCompat`.
    const seen = await drive({ label: "host-1", version: "0.0.0" });
    expect(Object.keys(seen).sort(), "a request was sent that WIRE_SURFACE doesn't declare, or one declared wasn't sent")
      .toEqual(Object.keys(WIRE_SURFACE).sort());
    for (const [row, declared] of Object.entries(WIRE_SURFACE)) {
      expect(seen[row], `${row} moved`).toEqual(declared);
    }
  });

  it("🔴 every receiver of a declared request is a release-gate receiver (metapass-saas on #67)", async () => {
    const { readFileSync } = await import("node:fs");
    const { RECEIVERS_BY_CLASS } = await import("../src/wire-surface.js");
    const listed: string[] = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).agentCompatReceivers ?? [];
    for (const [row, req] of Object.entries(WIRE_SURFACE)) {
      for (const name of RECEIVERS_BY_CLASS[req.receiver]) {
        expect(listed, `${row} is received by the ${req.receiver} '${name}', which the release gate doesn't require a line for`).toContain(name);
      }
    }
  });

  it("label and version are omitted, not sent empty, when unknown", async () => {
    const seen = await drive({});
    expect(seen.pairing.body).toEqual(["code"]);
    expect(seen.pickup.body).toEqual([]);
  });
});
