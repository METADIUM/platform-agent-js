import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Source files point at `platform-docs` for the reasoning that was moved out of them. A pointer to
 * another repository is the one kind of reference nothing here can follow, so it rots silently —
 * mini-paas carried a 404 docs path for five days.
 */
const ROOT = join(import.meta.dirname, "..");
const PLATFORM_DOCS = join(ROOT, "..", "platform-docs");

/** Which source file must point at which document, by full name so a rename goes red. */
const REQUIRED_POINTERS: Record<string, string> = {
  "src/release-key.ts": "42-agent-cli-release-key-rotation.md",
  "src/wire-surface.ts": "43-agent-cli-wire-compatibility.md",
  "src/delegation-refresh.ts": "44-agent-delegation-refresh.md",
};

/**
 * A resolvable reference: `platform-docs/NN`, optionally with the rest of the filename. The number
 * alone is enough to resolve and is how prose cites them (`platform-docs/22`), so both forms pass —
 * what cannot pass is naming the repository with no document at all.
 */
const REF_RE = /platform-docs\/(\d{2})(?:-\S*?\.md)?/g;

/**
 * A PR or issue reference — `platform-docs#5` — is a different thing from a document pointer and is
 * resolvable on its own, so it is allowed. ⚠️ Without this it was refused as a bare mention, which
 * would have made citing the PR that introduced a document impossible (`[Briefick]`, review of
 * c411775).
 */
const ISSUE_RE = /platform-docs#\d+/g;

/**
 * Everything that may cite platform-docs. ⚠️ This file is excluded deliberately: it names the repo
 * in prose throughout, and including it would make the check report its own text.
 */
const SCANNED = [
  ...readdirSync(join(ROOT, "src")).filter((f) => f.endsWith(".ts")).map((f) => join("src", f)),
  ...readdirSync(join(ROOT, "scripts")).map((f) => join("scripts", f)),
  ...readdirSync(join(ROOT, ".github", "workflows")).map((f) => join(".github", "workflows", f)),
  "README.md",
];

function refsIn(relPath: string): string[] {
  const text = readFileSync(join(ROOT, relPath), "utf8");
  return [...text.matchAll(REF_RE)].map((m) => m[0]);
}

function numbersIn(relPath: string): string[] {
  const text = readFileSync(join(ROOT, relPath), "utf8");
  return [...text.matchAll(REF_RE)].map((m) => m[1]);
}

/**
 * 🔴 A reference that names no document is the hole this suite was built to close and did not. `#33`
 * carried "`platform-docs`, agent delegation" — prose naming no document, pointing at one that did
 * not exist — and it matched nothing, so nothing looked at it (`[Briefick]`, review of a04cce0).
 * A reference that cannot be resolved cannot be checked, so the FORM itself is refused.
 */
function unresolvableIn(relPath: string): string[] {
  const text = readFileSync(join(ROOT, relPath), "utf8");
  const residue = text.replace(REF_RE, "").replace(ISSUE_RE, "");
  return residue.split("\n").filter((line) => line.includes("platform-docs"));
}

describe("pointers into platform-docs", () => {
  it("🔴 nothing names platform-docs without naming a document", () => {
    for (const f of SCANNED) {
      expect(
        unresolvableIn(f),
        `${f} names platform-docs with no document number. Accepted forms: ` +
          "`platform-docs/NN`, `platform-docs/NN-full-name.md`, or `platform-docs#N` for a PR. " +
          "A reference nothing can follow is the defect this suite exists for",
      ).toEqual([]);
    }
  });

  it("every file that moved its reasoning out still says where it went", () => {
    for (const [file, doc] of Object.entries(REQUIRED_POINTERS)) {
      expect(
        refsIn(file).join(" "),
        `${file} no longer points at ${doc} — the reasoning moved there and nothing else names it`,
      ).toContain(doc);
    }
  });

  // 🔴 In CI this is a NOTICE, not a gate: there is no platform-docs checkout there, so a green CI
  //    run does NOT mean these resolve. It is a gate only on a machine with the sibling layout.
  //    Do not cite the suite passing in CI as evidence that these documents exist.
  //    Making CI fetch platform-docs would turn it into a real gate, at the cost of a network
  //    dependency in the suite. ⚠️ `[minipaas]` turned that cost down **for their own**
  //    wire-surface check and said prescribing it here would be inconsistent — they did NOT
  //    measure it to be wrong here.
  it("every document referenced anywhere actually exists", () => {
    if (!existsSync(PLATFORM_DOCS)) {
      console.warn(
        "docs-pointers: ../platform-docs is not checked out — RESOLUTION was not measured, " +
          "only that every reference names a document.",
      );
      expect(existsSync(ROOT)).toBe(true);
      return;
    }
    const present = readdirSync(PLATFORM_DOCS);
    for (const f of SCANNED) {
      for (const n of numbersIn(f)) {
        expect(
          present.some((d) => d.startsWith(`${n}-`)),
          `${f} cites platform-docs/${n}, and no document with that number exists`,
        ).toBe(true);
      }
    }
  });
});
