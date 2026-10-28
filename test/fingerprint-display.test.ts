import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../src/cli.js";
import { AgentKey, groupFingerprint } from "../src/key.js";
import { loadStore } from "../src/keystore.js";

// keepin asks for "the first 4 characters of the 에이전트 지문"; Briefick and MiniPaaS show it as "xxxxx xxxxx".
describe("the agent fingerprint as the CLI prints it", () => {
  const dirs: string[] = [];
  afterEach(() => {
    vi.restoreAllMocks();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("groups ten characters as five and five, and leaves anything else alone", () => {
    expect(groupFingerprint("ecece7c037")).toBe("ecece 7c037");
    expect(groupFingerprint("abc")).toBe("abc");
  });

  it("`did` prints the grouped value labelled 에이전트 지문", async () => {
    const d = mkdtempSync(join(tmpdir(), "mpa-fp-"));
    dirs.push(d);
    const file = join(d, "key.json");
    const err: string[] = [];
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void err.push(a.join(" ")));

    expect(await main(["did", "--key-file", file])).toBe(0);

    const key = await AgentKey.fromPrivateJwk(loadStore(file)!.privateJwk!);
    const printed = err.join("\n");
    expect(printed, "the wallet's prompt names 에이전트 지문; the CLI must use the same words")
      .toContain(`에이전트 지문: ${groupFingerprint(key.fingerprint)}`);
    expect(printed, "bare 10 hex looks different from every screen the user compares it with")
      .not.toContain(key.fingerprint);
  });

  it("`status` leads with the same grouped value", async () => {
    const d = mkdtempSync(join(tmpdir(), "mpa-fp-"));
    dirs.push(d);
    const file = join(d, "key.json");
    vi.spyOn(console, "error").mockImplementation(() => {});
    const out: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void out.push(a.join(" ")));
    expect(await main(["did", "--key-file", file])).toBe(0);
    const key = await AgentKey.fromPrivateJwk(loadStore(file)!.privateJwk!);
    out.length = 0;

    await main(["status", "--key-file", file]);

    expect(out[0], "status is where a user checks which agent this machine is").toMatch(
      new RegExp(`^에이전트 지문 ${groupFingerprint(key.fingerprint)}  ·  daemon: `));
  });
});
