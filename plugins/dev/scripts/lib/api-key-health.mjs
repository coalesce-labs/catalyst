// api-key-health.mjs — shared helper for Catalyst daemon API-key health (CTL-343).
//
// Pattern: resolve key with precedence (env → project config → global config → none),
// format actionable startup logs, probe the upstream for a 401 within seconds of startup,
// and parameterize endpoint/headers for optional gateway routing.
//
// Used by catalyst-broker today; intended for re-use by other daemons (Linear, GitHub,
// Anthropic) as they adopt the same pattern.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

const PREFIX_LEN = 12;
const DEFAULT_GROQ_ENDPOINT = "https://api.groq.com/openai/v1/chat/completions";
const DEFAULT_PROBE_TIMEOUT_MS = 5000;

// ─── Config loading ──────────────────────────────────────────────────────────

function readJsonOrNull(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function pathGet(obj, dotted) {
  if (obj == null) return undefined;
  const parts = dotted.split(".");
  let cur = obj;
  for (const p of parts) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = cur[p];
  }
  return cur;
}

function prefixOf(value) {
  if (typeof value !== "string" || value.length === 0) return null;
  return value.slice(0, PREFIX_LEN);
}

// ─── resolveApiKey ───────────────────────────────────────────────────────────

/**
 * Resolve an API key with env → project-config → global-config precedence.
 *
 * @param {object} opts
 * @param {string} opts.envName Env var name (e.g. "GROQ_API_KEY")
 * @param {string} opts.configKeyPath Dotted path inside the config JSON (e.g. "groq.apiKey")
 * @param {string} [opts.configPath] Global config file path. Defaults to ~/.config/catalyst/config.json
 * @param {string} [opts.projectConfigPath] Optional per-project config file path
 * @returns {{value: string, source: "env"|"project-config"|"config"|null, prefix: string|null}}
 */
export function resolveApiKey({ envName, configKeyPath, configPath, projectConfigPath }) {
  // 1. env
  const envValue = envName ? process.env[envName] : undefined;
  if (envValue && envValue.length > 0) {
    return { value: envValue, source: "env", prefix: prefixOf(envValue) };
  }

  // 2. project config
  if (projectConfigPath) {
    const projCfg = readJsonOrNull(projectConfigPath);
    const projValue = pathGet(projCfg, configKeyPath);
    if (typeof projValue === "string" && projValue.length > 0) {
      return { value: projValue, source: "project-config", prefix: prefixOf(projValue) };
    }
  }

  // 3. global config
  const globalPath = configPath ?? resolve(homedir(), ".config/catalyst/config.json");
  const globalCfg = readJsonOrNull(globalPath);
  const globalValue = pathGet(globalCfg, configKeyPath);
  if (typeof globalValue === "string" && globalValue.length > 0) {
    return { value: globalValue, source: "config", prefix: prefixOf(globalValue) };
  }

  // 4. none
  return { value: "", source: null, prefix: null };
}

// ─── Log formatters ──────────────────────────────────────────────────────────

/**
 * Multi-line warning string for a missing required key.
 * Caller passes the result to log.warn / process.stderr.
 */
export function formatMissingKeyWarning({ name, envName, configPath, configKeyPath, getUrl }) {
  return [
    `${name} missing — feature disabled.`,
    `  Set via:   ${configPath} → ${configKeyPath}`,
    `  Or env:    export ${envName}=...`,
    `  Get one:   ${getUrl}`,
  ].join("\n");
}

/**
 * Single-line info string for a successfully-loaded key.
 * Includes prefix + source for at-a-glance "is this the right key?" sanity check.
 */
export function formatLoadedKeyInfo({ name, source, prefix }) {
  return `${name} loaded — prefix=${prefix}... (source: ${source})`;
}

// ─── Endpoint derivation (gateway support) ───────────────────────────────────

/**
 * Build the effective Groq chat-completions endpoint plus any extra headers.
 *
 * @param {object} opts
 * @param {{enabled: boolean, baseUrl?: string, headers?: object}|null|undefined} opts.gateway
 * @returns {{url: string, extraHeaders: Record<string,string>, gatewayEnabled: boolean}}
 */
export function deriveGroqEndpoint({ gateway }) {
  if (!gateway || gateway.enabled !== true || typeof gateway.baseUrl !== "string") {
    return { url: DEFAULT_GROQ_ENDPOINT, extraHeaders: {}, gatewayEnabled: false };
  }
  const baseUrl = gateway.baseUrl.replace(/\/+$/, "");
  return {
    url: `${baseUrl}/chat/completions`,
    extraHeaders: gateway.headers && typeof gateway.headers === "object" ? { ...gateway.headers } : {},
    gatewayEnabled: true,
  };
}

// ─── probeGroq ───────────────────────────────────────────────────────────────

/**
 * Probe Groq with a single cheap `GET /v1/models` call to surface auth errors at startup.
 *
 * @param {object} opts
 * @param {string} opts.apiKey
 * @param {string} opts.endpoint Chat-completions endpoint URL (used to derive /v1/models)
 * @param {object} [opts.extraHeaders] Gateway headers to merge
 * @param {Function} [opts.fetch] Injectable fetch (for tests)
 * @param {number} [opts.timeoutMs]
 * @returns {Promise<{status: "ok"|"missing"|"unauthorized"|"error", modelCount?: number, error?: string}>}
 */
export async function probeGroq({
  apiKey,
  endpoint,
  extraHeaders = {},
  fetch: fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
}) {
  if (!apiKey || typeof apiKey !== "string" || apiKey.length === 0) {
    return { status: "missing" };
  }

  const modelsUrl = endpoint.replace(/\/chat\/completions\/?$/, "/models");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetchImpl(modelsUrl, {
      method: "GET",
      headers: {
        ...extraHeaders,
        Authorization: `Bearer ${apiKey}`,
      },
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (res.ok) {
      let modelCount = 0;
      try {
        const body = await res.json();
        modelCount = Array.isArray(body?.data) ? body.data.length : 0;
      } catch {
        // tolerate non-JSON success body
      }
      return { status: "ok", modelCount };
    }

    if (res.status === 401 || res.status === 403) {
      let bodyText = "";
      try { bodyText = await res.text(); } catch { /* ignore */ }
      return {
        status: "unauthorized",
        error: `HTTP ${res.status}${bodyText ? `: ${bodyText.slice(0, 200)}` : ""}`,
      };
    }

    let bodyText = "";
    try { bodyText = await res.text(); } catch { /* ignore */ }
    return {
      status: "error",
      error: `HTTP ${res.status}${bodyText ? `: ${bodyText.slice(0, 200)}` : ""}`,
    };
  } catch (err) {
    clearTimeout(timer);
    return { status: "error", error: err?.message ?? String(err) };
  }
}
