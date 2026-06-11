#!/usr/bin/env bun
// Regenerates docs/otel-attribute-audit.md from lib/otel-attribute-audit.ts.
// Usage: bun run audit:gen
// Or:    bun run bin/gen-attribute-audit.ts

import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";

import { AUDIT_MANIFEST } from "../lib/otel-attribute-audit.ts";
import { renderAuditMarkdown } from "../lib/render-attribute-audit.ts";

const outPath = join(import.meta.dir, "../docs/otel-attribute-audit.md");
mkdirSync(join(import.meta.dir, "../docs"), { recursive: true });
writeFileSync(outPath, renderAuditMarkdown(AUDIT_MANIFEST), "utf8");
console.info(`Generated: ${outPath}`);
