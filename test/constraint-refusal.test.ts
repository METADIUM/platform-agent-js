import { describe, it, expect } from "vitest";
import { CONSTRAINT_REFUSALS, constraintRefusalAction } from "../src/constraint-refusal.js";

describe("constraintRefusalAction (spec §11.1)", () => {
  it("maps each code to the table's action", () => {
    expect(CONSTRAINT_REFUSALS).toEqual({
      constraints_missing: "drop",
      constraints_malformed: "drop",
      constraints_not_atomic: "drop",
      constraints_unknown_key: "keep",
    });
    for (const [code, action] of Object.entries(CONSTRAINT_REFUSALS)) {
      expect(constraintRefusalAction([code]), code).toBe(action);
    }
  });

  it("drop wins over keep, and anything else is not a constraint refusal", () => {
    expect(constraintRefusalAction(["constraints_unknown_key", "constraints_malformed"])).toBe("drop");
    expect(constraintRefusalAction(["scope_malformed", 42, null])).toBeNull();
    expect(constraintRefusalAction(["__proto__", "toString", "constructor"])).toBeNull();
    expect(constraintRefusalAction([])).toBeNull();
  });
});
