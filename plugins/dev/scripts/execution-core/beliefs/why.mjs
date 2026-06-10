// beliefs/why.mjs — CTL-934 `catalyst why <ticket>`: the §5 recursive-CTE
// belief trace. Reads beliefs.db (CATALYST_BELIEFS_DB override honored via
// schema.mjs) and renders, for the latest tick that mentions a ticket, every
// belief about it ← the rule that fired ← each source fact, with timestamps
// and raw values. Today's 10-hour archaeology becomes one query (spec §5).
//
// Read-only: opens the db, never writes (no tick/fact insertion, no rule eval).

import { openBeliefsDb } from "./schema.mjs";

// latestTickForTicket — the newest tick_id that has a belief whose subject
// references the ticket (subject is 'TICKET/phase' for per-phase beliefs;
// capacity beliefs 'host:…' are tick-global and folded in for that tick).
export function latestTickForTicket(db, ticket) {
  const row = db
    .query(
      `SELECT MAX(b.tick_id) AS tick_id
         FROM belief b
        WHERE b.subject = ? OR b.subject LIKE ? || '/%'`,
    )
    .get(ticket, ticket);
  return row?.tick_id ?? null;
}

// traceTicket — gather the belief→rule→facts trace for a ticket at the latest
// (or an explicit) tick. Returns a structured object the renderer formats;
// kept data-only so tests assert structure, not text.
//
// Shape:
//   { ticket, tickId, nowMs, host,
//     beliefs: [ { belief_id, name, subject, value, rule_id, stratum,
//                  sources: [ {kind:'belief'|'fact', table, id, summary, ts_ms} ] } ] }
export function traceTicket(db, ticket, { tickId: explicitTick } = {}) {
  const tickId = explicitTick ?? latestTickForTicket(db, ticket);
  if (tickId == null) return { ticket, tickId: null, beliefs: [] };

  const tick = db.query("SELECT now_ms, host FROM tick WHERE tick_id = ?").get(tickId);

  // The §5 recursive CTE: start from the ticket's beliefs at this tick, walk
  // source_fact_ids transitively to reach every belief in the chain. Refs are
  // TAGGED (rules.mjs): 'b<id>' belief, 'f<id>' fact, 't<id>' tick, 'i<id>'
  // intent — so the belief edges are exactly the 'b'-prefixed refs (no integer-
  // space collision). Facts are leaves resolved per-table below.
  const beliefRows = db
    .query(
      `WITH RECURSIVE chain(belief_id) AS (
         SELECT belief_id FROM belief
          WHERE tick_id = :tick
            AND (subject = :ticket OR subject LIKE :ticket || '/%')
         UNION
         SELECT CAST(substr(j.value, 2) AS INTEGER)
           FROM chain c
           JOIN belief b ON b.belief_id = c.belief_id
           JOIN json_each(b.source_fact_ids) j
          WHERE substr(j.value, 1, 1) = 'b'
       )
       SELECT b.* FROM belief b
        JOIN chain c ON c.belief_id = b.belief_id
        ORDER BY b.stratum, b.name, b.subject`,
    )
    .all({ ":tick": tickId, ":ticket": ticket });

  const beliefById = new Map(beliefRows.map((b) => [b.belief_id, b]));

  // Resolvers keyed by the one-char ref TAG (rules.mjs REF TAGGING). Each
  // resolver builds a human summary with the raw values that mattered, and the
  // timestamp the rule reasoned about, from the fact's OWN table — no scan, no
  // cross-table id collision.
  const RESOLVERS = {
    t: {
      table: "tick",
      sql: "SELECT tick_id AS id, now_ms, host FROM tick WHERE tick_id = ?",
      summary: (r) => `tick host=${r.host} now_ms=${r.now_ms}`,
      ts: (r) => r.now_ms,
    },
    i: {
      table: "intent",
      sql: "SELECT intent_id AS id, kind, subject, attempts, outcome FROM intent WHERE intent_id = ?",
      summary: (r) => `intent ${r.kind} ${r.subject} attempts=${r.attempts} outcome=${r.outcome}`,
    },
    s: {
      table: "obs_signal",
      sql: "SELECT fact_id AS id, ticket, phase, status, bg_job_id, generation, started_at_ms, updated_at_ms FROM obs_signal WHERE fact_id = ?",
      summary: (r) =>
        `signal ${r.ticket}/${r.phase} status=${r.status} bg=${r.bg_job_id} started_at_ms=${r.started_at_ms} updated_at_ms=${r.updated_at_ms}`,
      ts: (r) => r.updated_at_ms ?? r.started_at_ms,
    },
    a: {
      table: "obs_agent",
      sql: "SELECT fact_id AS id, session_id, short_id, kind, status, state, started_at_ms FROM obs_agent WHERE fact_id = ?",
      summary: (r) => `agent short=${r.short_id} kind=${r.kind} status=${r.status} state=${r.state}`,
      ts: (r) => r.started_at_ms,
    },
    j: {
      table: "obs_job",
      sql: "SELECT fact_id AS id, bg_job_id, state, tempo, detail, needs, first_terminal_at, exists_flag, mtime_ms FROM obs_job WHERE fact_id = ?",
      summary: (r) =>
        `job ${r.bg_job_id} state=${r.state} tempo=${r.tempo} detail=${JSON.stringify(r.detail)} firstTerminalAt=${r.first_terminal_at} exists=${r.exists_flag}`,
      ts: (r) => r.mtime_ms,
    },
    r: {
      table: "obs_transcript",
      sql: "SELECT fact_id AS id, session_id, exists_flag, mtime_ms, bytes FROM obs_transcript WHERE fact_id = ?",
      summary: (r) => `transcript ${r.session_id} exists=${r.exists_flag} bytes=${r.bytes}`,
      ts: (r) => r.mtime_ms,
    },
    h: {
      table: "obs_heartbeat",
      sql: "SELECT fact_id AS id, ticket, phase, kind, ts_ms FROM obs_heartbeat WHERE fact_id = ?",
      summary: (r) => `heartbeat ${r.ticket}/${r.phase} kind=${r.kind}`,
      ts: (r) => r.ts_ms,
    },
    l: {
      table: "obs_linear",
      sql: "SELECT fact_id AS id, ticket, state FROM obs_linear WHERE fact_id = ?",
      summary: (r) => `linear ${r.ticket} state=${r.state}`,
    },
  };

  // resolveRef — dispatch on the one-char tag prefix to the matching table.
  function resolveRef(tagged) {
    const tag = tagged[0];
    const id = Number(tagged.slice(1));
    if (tag === "b") {
      const child = beliefById.get(id);
      return {
        kind: "belief",
        table: "belief",
        id,
        summary: child
          ? `${child.name}(${child.subject}) [${child.rule_id}]`
          : `belief #${id} (outside this tick's chain)`,
        ts_ms: null,
      };
    }
    const res = RESOLVERS[tag];
    if (res) {
      const row = db.query(res.sql).get(id);
      if (row) {
        return {
          kind: "fact",
          table: res.table,
          id,
          summary: res.summary(row),
          ts_ms: res.ts ? (res.ts(row) ?? null) : null,
          raw: row,
        };
      }
    }
    return { kind: "fact", table: "unknown", id, summary: `unresolved ref ${tagged}`, ts_ms: null };
  }

  const beliefs = beliefRows.map((b) => {
    const refs = flatten(JSON.parse(b.source_fact_ids));
    const sources = refs.map((ref) => resolveRef(ref));
    return {
      belief_id: b.belief_id,
      name: b.name,
      subject: b.subject,
      value: b.value,
      rule_id: b.rule_id,
      stratum: b.stratum,
      sources,
    };
  });

  return { ticket, tickId, nowMs: tick?.now_ms ?? null, host: tick?.host ?? null, beliefs };
}

