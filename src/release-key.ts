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
 * readiness down, so the conclusion holds — but the staleness is **measurable** and this paragraph
 * used to treat the whole error as unmeasurable. The identifying mark is a row whose `cliVersion`
 * has not moved since its `lastSeenAt`, not since pairing.
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
