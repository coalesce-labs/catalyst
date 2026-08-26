// agentskills-spec.mjs — grades the planned `.agents/skills/` emit set
// against the agentskills.io / `skills` CLI contract (CTL-2215 Phase 1).
//
// SPEC_FRONTMATTER_KEYS is derived from skills@1.5.23's `parseSkillMd`
// (dist/cli.mjs:1153), verified 2026-08-26 by reading that function and
// executing it against scratch fixtures: it requires `name` and
// `description` as non-empty strings (skipping — never erroring — a skill
// missing either, with only a `⚠ Skipped` console line), and accepts the
// optional `license` and `metadata` keys. Positive control run the same
// session, same 293 KB bundle: a case-sensitive search for
// `allow_implicit_invocation`, `openai.yaml`, `openai.yml` → zero matches;
// `data.metadata` → 11, `data.name` → 15, `data.description` → 17 — proving
// the search instrument itself finds real hits before trusting its zero.
//
// Grades the PLANNED emit set (planAgentsSkillsBundle's `files` output), not
// the on-disk `.agents/skills/` tree — the drift gate already owns
// disk-vs-source agreement, and this module's only job is the emitted pack's
// external-spec shape, a deliberately separate concern (see
// docs/architecture.md's packaging-gate note and the drift gate's own
// header).

// core/ must never import providers/ (the CTL-1461 adapter seam, enforced by
// packaging-seam.test.mjs's countProviderImporters() — exactly one importer
// of providers/local.mjs, cli.mjs itself). So this is a deliberate,
// tiny, byte-for-byte duplicate of providers/local.mjs's splitFrontmatter,
// not a shared import — the function is a stable two-line contract
// (`---\n<yaml>\n---\n<body>`) that is cheaper to duplicate than to relocate.
function splitFrontmatter(contents) {
  const lines = contents.split("\n");
  if (lines[0] !== "---") return null;
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === "---") {
      end = i;
      break;
    }
  }
  if (end === -1) return null;
  return {
    yamlText: lines.slice(1, end).join("\n"),
    body: lines.slice(end + 1).join("\n"),
  };
}

/** SPEC_FRONTMATTER_KEYS — the frozen key table `skills@1.5.23`'s `parseSkillMd` actually enforces. See header for the verification date and positive-control counts. */
export const SPEC_FRONTMATTER_KEYS = Object.freeze({
  required: Object.freeze(["name", "description"]),
  optional: Object.freeze(["license", "metadata"]),
});

const ALLOWED_KEYS = new Set([...SPEC_FRONTMATTER_KEYS.required, ...SPEC_FRONTMATTER_KEYS.optional]);

function isNonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

function violation(source, field, message) {
  return { source, field, message };
}

function flatNameOf(file) {
  return file.flatName ?? file.relPath.replace(/\/SKILL\.md$/, "");
}

/**
 * checkAgentsSkillsConformance(files) → { verdict, violations, checkedCount, reason }
 *
 * `files` is a `planAgentsSkillsBundle`-shaped array (`[{ flatName, relPath,
 * text? }, ...]`) — only entries whose `relPath` ends in `/SKILL.md` are
 * graded; every other emitted file (agents/openai.yaml, the generated
 * marker, copied aux content) is outside the spec this module checks.
 *
 * Never throws: an unparseable SKILL.md becomes a violation, not an
 * exception. An empty emit set is `inconclusive`, never `ok` — a conformance
 * pass over zero skills is not a pass (`[].every(p)` is `true`, the exact
 * false-clean shape AGENTS.md names).
 */
export function checkAgentsSkillsConformance(files) {
  const skillMdEntries = (Array.isArray(files) ? files : []).filter((f) => f && typeof f.relPath === "string" && f.relPath.endsWith("/SKILL.md"));

  if (skillMdEntries.length === 0) {
    return {
      verdict: "inconclusive",
      violations: [],
      checkedCount: 0,
      reason: "empty emit set — a conformance pass over zero skills is not a pass",
    };
  }

  const violations = [];
  const namesSeen = new Map(); // frontmatter name -> [source, ...]

  for (const file of skillMdEntries) {
    const source = flatNameOf(file);

    if (typeof file.text !== "string") {
      violations.push(violation(source, "SKILL.md", "no text content available to grade"));
      continue;
    }

    const split = splitFrontmatter(file.text);
    if (split === null) {
      violations.push(violation(source, "frontmatter", "no parseable --- frontmatter block"));
      continue;
    }

    let parsed;
    try {
      parsed = Bun.YAML.parse(split.yamlText);
    } catch (err) {
      violations.push(violation(source, "frontmatter", `unparseable YAML: ${err.message}`));
      continue;
    }

    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      violations.push(violation(source, "frontmatter", "frontmatter is not a YAML mapping"));
      continue;
    }

    for (const key of SPEC_FRONTMATTER_KEYS.required) {
      if (!isNonEmptyString(parsed[key])) {
        violations.push(violation(source, key, `${key} missing, empty, or non-string`));
      }
    }

    for (const key of Object.keys(parsed)) {
      if (!ALLOWED_KEYS.has(key)) {
        violations.push(violation(source, key, `frontmatter key "${key}" is outside {${[...ALLOWED_KEYS].join(", ")}}`));
      }
    }

    if (parsed.metadata && typeof parsed.metadata === "object" && !Array.isArray(parsed.metadata) && parsed.metadata.internal === true) {
      violations.push(
        violation(source, "metadata.internal", "metadata.internal: true present — Catalyst omits internal-exposure skills rather than flagging them (D5)")
      );
    }

    if (isNonEmptyString(parsed.name)) {
      const sources = namesSeen.get(parsed.name) ?? [];
      sources.push(source);
      namesSeen.set(parsed.name, sources);
    }
  }

  for (const [name, sources] of namesSeen) {
    if (sources.length > 1) {
      violations.push(
        violation(
          sources.join(", "),
          "name",
          `duplicate frontmatter name "${name}" shared by ${sources.join(" and ")} — installSkillForAgent keys the install destination on name, so this is an install collision`
        )
      );
    }
  }

  return {
    verdict: violations.length > 0 ? "violations" : "ok",
    violations,
    checkedCount: skillMdEntries.length,
    reason: violations.length > 0 ? `${violations.length} violation(s)` : null,
  };
}
