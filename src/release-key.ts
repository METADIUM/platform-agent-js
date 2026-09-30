/**
 * Release signing keys this build trusts, compiled in so `upgrade` can verify without `minisign`.
 *
 * 🔴 **This is a list, not a key, and that is the whole rotation plan.** A binary trusts exactly
 * what is compiled into it. With one key, rotating means every installed binary refuses every new
 * release and cannot upgrade out of it — and the escape hatch (`install.sh`) **requires the
 * `minisign` tool again**, so the rotation day is the one day the dependency this command removed
 * comes back (`[Briefick]`, review of #22).
 *
 * ⇒ To rotate: add the new key to this list, ship a release signed by the **current** key, let it
 * propagate, and only then start signing with the new one. Binaries that took the intermediate
 * release accept both; binaries older than it still cannot, and for those `install.sh` is the only
 * route.
 *
 * 🔴 **"Let it propagate" is the one step with no completion condition**, and it is the step the
 * whole plan turns on — switching too early strands every install that missed the window, and the
 * failure is silent until the day they upgrade, where it looks like a corrupted download
 * (`[metapass-saas]`, review of #22).
 *
 * ⚠️ An earlier version of this paragraph added *"this is what has blocked their own key
 * rotation — not the crypto, and not a decision, but having no way to measure what is
 * installed"*. **That was false about them.** Their review said the step has no completion
 * condition **in this plan**; I turned it into a claim about their rotation, which is a different
 * key (an Android app signing key, not a release signing key), a different procedure, and a
 * different blocker — comparing certificate fingerprints against Play Console lists, which needs
 * console access nobody here has. Propagation measurement is not in front of it; that procedure
 * has no "what fraction of installs" question at all. It read as corroboration from a second site
 * and there was no second site.
 *
 * 🔴 The retraction stays here because the first attempt to make it did not reach the file: the
 * edit script wrote twice from the same unmodified source, so the second write discarded the
 * first, and both steps printed success (`0ae6db2` — the commit title claims a retraction the
 * diff does not contain). Caught by `[metapass-saas]` re-reading the head instead of the
 * changelog, after I reported it done twice.
 *
 * ⇒ The instrument, if it exists, is **not in this repository**: agents register with briefick,
 * so a version recorded on that row turns *"what fraction is at or past the intermediate release"*
 * into a query. This CLI sends one as of #24 — on `register` **and** on `startSession`, because
 * `register` runs once per pairing and would have frozen the value at the version an agent was
 * paired on. ⚠️ That field cannot be backfilled — it has to be added before a rotation, not during
 * one.
 *
 * ⚠️ **Sending the version is not enough by itself.** `register` runs once per pairing, so a row
 * filled there answers *"what fraction PAIRED at or past X"*, not *"what fraction IS at or past
 * X"* — and the agents those two answers differ on are exactly the upgraded ones, which is the
 * whole population a rotation is about (`[metapass-saas]`, review of #22; the fix is #24, which
 * also sends it on `startSession`).
 *
 * ⚠️ **And even then the query has two different errors in it, and only one is a gap.**
 * `cliVersion` is a column on briefick's `AgentToken`, so **every paired agent has a row** whether
 * or not it opens sessions (`[metapass-saas]`, review of #22, correcting an earlier version of
 * this paragraph — and the `[Briefick]` correction it came from — which called paired-and-idle
 * agents absent):
 *
 * ```
 * never paired              no row      absent                  ← the gap
 * paired, never sessioned   ROW EXISTS  the pairing version
 * paired, ran, then idle    ROW EXISTS  the LAST REPORTED one    ← stale, but not by as much
 * paired + sessions now     ROW EXISTS  current
 * ```
 *
 * ⚠️ The middle rows are not the same, and an earlier version of this table collapsed them into
 * "frozen at pairing" (`[Briefick]`, review of #47). `cliVersion` updates on `register` **and** on
 * every `session/start` where it changed, so an agent that upgraded, ran, and then went quiet
 * carries the version it last reported — **newer than its pairing value**. ⇒ My wording
 * *overstated* the error; it is only "frozen at pairing" for an agent that never opened a session.
 *
 * ⇒ The query samples **every paired agent**, not the ones that open sessions. All of it pushes
 * readiness down, so the conclusion holds.
 *
 * 🟢 **The instrument exists; nobody has written the query.** `lastSeenAt` moves when an agent
 * runs, and it has **two writers on two paths** — which is the distinction every version of this
 * paragraph has so far got wrong in one direction or the other:
 *
 * ```
 * recordAgentSeen()   agent-seen.ts:23        called from agent-auth.ts ×2, session/complete ×2
 * inline write        register/route.ts:55    ip ? { registeredIp, lastSeenIp, lastSeenAt } : {}
 * ```
 *
 * `[Briefick]` found the helper `[metapass-saas]` had missed; `[metapass-saas]` then found the
 * second writer that the correction had folded into the first (*« as well as at register »*
 * attributed an inline write to the helper).
 *
 * 🟡 **But the two facts are written by different paths and do not imply each other.**
 * `recordAgentSeen()` is **not** called from `session/start`, which is where `version` arrives. So
 * an agent can move `lastSeenAt` (MCP auth) without ever reporting a version, and the predicate
 * over `(cliVersion, lastSeenAt)` that would actually identify a stale row is **not established** —
 * what is established is only that the column exists.
 *
 * ⚠️ The limits below are the **helper's**. The register path shares exactly one of them, so a
 * query that applies these four to every row is wrong about the agents that re-pair
 * (`[Briefick]` measured the helper in code and in production, `[metapass-saas]` the split,
 * 2026-09-30 — neither is checkable from this repo, which has no briefick checkout):
 *
 * ```
 *                              recordAgentSeen()   register inline
 * delegated-session branch only      yes           n/a — register opens no session
 * 5-minute throttle                  yes           NO — every re-register writes
 * no client IP → skip                yes           yes
 * failure swallowed                  yes           no — part of the main update
 * ```
 *
 * ⇒ So *« a static-token agent (`bfk_agt_`) never records »* — what this block said until
 * `[metapass-saas]` checked it — is **false**. `agent-auth.ts:56` does show the static-token branch
 * skipping the helper, but a static-token agent that **re-registers** writes `lastSeenAt` inline and
 * unthrottled. A query built on the old wording would have excluded the entire static-token
 * population, including exactly the ones that have re-paired.
 *
 * ⚠️ The four limits still hold for the helper, and each is a way a missing value can mean
 * nothing: the throttle makes it a resolution rather than a last-call timestamp, no client IP leaves
 * no mark at all, and a swallowed failure looks the same as inactivity.
 *
 * ⇒ So *"has not been seen"* and *"is not tracked"* are the same reading of a missing value, which
 * is the shape this whole file keeps running into. Any query built on this has to say which one it
 * is counting.
 *
 * 🔴 This paragraph asserted the instrument exists (twice, in two wordings), then that it does not
 * (once), before anyone opened `agent-seen.ts`. Each version was more specific than the last —
 * file names, route names, measured counts — and that is what made each one read as checked.
 * ⚠️ The version that was wrong in the other direction came from a peer's **conditional** finding
 * losing its condition at the repository boundary: their note said *"I did not search the whole
 * repo for a writer"*, and what arrived here was *"there is no instrument"*, flat, with their name
 * on it. ⇒ Same failure as the rotation parenthesis at the top of this file, with the roles
 * reversed.
 *
 * 📌 And the shape of the corrections is itself the finding (`[metapass-saas]`, approving #22):
 * five versions, each one more specific than the last, each checked by one more person — and the
 * error surviving each round in the corner that round did not look at, because **a statement gets
 * re-read for the thing it was last wrong about.** ⚠️ The structural cause is that this paragraph
 * describes another repository, where nothing here can turn it red; the durable fix is to move it to
 * `platform-docs` and leave one line pointing at it, not a sixth revision.
 *
 * 📌 It is #24's finding one level up: **a value written once and read as current.** #24 fixed the
 * *write* (`startSession` reports too); the *query* still has to account for writes that have not
 * recurred yet.
 *
 * ⚠️ And the remaining gap is a *likely* upper bound, not a derived one: it holds only if agents
 * that never paired are **no newer** than those that did, which is plausible and is not measured.
 * A batch installed yesterday and never paired would be the newest software in the estate and
 * absent from the number — and then the measurement is a **lower** bound (`[Briefick]`, review of
 * #22). ⇒ On rotation day the direction of the error is the whole question, so the presumption is
 * stated rather than carried.
 *
 * ⚠️ **Compromise is out of scope, deliberately.** The plan above needs a release signed by the
 * old key, which an attacker holding that key can also produce. Under compromise there is no
 * intermediate release anyone can trust, every install is stranded, and `install.sh` is the only
 * route **for everyone** — not just for builds older than the intermediate. Stated because the
 * person reading this during an incident is reading it to find out whether there is a plan.
 *
 * ⚠️ `test/release-key.test.ts` asserts the first entry is byte-identical to `minisign.pub`, so a
 * rotation that edits one place and not the other is a red test rather than a binary that refuses
 * every future release — a failure that would otherwise first appear on users' machines.
 */
export const MINISIGN_PUBLIC_KEYS: readonly string[] = [
  `untrusted comment: minisign public key AAB2CB27BF4991FC
RWT8kUm/J8uyqoOFON5wRNBUCOUtn4+nX0YeyYMItdo2J6iVNYd4uUAX
`,
];

/** The key releases are currently signed with. The rest of the list exists for rotation. */
export const MINISIGN_PUBLIC_KEY = MINISIGN_PUBLIC_KEYS[0];
