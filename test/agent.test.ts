import { describe, it, expect, afterEach, vi } from "vitest";
import { AgentAuth, isPermanentAuthFailure } from "../src/agent.js";
import { AgentClientError, type BriefickAgentClient, type SessionResult } from "../src/briefick.js";

afterEach(() => vi.useRealTimers());

/** exchange 응답 시퀀스를 순서대로 돌려주는 가짜 클라이언트("fail"은 네트워크 오류). */
function fakeClient(seq: Array<SessionResult | "fail" | Error>): { client: BriefickAgentClient; calls: () => number } {
  let i = 0;
  const client = {
    exchange: async () => {
      const r = seq[Math.min(i++, seq.length - 1)];
      if (r === "fail") throw new TypeError("fetch failed");
      if (r instanceof Error) throw r;
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


describe("isPermanentAuthFailure — 「다시 보내면 달라지는가」", () => {
  it("401(등록 회수)은 영구다 — 재시도가 못 고친다", () => {
    expect(isPermanentAuthFailure(new AgentClientError("… → 401: 회수", 401, { error: "registration_revoked" }))).toBe(true);
  });
  it("403·404 도 영구다", () => {
    expect(isPermanentAuthFailure(new AgentClientError("403", 403))).toBe(true);
    expect(isPermanentAuthFailure(new AgentClientError("404", 404))).toBe(true);
  });
  it("408·429 는 4xx 지만 일시적이다 — 콜백 규칙과 같다", () => {
    expect(isPermanentAuthFailure(new AgentClientError("408", 408))).toBe(false);
    expect(isPermanentAuthFailure(new AgentClientError("429", 429))).toBe(false);
  });
  it("5xx 는 일시적이다", () => {
    expect(isPermanentAuthFailure(new AgentClientError("503", 503))).toBe(false);
  });
  it("세션 거부(httpStatus 없음, status=rejected)는 영구다", () => {
    expect(isPermanentAuthFailure(new AgentClientError("세션 거부", undefined, { status: "rejected" }))).toBe(true);
  });
  it("⚠️ 여집합 — 네트워크 오류(TypeError)는 영구가 아니다", () => {
    expect(isPermanentAuthFailure(new TypeError("fetch failed"))).toBe(false);
  });
  it("⚠️ 여집합 — 폴링 타임아웃(httpStatus 없음, 거부도 아님)은 영구가 아니다", () => {
    expect(isPermanentAuthFailure(new AgentClientError("세션 완료 타임아웃"))).toBe(false);
  });
});

describe("AgentAuth — 영구 실패에서 루프가 멈춘다", () => {
  it("🔴 401 이면 재시도하지 않고 onFatal 을 부른다 (9일 74,781건 버그)", async () => {
    vi.useFakeTimers();
    const revoked = new AgentClientError("POST /session/start → 401: 회수", 401, { error: "registration_revoked" });
    const { client, calls } = fakeClient([issued("A", 10_000), revoked]);
    const errors: unknown[] = [];
    const fatals: unknown[] = [];
    const auth = new AgentAuth({ client, credential: "VC~", retryMs: 1_000,
      onError: (e) => errors.push(e), onFatal: (e) => fatals.push(e) });
    await auth.start();
    await vi.advanceTimersByTimeAsync(5_000);   // 스케줄 갱신 → 401
    expect(errors.length).toBe(1);
    expect(fatals.length).toBe(1);              // 영구 실패 통지
    await vi.advanceTimersByTimeAsync(60_000);  // 한참 기다려도
    expect(calls()).toBe(2);                    // 최초 + 401 1회뿐 — **재시도 없음**
    expect(errors.length).toBe(1);              // onError 도 더는 안 온다(조용한 무한루프의 반대)
  });

  it("🟢 네트워크 실패는 종전대로 재시도한다 (일시 실패는 안 죽는다)", async () => {
    vi.useFakeTimers();
    const { client } = fakeClient([issued("A", 10_000), "fail", "fail", issued("B", 10_000)]);
    const fatals: unknown[] = [];
    const auth = new AgentAuth({ client, credential: "VC~", retryMs: 1_000, onFatal: (e) => fatals.push(e) });
    await auth.start();
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(auth.bearer()).toBe("B");            // 재시도로 회복
    expect(fatals.length).toBe(0);              // 영구 아님
    auth.stop();
  });
});
