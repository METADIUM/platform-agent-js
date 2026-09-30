import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AgentClient } from "../src/briefick.js";

/**
 * The CLI reports its own version on register, so briefick can answer *"what fraction of agents
 * is at or past release X"* with a query instead of a judgement.
 *
 * 🔴 Why this is worth a test rather than a field: it exists for **upstream signing-key rotation**
 * (`platform-agent-js#22`). The rotation plan's one unobservable step is "let the intermediate
 * release propagate", and this column is the instrument. ⚠️ It **cannot be backfilled** — an agent
 * that registered without it never reports retroactively, so a version that silently stops being
 * sent is not noticed until the rotation day, which is the day it is needed.
 *
 * ⚠️ briefick stores it only when it matches semver, and a `v` prefix is **rejected**. Release
 * **tags** carry the `v`; `package.json` does not. Sending the tag would be silently dropped on
 * their side and look like an agent that never reported.
 *
 * 🔴 **The regex below is a TRANSCRIPTION of a rule this repository does not own.** Source of
 * record: briefick `src/lib/agent-cli-version.ts` (`CLI_VERSION_RE`). ⚠️ This comment already went
 * stale once — it named `register/route.ts:51` at `1e2730b2`, which is where the rule lived when
 * it was transcribed and is not where it lives now (`[Briefick]`, review of #24). **A citation to
 * another repository's line is a copy with no guard**, which is the same defect the paragraph is
 * about.
 *
 * 🟢 briefick has since built the half this side cannot: their probe runs the **real packaged CLI**
 * against a stub and checks the posted `version` with that filter, and rejected versions are
 * logged server-side — so *"never reported"* and *"reported and discarded"* are now
 * distinguishable, which was the failure mode that made this copy dangerous.
 *
 * ⬜ What neither side catches: briefick tightening **between pin bumps** so that a version newer
 * than the pinned one is rejected. Their runtime log sees it; no CI on either side does.
 *
 * 🟢 Byte-identical to `CLI_VERSION_RE` as of `8cb1f222` (`[metapass-saas]`, re-measured after the
 * rule moved into its own module — the earlier comparison was against the route file it used to
 * live in). ⚠️ **It is not semver**: it accepts a leading zero (`01.2.3` matches; the spec forbids
 * it). Both sides accept it, so this is a shared quirk rather than drift — and the distinction
 * matters, because a "fix" on one side alone would start silently dropping values.
 *
 * ⚠️ It was not a contract either side declared independently. That has changed: briefick's
 * `agent-cli-version.test.ts` (`#44` `ca958fef`) now fixes their accepted range, so both sides
 * state it and either can go red. What remains is that **this file holds a copy**, and a copy
 * drifts — with **a direction** (`[metapass-saas]`, review of #24):
 *
 * ```
 * briefick LOOSENS   this test is stricter than reality   nothing breaks
 * briefick TIGHTENS  this test stays GREEN, their side starts dropping values
 *                    ⇒ indistinguishable from "an agent that never reported"
 *                    ⇒ invisible until the rotation day, which is the day it is needed
 * ```
 *
 * ⇒ So this file guards the direction where no value is lost and **fails to guard the direction
 * this feature exists for**. Partial cover exists on their side — their fixture table hardcodes
 * `0.5.6` and `0.6.0-rc.1`, so a tightening that rejects those goes red there. What neither side
 * catches is a tightening that keeps their fixtures and rejects a **future** version of this
 * package (a prerelease tag longer than 24 characters, for instance).
 *
 * ⬜ There is no device that closes this from here. What is available is saying where the rule
 * lives and what happens when it moves, which is what the paragraph above is for.
 */
const BRIEFICK_SEMVER = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]{1,24})?$/;

function bodyOf(calls: Array<{ body: unknown }>): Record<string, unknown> {
  return JSON.parse(String((calls[0] as { body: string }).body)) as Record<string, unknown>;
}

async function captureSession(version?: string) {
  const calls: Array<{ body: string }> = [];
  const client = new AgentClient({
    baseUrl: "https://rp.example",
    version,
    key: { did: "did:jwk:x", popJwt: async () => "pop" } as never,
    fetchImpl: (async (_url: string, init: { body: string }) => {
      calls.push(init);
      return { ok: true, status: 200, text: async () => JSON.stringify({ state: "s", nonce: "n", responseUri: "u" }) };
    }) as never,
  });
  await client.startSession();
  return { body: JSON.parse(calls[0].body) as Record<string, unknown> };
}

// ⚠️ No default for `label`: a default parameter treats an EXPLICIT `undefined` as absent and
//    substitutes it, so `capture(v, undefined)` would have tested the present case while reading
//    as the absent one. Callers pass it explicitly.
async function capture(version: string | undefined, label: string | undefined) {
  const calls: Array<{ body: unknown }> = [];
  const client = new AgentClient({
    baseUrl: "https://rp.example",
    version,
    key: {
      did: "did:jwk:x",
      popJwt: async () => "pop",
    } as never,
    fetchImpl: (async (_url: string, init: { body: string }) => {
      calls.push(init);
      return { ok: true, status: 200, text: async () => JSON.stringify({ registered: true }) };
    }) as never,
  });
  await client.register("CODE", label);
  return bodyOf(calls);
}

