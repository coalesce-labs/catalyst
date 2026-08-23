// comment-body-arg.test.mjs — CTL-2204. The shared body-resolution rule for the Linear
// comment tools (linear-reply.mjs, ask.mjs). See comment-body-arg.mjs for why this is one
// leaf shared by two callers rather than two hand-rolled parsers.
import { describe, test, expect } from "bun:test";
import { resolveCommentBody, BODY_REFUSAL } from "./comment-body-arg.mjs";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// A hermetic fake fs: only the paths in `files` exist. The seam is statSync (NOT existsSync)
// because the leaf needs to tell ENOENT apart from "I could not look" — statSync with
// throwIfNoEntry:false returns undefined for the former and throws for every other errno.
const fakeFs = (files) => ({
  statSync: (p) => (Object.hasOwn(files, p) ? { isFile: () => true } : undefined),
  readFileSync: (p) => {
    if (!Object.hasOwn(files, p)) throw new Error(`ENOENT: ${p}`);
    return files[p];
  },
});

// A seam whose existence check cannot answer — EACCES on a chmod-000 parent dir, ELOOP on a
// symlink cycle, ENAMETOOLONG. statSync throws for all of these even with throwIfNoEntry.
const uncheckableFs = (errno = "EACCES") => ({
  statSync: () => {
    throw Object.assign(new Error(`${errno}: permission denied`), { code: errno });
  },
  readFileSync: () => {
    throw Object.assign(new Error(`${errno}: permission denied`), { code: errno });
  },
});

describe("plain bodies still work", () => {
  test("a normal markdown body passes through unchanged", () => {
    const r = resolveCommentBody({ body: "hello world", fs: fakeFs({}) });
    expect(r).toEqual({ ok: true, body: "hello world" });
  });

  test("a multi-line body containing a path-looking line is NOT refused", () => {
    // The guard is anchored ^…$ over the TRIMMED whole string, so real prose
    // that merely mentions a path can never trip it.
    const body = "I wrote it to\n/tmp/x.md\nand it worked";
    const r = resolveCommentBody({ body, fs: fakeFs({ "/tmp/x.md": "c" }) });
    expect(r).toEqual({ ok: true, body });
  });

  test("a body with spaces that starts with a slash is NOT refused", () => {
    const r = resolveCommentBody({ body: "/tmp/x.md is where I put it", fs: fakeFs({ "/tmp/x.md": "c" }) });
    expect(r.ok).toBe(true);
  });
});

describe("--body refuses a path to an EXISTING file", () => {
  test("absolute path that exists → refused, naming --body-file", () => {
    const r = resolveCommentBody({ body: "/tmp/x.md", fs: fakeFs({ "/tmp/x.md": "contents" }) });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe(BODY_REFUSAL.PATH_AS_BODY);
    expect(r.message).toContain("--body-file");
    expect(r.message).toContain("/tmp/x.md");
  });

  test("surrounding whitespace does not evade the guard", () => {
    const r = resolveCommentBody({ body: "  /tmp/x.md\n", fs: fakeFs({ "/tmp/x.md": "c" }) });
    expect(r.reason).toBe(BODY_REFUSAL.PATH_AS_BODY);
  });

  test("~/ path is expanded against HOME and refused when it exists", () => {
    const r = resolveCommentBody({
      body: "~/notes/x.md",
      env: { HOME: "/Users/ryan" },
      fs: fakeFs({ "/Users/ryan/notes/x.md": "c" }),
    });
    expect(r.reason).toBe(BODY_REFUSAL.PATH_AS_BODY);
  });

  test("an absolute path that does NOT exist is a legitimate (if odd) body", () => {
    // Fail direction: only refuse what we can PROVE is a file. A non-existent
    // path is not evidence of the mistake, and refusing it would be a guess.
    const r = resolveCommentBody({ body: "/tmp/nope.md", fs: fakeFs({}) });
    expect(r).toEqual({ ok: true, body: "/tmp/nope.md" });
  });

  test("a RELATIVE path that exists is NOT refused (documented scope)", () => {
    const r = resolveCommentBody({ body: "README.md", fs: fakeFs({ "README.md": "c" }) });
    expect(r.ok).toBe(true);
  });
});

