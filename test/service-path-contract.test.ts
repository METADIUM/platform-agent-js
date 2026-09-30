import { describe, expect, it } from "vitest";
import { DEFAULT_SERVICE } from "../src/briefick.js";

/**
 * The endpoint paths this client posts to are a **cross-repo contract**, and until now only the
 * consumer side knew it.
 *
 * 🔴 briefick serves `/api/agent/register`. If `DEFAULT_SERVICE.registerPath` moves, every agent
 * that has not been reconfigured posts to a path briefick does not route, and **user registration
 * breaks** — with no error on this side that names the cause, because the CLI only checks for a
 * 2xx and any 404 page is a non-2xx with an unhelpful body.
 *
 * ⚠️ This test cannot prevent the change and is not trying to. It makes the change **deliberate**
 * and names who has to be told. The same shape as `install-path-contract.test.ts`: a tripwire with
 * a consumer's name on it is the only guard available when the two halves live in different
 * repositories and neither can import the other.
 *
 * 📌 briefick built the mirror of this first (`briefick#43`): their probe runs this CLI against a
 * stub and asserts the POST lands on `/api/agent/register`, with the expected value taken from
 * **their** route file rather than from us — so neither side's check is an identity against the
 * other. This file is our half; it was added because they asked whether they could rely on the
 * path, and the honest answer had to be a guard, not a yes.
 *
 * Known consumers as of 2026-09-30:
 *   - briefick `scripts/probe-agent-cli.mjs` — asserts the register POST path
 *   - briefick `src/app/api/agent/register/route.ts` — serves it
 */
describe("service paths other repositories serve", () => {
  it("register posts where briefick routes it", () => {
    expect(DEFAULT_SERVICE.registerPath).toBe("/api/agent/register");
  });

  it("delegation retrieval posts where briefick routes it", () => {
    expect(DEFAULT_SERVICE.retrievePath).toBe("/api/agent/delegation/retrieve");
  });

  it("🔴 the PoP audiences are part of the same contract — briefick verifies them", () => {
    // A PoP audience mismatch fails *after* a successful HTTP round trip, so briefick's probe
    // (which uses a stub that does not verify PoP) cannot see it. This side is the only guard.
    expect(DEFAULT_SERVICE.popAudience).toMatchObject({
      register: expect.any(String),
      retrieve: expect.any(String),
      session: expect.any(String),
    });
    for (const [name, aud] of Object.entries(DEFAULT_SERVICE.popAudience)) {
      expect(aud, `popAudience.${name} is empty`).not.toBe("");
    }
  });
});
