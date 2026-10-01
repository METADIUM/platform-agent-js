import { describe, it, expect } from "vitest";
import {
  MAX_CALLS_PER_HOUR_PER_AGENT,
  callsPerHourPerAgent,
  delayFor,
  nextCheckDelayMs,
  isReplacement,
  CHECK_INTERVAL_MS,
  MIN_CHECK_INTERVAL_MS,
  MAX_BACKOFF_MS,
} from "../src/delegation-refresh.js";

describe("when the daemon asks whether a newer delegation is waiting", () => {
  it("checks on a fixed interval while healthy", () => {
    expect(nextCheckDelayMs(0)).toBe(CHECK_INTERVAL_MS);
    expect(nextCheckDelayMs(-1)).toBe(CHECK_INTERVAL_MS);
  });

  it("\u{1F534} nextCheckDelayMs passes its bounds to delayFor in the right order", () => {
    // `delayFor` takes four numbers of the same unit, so a wrong order compiles and runs.
    // `[minipaas]` ran all five permutations against the assertions above and every one failed —
    // but by accident: the line that caught them was written to check the healthy interval, not
    // the wiring. **Anyone "simplifying" it would delete the only wiring guard without knowing.**
    // This says so out loud, so the guard survives being noticed.
    expect(nextCheckDelayMs(0), "interval is not in the interval slot").toBe(CHECK_INTERVAL_MS);
    expect(nextCheckDelayMs(1000), "ceiling is not in the ceiling slot").toBe(MAX_BACKOFF_MS);
    // the floor is below both, so it can only be identified by what it does NOT change
    expect(nextCheckDelayMs(0), "floor leaked into the interval slot").not.toBe(MIN_CHECK_INTERVAL_MS);
    // \u{1F534} (MIN, MAX, CHECK) survives all three assertions above — the floor masks the tiny
    //    interval at every point they sample. Only the FIRST BACKOFF STEP separates them: correct
    //    wiring doubles the interval, that one stays pinned at the floor. Measured, not reasoned.
    expect(nextCheckDelayMs(1), "the first backoff step is not twice the interval").toBe(2 * CHECK_INTERVAL_MS);
  });

  it("🔴 backs off on consecutive failures and stops at the ceiling", () => {
    // `[Briefick]` asked for this by name: an earlier agent bug turned a failing auth path into a
    // 401 storm against their RP. Unbounded retries against someone else's service is the failure
    // this guards, so the ceiling is asserted, not just the growth.
    const delays = [1, 2, 3, 4, 5, 6, 7, 8, 20].map(nextCheckDelayMs);
    expect(delays.every((d, i) => i === 0 || d >= delays[i - 1])).toBe(true);
    expect(nextCheckDelayMs(1)).toBeGreaterThan(CHECK_INTERVAL_MS);
    expect(Math.max(...delays)).toBe(MAX_BACKOFF_MS);
    expect(nextCheckDelayMs(1000)).toBe(MAX_BACKOFF_MS);
  });

  it("🔴 the floor is CLAMPED, not just true by luck of the constants", () => {
    // `[minipaas]`, review of #29: MIN_CHECK_INTERVAL_MS was referenced once — by its own
    // declaration — while its docstring promised a runtime guarantee. Adding `Math.max` fixed the
    // sentence but could not be tested through `nextCheckDelayMs`, because with the shipped
    // constants the clamp never binds: **deleting it left every test green.** These supply bounds
    // where it does bind, so removing the clamp fails.
    expect(delayFor(0, 1_000, 60_000, 30_000), "an interval below the floor was not raised").toBe(30_000);
    expect(delayFor(5, 1_000, 2_000, 30_000), "a ceiling below the floor was not raised").toBe(30_000);
    expect(delayFor(0, 90_000, 600_000, 30_000), "an interval above the floor was altered").toBe(90_000);
  });

  it("🔴 never returns a delay below the floor, at any failure count", () => {
    // The floor exists so a future edit to the growth curve cannot produce a hot loop.
    for (const n of [-5, 0, 1, 3, 10, 999]) {
      expect(nextCheckDelayMs(n), `delay for ${n} failures is below the floor`)
        .toBeGreaterThanOrEqual(MIN_CHECK_INTERVAL_MS);
    }
  });

  it("replaces on a credential, whichever word the RP uses for success", () => {
    // 🔴 briefick says "delivered"; mini-paas says "retrieved" for the same event
    // (`backend/routers/agent.py` pickup). Requiring one word made this silently never collect on
    // the other RP — the bug this loop exists to fix, re-created elsewhere.
    expect(isReplacement({ status: "delivered", credential: "vc" }), "briefick's success").toBe(true);
    expect(isReplacement({ status: "retrieved", credential: "vc" }), "mini-paas's success").toBe(true);
    expect(isReplacement({ status: "anything-new", credential: "vc" }), "an RP word we have not seen").toBe(true);
    // ⚠️ This case USED to be in the must-not-replace list, under the status-keyed design. It moved
    //    deliberately: an RP that hands back a credential without a status word has still handed
    //    back a credential, and refusing it was the same mistake as requiring "delivered".
    expect(isReplacement({ credential: "vc" }), "a credential with no status word").toBe(true);
  });

  it("🔴 briefick's ALREADY-COLLECTED answer uses the same word and must NOT replace", () => {
    // This is why keying on the payload is safe: the two spellings of "retrieved" are separated by
    // the credential being null, which is what they actually disagree about.
    expect(isReplacement({ status: "retrieved", credential: null })).toBe(false);
  });

  it("🔴 a nested lastRequest.status of 'delivered' is not a delivery", () => {
    // `[Briefick]` flagged this when answering whether any other word carries a credential:
    // briefick's `pending`/`expired` answers embed `lastRequest.status`, which CAN read
    // "delivered" — nested, with no credential. Keying on the top-level credential is what makes
    // that safe, so the near-miss is pinned rather than left as a reasoning step.
    expect(isReplacement({ status: "pending", lastRequest: { status: "delivered" } } as never)).toBe(false);
    expect(isReplacement({ status: "expired", lastRequest: { status: "delivered" } } as never)).toBe(false);
  });

  it("🔴 refuses a credential the RP has called expired", () => {
    expect(isReplacement({ status: "expired", credential: "vc" })).toBe(false);
  });

  it("🔴 keeps the working delegation for every other answer", () => {
    // Dropping a usable delegation because the RP said «pending» would be worse than the bug this
    // fixes: the agent would stop working instead of merely using an older grant.
    for (const r of [
      { status: "pending" },
      { status: "no_request" },
      { status: "expired" },
      { status: "no_agent" },
      { status: "delivered" },                 // delivered but no credential
      { status: "retrieved", credential: null },// collected already (briefick)
      { status: "delivered", credential: "" }, // delivered, empty credential
      {},
      null,
      undefined,
    ]) {
      expect(isReplacement(r as never), `treated ${JSON.stringify(r)} as a replacement`).toBe(false);
    }
  });
});

