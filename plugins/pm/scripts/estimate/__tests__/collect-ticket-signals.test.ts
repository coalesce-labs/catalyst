import { describe, expect, test } from "bun:test";
import {
  buildSignalRows,
  domainOf,
  domainsFromPaths,
  hoursBetween,
  indexPrsByTicket,
  parseActualsCsv,
  parseCompoundAggregate,
  structuralFlags,
  ticketIdFromPr,
  toCsv,
  type LinearTicket,
  type MergedPr,
} from "../collect-ticket-signals";
import { parseCsv } from "../score-tickets";

// -- fixtures -----------------------------------------------------------------

function pr(over: Partial<MergedPr> = {}): MergedPr {
  return {
    number: 100,
    title: "feat(dev): something (CTL-100)",
    headRefName: "ryan/ctl-100-something",
    createdAt: "2026-06-01T00:00:00Z",
    mergedAt: "2026-06-01T06:00:00Z",
    additions: 120,
    deletions: 30,
    changedFiles: 4,
    files: [
      { path: "plugins/dev/scripts/foo.mjs", additions: 100, deletions: 20 },
      { path: "plugins/pm/docs/bar.md", additions: 20, deletions: 10 },
    ],
    ...over,
  };
}

function ticket(over: Partial<LinearTicket> = {}): LinearTicket {
  return {
    identifier: "CTL-100",
    title: "something",
    state: "Done",
    priority: 2,
    project: "",
    created_at: "2026-05-30T00:00:00Z",
    updated_at: "2026-06-01T07:00:00Z",
    estimate: 3,
    ...over,
  };
}

// -- ticketIdFromPr -------------------------------------------------------------

describe("ticketIdFromPr", () => {
  test("extracts from lowercase branch name", () => {
    expect(ticketIdFromPr(pr({ headRefName: "ryan/ctl-813-loop", title: "x" }), ["CTL"])).toBe(
      "CTL-813",
    );
  });

  test("extracts from uppercase branch name", () => {
    expect(ticketIdFromPr(pr({ headRefName: "CTL-42", title: "x" }), ["CTL"])).toBe("CTL-42");
  });

  test("falls back to PR title when branch has no id", () => {
    expect(
      ticketIdFromPr(pr({ headRefName: "fix/concepts-shared-sync", title: "fix: x (CTL-789)" }), [
        "CTL",
      ]),
    ).toBe("CTL-789");
  });

  test("non-matching team is ignored", () => {
    expect(ticketIdFromPr(pr({ headRefName: "adv-12-foo", title: "ADV-12" }), ["CTL"])).toBeNull();
  });

  test("multiple teams accepted", () => {
    expect(ticketIdFromPr(pr({ headRefName: "adv-12-foo", title: "" }), ["CTL", "ADV"])).toBe(
      "ADV-12",
    );
  });

  test("branch id wins over a different title id", () => {
    expect(
      ticketIdFromPr(pr({ headRefName: "ryan/ctl-1-a", title: "dup of (CTL-2)" }), ["CTL"]),
    ).toBe("CTL-1");
  });
});

// -- domains + flags --------------------------------------------------------------

describe("domainOf / domainsFromPaths", () => {
  test("plugins keep two segments", () => {
    expect(domainOf("plugins/dev/scripts/foo.mjs")).toBe("plugins/dev");
  });

  test("non-plugins use first segment", () => {
    expect(domainOf("website/src/pages/index.astro")).toBe("website");
    expect(domainOf("CLAUDE.md")).toBe("CLAUDE.md");
  });

  test("domainsFromPaths dedupes and sorts", () => {
    expect(
      domainsFromPaths([
        "website/a.ts",
        "plugins/dev/x.mjs",
        "plugins/dev/y.mjs",
        "plugins/pm/z.ts",
      ]),
    ).toEqual(["plugins/dev", "plugins/pm", "website"]);
  });
});

describe("structuralFlags", () => {
  test("migration path sets has_migration", () => {
    expect(structuralFlags(["db/migrations/001.sql"]).has_migration).toBe(true);
  });

  test("website path is frontend, not backend", () => {
    const f = structuralFlags(["website/src/x.ts"]);
    expect(f.has_frontend).toBe(true);
    expect(f.has_backend).toBe(false);
  });

  test(".mjs script is backend", () => {
    const f = structuralFlags(["plugins/dev/scripts/execution-core/scheduler.mjs"]);
    expect(f.has_backend).toBe(true);
    expect(f.has_frontend).toBe(false);
  });

  test(".tsx is frontend even outside website/", () => {
    expect(structuralFlags(["plugins/dev/scripts/orch-monitor/src/App.tsx"]).has_frontend).toBe(
      true,
    );
  });

  test("markdown-only change has no flags", () => {
    const f = structuralFlags(["docs/adrs.md"]);
    expect(f).toEqual({ has_migration: false, has_frontend: false, has_backend: false });
  });
});

// -- parsers ---------------------------------------------------------------------