describe("the version this CLI reports on register", () => {
  it("is sent, and in the shape briefick stores", async () => {
    const body = await capture("0.5.6", "host-1");
    expect(body.version).toBe("0.5.6");
    expect(String(body.version)).toMatch(BRIEFICK_SEMVER);
  });

  it("🔴 is omitted entirely when unknown — an absent key means «keep what you have» there", async () => {
    const body = await capture(undefined, "host-1");
    expect("version" in body).toBe(false);
    // An empty string would be a VALUE on their side, not an absence. Same distinction as label.
    expect(body.version).toBeUndefined();
  });

  it("🔴 this package's own version passes briefick's filter", () => {
    // 🔴 The check that matters. If package.json ever carried a tag-shaped version, every agent
    // would report and briefick would store nothing, indistinguishable from not reporting at all.
    const pkg = JSON.parse(readFileSync(join(import.meta.dirname, "..", "package.json"), "utf8")) as { version: string };
    expect(pkg.version).toMatch(BRIEFICK_SEMVER);
    expect(pkg.version.startsWith("v"), "a v-prefixed version is rejected by briefick").toBe(false);
  });

  it("🔴 a release-tag-shaped version would NOT be stored — the control for the line above", () => {
    expect("v0.5.6").not.toMatch(BRIEFICK_SEMVER);
    expect("0.5").not.toMatch(BRIEFICK_SEMVER);
  });

  it("⚠️ documents a shared quirk: a leading zero is accepted, though semver forbids it", () => {
    // 🔴 Pinned so a well-meaning "make it real semver" edit on this side alone goes red. Both
    // sides accept it today; tightening one and not the other starts discarding values silently,
    // which is the direction this file cannot otherwise guard ([metapass-saas], review of #24).
    //
    // ⚠️ **Do not "fix" this to match the spec.** This assertion is deliberately wrong about
    // semver and right about briefick.
    //
    // 🔴 **And be exact about what it catches.** It reads THIS file's copy, so it goes red when
    // *this side* tightens alone — which is the useful case, because that is the edit a
    // well-meaning reader makes. It does **not** go red when briefick tightens: their change
    // cannot reach this expectation (`[Briefick]`, review of #24, correcting an earlier version
    // of this comment that claimed exactly that).
    // ⇒ The briefick side is pinned by their own test (`agent-cli-version.test.ts`, `#44`
    // `ca958fef`), which fixes the accepted range including `01.2.3` and goes red on a
    // leading-zero ban. **Two tests pointing at each other, not two comments.**
    expect("01.2.3").toMatch(BRIEFICK_SEMVER);
  });

  it("keeps label and version independent — measured in all four combinations", async () => {
    // 🔴 An earlier version of this ran only the both-present case while its name promised four
    // (`[Briefick]`, review of #24). A name that claims more than the body checks is the defect
    // this repo's rule is about, in a test.
    expect(await capture("0.5.6", "host-1")).toMatchObject({ label: "host-1", version: "0.5.6" });
    expect("version" in (await capture(undefined, "host-1"))).toBe(false);
    expect("label" in (await capture("0.5.6", undefined))).toBe(false);
    const neither = await capture(undefined, undefined);
    expect("version" in neither).toBe(false);
    expect("label" in neither).toBe(false);
  });
});

describe("the session call, which is the one that sees upgrades", () => {
  it("🔴 startSession reports the version too — register runs once per pairing", async () => {
    // 🔴 The finding this test exists for: an upgraded CLI never re-registers, so a version
    // recorded at register is frozen at pairing. Sessions re-issue on a short TTL.
    const { body } = await captureSession("0.5.6");
    expect(body.version).toBe("0.5.6");
  });

  it("🔴 omits it when unknown, same rule as register", async () => {
    const { body } = await captureSession(undefined);
    expect("version" in body).toBe(false);
  });
});

describe("the wiring, not a hand-built client", () => {
  it("🔴 agentClient() reports a version briefick will store", async () => {
    // 🔴 This is the test the earlier ones could not be. They constructed their own client, so a
    // call site sending `v0.5.6` stayed green in all five. This one goes through the real wiring.
    const { agentClient } = await import("../src/cli.js");
    const calls: Array<{ body: string }> = [];
    const client = agentClient("https://rp.example", {
      did: "did:jwk:x",
      popJwt: async () => "pop",
    } as never);
    (client as unknown as { http: unknown }).http = async (_u: string, init: { body: string }) => {
      calls.push(init);
      return { ok: true, status: 200, text: async () => JSON.stringify({ registered: true }) };
    };
    await client.register("CODE");
    const body = JSON.parse(calls[0].body) as { version?: string };
    expect(body.version, "agentClient() sent no version").toBeTruthy();
    expect(body.version).toMatch(BRIEFICK_SEMVER);
    expect(body.version!.startsWith("v"), "a tag-shaped version is dropped by briefick").toBe(false);
  });
});
