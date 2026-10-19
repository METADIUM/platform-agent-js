/**
 * What this CLI puts on the wire, declared — so a change to it cannot be silent.
 *
 * `package.json`'s `agentCompat` names the class of a release; {@link WIRE_SURFACE} lists the requests
 * and fields actually sent, and `wire-surface.test.ts` drives the real calls through an injected `fetch`
 * and compares, so the declaration cannot drift from the code without a red test.
 *
 * Why the classes are these four and what they do not cover: `platform-docs/43-agent-cli-wire-compatibility.md`.
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

/** One request this CLI sends: its method, its JSON body's field names (null: no body), and the headers it sets. */
export interface WireRequest {
  /** Who receives it: the verifier (sso) or the RP. Every receiver must be confirmed for a release that needs it. */
  receiver: "verifier" | "rp";
  readonly method: "GET" | "POST" | "forwarded";
  /** Sorted. `"forwarded"`: the MCP client's method or body, passed through unread. */
  readonly body: readonly string[] | null | "forwarded";
  /** Sorted, lower case; only headers this CLI sets itself. */
  readonly headers: readonly string[];
}

/**
 * Every request this CLI sends under agent-delegation `/1`, as its receiver (verifier or RP) sees it. The same
 * shape goes to every RP: the paths come from the verifier's signed entry, the fields don't vary.
 *
 * Changing this table is not a formality — it is the declaration that a wire change happened.
 * Update it **and** set `agentCompat` in the same commit. v0 (`register`/`retrieve`/`session/*`) was removed
 * on 2026-10-17 and has no rows.
 */
/** Release-gate names per receiver class: the verifier instance, and every RP. */
export const RECEIVERS_BY_CLASS: Readonly<Record<WireRequest["receiver"], readonly string[]>> = {
  verifier: ["sso"],
  rp: ["briefick", "minipaas"],
};

export const WIRE_SURFACE: Readonly<Record<string, WireRequest>> = {
  /** `GET <verifier>/rp/<alias>` (§17): the RP's signed registry entry. */
  rpEntry: { receiver: "verifier", method: "GET", body: null, headers: [] },
  /** The verifier's did.json, to check that entry's signature. */
  verifierDidJson: { receiver: "verifier", method: "GET", body: null, headers: [] },
  /** `POST <resource><pairing>` (§7). `label` and `version` only when known. */
  pairing: { receiver: "rp", method: "POST", body: ["code", "label", "version"], headers: ["agent-proof", "content-type"] },
  /** `POST <resource><pickup>` (§8). `version` only when known. */
  pickup: { receiver: "rp", method: "POST", body: ["version"], headers: ["agent-proof", "content-type"] },
  /** `POST <verifier>/agent/nonce` (§9). */
  sessionNonce: { receiver: "verifier", method: "POST", body: null, headers: [] },
  /** `POST <verifier>/agent/token` (§9). */
  sessionToken: { receiver: "verifier", method: "POST", body: ["rp", "vp_token"], headers: ["agent-proof", "content-type"] },
  /** A forwarded MCP call to the RP (§10). */
  mcpCall: { receiver: "rp", method: "forwarded", body: "forwarded", headers: ["agent-proof", "authorization"] },
};