describe("parseActualsCsv", () => {
  const csv = [
    `"ticket_id","session_count","otel_cost_usd","otel_input_tokens","otel_output_tokens","otel_turns","otel_wall_time_hours","otel_tool_success_rate","models","branches"`,
    `"CTL-100","2","12.3456","1000","2000","42","1.5000","","claude-opus-4-7","ryan/ctl-100"`,
  ].join("\n");

  test("maps ticket to otel columns", () => {
    const m = parseActualsCsv(csv);
    expect(m.get("CTL-100")).toEqual({
      otel_cost_usd: "12.3456",
      otel_input_tokens: "1000",
      otel_output_tokens: "2000",
      otel_turns: "42",
      otel_wall_time_hours: "1.5000",
      otel_tool_success_rate: "",
    });
  });

  test("empty content yields empty map", () => {
    expect(parseActualsCsv("").size).toBe(0);
  });
});

describe("parseCompoundAggregate", () => {
  test("extracts numeric estimate_actual per ticket", () => {
    const m = parseCompoundAggregate(
      JSON.stringify({
        entries: 2,
        tickets: {
          "CTL-1": { estimate_actual: 5 },
          "CTL-2": { estimate_actual: null },
        },
      }),
    );
    expect(m.get("CTL-1")).toBe(5);
    expect(m.has("CTL-2")).toBe(false);
  });

  test("malformed JSON yields empty map (fail-open)", () => {
    expect(parseCompoundAggregate("not json").size).toBe(0);
  });

  test("missing tickets key yields empty map", () => {
    expect(parseCompoundAggregate("{}").size).toBe(0);
  });
});

describe("hoursBetween", () => {
  test("6 hours", () => {
    expect(hoursBetween("2026-06-01T00:00:00Z", "2026-06-01T06:00:00Z")).toBe(6);
  });
  test("bad input → null", () => {
    expect(hoursBetween("nope", "2026-06-01T06:00:00Z")).toBeNull();
  });
});

// -- indexPrsByTicket --------------------------------------------------------------

describe("indexPrsByTicket", () => {
  test("first (latest-merged) PR wins per ticket", () => {
    const newer = pr({ number: 2, mergedAt: "2026-06-02T00:00:00Z" });
    const older = pr({ number: 1, mergedAt: "2026-06-01T00:00:00Z" });
    const map = indexPrsByTicket([newer, older], ["CTL"]); // gh emits newest first
    expect(map.get("CTL-100")?.number).toBe(2);
  });
});

// -- buildSignalRows + toCsv ---------------------------------------------------------

describe("buildSignalRows", () => {
  const actuals = parseActualsCsv(
    [
      `"ticket_id","session_count","otel_cost_usd","otel_input_tokens","otel_output_tokens","otel_turns","otel_wall_time_hours","otel_tool_success_rate","models","branches"`,
      `"CTL-100","1","42.0000","10","20","33","2.0000","","m","b"`,
      `"CTL-200","1","9.9900","5","6","12","0.5000","","m","b"`,
    ].join("\n"),
  );

  test("full join: PR + actuals + human re-score", () => {
    const rows = buildSignalRows(
      [ticket()],
      new Map([["CTL-100", pr()]]),
      actuals,
      new Map([["CTL-100", 5]]),
    );
    expect(rows).toHaveLength(1);
    const r = rows[0];
    expect(r.ticket_id).toBe("CTL-100");
    expect(r.pr_number).toBe("100");
    expect(r.additions).toBe("120");
    expect(r.closed_at).toBe("2026-06-01T06:00:00Z"); // PR mergedAt, not updated_at
    expect(r.hours_to_merge).toBe("6.00");
    expect(r.otel_cost_usd).toBe("42.0000");
    expect(r.domains_touched).toBe("plugins/dev|plugins/pm");
    expect(r.has_backend).toBe("true");
    expect(r.has_frontend).toBe("false");
    expect(r.human_actual_points).toBe("5");
  });

  test("actuals-only ticket kept with updated_at as closed_at", () => {
    const rows = buildSignalRows(
      [ticket({ identifier: "CTL-200", title: "no pr matched" })],
      new Map(),
      actuals,
      new Map(),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].pr_number).toBe("");
    expect(rows[0].closed_at).toBe("2026-06-01T07:00:00Z");
    expect(rows[0].otel_cost_usd).toBe("9.9900");
    expect(rows[0].has_backend).toBe(""); // no paths → flags unknown, not false
  });

  test("ticket with neither PR nor actuals is dropped", () => {
    const rows = buildSignalRows(
      [ticket({ identifier: "CTL-300" })],
      new Map(),
      new Map(),
      new Map(),
    );
    expect(rows).toHaveLength(0);
  });
});

describe("toCsv", () => {
  test("round-trips through score-tickets parseCsv with extra column intact", () => {
    const rows = buildSignalRows(
      [ticket({ title: 'has "quotes", commas' })],
      new Map([["CTL-100", pr()]]),
      new Map(),
      new Map([["CTL-100", 8]]),
    );
    const parsed = parseCsv(toCsv(rows));
    expect(parsed).toHaveLength(1);
    expect(parsed[0].ticket_id).toBe("CTL-100");
    expect(parsed[0].title).toBe('has "quotes", commas');
    expect(
      (parsed[0] as unknown as Record<string, string>).human_actual_points,
    ).toBe("8");
  });
});
