// ticket-artifacts-reader.mjs — resolve a ticket's research/plan thoughts
// artifacts for the LIFECYCLE SPINE 📄 links (CTL-889, P9).
//
// The spine's `📄research` / `📄plan` nodes link to the markdown the phase
// agents persist under `thoughts/shared/{research,plans}/`. This reader globs
// those two directories for files whose name carries the ticket id and returns
// their relative paths plus a small "peek" preview of the file head, so the UI
// can render the link AND a hover/peek pane without a second round-trip.
//
// MULTI-HOST CAVEAT (CTL-866, inherited): thoughts are synced between nodes by a
// push, not shared live. An artifact authored on another node is only visible
// here AFTER that node's thoughts-sync push lands locally. This reader reads the
// LOCAL thoughts tree only, so `crossNodeCaveat` is surfaced on every response
// to keep that eventual-consistency honest in the UI. In the SINGLE-HOST MVP
// (hosts.json absent / length 1) there is no other node, so the local tree IS
// the whole truth and the caveat is informational only.
//
// All filesystem collaborators are injectable so the route + unit tests drive it
// without a real thoughts tree. Tolerant of an absent dir: a missing
// research/plans dir simply contributes no artifacts (never throws).

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

// The two phase-artifact kinds the spine links, mapped to their on-disk dirs.
// `plans` is the real dir name (plural); `plan` is tolerated for forward-compat
// in case a future writer uses the singular the design doc references.
const ARTIFACT_DIRS = [
  { kind: "research", dirs: ["research"] },
  { kind: "plan", dirs: ["plans", "plan"] },
];

const PEEK_BYTES = 4096;

// Does this filename belong to the requested ticket? The phase agents write
// `<date>-<ticket>.md`, but operators also embed the id mid-name
// (`2026-06-07-ctl-845-humanlayer-...md`), so match the id as a whole token
// anywhere in the (case-insensitive) basename — bounded by a non-alphanumeric on
// each side so "CTL-8" never matches "CTL-845".
function fileMatchesTicket(name, ticket) {
  if (!name.toLowerCase().endsWith(".md")) return false;
  const lname = name.toLowerCase();
  const lticket = ticket.toLowerCase();
  let from = 0;
  for (;;) {
    const idx = lname.indexOf(lticket, from);
    if (idx === -1) return false;
    const before = idx === 0 ? "" : lname[idx - 1];
    const after = lname[idx + lticket.length] ?? "";
    const boundary = (c) => c === "" || !/[a-z0-9]/.test(c);
    if (boundary(before) && boundary(after)) return true;
    from = idx + 1;
  }
}

// Read the first PEEK_BYTES of a file as UTF-8 for the peek pane. Returns null
// on any read failure (the link still renders; the peek just shows nothing).
async function peekFile(absPath, reader) {
  try {
    const text = await reader(absPath);
    return typeof text === "string" ? text.slice(0, PEEK_BYTES) : null;
  } catch {
    return null;
  }
}

// buildArtifactList — scan the configured kind→dir map under `thoughtsDir` for
// files matching `ticket`, returning the sorted relative paths + peek preview.
// Pure-ish: `lister` and `reader` are injectable so tests run without fs.
//
// Returns: { ticket, artifacts: [{ kind, path, peek }], crossNodeCaveat }
//   • `path` is relative to the repo root (e.g.
//     "thoughts/shared/research/2026-06-07-ctl-845-...md") so the UI can build a
//     stable deep link.
//   • `crossNodeCaveat` is always present — the eventual-consistency note.
export async function buildArtifactList(
  ticket,
  {
    thoughtsRel = join("thoughts", "shared"),
    thoughtsDir,
    lister,
    reader,
  } = {},
) {
  const baseAbs = thoughtsDir ?? thoughtsRel;
  const artifacts = [];
  for (const { kind, dirs } of ARTIFACT_DIRS) {
    for (const dir of dirs) {
      const absDir = join(baseAbs, dir);
      let names;
      try {
        names = await lister(absDir);
      } catch {
        continue; // dir absent → no artifacts of this kind from this dir
      }
      if (!Array.isArray(names)) continue;
      for (const name of names) {
        if (!fileMatchesTicket(name, ticket)) continue;
        const relPath = join(thoughtsRel, dir, name);
        const peek = await peekFile(join(absDir, name), reader);
        artifacts.push({ kind, path: relPath, peek });
      }
    }
  }
  // Deterministic order: by kind (research before plan) then path.
  const kindRank = { research: 0, plan: 1 };
  artifacts.sort((a, b) => {
    const dk = (kindRank[a.kind] ?? 9) - (kindRank[b.kind] ?? 9);
    if (dk !== 0) return dk;
    return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
  });
  return {
    ticket,
    artifacts,
    // Eventual-consistency note (CTL-866): cross-node artifacts are only visible
    // after a thoughts-sync push. In the single-host MVP this is informational.
    crossNodeCaveat:
      "Artifacts are read from the local thoughts tree; cross-node artifacts " +
      "appear only after a thoughts-sync push (eventual consistency).",
  };
}

// readTicketArtifacts — the route-facing reader. Defaults `lister`/`reader` to
// the real fs/promises, resolving the thoughts tree relative to `cwd` (the repo
// root the orch-monitor server runs from). Tolerant of an absent tree (empty
// artifact list), never throws.
export async function readTicketArtifacts(
  ticket,
  { cwd = process.cwd(), lister, reader } = {},
) {
  const thoughtsRel = join("thoughts", "shared");
  return buildArtifactList(ticket, {
    thoughtsRel,
    thoughtsDir: join(cwd, thoughtsRel),
    lister: lister ?? ((d) => readdir(d)),
    reader: reader ?? ((p) => readFile(p, "utf8")),
  });
}