// flatten — source_fact_ids may contain nested json_array(...) (e.g. R8 nests
// the lease belief-id array and the bg-agent fact-id array). Walk to a flat
// list of TAGGED ref tokens ('b3','f1','t1',…). A bare integer (legacy /
// untagged) is kept as a string so resolveRef's obs_* scan can still find it.
function flatten(refs) {
  const out = [];
  const walk = (v) => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (typeof v === "number") out.push(String(v));
    else if (typeof v === "string" && v) out.push(v);
  };
  walk(refs);
  return out;
}

// renderTrace — human-readable rendering of a traceTicket() result.
export function renderTrace(trace) {
  const lines = [];
  if (trace.tickId == null) {
    return `no beliefs recorded for ${trace.ticket} (shadow mode may be off, or no tick has observed it yet)`;
  }
  const iso = (ms) => (ms == null ? "—" : new Date(ms).toISOString());
  lines.push(`why ${trace.ticket}  —  tick #${trace.tickId} @ ${iso(trace.nowMs)} on ${trace.host}`);
  lines.push("");
  if (trace.beliefs.length === 0) {
    lines.push("  (no beliefs about this ticket at this tick)");
    return lines.join("\n");
  }
  for (const b of trace.beliefs) {
    const val = b.value ? `  ${b.value}` : "";
    lines.push(`● ${b.name}(${b.subject})   [rule ${b.rule_id}, stratum ${b.stratum}]${val}`);
    if (b.sources.length === 0) {
      lines.push("    └─ (no source facts)");
    } else {
      b.sources.forEach((s, i) => {
        const last = i === b.sources.length - 1;
        const branch = last ? "└─" : "├─";
        const ts = s.ts_ms != null ? `  @ ${iso(s.ts_ms)}` : "";
        const tag = s.kind === "belief" ? "belief" : s.table;
        lines.push(`    ${branch} [${tag} #${s.id}] ${s.summary}${ts}`);
      });
    }
    lines.push("");
  }
  return lines.join("\n").replace(/\n+$/, "");
}

// main — CLI entry: `catalyst-why <ticket> [--tick N] [--json]`.
export function main(argv = process.argv.slice(2), { env = process.env, out = console.log } = {}) {
  let ticket = null;
  let tickId;
  let asJson = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") asJson = true;
    else if (a === "--tick") tickId = Number(argv[++i]);
    else if (!a.startsWith("-")) ticket = a;
  }
  if (!ticket) {
    out("usage: catalyst why <ticket> [--tick N] [--json]");
    return 2;
  }
  const db = openBeliefsDb({ env });
  try {
    const trace = traceTicket(db, ticket, { tickId });
    out(asJson ? JSON.stringify(trace, null, 2) : renderTrace(trace));
    return trace.tickId == null ? 1 : 0;
  } finally {
    try {
      db.close();
    } catch {
      /* best-effort */
    }
  }
}

if (import.meta.main) {
  process.exit(main());
}
