#!/usr/bin/env bun
/**
 * adapt-reference-corpus.ts — transform the flat CTL-746 corpus into the
 * entries[] schema that reference-class-lookup.ts loadCorpus() consumes.
 *
 * Usage (CLI):
 *   bun adapt-reference-corpus.ts [--in <flat.json>] [--out <corpus.json>]
 *
 * Defaults:
 *   --in  thoughts/shared/pm/analyses/reference-corpus.json
 *   --out plugins/pm/scripts/estimate/reference-class-corpus.json
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Corpus, CorpusEntry, TShirt } from "./reference-class-lookup.ts";

/** Transform a flat CTL-746 corpus dict into the loadCorpus() entries[] schema. */
export function adaptCorpus(flat: Record<string, any>, generatedAt?: string): Corpus {
  const entries: CorpusEntry[] = [];
  const meta = flat._meta ?? {};
  const ts = generatedAt ?? meta.generated ?? new Date(0).toISOString();

  for (const [key, raw] of Object.entries(flat)) {
    if (key === "_meta" || typeof raw !== "object" || raw === null) continue;
    const points = raw.heuristic?.points;
    if (typeof points !== "number") continue;

    const git = raw.git ?? null;
    const loc = git ? (raw.git.loc_added ?? 0) + (raw.git.loc_deleted ?? 0) : null;
    const changedFiles = git ? (raw.git.files_changed ?? null) : null;
    const actuals = raw.actuals ?? {};

    entries.push({
      ticket_id: raw.ticket ?? key,
      title: "",
      tier: null as unknown as number,
      tshirt: (raw.heuristic.tshirt ?? "M") as TShirt,
      points,
      confidence: "low",
      rationale: "reconstructed from CTL-746 actuals corpus",
      signals: {
        loc,
        changed_files: changedFiles,
        domains: [],
        has_migration: false,
        has_frontend: false,
        has_backend: false,
      },
      actuals: {
        cost_usd: actuals.cost_usd ?? null,
        turns: actuals.turns ?? null,
        wall_hours: actuals.wall_time_hours ?? null,
      },
    });
  }

  return {
    generated_at: ts,
    schema: "catalyst.estimation.corpus.v1",
    count: entries.length,
    entries,
  };
}

async function main() {
  const args = process.argv.slice(2);
  const getFlag = (f: string) => {
    const i = args.indexOf(f);
    return i !== -1 && i + 1 < args.length ? args[i + 1] : null;
  };

  const repoRoot = resolve(import.meta.dir, "../../../..");
  const inPath = resolve(
    getFlag("--in") ?? `${repoRoot}/thoughts/shared/pm/analyses/reference-corpus.json`
  );
  const outPath = resolve(
    getFlag("--out") ??
      `${import.meta.dir}/reference-class-corpus.json`
  );

  const flat = JSON.parse(readFileSync(inPath, "utf8"));
  const corpus = adaptCorpus(flat, flat._meta?.generated);
  writeFileSync(outPath, JSON.stringify(corpus, null, 2) + "\n", "utf8");
  console.log(`wrote ${corpus.count} entries to ${outPath}`);
}

if (import.meta.main) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
