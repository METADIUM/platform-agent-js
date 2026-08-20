import { describe, it, expect, afterEach, vi } from "vitest";
import { AgentAuth } from "../src/agent.js";
import type { BriefickAgentClient, SessionResult } from "../src/briefick.js";

afterEach(() => vi.useRealTimers());

/** exchange 응답 시퀀스를 순서대로 돌려주는 가짜 클라이언트("fail"은 네트워크 오류). */
function fakeClient(seq: Array<SessionResult | "fail">): { client: BriefickAgentClient; calls: () => number } {
  let i = 0;
  const client = {
    exchange: async () => {
      const r = seq[Math.min(i++, seq.length - 1)];
      if (r === "fail") throw new TypeError("fetch failed");
      return r;
    },
  } as unknown as BriefickAgentClient;
  return { client, calls: () => i };
}

function issued(bearer: string, ttlMs: number): SessionResult {
  return { status: "issued", bearer, expiresAt: new Date(Date.now() + ttlMs).toISOString() };
}

describe("AgentAuth 자동 갱신", () => {
  it("갱신 실패가 연속돼도 성공할 때까지 재시도(루프가 죽지 않음)", async () => {
    vi.useFakeTimers();
    // 첫 발급 성공 → 스케줄된 갱신 2회 연속 실패 → 3번째 재시도 성공
    const { client } = fakeClient([issued("A", 10_000), "fail", "fail", issued("B", 10_000)]);
    const errors: unknown[] = [];
    const auth = new AgentAuth({ client, credential: "VC~", retryMs: 1_000, onError: (e) => errors.push(e) });
    await auth.start();
    expect(auth.bearer()).toBe("A");

    await vi.advanceTimersByTimeAsync(5_000); // 스케줄 갱신(최소 5s) → 실패 1
    expect(errors.length).toBe(1);
    await vi.advanceTimersByTimeAsync(1_000); // 재시도 → 실패 2 (구버전은 여기서 루프 종료)
    expect(errors.length).toBe(2);
    await vi.advanceTimersByTimeAsync(1_000); // 재시도 → 성공
    expect(auth.bearer()).toBe("B");
    auth.stop();
  });

  it("stop() 후에는 재시도하지 않는다", async () => {
    vi.useFakeTimers();
    const { client, calls } = fakeClient([issued("A", 10_000), "fail"]);
    const auth = new AgentAuth({ client, credential: "VC~", retryMs: 1_000 });
    await auth.start();
    await vi.advanceTimersByTimeAsync(5_000); // 실패 1 → 재시도 예약
    auth.stop();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls()).toBe(2); // 최초 + 실패 1회뿐
  });
});
