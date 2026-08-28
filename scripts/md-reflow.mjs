#!/usr/bin/env node
// md-reflow.mjs — CTL-2253: join hard-wrapped markdown prose back into single physical lines.
//
// Structure is safe by construction, not by after-the-fact auditing: the scanner only ever
// accumulates lines that are already lazy-continuation lines of one paragraph (every structural
// opener — heading, table row, blockquote, list marker, thematic break, fence, blank line —
// flushes the run and is emitted untouched). Joining lines *within* one paragraph yields the
// same paragraph, so no Markdown parser is needed to prove the join preserves block structure.
//
// The join preserves the FIRST line's leading whitespace and applies it to the joined result.
// Both prior reflow passes (catalyst PR #4036, catalyst-cloud CTC-1009) dedented joined lines to
// column 1 instead — flattening an indented list-item continuation paragraph to column 0
// structurally closes its parent list item and detaches every sibling that follows. Preserving
// the first line's indentation makes that regression unconstructible.
//
// Six hazard classes are quarantined rather than joined — each verified live in plugins/dev by
// direct inspection (see the CTL-2253 plan), not inferred:
//   kv-metadata          bare `Key: value` lines directly under an H1 (e.g. `Trigger:`/`Target:`)
//   adjacent-bold-lead   two adjacent lines each opening `**` (independent bold-lead statements)
//   html-comment         a multi-line `<!-- ... -->` block (its internal newlines carry no
//                        rendering meaning, but collapsing them is a deliberate hand-edit, not
//                        a mechanical one)
//   hard-break           a non-final line ends with Markdown's explicit hard-break marker
//                        (two-or-more trailing spaces, or a trailing backslash) — trimming and
//                        joining would silently discard the author's forced line break
//   indented-code        every line in the run shares a >=4-column indent, CommonMark's signal
//                        for an indented code block; joining would collapse it into one line
//   mixed-indent         a block whose lines don't all share the same leading whitespace,
//                        i.e. something structurally irregular is going on
//
// CLI:
//   node scripts/md-reflow.mjs --check <paths...>   report only, exit non-zero if any file would change
//   node scripts/md-reflow.mjs <paths...>            rewrite in place, refusing per-file on content drift

import { readFileSync, writeFileSync } from "node:fs";

const BLANK_RE = /^\s*$/;
const HEADING_RE = /^\s{0,3}#{1,6}(\s|$)/;
const TABLE_RE = /^\s*\|/;
const QUOTE_RE = /^\s*>/;
const LIST_MARKER_RE = /^\s*([-*+]|\d+[.)])\s+/;
const THEMATIC_BREAK_RE =
	/^\s{0,3}(?:-[ \t]*){3,}$|^\s{0,3}(?:\*[ \t]*){3,}$|^\s{0,3}(?:_[ \t]*){3,}$/;
// Setext H1 underline (one or more `=`) — the `=` counterpart to THEMATIC_BREAK_RE's `-` handling.
const SETEXT_H1_RE = /^\s{0,3}=+\s*$/;
// A GFM table delimiter row that omits its outer pipes, e.g. `--- | ---`. Requires at least two
// cells (one interior `|`) so a bare `---`/`===` line is left to THEMATIC_BREAK_RE/SETEXT_H1_RE.
const TABLE_DELIMITER_RE = /^\s*:?-+:?(?:\s*\|\s*:?-+:?)+\s*$/;
// A link-reference-definition opener, e.g. `[label]: https://example.com "title"`. Adjacent
// definitions with no blank line between them are otherwise two non-structural lines that
// accumulate into one run; joining them merges two distinct `[label]: dest` block-level
// constructs onto a single line and breaks every reference using either label.
const LINK_REF_DEF_RE = /^\s{0,3}\[[^\]]+\]:/;
const FENCE_OPEN_RE = /^(\s{0,3})(`{3,}|~{3,})/;
const FENCE_CLOSE_RE = /^\s{0,3}(`+|~+)\s*$/;
const FRONTMATTER_FENCE_RE = /^---\s*$/;
const KV_METADATA_RE = /^[A-Za-z][\w -]*:\s/;

