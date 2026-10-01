import { describe, it, expect } from "vitest";
import {
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
