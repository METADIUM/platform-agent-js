import { describe, it, expect, afterEach, vi } from "vitest";
import { AgentAuth, MAX_RETRY_MS, isPermanentAuthFailure } from "../src/agent.js";
import { AgentClientError, type BriefickAgentClient, type SessionResult } from "../src/briefick.js";

afterEach(() => vi.useRealTimers());

/** exchange 응답 시퀀스를 순서대로 돌려주는 가짜 클라이언트("fail"은 네트워크 오류). */
function fakeClient(seq: Array<SessionResult | "fail" | Error>, retrieveStatus = "pending"):
    { client: BriefickAgentClient; calls: () => number; retrieves: () => number } {
  let i = 0;
  let r2 = 0;
  const client = {
    exchange: async () => {
      const r = seq[Math.min(i++, seq.length - 1)];
      if (r === "fail") throw new TypeError("fetch failed");
      if (r instanceof Error) throw r;
      return r;
    },
    retrieveDelegation: async () => { r2++; return { status: retrieveStatus }; },
  } as unknown as BriefickAgentClient;
  return { client, calls: () => i, retrieves: () => r2 };
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
    await vi.advanceTimersByTimeAsync(2_000); // backoff doubles → 재시도 → 성공
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
  it("401 alone is not permanent — AgentAuth asks the RP before it stops (one 401 stopped a daemon for 34 h)", () => {
    expect(isPermanentAuthFailure(new AgentClientError("… → 401: PoP", 401))).toBe(false);
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
  it("status=error is transient — Briefick answers it for a verifier poll or JWKS failure", () => {
    expect(isPermanentAuthFailure(new AgentClientError("세션 거부: error", undefined, { status: "error" }))).toBe(false);
  });
  it("⚠️ 여집합 — 네트워크 오류(TypeError)는 영구가 아니다", () => {
    expect(isPermanentAuthFailure(new TypeError("fetch failed"))).toBe(false);
  });
  it("⚠️ 여집합 — 폴링 타임아웃(httpStatus 없음, 거부도 아님)은 영구가 아니다", () => {
    expect(isPermanentAuthFailure(new AgentClientError("세션 완료 타임아웃"))).toBe(false);
  });
});

describe("AgentAuth — 영구 실패에서 루프가 멈춘다", () => {
  it("🔴 401 confirmed by retrieve → no_agent: stop and call onFatal (9일 74,781건 버그)", async () => {
    vi.useFakeTimers();
    const revoked = new AgentClientError("POST /session/start → 401: 회수", 401, { error: "registration_revoked" });
    const { client, calls } = fakeClient([issued("A", 10_000), revoked], "no_agent");
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
    expect(auth.state().stopReason).toBe("registration_gone");
  });

  it("🔴 401 while the RP still knows the agent: retry with backoff, never stop (Briefick, 34 h outage)", async () => {
    vi.useFakeTimers();
    const pop = new AgentClientError("POST /session/complete → 401: 소유증명(PoP) 검증 실패", 401);
    const { client, retrieves } = fakeClient([issued("A", 10_000), pop, pop, issued("B", 10_000)], "pending");
    const fatals: unknown[] = [];
    const auth = new AgentAuth({ client, credential: "VC~", retryMs: 1_000, onFatal: (e) => fatals.push(e) });
    await auth.start();
    await vi.advanceTimersByTimeAsync(5_000);   // 401 #1 → retrieve says pending → retry in 1 s
    await vi.advanceTimersByTimeAsync(1_000);   // 401 #2 → retry in 2 s
    expect(auth.state().failures).toBe(2);
    expect(auth.state().lastError).toContain("PoP");
    await vi.advanceTimersByTimeAsync(2_000);   // success
    expect(fatals, "a passing 401 stopped refreshing").toEqual([]);
    expect(retrieves()).toBe(2);
    expect(auth.bearer()).toBe("B");
    expect(auth.state()).toMatchObject({ stopped: false, failures: 0 });
    auth.stop();
  });

  it("a refused delegation stops with delegation_refused, so status asks for a new delegation, not re-registration", async () => {
    vi.useFakeTimers();
    const refused = new AgentClientError("세션 거부: revoked", undefined, { status: "rejected", reasons: ["revoked"] });
    const { client } = fakeClient([issued("A", 10_000), refused]);
    const auth = new AgentAuth({ client, credential: "VC~", retryMs: 1_000 });
    await auth.start();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(auth.state()).toMatchObject({ stopped: true, stopReason: "delegation_refused" });
  });

  it("backoff doubles per consecutive failure and stops growing at MAX_RETRY_MS", async () => {
    vi.useFakeTimers();
    const { client, calls } = fakeClient([issued("A", 10_000), "fail"]);
    const auth = new AgentAuth({ client, credential: "VC~", retryMs: 1_000 });
    await auth.start();
    await vi.advanceTimersByTimeAsync(5_000);          // failure 1 at t=5 s
    const at = (n: number) => { let t = 0; for (let k = 1; k < n; k++) t += Math.min(MAX_RETRY_MS, 1_000 * 2 ** (k - 1)); return t; };
    await vi.advanceTimersByTimeAsync(at(12));          // 11 more retries
    expect(calls()).toBe(1 + 12);
    await vi.advanceTimersByTimeAsync(MAX_RETRY_MS - 1);
    expect(calls(), "retried before the ceiling").toBe(13);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls()).toBe(14);
    auth.stop();
  });

  it("an expired bearer is not handed out — the daemon answers 503 instead of forwarding it", async () => {
    vi.useFakeTimers();
    const { client } = fakeClient([issued("A", 10_000), "fail"]);
    const auth = new AgentAuth({ client, credential: "VC~", retryMs: 60_000 });
    await auth.start();
    expect(auth.bearer()).toBe("A");
    await vi.advanceTimersByTimeAsync(10_001);
    expect(() => auth.bearer()).toThrow(/세션 만료/);
    auth.stop();
  });

  it("🟢 네트워크 실패는 종전대로 재시도한다 (일시 실패는 안 죽는다)", async () => {
    vi.useFakeTimers();
    const { client } = fakeClient([issued("A", 10_000), "fail", "fail", issued("B", 10_000)]);
    const fatals: unknown[] = [];
    const auth = new AgentAuth({ client, credential: "VC~", retryMs: 1_000, onFatal: (e) => fatals.push(e) });
    await auth.start();
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(auth.bearer()).toBe("B");            // 재시도로 회복
    expect(fatals.length).toBe(0);              // 영구 아님
    auth.stop();
  });
});
