/**
 * When the daemon asks whether a **newer** delegation is waiting.
 *
 * The daemon used to retrieve only when it held nothing, so a delegation approved afterwards was
 * never collected and the limit the user chose was silently not applied (measured in production,
 * 2026-10-01: `retrieve` called 0 times while two 30-day grants sat in `delivered`).
 *
 * ⚠️ Retrieving is not free to repeat: the RP moves the delegation to `retrieved` and deletes its
 * copy in the same update, so a successful check **consumes** it. The caller must persist before
 * doing anything else.
 *
 * 📌 Background and the measurements behind the numbers: `platform-docs`, agent delegation.
 */

/**
 * How long to wait between checks while they are succeeding.
 *
 * ⚠️ Must stay inside briefick's 10-minute "not collected" badge window, or a healthy agent trips a
 * badge telling the user to discard a delegation it is about to collect. Pinned by a test.
 * ⚠️ Must stay inside {@link MAX_CALLS_PER_HOUR_PER_RP}. Also pinned by a test.
 */
export const CHECK_INTERVAL_MS = 60 * 1000; // 1m

/**
 * Never check more often than this.
 *
 * ⚠️ Kept strictly below {@link CHECK_INTERVAL_MS} — equal values would silently clamp a deliberate
 * reduction of the interval, so the editor could not see their change did nothing. Pinned by a test.
 * ⚠️ Only applies to delays from {@link nextCheckDelayMs}; one computed elsewhere is outside it.
 */
export const MIN_CHECK_INTERVAL_MS = 15 * 1000; // 15s

/** Backoff ceiling — a persistently failing agent still asks, but rarely. */
export const MAX_BACKOFF_MS = 6 * 60 * 60 * 1000; // 6h

/**
 * The ceiling {@link CHECK_INTERVAL_MS} must stay inside, in requests per hour per RP.
 *
 * ⚠️ 60 is **[Briefick]'s judgement, not a benchmark**: they measured their load (0.24) and total
 * traffic (872 requests over ~6h to 05:47Z, 2026-10-01) but **not the cost per request** — their
 * logs carry no response time. Their estimate is "fine to ~100 agents".
 *
 * ⇒ Halving the interval doubles the rate and fails the test, which is when to ask them again.
 */
export const MAX_CALLS_PER_HOUR_PER_RP = 60;

/** What {@link CHECK_INTERVAL_MS} costs an RP per hour while healthy. */
export function callsPerHourPerRp(intervalMs: number = CHECK_INTERVAL_MS): number {
  return 3_600_000 / intervalMs;
}

/**
 * The schedule, with its bounds passed in so the floor clamp is reachable by a test.
 *
 * `consecutiveFailures` counts transport or server failures. A `pending` answer is a success — the
 * question was asked and answered — and backing off there would slow the loop while the user is
 * approving.
 */
export function delayFor(
  consecutiveFailures: number,
  interval: number,
  ceiling: number,
  floor: number,
): number {
  const base =
    consecutiveFailures <= 0
      ? interval
      : Math.min(interval * 2 ** Math.min(consecutiveFailures, 10), ceiling);
  return Math.max(floor, base);
}

export function nextCheckDelayMs(consecutiveFailures: number): number {
  return delayFor(consecutiveFailures, CHECK_INTERVAL_MS, MAX_BACKOFF_MS, MIN_CHECK_INTERVAL_MS);
}

/**
 * Whether a retrieval result carries a delegation the daemon should switch to.
 *
 * 🔴 Keyed on the **credential**, not on a status word: briefick spells success `delivered`,
 * mini-paas spells the same thing `retrieved`. Requiring one word made this silently never collect
 * on the other RP. briefick's *already collected* answer is also `retrieved` but carries
 * `credential: null`, so the payload separates them where the word does not.
 *
 * ⚠️ `expired` is refused even with a credential — installing something the RP just called expired
 * would act against what it told us.
 */
export function isReplacement(r: { status?: string; credential?: string | null } | null | undefined): boolean {
  if (!r || typeof r.credential !== "string" || r.credential.length === 0) return false;
  return r.status !== "expired";
}
