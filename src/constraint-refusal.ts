/**
 * What the agent does with a delegation an RP refused for its `constraints` (spec agent-delegation §11.1).
 * `drop`: the VC is unusable everywhere — discard it and wait for a new delegation, as `invalid_delegation`.
 * `keep`: the RP does not understand a limit (it lags the vct version) — keep the VC, do not retry, tell the user.
 */
export type ConstraintRefusalAction = "drop" | "keep";

export const CONSTRAINT_REFUSALS: Readonly<Record<string, ConstraintRefusalAction>> = {
  constraints_missing: "drop",
  constraints_malformed: "drop",
  constraints_not_atomic: "drop",
  constraints_unknown_key: "keep",
};

/** `drop` if any reason drops, else `keep` if any keeps, else `null` (not a constraint refusal). */
export function constraintRefusalAction(reasons: readonly unknown[]): ConstraintRefusalAction | null {
  const actions = reasons.map((r) => (typeof r === "string" ? CONSTRAINT_REFUSALS[r] : undefined));
  if (actions.includes("drop")) return "drop";
  if (actions.includes("keep")) return "keep";
  return null;
}
