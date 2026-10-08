/**
 * 고수준 에이전트 인증 — 위임 VC로 짧은 TTL bearer를 교환하고 만료 전 자동 재교환한다.
 * MCP 클라이언트는 "고정 헤더" 하나만 등록하므로, `onRefresh`로 갱신된 bearer를 설정에 반영하면 된다.
 */
import { AgentClientError, BriefickAgentClient, type SessionResult } from "./briefick.js";

export interface AgentAuthOptions {
  client: BriefickAgentClient;
  /** 회수·보관한 위임 VC(SD-JWT VC). */
  credential: string;
  /** 만료 몇 ms 전에 미리 재교환할지(기본 60s). */
  refreshSkewMs?: number;
  /** 갱신 때마다 새 bearer 통지 — MCP 고정헤더/토큰 캐시 갱신에 사용. */
  onRefresh?: (bearer: string, expiresAt: Date) => void;
  /** 재교환 실패 시 통지(성공할 때까지 retryMs 간격으로 계속 재시도). */
  onError?: (err: unknown) => void;
  /**
   * **영구 실패** 시 통지 — 재시도가 결과를 바꿀 수 없는 오류(등록 회수·세션 거부 등).
   * 이 콜백이 불리면 루프는 **멈춘 상태**다(재등록 없이는 되살아나지 않는다).
   * ⚠️ 미지정이면 루프는 그냥 멈춘다 — `onError` 로 계속 통지되던 종전과 달리 **조용해진다**.
   */
  onFatal?: (err: unknown) => void;
  /** First retry delay after a failure, ms (default 10s). It doubles per consecutive failure, up to [MAX_RETRY_MS]. */
  retryMs?: number;
}

/** Retry ceiling: after this many consecutive failures' backoff, retries come every 5 min, not every 10 s. */
export const MAX_RETRY_MS = 5 * 60_000;

/** What the daemon reports for one RP's session (`status`, and the 503 an MCP client gets). */
export interface SessionState {
  /** Refreshing stopped for good (registration gone, delegation refused). */
  stopped: boolean;
  /** Why it stopped, so `status` can say what fixes it: re-register, or approve a new delegation. */
  stopReason?: "registration_gone" | "delegation_refused" | "other";
  /** Consecutive failed refreshes since the last success. */
  failures: number;
  lastError?: string;
  lastRefreshAt?: Date;
  expiresAt?: Date;
}

/**
 * **다시 보내면 달라지는가** — 재교환 실패가 영구적인지 판정한다.
 *
 * ⚠️ 이 판정이 없으면 `401 registration_revoked`(재등록 전엔 영원히 같은 답)에도 루프가
 * 10초마다 무한 재시도한다. 실측: 한 데몬이 9일간 74,781건의 401 을 briefick 에 보냈다
 * (2026-09-17). 오류는 `httpStatus`·`body` 를 **보존한 채** 넘어오므로 정보는 이미 닿아 있다.
 *
 * 영구(재시도 무의미):
 *   - 4xx 중 401·408·429 를 제외한 전부 — 403, 404
 *   - 세션 거부(`completeSession` 이 던지는 status rejected — httpStatus 없음)
 * 일시(재시도가 고칠 수 있음):
 *   - 네트워크 오류, 5xx · 408 · 429
 *   - 401: a PoP failure from clock skew or a deploy window looks the same as a revoked registration. AgentAuth asks
 *     the RP (`retrieve` → `no_agent`) before it stops; one 401 stopped a daemon for 34 h (Briefick, 2026-10-06).
 *   - status `error`: Briefick answers it for a verifier poll or JWKS failure, which a retry can fix.
 */
export function isPermanentAuthFailure(err: unknown): boolean {
  if (err instanceof AgentClientError) {
    const code = err.httpStatus;
    if (typeof code === "number") {
      if (code === 401 || code === 408 || code === 429) return false; // 재시도 대상(401 은 AgentAuth 가 확인한다)
      if (code >= 400 && code < 500) return true;      // 나머지 4xx — 다시 보내도 같다
      return false;                                     // 5xx 등 — 일시적
    }
    // httpStatus 가 없는 AgentClientError: rejected 는 영구, error·타임아웃은 일시.
    const body = err.body as { status?: string } | undefined;
    return body?.status === "rejected";
  }
  return false; // TypeError('fetch failed') 등 네트워크 — 일시적
}

/** Reasons an RP's `rejected` gives when the agent's registration, not the delegation, is gone (Briefick). */
const REGISTRATION_GONE = new Set(["registration_revoked", "agent_not_registered"]);

function stopReasonOf(e: unknown): SessionState["stopReason"] {
  const body = e instanceof AgentClientError ? (e.body as { status?: string; reasons?: unknown } | undefined) : undefined;
  if (body?.status !== "rejected") return "other";
  const reasons = Array.isArray(body.reasons) ? body.reasons : [];
  return reasons.some((r) => typeof r === "string" && REGISTRATION_GONE.has(r)) ? "registration_gone" : "delegation_refused";
}

