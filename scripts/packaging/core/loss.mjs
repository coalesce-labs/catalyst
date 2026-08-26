// loss.mjs — the two-tier loss classifier (CTL-1463 Phase 3; CTL-1461 Phase 2
// delegates the emit/omit decision to core/safety-gate.mjs).
//
// The enumeration below is CLOSED — it comes from the research's
// schema-field-shaped boundary — so this is a table, not a detector. Two
// tiers: SAFETY losses omit (a hook or an effects/invocation/exposure guard
// is a mutation guard; shipping the constrained content without the
// constraint is unsafe), everything else warns or degrades (a capability the
// target lacks, or cosmetic metadata). No silent caps: a render that drops
// most skills and prints nothing would defeat the entire point of this
// module.

import { classifySkillEmission } from "./safety-gate.mjs";

const PRESENTATION_PATTERNS = [
  { name: "CLAUDE_PLUGIN_ROOT", regex: /\$\{CLAUDE_PLUGIN_ROOT\}/ },
  { name: "slash-command reference", regex: /\/[a-z][a-z0-9-]*:[a-z][a-z0-9-]*\b/i },
  { name: "Task(subagent_type=...)", regex: /Task\(subagent_type\s*=/ },
];

const CLAUDE_ONLY_COSMETIC_FIELDS = ["model", "color", "argument-hint", "user-invocable", "version"];

function skillLabel(packId, skillId) {
  return `${packId}/${skillId}`;
}
function agentLabel(packId, agentId) {
  return `${packId}/${agentId}`;
}

/**
 * classifyPackLosses(packId, pack, targetName) → { omitted, degraded, warnings }
 *
 * `pack` is a RenderedPack (contract shape). `targetName` is "claude" | "codex"
 * | "agentsSkills". The "claude" target never loses anything — it is the
 * origin format the contract was modeled on.
 */
export function classifyPackLosses(packId, pack, targetName) {
  const omitted = [];
  const degraded = [];
  const warnings = [];

  if (targetName === "claude") {
    return { omitted, degraded, warnings };
  }

  for (const skill of pack.skills) {
    const label = skillLabel(packId, skill.id);
    const verdict = classifySkillEmission(skill, pack.hooks, targetName);

    if (!verdict.emit) {
      omitted.push({ skill: label, class: "safety", reasonCode: verdict.reasonCode, reason: verdict.reason });
      continue;
    }

    if (verdict.reasonCode) {
      degraded.push({ skill: label, class: "capability", reasonCode: verdict.reasonCode, reason: verdict.reason });
    }

    // Emitted: the skill declared a neutral classification, so it is safe to
    // export. Its raw Claude-vocabulary fields are still dropped — they are
    // superseded by the neutral declaration, not a second safety gate.
    for (const field of CLAUDE_ONLY_COSMETIC_FIELDS) {
      if (skill.claudeOnly && Object.prototype.hasOwnProperty.call(skill.claudeOnly, field)) {
        warnings.push({ skill: label, class: "cosmetic", field });
      }
    }
    if (skill.claudeOnly && "allowed-tools" in skill.claudeOnly) {
      warnings.push({ skill: label, class: "cosmetic", field: "allowed-tools", reason: "superseded by neutral.effects" });
    }
    if (skill.claudeOnly && "disable-model-invocation" in skill.claudeOnly) {
      warnings.push({ skill: label, class: "cosmetic", field: "disable-model-invocation", reason: "superseded by neutral.invocation" });
    }

    for (const { name, regex } of PRESENTATION_PATTERNS) {
      if (regex.test(skill.body)) {
        warnings.push({ skill: label, class: "presentation", pattern: name });
      }
    }
  }

  for (const agent of pack.agents) {
    const label = agentLabel(packId, agent.id);
    degraded.push({
      agent: label,
      class: "capability",
      reason: "Claude subagents are a capability the target lacks — omitting removes power, not a guard, so this warns rather than failing the build",
    });
    for (const field of ["model", "color"]) {
      if (agent.claudeOnly && Object.prototype.hasOwnProperty.call(agent.claudeOnly, field)) {
        warnings.push({ agent: label, class: "cosmetic", field });
      }
    }
  }

  if (pack.mcpServers) {
    warnings.push({
      pack: packId,
      class: "capability",
      component: ".mcp.json",
      reason: "MCP server co-location is reported, not translated — emitting a Codex tool-wiring equivalent is out of scope",
    });
  }

  return { omitted, degraded, warnings };
}

function sortByKey(list, keyFn) {
  return [...list].sort((a, b) => keyFn(a).localeCompare(keyFn(b)));
}

/**
 * buildLossReport({ packs, targetNames, renderedAt }) → the loss report object.
 *
 * `packs` is [{ packId, pack }, ...]. `renderedAt` is passed in — never
 * Date.now() inside this pure function — so the report is byte-deterministic
 * for the same input (a git diff on dist/loss-report.json is signal).
 */
export function buildLossReport({ packs, targetNames, renderedAt }) {
  const sortedPacks = sortByKey(packs, (p) => p.packId);
  const targets = {};

  for (const targetName of targetNames) {
    const omitted = [];
    const degraded = [];
    const warnings = [];
    for (const { packId, pack } of sortedPacks) {
      const result = classifyPackLosses(packId, pack, targetName);
      omitted.push(...result.omitted);
      degraded.push(...result.degraded);
      warnings.push(...result.warnings);
    }
    targets[targetName] = {
      omitted: sortByKey(omitted, (e) => e.skill ?? e.pack ?? ""),
      degraded: sortByKey(degraded, (e) => e.agent ?? e.skill ?? e.pack ?? ""),
      warnings: sortByKey(warnings, (e) => e.skill ?? e.agent ?? e.pack ?? ""),
    };
  }

  return { renderedAt, contractVersion: 1, targets };
}

/** hasUnacknowledgedLosses(report) → true if any target has an omission or a degradation. */
export function hasUnacknowledgedLosses(report) {
  return Object.values(report.targets).some((t) => t.omitted.length > 0 || t.degraded.length > 0);
}

/** lossCounts(report) → per-target { omitted, degraded, warnings } counts, for a summary line. */
export function lossCounts(report) {
  const counts = {};
  for (const [targetName, t] of Object.entries(report.targets)) {
    counts[targetName] = { omitted: t.omitted.length, degraded: t.degraded.length, warnings: t.warnings.length };
  }
  return counts;
}

/** renderLossReportMarkdown(report) → the human-readable dist/LOSSES.md contents. */
export function renderLossReportMarkdown(report) {
  const lines = [`# Packaging Loss Report`, ``, `Rendered at: ${report.renderedAt}`, ``];
  for (const [targetName, t] of Object.entries(report.targets)) {
    lines.push(`## ${targetName}`, ``);
    lines.push(`- omitted: ${t.omitted.length}`, `- degraded: ${t.degraded.length}`, `- warnings: ${t.warnings.length}`, ``);
    if (t.omitted.length > 0) {
      lines.push(`### Omitted (safety)`, ``);
      for (const e of t.omitted) lines.push(`- \`${e.skill}\`: ${e.reason}`);
      lines.push(``);
    }
    if (t.degraded.length > 0) {
      lines.push(`### Degraded (capability)`, ``);
      for (const e of t.degraded) lines.push(`- \`${e.agent ?? e.skill}\`: ${e.reason}`);
      lines.push(``);
    }
    if (t.warnings.length > 0) {
      lines.push(`### Warnings (cosmetic / presentation)`, ``);
      for (const e of t.warnings) {
        const subject = e.skill ?? e.pack ?? "(pack)";
        const detail = e.field ?? e.component ?? e.pattern ?? "";
        lines.push(`- \`${subject}\` [${e.class}] ${detail}`.trimEnd());
      }
      lines.push(``);
    }
  }
  return lines.join("\n");
}
