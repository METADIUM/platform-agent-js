import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { watchForNewerDelegation } from "../src/cli.js";
import { CHECK_INTERVAL_MS } from "../src/delegation-refresh.js";

/**
 * 🔴 The decision module is locked by its own tests, and that is not enough: deleting the
 * `void watchForNewerDelegation(...)` line from the daemon left **all 180 tests green**. The same
 * shape as `upgradeIo()` (#22) and `agentClient()` (#24) — a thing wired inline is invisible to
 * every test that builds its own. These drive the loop itself.
 */
const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };

describe("the daemon's watch for a newer delegation", () => {
  let target: { auth: { bearer(): string } | null; pendingReason?: string };
  let store: { save: ReturnType<typeof vi.fn> };
  let data: { credentials?: Record<string, string> };
  let saved: string | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
    target = { auth: { bearer: () => "b" } };
    // 🔴 Capture what was on `data` AT THE MOMENT of the save. Asserting «the credential is set»
    //    and «save was called» separately passes even if save runs first and writes the OLD value —
    //    measured: swapping those two lines left this file green until this snapshot was added.
    store = { save: vi.fn((d: { credentials?: Record<string, string> }) => { saved = d.credentials?.["https://rp.example"]; }) };
    saved = undefined;
    data = { credentials: { "https://rp.example": "OLD" } };
  });
  afterEach(() => vi.useRealTimers());

  const run = (retrieveDelegation: ReturnType<typeof vi.fn>) => {
    void watchForNewerDelegation(
      target as never,
      { retrieveDelegation } as never,
      data as never,
      { url: "https://rp.example", alias: "rp" } as never,
      store as never,
      {} as never,
    );
    return retrieveDelegation;
  };

  it("🔴 asks the RP once the interval has passed — the whole point of the fix", async () => {
    const r = run(vi.fn().mockResolvedValue({ status: "pending" }));
    expect(r, "asked before the interval elapsed").not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS);
    await flush();
    expect(r, "never asked the RP — the daemon would keep the stale delegation forever").toHaveBeenCalled();
  });

  it("🔴 persists a delivered credential BEFORE reconnecting", async () => {
    // Order is the property: the RP has already deleted its copy by the time this resolves, so a
    // save that happens after anything else can be lost — and the user's approval with it.
    const r = run(vi.fn().mockResolvedValue({ status: "delivered", credential: "NEW" }));
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS);
    await flush();
    expect(data.credentials?.["https://rp.example"], "the new delegation was not stored").toBe("NEW");
    expect(store.save, "stored in memory but never written to disk").toHaveBeenCalled();
    expect(saved, "saved to disk BEFORE the new credential was set — a crash here loses the user's approval")
      .toBe("NEW");
  });

  it("🔴 keeps the working delegation when the RP says pending", async () => {
    const r = run(vi.fn().mockResolvedValue({ status: "pending" }));
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS);
    await flush();
    expect(data.credentials?.["https://rp.example"], "dropped a usable delegation for a pending answer").toBe("OLD");
    expect(store.save).not.toHaveBeenCalled();
  });

  it("does not ask while disconnected — connectTarget is already polling the same endpoint", async () => {
    target.auth = null;
    const r = run(vi.fn().mockResolvedValue({ status: "delivered", credential: "NEW" }));
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS * 2);
    await flush();
    expect(r, "raced connectTarget for the same delivered credential").not.toHaveBeenCalled();
  });
});

describe("how the watch treats answers that are not a replacement", () => {
  let target: { auth: { bearer(): string } | null };
  let store: { save: ReturnType<typeof vi.fn> };
  let data: { credentials?: Record<string, string> };

  beforeEach(() => {
    vi.useFakeTimers();
    target = { auth: { bearer: () => "b" } };
    store = { save: vi.fn() };
    data = { credentials: { "https://rp.example": "OLD" } };
  });
  afterEach(() => vi.useRealTimers());

  const run = (retrieveDelegation: ReturnType<typeof vi.fn>) => {
    void watchForNewerDelegation(
      target as never, { retrieveDelegation } as never, data as never,
      { url: "https://rp.example", alias: "rp" } as never, store as never, {} as never,
    );
    return retrieveDelegation;
  };

  it("🔴 does NOT back off while the user is still approving (pending)", async () => {
    // `[Briefick]`, review of #29: the docstring claimed this and nothing tested it — inverting
    // `failures = 0` to `failures++` left the file green. Backing off here would slow the loop
    // down at exactly the moment the user is waiting for their approval to take effect.
    const r = run(vi.fn().mockResolvedValue({ status: "pending" }));
    for (let i = 1; i <= 3; i++) {
      await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS);
      for (let k = 0; k < 5; k++) await Promise.resolve();
      expect(r, `after ${i} pending answers the interval had already grown`).toHaveBeenCalledTimes(i);
    }
  });

  it("🔴 DOES back off on no_agent — a revoked registration never recovers by asking again", async () => {
    // 200, but not healthy. Treated as healthy it polls every 5 minutes forever and logs on the
    // RP every time (`[Briefick]`, review of #29 — the weak form of a 401 storm).
    const r = run(vi.fn().mockResolvedValue({ status: "no_agent" }));
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS);
    for (let k = 0; k < 5; k++) await Promise.resolve();
    expect(r).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS);
    for (let k = 0; k < 5; k++) await Promise.resolve();
    expect(r, "asked again at the healthy interval — no_agent did not back off").toHaveBeenCalledTimes(1);
  });
});
