import { describe, it, expect, afterEach } from "vitest";
import http from "node:http";
import { createHash } from "node:crypto";
import { decodeProtectedHeader, decodeJwt, jwtVerify, importJWK } from "jose";
import { AgentKey } from "../src/key.js";
import { exchangeSessionToken, SessionExchangeError } from "../src/session.js";

/** spec agent-delegation §11: the request proof, wire-compatible with platform-java AgentRequestProof. */
describe("requestProof", () => {
  it("has the §11 header and binds the body and the token", async () => {
    const key = await AgentKey.generate();
    const body = Buffer.from('{"rp":"paas"}', "utf8");
    const token = "eyJ0eXAiOiJkZWxlZ2F0aW9uLXNlc3Npb24rand0In0.e30.sig";
    const proof = await key.requestProof("POST", "https://sso.example.com/agent/token", { body, sessionToken: token, jti: "j1", iat: 1_800_000_000 });
    expect(decodeProtectedHeader(proof)).toEqual({ typ: "agent-request+jwt", alg: "ES256", kid: key.did + "#0" });
    const p = decodeJwt(proof);
    expect(p).toEqual({
      htm: "POST",
      htu: "https://sso.example.com/agent/token",
      iat: 1_800_000_000,
      jti: "j1",
      ath: createHash("sha256").update(Buffer.from(token, "ascii")).digest("base64url"),
      bh: createHash("sha256").update(body).digest("base64url"),
    });
    await jwtVerify(proof, await importJWK(key.publicJwk, "ES256"));
  });

  it("omits ath and bh when there is no token or body", async () => {
    const key = await AgentKey.generate();
    const p = decodeJwt(await key.requestProof("GET", "https://rp.example.com/mcp"));
    expect(p.ath).toBeUndefined();
    expect(p.bh).toBeUndefined();
    expect(typeof p.jti).toBe("string");
  });
});

interface Hit { path: string; headers: http.IncomingHttpHeaders; body: Buffer }

async function verifierStub(tokenAnswer: (h: Hit) => [number, unknown]) {
  const hits: Hit[] = [];
  const srv = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const hit = { path: req.url ?? "", headers: req.headers, body: Buffer.concat(chunks) };
      hits.push(hit);
      const [status, json] = hit.path === "/agent/nonce" ? [200, { c_nonce: "n-1", expires_in: 60 }] : tokenAnswer(hit);
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(json));
    });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  const port = (srv.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}`, hits, close: () => new Promise<void>((r) => srv.close(() => r())) };
}

/** A minimal SD-JWT VC: an issuer JWT and one disclosure. The stub doesn't verify it; this tests the client. */
function vc(): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "ES256", typ: "dc+sd-jwt" })}.${b64({ iss: "did:jwk:x", _sd: [] })}.sig~${b64(["s", "note", "x"])}~`;
}

const stubs: { close: () => Promise<void> }[] = [];
afterEach(async () => {
  for (const s of stubs.splice(0)) await s.close();
});

describe("exchangeSessionToken (§9)", () => {
  it("presents with the c_nonce and proves over the exact bytes it sends", async () => {
    const key = await AgentKey.generate();
    const s = await verifierStub(() => [200, { access_token: "tok", expires_in: 300 }]);
    stubs.push(s);
    const t = await exchangeSessionToken({ verifierUrl: s.url, verifierDid: "did:web:sso.example.com", vc: vc(), rp: "paas", key });
    expect(t.accessToken).toBe("tok");
    expect(t.expiresIn).toBe(300);
    expect(s.hits.map((h) => h.path)).toEqual(["/agent/nonce", "/agent/token"]);
    const tokenHit = s.hits[1];
    const sent = JSON.parse(tokenHit.body.toString("utf8"));
    expect(sent.rp).toBe("paas");
    const kb = sent.vp_token.slice(sent.vp_token.lastIndexOf("~") + 1);
    expect(decodeJwt(kb)).toMatchObject({ aud: "did:web:sso.example.com", nonce: "n-1" });
    const proof = decodeJwt(tokenHit.headers["agent-proof"] as string);
    expect(proof.htm).toBe("POST");
    expect(proof.htu).toBe(s.url + "/agent/token");
    expect(proof.bh).toBe(createHash("sha256").update(tokenHit.body).digest("base64url"));
    expect(proof.ath).toBeUndefined();
    expect(tokenHit.headers["content-encoding"]).toBeUndefined();
  });

  it("tells a dropped VC from a retry", async () => {
    const key = await AgentKey.generate();
    for (const [status, error, drop] of [
      [400, "invalid_delegation", true],
      [400, "invalid_nonce", false],
      [401, "invalid_proof", false],
      [503, "temporarily_unavailable", false],
    ] as const) {
      const s = await verifierStub(() => [status, { error, reasons: ["r"] }]);
      stubs.push(s);
      const e = await exchangeSessionToken({ verifierUrl: s.url, vc: vc(), rp: "paas", key }).catch((x) => x);
      expect(e).toBeInstanceOf(SessionExchangeError);
      expect([e.status, e.error, e.dropVc]).toEqual([status, error, drop]);
    }
  });
});
