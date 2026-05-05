#!/usr/bin/env node
// catalyst-filter — semantic event routing daemon
//
// Tails ~/catalyst/events/YYYY-MM.jsonl, batches incoming events, calls Groq
// to classify relevance against registered orchestrator interests, and emits
// filter.wake.{id} events back into the log for orchestrators to wait-for.

import fs from 'fs';
import path from 'path';
import os from 'os';

// ── Constants ─────────────────────────────────────────────────────────────────

const CONFIG_PATH = path.join(os.homedir(), '.config/catalyst/config.json');
const EVENTS_DIR = path.join(
  process.env.CATALYST_DIR || path.join(os.homedir(), 'catalyst'),
  'events'
);
const STATE_DIR = path.join(os.homedir(), '.local/share/catalyst');
const PID_FILE = path.join(STATE_DIR, 'filter-daemon.pid');

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODEL = 'llama-3.1-8b-instant';

// Batch fires when ANY of these thresholds hit
const DEBOUNCE_MS = 200;   // idle window — resets on each new event
const HARD_CAP_MS = 500;   // max wait regardless of continued arrivals
const BATCH_MAX = 10;      // size cap — fires immediately

// ── Config ────────────────────────────────────────────────────────────────────

function loadConfig() {
  const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  const apiKey = raw.groq?.apiKey;
  if (!apiKey || apiKey.startsWith('[')) {
    throw new Error('groq.apiKey not configured in ~/.config/catalyst/config.json');
  }
  return { apiKey };
}

// ── Event log path (monthly rotation) ─────────────────────────────────────────

function eventsFilePath(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  return path.join(EVENTS_DIR, `${y}-${m}.jsonl`);
}

// ── Routing table ─────────────────────────────────────────────────────────────
// interest_id → { notify_event, prompt, context }

const routingTable = new Map();

function handleRegister(event) {
  const detail = event.detail || {};
  const id = event.orchestrator || detail.interest_id;
  const { notify_event, prompt, context } = detail;
  if (!id || !prompt) {
    log(`WARN: filter.register missing id or prompt — skipping`);
    return;
  }
  routingTable.set(id, {
    notify_event: notify_event || `filter.wake.${id}`,
    prompt,
    context: context || {},
  });
  log(`Registered: ${id} (${routingTable.size} active)`);
}

function handleDeregister(event) {
  const id = event.orchestrator || event.detail?.interest_id;
  if (!id) return;
  routingTable.delete(id);
  log(`Deregistered: ${id} (${routingTable.size} remaining)`);
}

// ── Batching ──────────────────────────────────────────────────────────────────

let batch = [];
let debounceTimer = null;
let hardCapTimer = null;

function addToBatch(event) {
  batch.push(event);
  if (batch.length >= BATCH_MAX) {
    flush();
    return;
  }
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(flush, DEBOUNCE_MS);
  if (!hardCapTimer) {
    hardCapTimer = setTimeout(flush, HARD_CAP_MS);
  }
}

function flush() {
  clearTimeout(debounceTimer);
  clearTimeout(hardCapTimer);
  debounceTimer = null;
  hardCapTimer = null;
  if (batch.length === 0 || routingTable.size === 0) {
    batch = [];
    return;
  }
  const events = batch;
  batch = [];
  processBatch(events).catch(err => log(`ERROR batch: ${err.message}`));
}

// ── Groq ──────────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are an event router for a multi-agent CI/CD orchestration system.

You receive batches of structured JSON events from an event log and a list of named interests from active orchestrators. Each interest has a natural language description of what that orchestrator cares about, plus optional context (PR numbers, ticket IDs, branch names).

For each interest, identify which events from the batch are relevant. Use both the description AND context when matching — a "CI failed" interest with context pr_numbers:[409] should only match CI events involving PR 409.

Return ONLY valid JSON in this exact format:
{"matches":[{"interest_id":"<id>","event_ids":["<id_or_ts>"],"reason":"<one sentence>"}]}

Rules:
- Use the event's "id" field as identifier when present, otherwise use its "ts" field
- Only include confident matches — prefer false negatives over false positives
- Return {"matches":[]} if nothing clearly matches
- Output nothing outside the JSON object`;

async function callGroq(apiKey, events, interests) {
  const eventsText = events.map(e => JSON.stringify(e)).join('\n');
  const interestsText = interests
    .map(([id, info]) => {
      const ctx = Object.keys(info.context).length
        ? ` [context: ${JSON.stringify(info.context)}]`
        : '';
      return `${id}: ${info.prompt}${ctx}`;
    })
    .join('\n');

  const userContent =
    `EVENTS:\n${eventsText}\n\nINTERESTS:\n${interestsText}\n\nWhich events match which interests?`;

  const res = await fetch(GROQ_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: GROQ_MODEL,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userContent },
      ],
      temperature: 0,
      max_tokens: 512,
      response_format: { type: 'json_object' },
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Groq ${res.status}: ${body.slice(0, 200)}`);
  }

  const data = await res.json();
  return JSON.parse(data.choices[0].message.content);
}

