/**
 * 에이전트 홀더 키 (did:jwk, ES256/P-256) — platform-java `DidJwk`/`KeyBindingJwt`와 바이트 호환.
 *
 * did:jwk 형식: `did:jwk:<base64url(JSON JWK)>`, JWK JSON은 **compact + 키순서 crv,kty,x,y**
 * (platform-java `DidJwk.jwkMap` 정준 순서와 동일 → 같은 키면 같은 did:jwk 문자열). VM id = `<did>#0`.
 */
import { SignJWT, importJWK, type JWK, type KeyLike } from "jose";
import { generateKeyPair, exportJWK } from "jose";
import { createHash, randomUUID } from "node:crypto";

const ALG = "ES256";

/**
 * 에이전트 지문 — sha256(did:jwk 문자열) hex 앞 10자리. Briefick /publish가 등록 에이전트를
 * 같은 지문으로 표시하므로 화면과 1:1 대조용(모든 did:jwk는 앞자리가 같아 육안 구분 불가).
 */
export function didFingerprint(did: string): string {
  return createHash("sha256").update(did, "utf8").digest("hex").slice(0, 10);
}

/** 공개 JWK → did:jwk. JSON 키순서(crv,kty,x,y) 고정으로 platform-java와 바이트 동일. */
export function didJwkFromPublicJwk(pub: JWK): string {
  if (pub.kty !== "EC" || pub.crv !== "P-256" || !pub.x || !pub.y) {
    throw new Error("ES256/P-256 (EC) 공개키만 지원합니다");
  }
  const canonical = JSON.stringify({ crv: pub.crv, kty: pub.kty, x: pub.x, y: pub.y });
  const enc = Buffer.from(canonical, "utf8").toString("base64url");
  return "did:jwk:" + enc;
}

/** did:jwk → 공개 JWK (platform-java `DidJwk.parse`와 동일 파싱). */
export function publicJwkFromDidJwk(did: string): JWK {
  if (!did.startsWith("did:jwk:")) throw new Error("did:jwk 형식이 아닙니다");
  const json = Buffer.from(did.slice("did:jwk:".length), "base64url").toString("utf8");
  const jwk = JSON.parse(json) as JWK;
  if (!jwk || jwk.kty !== "EC") throw new Error("did:jwk 안에 유효한 EC JWK가 없습니다");
  return jwk;
}

/** 홀더 키 — 개인키 보유, did:jwk 노출, PoP/KB-JWT 서명. 개인키는 로컬에만 둔다. */
export class AgentKey {
  private constructor(
    private readonly privateKey: KeyLike,
    readonly publicJwk: JWK,
    readonly privateJwk: JWK,
    readonly did: string,
  ) {}

  /** 새 ES256 키 생성. */
  static async generate(): Promise<AgentKey> {
    const { publicKey, privateKey } = await generateKeyPair(ALG, { extractable: true });
    const pub = await exportJWK(publicKey);
    const priv = await exportJWK(privateKey);
    const key = await importJWK(priv, ALG);
    return new AgentKey(key as KeyLike, pub, priv, didJwkFromPublicJwk(pub));
  }

  /** 저장된 개인 JWK로 복원(에이전트 키 영속 — 재실행에도 같은 did:jwk 유지). */
  static async fromPrivateJwk(priv: JWK): Promise<AgentKey> {
    const key = await importJWK(priv, ALG);
    const pub: JWK = { kty: "EC", crv: "P-256", x: priv.x, y: priv.y };
    return new AgentKey(key as KeyLike, pub, priv, didJwkFromPublicJwk(pub));
  }

  /** 저장용 개인 JWK(파일 등에 보관). */
  exportPrivateJwk(): JWK {
    return this.privateJwk;
  }

  /** 지문(sha256(did) 앞 10 hex) — Briefick /publish 표시와 동일, 화면 대조용. */
  get fingerprint(): string {
    return didFingerprint(this.did);
  }

  /**
   * 소유증명(PoP) JWT — aud 스코핑 + iat(재생 방지) + 선택 클레임. 등록 시 `code`를 넣는다.
   * ES256 compact JWT, 개인키 서명. Briefick `verifyAgentPop`/`verifyRegistrationPop`가 검증.
   */
  async popJwt(audience: string, extraClaims: Record<string, unknown> = {}): Promise<string> {
    return new SignJWT(extraClaims)
      .setProtectedHeader({ alg: ALG })
      .setIssuedAt()
      .setAudience(audience)
      .sign(this.privateKey);
  }

  /**
   * Request proof (spec agent-delegation §11) — typ agent-request+jwt, kid `<did:jwk>#0`; payload htm, htu, iat,
   * jti, `ath` (session token, on calls only) and `bh` (body bytes, sent exactly as hashed). Wire-compatible with
   * platform-java `AgentRequestProof`.
   */
  async requestProof(
    htm: string,
    htu: string,
    opts: { body?: Uint8Array; sessionToken?: string; jti?: string; iat?: number } = {},
  ): Promise<string> {
    const payload: Record<string, unknown> = {
      htm,
      htu,
      iat: opts.iat ?? Math.floor(Date.now() / 1000),
      jti: opts.jti ?? randomUUID(),
    };
    if (opts.sessionToken !== undefined) {
      payload.ath = createHash("sha256").update(Buffer.from(opts.sessionToken, "ascii")).digest("base64url");
    }
    if (opts.body !== undefined) {
      payload.bh = createHash("sha256").update(opts.body).digest("base64url");
    }
    return new SignJWT(payload)
      .setProtectedHeader({ typ: "agent-request+jwt", alg: ALG, kid: this.did + "#0" })
      .sign(this.privateKey);
  }

  /** KB-JWT — typ=kb+jwt, payload {iat, aud, nonce, sd_hash}. platform-java `KeyBindingJwt`와 동일. */
  async keyBindingJwt(sdHash: string, aud: string, nonce: string): Promise<string> {
    return new SignJWT({ nonce, sd_hash: sdHash })
      .setProtectedHeader({ alg: ALG, typ: "kb+jwt" })
      .setIssuedAt()
      .setAudience(aud)
      .sign(this.privateKey);
  }
}
