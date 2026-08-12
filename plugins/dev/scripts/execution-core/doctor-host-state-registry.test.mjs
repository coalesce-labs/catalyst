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

export function checksReadingHomedirDirectly(src) {
  const found = new Set();
  const decl = /^(?:export\s+)?(?:function\s+(check[A-Za-z0-9_]*)\s*\(|const\s+(check[A-Za-z0-9_]*)\s*=)/gm;
  for (const match of src.matchAll(decl)) {
    const checkName = match[1] ?? match[2];
    let bodyStart;
    if (match[1]) {
      const parametersStart = src.indexOf("(", match.index);
      let parameterDepth = 0;
      let parametersEnd = parametersStart;
      for (; parametersEnd < src.length; parametersEnd += 1) {
        if (src[parametersEnd] === "(") parameterDepth += 1;
        if (src[parametersEnd] === ")") parameterDepth -= 1;
        if (parameterDepth === 0) break;
      }
      bodyStart = src.indexOf("{", parametersEnd);
    } else {
      const declarationEnd = src.indexOf(";", match.index);
      const arrow = src.indexOf("=>", match.index);
      const functionKeyword = src.indexOf("function", match.index);
      const isArrow = arrow !== -1 && (declarationEnd === -1 || arrow < declarationEnd);
      const isFunction = functionKeyword !== -1 && (declarationEnd === -1 || functionKeyword < declarationEnd);
      if (!isArrow && !isFunction) continue;
      bodyStart = src.indexOf("{", isArrow ? arrow : functionKeyword);
      if (bodyStart === -1 || (declarationEnd !== -1 && bodyStart > declarationEnd)) {
        const expression = src.slice(match.index, declarationEnd === -1 ? src.length : declarationEnd + 1);
        if (/\bhomedir\(\)/.test(expression)) found.add(checkName);
        continue;
      }
    }
    let depth = 0;
    let bodyEnd = bodyStart;
    for (; bodyEnd < src.length; bodyEnd += 1) {
      if (src[bodyEnd] === "{") depth += 1;
      if (src[bodyEnd] === "}") depth -= 1;
      if (depth === 0) break;
    }
    const declaration = src.slice(match.index, bodyEnd + 1);
    if (/\bhomedir\(\)/.test(declaration)) found.add(checkName);
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

  it("detects host-state checks regardless of declaration shape", () => {
    const synthetic = [
      "export function checkAlpha() { return homedir(); }",
      "export const checkBeta = (deps = { root: homedir() }) => deps;",
      'function checkGamma() { const p = join(homedir(), ".config"); return p; }',
      'export function checkDelta() { return "no host state"; }',
    ].join("\n\n");
    const found = checksReadingHomedirDirectly(synthetic);
    expect([...found].sort()).toEqual(["checkAlpha", "checkBeta", "checkGamma"]);
  });

  it("fails closed when no declaration anchor matches", () => {
    expect(checksReadingHomedirDirectly("const nothing = 1;").size).toBe(0);
  });
});