async function processBatch(events) {
  const interests = [...routingTable.entries()];
  log(`Batch: ${events.length} events × ${interests.length} interests`);

  let result;
  try {
    result = await callGroq(config.apiKey, events, interests);
  } catch (err) {
    log(`ERROR Groq: ${err.message}`);
    return;
  }

  const matches = result.matches || [];
  if (matches.length === 0) {
    log(`No matches`);
    return;
  }

  for (const match of matches) {
    const info = routingTable.get(match.interest_id);
    if (!info) continue;
    emitWake(info.notify_event, match);
    log(`WAKE ${info.notify_event}: ${match.reason}`);
  }
}

// ── Event emission ────────────────────────────────────────────────────────────

function emitWake(notifyEvent, match) {
  const event = {
    ts: new Date().toISOString(),
    event: notifyEvent,
    orchestrator: match.interest_id,
    worker: null,
    detail: {
      reason: match.reason,
      source_event_ids: match.event_ids,
      interest_id: match.interest_id,
    },
  };
  const line = JSON.stringify(event) + '\n';
  // Pause the watcher position update so we skip our own write on next read
  skipBytes += Buffer.byteLength(line, 'utf8');
  fs.appendFileSync(eventsFilePath(), line, 'utf8');
}

// ── File tailing ──────────────────────────────────────────────────────────────

let filePosition = 0;
let skipBytes = 0;       // bytes written by us — skip on next read to avoid self-loop
let currentFilePath = null;

function fileSize(filePath) {
  try { return fs.statSync(filePath).size; } catch { return 0; }
}

function readNewContent(filePath) {
  const size = fileSize(filePath);
  let readFrom = filePosition;

  // Skip bytes we wrote ourselves
  if (skipBytes > 0) {
    readFrom += skipBytes;
    skipBytes = 0;
    filePosition = readFrom;
  }

  if (size <= readFrom) return;

  const len = size - readFrom;
  const buf = Buffer.alloc(len);
  const fd = fs.openSync(filePath, 'r');
  fs.readSync(fd, buf, 0, len, readFrom);
  fs.closeSync(fd);
  filePosition = size;

  const lines = buf.toString('utf8').split('\n');
  for (const line of lines) {
    if (!line.trim()) continue;
    let event;
    try { event = JSON.parse(line); } catch { continue; }

    const type = event.event || '';
    if (type === 'filter.register') { handleRegister(event); continue; }
    if (type === 'filter.deregister') { handleDeregister(event); continue; }
    if (type.startsWith('filter.')) continue; // skip our own wake events

    addToBatch(event);
  }
}

function startWatching(filePath) {
  if (currentFilePath) fs.unwatchFile(currentFilePath);
  currentFilePath = filePath;
  filePosition = fileSize(filePath); // seek to EOF — don't replay history
  skipBytes = 0;
  log(`Watching ${filePath} from byte ${filePosition}`);

  fs.watchFile(filePath, { interval: 100, persistent: true }, () => {
    // Monthly rotation check
    const expected = eventsFilePath();
    if (expected !== currentFilePath) {
      log(`Month rotated → ${expected}`);
      startWatching(expected);
      return;
    }
    readNewContent(filePath);
  });
}

// ── Logging ───────────────────────────────────────────────────────────────────

function log(msg) {
  process.stdout.write(`[${new Date().toISOString()}] ${msg}\n`);
}

// ── Main ──────────────────────────────────────────────────────────────────────

let config;

function main() {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.mkdirSync(EVENTS_DIR, { recursive: true });

  config = loadConfig();
  log(`starting (model: ${GROQ_MODEL}, debounce: ${DEBOUNCE_MS}ms, cap: ${HARD_CAP_MS}ms)`);

  fs.writeFileSync(PID_FILE, String(process.pid), 'utf8');

  const eventsFile = eventsFilePath();
  // Create file if it doesn't exist yet
  if (!fs.existsSync(eventsFile)) fs.writeFileSync(eventsFile, '', 'utf8');
  startWatching(eventsFile);

  function shutdown(signal) {
    log(`${signal} — shutting down`);
    flush();
    if (currentFilePath) fs.unwatchFile(currentFilePath);
    try { fs.unlinkSync(PID_FILE); } catch {}
    process.exit(0);
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  log(`ready — ${routingTable.size} interests loaded`);
}

main();
