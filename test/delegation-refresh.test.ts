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

  it("replaces only on delivered WITH a credential", () => {
    expect(isReplacement({ status: "delivered", credential: "vc" })).toBe(true);
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
      { status: "delivered", credential: "" }, // delivered, empty credential
      { credential: "vc" },                    // credential but no status
      {},
      null,
      undefined,
    ]) {
      expect(isReplacement(r as never), `treated ${JSON.stringify(r)} as a replacement`).toBe(false);
    }
  });
});