/**
 * 사용 예:
 * ```ts
 * const auth = new AgentAuth({ client, credential, onRefresh: writeMcpHeader });
 * await auth.start();
 * fetch(mcpUrl, { headers: auth.authHeader() });   // 항상 유효한 bearer
 * ```
 */
export class AgentAuth {
  private bearerValue?: string;
  private expiresAt?: Date;
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private failures = 0;
  private stopReason?: SessionState["stopReason"];
  private lastError?: string;
  private lastRefreshAt?: Date;

  constructor(private readonly opts: AgentAuthOptions) {}

  /** 최초 교환 + 자동 갱신 스케줄. */
  async start(): Promise<void> {
    this.stopped = false;
    await this.refresh();
  }

  /** 현재 bearer. None yet, or past its expiry: throws, so the daemon answers 503 instead of forwarding a dead token. */
  bearer(): string {
    if (!this.bearerValue) throw new Error("start() 먼저 호출하세요");
    if (this.expiresAt && this.expiresAt.getTime() <= Date.now()) {
      throw new Error(`세션 만료 — ${this.stopped ? "갱신 중지" : "갱신 재시도 중"}${this.lastError ? `: ${this.lastError}` : ""}`);
    }
    return this.bearerValue;
  }

  state(): SessionState {
    return { stopped: this.stopped, stopReason: this.stopReason, failures: this.failures, lastError: this.lastError,
      lastRefreshAt: this.lastRefreshAt, expiresAt: this.expiresAt };
  }

  /** `{ Authorization: "Bearer …" }`. */
  authHeader(): Record<string, string> {
    return { Authorization: `Bearer ${this.bearer()}` };
  }

  /** 자동 갱신 중지. */
  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private async refresh(): Promise<void> {
    const r: SessionResult = await this.opts.client.exchange(this.opts.credential);
    if (r.status !== "issued" || !r.bearer) {
      throw new Error(`세션 발급 실패: ${r.status}`);
    }
    this.bearerValue = r.bearer;
    this.expiresAt = r.expiresAt ? new Date(r.expiresAt) : undefined;
    this.failures = 0;
    this.lastError = undefined;
    this.lastRefreshAt = new Date();
    this.opts.onRefresh?.(r.bearer, this.expiresAt ?? new Date(Date.now() + 15 * 60_000));
    this.schedule();
  }

  private schedule(): void {
    if (this.stopped || !this.expiresAt) return;
    const skew = this.opts.refreshSkewMs ?? 60_000;
    const delay = Math.max(5_000, this.expiresAt.getTime() - Date.now() - skew);
    this.timer = setTimeout(() => {
      this.refresh().catch((e) => this.onRefreshError(e));
    }, delay);
    // Node에서 프로세스 종료를 막지 않도록
    (this.timer as unknown as { unref?: () => void }).unref?.();
  }

  /**
   * 갱신 실패 처리 — **다시 보내면 달라지는가**로 갈린다.
   *
   * 🔴 영구 실패(등록 회수 등)면 **멈춘다** — 재시도해도 같은 401 이 영원히 온다.
   *    종전에는 이 구분이 없어 10초마다 무한 재시도했다(실측 9일 74,781건).
   * 🟢 일시 실패(네트워크·5xx)면 종전대로 재시도한다 — 루프가 죽지 않는다.
   */
  private onRefreshError(e: unknown): void {
    this.failures++;
    this.lastError = e instanceof Error ? e.message : String(e);
    this.opts.onError?.(e);
    if (isPermanentAuthFailure(e)) return this.fatal(e, stopReasonOf(e));
    if (e instanceof AgentClientError && e.httpStatus === 401) {
      // Revoked, or a passing PoP failure? Only the RP knows. `no_agent` is its «registration gone».
      this.opts.client.retrieveDelegation().then(
        (r) => (r.status === "no_agent" ? this.fatal(e, "registration_gone") : this.retrySoon()),
        () => this.retrySoon(),
      );
      return;
    }
    this.retrySoon();
  }

  private fatal(e: unknown, reason: SessionState["stopReason"]): void {
    this.stopped = true;
    this.stopReason = reason;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.opts.onFatal?.(e);
  }

  /** 일시 실패 재시도 — 일시 네트워크 단절이 재시도 1회보다 길어도 루프가 죽지 않는다. */
  private retrySoon(): void {
    if (this.stopped) return;
    const base = this.opts.retryMs ?? 10_000;
    const delay = Math.min(MAX_RETRY_MS, base * 2 ** Math.max(0, this.failures - 1));
    this.timer = setTimeout(() => {
      this.refresh().catch((e) => this.onRefreshError(e));
    }, delay);
    (this.timer as unknown as { unref?: () => void }).unref?.();
  }
}
