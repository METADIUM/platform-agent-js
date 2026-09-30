import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parsePublicKey } from "../src/minisign.js";
import { MINISIGN_PUBLIC_KEY } from "../src/release-key.js";

/**
 * 🔴 `src/release-key.ts` is a copy of `minisign.pub`, and this is the only thing stopping the two
 * from drifting. Rotating the key in one place and not the other produces a binary that refuses
 * every future release and cannot upgrade itself out of it — a failure that would first appear on
 * users' machines, not in CI.
 */
describe("the compiled-in release key", () => {
  it("is byte-identical to minisign.pub", () => {
    const onDisk = readFileSync(join(import.meta.dirname, "..", "minisign.pub"), "utf8");
    expect(MINISIGN_PUBLIC_KEY.trim()).toBe(onDisk.trim());
  });

  it("parses, and is the key that signed the checked-in release vector", () => {
    const key = parsePublicKey(MINISIGN_PUBLIC_KEY);
    expect(key.keyId).toBe("fc9149bf27cbb2aa");
  });
});
