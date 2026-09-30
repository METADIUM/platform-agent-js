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

  it("the MCP path is where briefick mounts it", () => {
    // 🔴 This pin was worthless until the value was read. [metapass-saas] measured it on #23:
    // `DEFAULT_SERVICE.mcpPath` was declared and **never read** — `cli.ts` carried two of its own
    // `"/api/mcp"` literals, so moving the field broke nothing and pinning it would have pinned a
    // dead copy. Worse, the object's shape advertised it as the place to change the path. The two
    // literals now read this field, so the pin means something.
    expect(DEFAULT_SERVICE.mcpPath).toBe("/api/mcp");
  });

  it("the session paths are where briefick routes them", () => {
    // ⚠️ `test/cli.test.ts` already hardcodes these in its stubs, so an accidental change is
    // caught. What it cannot do is the thing this file exists for: name who has to be told.
    // Someone changing them deliberately fixes both sides in one self-consistent edit and never
    // learns briefick serves them ([metapass-saas], review of #23).
    expect(DEFAULT_SERVICE.sessionStartPath).toBe("/api/agent/session/start");
    expect(DEFAULT_SERVICE.sessionCompletePath).toBe("/api/agent/session/complete");
  });

  it("🔴 the PoP audiences match the strings briefick verifies against", () => {
    // A PoP audience mismatch fails *after* a successful HTTP round trip: status 2xx, path
    // correct, briefick's probe green, registration broken. This side is the only guard.
    //
    // 🔴 The values, not their shape. An earlier version asserted these were non-empty strings,
    // which is true of every wrong value as well — briefick pointed out that it pins nothing
    // (review of #23). They confirmed these three are byte-identical to the constants in
    // briefick `src/lib/agent-did.ts`, checked against this CLI's published 0.5.6 dist.
    expect(DEFAULT_SERVICE.popAudience).toEqual({
      register: "briefick-agent-register",
      retrieve: "briefick-agent-retrieve",
      session: "briefick-agent-session",
    });
  });
});
