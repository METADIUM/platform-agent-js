import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { BriefickAgentClient } from "../src/briefick.js";
import { WIRE_SURFACE, AGENT_COMPAT, AGENT_COMPAT_CLASSES } from "../src/wire-surface.js";
import { AgentKey } from "../src/key.js";

/** Captures every request body the client sends, keyed by path. */
function recorder() {
  const sent: Record<string, unknown> = {};
  const fetchImpl = (async (url: string, init?: { body?: string }) => {
    const path = new URL(url).pathname;
    sent[path] = init?.body ? JSON.parse(init.body) : {};
    // enough of a reply for each call to return rather than throw
    return {
      ok: true,
      status: 200,
      json: async () => ({ registered: true, status: "pending", state: "s", nonce: "n", bearer: "b", expiresAt: new Date(Date.now() + 60_000).toISOString() }),
      text: async () => "{}",
    };
  }) as never;
  return { sent, fetchImpl };
}

describe("the wire surface this release declares", () => {
  it("🔴 package.json's agentCompat is present and is one of the declared classes", () => {
    // The release workflow refuses without it. Asserted here too so the failure is local and
    // immediate rather than only at tag time, when it is most expensive.
    const pkg = JSON.parse(readFileSync(join(import.meta.dirname, "..", "package.json"), "utf8"));
    expect(pkg.agentCompat, "package.json has no agentCompat — which class is this release?").toBeDefined();
    expect(AGENT_COMPAT_CLASSES, `agentCompat "${pkg.agentCompat}" is not a declared class`).toContain(pkg.agentCompat);
  });

  it("🔴 the two classes that can silently drop a field are the ones the gate holds back", () => {
    // The release workflow reads `releaseAfterReceiverConfirmed` off this table and refuses a
    // release in those classes unless the notes name the receiver that was confirmed first. If this
    // table said otherwise, a `receiver-first` release would ship before the RP widened and the
    // field would be dropped — briefick#48 / #25. (briefick now LOGS a rejected cliVersion, per
    // their agent-cli-version.ts; there is still no 422, so the agent is never told.)
    const gated = AGENT_COMPAT_CLASSES.filter((c) => AGENT_COMPAT[c].releaseAfterReceiverConfirmed);
    expect(gated, "a class that reorders a deploy is not gated").toEqual(["receiver-first", "breaking"]);

    const coexist = AGENT_COMPAT_CLASSES.filter((c) => AGENT_COMPAT[c].coexists);
    expect(coexist, "breaking is the only class an older agent cannot survive").toEqual([
      "local",
      "additive",
      "receiver-first",
    ]);
  });

  it("🔴 what the client actually sends matches WIRE_SURFACE", async () => {
    // 🔴 This is what keeps `agentCompat` honest. Adding, removing or renaming a field on any of
    // these requests fails here — and that failure is the moment someone has to decide whether the
    // release is `additive`, `receiver-first` or `breaking` instead of `local`.
    // Without it, `agentCompat` is prose, and this repo spent a day watching prose go stale:
    // briefick's own AGENT_CLI_MIN_VERSION was renamed because the value was right and the word
    // had become false.
    const key = await AgentKey.generate();
    const { sent, fetchImpl } = recorder();
    const c = new BriefickAgentClient({ baseUrl: "https://rp.example", key, version: "0.0.0", fetchImpl });

    await c.register("CODE", "label").catch(() => {});
    await c.retrieveDelegation().catch(() => {});
    await c.startSession().catch(() => {});

    const seen: Record<string, string[]> = {};
    for (const [path, body] of Object.entries(sent)) {
      seen[path] = Object.keys(body as object).sort();
    }
    expect(seen["/api/agent/register"], "register's fields moved").toEqual(WIRE_SURFACE.register);
    expect(seen["/api/agent/delegation/retrieve"], "retrieve's fields moved").toEqual(WIRE_SURFACE.retrieve);
    expect(seen["/api/agent/session/start"], "session/start's fields moved").toEqual(WIRE_SURFACE.sessionStart);
  });

  it("⬜ sessionComplete is declared but not driven here", () => {
    // Honest about the gap: reaching it needs a full session exchange. Its entry is a claim, and
    // the only one in WIRE_SURFACE that is not measured.
    expect(WIRE_SURFACE.sessionComplete).toEqual(["didJwk", "pop", "state"]);
  });
});
