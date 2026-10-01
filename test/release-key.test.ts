import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parsePublicKey } from "../src/minisign.js";
import { MINISIGN_PUBLIC_KEY, MINISIGN_PUBLIC_KEYS } from "../src/release-key.js";

/**
 * 🔴 `src/release-key.ts` is a copy of `minisign.pub`, and this is the only thing stopping the two
 * from drifting. Rotating the key in one place and not the other produces a binary that refuses
 * every future release and cannot upgrade itself out of it — a failure that would first appear on
 * users' machines, not in CI.
 */
describe("the compiled-in release keys", () => {
  it("the signing key is byte-identical to minisign.pub", () => {
    const onDisk = readFileSync(join(import.meta.dirname, "..", "minisign.pub"), "utf8");
    expect(MINISIGN_PUBLIC_KEY.trim()).toBe(onDisk.trim());
  });

  it("parses, and is the key that signed the checked-in release vector", () => {
    expect(parsePublicKey(MINISIGN_PUBLIC_KEY).keyId).toBe("fc9149bf27cbb2aa");
  });

  it("🔴 every entry in the trusted list parses, so a bad rotation cannot ship silently", () => {
    // A malformed new key would otherwise surface as "every release is refused" — on users'
    // machines, after the old key was retired, which is the point of no return.
    expect(MINISIGN_PUBLIC_KEYS.length).toBeGreaterThan(0);
    for (const text of MINISIGN_PUBLIC_KEYS) {
      expect(() => parsePublicKey(text)).not.toThrow();
    }
  });

  it("signs with the first entry; the rest of the list exists for the rotation window", () => {
    expect(MINISIGN_PUBLIC_KEY).toBe(MINISIGN_PUBLIC_KEYS[0]);
  });
});
