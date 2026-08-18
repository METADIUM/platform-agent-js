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
  fetchImpl?: FetchLike;
}

export interface DelegationRetrieval {
  status: "delivered" | "pending" | "no_agent" | string;
  credential?: string;
  scope?: unknown;
  constraints?: unknown;
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
  private readonly http: FetchLike;

  constructor(opts: AgentClientOptions) {
    this.base = opts.baseUrl.replace(/\/+$/, "");
    this.key = opts.key;
    this.svc = { ...DEFAULT_SERVICE, ...(opts.service ?? {}), popAudience: { ...DEFAULT_SERVICE.popAudience, ...(opts.service?.popAudience ?? {}) } };
    this.verifierId = opts.verifierId;
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
    return this.postJson(this.svc.registerPath, { didJwk: this.key.did, code, pop, label });
  }

  /** 승인된 위임 VC 1회 회수(delivered면 credential 반환, pending이면 재시도). */
  async retrieveDelegation(): Promise<DelegationRetrieval> {
    const pop = await this.key.popJwt(this.svc.popAudience.retrieve);
    return this.postJson(this.svc.retrievePath, { didJwk: this.key.did, pop });
  }

  /** delivered 될 때까지 회수 폴링(사용자가 지갑에서 승인 완료 대기). */
  async waitForDelegation(opts: { pollMs?: number; timeoutMs?: number } = {}): Promise<string> {
    const pollMs = opts.pollMs ?? 2000;
    const deadline = Date.now() + (opts.timeoutMs ?? 120000);
    for (;;) {
      const r = await this.retrieveDelegation();
      if (r.status === "delivered" && r.credential) return r.credential;
      if (r.status === "no_agent") throw new AgentClientError("등록되지 않은 에이전트");
      if (Date.now() > deadline) throw new AgentClientError("위임 VC 회수 타임아웃(승인 대기)");
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

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
