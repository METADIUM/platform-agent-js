import { describe, expect, it } from "vitest";
import { DEFAULT_RP_PATHS } from "../src/config.js";

describe("the assembly, not a value handed in", () => {
  it("🔴 builds the MCP URL by READING the default, not by repeating its value", async () => {
    // 🔴 Asserting the output is not enough, and this is measured rather than reasoned: putting the
    // literal "/api/mcp" back into the assembly left all eight tests green, because the literal and
    // the default are the same string. The test saw the value and not the dependency — which is the
    // dead-copy defect this PR exists to remove, reintroduced where the PR's own tests cannot look.
    //
    // ⇒ So move the default and assert the assembly follows. A hardcoded literal does not.
    const { mcpUrlFor } = await import("../src/cli.js");
    const real = DEFAULT_RP_PATHS.mcpPath;
    try {
      (DEFAULT_RP_PATHS as { mcpPath: string }).mcpPath = "/sentinel-not-a-real-path";
      expect(mcpUrlFor("https://rp.example")).toBe("https://rp.example/sentinel-not-a-real-path");
    } finally {
      (DEFAULT_RP_PATHS as { mcpPath: string }).mcpPath = real;
    }
    // 🔴 CONTROL: the restore worked, so later tests are not reading a sentinel.
    expect(DEFAULT_RP_PATHS.mcpPath).toBe("/api/mcp");
    expect(mcpUrlFor("https://rp.example")).toBe("https://rp.example/api/mcp");
  });

  it("strips trailing slashes so the path is not doubled", async () => {
    const { mcpUrlFor } = await import("../src/cli.js");
    expect(mcpUrlFor("https://rp.example///")).toBe("https://rp.example/api/mcp");
  });

  it("an explicit --mcp-path overrides the default without touching it", async () => {
    const { mcpUrlFor } = await import("../src/cli.js");
    expect(mcpUrlFor("https://rp.example", "/custom")).toBe("https://rp.example/custom");
    // 🔴 CONTROL: the override must not be what makes the first test pass.
    expect(mcpUrlFor("https://rp.example", "/custom")).not.toContain(DEFAULT_RP_PATHS.mcpPath);
  });
});
