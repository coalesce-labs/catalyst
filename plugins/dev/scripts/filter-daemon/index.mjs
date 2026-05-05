#!/usr/bin/env node
// filter-daemon/index.mjs — Groq-powered semantic event router
// No build step, no npm dependencies. Requires Node.js >=21 or Bun.

import { readFileSync, appendFileSync, writeFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// --- Config ---
const CATALYST_DIR = process.env.CATALYST_DIR ?? `${homedir()}/catalyst`;
const GROQ_API_KEY = process.env.GROQ_API_KEY ?? '';
const GROQ_ENDPOINT = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODEL = process.env.FILTER_GROQ_MODEL ?? 'llama-3.1-8b-instant';
const DEBOUNCE_MS = parseInt(process.env.FILTER_DEBOUNCE_MS ?? '100', 10);
const HARD_CAP_MS = parseInt(process.env.FILTER_HARD_CAP_MS ?? '500', 10);
const MAX_BATCH_SIZE = parseInt(process.env.FILTER_BATCH_SIZE ?? '20', 10);
const POLL_MS = parseInt(process.env.FILTER_POLL_MS ?? '200', 10);
const LOOKBACK_LINES = 1000;

// --- Event log ---
function getEventLogPath() {
  const now = new Date();
  const ym = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  return resolve(CATALYST_DIR, 'events', `${ym}.jsonl`);
}

function appendEvent(event) {
  const logPath = getEventLogPath();
  mkdirSync(dirname(logPath), { recursive: true });
  appendFileSync(logPath, JSON.stringify({ ts: new Date().toISOString(), ...event }) + '\n');
}

// --- Interest table ---
const interests = new Map();

export function getInterests() {
  return interests;
}

export function clearInterests() {
  interests.clear();
}

export function handleRegister(event) {
  const d = event.detail ?? {};
  const id = d.interest_id ?? event.orchestrator ?? d.notify_event;
  if (!id) return;
  interests.set(id, {
    notify_event: d.notify_event ?? `filter.wake.${id}`,
    prompt: d.prompt ?? '',
    context: d.context ?? null,
    orchestrator: event.orchestrator ?? null,
    persistent: d.persistent === true,
  });
  console.log(`[filter] Registered: ${id} — "${d.prompt}" (persistent: ${d.persistent === true})`);
}

export function handleDeregister(event) {
  const id = (event.detail ?? {}).interest_id ?? event.orchestrator;
  if (!id) return;
  if (interests.delete(id)) {
    console.log(`[filter] Deregistered: ${id}`);
  }
}

export function handleOrchestratorTerminated(event) {
  const orchId = event.orchestrator;
  if (!orchId) return;
  for (const [id, reg] of interests) {
    if (reg.orchestrator === orchId) {
      interests.delete(id);
      console.log(`[filter] Auto-deregistered: ${id} (orchestrator ${orchId} terminated)`);
    }
  }
}

// --- Event classification ---

// Returns true if this event should be completely ignored (not batched, not dispatched)
export function shouldSkipEvent(event) {
  const name = event.event ?? '';
  // Self-loop prevention: skip all filter.* events the daemon produces or handles.
  // filter.register and filter.deregister are dispatched to handlers before this is called,
  // but skipping all filter.* here ensures no future filter.* variants reach Groq.
  return name.startsWith('filter.');
}

export function buildGroqPrompt(events) {
  if (!interests.size) return null;

  const interestLines = [...interests.entries()]
    .map(([id, reg]) => {
      const ctx = reg.context ? ` (context: ${JSON.stringify(reg.context)})` : '';
      return `- ${id}: "${reg.prompt}"${ctx}`;
    })
    .join('\n');

  const eventLines = events.map((e, i) => `${i + 1}. ${JSON.stringify(e)}`).join('\n');

  const systemPrompt =
    'You are a semantic event router for a developer automation system. ' +
    'Given a list of events and registered orchestrator interests, determine which events are relevant to which interests.\n\n' +
    'Respond with a JSON array of matches. Each element: ' +
    '{"interest_id":"...","reason":"one sentence why","event_indices":[1,2,...]}.\n' +
    'Only include interests with at least one matching event. Return [] if nothing matches.\n' +
    'Return ONLY the JSON array, no other text.';

  const userPrompt = `Events:\n${eventLines}\n\nRegistered interests:\n${interestLines}`;

  return { systemPrompt, userPrompt };
}

async function classifyBatch(events) {
  const prompts = buildGroqPrompt(events);
  if (!prompts) return;

  if (!GROQ_API_KEY) {
    console.error('[filter] GROQ_API_KEY not set — skipping batch of', events.length, 'events');
    return;
  }

  let responseText;
  try {
    const res = await fetch(GROQ_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${GROQ_API_KEY}`,
      },
      body: JSON.stringify({
        model: GROQ_MODEL,
        messages: [
          { role: 'system', content: prompts.systemPrompt },
          { role: 'user', content: prompts.userPrompt },
        ],
        temperature: 0,
        max_tokens: 512,
      }),
    });
    if (!res.ok) {
      console.error(`[filter] Groq error ${res.status}:`, await res.text());
      return;
    }
    const data = await res.json();
    responseText = data.choices?.[0]?.message?.content ?? '[]';
  } catch (err) {
    console.error('[filter] Groq fetch failed:', err.message);
    return;
  }

  let matches;
  try {
    matches = JSON.parse(responseText);
  } catch {
    console.error('[filter] Failed to parse Groq response:', responseText);
    return;
  }

  if (!Array.isArray(matches)) return;

  for (const match of matches) {
    const reg = interests.get(match.interest_id);
    if (!reg) continue;

    const sourceIds = (match.event_indices ?? [])
      .map((i) => events[i - 1]?.id)
      .filter(Boolean);

    appendEvent({
      event: reg.notify_event,
      orchestrator: reg.orchestrator ?? match.interest_id,
      worker: null,
      detail: {
        reason: match.reason,
        source_event_ids: sourceIds,
        interest_id: match.interest_id,
      },
    });
    console.log(`[filter] Wake: ${reg.notify_event} — ${match.reason}`);
    if (!reg.persistent) {
      interests.delete(match.interest_id);
      console.log(`[filter] Auto-deregistered (one-shot): ${match.interest_id}`);
    }
  }
}

// --- Debounce ---
let pendingBatch = [];
let debounceTimer = null;
let hardCapTimer = null;

async function flushBatch() {
  clearTimeout(debounceTimer);
  clearTimeout(hardCapTimer);
  debounceTimer = null;
  hardCapTimer = null;
  const batch = pendingBatch.splice(0);
  if (batch.length) await classifyBatch(batch);
}

function scheduleBatchFlush() {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(flushBatch, DEBOUNCE_MS);
  if (!hardCapTimer) {
    hardCapTimer = setTimeout(flushBatch, HARD_CAP_MS);
  }
}

function queueEvent(event) {
  pendingBatch.push(event);
  if (pendingBatch.length >= MAX_BATCH_SIZE) {
    flushBatch();
  } else {
    scheduleBatchFlush();
  }
}

// --- Event processing ---
function processEvent(event) {
  const name = event.event ?? '';

  if (name === 'filter.register') { handleRegister(event); return; }
  if (name === 'filter.deregister') { handleDeregister(event); return; }

  if (shouldSkipEvent(event)) return;
  if (name === 'heartbeat') return;

  // Implicitly deregister interests belonging to a terminated orchestrator.
  // The event is still queued for Groq so other orchestrators watching for this event can fire.
  if (name === 'orchestrator-completed' || name === 'orchestrator-failed') {
    handleOrchestratorTerminated(event);
  }

  if (!interests.size) return;
  queueEvent(event);
}

// --- Event log tailing ---
let lastLineCount = 0;
let lastLogPath = '';

function pollEventLog() {
  const logPath = getEventLogPath();

  if (logPath !== lastLogPath) {
    // Month rollover: snapshot current EOF, don't replay history
    lastLogPath = logPath;
    try {
      const content = readFileSync(logPath, 'utf8');
      lastLineCount = content.split('\n').filter((l) => l.trim()).length;
    } catch {
      lastLineCount = 0;
    }
    return;
  }

  let content;
  try {
    content = readFileSync(logPath, 'utf8');
  } catch {
    return;
  }

  const lines = content.split('\n').filter((l) => l.trim());
  if (lines.length <= lastLineCount) return;

  const newLines = lines.slice(lastLineCount);
  lastLineCount = lines.length;

  for (const line of newLines) {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    processEvent(event);
  }
}

function loadExistingRegistrations() {
  try {
    const content = readFileSync(lastLogPath, 'utf8');
    const lines = content.split('\n').filter((l) => l.trim());
    for (const line of lines.slice(-LOOKBACK_LINES)) {
      let event;
      try { event = JSON.parse(line); } catch { continue; }
      if (event.event === 'filter.register') handleRegister(event);
      if (event.event === 'filter.deregister') handleDeregister(event);
      if (event.event === 'orchestrator-completed' || event.event === 'orchestrator-failed') {
        handleOrchestratorTerminated(event);
      }
    }
    if (interests.size) {
      console.log(`[filter] Recovered ${interests.size} interest(s) from log`);
    }
  } catch {
    // No log file yet — fine
  }
}

// --- PID file ---
function parsePidFilePath() {
  const idx = process.argv.indexOf('--pid-file');
  return idx !== -1 ? process.argv[idx + 1] : null;
}

const PID_FILE_PATH = parsePidFilePath();

function writePidFile() {
  if (!PID_FILE_PATH) return;
  try {
    mkdirSync(dirname(PID_FILE_PATH), { recursive: true });
    writeFileSync(PID_FILE_PATH, `${process.pid}\n`);
  } catch (err) {
    console.error('[filter] Failed to write PID file:', err.message);
  }
}

function removePidFile() {
  if (!PID_FILE_PATH) return;
  try { unlinkSync(PID_FILE_PATH); } catch { /* already gone */ }
}

// --- Main ---
function main() {
  if (!GROQ_API_KEY) {
    console.warn('[filter] WARN: GROQ_API_KEY not set — semantic filtering disabled until set');
  }

  writePidFile();

  lastLogPath = getEventLogPath();
  loadExistingRegistrations();

  try {
    const content = readFileSync(lastLogPath, 'utf8');
    lastLineCount = content.split('\n').filter((l) => l.trim()).length;
    console.log(`[filter] Starting from line ${lastLineCount} of ${lastLogPath}`);
  } catch {
    console.log(`[filter] Starting (no log file yet at ${lastLogPath})`);
  }

  const pollId = setInterval(pollEventLog, POLL_MS);
  console.log(`[filter] catalyst-filter daemon started (pid ${process.pid})`);

  const shutdown = () => {
    clearInterval(pollId);
    clearTimeout(debounceTimer);
    clearTimeout(hardCapTimer);
    removePidFile();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

// Run as script only, not when imported as a module (enables unit testing)
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
