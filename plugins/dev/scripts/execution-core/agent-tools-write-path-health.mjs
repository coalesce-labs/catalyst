// agent-tools-write-path-health.mjs — CTL-2026, the `catalyst doctor` half.
//
// ── THE GATE THIS SERVES, AND THE HOLE IT CLOSES ──
// CTL-1889's gate is "`doctor` asserts no skill/tool holds a direct Linear write path".
// The two tools every lane's brief actually invokes are NOT in the repo:
//
//     ~/catalyst/comms/tools/linear-reply.mjs   ← every lane's ticket replies
//     ~/catalyst/comms/tools/linear-ack.mjs     ← every lane's 👀 claim
//
// ⛔ A check that walks only the repo would CERTIFY a host that is still writing around
// the proxy — a green gate over the exact thing it exists to catch. So this check looks at
// the out-of-tree directory and REPORTS ON IT, and the one outcome it may never produce is
// a silent PASS earned by not looking.
//
// ── WHY A DIGEST COMPARISON AND NOT A SOURCE GREP ──
// The tempting check is "does the out-of-tree file mention the write proxy". That passes on
// a declared-but-unused import — the same class of untruth as a gate that reads a
// discriminator and ignores it. What can be stated falsifiably is IDENTITY: is the file
// out there the file this repo tests? A SHA-256 answers that and nothing else, and it
// cannot be satisfied by a plausible-looking edit.
//
// ⭐ THE DRIFT IS MEASURED, NOT HYPOTHETICAL. CTL-2026 was filed on the observation that the
// copies were "byte-identical" — and stopped being so SIX HOURS LATER, when the out-of-tree
// linear-reply.mjs was hand-edited (2026-08-18 19:46:30) to add a per-agent avatar the repo
// copy did not have. Nothing reported that. This is what reports it.
//
// ── ADVISORY — never FAIL ──
// doctor's FAIL count gates worker activation. An out-of-tree copy is a provenance problem,
// not a reason to take a host out of service, and during the CTL-2026(b) interim EVERY host
// legitimately has one. Same posture and same reason as checkLinearWriteBudget and
// checkRegistryTeamIdentity. Flipping it to FAIL is a decision for after (a) lands.

