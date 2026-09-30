/**
 * 위임 인증 클라이언트 — **서비스 중립**. RP(검증 소비처)의 엔드포인트 경로와 PoP audience를 설정으로 받아,
 * 등록·회수·세션 교환을 수행한다. 기본값은 Briefick 계약이라 설정 없이 쓰면 Briefick 클라이언트로 동작한다.
 * 홀더 암호(PoP·VP 제시)는 `AgentKey`/`presentVpToken`에 위임하고, 여기선 계약 호출만 담당.
 * @see Briefick docs/agent-auth-delegation.md (기본 계약)
 */
import type { AgentKey } from "./key.js";
import { presentVpToken, verifierDidFromResponseUri } from "./present.js";

/** RP 계약 설정 — 미지정 필드는 Briefick 기본값. */
export interface AgentServiceConfig {
  /** 등록 경로 (기본 /api/agent/register) */
  registerPath?: string;
  /** 위임 VC 회수 경로 (기본 /api/agent/delegation/retrieve) */
  retrievePath?: string;
  /** 세션 시작 경로 (기본 /api/agent/session/start) */
  sessionStartPath?: string;
  /** 세션 완료 경로 (기본 /api/agent/session/complete) */
  sessionCompletePath?: string;
  /** PoP audience (기본 briefick-agent-*) */
  popAudience?: { register: string; retrieve: string; session: string };
  /** RP MCP 경로 (프록시 편의용, 기본 /api/mcp) */
  mcpPath?: string;
}

/** 기본 계약 = Briefick. */
export const DEFAULT_SERVICE: Required<AgentServiceConfig> = {
  registerPath: "/api/agent/register",
  retrievePath: "/api/agent/delegation/retrieve",
  sessionStartPath: "/api/agent/session/start",
  sessionCompletePath: "/api/agent/session/complete",
  popAudience: {
    register: "briefick-agent-register",
    retrieve: "briefick-agent-retrieve",
    session: "briefick-agent-session",
  },
  mcpPath: "/api/mcp",
};

/** 하위호환 — Briefick PoP audience 상수. */
export const POP_AUDIENCE = DEFAULT_SERVICE.popAudience;

type FetchLike = typeof fetch;

export interface AgentClientOptions {
  /** RP 베이스 URL (예: https://briefick.cplabs.io) */
  baseUrl: string;
  key: AgentKey;
  /** RP 계약 설정(경로·aud). 미지정 시 Briefick 기본값. */
  service?: AgentServiceConfig;
  /** KB-JWT audience 오버라이드. 미지정 시 sso responseUri에서 did:web 유도. */
  verifierId?: string;
  /**
   * 이 CLI 의 판. 등록 본문의 `version` 으로 나간다.
   *
   * 🔴 briefick 이 이걸 `AgentToken.cliVersion` 으로 저장해, **상류 서명키 회전의 전파율**을
   * 질의로 만든다(`briefick#44`). 그 칸은 **소급이 안 된다** — 이 판을 안 보내고 등록한
   * 에이전트는 나중에 보고하지 않는다.
   *
   * ⚠️ semver 모양(`0.5.6`)만 저장된다. `v` 접두어는 거부되므로 태그(`v0.5.6`)가 아니라
   * `package.json` 의 값을 보낸다. 알 수 없으면 **보내지 않는다**(빈 문자열이 아니라 부재).
   */
  version?: string;
  fetchImpl?: FetchLike;
}

/** retrieve의 미배달 세분화(0.2.2, RP 하위호환 확장) — pending일 때 마지막 발급 요청 상태. */
export interface DelegationLastRequest {
  nonce?: string;
  status?: string;
  createdAt?: string;
  expiresAt?: string;
}

export interface DelegationRetrieval {
  /**
   * delivered=회수 가능 / pending=요청 있음·지갑 승인/전달 대기 / no_request=이 에이전트로
   * 발급된 위임 없음(엉뚱한 에이전트이거나 미발급) / expired=마지막 요청 만료(재발급 필요) /
   * no_agent=미등록. (구 RP는 no_request·expired 없이 pending만 반환 — 하위호환:
   * expired는 lastRequest.expiresAt로도 판정한다, {@link isRequestExpired})
   */
  status: "delivered" | "pending" | "no_request" | "expired" | "no_agent" | string;
  credential?: string;
  scope?: unknown;
  constraints?: unknown;
  lastRequest?: DelegationLastRequest;
}

