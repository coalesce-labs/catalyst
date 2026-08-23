// comment-body-arg.test.mjs — CTL-2204. The shared body-resolution rule for the Linear
// comment tools (linear-reply.mjs, ask.mjs). See comment-body-arg.mjs for why this is one
// leaf shared by two callers rather than two hand-rolled parsers.
import { describe, test, expect } from "bun:test";
import { resolveCommentBody, BODY_REFUSAL } from "./comment-body-arg.mjs";

// A hermetic fake fs: only the paths in `files` exist.
const fakeFs = (files) => ({
  existsSync: (p) => Object.hasOwn(files, p),
  readFileSync: (p) => {
    if (!Object.hasOwn(files, p)) throw new Error(`ENOENT: ${p}`);
    return files[p];
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
    const fs = { existsSync: () => true, readFileSync: () => { throw new Error("EACCES"); } };
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
