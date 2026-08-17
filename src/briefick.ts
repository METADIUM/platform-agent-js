/**
 * Briefick 에이전트 인증 계약 클라이언트 — 등록·회수·세션 교환(HTTP).
 * 홀더 암호(PoP·VP 제시)는 `AgentKey`/`presentVpToken`에 위임하고, 여기선 계약 호출만 담당.
 * @see Briefick docs/agent-auth-delegation.md
 */
import type { AgentKey } from "./key.js";
import { presentVpToken, verifierDidFromResponseUri } from "./present.js";

/** PoP audience (Briefick `agent-did.ts` 상수와 일치해야 함). */
export const POP_AUDIENCE = {
  register: "briefick-agent-register",
  retrieve: "briefick-agent-retrieve",
  session: "briefick-agent-session",
} as const;

type FetchLike = typeof fetch;

export interface BriefickClientOptions {
  /** Briefick 베이스 URL (예: https://briefick.example) */
  baseUrl: string;
  key: AgentKey;
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

export class BriefickAgentError extends Error {
  constructor(message: string, readonly httpStatus?: number, readonly body?: unknown) {
    super(message);
    this.name = "BriefickAgentError";
  }
}

export class BriefickAgentClient {
  private readonly base: string;
  private readonly key: AgentKey;
  private readonly verifierId?: string;
  private readonly http: FetchLike;

  constructor(opts: BriefickClientOptions) {
    this.base = opts.baseUrl.replace(/\/+$/, "");
    this.key = opts.key;
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
      throw new BriefickAgentError(
        `POST ${path} → ${res.status}: ${json?.error ?? text}`,
        res.status,
        json ?? text,
      );
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

  /** 페어링 등록 — 사용자가 Briefick /publish에서 발급한 코드로 did:jwk 바인딩(PoP). */
  async register(code: string, label?: string): Promise<{ registered: boolean; id?: string }> {
    const pop = await this.key.popJwt(POP_AUDIENCE.register, { code });
    return this.postJson("/api/agent/register", { didJwk: this.key.did, code, pop, label });
  }

  /** 승인된 위임 VC 1회 회수(delivered면 credential 반환, pending이면 재시도). */
  async retrieveDelegation(): Promise<DelegationRetrieval> {
    const pop = await this.key.popJwt(POP_AUDIENCE.retrieve);
    return this.postJson("/api/agent/delegation/retrieve", { didJwk: this.key.did, pop });
  }

  /** delivered 될 때까지 회수 폴링(사용자가 지갑에서 승인 완료 대기). */
  async waitForDelegation(opts: { pollMs?: number; timeoutMs?: number } = {}): Promise<string> {
    const pollMs = opts.pollMs ?? 2000;
    const deadline = Date.now() + (opts.timeoutMs ?? 120000);
    for (;;) {
      const r = await this.retrieveDelegation();
      if (r.status === "delivered" && r.credential) return r.credential;
      if (r.status === "no_agent") throw new BriefickAgentError("등록되지 않은 에이전트");
      if (Date.now() > deadline) throw new BriefickAgentError("위임 VC 회수 타임아웃(승인 대기)");
      await sleep(pollMs);
    }
  }

  /** 세션 교환 시작 — sso 제시용 nonce·responseUri 획득. */
  async startSession(): Promise<SessionStart> {
    const pop = await this.key.popJwt(POP_AUDIENCE.session);
    const r = await this.postJson("/api/agent/session/start", { didJwk: this.key.did, pop });
    return { state: r.state, nonce: r.nonce, responseUri: r.responseUri };
  }

  /** 위임 VP를 sso responseUri에 제시(검증은 sso가 수행). */
  async presentDelegation(credential: string, s: SessionStart): Promise<void> {
    const audience = this.verifierId ?? verifierDidFromResponseUri(s.responseUri);
    const vpToken = await presentVpToken(credential, this.key, { audience, nonce: s.nonce });
    await this.postAbsolute(s.responseUri, { vpToken });
  }

  /** 세션 완료 폴링 — sso 검증 결과 확정 후 짧은 TTL bearer 수령. */
  async completeSession(state: string, opts: { pollMs?: number; timeoutMs?: number } = {}): Promise<SessionResult> {
    const pollMs = opts.pollMs ?? 1500;
    const deadline = Date.now() + (opts.timeoutMs ?? 60000);
    for (;;) {
      const pop = await this.key.popJwt(POP_AUDIENCE.session);
      const r: SessionResult = await this.postJson("/api/agent/session/complete", {
        state,
        didJwk: this.key.did,
        pop,
      });
      if (r.status === "issued") return r;
      if (r.status === "rejected" || r.status === "error") {
        throw new BriefickAgentError(`세션 거부: ${(r.reasons ?? []).join(",") || r.status}`, undefined, r);
      }
      if (Date.now() > deadline) throw new BriefickAgentError("세션 완료 타임아웃");
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

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
