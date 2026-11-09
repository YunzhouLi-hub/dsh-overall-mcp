// lib/calls.js — the runtime record behind the panel's 「调用」 tab.
//
// Why this exists: 「已注册」 answers "is it installed and healthy" and 「市场」
// answers "what can I install". Neither answers the question an operator asks
// when a tool misbehaves: what has actually been called, how slow was it, and
// did it fail. The host keeps that per session and this plugin could not read it
// — until the host's own event stream turned out to be subscribable
// (`ctx.on('session/event', (session, event) => …)`, types `tool/call` and
// `tool/result`).
//
// Two rules shape this file:
//
// 1. Only MCP tool calls and skill loading are recorded. A native `read`/`bash`
//    call belongs to the harness, not to this plugin's two surfaces, and a feed
//    that mixes them stops being a feed of "my servers".
// 2. A skill has no separate load event in DSH: the host builds one catalogue
//    per session (`fetchCatalog(session.sessionId)`) and the model later calls
//    the `skill` tool. Only 「触发」 — that real `skill` tool call — is recorded.
//    0.20.x also wrote a 「会话加载」 row per session for the catalogue itself;
//    0.21.0 dropped it (reusing a directory is not calling a skill), and any
//    such row still sitting in an old file is skipped on read instead of being
//    shown as an unnamed group.
//
// The store is append-only on disk and bounded in memory; every entry point
// swallows its own failures, because a feed that can break a page is worse than
// a missing line (same rule as lib/events.js).

import fs from 'node:fs/promises';
import path from 'node:path';
import { redactSecrets } from './install-diagnosis.js';

/** How far back the feed is kept. */
export const CALL_KEEP_MS = 7 * 24 * 60 * 60 * 1000;
/** Lines and bytes on disk; the older end is dropped first. */
export const CALL_LIMIT_LINES = 20000;
export const CALL_LIMIT_BYTES = 8 * 1024 * 1024;
/** Rows held in memory for answering a request. */
export const CALL_MEMORY_LIMIT = 4000;
/** How many appends may pass between two pruning passes. */
const PRUNE_EVERY = 200;

/** The three windows the toolbar offers, in milliseconds. */
export const CALL_RANGES = { '1h': 60 * 60 * 1000, '24h': 24 * 60 * 60 * 1000, '7d': CALL_KEEP_MS };

/** Field caps. One request body must not own the file, and a token must not be kept. */
const MAX_TEXT = 400;
const SENSITIVE_KEY = /(authorization|token|api[-_]?key|apikey|secret|cookie|password|credential|bearer)/i;

/**
 * Replace the value of anything that looks like a credential.
 *
 * The feed shows request and response previews, so this is not cosmetic: a
 * pasted GitHub token or an `Authorization` header would otherwise be written to
 * a file the panel reads back. The key keeps its name so a reader still sees
 * *that* a header was sent.
 */
export function redactValue(value, depth = 0) {
  if (typeof value === 'string') {
    const safe = redactSecrets(value);
    return safe.length > MAX_TEXT ? `${safe.slice(0, MAX_TEXT)}…` : safe;
  }
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) {
    if (depth >= 3) return `[${value.length}]`;
    const items = value.slice(0, 12).map((item) => redactValue(item, depth + 1));
    return value.length > 12 ? [...items, `…${value.length - 12} more`] : items;
  }
  if (value && typeof value === 'object') {
    if (depth >= 3) return '{…}';
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = SENSITIVE_KEY.test(key) && item !== undefined && item !== null ? '••••' : redactValue(item, depth + 1);
    }
    return out;
  }
  return undefined; // functions, symbols: JSON cannot carry them
}

/** `arguments` arrives as an object; a string form is parsed so a name is still readable. */
function argsOf(raw) {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw;
  if (typeof raw === 'string' && raw.trim().startsWith('{')) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch {
      /* a truncated or malformed body is not worth throwing over */
    }
  }
  return {};
}

