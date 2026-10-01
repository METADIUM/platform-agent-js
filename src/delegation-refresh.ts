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
 * ⇒ The check must land **inside** their badge window, not outside it. A healthy agent always
 * collects before the badge can fire, so briefick needs no version-conditional logic, and the badge
 * keeps meaning what it says: *this agent is not collecting* — true, on this version, only when
 * the loop is backing off or failing.
 *
 * 🔴 **Lowered 5m → 1m** because 5 minutes could not be called "immediate" and the first fix
 * proposed for that did not work. The idea was to poll fast while the RP reports `pending`, since
 * `lastRequest` already says a user is approving — but **learning that a request is pending happens
 * on the same slow tick**. By the time the tick lands, the approval has usually completed and the
 * answer is already `delivered`. ⇒ The signal is in the response and arrives too late to act on;
 * only the interval itself moves the worst case (`[Briefick]`, who refuted it with the numbers:
 * the approval window is 300s, and issue→approve is typically tens of seconds).
 *
 * ⚠️ The cost, measured rather than argued: **60 calls/hour/RP**, up from 12, against the
 * ~20/hour of `session/start` + `complete` that pmvm-02 was already making. Worst case to collect
 * a newly approved delegation drops from ~5 minutes to ~1.
 *
 * 📌 Long-polling would give seconds instead of a minute, and was not taken: it needs changes on
 * both sides, holds a connection open per agent, and makes proxy read timeouts a shared concern.
 * Its advantage over this is only visible to someone watching the agent in the seconds after
 * approving, and **nobody has measured how often that happens**.
 */
export const CHECK_INTERVAL_MS = 60 * 1000; // 1m

/**
 * Never check more often than this — clamped in {@link nextCheckDelayMs}, not merely asserted.
 *
 * ⚠️ Not binding today ({@link CHECK_INTERVAL_MS} is above it). It exists so that a later edit to
 * the interval or the backoff curve cannot produce a hot loop against someone else's service.
 * ⚠️ A delay computed anywhere other than {@link nextCheckDelayMs} is still outside this floor.
 *
 * 🔴 **Kept strictly below {@link CHECK_INTERVAL_MS}, and a test pins that.** When the interval
 * dropped to 1m this was also 1m, which would have made them equal — and then anyone lowering the
 * interval further gets **silently clamped back up** and cannot see that their change did nothing.
 * The floor is meant to stop a hot loop, not to quietly override a deliberate edit.
 */
export const MIN_CHECK_INTERVAL_MS = 15 * 1000; // 15s

/** Backoff ceiling — a persistently failing agent still asks, but rarely. */
export const MAX_BACKOFF_MS = 6 * 60 * 60 * 1000; // 6h

/**
 * Delay until the next check.
 *
 * `consecutiveFailures` counts *transport or server* failures, not "no newer delegation" —
 * a healthy `pending` answer is a success, because the question was asked and answered.
 */
/**
 * The schedule, with its bounds passed in.
 *
 * 🔴 Separated so the **clamp can be tested**. `[minipaas]` found that
 * {@link MIN_CHECK_INTERVAL_MS} was referenced exactly once — by its own declaration — while its
 * docstring promised "whatever else happens", which reads as a runtime guarantee it did not give.
 * Adding `Math.max` fixed the sentence and created a second problem: with today's constants the
 * clamp never binds, so **deleting it left every test green**. A guard nothing can reach is the
 * thing this repo keeps removing.
 *
 * ⇒ With `floor` as an argument a test can supply constants where the clamp *does* bind, so the
 * floor is enforced in code **and** that enforcement fails when removed.
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
 * 🔴 **Keyed on the credential, not on the status word — because the word is per-RP.**
 * This first required `status === "delivered"`, which is briefick's vocabulary. Measured against
 * the only other RP implementation in reach, mini-paas (`backend/routers/agent.py`), whose pickup
 * returns `{"status": "retrieved", "credential": …}` for the **same** success:
 *
 * ```
 *                            briefick                      mini-paas
 * success                    "delivered" + credential      "retrieved" + credential
 * already collected          "retrieved" + null            "retrieved" + null
 * ```
 *
 * ⇒ Requiring `"delivered"` would have made this loop **silently never collect** on an RP using
 * the other word — the exact bug it was written to fix, re-created for a different RP and with no
 * symptom on this side. A delegation is the credential; the word around it is not a contract we
 * control. (Raised by the user: this change is for every RP, not only the one that reported it.)
 *
 * 🟢 And keying on the credential stays correct for briefick's *already collected* case, because
 * that carries `credential: null` — so the two spellings of "retrieved" are separated by the
 * payload rather than by the word, which is what they actually disagree about.
 *
 * ⚠️ `expired` is still refused even if a credential appears: installing a delegation the RP has
 * just called expired would be acting against what it told us, and no RP in reach does that.
 */
export function isReplacement(r: { status?: string; credential?: string | null } | null | undefined): boolean {
  if (!r || typeof r.credential !== "string" || r.credential.length === 0) return false;
  return r.status !== "expired";
}
