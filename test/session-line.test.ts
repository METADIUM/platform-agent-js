import { describe, it, expect } from "vitest";
import { sessionLine } from "../src/cli.js";

describe("status: the session line", () => {
  it("says refreshing stopped, with the error and what fixes it for that cause (Briefick)", () => {
    const line = (stopReason: string) =>
      sessionLine({ alias: "b", connected: true, session: { stopped: true, stopReason, failures: 1, lastError: "e" } });
    expect(line("registration_gone")).toBe("✗ 세션 갱신 중지 — 재등록 필요(register --code): e");
    expect(line("delegation_refused")).toBe("✗ 세션 갱신 중지 — 지갑에서 새 위임 승인 필요: e");
    expect(line("other")).toBe("✗ 세션 갱신 중지 — 원인 확인 후 데몬 재시작: e");
  });
  it("says it is retrying, with the count", () => {
    expect(sessionLine({ alias: "b", connected: true, session: { stopped: false, failures: 3, lastError: "fetch failed" } }))
      .toBe("⚠ 세션 갱신 실패 3회, 재시도 중: fetch failed");
  });
  it("says why it isn't connected", () => {
    expect(sessionLine({ alias: "b", connected: false, pendingReason: "위임 대기" })).toBe("⏸ 세션 미연결: 위임 대기");
  });
  it("prints nothing for a healthy session, or when the daemon can't be asked", () => {
    expect(sessionLine({ alias: "b", connected: true, session: { stopped: false, failures: 0 } })).toBeNull();
    expect(sessionLine(undefined)).toBeNull();
  });
});