function textOf(value) {
  if (typeof value === 'string') return redactValue(value);
  try {
    const text = JSON.stringify(redactValue(value));
    if (typeof text !== 'string') return '';
    return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}…` : text;
  } catch {
    return '';
  }
}

/**
 * Which surface a tool name belongs to, or null when it is neither.
 *
 * `mcp__<server>__<tool>` is the harness's naming rule for a mounted server's
 * tools, so the server is recoverable from the name alone; `skill` is the one
 * built-in tool this feed cares about.
 */
export function classifyCall(name, args) {
  if (typeof name !== 'string' || name === '') return null;
  if (name.startsWith('mcp__')) {
    const parts = name.split('__');
    // `mcp__` + server + at least one tool segment.
    if (parts.length < 3 || parts[1] === '') return null;
    return { space: 'mcp', server: parts[1], tool: parts.slice(2).join('__') };
  }
  if (name === 'skill') {
    const skill = argsOf(args).name;
    if (typeof skill !== 'string' || skill === '') return { space: 'skill', skill: null, tool: name };
    return { space: 'skill', skill, tool: name };
  }
  return null;
}

/** Short, stable session handle: the last six characters, as the panel shows it. */
export function shortSession(sessionId) {
  const text = typeof sessionId === 'string' ? sessionId : '';
  return text.length <= 6 ? text : text.slice(-6);
}

/**
 * A `tool/call` event → one running row, or null when it is not ours.
 *
 * `startedAt` is the plugin's own clock, not `event.at`: the row's duration is
 * the difference between two events we receive, so both ends must use one clock.
 */
export function runningRowOf(sessionId, event, at = Date.now()) {
  const data = event?.data;
  if (!data || typeof data !== 'object') return null;
  const name = data.name;
  const kind = classifyCall(name, data.arguments);
  if (!kind) return null;
  const callId = typeof data.callId === 'string' && data.callId !== '' ? data.callId : null;
  return {
    id: `${sessionId ?? 'unknown'}#${callId ?? `${name}@${at}`}`,
    space: kind.space,
    kind: kind.space === 'skill' ? '触发' : undefined,
    name,
    tool: kind.tool,
    server: kind.server,
    skill: kind.skill,
    status: 'running',
    startedAt: new Date(at).toISOString(),
    ms: null,
    session: shortSession(sessionId),
    req: textOf(data.arguments),
    res: null,
    note: null,
  };
}

/**
 * Skill names a user message asked the host to inject.
 *
 * A model-initiated load is a `skill` tool call and is recorded as one. A slash
 * command the user types is *not* a tool call — the host expands it into the
 * conversation before the turn starts — so the expanded `<skill_content
 * name="…">` block in the user message is the only signal it leaves. Without
 * this, `/skill-router` produced no row at all (0.29.0 and earlier).
 */
const SKILL_BLOCK = /<skill_content\s+name="([^"]{1,120})"/g;
const SKILL_SCAN_BUDGET = 1024 * 1024;

/** How long repeated references to one skill count as the same 调用. */
export const USER_SKILL_MERGE_MS = 5 * 60 * 1000;

export function skillReferencesIn(value, limit = 8) {
  const found = [];
  const seen = new Set();
  let budget = SKILL_SCAN_BUDGET;
  const walk = (node, depth) => {
    if (found.length >= limit || budget <= 0 || depth > 6 || node === null || node === undefined) return;
    if (typeof node === 'string') {
      budget -= node.length;
      for (const match of node.matchAll(SKILL_BLOCK)) {
        const name = match[1].trim();
        if (!name || seen.has(name)) continue;
        seen.add(name);
        found.push(name);
        if (found.length >= limit) return;
      }
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) walk(item, depth + 1);
      return;
    }
    if (typeof node === 'object') {
      for (const item of Object.values(node)) walk(item, depth + 1);
    }
  };
  walk(value, 0);
  return found;
}

/**
 * A user message → one 触发 row per skill it referenced, or [] when it names
 * none.
 *
 * `role` has to be the user's: an assistant echo of the same block is not a
 * second load, and the `skill` tool's own result carries the block too. The row
 * is born settled — the host resolved the command before the turn began, so
 * there is no duration to measure.
 */
/** The note a 用户引用 row carries; both capture paths share it. */
const USER_SKILL_NOTE = '你在输入框里用斜杠命令引用了这个技能（宿主把它展开注入本次请求）';

/**
 * One settled 触发 row for a skill the user named.
 *
 * `schema: 2` marks a row recorded from the host's own `skill-invocation`
 * provenance. Rows from 0.30.x have no marker because they were found by
 * scanning text for `<skill_content>` — a heuristic that also matched assistant
 * answers and tool output, and produced seven phantom rows on 2026-10-29. Those
 * are dropped on load rather than shown as if they were real.
 */
