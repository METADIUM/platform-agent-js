/**
 * What this CLI puts on the wire, declared — so a change to it cannot be silent.
 *
 * `package.json`'s `agentCompat` names the class of a release; {@link WIRE_SURFACE} lists the fields
 * actually sent, and `wire-surface.test.ts` drives the real client through an injected `fetch` and
 * compares, so the declaration cannot drift from the code without a red test.
 *
 * Why the classes are these four, what they do not cover, and why mini-paas needs its own entry:
 * `platform-docs/43-agent-cli-wire-compatibility.md`.
 */

/**
 * How a release relates to agents and RPs already deployed. See {@link AGENT_COMPAT} for what each
 * one commits the release to; the doc above has the reasoning.
 */
export type AgentCompat = "local" | "additive" | "receiver-first" | "breaking";

/**
 * The two properties the release process acts on. `coexists` is whether an older agent keeps
 * working once this release is out; `releaseAfterReceiverConfirmed` is whether the RP has to be
 * confirmed widened **before** this release ships — shipping first is a silent drop on their side.
 */
export const AGENT_COMPAT: Readonly<
  Record<AgentCompat, { readonly coexists: boolean; readonly releaseAfterReceiverConfirmed: boolean }>
> = {
  local: { coexists: true, releaseAfterReceiverConfirmed: false },
  additive: { coexists: true, releaseAfterReceiverConfirmed: false },
  "receiver-first": { coexists: true, releaseAfterReceiverConfirmed: true },
  breaking: { coexists: false, releaseAfterReceiverConfirmed: true },
};

export const AGENT_COMPAT_CLASSES: readonly AgentCompat[] = Object.keys(AGENT_COMPAT) as AgentCompat[];

/**
 * Field names this CLI sends, per request. Sorted, so the comparison is order-independent.
 *
 * Changing this list is not a formality — it is the declaration that a wire change happened.
 * Update it **and** set `agentCompat` in the same commit.
 *
 * ⚠️ These are the requests as **briefick** receives them. mini-paas speaks a different shape and
 * is not covered by any row here; a second RP gets its own entry rather than being folded in.
 */
export const WIRE_SURFACE: Readonly<Record<string, readonly string[]>> = {
  register: ["code", "didJwk", "label", "pop", "version"],
  retrieve: ["didJwk", "pop"],
  sessionStart: ["didJwk", "pop", "version"],
  sessionComplete: ["didJwk", "pop", "state"],
};
