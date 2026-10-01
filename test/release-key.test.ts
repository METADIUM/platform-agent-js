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

  it("🔴 every entry in the trusted list parses", () => {
    // A malformed new key would otherwise surface as "every release is refused" — on users'
    // machines, after the old key was retired, which is the point of no return.
    // ⚠️ Parsing is a weak property and this test used to claim more than it checks: its name said
    // "so a bad rotation cannot ship silently", and a 56-character base64 string of the right
    // shape parses fine whatever is in it. The name now matches the assertion; the rotation
    // failures that are actually reachable are below.
    expect(MINISIGN_PUBLIC_KEYS.length).toBeGreaterThan(0);
    for (const text of MINISIGN_PUBLIC_KEYS) {
      expect(() => parsePublicKey(text)).not.toThrow();
    }
  });

  it("🔴 the trusted key ids are distinct, so a rotation cannot add a key that is never selected", () => {
    // `verifyContentAny` picks by `keys.find((k) => k.keyId === sig.keyId)`, so a second entry
    // sharing an id with an earlier one is **unreachable** — find() stops at the first.
    //
    // ⚠️ This is the rotation failure that costs the most and shows the least. Add the new key with
    // a duplicated id, ship the intermediate release, retire the old key, and every install refuses
    // every release afterwards with "signed by key X; this binary trusts X" — a message that names
    // the key it is holding and still cannot use. Nothing before this assertion caught it: a
    // duplicate parses, and the list was only ever checked for length and parseability.
    const ids = MINISIGN_PUBLIC_KEYS.map((text) => parsePublicKey(text).keyId);
    expect(new Set(ids).size, `duplicate key id in the trusted list: ${ids.join(", ")}`).toBe(ids.length);
  });

  it("signs with the first entry; the rest of the list exists for the rotation window", () => {
    expect(MINISIGN_PUBLIC_KEY).toBe(MINISIGN_PUBLIC_KEYS[0]);
  });
});
