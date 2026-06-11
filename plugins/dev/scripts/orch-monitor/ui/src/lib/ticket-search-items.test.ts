import { describe, it, expect } from "bun:test";
import { ticketSearchItems } from "./ticket-search-items";

const r = (ticket: string, score: number, linearState: string | null = null) => ({
  ticket, score, linearState, labels: [] as string[],
});

describe("ticketSearchItems", () => {
  it("maps results to {id,label} rows preserving server order", () => {
    const rows = ticketSearchItems([r("CTL-10", 5), r("CTL-20", 3)]);
    expect(rows.map((x) => x.id)).toEqual(["CTL-10", "CTL-20"]);
  });

  it("surfaces linearState as meta when present", () => {
    const [row] = ticketSearchItems([r("CTL-10", 5, "In Progress")]);
    expect(row.meta).toBe("In Progress");
  });

  it("empty results yield no rows", () => {
    expect(ticketSearchItems([])).toEqual([]);
  });
});
