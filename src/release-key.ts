/**
 * Release signing keys this build trusts, compiled in so `upgrade` can verify without `minisign`.
 *
 * A **list**, not a key: a binary trusts exactly what was compiled into it, so rotating a single key
 * would strand every installed binary with no way to upgrade out of it. Entry 0 is the key releases
 * are signed with; the rest exist for the rotation window.
 *
 * Rotation procedure, and what about it is not measurable:
 * `platform-docs/42-agent-cli-release-key-rotation.md`.
 */
export const MINISIGN_PUBLIC_KEYS: readonly string[] = [
  `untrusted comment: minisign public key AAB2CB27BF4991FC
RWT8kUm/J8uyqoOFON5wRNBUCOUtn4+nX0YeyYMItdo2J6iVNYd4uUAX
`,
];

/** The key releases are currently signed with. The rest of the list exists for rotation. */
export const MINISIGN_PUBLIC_KEY = MINISIGN_PUBLIC_KEYS[0];
