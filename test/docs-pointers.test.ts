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
  "src/delegation-refresh.ts": "44-agent-delegation-refresh.md",
};

const POINTER_RE = /platform-docs\/([0-9]{2}-[A-Za-z0-9._-]+\.md)/g;

function pointersIn(relPath: string): string[] {
  const text = readFileSync(join(ROOT, relPath), "utf8");
  return [...text.matchAll(POINTER_RE)].map((m) => m[1]);
}

/**
 * 🔴 A pointer that names no file is the hole this suite was built to close and did not. `#33`
 * carried "`platform-docs`, agent delegation" — prose naming no document, pointing at one that did
 * not exist — and it matched {@link POINTER_RE} nowhere, so nothing looked at it (`[Briefick]`,
 * review of a04cce0). A reference that cannot be resolved cannot be checked, so the form itself is
 * refused.
 */
function bareMentionsIn(relPath: string): string[] {
  const text = readFileSync(join(ROOT, relPath), "utf8");
  // Remove every well-formed pointer, then anything still naming the repo is a bare mention.
  const residue = text.replace(POINTER_RE, "");
  return residue.split("\n").filter((line) => line.includes("platform-docs"));
}

describe("pointers into platform-docs", () => {
  it("🔴 no source file mentions platform-docs without naming a document", () => {
    const sources = readdirSync(join(ROOT, "src")).filter((f) => f.endsWith(".ts"));
    for (const f of sources) {
      const bare = bareMentionsIn(join("src", f));
      expect(
        bare,
        `src/${f} names platform-docs without a resolvable NN-….md — ` +
          "a pointer nothing can follow is the defect this suite exists for",
      ).toEqual([]);
    }
  });

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
  //    Making CI fetch platform-docs would turn it into a real gate, at the cost of a network
  //    dependency in the suite. ⚠️ `[minipaas]` turned that cost down **for their own** wire-surface
  //    check and said prescribing it here would be inconsistent — they did NOT measure it to be
  //    wrong here. (Their correction of an earlier version of this comment, which stated their
  //    position without that scope.)
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
