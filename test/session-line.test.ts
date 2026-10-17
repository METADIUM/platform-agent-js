import { describe, it, expect } from "vitest";
import { sessionLine } from "../src/cli.js";

describe("status: the session line", () => {
  it("says why it isn't connected", () => {
    expect(sessionLine({ alias: "b", connected: false, pendingReason: "위임 대기" })).toBe("⏸ 세션 미연결: 위임 대기");
  });
  it("prints nothing for a healthy session, or when the daemon can't be asked", () => {
    expect(sessionLine({ alias: "b", connected: true, session: { status: "active" } as never })).toBeNull();
    // A daemon still on a pre-removal build reports a v0 session (no `status`): no line, and no crash.
    expect(sessionLine({ alias: "b", connected: true, session: { stopped: true, failures: 1 } as never })).toBeNull();
    expect(sessionLine(undefined)).toBeNull();
  });
});