import { createHash } from "node:crypto";
import { readFileSync, lstatSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { STATUS, mkCheck } from "./doctor-status.mjs";

/** The tools whose out-of-tree copies are load-bearing for every lane. */
export const AGENT_TOOLS = Object.freeze(["linear-reply.mjs", "linear-ack.mjs"]);

/** Where the repo's canonical copies live — resolved from THIS file's URL, so the answer
 *  does not depend on the caller's cwd (the CTL-1641 rule). */
export function repoScriptsDir() {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

/** The out-of-tree directory, honouring CATALYST_DIR the way the rest of the fleet does. */
export function defaultOutOfTreeDir(env = process.env) {
  const base = env.CATALYST_DIR || join(env.HOME || homedir(), "catalyst");
  return join(base, "comms", "tools");
}

export const VERDICT = Object.freeze({
  ABSENT: "absent",
  WRAPPER: "wrapper",
  COPY_MATCHES: "copy-matches",
  COPY_DRIFTED: "copy-drifted",
  INCONCLUSIVE: "inconclusive",
});

/**
 * classifyAgentToolCopy — pure. One out-of-tree file's relationship to its repo counterpart.
 *
 * ⛔ EVERY UNKNOWN RESOLVES TO `INCONCLUSIVE`, NEVER TO A MATCH. An unreadable file, a
 * missing repo counterpart, or a throwing probe are all "I could not look" — reporting any
 * of them as agreement is the false-clean this whole ticket is about, and `[].every(p)` is
 * `true` is how it usually arrives.
 *
 * @param {object} o
 * @param {string} o.name              the tool's filename
 * @param {string|null} o.linkTarget   realpath of the out-of-tree entry when it is a symlink
 * @param {string|null} o.outDigest    sha256 of the out-of-tree file, null if unreadable
 * @param {string|null} o.repoDigest   sha256 of the repo copy, null if unreadable
 * @param {boolean} o.outPresent       does the out-of-tree entry exist at all
 * @param {string|null} o.reason       why a digest is null, when it is
 */
export function classifyAgentToolCopy({
  name,
  linkTarget = null,
  outDigest = null,
  repoDigest = null,
  outPresent = false,
  reason = null,
  repoDir = repoScriptsDir(),
} = {}) {
  if (!outPresent) {
    return { name, verdict: VERDICT.ABSENT, detail: `${name}: no out-of-tree copy` };
  }
  if (linkTarget) {
    // The CTL-2026(a) end state: one implementation, kept current by the fleet refresh.
    // Recognised by RESOLUTION, not by the link's text — a relative link and an absolute
    // one are the same fact, and only the resolved path can be checked against the repo.
    const inRepo = resolve(linkTarget) === resolve(join(repoDir, name));
    return inRepo
      ? { name, verdict: VERDICT.WRAPPER, detail: `${name}: symlink → the repo copy` }
      : {
          name,
          verdict: VERDICT.INCONCLUSIVE,
          detail: `${name}: symlink resolves OUTSIDE the repo scripts dir (${linkTarget}) — its write path is unknown here`,
        };
  }
  if (outDigest == null || repoDigest == null) {
    return {
      name,
      verdict: VERDICT.INCONCLUSIVE,
      detail: `${name}: could not compare (${reason ?? (outDigest == null ? "out-of-tree copy unreadable" : "repo copy unreadable")})`,
    };
  }
  return outDigest === repoDigest
    ? {
        name,
        verdict: VERDICT.COPY_MATCHES,
        detail: `${name}: a byte-identical copy of the repo file`,
      }
    : { name, verdict: VERDICT.COPY_DRIFTED, detail: `${name}: DRIFTED from the repo copy` };
}

/** sha256 of a file, or null plus the reason it could not be read. */
function digestOf(path, readFn) {
  try {
    return { digest: createHash("sha256").update(readFn(path)).digest("hex"), reason: null };
  } catch (err) {
    return { digest: null, reason: `${err?.code ?? "read failed"}` };
  }
}

/**
 * checkAgentToolsWritePath — the doctor row.
 *
 * ⛔ The grade is the WORST verdict across the tools, and the detail always NAMES the
 * directory that was examined. "I looked at X and found Y" is checkable by the reader;
 * a bare "ok" is not.
 */
export function checkAgentToolsWritePath(deps = {}) {
  const {
    env = process.env,
    outDir = defaultOutOfTreeDir(env),
    repoDir = repoScriptsDir(),
    tools = AGENT_TOOLS,
    readFile = readFileSync,
    lstat = lstatSync,
    realpath = realpathSync,
  } = deps;

  // ⛔ BOTH SIDES OF THE SYMLINK COMPARISON MUST BE CANONICAL, OR NEITHER.
  // `realpathSync` on a link resolves every component — on macOS that turns /var into
  // /private/var — while a plain `join(repoDir, name)` does not. Comparing one against the
  // other made a correct wrapper read as "resolves OUTSIDE the repo", i.e. the CTL-2026(a)
  // end state would have graded WARN on the very host that had adopted it. Caught by the
  // suite's symlink case on macOS; it would have passed on a Linux runner, which is exactly
  // the kind of half-true green this check exists to refuse.
  let canonicalRepoDir = repoDir;
  try {
    canonicalRepoDir = realpath(repoDir);
  } catch {
    // A repo dir that cannot be canonicalised is left as-is: the comparison may then fail
    // to recognise a wrapper, which lands on INCONCLUSIVE — the safe direction.
  }

  const results = tools.map((name) => {
    const outPath = join(outDir, name);
    let outPresent = false;
    let linkTarget = null;
    try {
      const st = lstat(outPath);
      outPresent = true;
      if (st.isSymbolicLink()) {
        try {
          linkTarget = realpath(outPath);
        } catch (err) {
          // A DANGLING symlink is present-but-unresolvable. Reporting it as "absent"
          // would hide a tool every lane invokes and that currently cannot run at all.
          return classifyAgentToolCopy({
            name,
            outPresent: true,
            reason: `symlink does not resolve (${err?.code ?? "unknown"})`,
            canonicalRepoDir,
          });
        }
      }
    } catch {
      // ENOENT is the only benign reason to be here, and it is the common one. Any other
      // errno also lands here; it is reported as absent rather than inconclusive because
      // an entry doctor cannot even lstat is not one the lanes are invoking either.
      return classifyAgentToolCopy({ name, outPresent: false, repoDir: canonicalRepoDir });
    }
    if (linkTarget)
      return classifyAgentToolCopy({ name, outPresent, linkTarget, repoDir: canonicalRepoDir });

    const out = digestOf(outPath, readFile);
    const repo = digestOf(join(repoDir, name), readFile);
    return classifyAgentToolCopy({
      name,
      outPresent,
      outDigest: out.digest,
      repoDigest: repo.digest,
      reason: out.reason
        ? `out-of-tree copy: ${out.reason}`
        : repo.reason
          ? `repo copy: ${repo.reason}`
          : null,
      repoDir: canonicalRepoDir,
    });
  });

  const has = (v) => results.some((r) => r.verdict === v);
  const summary = results.map((r) => r.detail).join("; ");

  if (results.every((r) => r.verdict === VERDICT.ABSENT)) {
    return mkCheck(
      "agent-tools-write-path",
      STATUS.PASS,
      `no out-of-tree agent tools under ${outDir} — nothing outside this repo's tests to certify`
    );
  }
  if (results.every((r) => r.verdict === VERDICT.WRAPPER || r.verdict === VERDICT.ABSENT)) {
    return mkCheck(
      "agent-tools-write-path",
      STATUS.PASS,
      `${outDir}: every present tool is a symlink to the repo copy (CTL-2026(a)) — ${summary}`
    );
  }
  if (has(VERDICT.INCONCLUSIVE)) {
    return mkCheck(
      "agent-tools-write-path",
      STATUS.WARN,
      `${outDir}: INCONCLUSIVE — this directory's write path could not be established, which is not the same as it being routed. ${summary}`
    );
  }
  if (has(VERDICT.COPY_DRIFTED)) {
    return mkCheck(
      "agent-tools-write-path",
      STATUS.WARN,
      `${outDir}: a copy has DRIFTED from the repo — its write path is NOT the one this repo's tests cover, so no CI result here is evidence about it. ${summary}`
    );
  }
  return mkCheck(
    "agent-tools-write-path",
    STATUS.WARN,
    `${outDir}: byte-identical copies, not wrappers — inconclusive by design until CTL-2026(a) makes them symlinks. They also cannot resolve the proxy modules from that directory, so their writes go direct (or, under enforce, refuse). ${summary}`
  );
}
