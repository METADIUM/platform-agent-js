import { describe, it, expect } from "vitest";
import { importJWK, jwtVerify, decodeProtectedHeader } from "jose";
import { AgentKey } from "../src/key.js";
import { presentVpToken, splitSdJwt, sha256Base64Url, verifierDidFromResponseUri } from "../src/present.js";

/** disclosure 만들기: base64url(JSON [salt, name, value]) */
function disclosure(name: string, value: unknown): string {
  return Buffer.from(JSON.stringify(["s4lt_" + name, name, value]), "utf8").toString("base64url");
}

describe("SD-JWT VC 제시 (platform-java 조립 규격)", () => {
  const issuerJwt = "eyJhbGciOiJFUzI1NiJ9.eyJ2Y3QiOiJ4In0.sig"; // 더미 발급 JWT(제시 조립만 검증)
  const dScope = disclosure("scope", ["log.worklog"]);
  const dCons = disclosure("constraints", { maxHoursPerDay: 8 });
  const vc = `${issuerJwt}~${dScope}~${dCons}~`;

  it("split — 발급JWT + disclosure(트레일링 ~ 제거)", () => {
    const { issuerJwt: j, disclosures } = splitSdJwt(vc);
    expect(j).toBe(issuerJwt);
    expect(disclosures).toEqual([dScope, dCons]);
  });

  it("vp_token = core(+트레일링 ~) + KB-JWT, sd_hash = SHA-256(core)", async () => {
    const key = await AgentKey.generate();
    const vp = await presentVpToken(vc, key, { audience: "did:web:sso.cplabs.io", nonce: "n0nce" });

    const last = vp.lastIndexOf("~");
    const core = vp.slice(0, last + 1); // platform-java VerifierCore와 동일한 분리
    const kb = vp.slice(last + 1);
    expect(core).toBe(`${issuerJwt}~${dScope}~${dCons}~`);

    // KB-JWT: typ=kb+jwt, sd_hash == SHA-256(core), aud/nonce
    expect(decodeProtectedHeader(kb).typ).toBe("kb+jwt");
    const pub = await importJWK(key.publicJwk, "ES256");
    const { payload } = await jwtVerify(kb, pub, { audience: "did:web:sso.cplabs.io" });
    expect(payload.nonce).toBe("n0nce");
    expect(payload.sd_hash).toBe(sha256Base64Url(core));
  });

  it("선택 공개 — disclose 필터", async () => {
    const key = await AgentKey.generate();
    const vp = await presentVpToken(vc, key, {
      audience: "aud",
      nonce: "n",
      disclose: ["scope"],
    });
    expect(vp.includes(dScope)).toBe(true);
    expect(vp.includes(dCons)).toBe(false); // constraints 미공개
  });

  it("responseUri → 검증자 did:web", () => {
    expect(verifierDidFromResponseUri("https://sso.cplabs.io/response")).toBe("did:web:sso.cplabs.io");
    expect(verifierDidFromResponseUri("https://localhost:8080/response")).toBe("did:web:localhost%3A8080");
  });
});
