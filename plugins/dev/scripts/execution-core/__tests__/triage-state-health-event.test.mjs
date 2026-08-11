import { describe, test, expect } from "bun:test";
import { buildTriageStateHealthEvent, TRIAGE_STATE_MISSING_ACTION, TRIAGE_STATE_RECOVERED_ACTION } from "../triage-state-health-event.mjs";
import { isBrokerProtectedName, phaseSlotOf } from "../../broker/namespace-contract.mjs";

describe("triage state health events (CAT-140)", () => {
  test("missing carries its team and expected state as WARN attributes", () => {
    const ev = JSON.parse(buildTriageStateHealthEvent({ team: "CAT", action: TRIAGE_STATE_MISSING_ACTION, expectedState: "Triage", ticketsAffected: 23 }));
    expect(ev.attributes["event.name"]).toBe("monitor.triage_state.missing.CAT");
    expect(ev.severityText).toBe("WARN");
    expect(ev.attributes["catalyst.team"]).toBe("CAT");
    expect(ev.attributes["triage_state.expected"]).toBe("Triage");
  });

  test("recovered is INFO and both names are outside broker namespaces", () => {
    const ev = JSON.parse(buildTriageStateHealthEvent({ team: "CAT", action: TRIAGE_STATE_RECOVERED_ACTION, expectedState: "Triage" }));
    expect(ev.severityText).toBe("INFO");
    for (const action of [TRIAGE_STATE_MISSING_ACTION, TRIAGE_STATE_RECOVERED_ACTION]) {
      const name = `monitor.triage_state.${action}.CAT`;
      expect(isBrokerProtectedName(name)).toBe(false);
      expect(phaseSlotOf(name)).toBeNull();
    }
  });
});
