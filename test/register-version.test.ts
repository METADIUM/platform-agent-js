import { readFileSync } from "node:fs";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { AgentKey } from "../src/key.js";
import { saveStore } from "../src/keystore.js";
import { pairV1 } from "../src/rp-entry.js";
import { pickup } from "../src/pickup.js";
import { fakeVerifier } from "./fake-verifier.js";

/**
 * The CLI reports its own version on pairing and on every pickup (`/1`; v0 `register` and `session/start` were
 * removed on 2026-10-17), so briefick can answer *"what fraction of agents
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
const BRIEFICK_SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]{1,24})?(?:\+[0-9A-Za-z.-]{1,24})?$/;

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const f of cleanup.splice(0)) await f();
});

/** The JSON body of the one request `call` sends through the injected fetch. */
async function sent(call: (fetchImpl: typeof fetch) => Promise<unknown>, reply: unknown): Promise<Record<string, unknown>> {
  const bodies: Record<string, unknown>[] = [];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(Buffer.from(init.body as Uint8Array).toString("utf8")) as Record<string, unknown>);
    return Response.json(reply);
  }) as unknown as typeof fetch;
  await call(fetchImpl);
  expect(bodies, "no request was sent").toHaveLength(1);
  return bodies[0];
}

// ⚠️ No default for `label`: a default parameter treats an EXPLICIT `undefined` as absent and
//    substitutes it, so `capture(v, undefined)` would have tested the present case while reading
//    as the absent one. Callers pass it explicitly.
async function capture(version: string | undefined, label: string | undefined) {
  const key = await AgentKey.generate();
  return sent((fetchImpl) => pairV1({ resource: "https://rp.example", path: "/agent/pair", key, code: "CODE", label, version, fetchImpl }),
    { paired: true, agent_fingerprint: key.fingerprint });
}

async function capturePickup(version?: string) {
  const key = await AgentKey.generate();
  return { body: await sent((fetchImpl) => pickup({ url: "https://rp.example", key, version, fetchImpl }), { delegations: [] }) };
}

describe("the version this CLI reports on pairing", () => {
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

  it("🔴 accepts a prerelease AND build metadata together — valid semver the old copy rejected", () => {
    // The old form was `(?:[-+]…)?` — ONE optional group, so a version carrying both was thrown
    // away. semver.org's own example is in this shape (`briefick#48`, found by minipaas).
    // ⚠️ This is briefick WIDENING, announced before the change as agreed. The copy here is
    // updated to match; had it not been, a release in this shape would have gone red on this side
    // while briefick stored it happily — a false red, the mirror of the silent drop this file
    // guards against.
    //
    // 📌 The merge order is settled — this records why it was chosen, it is not a pending
    // instruction (`[metapass-saas]`, review of #25). `briefick#48` went first (`e782df4e`) and
    // reached production on 2026-10-01; this copy followed. The asymmetry is the reason, and it
    // outlives the decision:
    //   widen THEM first   they accept more, this copy still rejects  → FALSE RED here. Loud, safe.
    //   widen US first     this accepts, they reject                  → CLI sends, briefick SILENTLY
    //                      drops, and this side is green — the failure this file exists to stop.
    // ⇒ Whenever the two rules move again, widen briefick first and narrow this side first.
    expect("1.2.3-rc.1+build.5").toMatch(BRIEFICK_SEMVER);
    expect("1.2.3-0.3.7+build.11.e0f985a").toMatch(BRIEFICK_SEMVER);
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

describe("pickup, which is the call that sees upgrades", () => {
  it("🔴 pickup reports the version too — pairing runs once", async () => {
    // 🔴 An upgraded CLI never re-pairs, so a version recorded at pairing is frozen there. Pickup runs every interval.
    const { body } = await capturePickup("0.5.6");
    expect(body.version).toBe("0.5.6");
  });

  it("🔴 omits it when unknown, same rule as pairing", async () => {
    const { body } = await capturePickup(undefined);
    expect("version" in body).toBe(false);
  });
});

describe("the wiring, not a hand-built call", () => {
  it("🔴 the daemon's pickup reports a version briefick will store", async () => {
    const { pickupOptionsFor } = await import("../src/cli.js");
    const version = pickupOptionsFor({ alias: "b", url: "https://b.example.com" }, await AgentKey.generate()).version;
    expect(version, "pickupOptionsFor() sends no version").toBeTruthy();
    expect(version).toMatch(BRIEFICK_SEMVER);
  });

  it("🔴 add --code pairs with a version briefick will store", async () => {
    const { main } = await import("../src/cli.js");
    const d = mkdtempSync(join(tmpdir(), "mpa-ver-"));
    cleanup.push(() => rmSync(d, { recursive: true, force: true }));
    const keyFile = join(d, "key.json");
    const key = await AgentKey.generate();
    saveStore(keyFile, { privateJwk: key.exportPrivateJwk() });
    const url = "https://briefick.example.com";
    const v = await fakeVerifier("briefick", url, () => Response.json({ paired: true, agent_fingerprint: key.fingerprint }));
    cleanup.push(v.restore);
    expect(await main(["add", url, "--verifier", "https://sso.example.com", "--code", "C1", "--key-file", keyFile])).toBe(0);
    const version = v.pairs[0]?.version as string | undefined;
    expect(version, "add sent no version").toBeTruthy();
    expect(version).toMatch(BRIEFICK_SEMVER);
    expect(version!.startsWith("v"), "a tag-shaped version is dropped by briefick").toBe(false);
  });
});
