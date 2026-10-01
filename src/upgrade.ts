/**
 * Replacing this binary with a newer signed one, using nothing the machine does not already have.
 *
 * 🔴 **`upgrade` used to not upgrade.** It reinstalled the launchd/systemd unit and restarted it,
 * which refreshes the exec line and leaves the file alone — so "I upgraded and the version is the
 * same" was the expected outcome, and the command had to say so in its own output. This is the
 * command doing what its name says.
 *
 * 📌 **Why it can.** The first install cannot verify itself — nothing trustworthy is on the machine
 * yet, which is why `install.sh` requires `minisign`. An upgrade is different: a binary that was
 * verified at install time verifies the next one, and the Node runtime it ships with has Ed25519
 * and BLAKE2b-512. The chain has a root (`install.sh`) and this extends it.
 *
 * ⚠️ **Two preconditions, both outside this file.** The release repository must be reachable
 * without credentials (it is public as of 2026-09-30; while it was private this command could not
 * have worked at all), and the signing key is compiled in — see `verifyContent` for what happens
 * when the release is signed by a different one.
 *
 * The decision-making below is separated from the I/O so it can be tested without a network or a
 * 112 MB download: `assetName`, `isNewer` and `planUpgrade` are pure.
 */
import { createHash } from "node:crypto";
import { chmodSync, renameSync, statfsSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { MinisignError, parsePublicKey, parseSignature, verifyContentAny } from "./minisign.js";

export const RELEASE_REPO = "METADIUM/platform-agent-js";
export const RELEASE_BASE = `https://github.com/${RELEASE_REPO}/releases`;

/** Platforms the release workflow actually builds. Anything else must say so, not guess. */
const BUILT_TARGETS = new Set(["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"]);

export class UpgradeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UpgradeError";
  }
}

/**
 * The release asset for a target.
 *
 * ⚠️ Kept as one expression with `BUILT_TARGETS` beside it so an unbuilt platform is a clear
 * refusal rather than a 404 three steps later. `win32` has never been built.
 */
export function assetName(platform: string = process.platform, arch: string = process.arch): string {
  const target = `${platform}-${arch}`;
  if (!BUILT_TARGETS.has(target)) {
    throw new UpgradeError(
      `no release binary is built for ${target} (built: ${[...BUILT_TARGETS].join(", ")}) — ` +
        `install from npm instead: npx @metadium-did/platform-agent-js`,
    );
  }
  return `metapass-agent-${target}`;
}

/** `v1.2.3` / `1.2.3` → numeric components. Non-numeric parts make it unusable, not zero. */
export function parseVersion(raw: string): number[] {
  const cleaned = raw.trim().replace(/^v/, "").split("-")[0];
  const parts = cleaned.split(".");
  if (parts.length === 0 || parts.some((p) => !/^\d+$/.test(p))) {
    throw new UpgradeError(`cannot read ${JSON.stringify(raw)} as a version`);
  }
  return parts.map((p) => Number.parseInt(p, 10));
}

/**
 * Is `candidate` newer than `current`?
 *
 * 🔴 Compares components numerically. A string compare puts `0.5.10` before `0.5.9` and the
 * upgrade silently stops being offered — the same defect shape the version gate hit in the wallets.
 */
export function isNewer(candidate: string, current: string): boolean {
  const a = parseVersion(candidate);
  const b = parseVersion(current);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return false;
}

export type UpgradePlan =
  | { action: "not-a-binary"; message: string }
  | { action: "up-to-date"; version: string }
  | { action: "replace"; from: string; to: string; asset: string; target: string };

/**
 * What `upgrade` should do, decided without touching the network or the disk.
 *
 * ⚠️ `sea === false` means this process is `npx`/`node dist/cli.js`. There is no single file to
 * replace, and rewriting whatever `execPath` points at would clobber the user's Node. It refuses
 * and names the npm path instead.
 */
