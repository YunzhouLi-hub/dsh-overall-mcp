/**
 * Local install counter for the market.
 *
 * The market's 「使用量」 comes from the *sources*: only Smithery (`useCount`) and
 * the Docker catalogue (`pull_count`) publish one, and neither counts the
 * installs a user made from this panel. The user asked for exactly that
 * (「下载量以后从我们市场下载的也要统计一下」), so every successful install
 * through this plugin is recorded here and reported back with the catalogue.
 *
 * It is a **local** counter, deliberately: nothing leaves the machine, and the
 * card labels the two series separately (「87.5k 次启动」 is the upstream's
 * number, 「本市场 3 次」 is this machine's). The two are only *summed* when
 * ordering by 使用量, where the point is "how used is this thing" and our own
 * installs are the only evidence available for the 233 entries whose source
 * publishes no figure at all.
 *
 * Storage is a small JSON document next to the registry, so it survives a
 * restart and stays inspectable (`$DSH_HOME/overall-mcp/installs.json`).
 */
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { dirname } from 'node:path';

const INSTALLS_VERSION = 1;

/** Cap on the stored key length: entries come from a remote catalogue. */
const KEY_MAX = 200;

/**
 * Stable key for one catalogue entry.
 *
 * The catalogue's own `id` (`smithery:brave`, `official:ac.snag/snag`) is what
 * the card, the favourites and the install button already agree on, so a count
 * cannot drift away from the entry it belongs to. `fallback` (the registry
 * server name) covers an item handed to the install tool without an id.
 */
export function installKeyOf(item, fallback = null) {
  const id = typeof item?.id === 'string' ? item.id.trim() : '';
  if (id) return id.slice(0, KEY_MAX);
  const name = typeof fallback === 'string' ? fallback.trim() : '';
  return name ? `name:${name}`.slice(0, KEY_MAX) : null;
}

export function emptyInstalls() {
  return { version: INSTALLS_VERSION, entries: {} };
}

/** Coerce whatever was on disk into a usable store; anything odd is a fresh one. */
export function normalizeInstalls(raw) {
  const store = emptyInstalls();
  const entries = raw && typeof raw === 'object' ? raw.entries : null;
  if (!entries || typeof entries !== 'object' || Array.isArray(entries)) return store;
  for (const [key, value] of Object.entries(entries)) {
    if (!key) continue;
    const count = Number(value?.count);
    if (!Number.isFinite(count) || count <= 0) continue;
    const entry = { count: Math.floor(count) };
    if (typeof value?.firstAt === 'string') entry.firstAt = value.firstAt;
    if (typeof value?.lastAt === 'string') entry.lastAt = value.lastAt;
    if (typeof value?.name === 'string' && value.name) entry.name = value.name.slice(0, KEY_MAX);
    store.entries[key.slice(0, KEY_MAX)] = entry;
  }
  return store;
}

/** Read the store; a missing or corrupt file is an empty store, never a throw. */
export async function readInstalls(file, readFileImpl = readFile) {
  try {
    return normalizeInstalls(JSON.parse(await readFileImpl(file, 'utf8')));
  } catch {
    return emptyInstalls();
  }
}

/**
 * Count one install. Mutates `store` and returns the entry, so the caller can
 * both persist the store and answer with the new count.
 */
export function recordInstallIn(store, { key, name = null, at = null } = {}) {
  const target = store && typeof store === 'object' ? store : emptyInstalls();
  if (!target.entries || typeof target.entries !== 'object') target.entries = {};
  if (!key) return null;
  const iso = typeof at === 'string' && at ? at : new Date().toISOString();
  const existing = target.entries[key];
  const entry = {
    count: (Number.isFinite(existing?.count) ? existing.count : 0) + 1,
    firstAt: existing?.firstAt ?? iso,
    lastAt: iso,
  };
  if (name) entry.name = String(name).slice(0, KEY_MAX);
  else if (existing?.name) entry.name = existing.name;
  target.entries[key] = entry;
  return entry;
}

/** How many times this machine installed one catalogue entry. */
export function localInstallsOf(store, item, fallback = null) {
  const key = typeof item === 'string' ? item : installKeyOf(item, fallback);
  if (!key) return 0;
  const count = store?.entries?.[key]?.count;
  return Number.isFinite(count) && count > 0 ? count : 0;
}

/** When this machine last installed it, or null. */
export function localLastInstallOf(store, item, fallback = null) {
  const key = typeof item === 'string' ? item : installKeyOf(item, fallback);
  if (!key) return null;
  const at = store?.entries?.[key]?.lastAt;
  return typeof at === 'string' && at ? at : null;
}

/**
 * Persist through a temp file + rename, so a crash mid-write cannot leave a
 * truncated counter behind (the registry itself is written in place; a counter
 * that loses its history silently is worse than one that lags a moment).
 */
export async function writeInstalls(file, store, fsImpl = { mkdir, writeFile, rename }) {
  await fsImpl.mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await fsImpl.writeFile(tmp, JSON.stringify({ version: INSTALLS_VERSION, entries: store?.entries ?? {} }, null, 2), 'utf8');
  await fsImpl.rename(tmp, file);
}