const MIN_WRAP_LEN = 70;
const INDENTED_CODE_WIDTH = 4;

function isStructural(line) {
	return (
		BLANK_RE.test(line) ||
		HEADING_RE.test(line) ||
		TABLE_RE.test(line) ||
		TABLE_DELIMITER_RE.test(line) ||
		QUOTE_RE.test(line) ||
		LIST_MARKER_RE.test(line) ||
		THEMATIC_BREAK_RE.test(line) ||
		SETEXT_H1_RE.test(line) ||
		LINK_REF_DEF_RE.test(line)
	);
}

function leadingWhitespace(line) {
	const m = line.match(/^[ \t]*/);
	return m ? m[0] : "";
}

// Expands leading tabs to 4-column stops so a tab-indented code block is recognized the same as
// a space-indented one.
function indentWidth(line) {
	const ws = leadingWhitespace(line);
	let width = 0;
	for (const ch of ws) {
		width += ch === "\t" ? 4 - (width % 4) : 1;
	}
	return width;
}

// Walks the file structurally, splitting it into passthrough lines and candidate "runs" — 1+
// consecutive non-blank, non-structural lines, outside frontmatter/fences. A run is emitted
// regardless of whether it later qualifies for joining; qualification (length >= 2, all-but-last
// >= MIN_WRAP_LEN chars) is decided by the caller so scanFile and reflowFile share one walk.
function scanSegments(text) {
	const hadTrailingNewline = text.endsWith("\n");
	const lines = text.split("\n");
	if (hadTrailingNewline) lines.pop();

	const segments = [];
	let idx = 0;

	if (lines[0] !== undefined && FRONTMATTER_FENCE_RE.test(lines[0])) {
		segments.push({ type: "line", raw: lines[0] });
		idx = 1;
		while (idx < lines.length && !FRONTMATTER_FENCE_RE.test(lines[idx])) {
			segments.push({ type: "line", raw: lines[idx] });
			idx++;
		}
		if (idx < lines.length) {
			segments.push({ type: "line", raw: lines[idx] });
			idx++;
		}
	}

	let run = [];
	const flush = () => {
		if (run.length > 0) {
			segments.push({ type: "run", lines: run });
			run = [];
		}
	};

	let inFence = false;
	let fenceChar = "";
	let fenceLen = 0;

	for (; idx < lines.length; idx++) {
		const line = lines[idx];

		if (inFence) {
			segments.push({ type: "line", raw: line });
			const closeMatch = line.match(FENCE_CLOSE_RE);
			if (closeMatch && closeMatch[1][0] === fenceChar && closeMatch[1].length >= fenceLen) {
				inFence = false;
			}
			continue;
		}

		const fenceOpen = line.match(FENCE_OPEN_RE);
		if (fenceOpen) {
			flush();
			segments.push({ type: "line", raw: line });
			inFence = true;
			fenceChar = fenceOpen[2][0];
			fenceLen = fenceOpen[2].length;
			continue;
		}

		if (isStructural(line)) {
			flush();
			segments.push({ type: "line", raw: line });
			continue;
		}

		run.push(line);
	}
	flush();

	return { segments, hadTrailingNewline };
}

function qualifies(lines) {
	return lines.length >= 2 && lines.slice(0, -1).every((l) => l.length >= MIN_WRAP_LEN);
}

// Precedence: kv-metadata, adjacent-bold-lead, html-comment, hard-break, indented-code,
// mixed-indent, null.
function classifyHazard(lines) {
	const trimmed = lines.map((l) => l.trim());

	if (trimmed.every((l) => KV_METADATA_RE.test(l))) return "kv-metadata";

	for (let i = 0; i < trimmed.length - 1; i++) {
		if (trimmed[i].startsWith("**") && trimmed[i + 1].startsWith("**")) {
			return "adjacent-bold-lead";
		}
	}

	if (trimmed[0].startsWith("<!--")) return "html-comment";

	for (let i = 0; i < lines.length - 1; i++) {
		if (/ {2,}$/.test(lines[i]) || /\\$/.test(lines[i])) return "hard-break";
	}

	if (lines.every((l) => indentWidth(l) >= INDENTED_CODE_WIDTH)) return "indented-code";

	const indents = lines.map(leadingWhitespace);
	if (!indents.every((w) => w === indents[0])) return "mixed-indent";

	return null;
}