describe("the floor keeps headroom under the interval", () => {
  it("🔴 the floor is strictly below the interval, so lowering the interval is not silently clamped", () => {
    // When the interval dropped 5m → 1m the floor was also 1m. Equal values mean the next person to
    // lower the interval gets clamped back up and **cannot tell their change did nothing** — the
    // floor exists to stop a hot loop, not to override a deliberate edit without saying so.
    expect(MIN_CHECK_INTERVAL_MS, "floor is not below the interval — a lower interval would be silently clamped")
      .toBeLessThan(CHECK_INTERVAL_MS);
  });

  it("the healthy interval still lands inside briefick's 10-minute badge window", () => {
    // If a healthy agent could not collect before that badge fires, the badge would tell users to
    // discard a delegation the daemon was about to pick up (`[Briefick]`, review of #29).
    expect(CHECK_INTERVAL_MS).toBeLessThan(10 * 60 * 1000);
  });
});

describe("the request budget is enforced, not described", () => {
  it("🔴 the healthy interval stays inside the agreed per-RP ceiling", () => {
    // The basis for this number used to be a paragraph, and it took two corrections in one day:
    // a figure attributed to the wrong quantity, then a rate copied without its interval — which
    // made the comparison it supported flip sign. Halving the interval doubles the rate and fails
    // here, which is the moment to ask the party carrying the load rather than edit a sentence.
    expect(callsPerHourPerAgent(), `interval costs more than the agreed ${MAX_CALLS_PER_HOUR_PER_AGENT}/hour per agent, per RP`)
      .toBeLessThanOrEqual(MAX_CALLS_PER_HOUR_PER_AGENT);
  });

  it("the cost function is the arithmetic it claims to be", () => {
    expect(callsPerHourPerAgent(60_000)).toBe(60);
    expect(callsPerHourPerAgent(30_000)).toBe(120);
    expect(callsPerHourPerAgent(5 * 60_000)).toBe(12);
  });
});