export function userSkillRowOf(sessionId, skill, at = Date.now(), note = USER_SKILL_NOTE) {
  return {
    id: `${sessionId ?? 'unknown'}#user-skill-${skill}@${at}`,
    schema: 2,
    count: 1,
    space: 'skill',
    kind: '触发',
    name: 'skill',
    tool: 'skill',
    skill,
    via: '用户引用',
    status: 'ok',
    startedAt: new Date(at).toISOString(),
    ms: null,
    session: shortSession(sessionId),
    req: '',
    res: null,
    note,
  };
}

function eventCount(row) {
  return row.via === '用户引用' && Number.isInteger(row.count) && row.count > 0 ? row.count : 1;
}

/**
 * Fold repeated references to one skill inside `windowMs` into a single row.
 *
 * 「同一段时间内的算一次」 is a reading rule, not a recording rule: the file keeps
 * every invocation, and this only decides how the timeline shows them. The
 * newest row of a group is the representative; the others are dropped and the
 * count rides on it.
 */
export function foldReferences(rows, windowMs = USER_SKILL_MERGE_MS) {
  const list = Array.isArray(rows) ? rows : [];
  if (!(windowMs > 0)) return list.slice();
  const out = [];
  const groups = new Map();
  for (const row of list) {
    if (row?.via !== '用户引用') {
      out.push(row);
      continue;
    }
    const key = `${row.session ?? ''}#${row.skill ?? ''}`;
    const group = groups.get(key);
    const at = Date.parse(row.startedAt);
    if (group && Math.abs(at - group.at) < windowMs) {
      group.row.count += eventCount(row);
      group.row.lastAt = new Date(Math.max(group.at, at)).toISOString();
      continue;
    }
    const fresh = { ...row, count: eventCount(row), ms: null };
    groups.set(key, { row: fresh, at });
    out.push(fresh);
  }
  return out;
}

export function userSkillRowsOf(sessionId, event, at = Date.now()) {
  const data = event?.data;
  if (!data || typeof data !== 'object') return [];
  // The host names the cause itself: a slash command arrives as a user message
  // whose `source` is `{kind: "skill-invocation", name: "…"}`. Scanning content
  // for the `<skill_content>` block instead matched assistant answers and tool
  // output too — that recorded seven phantom `skill-router` rows on 2026-10-29
  // between 14:06 and 14:09, one named `([^` because it had matched the parser's
  // own regular expression in a log dump.
  const source = data.source;
  if (!source || typeof source !== 'object' || source.kind !== 'skill-invocation') return [];
  const named = typeof source.name === 'string' && source.name.trim() !== ''
    ? [source.name.trim()]
    : skillReferencesIn(data);
  return named.map((skill) => userSkillRowOf(sessionId, skill, at));
}

/**
 * A `tool/result` event → the fields that settle a running row.
 *
 * `data.error` is where the harness puts a failed tool's reason; its own
 * `message` is the response preview. Neither may keep a credential, hence
 * `textOf`/`redactValue` on the way in.
 */
export function settlementOf(event) {
  const data = event?.data;
  if (!data || typeof data !== 'object') return null;
  const error = data.error;
  const failed = Boolean(error) || data.isError === true || data.message?.isError === true;
  const reason = failed
    ? textOf(typeof error === 'string' ? error : error?.info ?? error?.message ?? data.message?.content ?? '工具返回失败')
    : null;
  return { failed, reason, res: textOf(data.message ?? data.result ?? '') };
}


