// lib/events.js — the plugin's own activity log.
//
// Why this exists: on 2026-10-16 the panel said a catalogue source was
// unavailable. The reason — a spent anonymous GitHub search window, shared with
// every other process on the same IP — lived inside a plugin process that had
// already exited, so the only way to find it was to re-derive it by hand. The
// host's own logs hold startup lines; a tool call is recorded in a session
// container this plugin cannot read. What this plugin *can* keep honestly is a
// record of its own actions: which source was fetched with what status, which
// walk stopped for which reason, which install or update was attempted.
//
// One JSON object per line, appended, trimmed from the front. Direct reads and
// writes reject on storage errors. Event-stream callers report failures through
// the host logger and the file's persistence state without disrupting tool results.

import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { redactSecrets } from './install-diagnosis.js';

/** Retained window: enough for a session's worth of actions, small enough to read on demand. */
export const EVENT_LIMIT_LINES = 400;
export const EVENT_LIMIT_BYTES = 256 * 1024;
/** One field longer than this is truncated; a stack in one field must not own the file. */
const MAX_FIELD_CHARS = 600;
const MAX_ARRAY_ITEMS = 20;

/**
 * The process-wide sink. `lib/*` emits without threading a callback through
 * every `browseCatalog`/`crawl*` call: the host installs the writer once in
 * `apply()`, and until then `emit()` is a no-op (which is what keeps the library
 * usable from a test or a one-off script with no data directory).
 */
let sink = null;
let reportSinkError = error => console.error('[overall-mcp] 操作日志失败：' + redactSecrets(String(error?.message ?? error)));

export function setEventSink(fn, { onError } = {}) {
  sink = typeof fn === 'function' ? fn : null;
  reportSinkError = onError ?? (error => console.error('[overall-mcp] 操作日志失败：' + redactSecrets(String(error?.message ?? error))));
}

/** Record one event. Never throws, never awaits, never blocks the caller. */
export function emit(event) {
  if (!sink || !event) return;
  try {
    const result = sink(event);
    if (result?.then) result.catch(reportSinkError);
  } catch (error) {
    reportSinkError(error);
  }
}

/**
 * Writes are serialized per file. Two events appended concurrently would
 * otherwise interleave mid-line and produce a file whose lines do not parse —
 * precisely the "damaged" reading this log exists to avoid.
 */
const chains = new Map();
const persistence = new Map();
const pendingEvents = new Map();

export function eventPersistence(file) {
  return { ...(persistence.get(file) ?? { ok: true, error: null, at: null }), pending: pendingEvents.get(file)?.lines.length ?? 0 };
}

export async function flushEvents(file) {
  let tail;
  do { tail = chains.get(file); if (tail) await tail; } while (chains.get(file) && chains.get(file) !== tail);
  if (pendingEvents.has(file)) await enqueue(file, () => persistPendingEvents(file));
  const state = eventPersistence(file);
  if (!state.ok) throw new Error(state.error);
}

async function persistPendingEvents(file) {
  const pending = pendingEvents.get(file);
  if (!pending) return null;
  const existing = (await readText(file)).split('\n').filter(line => line.trim() !== '');
  const { lines, dropped } = retained(existing, pending.lines, pending.limits);
  await writeLines(file, lines);
  pendingEvents.delete(file);
  return { written: pending.lines.length, lines: lines.length, dropped };
}

function enqueue(file, task) {
  const previous = chains.get(file) ?? Promise.resolve();
  const next = previous.then(task, task).then(value => {
    persistence.set(file, { ok: true, error: null, at: new Date().toISOString() });
    return value;
  }, cause => {
    const error = new Error('操作日志写入失败：' + redactSecrets(String(cause?.message ?? cause)), { cause });
    persistence.set(file, { ok: false, error: error.message, at: new Date().toISOString() });
    throw error;
  });
  const observed = next.then(() => {}, () => {});
  chains.set(file, observed);
  void observed.then(() => { if (chains.get(file) === observed) chains.delete(file); });
  return next;
}

/** Bound what one event can cost: depth, array length and string length. */
function clip(value, depth = 0) {
  if (typeof value === 'string') {
    const safe = redactSecrets(value);
    return safe.length > MAX_FIELD_CHARS ? `${safe.slice(0, MAX_FIELD_CHARS)}…` : safe;
  }
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) {
    if (depth >= 2) return `[${value.length}]`;
    const items = value.slice(0, MAX_ARRAY_ITEMS).map((item) => clip(item, depth + 1));
    return value.length > MAX_ARRAY_ITEMS ? [...items, `…${value.length - MAX_ARRAY_ITEMS} more`] : items;
  }
  if (value && typeof value === 'object') {
    if (depth >= 2) return '{…}';
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      const clipped = clip(item, depth + 1);
      if (clipped !== undefined) out[key] = clipped;
    }
    return out;
  }
  return undefined; // functions, symbols, undefined: JSON cannot carry them
}

