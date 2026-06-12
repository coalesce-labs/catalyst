// beliefs/compile-rules.mjs — CTL-1063 Phase 1: CLI driver for the Datalog compiler.
// Reads beliefs/rules.dl, compiles, writes beliefs/rules.generated.mjs.
//
// Usage: cd plugins/dev/scripts/execution-core && bun beliefs/compile-rules.mjs

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { compile } from "./compiler/index.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

const dlPath = resolve(__dirname, "rules.dl");
const outPath = resolve(__dirname, "rules.generated.mjs");

const source = readFileSync(dlPath, "utf8");
// CTL-1063 Phase 4: content hash of the rules source, threaded through to
// tick rows so disagreements can be correlated to the rules version in play.
const RULES_SHA = createHash("sha256").update(source).digest("hex").slice(0, 16);
const result = compile(source);
// CTL-1063 Phase 5: pass source to emit() so RULE_MANIFEST can be built.
const moduleText = result.emit(RULES_SHA, source);

writeFileSync(outPath, moduleText, "utf8");
console.log(`[compile-rules] wrote ${outPath}`);
console.log(`[compile-rules] rules_sha: ${RULES_SHA}`);
console.log(`[compile-rules] compiled rules: ${[...result.rules.keys()].join(", ")}`);
