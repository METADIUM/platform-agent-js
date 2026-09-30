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
 * route — which is why the intermediate release has to go out **before** the old key is retired,
 * not after it is compromised.
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