// scanFile(text) → Block[] — every qualifying run, classified. Non-qualifying runs (single lines,
// or runs whose non-final lines are under the wrap threshold) are not reported; nothing would
// change about them.
function scanFile(text) {
	const { segments } = scanSegments(text);
	const blocks = [];
	for (const seg of segments) {
		if (seg.type !== "run") continue;
		if (!qualifies(seg.lines)) continue;
		blocks.push({ lines: seg.lines, hazard: classifyHazard(seg.lines) });
	}
	return blocks;
}

function assertContentIdentical(before, after) {
	const normalize = (s) => s.replace(/\s+/g, " ").trim();
	if (normalize(before) !== normalize(after)) {
		throw new Error("md-reflow: content drift detected — refusing to write");
	}
}

// reflowFile(text) → { text, joined, quarantined } — joins qualifying non-hazard runs with a
// single space, applying the first line's leading whitespace to the result. Throws (via
// assertContentIdentical) rather than returning a corrupted result on any content drift.
function reflowFile(text) {
	const { segments, hadTrailingNewline } = scanSegments(text);
	let joined = 0;
	let quarantined = 0;
	const outLines = [];

	for (const seg of segments) {
		if (seg.type === "line") {
			outLines.push(seg.raw);
			continue;
		}

		if (!qualifies(seg.lines)) {
			outLines.push(...seg.lines);
			continue;
		}

		const hazard = classifyHazard(seg.lines);
		if (hazard) {
			outLines.push(...seg.lines);
			quarantined++;
			continue;
		}

		const indent = leadingWhitespace(seg.lines[0]);
		const content = seg.lines.map((l) => l.trim()).join(" ");
		outLines.push(indent + content);
		joined++;
	}

	const newText = outLines.join("\n") + (hadTrailingNewline ? "\n" : "");
	assertContentIdentical(text, newText);
	return { text: newText, joined, quarantined };
}

export { scanFile, classifyHazard, reflowFile, assertContentIdentical };

function main() {
	const args = process.argv.slice(2);
	const checkMode = args.includes("--check");
	const paths = args.filter((a) => a !== "--check");

	if (paths.length === 0) {
		console.error("usage: md-reflow.mjs [--check] <paths...>");
		process.exit(2);
	}

	let filesWithBlocks = 0;
	let totalBlocks = 0;
	let totalHazards = 0;
	let wouldChange = false;
	let refused = false;

	for (const p of paths) {
		const text = readFileSync(p, "utf8");
		const blocks = scanFile(text);
		const joinable = blocks.filter((b) => !b.hazard);
		const hazards = blocks.filter((b) => b.hazard);

		if (blocks.length > 0) filesWithBlocks++;
		totalBlocks += blocks.length;
		totalHazards += hazards.length;

		for (const b of hazards) {
			console.log(`${p}: hazard=${b.hazard}`);
		}

		if (joinable.length === 0) continue;

		if (checkMode) {
			wouldChange = true;
			console.log(`${p}: ${joinable.length} joinable, ${hazards.length} hazard(s)`);
			continue;
		}

		try {
			const { text: newText, joined, quarantined } = reflowFile(text);
			writeFileSync(p, newText);
			console.log(`${p}: rewrote (${joined} joined, ${quarantined} quarantined)`);
		} catch (err) {
			refused = true;
			console.error(`${p}: REFUSED — ${err.message}`);
		}
	}

	console.log(
		`\n${filesWithBlocks}/${paths.length} files, ${totalBlocks} blocks, ${totalHazards} hazards`,
	);

	if (refused) process.exit(1);
	if (checkMode && wouldChange) process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
	main();
}
