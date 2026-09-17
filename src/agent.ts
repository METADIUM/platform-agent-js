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
  /** 실패 재시도 간격 ms(기본 10s). */
  retryMs?: number;
}

/**
 * **다시 보내면 달라지는가** — 재교환 실패가 영구적인지 판정한다.
 *
 * ⚠️ 이 판정이 없으면 `401 registration_revoked`(재등록 전엔 영원히 같은 답)에도 루프가
 * 10초마다 무한 재시도한다. 실측: 한 데몬이 9일간 74,781건의 401 을 briefick 에 보냈다
 * (2026-09-17). 오류는 `httpStatus`·`body` 를 **보존한 채** 넘어오므로 정보는 이미 닿아 있다.
 *
 * 영구(재시도 무의미):
 *   - 4xx 중 408·429 를 제외한 전부 — 특히 401(인증·등록 회수), 403, 404
 *   - 세션 거부(`completeSession` 이 던지는 status rejected/error — httpStatus 없음)
 * 일시(재시도가 고칠 수 있음):
 *   - 네트워크 오류(httpStatus 없음, 거부도 아님)
 *   - 5xx · 408 · 429(서버측 일시 상태)
 */
export function isPermanentAuthFailure(err: unknown): boolean {
  if (err instanceof AgentClientError) {
    const code = err.httpStatus;
    if (typeof code === "number") {
      if (code === 408 || code === 429) return false; // 재시도 대상
      if (code >= 400 && code < 500) return true;      // 나머지 4xx — 다시 보내도 같다
      return false;                                     // 5xx 등 — 일시적
    }
    // httpStatus 가 없는 AgentClientError 는 세션 거부(rejected/error) — 영구다.
    // ⚠️ 단, 타임아웃 메시지는 일시적이므로 거른다(completeSession 폴링 타임아웃).
    const body = err.body as { status?: string } | undefined;
    if (body?.status === "rejected" || body?.status === "error") return true;
    return false;
  }
  return false; // TypeError('fetch failed') 등 네트워크 — 일시적
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

  constructor(private readonly opts: AgentAuthOptions) {}

  /** 최초 교환 + 자동 갱신 스케줄. */
  async start(): Promise<void> {
    this.stopped = false;
    await this.refresh();
  }

  /** 현재 bearer(없으면 예외). */
  bearer(): string {
    if (!this.bearerValue) throw new Error("start() 먼저 호출하세요");
    return this.bearerValue;
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
    this.opts.onError?.(e);
    if (isPermanentAuthFailure(e)) {
      this.stopped = true;
      if (this.timer) clearTimeout(this.timer);
      this.timer = undefined;
      this.opts.onFatal?.(e);
      return;
    }
    this.retrySoon();
  }

  /** 일시 실패 재시도 — 일시 네트워크 단절이 재시도 1회보다 길어도 루프가 죽지 않는다. */
  private retrySoon(): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.refresh().catch((e) => this.onRefreshError(e));
    }, this.opts.retryMs ?? 10_000);
    (this.timer as unknown as { unref?: () => void }).unref?.();
  }
}