describe("--body-file", () => {
  test("reads the file and returns its contents", () => {
    const r = resolveCommentBody({ bodyFile: "/tmp/x.md", fs: fakeFs({ "/tmp/x.md": "# real body\n" }) });
    expect(r).toEqual({ ok: true, body: "# real body\n" });
  });

  test("a missing file is refused, naming the path", () => {
    const r = resolveCommentBody({ bodyFile: "/tmp/gone.md", fs: fakeFs({}) });
    expect(r.reason).toBe(BODY_REFUSAL.BODY_FILE_MISSING);
    expect(r.message).toContain("/tmp/gone.md");
  });

  test("a file whose contents are whitespace-only is refused as empty", () => {
    const r = resolveCommentBody({ bodyFile: "/tmp/x.md", fs: fakeFs({ "/tmp/x.md": "   \n\t\n" }) });
    expect(r.reason).toBe(BODY_REFUSAL.EMPTY);
  });

  test("an unreadable file is refused, not crashed", () => {
    const fs = { statSync: () => ({ isFile: () => true }), readFileSync: () => { throw new Error("EACCES"); } };
    const r = resolveCommentBody({ bodyFile: "/tmp/x.md", fs });
    expect(r.reason).toBe(BODY_REFUSAL.BODY_FILE_UNREADABLE);
  });
});

describe("empty / missing / ambiguous", () => {
  test("neither --body nor --body-file → MISSING", () => {
    expect(resolveCommentBody({ fs: fakeFs({}) }).reason).toBe(BODY_REFUSAL.MISSING);
  });

  test("whitespace-only --body → EMPTY", () => {
    expect(resolveCommentBody({ body: "   \n ", fs: fakeFs({}) }).reason).toBe(BODY_REFUSAL.EMPTY);
  });

  test("both --body and --body-file → AMBIGUOUS (never a silent precedence)", () => {
    const r = resolveCommentBody({ body: "hi", bodyFile: "/tmp/x.md", fs: fakeFs({ "/tmp/x.md": "c" }) });
    expect(r.reason).toBe(BODY_REFUSAL.AMBIGUOUS);
  });

  test("a trailing --body-file flag with no value is MISSING, never a crash", () => {
    // arg()/argOf() return undefined when the flag is the last argv element.
    expect(resolveCommentBody({ bodyFile: undefined, fs: fakeFs({}) }).reason).toBe(BODY_REFUSAL.MISSING);
  });

  test("a trailing --body flag with no value is MISSING, never a TypeError", () => {
    expect(() => resolveCommentBody({ body: undefined, fs: fakeFs({}) })).not.toThrow();
    expect(resolveCommentBody({ body: undefined, fs: fakeFs({}) }).reason).toBe(BODY_REFUSAL.MISSING);
  });
});

describe("stdin is resolved by the CALLER, not here", () => {
  test('"-" is passed through as the STDIN sentinel, not treated as a body', () => {
    // The leaf must not read fd 0 — that keeps it pure and unit-testable.
    expect(resolveCommentBody({ body: "-", fs: fakeFs({}) })).toEqual({ ok: true, stdin: true });
  });
});

