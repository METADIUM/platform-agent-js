import { describe, expect, it } from "vitest";
import { assetName, checksumFor, isNewer, parseVersion, planUpgrade, UpgradeError } from "../src/upgrade.js";

/**
 * The decisions `upgrade` makes before it touches the network. Everything here is pure, so a
 * failure means the command would have done the wrong thing — not that a download flaked.
 */
describe("which asset", () => {
  it("names the four targets the release workflow builds", () => {
    expect(assetName("darwin", "arm64")).toBe("metapass-agent-darwin-arm64");
    expect(assetName("linux", "x64")).toBe("metapass-agent-linux-x64");
  });

  it("🔴 refuses a target nothing is built for, instead of constructing a 404", () => {
    expect(() => assetName("win32", "x64")).toThrow(/no release binary is built for win32-x64/);
    expect(() => assetName("darwin", "ia32")).toThrow(UpgradeError);
  });
});

describe("which version is newer", () => {
  it("compares components numerically, not as text", () => {
    // 🔴 The whole point. "0.5.10" < "0.5.9" as strings, and the upgrade would stop being offered
    // exactly once the patch number reached double digits — silently, and only for some users.
    expect(isNewer("0.5.10", "0.5.9")).toBe(true);
    expect(isNewer("v0.5.10", "0.5.9")).toBe(true);
    expect(isNewer("0.9.0", "0.10.0")).toBe(false);
  });

  it("treats equal versions as not newer, both spellings", () => {
    expect(isNewer("v0.5.6", "0.5.6")).toBe(false);
  });

  it("handles a shorter version without treating the missing part as larger", () => {
    expect(isNewer("1.0", "1.0.0")).toBe(false);
    expect(isNewer("1.0.1", "1.0")).toBe(true);
  });

  it("🔴 refuses an unreadable version rather than scoring it zero", () => {
    // A version that parses as 0.0.0 would make every release look newer, or none.
    expect(() => parseVersion("abc")).toThrow(/cannot read/);
    expect(() => parseVersion("v1.x.3")).toThrow(/cannot read/);
  });
});

describe("what the command decides to do", () => {
  const base = { currentVersion: "0.5.4", latestTag: "v0.5.6", platform: "darwin", arch: "arm64" };

  it("🔴 refuses to replace anything when this is npx, not the binary", () => {
    // There is no single file to replace; execPath is the user's node.
    const plan = planUpgrade({ ...base, sea: false });
    expect(plan.action).toBe("not-a-binary");
    expect(plan).toMatchObject({ message: expect.stringContaining("npx @metadium-did/platform-agent-js@latest") });
  });

  it("does nothing when already on the latest", () => {
    expect(planUpgrade({ ...base, sea: true, currentVersion: "0.5.6" })).toMatchObject({ action: "up-to-date" });
  });

  it("plans a replacement with the target's asset", () => {
    expect(planUpgrade({ ...base, sea: true })).toMatchObject({
      action: "replace",
      from: "0.5.4",
      to: "0.5.6",
      asset: "metapass-agent-darwin-arm64",
    });
  });

  it("🔴 does not offer a downgrade when the release is older than the binary", () => {
    expect(planUpgrade({ ...base, sea: true, currentVersion: "0.6.0" })).toMatchObject({ action: "up-to-date" });
  });
});

describe("reading the signed checksum list", () => {
  const sums = [
    "1111111111111111111111111111111111111111111111111111111111111111  metapass-agent-linux-x64",
    "2222222222222222222222222222222222222222222222222222222222222222  metapass-agent-darwin-arm64",
    "3333333333333333333333333333333333333333333333333333333333333333  install.sh",
  ].join("\n");

  it("takes the line for this asset and not a prefix of another", () => {
    expect(checksumFor(sums, "metapass-agent-darwin-arm64")).toBe("2".repeat(64));
  });

  it("🔴 throws when the asset has no entry, rather than installing an unlisted file", () => {
    expect(() => checksumFor(sums, "metapass-agent-darwin-x64")).toThrow(/no entry for/);
  });
});
