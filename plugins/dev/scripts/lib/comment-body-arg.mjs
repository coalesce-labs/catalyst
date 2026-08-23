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
// ⛔ A THIRD agent-facing writer is DELIBERATELY OUT OF SCOPE and still unguarded:
// `lib/linear-comment-post.sh` takes the body as a POSITIONAL ($2), not a --body flag, and
// phase-triage/SKILL.md documents it to agents as `linear-comment-post.sh <TICKET> "<body>"`.
// Its in-repo callers are programmatic phase-mirror blocks that build the body in a shell
// variable, so the residual exposure is hand-invocation. Porting this rule into that bash
// helper is a follow-up, NOT part of this leaf — so read "one function, two importers" as a
// statement about the two --body PARSERS, never as "every path into a Linear comment".
//
// ⛔ SCOPE OF THE PATH GUARD — deliberately narrow, and the narrowness is the point.
// It fires only on an ABSOLUTE (or ~/) path to a file that PROVABLY EXISTS. It does not
// fire on a relative path (a bare `README.md` could be a legitimate one-word body), nor on
// a non-existent path (that is not evidence of the mistake — refusing it would be a guess),
// nor on any string containing whitespace or a newline (`\S+` anchored ^…$), so no real
// markdown body can trip it. Every one of the 23 measured incidents was an absolute path.
//
// ⛔ "I COULD NOT LOOK" IS NOT "NO SUCH FILE". node:fs existsSync swallows EVERY error
// (EACCES, ELOOP, ENAMETOOLONG, dangling symlink) and returns false — so a body.md inside a
// chmod-000 directory read as "not a file" and the PATH was posted verbatim, which is the
// incident this leaf exists to prevent. Every existence question therefore goes through the
// three-valued `probeFile` below (statSync + throwIfNoEntry:false): true / false / null,
// where null means the check itself could not answer. On the --body side an inconclusive
// probe REFUSES (PATH_UNCHECKABLE) — refusing a path-shaped string is recoverable, posting
// one is not. On the --body-file side it falls through to the read, which is the
// authoritative answer for "can I get these bytes".
//
// ⛔ TILDE IS EXPANDED ON BOTH SIDES, THROUGH ONE HELPER. The --body refusal's remedy names
// the path back to the operator ("use --body-file ~/x.md"), so if only --body expanded `~/`
// that suggested command would itself fail with "--body-file not found" — a refusal whose
// own advice is un-followable. Both branches call expandTilde().
//
// This leaf NEVER exits, NEVER throws, and NEVER reads fd 0 — it returns a verdict and lets
// the caller own its exit code and message. `-` comes back as {ok:true, stdin:true} for the
// caller to read.
import { statSync as _statSync, readFileSync as _readFileSync } from "node:fs";

export const BODY_REFUSAL = Object.freeze({
  MISSING: "missing",
  EMPTY: "empty",
  AMBIGUOUS: "ambiguous",
  PATH_AS_BODY: "path-as-body",
  PATH_UNCHECKABLE: "path-uncheckable",
  BODY_FILE_MISSING: "body-file-missing",
  BODY_FILE_UNREADABLE: "body-file-unreadable",
});

const DEFAULT_FS = { statSync: _statSync, readFileSync: _readFileSync };

// Absolute or ~/-rooted, no whitespace anywhere. Anchored, so a multi-line or
// space-containing body can never match.
//
// ⚠️ KNOWN, DELIBERATE SCOPE: an existing path CONTAINING A SPACE is NOT refused. The
// no-whitespace anchor is exactly what keeps real markdown from tripping the guard, and all
// 23 measured incidents were space-free job-tmp paths. Widening it trades markdown safety
// for a shape that has never occurred; `comment-body-arg.test.mjs` pins the trade-off so a
// later "fix" cannot quietly reverse it.
const PATH_SHAPED = /^(?:\/|~\/)\S+$/;

function refuse(reason, message) {
  return { ok: false, reason, message };
}

/** ~/-rooted → absolute, against the injected env. Every other string passes through. */
function expandTilde(p, env) {
  return p.startsWith("~/") ? `${env?.HOME ?? ""}${p.slice(1)}` : p;
}

/**
 * probeFile — THREE-VALUED existence check that never throws.
 * @returns {true|false|null} true = it is there; false = proven absent (ENOENT);
 *          null = the check could not answer (EACCES/ELOOP/ENAMETOOLONG/seam threw).
 */
function probeFile(fs, p) {
  try {
    // throwIfNoEntry:false makes ENOENT a plain `undefined` while EVERY other errno still
    // throws — the whole point of using statSync over existsSync here.
    return fs.statSync(p, { throwIfNoEntry: false }) ? true : false;
  } catch {
    return null;
  }
}

/**
 * @param {object} o
 * @param {string=} o.body      the --body argument (may be undefined: trailing flag)
 * @param {string=} o.bodyFile  the --body-file argument (may be undefined)
 * @param {object=} o.fs        { statSync, readFileSync } seam (tests)
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
    const filePath = expandTilde(rawFile, env);
    // `as` names what we actually checked when a ~/ was expanded, so an operator debugging a
    // miss sees the absolute path rather than the tilde they typed.
    const as = filePath === rawFile ? "" : ` (expanded to ${filePath})`;
    // null (could not look) deliberately falls THROUGH to the read: "can I get these bytes"
    // is the authoritative question, and readFileSync answers it with a real errno below.
    if (probeFile(fs, filePath) === false) {
      return refuse(BODY_REFUSAL.BODY_FILE_MISSING, `--body-file not found: ${rawFile}${as}`);
    }
    let contents;
    try {
      contents = fs.readFileSync(filePath, "utf8");
    } catch (e) {
      return refuse(
        BODY_REFUSAL.BODY_FILE_UNREADABLE,
        `--body-file unreadable: ${rawFile}${as} (${e?.message ?? e})`
      );
    }
    if (!String(contents).trim()) {
      return refuse(BODY_REFUSAL.EMPTY, `--body-file is empty: ${rawFile}${as}`);
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
    const resolved = expandTilde(trimmed, env);
    const probe = probeFile(fs, resolved);
    if (probe === true) {
      return refuse(
        BODY_REFUSAL.PATH_AS_BODY,
        `--body is a path to an existing file (${trimmed}). A path is never a valid comment body — ` +
          `use --body-file ${trimmed} to post its contents.`
      );
    }
    if (probe === null) {
      // Inconclusive, not absent. Refusing a path-shaped string costs an exit 2; posting one
      // is the unrecoverable incident (7 of the 23 measured were unrecoverable).
      return refuse(
        BODY_REFUSAL.PATH_UNCHECKABLE,
        `--body looks like a path (${trimmed}) but it could not be checked (permission, symlink loop, or a ` +
          `bad path) — refusing rather than posting a path as a comment body. Use --body-file ${trimmed} ` +
          "to post its contents, or pass the text itself."
      );
    }
  }

  if (!trimmed) return refuse(BODY_REFUSAL.EMPTY, "comment body is empty");
  return { ok: true, body: rawBody };
}
