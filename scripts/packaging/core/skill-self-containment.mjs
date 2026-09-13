// skill-self-containment.mjs — does a skill run from its own directory? (CTL-2306 Phase 2)
//
// checkSkillSelfContainment(skillDir) → { filesScanned, violations: [{ rule, file, line, detail }] }
//
// Rules, each with a positive control in skill-self-containment.test.mjs:
//   plugin-root-reference       SKILL.md, references/ or assets/ names ${CLAUDE_PLUGIN_ROOT} or a
//                               repo-relative plugins/<plugin>/{scripts,skills,references,templates,agents}/
//                               path — only Claude Code's plugin rail, or a cwd inside the catalyst
//                               checkout, resolves those.
//   skill-dir-path-missing      a `${CLAUDE_SKILL_DIR}/<path>` names a file the skill does not carry.
//   missing-skill-dir-preamble  the skill runs a `${CLAUDE_SKILL_DIR}` command but never tells a
//                               non-Claude harness how to set the variable (`skill_dir_unresolved`).
//   script-sibling-missing      a script under scripts/ reaches a file through a directory variable
//                               that holds the script's own location (`${SCRIPT_DIR}/lib/x.sh`,
//                               `$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/x.sh`) that the skill does
//                               not carry. Repo-root, $HOME and cwd paths are not the skill's concern.
//                               A JS module's relative imports (`from "./x.mjs"`, `import "./x.mjs"`,
//                               `import("./x.mjs")`, `require("./x.cjs")`,
//                               `new URL("./x.sh", import.meta.url)`, `join(dirname(fileURLToPath(
//                               import.meta.url)), "x.json")`) must resolve inside the skill too.
//                               A line marked `# self-containment: optional` is a reference the script
//                               already tolerates being absent.
//
// Static and deliberately conservative: it reads text, it does not execute anything.
// skill-dir-isolation.test.sh is the half that runs the scripts. Operates only on the
// directory it is given — no plugin path is hard-coded here (the packaging seam).

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, normalize, relative, sep } from "node:path";