function startOfDay(now) {
  const date = new Date(now);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function bucketOf(ms, rangeMs, buckets) {
  const span = Math.max(1, Math.floor(rangeMs / buckets));
  return Math.min(buckets - 1, Math.max(0, Math.floor(ms / span)));
}

/**
 * Answer one request: the three headline numbers, the left rail, and the rows.
 *
 * `today` counts the whole space for the tab badge. The rail and its totals
 * use the requested time window, independently of the selected resource or
 * search. Headline metrics and timeline additionally follow those filters.
 */
export function summarize(rows, { space = 'mcp', range = '24h', filter = '', q = '', merge = USER_SKILL_MERGE_MS, now = Date.now() } = {}) {
  const rangeMs = CALL_RANGES[range] ?? CALL_RANGES['24h'];
  const since = now - rangeMs;
  const inSpace = (rows ?? []).filter((row) => row && row.space === space);
  const todayStart = startOfDay(now);
  const today = inSpace.reduce((sum, row) => sum + (Date.parse(row.startedAt) >= todayStart && Date.parse(row.startedAt) <= now ? eventCount(row) : 0), 0);
  const inWindow = inSpace.filter(row => {
    const at = Date.parse(row.startedAt);
    return Number.isFinite(at) && at >= since && at <= now;
  });

  const needle = typeof q === 'string' ? q.trim().toLowerCase() : '';
  const wanted = typeof filter === 'string' ? filter.trim() : '';
  const filtered = inWindow.filter((row) => {
    if (wanted !== '') {
      const key = space === 'mcp' ? row.server ?? '' : row.skill ?? '';
      if (key !== wanted) return false;
    }
    if (needle !== '') {
      const hay = [row.tool, row.name, row.skill, row.kind, row.session, shortSession(row.session)]
        .filter((part) => typeof part === 'string')
        .join(' ')
        .toLowerCase();
      if (!hay.includes(needle)) return false;
    }
    return true;
  });

  // The timeline folds repeated slash references (a reading rule), while the
  // spark line keeps counting every event that actually happened. Folding needs
  // the newest row first, which is the order the reader sees anyway.
  const ordered = filtered.slice().sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
  const view = space === 'skill' ? foldReferences(ordered, merge) : ordered;
  const references = filtered.filter(row => row.via === '用户引用').reduce((sum, row) => sum + eventCount(row), 0);
  const completedLoads = filtered.filter(row => row.via !== '用户引用' && (row.status === 'ok' || row.status === 'fail'));
  const loaded = completedLoads.filter(row => row.status === 'ok').length;
  const ok = loaded + references;
  const fail = completedLoads.length - loaded;
  const settled = ok + fail;
  // Slash references have no measurement; historical zero placeholders are not timings.
  const timed = completedLoads.filter(row => Number.isFinite(row.ms));
  const avgMs = timed.length === 0 ? null : Math.round(timed.reduce((sum, row) => sum + row.ms, 0) / timed.length);

  const buckets = 24;
  // The stat block draws this instead of a decoration: the same 24 slots the
  // rail uses, so a busy hour looks busy in both places.
  const spark = new Array(buckets).fill(0);
  for (const row of filtered) {
    spark[bucketOf(Date.parse(row.startedAt) - since, rangeMs, buckets)] += eventCount(row);
  }
  const groups = new Map();
  const keyOf = (row) => (space === 'mcp' ? row.server ?? '未知服务器' : row.skill ?? '未记录 skill');
  for (const row of inWindow) {
    const key = keyOf(row);
    if (!groups.has(key)) groups.set(key, { id: key, name: key, today: 0, spark: new Array(buckets).fill(0), total: 0 });
    const group = groups.get(key);
    group.total += eventCount(row);
    if (Date.parse(row.startedAt) >= todayStart) group.today += eventCount(row);
    const at = Date.parse(row.startedAt);
    const index = bucketOf(at - since, rangeMs, buckets);
    group.spark[index] += eventCount(row);
  }

  const rail = [...groups.values()].sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
  return {
    space,
    range,
    filter: wanted,
    q: needle,
    // The window actually used. The panel adopts this instead of hard-coding a
    // second copy of the default, and 0 means "no folding" rather than missing.
    merge: space === 'skill' ? merge : 0,
    stats: {
      today,
      inRange: inWindow.reduce((sum, row) => sum + eventCount(row), 0),
      ok,
      fail,
      settled,
      ...(space === 'skill' ? { references } : {}),
      rate: settled === 0 ? null : Math.round((ok / settled) * 1000) / 10,
      avgMs,
      shown: view.length,
      spark,
    },
    rail,
    rows: view.slice(0, 300),
  };
}

/**
 * The store: memory for answering, a file for surviving a restart.
 *
 * A row is written twice — once when the call starts, once when it settles —
 * because a host that dies mid-call must not leave a row claiming to be running
 * forever. On load, anything still marked running is settled as `lost`: the
 * result can never arrive, and a page that shows a breathing dot for it would be
 * telling the operator something untrue.
 */
export class CallStore {
  constructor({ file, now = () => Date.now(), memoryLimit = CALL_MEMORY_LIMIT, fileLimits = {} } = {}) {
    this.file = file;
    this.now = now;
    this.memoryLimit = memoryLimit;
    // Injectable so a test can drive the rewrite without 20,000 rows.
    this.limits = { lines: fileLimits.lines ?? CALL_LIMIT_LINES, bytes: fileLimits.bytes ?? CALL_LIMIT_BYTES };
    this.rows = [];
    this.byId = new Map();
    this.ownedIds = new Set();
    this.dropped = 0;
    this.damaged = 0;
    this.loaded = false;
    this.sig = null;
    this.appends = 0;
    this.chain = Promise.resolve();
  }

  /** Read the file once. Failures mean "an empty feed", never a broken plugin. */
  async load() {
    if (this.loaded) return this;
    this.loaded = true;
    return this.readFromDisk();
  }

  /**
   * Pick up what the subscriber appended after the first read.
   *
   * The reader asks on demand, so the feed must include rows written since the
   * plugin started; the size/mtime pair keeps that honest without re-reading
   * the file on every scroll.
   */
  async refresh() {
    if (!this.loaded) return this.load();
    if (!this.file) return this;
    let stat = null;
    try {
      stat = await fs.stat(this.file);
    } catch {
      return this;
    }
    if (`${stat.size}:${stat.mtimeMs}` === this.sig) return this;
    return this.readFromDisk();
  }

  async readFromDisk() {
    if (!this.file) return this;
    let raw = '';
    try {
      raw = await fs.readFile(this.file, 'utf8');
    } catch {
      return this;
    }
    const stat = await fs.stat(this.file).catch(() => null);
    if (stat) this.sig = `${stat.size}:${stat.mtimeMs}`;
    const oldest = this.now() - CALL_KEEP_MS;
    for (const line of raw.split('\n')) {
      const text = line.trim();
      if (text === '') continue;
      let row = null;
      try {
        row = JSON.parse(text);
      } catch {
        this.damaged += 1;
        continue;
      }
      if (!row || typeof row !== 'object' || Array.isArray(row)) {
        this.damaged += 1;
        continue;
      }
      // 0.21.0 stopped inventing a row for "the host reused a skill directory":
      // that is not a call. Rows left over from 0.20.x carry no skill name, and
      // an unnamed row is what used to surface as a group the reader could not
      // account for in the rail.
      if (row.kind === '会话加载') continue;
      // 0.30.x found references by scanning text for `<skill_content>`, which also
      // matched assistant answers and tool output — seven phantom rows on
      // 2026-10-29 between 14:06 and 14:09. Untagged rows are dropped; rows from
      // the provenance-based version (`schema: 2`) are kept.
      if (row.via === '用户引用' && row.schema !== 2) continue;
      if (!Number.isFinite(Date.parse(row.startedAt)) || Date.parse(row.startedAt) < oldest) continue;
      for (const field of ['req', 'res', 'note']) if (typeof row[field] === 'string') row[field] = redactSecrets(row[field]);
      if (!this.ownedIds.has(row.id)) this.put(row, { write: false });
    }
    for (const row of this.rows) {
      // A slash reference is over the moment it is seen: nothing to wait for, so
      // no duration, and never a "lost" notice.
      if (row.via === '用户引用') {
        row.status = 'ok';
        row.ms = null;
        row.count = eventCount(row);
        continue;
      }
      if (row.status === 'running' && !this.ownedIds.has(row.id)) {
        // Only a restart can leave a row running: the subscriber settles it in
        // the same process. Saying so beats showing a spinner that never stops.
        row.status = 'lost';
        row.ms = null;
        row.note = '宿主在这次调用返回前退出了，结果没能取到';
      }
    }
    this.trim();
    return this;
  }

  put(row, { write = true } = {}) {
    if (write) this.ownedIds.add(row.id);
    const previous = this.byId.get(row.id);
    const merged = previous ? { ...previous, ...row } : row;
    if (previous) {
      const index = this.rows.findIndex((item) => item.id === row.id);
      if (index >= 0) this.rows[index] = merged;
    } else {
      this.rows.push(merged);
    }
    this.byId.set(merged.id, merged);
    if (write) this.appendToFile(merged);
    return merged;
  }

  /** Start a call. Returns the row, or null when the event was not ours. */
  start(row) {
    if (!row) return null;
    return this.put({ ...row, status: 'running' });
  }

  /**
   * Record a user's slash reference. Every invocation is its own fact; folding
   * repeats into one row is a *view* decision and happens on read
   * (`foldReferences`), so the window can be changed without rewriting history.
   */
  recordReference(sessionId, skill, at = this.now()) {
    return this.record(userSkillRowOf(sessionId, skill, at));
  }

  /**
   * Record a row that is already over.
   *
   * A user's slash reference has nothing to wait for: `start` forces `running`,
   * and a later `tool/result` without a `callId` then settles it with an
   * unrelated tool's output — observed live: a `/skill-router` row took the
   * result of a `node --test` that ran ten seconds later.
   */
  record(row) {
    if (!row) return null;
    return this.put(row);
  }

  /** Finish a call. Unknown ids are ignored: the row may have been pruned. */
  settle(id, { failed, reason, res }) {
    const row = this.byId.get(id);
    if (!row) return null;
    const ms = Math.max(0, this.now() - Date.parse(row.startedAt));
    return this.put({
      ...row,
      status: failed ? 'fail' : 'ok',
      ms,
      res: res ?? row.res,
      note: failed ? reason ?? '工具返回失败' : row.note ?? null,
    });
  }

  /**
   * The newest still-running row of one session.
   *
   * A `tool/result` event carries the response and the originating `callSeq`,
   * not the call id, so a settle either matches by id (when the event happens to
   * carry one) or takes this session's most recent open call — calls inside one
   * session are ordered, and a wrong guess only ever affects a row that is about
   * to be pruned anyway.
   */
  newestRunning(sessionId) {
    // Rows keep the short session the card shows, so compare short to short.
    const short = shortSession(sessionId);
    for (let i = this.rows.length - 1; i >= 0; i -= 1) {
      const row = this.rows[i];
      if (row.status === 'running' && row.session === short) return row;
    }
    return null;
  }

  /** Mark a call whose result never arrived (session ended, host stopped waiting). */
  abandon(id, note) {
    const row = this.byId.get(id);
    if (!row || row.status !== 'running') return null;
    return this.put({ ...row, status: 'lost', ms: null, note: note ?? '没有等到结果事件' });
  }

  appendToFile(row) {
    if (!this.file) return;
    const line = `${JSON.stringify(row)}\n`;
    this.chain = this.chain.then(async () => {
      try {
        await fs.mkdir(path.dirname(this.file), { recursive: true });
        await fs.appendFile(this.file, line, 'utf8');
      } catch {
        /* a feed that cannot write is still readable in memory */
      }
    });
    this.appends += 1;
    if (this.appends % PRUNE_EVERY === 0) void this.prune();
  }

  /** Drop the old end of memory; returns how many rows went. */
  trim() {
    const oldest = this.now() - CALL_KEEP_MS;
    const kept = [];
    for (const row of this.rows) {
      const at = Date.parse(row.startedAt);
      if (Number.isFinite(at) && at >= oldest) kept.push(row);
      else this.dropped += 1;
    }
    while (kept.length > this.memoryLimit) {
      const gone = kept.shift();
      if (gone) this.dropped += 1;
    }
    this.rows = kept;
    this.byId = new Map(kept.map((row) => [row.id, row]));
    this.ownedIds = new Set([...this.ownedIds].filter((id) => this.byId.has(id)));
    return this.dropped;
  }

  /**
   * Rewrite the file when what is on disk has grown past its limits.
   *
   * The check reads the file rather than counting memory: memory deliberately
   * holds fewer rows than the file may, so "memory is small" is not evidence
   * that the file is small.
   */
  async prune() {
    if (!this.file) return null;
    let raw = '';
    try {
      raw = await fs.readFile(this.file, 'utf8');
    } catch {
      return null;
    }
    const onDisk = raw.split('\n').filter((line) => line.trim() !== '').length;
    const diskBytes = Buffer.byteLength(raw, 'utf8');
    if (onDisk <= this.limits.lines && diskBytes <= this.limits.bytes) return null;
    this.trim();
    const kept = [];
    let size = 0;
    for (const row of [...this.rows].reverse()) {
      const line = JSON.stringify(row);
      if (size + line.length + 1 > this.limits.bytes) break;
      kept.unshift(row);
      size += line.length + 1;
      if (kept.length >= this.limits.lines) break;
    }
    this.dropped += this.rows.length - kept.length;
    this.rows = kept;
    this.byId = new Map(kept.map((row) => [row.id, row]));
    try {
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      await fs.writeFile(tmp, kept.map((row) => JSON.stringify(row)).join('\n') + (kept.length > 0 ? '\n' : ''), 'utf8');
      await fs.rename(tmp, this.file);
    } catch {
      return null;
    }
    return { kept: kept.length };
  }

  /** Wait for queued writes to land (tests and shutdown). */
  async flush() {
    await this.chain;
  }

  coverage() {
    const oldest = this.rows.length === 0 ? null : this.rows[0].startedAt;
    return {
      since: oldest,
      kept: this.rows.length,
      dropped: this.dropped,
      damaged: this.damaged,
      running: this.rows.filter((row) => row.status === 'running').length,
    };
  }
}