/** `{at, ...event}` with every field bounded; unencodable input becomes one honest line. */
export function normalizeEvent(event, at = new Date()) {
  const stamp = at instanceof Date ? at.toISOString() : String(at);
  const clipped = clip(event);
  if (!clipped || typeof clipped !== 'object' || Array.isArray(clipped)) {
    return { at: stamp, kind: 'log', action: 'unserializable' };
  }
  return { at: stamp, ...clipped };
}

async function readText(file) {
  try {
    return await fs.readFile(file, 'utf8');
  } catch (cause) {
    if (cause.code === 'ENOENT') return '';
    throw new Error('操作日志读取失败：' + redactSecrets(String(cause?.message ?? cause)), { cause });
  }
}

async function writeLines(file, lines) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(tmp, lines.length > 0 ? `${lines.join('\n')}\n` : '', { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    await fs.rename(tmp, file);
  } finally { await fs.rm(tmp, { force: true }); }
}

/**
 * Keep the newest `maxLines`/`maxBytes` of (existing + appended). When lines are
 * dropped the retained window says so on its own first line — a log that
 * silently loses its beginning reads as "this is everything that happened".
 */
function retained(existing, appended, { maxLines, maxBytes }) {
  const lines = [...existing, ...appended];
  let dropped = 0;
  const byteLength = (list) => Buffer.byteLength(list.join('\n'), 'utf8');
  while (lines.length > maxLines || (lines.length > 1 && byteLength(lines) > maxBytes)) {
    lines.shift();
    dropped += 1;
  }
  if (dropped > 0) {
    lines.unshift(JSON.stringify({
      at: new Date().toISOString(),
      kind: 'log',
      action: 'trim',
      dropped,
      note: `只保留最近 ${maxLines} 条 / ${Math.round(maxBytes / 1024)} KB`,
    }));
  }
  return { lines, dropped };
}

/**
 * Append events, trimming the file from the front when it grows past the window.
 * Resolves to `{written, lines, dropped}`, null for no input; rejects on I/O failure.
 */
export function appendEvents(file, events, { maxLines = EVENT_LIMIT_LINES, maxBytes = EVENT_LIMIT_BYTES } = {}) {
  const list = (Array.isArray(events) ? events : [events]).filter(Boolean);
  if (list.length === 0) return Promise.resolve(null);
  return enqueue(file, async () => {
      const appended = list.map((event) => {
        try {
          return JSON.stringify(normalizeEvent(event));
        } catch {
          // A value JSON refuses (a BigInt in a message, a circular object).
          return JSON.stringify({ at: new Date().toISOString(), kind: 'log', action: 'unserializable' });
        }
      });
      // Failed writes remain bounded by the same documented retention window.
      // retained() inserts an explicit trim event if that window is exceeded.
      const buffered = retained(pendingEvents.get(file)?.lines ?? [], appended, { maxLines, maxBytes });
      pendingEvents.set(file, { lines: buffered.lines, limits: { maxLines, maxBytes } });
      return persistPendingEvents(file);
  });
}

/**
 * The retained events, oldest first, newest `limit`. Corrupt lines are counted
 * rather than thrown or silently dropped: a file that half-parses is a fact
 * about the log itself and the panel is allowed to say so.
 */
export async function readEvents(file, { limit = 100 } = {}) {
  const raw = await readText(file);
  const events = [];
  let damaged = 0;
  let total = 0;
  for (const line of raw.split('\n')) {
    const text = line.trim();
    if (text === '') continue;
    total += 1;
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) events.push(normalizeEvent(parsed, parsed.at ?? new Date()));
      else damaged += 1;
    } catch {
      damaged += 1;
    }
  }
  const capped = Number.isFinite(limit) && limit > 0 ? events.slice(-limit) : events;
  return { events: capped, damaged, total };
}

/**
 * Cheap facts for the status line: how much log there is and when it last moved.
 * `lastAt` is the newest event's own timestamp, not the file's mtime — the two
 * differ exactly when the host died mid-write, which is worth seeing.
 */
export async function eventFileFacts(file) {
  try {
    const stat = await fs.stat(file);
    const { events, damaged, total } = await readEvents(file, { limit: 1 });
    return {
      bytes: stat.size,
      at: stat.mtime.toISOString(),
      lines: total,
      damaged,
      lastAt: typeof events.at(-1)?.at === 'string' ? events.at(-1).at : null,
      persistence: eventPersistence(file),
    };
  } catch (err) {
    if (err?.code === 'ENOENT') return { bytes: 0, at: null, lines: 0, damaged: 0, lastAt: null };
    return { error: redactSecrets(String(err?.message ?? err)), persistence: eventPersistence(file) };
  }
}