export interface SessionStart {
  state: string;
  nonce: string;
  responseUri: string;
}

export interface SessionResult {
  status: "issued" | "pending" | "unknown" | "rejected" | "error" | string;
  bearer?: string;
  expiresAt?: string;
  scope?: string[];
  reasons?: string[];
}

export class AgentClientError extends Error {
  constructor(message: string, readonly httpStatus?: number, readonly body?: unknown) {
    super(message);
    this.name = "AgentClientError";
  }
}

export class AgentClient {
  private readonly base: string;
  private readonly key: AgentKey;
  private readonly svc: Required<AgentServiceConfig>;
  private readonly verifierId?: string;
  private readonly version?: string;
  private readonly http: FetchLike;

  constructor(opts: AgentClientOptions) {
    this.base = opts.baseUrl.replace(/\/+$/, "");
    this.key = opts.key;
    this.svc = { ...DEFAULT_SERVICE, ...(opts.service ?? {}), popAudience: { ...DEFAULT_SERVICE.popAudience, ...(opts.service?.popAudience ?? {}) } };
    this.verifierId = opts.verifierId;
    this.version = opts.version;
    this.http = opts.fetchImpl ?? fetch;
  }

  private async postJson(path: string, body: unknown): Promise<any> {
    const res = await this.http(this.base + path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    let json: any = undefined;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      /* 비 JSON 응답 */
    }
    if (!res.ok) {
      throw new AgentClientError(`POST ${path} → ${res.status}: ${json?.error ?? text}`, res.status, json ?? text);
    }
    return json;
  }