const PROSE_DIRS = ["references", "assets"];
// ${CLAUDE_PLUGIN_ROOT}, or a repo-relative path into the plugin tree (resolves only inside the catalyst checkout).
const PLUGIN_ROOT_PATTERN = /\$\{?CLAUDE_PLUGIN_ROOT\}?|plugins\/[a-z0-9-]+\/(?:scripts|skills|references|templates|agents)\//;
const SKILL_DIR_PATH_PATTERN = /\$\{CLAUDE_SKILL_DIR\}\/([A-Za-z0-9_./-]+)/g;
const PREAMBLE_MARKER = "skill_dir_unresolved";
const OPTIONAL_MARKER = "# self-containment: optional";
const FILE_REF = String.raw`((?:\.\.\/)*[A-Za-z0-9_.-][A-Za-z0-9_./-]*\.(?:sh|mjs|cjs|js|json|py))\b`;
const ASSIGNMENT = /^\s*(?:local\s+|export\s+|readonly\s+|declare\s+(?:-\w+\s+)?)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/;
// The script's own file: ${BASH_SOURCE[0]}, $0, zsh's ${(%):-%x}.
const SELF_FILE_EXPANSION = /BASH_SOURCE|\$\{?0\b|%x/;
// A JS module's relative dependency: a static or dynamic import, or a file located from import.meta.url.
// Covers `from "./x"`, a side-effect `import "./x"`, `import("./x")`, `require("./x")` and
// `new URL("./x", import.meta.url)`.
const JS_RELATIVE_REF = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*|new URL\(\s*)["'](\.{1,2}\/[^"']+)["']/g;
// …or a file joined onto the module's own directory: join(dirname(fileURLToPath(import.meta.url)), "x").
const JS_DIR_JOIN_REF = /(?:dirname\(\s*fileURLToPath\(\s*import\.meta\.url\s*\)\s*\)|import\.meta\.dirname)\s*,\s*["']([^"']+)["']/g;

// scriptLocationVars(lines) → the variables that hold the script's own directory (or a directory
// under it), learned from the script's assignments: SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")"
// && pwd)", LIB_DIR="${SCRIPT_DIR}/lib", and a self-file variable passed to dirname. Anything else —
// a repo root, $HOME, the cwd — is not the skill's business.
function scriptLocationVars(lines) {
  const selfFileVars = new Set();
  const dirVars = new Set();
  let grew = true;
  while (grew) {
    grew = false;
    for (const text of lines) {
      const m = text.match(ASSIGNMENT);
      if (!m) continue;
      const [, name, rhs] = m;
      const mentionsSelfFile = SELF_FILE_EXPANSION.test(rhs) || [...selfFileVars].some((v) => new RegExp(String.raw`\$\{?${v}\b`).test(rhs));
      const namesAFile = /\.[a-z]+"?$/.test(rhs.trim());
      const isDirOfSelf = /dirname/.test(rhs) && mentionsSelfFile;
      const fromDirVar = [...dirVars].some((v) => new RegExp(String.raw`^"?\$\{?${v}\}?(?:/[A-Za-z0-9_./-]*)?"?$`).test(rhs.trim()));
      if (!namesAFile && (isDirOfSelf || fromDirVar)) {
        if (!dirVars.has(name)) {
          dirVars.add(name);
          grew = true;
        }
      } else if (SELF_FILE_EXPANSION.test(rhs) && !/dirname/.test(rhs) && !selfFileVars.has(name)) {
        selfFileVars.add(name);
        grew = true;
      }
    }
  }
  return { selfFileVars, dirVars };
}

function scriptRelativeRefs(text, { selfFileVars, dirVars }) {
  const refs = [];
  for (const v of dirVars) {
    for (const m of text.matchAll(new RegExp(String.raw`\$\{?${v}\}?"?\/${FILE_REF}`, "g"))) refs.push(m[1]);
  }
  // Inline: $(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/x.sh, or dirname of a self-file variable.
  const selfFile = [String.raw`BASH_SOURCE`, String.raw`\$\{?0\b`, "%x", ...[...selfFileVars].map((v) => String.raw`\$\{?${v}\b`)].join("|");
  for (const m of text.matchAll(new RegExp(String.raw`dirname[^)]*(?:${selfFile})[^)]*\).*?pwd\)"?\/${FILE_REF}`, "g"))) refs.push(m[1]);
  return refs;
}

function listFiles(absDir) {
  if (!existsSync(absDir)) return [];
  const out = [];
  for (const entry of readdirSync(absDir)) {
    const full = join(absDir, entry);
    if (statSync(full).isDirectory()) out.push(...listFiles(full));
    else out.push(full);
  }
  return out;
}

function rel(skillDir, abs) {
  return relative(skillDir, abs).split(sep).join("/");
}

export function checkSkillSelfContainment(skillDir) {
  const violations = [];
  let filesScanned = 0;

  const proseFiles = [join(skillDir, "SKILL.md"), ...PROSE_DIRS.flatMap((d) => listFiles(join(skillDir, d)))].filter(
    (f) => existsSync(f) && f.endsWith(".md")
  );
  let usesSkillDir = false;
  let hasPreamble = false;

  for (const file of proseFiles) {
    filesScanned += 1;
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((text, idx) => {
      if (PLUGIN_ROOT_PATTERN.test(text)) {
        violations.push({ rule: "plugin-root-reference", file: rel(skillDir, file), line: idx + 1, detail: text.trim() });
      }
      if (text.includes(PREAMBLE_MARKER)) hasPreamble = true;
      for (const match of text.matchAll(SKILL_DIR_PATH_PATTERN)) {
        usesSkillDir = true;
        const target = match[1].replace(/[.,;:]+$/, "");
        if (!existsSync(join(skillDir, target))) {
          violations.push({ rule: "skill-dir-path-missing", file: rel(skillDir, file), line: idx + 1, detail: target });
        }
      }
    });
  }
  if (usesSkillDir && !hasPreamble) {
    violations.push({
      rule: "missing-skill-dir-preamble",
      file: "SKILL.md",
      line: 0,
      detail: `commands use \${CLAUDE_SKILL_DIR} but no file tells another harness how to set it (${PREAMBLE_MARKER})`,
    });
  }

  const scriptsRoot = join(skillDir, "scripts");
  for (const file of listFiles(scriptsRoot)) {
    filesScanned += 1;
    const contents = readFileSync(file, "utf8");
    if (!/\.(sh|mjs|cjs|js|py)$/.test(file) && !contents.startsWith("#!")) continue;
    const lines = contents.split("\n");
    if (/\.(mjs|cjs|js)$/.test(file)) {
      lines.forEach((text, idx) => {
        // JSDoc `@param {import("./x.d.mts")}` and commented-out code are not runtime dependencies.
        if (text.includes(OPTIONAL_MARKER) || /^\s*(\/\/|\*|\/\*)/.test(text)) return;
        for (const match of [...text.matchAll(JS_RELATIVE_REF), ...text.matchAll(JS_DIR_JOIN_REF)]) {
          const target = normalize(join(dirname(file), match[1]));
          if (relative(skillDir, target).startsWith("..") || !existsSync(target)) {
            violations.push({ rule: "script-sibling-missing", file: rel(skillDir, file), line: idx + 1, detail: match[1] });
          }
        }
      });
      continue;
    }
    const vars = scriptLocationVars(lines);
    lines.forEach((text, idx) => {
      if (text.includes(OPTIONAL_MARKER) || /^\s*#/.test(text)) return;
      for (const target of scriptRelativeRefs(text, vars)) {
        const candidates = [normalize(join(dirname(file), target)), normalize(join(scriptsRoot, target))];
        const inside = candidates.filter((c) => !relative(skillDir, c).startsWith(".."));
        if (!inside.some((c) => existsSync(c))) {
          violations.push({ rule: "script-sibling-missing", file: rel(skillDir, file), line: idx + 1, detail: target });
        }
      }
    });
  }

  return { filesScanned, violations };
}
