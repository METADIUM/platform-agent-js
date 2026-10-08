import { describe, it, expect } from "vitest";
import { sessionLine } from "../src/cli.js";

describe("status: the session line", () => {
  it("says refreshing stopped, with the error, instead of leaving «위임 유효» alone", () => {
    expect(sessionLine({ alias: "b", connected: true, session: { stopped: true, failures: 1, lastError: "401: PoP" } }))
      .toBe("✗ 세션 갱신 중지 — 재등록 필요(register --code): 401: PoP");
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
