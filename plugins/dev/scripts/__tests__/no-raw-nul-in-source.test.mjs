// no-raw-nul-in-source.test.mjs — CTL-1811.
//
// A tracked source file must not contain a raw NUL byte, because `grep` classifies such a
// file as binary and reports NOTHING for it — not an error, just silence. Measured before
// the fix: five files under plugins/ were invisible this way, including broker/projection.mjs,
// where `grep -c abandoned` exited 1 with no output on a file containing three matches.
//
// The failure mode is a MISSED edit during a "find every place that handles X" sweep, which
// is the direction that strands work. It also defeats `git grep`, ripgrep's default binary
// handling, and most editor project-search.
//
// A NUL as a hash/key field-separator is legitimate and should stay — but written as the
// `\u0000` ESCAPE, which produces an identical string at runtime while keeping the file text.
// projection-hash-stability.test.mjs proves the digests did not move.
import { describe, test, expect } from "bun:test";
import { readFileSync, readdirSync, statSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join, extname } from "node:path";
import { tmpdir } from "node:os";

const ROOT = join(import.meta.dir, "..");

// Extensions that are legitimately binary. Everything NOT in this list is treated as source —
// deliberately the safe direction: a new text extension is checked by default rather than
// silently skipped. (The original hand-audit missed .tsx precisely by listing extensions to
// INCLUDE; this lists what to EXCLUDE.)
const BINARY_EXT = new Set([
  ".png", ".ico", ".icns", ".jpg", ".jpeg", ".gif", ".webp", ".pdf", ".zip", ".gz", ".tgz",
  ".woff", ".woff2", ".ttf", ".otf", ".eot", ".db", ".sqlite", ".wasm", ".node", ".bin",
  ".mp4", ".mov", ".jar", ".class", ".so", ".dylib",
]);

const SKIP_DIR = new Set(["node_modules", ".git", "dist", "build", ".next", "coverage", ".turbo"]);

function* sourceFiles(dir) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (SKIP_DIR.has(name)) continue;
    const p = join(dir, name);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      yield* sourceFiles(p);
    } else if (!BINARY_EXT.has(extname(name).toLowerCase())) {
      yield p;
    }
  }
}

const hasRawNul = (path) => {
  try {
    return readFileSync(path).includes(0);
  } catch {
    return false;
  }
};

describe("CTL-1811 — no tracked source file may contain a raw NUL byte", () => {
  test("every source file under plugins/dev/scripts is visible to grep", () => {
    const offenders = [...sourceFiles(ROOT)].filter(hasRawNul);
    // Named, not just counted — a bare count tells the next reader nothing about what to fix.
    expect(offenders.map((p) => p.slice(ROOT.length + 1))).toEqual([]);
  });

  // THE DELETED-SUBSCRIBER TEST, applied to a guard: a check that has never been SEEN failing
  // is not known to work. Seed a fixture containing a raw NUL and assert the detector flags it.
  test("the detector actually detects — proven against a seeded fixture", () => {
    const dir = mkdtempSync(join(tmpdir(), "nul-fixture-"));
    try {
      const clean = join(dir, "clean.ts");
      const dirty = join(dir, "dirty.ts");
      writeFileSync(clean, 'const sep = "\\u0000";\n'); // the ESCAPE — must NOT trip
      writeFileSync(dirty, Buffer.from([0x61, 0x00, 0x62])); // a RAW NUL — must trip
      expect(hasRawNul(clean)).toBe(false);
      expect(hasRawNul(dirty)).toBe(true);
      // …and the walker reaches both, so a real offender could not hide from it.
      const walked = [...sourceFiles(dir)].sort();
      expect(walked).toEqual([clean, dirty].sort());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a binary extension is excluded, so images cannot make this test permanently red", () => {
    const dir = mkdtempSync(join(tmpdir(), "nul-bin-"));
    try {
      writeFileSync(join(dir, "logo.png"), Buffer.from([0x89, 0x50, 0x00, 0x4e]));
      expect([...sourceFiles(dir)]).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