export function planUpgrade(opts: {
  sea: boolean;
  currentVersion: string;
  latestTag: string;
  platform?: string;
  arch?: string;
}): UpgradePlan {
  if (!opts.sea) {
    return {
      action: "not-a-binary",
      message:
        "this is the npm package, not the installed binary — there is no file to replace.\n" +
        "  npx @metadium-did/platform-agent-js@latest …   (or: npm i -g @metadium-did/platform-agent-js@latest)",
    };
  }
  if (!isNewer(opts.latestTag, opts.currentVersion)) {
    return { action: "up-to-date", version: opts.currentVersion };
  }
  const platform = opts.platform ?? process.platform;
  const arch = opts.arch ?? process.arch;
  return {
    action: "replace",
    from: opts.currentVersion,
    to: opts.latestTag.replace(/^v/, ""),
    asset: assetName(platform, arch),
    target: `${platform}-${arch}`,
  };
}

/** The checksum line for `asset` in a `SHA256SUMS` body. */
export function checksumFor(sums: string, asset: string): string {
  for (const line of sums.split("\n")) {
    const m = line.trim().match(/^([0-9a-f]{64})\s+\*?(.+)$/);
    if (m && m[2].trim() === asset) return m[1];
  }
  throw new UpgradeError(`SHA256SUMS has no entry for ${asset}`);
}

export interface UpgradeIo {
  fetchText(url: string): Promise<string>;
  fetchBinary(url: string): Promise<Buffer>;
  publicKeyTexts: readonly string[];
  log(line: string): void;
}

/** The latest release tag, from the API that works without credentials on a public repository. */
export async function latestTag(io: Pick<UpgradeIo, "fetchText">): Promise<string> {
  const body = await io.fetchText(`https://api.github.com/repos/${RELEASE_REPO}/releases/latest`);
  const tag = (JSON.parse(body) as { tag_name?: unknown }).tag_name;
  if (typeof tag !== "string" || tag.length === 0) throw new UpgradeError("the latest release has no tag_name");
  return tag;
}

/**
 * Downloads, verifies and atomically replaces `destination`.
 *
 * 🔴 The order is signature → checksum → replace, and each step throws. `install.sh` documents why
 * the staged-then-`rename(2)` shape matters: dying midway through an in-place overwrite leaves a
 * binary that is neither version and cannot be run to fix itself.
 */
export async function downloadVerified(
  plan: Extract<UpgradePlan, { action: "replace" }>,
  destination: string,
  io: UpgradeIo,
): Promise<void> {
  const base = `${RELEASE_BASE}/download/v${plan.to}`;
  const keys = io.publicKeyTexts.map(parsePublicKey);

  io.log(`  fetching SHA256SUMS and its signature (${plan.to})`);
  const sumsText = await io.fetchText(`${base}/SHA256SUMS`);
  const sigText = await io.fetchText(`${base}/SHA256SUMS.minisig`);
  verifyContentAny(Buffer.from(sumsText, "utf8"), parseSignature(sigText), keys);
  io.log("  ✅ signature over SHA256SUMS verified");

  const expected = checksumFor(sumsText, plan.asset);
  io.log(`  downloading ${plan.asset} (~110 MB)`);
  const binary = await io.fetchBinary(`${base}/${plan.asset}`);
  const actual = createHash("sha256").update(binary).digest("hex");
  if (actual !== expected) {
    throw new UpgradeError(`checksum mismatch for ${plan.asset}: expected ${expected}, got ${actual}`);
  }
  io.log("  ✅ checksum matches the signed list");

  const dir = dirname(destination);
  const staged = join(dir, `.metapass-agent.new.${process.pid}`);
  try {
    writeFileSync(staged, binary);
    chmodSync(staged, 0o755);
    // Same directory, so this is rename(2): either it happens or the old binary is untouched.
    renameSync(staged, destination);
  } catch (e) {
    try {
      unlinkSync(staged);
    } catch {
      /* the staged file may not exist */
    }
    throw e;
  }
}

/** Free bytes on the volume holding `path`, or undefined where it cannot be read. */
export function freeBytes(path: string): number | undefined {
  try {
    const s = statfsSync(path);
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    return undefined;
  }
}

export { MinisignError };
