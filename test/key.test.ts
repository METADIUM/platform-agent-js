import { describe, it, expect } from "vitest";
import { importJWK, jwtVerify } from "jose";
import { createHash } from "node:crypto";
import { AgentKey, didJwkFromPublicJwk, publicJwkFromDidJwk, didFingerprint } from "../src/key.js";

describe("did:jwk (ES256/P-256)", () => {
  it("생성·라운드트립·정준 키순서(crv,kty,x,y)", async () => {
    const key = await AgentKey.generate();
    expect(key.did.startsWith("did:jwk:")).toBe(true);

    const back = publicJwkFromDidJwk(key.did);
    expect(back.x).toBe(key.publicJwk.x);
    expect(back.y).toBe(key.publicJwk.y);
    expect(back.crv).toBe("P-256");

    // did:jwk 안 JSON은 crv,kty,x,y 순 (platform-java DidJwk.jwkMap 정준 순서)
    const json = Buffer.from(key.did.slice("did:jwk:".length), "base64url").toString("utf8");
    expect(json).toBe(
      JSON.stringify({ crv: "P-256", kty: "EC", x: key.publicJwk.x, y: key.publicJwk.y }),
    );
    expect(Object.keys(JSON.parse(json))).toEqual(["crv", "kty", "x", "y"]);
  });

  it("개인 JWK 복원 시 같은 did:jwk", async () => {
    const k1 = await AgentKey.generate();
    const k2 = await AgentKey.fromPrivateJwk(k1.exportPrivateJwk());
    expect(k2.did).toBe(k1.did);
  });

  it("PoP JWT — aud·iat·code, 공개키로 검증됨", async () => {
    const key = await AgentKey.generate();
    const pop = await key.popJwt("briefick-agent-register", { code: "ABCD2345" });
    const pub = await importJWK(key.publicJwk, "ES256");
    const { payload, protectedHeader } = await jwtVerify(pop, pub, {
      audience: "briefick-agent-register",
    });
    expect(protectedHeader.alg).toBe("ES256");
    expect(payload.code).toBe("ABCD2345");
    expect(typeof payload.iat).toBe("number");
  });

  it("지문 = sha256(did) hex 앞 10자리 (/publish 표시와 동일)", async () => {
    const key = await AgentKey.generate();
    const expected = createHash("sha256").update(key.did, "utf8").digest("hex").slice(0, 10);
    expect(key.fingerprint).toBe(expected);
    expect(didFingerprint(key.did)).toBe(expected);
    expect(key.fingerprint).toMatch(/^[0-9a-f]{10}$/);
    // 복원해도 같은 지문
    const k2 = await AgentKey.fromPrivateJwk(key.exportPrivateJwk());
    expect(k2.fingerprint).toBe(key.fingerprint);
  });

  it("EC(P-256) 아닌 키는 거부", () => {
    expect(() => didJwkFromPublicJwk({ kty: "OKP", crv: "Ed25519", x: "z" } as any)).toThrow();
  });
});
