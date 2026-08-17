/**
 * SD-JWT VC 제시(홀더) — platform-java `SdJwtPresentation`와 바이트 호환.
 *
 * 조립: `core = issuerJwt~<선택disclosure>~...~` (각 disclosure 뒤 `~`, 트레일링 `~` 포함),
 * `sd_hash = base64url(SHA-256(ASCII(core)))`, `vp_token = core + KB-JWT`.
 * (platform-java `VerifierCore.verify`가 `lastIndexOf('~')`로 core/KB를 가르므로 정확히 일치해야 함.)
 */
import { createHash } from "node:crypto";
import type { AgentKey } from "./key.js";

/** disclosure(base64url(JSON [salt, name, value]))에서 클레임 이름 추출. 실패 시 null. */
function disclosureName(disclosure: string): string | null {
  try {
    const arr = JSON.parse(Buffer.from(disclosure, "base64url").toString("utf8"));
    return Array.isArray(arr) && arr.length >= 2 ? String(arr[1]) : null;
  } catch {
    return null;
  }
}

function looksLikeJwt(s: string): boolean {
  return s.split(".").length === 3;
}

/** 발급 SD-JWT VC를 발급JWT + disclosure 목록으로 분해(트레일링 `~`/기존 KB 제거). */
export function splitSdJwt(serialized: string): { issuerJwt: string; disclosures: string[] } {
  const segments = serialized.split("~");
  const issuerJwt = segments[0];
  const disclosures = segments
    .slice(1)
    .filter((s) => s.length > 0 && !looksLikeJwt(s)); // 트레일링 빈칸·기존 KB-JWT 제외
  return { issuerJwt, disclosures };
}

/** base64url(SHA-256(ASCII(s))) — platform-java `SdJwtCodec.sha256Base64Url`와 동일. */
export function sha256Base64Url(s: string): string {
  return createHash("sha256").update(Buffer.from(s, "ascii")).digest("base64url");
}

export interface PresentOptions {
  /** 공개할 클레임 이름들. 미지정 시 VC의 모든 disclosure 공개(위임 VC는 scope·constraints뿐). */
  disclose?: string[];
  /** KB-JWT audience. 미지정 시 responseUri 호스트에서 did:web 유도. */
  audience: string;
  /** 검증자 요청 nonce. */
  nonce: string;
}

/**
 * 위임 VC를 제시용 vp_token으로 변환.
 * @param serialized 발급된 SD-JWT VC(회수한 credential 그대로)
 * @param key 에이전트 홀더 키(cnf에 바인딩된 개인키)
 */
export async function presentVpToken(
  serialized: string,
  key: AgentKey,
  opts: PresentOptions,
): Promise<string> {
  const { issuerJwt, disclosures } = splitSdJwt(serialized);
  const wanted = opts.disclose;
  const included = wanted
    ? disclosures.filter((d) => {
        const n = disclosureName(d);
        return n != null && wanted.includes(n);
      })
    : disclosures;

  let core = issuerJwt + "~";
  for (const d of included) core += d + "~";

  const sdHash = sha256Base64Url(core);
  const kbJwt = await key.keyBindingJwt(sdHash, opts.audience, opts.nonce);
  return core + kbJwt;
}

/** responseUri(예: https://sso.cplabs.io/response) → 검증자 did:web(did:web:sso.cplabs.io). */
export function verifierDidFromResponseUri(responseUri: string): string {
  const host = new URL(responseUri).host; // host[:port]
  return "did:web:" + host.replace(":", "%3A");
}
