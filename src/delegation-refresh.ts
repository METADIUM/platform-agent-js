/**
 * When the daemon should ask whether a **newer** delegation is waiting.
 *
 * 🔴 The daemon used to retrieve a delegation only when it had none cached
 * (`cli.ts`: `if (!credential) waitCredential(...)`). So once an agent held any working
 * delegation it never looked again — and a delegation the user approved afterwards sat in
 * `delivered` until its 12-hour collection window expired and was dropped.
 *
 * Measured in production on 0.5.7 / pmvm-02 (`[Briefick]`, 2026-10-01): the user approved
 * 30-day delegations at 03:06 and 03:14, both reached `delivered`, and
 * `POST /api/agent/delegation/retrieve` was called **zero** times after 03:00 while
 * `session/start` and `complete` kept returning 200 on the previously cached, open-ended
 * delegation. ⇒ **The limit the user chose was never applied, and nothing said so.** The only
 * escape was `credentials clear`, which a user has no reason to know about.
 *
 * ⚠️ Retrieving is **not** free to repeat: the RP transitions `delivered → retrieved` and deletes
 * its copy, so a successful check consumes the credential. The caller must persist it before
 * doing anything else — losing it after that transition loses the user's approval, and they
 * would have to approve again without being told why.
 *
 * ⚠️ And this adds a recurring call to an authenticated endpoint. `[Briefick]` asked for a cap
 * and backoff explicitly, because an earlier agent bug turned a failing auth path into a 401
 * storm against their RP. Hence {@link nextCheckDelayMs}: a fixed interval while healthy, and
 * exponential backoff with a ceiling once it starts failing.
 */

/**
 * How long to wait between checks while they are succeeding.
 *
 * 🔴 **This is a cross-repo contract, not a free parameter.** briefick shows a badge when a
 * delegation has been approved for 10 minutes, the agent is still connected, and nothing has been
 * retrieved — telling the user to run `credentials clear`. At the 1h interval this started with,
 * a healthy agent on this version would trip that badge for **50 minutes out of every hour**,
 * telling the user to throw away a delegation the daemon was about to collect by itself. That is
 * the expensive direction of a wrong message (`[Briefick]`, review of #29).
 *
 * ⇒ The check must land **inside** their badge window, not outside it. At 5 minutes a healthy
 * agent always collects before the badge can fire, so briefick needs no version-conditional logic,
 * and the badge keeps meaning what it says: *this agent is not collecting* — which, on this
 * version, is true only when the loop is backing off or failing, and `credentials clear` is then
 * reasonable advice because it routes through `connectTarget` instead.
 *
 * ⚠️ The cost is small enough to measure rather than argue about: 12 calls/hour/RP, against the
 * ~20/hour of `session/start` + `complete` that pmvm-02 was already making.
 */
export const CHECK_INTERVAL_MS = 5 * 60 * 1000; // 5m

/**
 * Never check more often than this, whatever else happens.
 *
 * ⚠️ Not binding today ({@link CHECK_INTERVAL_MS} is above it). It exists so that a later edit to
 * the interval or the backoff curve cannot produce a hot loop against someone else's service.
 */
export const MIN_CHECK_INTERVAL_MS = 60 * 1000; // 1m

/** Backoff ceiling — a persistently failing agent still asks, but rarely. */
export const MAX_BACKOFF_MS = 6 * 60 * 60 * 1000; // 6h

/**
 * Delay until the next check.
 *
 * `consecutiveFailures` counts *transport or server* failures, not "no newer delegation" —
 * a healthy `pending` answer is a success, because the question was asked and answered.
 */
export function nextCheckDelayMs(consecutiveFailures: number): number {
  if (consecutiveFailures <= 0) return CHECK_INTERVAL_MS;
  const backed = CHECK_INTERVAL_MS * 2 ** Math.min(consecutiveFailures, 10);
  return Math.min(backed, MAX_BACKOFF_MS);
}

/**
 * Whether a retrieval result carries a delegation the daemon should switch to.
 *
 * 🔴 Only `delivered` with a credential counts. `pending`, `no_request`, `expired` and
 * `no_agent` all mean *keep what you have* — treating any of them as "replace" would drop a
 * working delegation for nothing, which is worse than the bug this fixes.
 */
export function isReplacement(r: { status?: string; credential?: string } | null | undefined): boolean {
  return !!r && r.status === "delivered" && typeof r.credential === "string" && r.credential.length > 0;
}
