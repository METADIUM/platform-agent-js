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

/** How long to wait between checks while they are succeeding. */
export const CHECK_INTERVAL_MS = 60 * 60 * 1000; // 1h

/** Never check more often than this, whatever else happens. */
export const MIN_CHECK_INTERVAL_MS = 10 * 60 * 1000; // 10m

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
