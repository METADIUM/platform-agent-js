/**
 * What this CLI puts on the wire, declared — so a change to it cannot be silent.
 *
 * 🔴 **Why this file exists.** Nothing here declared anything about compatibility: the CLI stated
 * no protocol version, no RP rejected an agent by version, and briefick's pin is a sentence on a
 * screen for a human to read. Every compatibility decision so far was made in prose, once, in the
 * place it came up.
 *
 * That worked until it did not. `#25`/`briefick#48` was a real coexistence failure: a widened
 * version string sent to an RP that had not widened yet was **silently dropped**, and the rule that
 * saved it — *widen the receiver first, narrow the sender first* — ended up written in the comment
 * of one test file. ⇒ The rule was right and its home was wrong.
 *
 * ## The four classes a release can be
 *
 * ```
 * local           no field and no shape changes on any request.                   coexists
 * additive        a NEW field the receiver may ignore.                            coexists
 * receiver-first  an existing field's ACCEPTED SHAPE widens.                      ⚠️ ORDER MATTERS
 *                 widening the sender first = silent drop; the receiver first = a loud false red
 * breaking        a field is removed, renamed, or its meaning changes.            🔴 must upgrade
 * ```
 *
 * ⚠️ **`local` does not mean "nothing new reaches the RP".** It said so in the first draft and
 * was already false of the release that introduced it: 0.5.8 adds no field, but it adds a
 * **recurring call** — `retrieve` every five minutes per RP, which an RP sees as new traffic and,
 * for `no_agent`, as a log line each time (`[Briefick]`, review of #30). The classes are about
 * **whether old and new can coexist**, not about load. A release that changes what an RP must
 * absorb should still say so, and this field is not where that is said.
 *
 * ⚠️ `receiver-first` is the class a simple minimum-version gate cannot express, and it is the one
 * that actually happened. Coexistence is not a property of the pair — it is a property of **the
 * order you deploy them in**.
 *
 * 🔴 **And "the receiver" is not one thing.** `[Briefick]` corrected the prescription: their
 * deploy has no window (it goes out on user approval, lead time minutes to hours, migrations
 * separate), and they also assume **independent installs by other organisations** — whose state
 * neither this CLI nor briefick can see. So *"deploy the RP first"* is not checkable for those.
 * ⇒ The prescription is **"release after the receiver is confirmed"**, and for briefick the
 * confirmation is `/api/version` (the running commit) plus `src/lib/agent-cli-version.ts`. For an
 * RP that cannot be queried, a `receiver-first` change has no safe release order at all — which is
 * a fact about that deployment, and better said than assumed away.
 *
 * ## What makes the declaration honest
 *
 * `package.json`'s `agentCompat` says which class a release is. On its own that is prose, and this
 * repo has watched prose go stale all day — briefick's own `AGENT_CLI_MIN_VERSION` was renamed
 * because *the value was right and the word had become false*.
 *
 * ⇒ So {@link WIRE_SURFACE} lists the field names actually sent, and `wire-surface.test.ts` drives
 * the real client through an injected `fetch` and compares. **Changing what goes on the wire fails
 * that test**, which is the moment someone has to decide which class the change is and set
 * `agentCompat` accordingly. The declaration cannot drift from the code without a red test.
 *
 * ⬜ What it does NOT catch: a change in a field's **meaning** with its name unchanged, and
 * anything about the RP's side. Both are `breaking` by definition and neither is visible from here.
 *
 * ⚠️ **And this describes ONE protocol shape, not "the wire".** These are the requests as
 * briefick receives them — verified 2026-10-01 by reading their four route handlers, whose fields
 * match this list exactly, including `sessionComplete`, which the test cannot drive. mini-paas
 * speaks a different shape for the same step (`GET /delegation/retrieve?nonce=&secret=` against
 * this CLI's `POST {didJwk, pop}`), so nothing here describes that interaction at all. A second RP
 * shape would need its own entry rather than being folded into these.
 */
export type AgentCompat = "local" | "additive" | "receiver-first" | "breaking";

export const AGENT_COMPAT_CLASSES: readonly AgentCompat[] = [
  "local",
  "additive",
  "receiver-first",
  "breaking",
];

/**
 * Field names this CLI sends, per request. Sorted, so the comparison is order-independent.
 *
 * 🔴 Changing this list is not a formality — it is the declaration that a wire change happened.
 * Update it **and** set `agentCompat` in the same commit.
 */
export const WIRE_SURFACE: Readonly<Record<string, readonly string[]>> = {
  register: ["code", "didJwk", "label", "pop", "version"],
  retrieve: ["didJwk", "pop"],
  sessionStart: ["didJwk", "pop", "version"],
  sessionComplete: ["didJwk", "pop", "state"],
};
