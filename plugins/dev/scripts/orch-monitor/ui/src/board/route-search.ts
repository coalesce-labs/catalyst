// route-search.ts — the typed search-param contract for the detail routes
// (CTL-881 / FND1). This is the load-bearing piece every later redesign ticket
// binds to: the breadcrumb, list-context, pager, and j/k walk are all
// reconstructed from `?from&lens&col&cursor` on the URL alone (detail design
// §3.1 — "URL = location, store = cursor").
//
// PURE module — deliberately React-/router-free so it can be unit-tested under
// `bun test` directly (same pattern as board-logic.ts). `router.tsx` wires
// `validateDetailSearch` into TanStack Router's `validateSearch`; nothing here
// imports the router.
//
// Hard contract (mirrors the param names detail design §3.1 mandates):
//   from   ∈ board | stuck | recent      (which list the operator came from)
//   lens   ∈ linear | phase               (which board lens that list was under)
//   col    : string                       (the column within that lens)
//   cursor : number                       (0-based index into the resolved list)
//
// Robustness requirement (Gherkin "List-context survives a refresh or paste" +
// "unknown or malformed search params fall back to safe defaults rather than
// throwing"): validation NEVER throws — every field independently falls back to
// `undefined` (a cold-link, no context) when absent or malformed, so a pasted
// or hand-edited URL can never crash the route resolver.

/** Which list the operator navigated from. */
export const FROM_VALUES = ["board", "stuck", "recent"] as const;
export type DetailFrom = (typeof FROM_VALUES)[number];

/** Which board lens that originating list was rendered under. */
export const LENS_VALUES = ["linear", "phase"] as const;
export type DetailLens = (typeof LENS_VALUES)[number];

/**
 * The typed search params shared by `/ticket/$id` and `/worker/$id`.
 * Every field is optional: a degraded deep-link (a pasted bare URL) carries
 * none of them and is a valid "cold-link" — see the FND1 Gherkin
 * "A degraded deep-link with no context still works". Pager support for the
 * cold-link case is added by FND2; FND1 only guarantees the contract parses.
 */
export interface DetailSearch {
  from?: DetailFrom;
  lens?: DetailLens;
  col?: string;
  cursor?: number;
}

function isDetailFrom(value: unknown): value is DetailFrom {
  return typeof value === "string" && (FROM_VALUES as readonly string[]).includes(value);
}

function isDetailLens(value: unknown): value is DetailLens {
  return typeof value === "string" && (LENS_VALUES as readonly string[]).includes(value);
}

/**
 * Coerce a raw search value to a finite non-negative integer cursor, or
 * `undefined` if it is absent/malformed. Accepts the numeric form TanStack's
 * default search parser produces (a `number`) as well as a bare string (e.g.
 * hand-pasted `?cursor=4`). Rejects NaN/Infinity, negatives, and non-integers
 * — a cursor is an index into the resolved list, so anything else is unsafe.
 */
function coerceCursor(value: unknown): number | undefined {
  let n: number;
  if (typeof value === "number") {
    n = value;
  } else if (typeof value === "string" && value.trim() !== "") {
    n = Number(value);
  } else {
    return undefined;
  }
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) return undefined;
  return n;
}

/**
 * Validate raw URL search params into the typed `DetailSearch` contract.
 *
 * Total + non-throwing: any input (including `null`, a string, or an object
 * with garbage values) yields a valid `DetailSearch`; unknown/malformed fields
 * are dropped to `undefined` rather than raising. This is exactly TanStack
 * Router's `validateSearch` shape `(raw) => DetailSearch`, and the Gherkin
 * acceptance criterion for "unknown or malformed search params fall back to
 * safe defaults rather than throwing".
 */
export function validateDetailSearch(raw: unknown): DetailSearch {
  const record: Record<string, unknown> =
    typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};

  const out: DetailSearch = {};
  if (isDetailFrom(record.from)) out.from = record.from;
  if (isDetailLens(record.lens)) out.lens = record.lens;
  if (typeof record.col === "string" && record.col !== "") out.col = record.col;
  const cursor = coerceCursor(record.cursor);
  if (cursor !== undefined) out.cursor = cursor;
  return out;
}
