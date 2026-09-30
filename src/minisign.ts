/**
 * Minisign signature verification, using only `node:crypto`.
 *
 * 🔴 **Why this exists at all.** `install.sh` shells out to the `minisign` binary and refuses to
 * install without it. That is correct for a first install — nothing trustworthy is on the machine
 * yet — but it makes every *upgrade* depend on a tool the user has to obtain separately. An
 * already-verified binary can verify the next one, and the runtime it ships with can do the maths:
 * Ed25519 and BLAKE2b-512 are both in the OpenSSL that Node embeds.
 *
 * 📌 Measured against the real `v0.5.6` release assets before this file was written: both the file
 * signature and the global signature verify, a one-byte edit fails, and another key fails. Those
 * assets are checked in as fixtures so the check runs offline.
 *
 * ⚠️ `alg` is **not** cosmetic. Modern minisign writes `ED`, which signs BLAKE2b-512 of the
 * content, not the content. Treating an `ED` signature as `Ed` verifies the wrong bytes and fails
 * closed — but treating `Ed` as `ED` would too, so neither is silently accepted here.
 */
import { createHash, createPublicKey, verify as edVerify, type KeyObject } from "node:crypto";

/** Ed25519 SubjectPublicKeyInfo prefix; `node:crypto` has no raw-key import. */
const SPKI_ED25519_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export interface MinisignKey {
  /** 8-byte key id, hex. A signature from another key is refused before any maths runs. */
  keyId: string;
  publicKey: KeyObject;
}

export interface MinisignSignature {
  /** `"Ed"` (signs the content) or `"ED"` (signs BLAKE2b-512 of the content). */
  alg: "Ed" | "ED";
  keyId: string;
  signature: Buffer;
  trustedComment: string;
  globalSignature: Buffer;
}

export class MinisignError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MinisignError";
  }
}

/** Parses a `.pub` file: comment lines are ignored, the payload is the last base64 line. */
export function parsePublicKey(text: string): MinisignKey {
  const line = text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("untrusted comment:"))
    .pop();
  if (!line) throw new MinisignError("public key file has no key line");
  const raw = Buffer.from(line, "base64");
  if (raw.length !== 42) throw new MinisignError(`public key is ${raw.length} bytes, expected 42`);
  if (raw.subarray(0, 2).toString("ascii") !== "Ed") {
    throw new MinisignError(`unsupported public key algorithm ${JSON.stringify(raw.subarray(0, 2).toString("ascii"))}`);
  }
  return {
    keyId: raw.subarray(2, 10).toString("hex"),
    publicKey: createPublicKey({
      key: Buffer.concat([SPKI_ED25519_PREFIX, raw.subarray(10)]),
      format: "der",
      type: "spki",
    }),
  };
}

/** Parses a `.minisig` file (4 lines: comment, signature, trusted comment, global signature). */
export function parseSignature(text: string): MinisignSignature {
  const lines = text.split("\n").map((l) => l.trimEnd());
  if (lines.length < 4) throw new MinisignError(`signature file has ${lines.length} lines, expected at least 4`);
  const blob = Buffer.from(lines[1].trim(), "base64");
  if (blob.length !== 74) throw new MinisignError(`signature blob is ${blob.length} bytes, expected 74`);
  const alg = blob.subarray(0, 2).toString("ascii");
  if (alg !== "Ed" && alg !== "ED") throw new MinisignError(`unsupported signature algorithm ${JSON.stringify(alg)}`);
  const marker = "trusted comment: ";
  if (!lines[2].startsWith(marker)) throw new MinisignError("line 3 is not a trusted comment");
  return {
    alg,
    keyId: blob.subarray(2, 10).toString("hex"),
    signature: blob.subarray(10),
    trustedComment: lines[2].slice(marker.length),
    globalSignature: Buffer.from(lines[3].trim(), "base64"),
  };
}

/**
 * Verifies `content` against `sig` under `key`. Throws on any failure; never returns false.
 *
 * 🔴 Throwing rather than returning a boolean is deliberate: a boolean return invites
 * `if (verify(...))` with no `else`, and the failure mode of this function is "install anything".
 */
export function verifyContent(content: Buffer, sig: MinisignSignature, key: MinisignKey): void {
  if (sig.keyId !== key.keyId) {
    throw new MinisignError(
      `signature was made by key ${sig.keyId}, this build trusts ${key.keyId} — ` +
        `if the release signing key was rotated, this binary cannot verify the new one; reinstall with install.sh`,
    );
  }
  const signed = sig.alg === "ED" ? createHash("blake2b512").update(content).digest() : content;
  if (!edVerify(null, signed, key.publicKey, sig.signature)) {
    throw new MinisignError("signature does not match the downloaded content");
  }
  // The trusted comment is only trustworthy because this second signature covers it.
  if (!edVerify(null, Buffer.concat([sig.signature, Buffer.from(sig.trustedComment, "utf8")]), key.publicKey, sig.globalSignature)) {
    throw new MinisignError("global signature does not match the trusted comment");
  }
}
