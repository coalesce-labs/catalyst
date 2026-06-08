// hrw.test.mjs — Highest-Random-Weight (rendezvous) ownership (CTL-859 PR2).
// Pure deterministic hashing: determinism, single-host degeneracy, distribution
// sanity, and the minimal-churn property that makes HRW the right choice for a
// small fleet (removing a non-owner host never moves a ticket's owner).
import { describe, it, expect } from "bun:test";

import { ownerForTicket, ownedBy } from "./hrw.mjs";

const HOSTS = ["mini", "mac-studio", "macbook"];

describe("ownerForTicket — determinism", () => {
  it("same (ticket, host-set) → same owner every time", () => {
    const a = ownerForTicket("CTL-842", HOSTS);
    const b = ownerForTicket("CTL-842", HOSTS);
    expect(a).toBe(b);
    expect(HOSTS).toContain(a);
  });

  it("host order in the roster does not change the owner", () => {
    const owner = ownerForTicket("CTL-842", HOSTS);
    const reversed = ownerForTicket("CTL-842", [...HOSTS].reverse());
    expect(reversed).toBe(owner);
  });
});

describe("ownerForTicket — single host & empty roster", () => {
  it("a single-host roster always owns every ticket", () => {
    for (const t of ["CTL-1", "CTL-842", "ADV-77", "CTL-999"]) {
      expect(ownerForTicket(t, ["only-host"])).toBe("only-host");
    }
  });

  it("an empty roster has no owner (null)", () => {
    expect(ownerForTicket("CTL-842", [])).toBeNull();
    expect(ownerForTicket("CTL-842", undefined)).toBeNull();
  });
});

describe("ownerForTicket — distribution sanity", () => {
  it("different tickets map across more than one host", () => {
    const owners = new Set();
    for (let i = 0; i < 300; i += 1) {
      owners.add(ownerForTicket(`CTL-${i}`, HOSTS));
    }
    // sha1 spread should cover the whole roster over 300 tickets.
    expect(owners.size).toBe(HOSTS.length);
  });

  it("roughly balanced — no host owns more than ~60% of a large sample", () => {
    const counts = Object.fromEntries(HOSTS.map((h) => [h, 0]));
    const N = 900;
    for (let i = 0; i < N; i += 1) {
      counts[ownerForTicket(`CTL-${i}`, HOSTS)] += 1;
    }
    for (const h of HOSTS) {
      expect(counts[h]).toBeGreaterThan(0);
      expect(counts[h] / N).toBeLessThan(0.6); // far from a degenerate skew
    }
  });
});

describe("ownerForTicket — minimal churn (the HRW property)", () => {
  it("removing a NON-owner host never changes a ticket's owner", () => {
    for (let i = 0; i < 200; i += 1) {
      const ticket = `CTL-${i}`;
      const owner = ownerForTicket(ticket, HOSTS);
      // drop a host that is NOT the owner.
      const nonOwner = HOSTS.find((h) => h !== owner);
      const reduced = HOSTS.filter((h) => h !== nonOwner);
      expect(ownerForTicket(ticket, reduced)).toBe(owner);
    }
  });

  it("removing the OWNER re-homes ONLY that host's tickets; others undisturbed", () => {
    const victim = "mac-studio";
    const reduced = HOSTS.filter((h) => h !== victim);
    let movedCount = 0;
    for (let i = 0; i < 300; i += 1) {
      const ticket = `CTL-${i}`;
      const before = ownerForTicket(ticket, HOSTS);
      const after = ownerForTicket(ticket, reduced);
      if (before === victim) {
        // its tickets must re-home to a surviving host.
        movedCount += 1;
        expect(reduced).toContain(after);
      } else {
        // everyone else's mapping is untouched — the minimal-churn guarantee.
        expect(after).toBe(before);
      }
    }
    expect(movedCount).toBeGreaterThan(0); // the victim actually owned some
  });

  it("adding a host only steals a fraction; the rest keep their owner", () => {
    const grown = [...HOSTS, "new-host"];
    let stolen = 0;
    let kept = 0;
    for (let i = 0; i < 300; i += 1) {
      const ticket = `CTL-${i}`;
      const before = ownerForTicket(ticket, HOSTS);
      const after = ownerForTicket(ticket, grown);
      if (after === "new-host") stolen += 1;
      else {
        expect(after).toBe(before); // unchanged owners are exactly preserved
        kept += 1;
      }
    }
    expect(kept).toBeGreaterThan(stolen); // most tickets keep their owner
  });
});

describe("ownedBy — the per-daemon eligibility predicate", () => {
  it("true exactly for the HRW owner", () => {
    const ticket = "CTL-842";
    const owner = ownerForTicket(ticket, HOSTS);
    expect(ownedBy(ticket, HOSTS, owner)).toBe(true);
    for (const other of HOSTS.filter((h) => h !== owner)) {
      expect(ownedBy(ticket, HOSTS, other)).toBe(false);
    }
  });

  it("false on an empty roster (no owner)", () => {
    expect(ownedBy("CTL-842", [], "mini")).toBe(false);
  });
});
