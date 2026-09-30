/**
 * The release signing key, compiled into the binary so `upgrade` can verify without `minisign`.
 *
 * 🔴 **This is a copy of `minisign.pub`, and a copy goes stale.** `test/release-key.test.ts`
 * asserts the two are byte-identical, so rotating the key in one place and not the other is a red
 * test rather than an upgrade that refuses every future release.
 *
 * ⚠️ **Rotation has a one-way door here.** A binary trusts exactly this key. If the signing key is
 * replaced, every already-installed binary refuses the new releases and cannot upgrade itself out
 * of it — the escape hatch is `install.sh`, which carries the key separately, and `verifyContent`
 * says so in the error it throws. Before rotating: ship a release signed by the OLD key that
 * carries the NEW one, let it propagate, and only then switch.
 */
export const MINISIGN_PUBLIC_KEY = `untrusted comment: minisign public key AAB2CB27BF4991FC
RWT8kUm/J8uyqoOFON5wRNBUCOUtn4+nX0YeyYMItdo2J6iVNYd4uUAX
`;
