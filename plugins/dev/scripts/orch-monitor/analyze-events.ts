#!/usr/bin/env bun
/**
 * analyze-events — answer multi-agent event-log questions from canonical
 * (CTL-300) JSONL files. See lib/event-analysis.ts for the question
 * implementations.
 *
 * Usage:
 *   bun run analyze-events.ts <question> [--input <path>]...
 *
 * Questions: phase-time | stalls | ci-funnel | all
 *
 * Defaults to reading ~/catalyst/events/*.jsonl (excludes *.legacy).
 * Tolerates the corrupt 2026-04 sentinel — skipped lines are reported
 * on stderr, not aborted.
 */

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  normalize,
  phaseTime,
  stalls,
  ciFunnel,
  type NormalizedEvent,
} from "./lib/event-analysis";

const QUESTIONS = ["phase-time", "stalls", "ci-funnel", "all"] as const;
type Question = (typeof QUESTIONS)[number];

interface ParsedArgs {
  question: Question;
  inputs: string[];
}

function isQuestion(s: string): s is Question {
  return (QUESTIONS as readonly string[]).includes(s);
}

function defaultInputs(): string[] {
  const home = process.env.HOME;
  if (home === undefined || home.length === 0) return [];
  const dir = join(home, "catalyst", "events");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((n) => n.endsWith(".jsonl"))
    .map((n) => join(dir, n));
}

function parseArgs(argv: string[]): ParsedArgs | null {
  if (argv.length === 0) return null;
  const question = argv[0];
  if (question === undefined || !isQuestion(question)) return null;

  const inputs: string[] = [];
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--input") {
      const next = argv[i + 1];
      if (next === undefined) return null;
      inputs.push(next);
      i += 1;
    } else {
      return null;
    }
  }
  if (inputs.length === 0) inputs.push(...defaultInputs());
  return { question, inputs };
}

function loadEvents(paths: string[]): {
  events: NormalizedEvent[];
  stats: { totalLines: number; skippedLines: number };
} {
  const events: NormalizedEvent[] = [];
  let totalLines = 0;
  let skippedLines = 0;
  for (const path of paths) {
    if (!existsSync(path)) {
      process.stderr.write(`warn: input file not found: ${path}\n`);
      continue;
    }
    const text = readFileSync(path, "utf8");
    const lines = text.split("\n").filter((l) => l.length > 0);
    for (const line of lines) {
      totalLines += 1;
      const e = normalize(line);
      if (e === null) {
        skippedLines += 1;
        continue;
      }
      events.push(e);
    }
  }
  return { events, stats: { totalLines, skippedLines } };
}

function usage(): string {
  return [
    "Usage: bun run analyze-events.ts <question> [--input <path>]...",
    "",
    `Questions: ${QUESTIONS.join(" | ")}`,
    "",
    "Defaults to reading ~/catalyst/events/*.jsonl (excludes .legacy files).",
  ].join("\n");
}

function main(): number {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed === null) {
    process.stderr.write(usage() + "\n");
    return 2;
  }

  const { events, stats } = loadEvents(parsed.inputs);
  process.stderr.write(
    `read ${stats.totalLines} lines from ${parsed.inputs.length} file(s); ` +
      `kept ${events.length} normalized events; skipped ${stats.skippedLines} (heartbeats/legacy/corrupt)\n`,
  );

  const out: Record<string, unknown> = {
    inputs: parsed.inputs,
    stats,
  };

  if (parsed.question === "phase-time" || parsed.question === "all") {
    out["phaseTime"] = phaseTime(events);
  }
  if (parsed.question === "stalls" || parsed.question === "all") {
    out["stalls"] = stalls(events);
  }
  if (parsed.question === "ci-funnel" || parsed.question === "all") {
    out["ciFunnel"] = ciFunnel(events);
  }

  process.stdout.write(JSON.stringify(out, null, 2) + "\n");
  return 0;
}

process.exit(main());
