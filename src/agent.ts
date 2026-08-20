/**
 * 고수준 에이전트 인증 — 위임 VC로 짧은 TTL bearer를 교환하고 만료 전 자동 재교환한다.
 * MCP 클라이언트는 "고정 헤더" 하나만 등록하므로, `onRefresh`로 갱신된 bearer를 설정에 반영하면 된다.
 */
import { BriefickAgentClient, type SessionResult } from "./briefick.js";

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
  /** 실패 재시도 간격 ms(기본 10s). */
  retryMs?: number;
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
      this.refresh().catch((e) => {
        this.opts.onError?.(e);
        this.retrySoon();
      });
    }, delay);
    // Node에서 프로세스 종료를 막지 않도록
    (this.timer as unknown as { unref?: () => void }).unref?.();
  }

  /** 갱신 실패 시 성공할 때까지 재시도 — 일시 네트워크 단절이 재시도 1회보다 길어도 루프가 죽지 않는다. */
  private retrySoon(): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.refresh().catch((e) => {
        this.opts.onError?.(e);
        this.retrySoon();
      });
    }, this.opts.retryMs ?? 10_000);
    (this.timer as unknown as { unref?: () => void }).unref?.();
  }
}
