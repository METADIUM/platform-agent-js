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
 * (`[metapass-saas]`, review of #22: this is what has blocked their own key rotation — not the
 * crypto, and not a decision, but having no way to measure what is installed).
 *
 * ⇒ The instrument, if it exists, is **not in this repository**: agents register with briefick,
 * so a version recorded on that row turns *"what fraction is at or past the intermediate release"*
 * into a query. This CLI sends one as of #24 — on `register` **and** on `startSession`, because
 * `register` runs once per pairing and would have frozen the value at the version an agent was
 * paired on. ⚠️ That field cannot be backfilled — it has to be added before a rotation, not during
 * one.
 *
 * ⚠️ **And the query samples agents that open sessions with briefick, not installs.** An agent
 * installed and never paired, or paired and idle, is absent from it — so the fraction it reports
 * is an upper bound on readiness among active agents and says nothing about the rest
 * (`[Briefick]`, review of #22).
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
