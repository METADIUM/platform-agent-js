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
 * 🔴 **The regex below is a TRANSCRIPTION of a rule this repository does not own.** Source:
 * briefick `src/app/api/agent/register/route.ts:51` at `1e2730b2` (byte-compared 2026-09-30 by
 * `[metapass-saas]`). It is not a contract either side declares independently — briefick has
 * nothing written down about what we send — so it drifts, and **the drift has a direction**
 * (`[metapass-saas]`, review of #24):
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

async function capture(version?: string) {
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
  await client.register("CODE", "host-1");
  return bodyOf(calls);
}

describe("the version this CLI reports on register", () => {
  it("is sent, and in the shape briefick stores", async () => {
    const body = await capture("0.5.6");
    expect(body.version).toBe("0.5.6");
    expect(String(body.version)).toMatch(BRIEFICK_SEMVER);
  });

  it("🔴 is omitted entirely when unknown — an absent key means «keep what you have» there", async () => {
    const body = await capture(undefined);
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

  it("keeps label and version independent — either can be absent alone", async () => {
    const body = await capture("0.5.6");
    expect(body.label).toBe("host-1");
    expect(body.version).toBe("0.5.6");
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
