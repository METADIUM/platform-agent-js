import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { CONSTRAINT_REFUSALS, constraintRefusalAction } from "../src/constraint-refusal.js";
import { connectTarget } from "../src/cli.js";
import { AgentClientError } from "../src/briefick.js";

describe("constraintRefusalAction (spec §11.1)", () => {
  it("maps each code to the table's action", () => {
    expect(CONSTRAINT_REFUSALS).toEqual({
      constraints_missing: "drop",
      constraints_malformed: "drop",
      constraints_not_atomic: "drop",
      constraints_unknown_key: "keep",
    });
    for (const [code, action] of Object.entries(CONSTRAINT_REFUSALS)) {
      expect(constraintRefusalAction([code]), code).toBe(action);
    }
  });

  it("drop wins over keep, and anything else is not a constraint refusal", () => {
    expect(constraintRefusalAction(["constraints_unknown_key", "constraints_malformed"])).toBe("drop");
    expect(constraintRefusalAction(["scope_malformed", 42, null])).toBeNull();
    expect(constraintRefusalAction(["__proto__", "toString", "constructor"])).toBeNull();
    expect(constraintRefusalAction([])).toBeNull();
  });
});

describe("the daemon on a session refused for its constraints", () => {
  const URL = "https://rp.example";
  let data: { credentials?: Record<string, string> };
  let store: { save: ReturnType<typeof vi.fn> };
  let target: { auth: unknown; pendingReason?: string };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, "error").mockImplementation(() => {});
    data = { credentials: { [URL]: "OLD" } };
    store = { save: vi.fn() };
    target = { auth: null };
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const rejected = (code: string) =>
    new AgentClientError(`세션 거부: ${code}`, undefined, { status: "rejected", reasons: [code] });
  const issued = { status: "issued", bearer: "b", expiresAt: new Date(Date.now() + 3_600_000).toISOString() };

  const run = (exchange: ReturnType<typeof vi.fn>, waitForDelegation: ReturnType<typeof vi.fn>) =>
    connectTarget(
      target as never,
      { exchange, waitForDelegation } as never,
      data as never,
      { url: URL, alias: "rp" } as never,
      store as never,
      { fingerprint: "fp" } as never,
    );

  it("🔴 keep: the VC stays on disk and is never presented again in a loop", async () => {
    let deliver!: (c: string) => void;
    const waitForDelegation = vi.fn(() => new Promise<string>((r) => { deliver = r; }));
    const exchange = vi.fn().mockRejectedValueOnce(rejected("constraints_unknown_key")).mockResolvedValue(issued);
    const done = run(exchange, waitForDelegation);

    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(exchange.mock.calls.map((c) => c[0]), "the refused VC was presented again — a retry loop").toEqual(["OLD"]);
    expect(data.credentials?.[URL], "a keep-class refusal deleted the VC").toBe("OLD");
    expect(store.save, "a keep-class refusal rewrote the store").not.toHaveBeenCalled();
    expect(target.pendingReason, "the user is not told which limit").toContain("constraints_unknown_key");
    expect(waitForDelegation, "not waiting for a new delegation").toHaveBeenCalled();

    deliver("NEW");
    await done;
    expect(exchange.mock.calls.map((c) => c[0]), "a new delegation does not replace the held one").toEqual(["OLD", "NEW"]);
  });

  it("drop: the VC is discarded and a new delegation is awaited (control)", async () => {
    const waitForDelegation = vi.fn().mockResolvedValue("NEW");
    const exchange = vi.fn().mockRejectedValueOnce(rejected("constraints_not_atomic")).mockResolvedValue(issued);
    await run(exchange, waitForDelegation);
    expect(exchange.mock.calls.map((c) => c[0])).toEqual(["OLD", "NEW"]);
    expect(store.save, "the dropped VC was never removed from disk").toHaveBeenCalled();
    expect(data.credentials?.[URL]).toBe("NEW");
  });
});
