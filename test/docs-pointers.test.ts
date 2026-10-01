import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Source files point at `platform-docs` for the reasoning that was moved out of them. A pointer to
 * another repository is the one kind of reference nothing here can follow, so it rots silently —
 * mini-paas carried a 404 docs path for five days before anyone noticed.
 */
const ROOT = join(import.meta.dirname, "..");
const PLATFORM_DOCS = join(ROOT, "..", "platform-docs");

/** Which source file must point at which document. Both halves are checked. */
const REQUIRED_POINTERS: Record<string, string> = {
  "src/release-key.ts": "42-agent-cli-release-key-rotation.md",
  "src/wire-surface.ts": "43-agent-cli-wire-compatibility.md",
};

const POINTER_RE = /platform-docs\/([0-9]{2}-[A-Za-z0-9._-]+\.md)/g;

function pointersIn(relPath: string): string[] {
  const text = readFileSync(join(ROOT, relPath), "utf8");
  return [...text.matchAll(POINTER_RE)].map((m) => m[1]);
}

describe("pointers into platform-docs", () => {
  it("every file that moved its reasoning out still says where it went", () => {
    for (const [file, doc] of Object.entries(REQUIRED_POINTERS)) {
      expect(
        pointersIn(file),
        `${file} no longer points at ${doc} — the reasoning moved there and nothing else names it`,
      ).toContain(doc);
    }
  });

  // 🔴 In CI this is a NOTICE, not a gate: there is no platform-docs checkout there, so a green CI
  //    run does NOT mean the pointers resolve. It is a gate only on a machine with the sibling
  //    layout. Do not cite the suite passing in CI as evidence that these documents exist.
  //    (`[minipaas]`, review of platform-docs#4, who also declined the obvious fix — making CI fetch
  //    platform-docs would add a network dependency to the suite, the same cost they turned down for
  //    their own wire-surface check.)
  it("the documents those pointers name exist", () => {
    if (!existsSync(PLATFORM_DOCS)) {
      // Not a silent pass: CI has no platform-docs checkout, so resolution is only ever measured on
      // a developer machine with the sibling layout. Say so rather than report a green.
      console.warn(
        "docs-pointers: ../platform-docs is not checked out — pointer RESOLUTION was not measured, " +
          "only that the pointers are present.",
      );
      expect(existsSync(ROOT)).toBe(true);
      return;
    }
    const present = new Set(readdirSync(PLATFORM_DOCS));
    for (const [file, doc] of Object.entries(REQUIRED_POINTERS)) {
      expect(present.has(doc), `${file} points at platform-docs/${doc}, which does not exist`).toBe(true);
    }
  });
});