describe("the refusal's own remedy must be followable (tilde round trip)", () => {
  // The --body refusal names a --body-file command back to the operator. When only ONE
  // branch expanded `~/`, that suggested command failed with "--body-file not found" — a
  // guard whose advice does not work. This pins the ROUND TRIP, not just the refusal.
  const HOME = "/Users/ryan";
  const files = { "/Users/ryan/.p/b.md": "# the real body\n" };

  test("~/ --body is refused AND the --body-file it suggests then succeeds", () => {
    const refused = resolveCommentBody({ body: "~/.p/b.md", env: { HOME }, fs: fakeFs(files) });
    expect(refused.ok).toBe(false);
    expect(refused.reason).toBe(BODY_REFUSAL.PATH_AS_BODY);

    // Extract the remedy the message ITSELF printed and feed it straight back in.
    const suggested = /--body-file (\S+)/.exec(refused.message)?.[1];
    expect(suggested).toBe("~/.p/b.md");
    const retry = resolveCommentBody({ bodyFile: suggested, env: { HOME }, fs: fakeFs(files) });
    expect(retry).toEqual({ ok: true, body: "# the real body\n" });
  });

  test("positive control: the ABSOLUTE form of the same file already worked", () => {
    // If this failed, the test above would prove nothing about tilde handling.
    const r = resolveCommentBody({ bodyFile: "/Users/ryan/.p/b.md", env: { HOME }, fs: fakeFs(files) });
    expect(r).toEqual({ ok: true, body: "# the real body\n" });
  });

  test("a ~/ --body-file that is genuinely absent still refuses, naming both forms", () => {
    const r = resolveCommentBody({ bodyFile: "~/.p/gone.md", env: { HOME }, fs: fakeFs(files) });
    expect(r.reason).toBe(BODY_REFUSAL.BODY_FILE_MISSING);
    expect(r.message).toContain("~/.p/gone.md");
    expect(r.message).toContain("/Users/ryan/.p/gone.md"); // what was actually checked
  });
});

describe("'I could not look' is not 'no such file'", () => {
  // existsSync swallows EACCES/ELOOP/ENAMETOOLONG and returns false, so a body.md inside a
  // chmod-000 dir read as "not a file" and the PATH was posted — the exact incident.
  test("--body: an UNCHECKABLE path-shaped string is refused, not posted", () => {
    const r = resolveCommentBody({ body: "/locked/body.md", fs: uncheckableFs("EACCES") });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe(BODY_REFUSAL.PATH_UNCHECKABLE);
    expect(r.message).toContain("/locked/body.md");
    expect(r.message).toContain("--body-file");
  });

  test("--body: an uncheckable string that is NOT path-shaped is still an ordinary body", () => {
    // The inconclusive branch must not swallow real prose — it sits INSIDE the
    // PATH_SHAPED test, so a probe that cannot answer is only consulted for a
    // string that already looks like an absolute path.
    const r = resolveCommentBody({ body: "accepted — go ahead", fs: uncheckableFs("EACCES") });
    expect(r).toEqual({ ok: true, body: "accepted — go ahead" });
  });

  test("--body-file: an uncheckable stat falls through to the READ, which is authoritative", () => {
    // "Can I get these bytes" is the real question for --body-file. A stat that cannot
    // answer must not become a MISSING refusal naming a file that is actually there.
    const fs = {
      statSync: () => { throw Object.assign(new Error("EACCES"), { code: "EACCES" }); },
      readFileSync: () => "# readable after all\n",
    };
    expect(resolveCommentBody({ bodyFile: "/odd/b.md", fs })).toEqual({ ok: true, body: "# readable after all\n" });
  });

  test("--body-file: uncheckable AND unreadable refuses as UNREADABLE, carrying the errno", () => {
    const r = resolveCommentBody({ bodyFile: "/locked/b.md", fs: uncheckableFs("EACCES") });
    expect(r.reason).toBe(BODY_REFUSAL.BODY_FILE_UNREADABLE);
    expect(r.message).toContain("EACCES");
  });
});

