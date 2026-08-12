import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { HOST_STATE_SEAMS } from "./doctor.mjs";

// CAT-179: HOST_STATE_SEAMS is opt-in and runDoctor spreads opts opaquely, so
// an omitted seam is a silent no-op. This scan accounts for checks whose own
// body calls homedir(); default* helper-mediated reads are already injectable.
const SRC = readFileSync(join(import.meta.dir, "doctor.mjs"), "utf8");

// These direct readers are not whole-check seams. Two-directional assertions
// below make both new omissions and stale exceptions fail loudly.
const KNOWN_UNREGISTERED = Object.freeze([
  "checkReaper", // ~/Library/LaunchAgents orphan-sweep plist
  "checkHealthResponder", // ~/Library/LaunchAgents health-responder plist
  "checkLogShipper", // ~/Library/LaunchAgents shipper plist
  "checkCloudTokenEnv", // ~/.config/catalyst and ~/.zshenv
  "checkLayer2PathDivergence", // ~/.config/catalyst/config.json
]);

function checksReadingHomedirDirectly(src) {
  const found = new Set();
  const decl = /^export function (check[A-Za-z0-9_]*)\s*\(/gm;
  for (const match of src.matchAll(decl)) {
    const parametersStart = src.indexOf("(", match.index);
    let parameterDepth = 0;
    let parametersEnd = parametersStart;
    for (; parametersEnd < src.length; parametersEnd += 1) {
      if (src[parametersEnd] === "(") parameterDepth += 1;
      if (src[parametersEnd] === ")") parameterDepth -= 1;
      if (parameterDepth === 0) break;
    }
    const bodyStart = src.indexOf("{", parametersEnd);
    let depth = 0;
    let bodyEnd = bodyStart;
    for (; bodyEnd < src.length; bodyEnd += 1) {
      if (src[bodyEnd] === "{") depth += 1;
      if (src[bodyEnd] === "}") depth -= 1;
      if (depth === 0) break;
    }
    const body = src.slice(bodyStart, bodyEnd + 1);
    if (/\bhomedir\(\)/.test(body)) found.add(match[1]);
  }
  return found;
}

const checkFnFor = (checkName) =>
  `check${checkName.split("-").map((part) => part[0].toUpperCase() + part.slice(1)).join("")}`;

describe("HOST_STATE_SEAMS registry completeness (CAT-179)", () => {
  const reading = checksReadingHomedirDirectly(SRC);
  const registered = new Set(HOST_STATE_SEAMS.map((entry) => checkFnFor(entry.checkName)));

  it("detects the known host-state readers", () => {
    expect(reading.size).toBeGreaterThan(0);
    expect(reading.has("checkStaleLock")).toBe(true);
  });

  it("accounts for every homedir()-reading check", () => {
    const unaccounted = [...reading]
      .filter((name) => !registered.has(name) && !KNOWN_UNREGISTERED.includes(name))
      .sort();
    expect(unaccounted).toEqual([]);
  });

  it("has no stale allowlist entries", () => {
    const stale = KNOWN_UNREGISTERED.filter((name) => !reading.has(name) || registered.has(name)).sort();
    expect(stale).toEqual([]);
  });

  it("pins the currently unregistered set", () => {
    expect([...reading].filter((name) => !registered.has(name)).sort()).toEqual([...KNOWN_UNREGISTERED].sort());
  });
});
