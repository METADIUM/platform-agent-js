import { generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MinisignError, parsePublicKey, parseSignature, verifyContent, verifyContentAny } from "../src/minisign.js";

/**
 * 🔴 This is the check that lets `upgrade` replace the binary without the `minisign` tool.
 * If it is wrong in the permissive direction, the command installs whatever it downloaded.
 *
 * The vectors are the **real `v0.5.6` release assets**, checked in so this runs offline. They are
 * 370 and 305 bytes; the point is not their size but that nobody in this repo produced them —
 * they were signed by the CI key, so a bug in our own signing path cannot make this pass.
 *
 * ⚠️ Every assertion below that the signature is GOOD is worth nothing on its own. The ones that
 * matter are the three that must FAIL, because "verify" that returns success for everything also
 * returns success for the real vector.
 */
const root = join(import.meta.dirname, "..");
const pubText = readFileSync(join(root, "minisign.pub"), "utf8");
const sumsPath = join(root, "test/fixtures/SHA256SUMS.v0.5.6");
const sigPath = join(root, "test/fixtures/SHA256SUMS.v0.5.6.minisig");

describe("minisign verification against the real release key", () => {
  const key = parsePublicKey(pubText);
  const sig = parseSignature(readFileSync(sigPath, "utf8"));
  const content = readFileSync(sumsPath);

  it("accepts the signature the release CI actually produced", () => {
    expect(() => verifyContent(content, sig, key)).not.toThrow();
  });

  it("reads the algorithm from the file rather than assuming one", () => {
    // Modern minisign writes ED (BLAKE2b-512 prehash). If this ever reads Ed for a real release,
    // the verifier is hashing the wrong bytes and the test above is passing for another reason.
    expect(sig.alg).toBe("ED");
    expect(sig.keyId).toBe(key.keyId);
  });

  // ── the three that have to fail ───────────────────────────────────────────────────────────
  it("🔴 refuses content changed by one byte", () => {
    const tampered = Buffer.from(content);
    tampered[0] ^= 0x01;
    expect(() => verifyContent(tampered, sig, key)).toThrow(MinisignError);
  });

  it("🔴 refuses a different key, before doing any maths", () => {
    const other = { keyId: "0000000000000000", publicKey: generateKeyPairSync("ed25519").publicKey };
    expect(() => verifyContent(content, sig, other)).toThrow(/this release is signed by key/);
  });

  it("🔴 refuses a tampered trusted comment even when the file signature still matches", () => {
    // The trusted comment is what a UI would show. Its own signature is the only thing making it
    // trustworthy, so editing it must fail even though the content signature is untouched.
    expect(() => verifyContent(content, { ...sig, trustedComment: sig.trustedComment + " " }, key)).toThrow(
      /global signature/,
    );
  });

  it("🔴 refuses an Ed signature presented as raw when it is really prehashed", () => {
    expect(() => verifyContent(content, { ...sig, alg: "Ed" }, key)).toThrow(/does not match the downloaded content/);
  });
});

describe("parsing refuses malformed input rather than guessing", () => {
  it("rejects a public key of the wrong length", () => {
    expect(() => parsePublicKey("untrusted comment: x\nRWQ=\n")).toThrow(/expected 42/);
  });

  it("rejects an unknown signature algorithm", () => {
    const real = readFileSync(sigPath, "utf8").split("\n");
    const blob = Buffer.from(real[1].trim(), "base64");
    blob.write("XX", 0, "ascii");
    real[1] = blob.toString("base64");
    expect(() => parseSignature(real.join("\n"))).toThrow(/unsupported signature algorithm/);
  });

  it("rejects a signature file whose third line is not a trusted comment", () => {
    const real = readFileSync(sigPath, "utf8").split("\n");
    real[2] = "comment: not the marker";
    expect(() => parseSignature(real.join("\n"))).toThrow(/not a trusted comment/);
  });
});

describe("rotation: a build trusts a list, not a key", () => {
  const key = parsePublicKey(pubText);
  const sig = parseSignature(readFileSync(sigPath, "utf8"));
  const content = readFileSync(sumsPath);
  const stranger = { keyId: "0000000000000000", publicKey: generateKeyPairSync("ed25519").publicKey };

  it("accepts when the signing key is anywhere in the trusted list", () => {
    // This is the rotation window: a binary shipped with both keys takes releases signed by either.
    expect(() => verifyContentAny(content, sig, [stranger, key])).not.toThrow();
    expect(() => verifyContentAny(content, sig, [key, stranger])).not.toThrow();
  });

  it("🔴 refuses when no trusted key matches, and names the recovery command", () => {
    // 🔴 The message is the only thing a stranded user has. [Briefick]'s point: naming the file is
    // not enough, and the recovery route re-requires minisign — on the one day it is needed.
    let message = "";
    try {
      verifyContentAny(content, sig, [stranger]);
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain("signed by key fc9149bf27cbb2aa");
    expect(message).toContain("brew install minisign");
    expect(message).toContain("curl -fsSL -o install.sh");
    // 🔴 The recovery path must not need a tool the stranded user may not have. `gh` needs a
    // login for its API endpoints; `curl` needs nothing, and this repository is public.
    expect(message).not.toContain("gh release download");
    expect(message).toContain("needs the minisign tool again");
  });

  it("🔴 refuses an empty trusted list rather than accepting anything", () => {
    expect(() => verifyContentAny(content, sig, [])).toThrow(MinisignError);
  });
});

describe("the trust material the upgrade command actually hands over", () => {
  it("🔴 passes EVERY trusted key, not just the signing one", async () => {
    // ⚠️ **This assertion is asleep while the list has one element.** `[MINISIGN_PUBLIC_KEYS[0]]`
    // and `MINISIGN_PUBLIC_KEYS` are then the same value, so the sabotage that matters passes here
    // and only the control below catches it (`[metapass-saas]`, review of #22, who measured it).
    // ⇒ It wakes on the day a second key is added — which is rotation day, the day this file gets
    // edited under pressure. Not fixed with a fabricated second key: a key in the production
    // trust list that exists to keep a test honest is a real thing shipped for a test's sake.
    // 🔴 The rotation plan is one subscript away from being undone. `[MINISIGN_PUBLIC_KEYS[0]]`
    // instead of the list leaves a binary unable to accept a release signed by the next key —
    // the exact failure the list exists to prevent — and it left all 153 tests green until this
    // one existed ([Briefick], review of #22).
    const { upgradeIo } = await import("../src/cli.js");
    const { MINISIGN_PUBLIC_KEYS } = await import("../src/release-key.js");
    const io = upgradeIo(() => {});
    expect(io.publicKeyTexts).toEqual(MINISIGN_PUBLIC_KEYS);
    expect(io.publicKeyTexts.length).toBe(MINISIGN_PUBLIC_KEYS.length);
  });

  it("🔴 follows the list when it grows — the control for the line above", async () => {
    // Asserting equality against the same constant passes for a copy too. Move the original.
    const { upgradeIo } = await import("../src/cli.js");
    const keys = (await import("../src/release-key.js")).MINISIGN_PUBLIC_KEYS as string[];
    const before = upgradeIo(() => {}).publicKeyTexts.length;
    keys.push("untrusted comment: probe\nRWTKlL8ny0mh/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=\n");
    try {
      expect(upgradeIo(() => {}).publicKeyTexts.length).toBe(before + 1);
    } finally {
      keys.pop();
    }
    expect(upgradeIo(() => {}).publicKeyTexts.length).toBe(before);
  });
});