describe("the leaf ALWAYS returns a verdict — it never throws out", () => {
  // The header promises "NEVER exits ... returns a verdict". Before CTL-2204's remediation
  // the existence checks were unwrapped, so a throwing seam produced a stack trace out of
  // the leaf instead of an exit-2 refusal. Both seams are now covered.
  const throwing = {
    statSync: () => { throw new Error("boom"); },
    readFileSync: () => { throw new Error("boom"); },
  };

  test("a throwing statSync on the --body path yields a refusal, not an exception", () => {
    expect(() => resolveCommentBody({ body: "/tmp/x.md", fs: throwing })).not.toThrow();
    expect(resolveCommentBody({ body: "/tmp/x.md", fs: throwing }).ok).toBe(false);
  });

  test("a throwing statSync on the --body-file path yields a refusal, not an exception", () => {
    expect(() => resolveCommentBody({ bodyFile: "/tmp/x.md", fs: throwing })).not.toThrow();
    expect(resolveCommentBody({ bodyFile: "/tmp/x.md", fs: throwing }).ok).toBe(false);
  });
});

describe("DELIBERATE scope limits, pinned so a later 'fix' cannot silently widen them", () => {
  test("an EXISTING path containing a space is deliberately NOT refused", () => {
    // PATH_SHAPED's `\S+` anchor is what keeps real markdown from tripping the guard, and
    // all 23 measured incidents were space-free job-tmp paths. Widening this would trade
    // markdown safety for a shape that has never occurred. If you are changing this
    // assertion, you are making that trade — say so in the commit.
    const p = "/tmp/ctl2204 space/b.md";
    const r = resolveCommentBody({ body: p, fs: fakeFs({ [p]: "c" }) });
    expect(r).toEqual({ ok: true, body: p });
  });

  test("positive control: the same path WITHOUT the space IS refused", () => {
    // Proves the fake fs and the guard are both live — so the pass above is a property of
    // the space, not of a broken fixture.
    const p = "/tmp/ctl2204-space/b.md";
    expect(resolveCommentBody({ body: p, fs: fakeFs({ [p]: "c" }) }).reason).toBe(BODY_REFUSAL.PATH_AS_BODY);
  });
});

// ── The header's central claim, held mechanically ───────────────────────────────
// "One function, two importers" is the whole design, and nothing asserted it. A divergent
// hand-rolled copy in one caller is this repo's recorded failure mode (the 2026-08-02 fleet
// 401 was four copies of a secret chain; CTL-1834 was five event-name ladders in three
// incompatible orders) and there is direct precedent for pinning it with a source scan
// (execution-core/assertion-evidence-parity.test.mjs, execution-core/event-name-read-guard.test.mjs).
describe("drift guard: both callers IMPORT the leaf, neither re-implements it", () => {
  const SCRIPTS = join(dirname(fileURLToPath(import.meta.url)), "..");
  const IMPORTERS = ["ask.mjs", "linear-reply.mjs"];
  const read = (f) => readFileSync(join(SCRIPTS, f), "utf8");

  test("positive control: the scan instrument really reads both files", () => {
    // Without this, every assertion below is equally consistent with reading "" — the
    // false-clean mechanism this repo has shipped before ([].every(p) is true).
    for (const f of IMPORTERS) {
      const src = read(f);
      expect(src.length).toBeGreaterThan(1000);
      expect(src).toContain("resolveCommentBody");
    }
  });

  test("each caller imports resolveCommentBody from the shared leaf", () => {
    for (const f of IMPORTERS) {
      expect(read(f)).toContain('from "./lib/comment-body-arg.mjs"');
    }
  });

  test("no caller carries a SECOND copy of the path-shape rule", () => {
    // The regex is the rule. A copy of it in a caller means the two tools can drift, which
    // is exactly what one shared leaf exists to prevent.
    for (const f of IMPORTERS) {
      expect(read(f)).not.toContain("(?:\\/|~\\/)");
      expect(read(f)).not.toMatch(/PATH_SHAPED/);
    }
  });

  test("negative control: the leaf itself DOES carry the rule", () => {
    // Proves the two assertions above are discriminating rather than vacuously true of any
    // JS file — the string they look for exists, in exactly one place.
    const leaf = readFileSync(join(SCRIPTS, "lib", "comment-body-arg.mjs"), "utf8");
    expect(leaf).toContain("(?:\\/|~\\/)");
    expect(leaf).toMatch(/PATH_SHAPED/);
  });
});
