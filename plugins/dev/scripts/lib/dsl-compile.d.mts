// Type declarations for dsl-compile.mjs — kept in sync manually with the
// runtime module. The TUI consumes these; the bash CLI does not need types.

export class DslError extends Error {
  code: "invalid" | "unknown_field" | "type_mismatch" | "refused" | "groq_rejected";
  field?: string;
  suggestion?: string | null;
  constructor(message: string, opts?: { code?: DslError["code"]; field?: string; suggestion?: string | null });
}

export class GroqHttpError extends Error {
  status: number;
  body?: string;
  constructor(message: string, opts?: { status?: number; body?: string });
}

export class GroqResponseError extends Error {
  raw?: string;
  constructor(message: string, opts?: { raw?: string; cause?: unknown });
}

export interface DslLeaf {
  field: string;
  eq?: unknown; ne?: unknown;
  gt?: unknown; gte?: unknown; lt?: unknown; lte?: unknown;
  in?: unknown[];
  startsWith?: string; endsWith?: string; contains?: string;
  exists?: boolean;
}

export type DslNode =
  | { and: DslNode[] }
  | { or: DslNode[] }
  | { not: DslNode }
  | DslLeaf
  | Record<string, never>;

export interface Dsl {
  filter?: DslNode;
  sort?: { field: string; order?: "asc" | "desc" } | null;
  limit?: number | null;
  error?: string;
}

export interface CompiledDsl {
  jqPredicate: string;
  jqSort: string | null;
  jqLimit: string | null;
  jsPredicate: (event: unknown) => boolean;
}

export function validateField(
  path: string,
  opts?: { operator?: string; value?: unknown },
): { ok: true } | { ok: false; code?: string; error: string; suggestion: string | null };
export function getField(event: unknown, path: string): unknown;
export function evalJs(node: DslNode, event: unknown): boolean;
export function compileJq(node: DslNode): string;
export function compileSort(spec: { field: string; order?: "asc" | "desc" } | null | undefined): string | null;
export function compileLimit(n: number | null | undefined): string | null;
export function compile(dsl: Dsl): CompiledDsl;

export function readGroqApiKeyFromConfig(configPath?: string): string;
export function parseGroqResponse(raw: string): Dsl;
export function groqTranslate(
  nlText: string,
  opts: {
    apiKey: string;
    model?: string;
    fetchImpl?: typeof fetch;
    systemPrompt: string;
  },
): Promise<Dsl>;

export function rewriteTimePlaceholders(value: unknown): unknown;
export function rewriteNode<T>(node: T): T;

export const CANONICAL_FIELDS: ReadonlyArray<{ path: string; type: string; description: string }>;
export const FIELD_PATH_SET: ReadonlySet<string>;
export const TIME_FIELDS: ReadonlySet<string>;
export function suggestField(path: string, maxDistance?: number): string | null;
