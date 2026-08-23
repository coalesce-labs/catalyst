// comment-body-arg.mjs — CTL-2204. ONE rule for "what is the comment body?", shared by
// linear-reply.mjs and ask.mjs.
//
// ⛔ WHY A SHARED LEAF. The coordinator house rule "write the body to a FILE first" (it
// exists because `--body -` stdin can 401) led twice in two sessions to passing the file's
// PATH to --body. Measured 2026-08-23: 23 comments whose whole body was a
// /Users/ryan/.claude/jobs/…/tmp/*.md path, across 16 tickets, from two concierge jobs;
// 7 unrecoverable. Two tools parse --body today and the ticket asks for the identical rule
// in both — and divergent hand-written copies of one rule is this repo's recorded failure
// mode (the 2026-08-02 fleet 401 was four copies of a secret chain; CTL-1834 was five
// event-name ladders in three incompatible orders). So: one function, two importers.
//
// ⛔ SCOPE OF THE PATH GUARD — deliberately narrow, and the narrowness is the point.
// It fires only on an ABSOLUTE (or ~/) path to a file that PROVABLY EXISTS. It does not
// fire on a relative path (a bare `README.md` could be a legitimate one-word body), nor on
// a non-existent path (that is not evidence of the mistake — refusing it would be a guess),
// nor on any string containing whitespace or a newline (`\S+` anchored ^…$), so no real
// markdown body can trip it. Every one of the 23 measured incidents was an absolute path.
//
// This leaf NEVER exits and NEVER reads fd 0 — it returns a verdict and lets the caller own
// its exit code and message. `-` comes back as {ok:true, stdin:true} for the caller to read.
import { existsSync as _existsSync, readFileSync as _readFileSync } from "node:fs";

export const BODY_REFUSAL = Object.freeze({
  MISSING: "missing",
  EMPTY: "empty",
  AMBIGUOUS: "ambiguous",
  PATH_AS_BODY: "path-as-body",
  BODY_FILE_MISSING: "body-file-missing",
  BODY_FILE_UNREADABLE: "body-file-unreadable",
});

const DEFAULT_FS = { existsSync: _existsSync, readFileSync: _readFileSync };

// Absolute or ~/-rooted, no whitespace anywhere. Anchored, so a multi-line or
// space-containing body can never match.
const PATH_SHAPED = /^(?:\/|~\/)\S+$/;

function refuse(reason, message) {
  return { ok: false, reason, message };
}

/**
 * @param {object} o
 * @param {string=} o.body      the --body argument (may be undefined: trailing flag)
 * @param {string=} o.bodyFile  the --body-file argument (may be undefined)
 * @param {object=} o.fs        { existsSync, readFileSync } seam (tests)
 * @param {object=} o.env       { HOME } seam (tests)
 * @returns {{ok:true, body:string}|{ok:true, stdin:true}|{ok:false, reason:string, message:string}}
 */
export function resolveCommentBody({ body, bodyFile, fs = DEFAULT_FS, env = process.env } = {}) {
  // Normalize FIRST. arg()/argOf() return undefined when the flag is the last argv
  // element, and `undefined.trim()` is a TypeError — a crash where an exit 2 belongs.
  const rawBody = typeof body === "string" ? body : "";
  const rawFile = typeof bodyFile === "string" ? bodyFile : "";

  if (rawBody !== "" && rawFile !== "") {
    return refuse(
      BODY_REFUSAL.AMBIGUOUS,
      "both --body and --body-file were given; pass exactly one (refusing rather than guessing which you meant)"
    );
  }

  if (rawFile !== "") {
    if (!fs.existsSync(rawFile)) {
      return refuse(BODY_REFUSAL.BODY_FILE_MISSING, `--body-file not found: ${rawFile}`);
    }
    let contents;
    try {
      contents = fs.readFileSync(rawFile, "utf8");
    } catch (e) {
      return refuse(BODY_REFUSAL.BODY_FILE_UNREADABLE, `--body-file unreadable: ${rawFile} (${e?.message ?? e})`);
    }
    if (!String(contents).trim()) {
      return refuse(BODY_REFUSAL.EMPTY, `--body-file is empty: ${rawFile}`);
    }
    return { ok: true, body: String(contents) };
  }

  if (rawBody === "") {
    return refuse(BODY_REFUSAL.MISSING, "a comment body is required: pass --body <markdown>, --body-file <path>, or --body -");
  }

  // stdin is the caller's to read (keeps this leaf pure).
  if (rawBody === "-") return { ok: true, stdin: true };

  const trimmed = rawBody.trim();
  if (PATH_SHAPED.test(trimmed)) {
    const resolved = trimmed.startsWith("~/")
      ? `${env?.HOME ?? ""}${trimmed.slice(1)}`
      : trimmed;
    if (fs.existsSync(resolved)) {
      return refuse(
        BODY_REFUSAL.PATH_AS_BODY,
        `--body is a path to an existing file (${trimmed}). A path is never a valid comment body — ` +
          `use --body-file ${trimmed} to post its contents.`
      );
    }
  }

  if (!trimmed) return refuse(BODY_REFUSAL.EMPTY, "comment body is empty");
  return { ok: true, body: rawBody };
}