  private async postAbsolute(url: string, body: unknown): Promise<any> {
    const res = await this.http(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    try {
      return text ? JSON.parse(text) : undefined;
    } catch {
      return text;
    }
  }

  /** 페어링 등록 — 사용자가 RP UI에서 발급한 코드로 did:jwk 바인딩(PoP). */
  async register(code: string, label?: string): Promise<{ registered: boolean; id?: string }> {
    const pop = await this.key.popJwt(this.svc.popAudience.register, { code });
    // ⚠️ `version` and `label` are **omitted when unknown**, not sent empty. briefick reads a
    //    missing key as "keep what you have" and an empty one as a value, so `undefined` is the
    //    only spelling of "could not determine" — `registerLabel` makes the same distinction.
    return this.postJson(this.svc.registerPath, { didJwk: this.key.did, code, pop, label, version: this.version });
  }

  /** 승인된 위임 VC 1회 회수(delivered면 credential 반환, pending이면 재시도). */
  async retrieveDelegation(): Promise<DelegationRetrieval> {
    const pop = await this.key.popJwt(this.svc.popAudience.retrieve);
    return this.postJson(this.svc.retrievePath, { didJwk: this.key.did, pop });
  }

  /**
   * delivered 될 때까지 회수 폴링(사용자가 지갑에서 승인 완료 대기).
   * onStatus는 상태(또는 pending 대상 요청)가 바뀔 때마다 호출 — CLI 안내 분기용.
   */
  async waitForDelegation(
    opts: { pollMs?: number; timeoutMs?: number; onStatus?: (r: DelegationRetrieval) => void } = {},
  ): Promise<string> {
    const pollMs = opts.pollMs ?? 2000;
    const deadline = Date.now() + (opts.timeoutMs ?? 120000);
    let last: DelegationRetrieval | undefined;
    let lastExpired = false;
    for (;;) {
      const r = await this.retrieveDelegation();
      const expired = isRequestExpired(r);
      // 대기 중 같은 요청이 만료로 넘어가는 순간(status·nonce 불변)에도 onStatus를 다시 알린다.
      if (r.status !== last?.status || r.lastRequest?.nonce !== last?.lastRequest?.nonce || expired !== lastExpired) {
        opts.onStatus?.(r);
      }
      last = r;
      lastExpired = expired;
      if (r.status === "delivered" && r.credential) return r.credential;
      if (r.status === "no_agent") throw new AgentClientError("등록되지 않은 에이전트");
      if (Date.now() > deadline) throw new AgentClientError(retrievalTimeoutMessage(last));
      await sleep(pollMs);
    }
  }

  /** 세션 교환 시작 — 검증자 제시용 nonce·responseUri 획득. */
  async startSession(): Promise<SessionStart> {
    const pop = await this.key.popJwt(this.svc.popAudience.session);
    const r = await this.postJson(this.svc.sessionStartPath, { didJwk: this.key.did, pop });
    return { state: r.state, nonce: r.nonce, responseUri: r.responseUri };
  }

  /** 위임 VP를 검증자 responseUri에 제시(검증은 검증자가 수행). */
  async presentDelegation(credential: string, s: SessionStart): Promise<void> {
    const audience = this.verifierId ?? verifierDidFromResponseUri(s.responseUri);
    const vpToken = await presentVpToken(credential, this.key, { audience, nonce: s.nonce });
    await this.postAbsolute(s.responseUri, { vpToken });
  }

  /** 세션 완료 폴링 — 검증 결과 확정 후 짧은 TTL bearer 수령. */
  async completeSession(state: string, opts: { pollMs?: number; timeoutMs?: number } = {}): Promise<SessionResult> {
    const pollMs = opts.pollMs ?? 1500;
    const deadline = Date.now() + (opts.timeoutMs ?? 60000);
    for (;;) {
      const pop = await this.key.popJwt(this.svc.popAudience.session);
      const r: SessionResult = await this.postJson(this.svc.sessionCompletePath, {
        state,
        didJwk: this.key.did,
        pop,
      });
      if (r.status === "issued") return r;
      if (r.status === "rejected" || r.status === "error") {
        throw new AgentClientError(`세션 거부: ${(r.reasons ?? []).join(",") || r.status}`, undefined, r);
      }
      if (Date.now() > deadline) throw new AgentClientError("세션 완료 타임아웃");
      await sleep(pollMs);
    }
  }

  /** 전체 세션 교환: start → present → complete. 짧은 TTL bearer 반환. */
  async exchange(credential: string): Promise<SessionResult> {
    const s = await this.startSession();
    await this.presentDelegation(credential, s);
    return this.completeSession(s.state);
  }
}

// ── 하위호환 별칭 (Briefick 기본 계약) ──
export { AgentClient as BriefickAgentClient };
export { AgentClientError as BriefickAgentError };
export type { AgentClientOptions as BriefickClientOptions };

/** 요청 만료 여부 — RP의 명시적 {@code status:"expired"} 우선, 없으면 lastRequest.expiresAt로 판정(하위호환). */
export function isRequestExpired(r: DelegationRetrieval): boolean {
  if (r.status === "expired") return true;
  const e = r.lastRequest?.expiresAt;
  return e !== undefined && Date.parse(e) < Date.now();
}

/** 마지막 관측 상태로 타임아웃 원인을 구분한다(무음 pending의 조기 진단 — A 항목). */
function retrievalTimeoutMessage(last?: DelegationRetrieval): string {
  if (last?.status === "no_request") {
    return "위임 VC 회수 타임아웃 — 이 에이전트로 발급된 위임 요청이 없습니다(다른 에이전트로 발급했거나 미발급). Briefick /publish에서 에이전트 지문을 대조해 위임을 발급하세요";
  }
  if (last && isRequestExpired(last)) {
    return `위임 VC 회수 타임아웃 — 마지막 요청(nonce ${last.lastRequest?.nonce ?? "?"})이 만료됐습니다. Briefick /publish에서 위임을 다시 발급하세요`;
  }
  if (last?.status === "pending" && last.lastRequest) {
    const lr = last.lastRequest;
    return (
      `위임 VC 회수 타임아웃 — 요청(nonce ${lr.nonce ?? "?"}, 만료 ${lr.expiresAt ?? "?"})은 있으나 ` +
      "지갑 발급물이 도착하지 않았습니다(지갑 callback 전달 실패 또는 미승인). 지갑에서 재승인하거나 /publish에서 재발급하세요"
    );
  }
  return "위임 VC 회수 타임아웃(승인 대기)";
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
