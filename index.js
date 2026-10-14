// index.js — dsh-overall-mcp host plugin.
//
// Architecture (verified against @deepseek-ai/cordis@4.0.4, dsh-tools@0.0.1-rc.1,
// dsh-mcp-client@0.0.1-rc.1 published sources):
//   - This plugin injects the `tools` service (ToolRegistry).
//   - Each enabled registry entry is mounted as its own dsh-mcp-client plugin
//     instance via `ctx.plugin(mcpClient, config)`; its tools appear as
//     `mcp__<serverName>__<rawName>`. Disposal unloads via `fiber.dispose()`.
//   - Management tools are defined with `defineTool` and registered through
//     `ctx.tools.register(definition)`, which returns an unregister disposer.

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as mcpClient from '@deepseek-ai/dsh-mcp-client';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { scanHost, mergeIntoRegistry } from './lib/scanner.js';
import { searchOpenCatalogs, browseCatalog, catalogItemToEntry, fetchRepoStats } from './lib/catalog.js';
import { collectRepoMedia } from './lib/media.js';
import { sanitizeToolDefinition } from './lib/schema-guard.js';
import { checkAllUpdates, checkEntryUpdate, parsePackageInvocation, pinArgs } from './lib/updates.js';
import { checkSelfUpdate, updateSelf } from './lib/self-update.js';

export const name = 'overall-mcp';
export const inject = ['tools'];

const REGISTRY_VERSION = 1;
const SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;
/** How long a browsed market listing stays fresh before the next fetch. */
const CATALOG_TTL_MS = 10 * 60 * 1000;
/** Bounded readiness wait for one mcp-client mount (see connect()). */
const CONNECT_WAIT_MS = 8000;

function dataDir() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  return path.join(home, 'overall-mcp');
}

async function readJson(file, fallback) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch { return fallback; }
}
async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(value, null, 2), 'utf8');
}

/** Slugify a display name into a legal mcp-client serverName (≤32 chars). */
function toServerName(name) {
  let slug = String(name).toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32);
  return SERVER_NAME_PATTERN.test(slug) ? slug : null;
}

/** Build the dsh-mcp-client Config for one registry entry with an explicit serverName. */
function toMcpConfig(entry, serverName) {
  if (!serverName) return null;
  if (entry.transport === 'streamable-http' || entry.transport === 'sse') {
    return { transport: 'streamable-http', serverName, url: entry.url, headers: entry.headers ?? {} };
  }
  return {
    transport: 'stdio',
    serverName,
    command: entry.command,
    args: entry.args ?? [],
    env: entry.env ?? {},
    cwd: entry.cwd ?? '',
  };
}

/**
 * True when an mcp-client start rejected because its serverName was already
 * reserved — other MCP plugins (dsh-mcp-connector, dsh-mcp-panel) mount their
 * own mcp-client entries with the same serverNames, so this is expected.
 */
function isNameConflict(err) {
  return /already in use|unique serverName/i.test(String(err?.message ?? err));
}

/**
 * Install a narrow guard around ToolRegistry.register so MCP tool schemas that
 * our mounts publish never carry a regex the model provider rejects. Only
 * `mcp__*` definitions are touched, and the method is restored on disposal.
 * Failure to patch is non-fatal: the plugin keeps working without the guard.
 */
function installSchemaGuard(ctx, log) {
  const registry = ctx.tools;
  const original = registry?.register;
  if (typeof original !== 'function') return;

  const wrapper = function guardedRegister(definition) {
    return original.call(this, sanitizeToolDefinition(definition, {
      onChange: ({ name, changes }) => {
        log?.warn?.(`overall-mcp: repaired ${changes.length} regex keyword(s) in ${name} (${changes
          .map((c) => `${c.path}:${c.action}`).join(', ')})`);
      },
    }));
  };

  try {
    Object.defineProperty(registry, 'register', { value: wrapper, configurable: true, writable: true });
  } catch (err) {
    log?.warn?.(`overall-mcp: schema guard unavailable: ${String(err?.message ?? err)}`);
    return;
  }
  log?.info?.('overall-mcp: schema guard installed for mcp__* tool schemas');
  ctx.effect(() => () => {
    try { delete registry.register; } catch { /* leave the shim in place */ }
  }, 'overall-mcp.schema-guard');
}

/** Render any JSON result as one text block for the Native projection. */
function renderJson(args, value) {
  return [{ type: 'text', text: JSON.stringify(value, null, 2) }];
}

/** Collect every regex keyword found in one JSON schema, for diagnostics. */
function collectPatterns(schema, path = '', found = []) {
  if (schema === null || typeof schema !== 'object') return found;
  for (const [key, value] of Object.entries(schema)) {
    const here = path ? `${path}.${key}` : key;
    if (key === 'pattern' && typeof value === 'string') found.push({ path: here, pattern: value });
    else if (key === 'patternProperties' && value && typeof value === 'object') {
      for (const source of Object.keys(value)) found.push({ path: `${here}.${source}`, pattern: source });
    }
    collectPatterns(value, here, found);
  }
  return found;
}

export async function apply(ctx) {
  const log = ctx.logger?.('overall-mcp') ?? ctx.logger;
  const dir = dataDir();
  const registryFile = path.join(dir, 'registry.json');
  const reportFile = path.join(dir, 'scan-report.json');

  let registry = await readJson(registryFile, null);
  const firstRun = registry === null;
  if (!registry) registry = { version: REGISTRY_VERSION, servers: [] };
  // Favourite market entries, keyed exactly like the client's React key
  // (`<source>:<id|title>`) so the card and the stored state cannot disagree.
  // Kept beside `servers` rather than inside it: a favourite is a UI bookmark,
  // not a mounted server, and mixing the two would make scans write over it.
  const favorites = new Set(Array.isArray(registry.favorites) ? registry.favorites.filter((k) => typeof k === 'string') : []);

  const fibers = new Map(); // entry.name -> mcp-client Fiber

  // Repair provider-hostile regexes in every MCP schema mounted below.
  installSchemaGuard(ctx, log);

  async function save() {
    registry.version = REGISTRY_VERSION;
    await writeJson(registryFile, registry);
  }

  /**
   * Mount one registry entry as its own mcp-client instance.
   *
   * Resilience rules (learned from real failures):
   *   1. `fiber.await()` rethrows startup errors, so a duplicate serverName is
   *      caught HERE instead of failing the whole overall-mcp entry.
   *   2. When the plain serverName is already reserved by another mcp-client
   *      mount (e.g. the harness-home patch already provides REA as `rea`), the
   *      entry is marked `provided-externally` and NOT mounted a second time:
   *      duplicate tool sets bloat every request and duplicate connections can
   *      ship broken schemas that abort the whole model call.
   *   3. Any other per-server failure is contained and reported, never thrown.
   *   4. The readiness wait is BOUNDED: a first-run `npx` download can take
   *      minutes, and an interactive install must not block the settings page
   *      for that long. A fiber still starting after the deadline is kept and
   *      reported as `starting`.
   */
  async function connect(entry, { waitMs = CONNECT_WAIT_MS } = {}) {
    if (fibers.has(entry.name)) return { ok: true, already: true };
    const serverName = toServerName(entry.name);
    if (!serverName) return { ok: false, error: `invalid server name: ${entry.name}` };

    const config = toMcpConfig(entry, serverName);
    let fiber;
    try {
      fiber = ctx.plugin(mcpClient, config);
    } catch (err) {
      if (isNameConflict(err)) {
        entry.providedExternally = true;
        entry.connectError = undefined;
        delete entry.serverName;
        log?.info?.(`overall-mcp: ${entry.name} is already provided by another mcp-client mount, skipping`);
        return { ok: true, skipped: 'already-provided', serverName };
      }
      entry.connectError = String(err?.message ?? err);
      log?.warn?.(`overall-mcp: could not mount ${entry.name}: ${entry.connectError}`);
      return { ok: false, error: entry.connectError };
    }

    let failure = null;
    let timedOut = false;
    await Promise.race([
      fiber.await().catch((err) => { failure = err; }),
      new Promise((resolve) => { setTimeout(() => { timedOut = true; resolve(); }, waitMs); }),
    ]);

    if (failure) {
      try { await fiber.dispose(); } catch { /* already gone */ }
      if (isNameConflict(failure)) {
        entry.providedExternally = true;
        entry.connectError = undefined;
        delete entry.serverName;
        log?.info?.(`overall-mcp: ${entry.name} is already provided by another mcp-client mount, skipping`);
        return { ok: true, skipped: 'already-provided', serverName };
      }
      entry.connectError = String(failure?.message ?? failure);
      log?.warn?.(`overall-mcp: could not connect ${entry.name}: ${entry.connectError}`);
      return { ok: false, error: entry.connectError };
    }

    fibers.set(entry.name, fiber);
    entry.serverName = serverName;
    entry.connectError = undefined;
    entry.providedExternally = false;
    if (timedOut) {
      // Keep the fiber and let it finish in the background; a later
      // `overall_mcp_list` / page refresh shows the settled state.
      fiber.await().then(
        () => log?.info?.(`overall-mcp: ${entry.name} finished connecting in the background`),
        (err) => {
          entry.connectError = String(err?.message ?? err);
          log?.warn?.(`overall-mcp: ${entry.name} failed to connect: ${entry.connectError}`);
        },
      );
    }
    return { ok: true, serverName, toolPrefix: `mcp__${serverName}__`, starting: timedOut };
  }

  async function disconnect(name) {
    const fiber = fibers.get(name);
    if (!fiber) return;
    fibers.delete(name);
    try { await fiber.dispose(); } catch { /* already gone */ }
  }

  async function connectEnabled() {
    const results = [];
    for (const entry of registry.servers) {
      if (entry.enabled === false) continue;
      results.push({ name: entry.name, ...(await connect(entry)) });
    }
    return results;
  }

  function publicList() {
    return registry.servers.map((s) => {
      const enabled = s.enabled !== false;
      const connected = fibers.has(s.name);
      const providedExternally = !connected && s.providedExternally === true;
      const status = s.connectError ? 'error'
        : providedExternally ? 'provided-externally'
          : connected ? 'connected'
            : enabled ? 'idle' : 'stopped';
      return {
        name: s.name,
        transport: s.transport,
        source: s.source,
        enabled,
        connected,
        status,
        providedExternally,
        serverName: s.serverName ?? toServerName(s.name) ?? undefined,
        error: s.connectError,
        package: (() => {
          const invocation = parsePackageInvocation(s);
          return invocation ? { manager: invocation.manager, name: invocation.pkg, version: invocation.version } : null;
        })(),
        updateAvailable: s.updateCheck?.updateAvailable === true,
        update: s.updateCheck ?? null,
        updatedAt: s.updatedAt,
      };
    });
  }

  // First install: scan well-known host MCP configs and import them.
  // Contained: a scan failure must never fail this plugin's activation.
  if (firstRun) {
    try {
      const { found, report } = await scanHost({});
      const merged = mergeIntoRegistry(registry, found);
      registry = merged.registry;
      await save();
      await writeJson(reportFile, { scannedAt: new Date().toISOString(), report });
      log?.info?.(`first-run scan imported ${merged.added.length} servers (skipped ${merged.skipped.length})`);
    } catch (err) {
      log?.warn?.(`overall-mcp: first-run scan failed: ${String(err?.message ?? err)}`);
    }
  }

  // ---- shared management actions (used by model tools AND /api routes) ----

  async function doScan() {
    const { found, report } = await scanHost({});
    const merged = mergeIntoRegistry(registry, found);
    registry = merged.registry;
    await save();
    await writeJson(reportFile, { scannedAt: new Date().toISOString(), report });
    const connected = [];
    for (const name of merged.added) {
      const entry = registry.servers.find((s) => s.name === name);
      if (entry && entry.enabled !== false) connected.push({ name, ...(await connect(entry)) });
    }
    return { added: merged.added, skipped: merged.skipped, connected, scannedFiles: report.length };
  }

  async function doInstall(item) {
    const entry = catalogItemToEntry(item);
    if (!entry) throw new Error('item has no installable transport (stdio command or http url)');
    const i = registry.servers.findIndex((s) => s.name === entry.name);
    if (i >= 0) { await disconnect(entry.name); registry.servers[i] = entry; }
    else registry.servers.push(entry);
    await save();
    const conn = entry.enabled !== false ? await connect(entry) : { ok: true, deferred: true };
    return { installed: entry.name, servers: publicList(), connect: conn };
  }

  async function doSetEnabled(name, enabled) {
    const entry = registry.servers.find((s) => s.name === name);
    if (!entry) throw new Error(`unknown server: ${name}`);
    entry.enabled = enabled;
    await save();
    if (!enabled) await disconnect(name);
    else if (!fibers.has(name)) await connect(entry);
    return { name, enabled, connected: fibers.has(name) };
  }

  /** Bulk enable/disable every server imported from one source (group switch). */
  async function doSetSourceEnabled(source, enabled) {
    const targets = registry.servers.filter((s) => (s.source ?? 'manual') === source);
    if (targets.length === 0) throw new Error(`unknown source: ${source}`);
    for (const entry of targets) entry.enabled = enabled;
    await save();
    for (const entry of targets) {
      if (!enabled) await disconnect(entry.name);
      else if (!fibers.has(entry.name)) await connect(entry);
    }
    return { source, enabled, changed: targets.length, servers: publicList() };
  }

  async function doRemove(name) {
    const i = registry.servers.findIndex((s) => s.name === name);
    if (i < 0) throw new Error(`unknown server: ${name}`);
    await disconnect(name);
    registry.servers.splice(i, 1);
    await save();
    return { removed: name, servers: publicList() };
  }

  // ---- package updates ------------------------------------------------------
  // Only entries launched through a package runner (npx / uvx, including the
  // Windows `cmd.exe /c` form imported from other clients) have a checkable
  // version; everything else reports `detectable: false` instead of guessing.

  // The plugin's *own* update check is a different question from the MCP
  // servers it mounts (see lib/self-update.js): a `link:` checkout has no
  // published version to move to, so the panel must not offer one. The memo
  // keeps 检查更新 from hitting the npm registry on every click.
  const selfUpdateCache = {};

  const doCheckSelfUpdate = (opts = {}) => checkSelfUpdate({ moduleUrl: import.meta.url, cache: selfUpdateCache, ...opts });

  const doSelfUpdate = () => updateSelf({ moduleUrl: import.meta.url });

  async function doCheckUpdates() {
    const entries = registry.servers.filter((s) => s.enabled !== false);
    const result = await checkAllUpdates(entries);
    for (const check of result.entries) {
      const entry = registry.servers.find((s) => s.name === check.name);
      if (!entry) continue;
      entry.updateCheck = check.detectable
        ? { at: new Date().toISOString(), current: check.current, latest: check.latest, updateAvailable: check.updateAvailable, error: check.error }
        : { at: new Date().toISOString(), detectable: false, reason: check.reason };
    }
    await save();
    return { ...result, servers: publicList() };
  }

  async function doUpdate(name) {
    const entry = registry.servers.find((s) => s.name === name);
    if (!entry) throw new Error(`unknown server: ${name}`);
    const check = await checkEntryUpdate(entry);
    if (!check.detectable) throw new Error(`${name} is not launched through a package runner; update it manually`);
    if (check.error) throw new Error(`version lookup failed for ${check.pkg}: ${check.error}`);
    if (!check.updateAvailable) {
      return { name, updated: false, package: check.pkg, version: check.latest, reason: check.unpinned ? 'unpinned runner always resolves to the newest release' : 'already up to date' };
    }
    const previous = check.current;
    entry.args = pinArgs(entry, check.latest);
    entry.updatedAt = new Date().toISOString();
    entry.updateCheck = { at: new Date().toISOString(), current: check.latest, latest: check.latest, updateAvailable: false };
    await save();
    // Restart the mount so the new version is what actually runs.
    const wasConnected = fibers.has(name);
    if (wasConnected) await disconnect(name);
    const conn = entry.enabled !== false ? await connect(entry) : { ok: true, deferred: true };
    log?.info?.(`overall-mcp: updated ${name} from ${previous} to ${check.latest}`);
    return { name, updated: true, package: check.pkg, from: previous, to: check.latest, reconnected: wasConnected, connect: conn };
  }

  // ---- MCP market (browse the open catalogs) -------------------------------
  // Cached per query key so opening the market tab repeatedly does not hammer
  // the upstream registries; `refresh: true` forces a new fetch.
  const catalogCache = new Map(); // key -> { at, data }

  /**
   * Stable identity for a market entry's favourite state.
   *
   * `<source>:<id|title>` — the same string the market card uses as its React
   * key. A catalogue entry has no other durable id (official-registry items are
   * versioned records whose ids change on every release), so the source-scoped
   * title is the only key that stays put across refreshes.
   */
  function favoriteKeyOf(item) {
    const source = String(item?.source ?? 'unknown');
    const id = item?.id ?? item?.title;
    return `${source}:${id ?? ''}`;
  }

  /**
   * Annotate a catalog item with its proposed registry name and installed state.
   *
   * `raw` is the upstream's own record and is stripped: it is large, and the
   * settings page only needs the handful of fields below (currently Smithery's
   * `qualifiedName`, to build a link to its listing page). Everything the UI
   * shows is derived here instead of being forwarded wholesale.
   */
  function annotateItem(item) {
    const entry = catalogItemToEntry(item);
    const name = entry?.name ?? null;
    const installed = name !== null && registry.servers.some((s) => s.name === name);
    return {
      ...item,
      raw: undefined,
      qualifiedName: item.raw?.qualifiedName ?? undefined,
      proposedName: name,
      installable: entry !== null,
      installed,
      favorite: favorites.has(favoriteKeyOf(item)),
    };
  }

  /** Toggle one market entry's favourite, persisted with the registry. */
  async function doToggleFavorite({ key } = {}) {
    if (typeof key !== 'string' || !key.trim()) throw new Error('key required');
    const normalized = key.trim().slice(0, 200);
    if (favorites.has(normalized)) favorites.delete(normalized);
    else favorites.add(normalized);
    registry.favorites = [...favorites].sort();
    await save();
    return { key: normalized, favorite: favorites.has(normalized), favorites: registry.favorites };
  }
  async function doBrowse({ query = '', limit = 120, source = '', refresh = false } = {}) {
    const key = `${source}|${query}|${limit}`;
    const hit = catalogCache.get(key);
    const now = Date.now();
    // Cache the RAW listing only: the installed flag depends on the registry and
    // is recomputed on every read, so installing/removing never shows a stale badge.
    if (refresh || !hit || now - hit.at >= CATALOG_TTL_MS) {
      const result = await browseCatalog({ query, limit, source });
      catalogCache.set(key, { at: now, data: { items: result.items, errors: result.errors, counts: result.counts, total: result.total } });
    }
    const cached = catalogCache.get(key);
    return {
      items: cached.data.items.map(annotateItem),
      errors: cached.data.errors,
      counts: cached.data.counts,
      total: cached.data.total,
      cached: !refresh && hit !== undefined,
      fetchedAt: new Date(cached.at).toISOString(),
      servers: publicList(),
    };
  }

  // ---- GitHub star enrichment for the market cards -------------------------
  // The catalogs themselves do not publish star counts, so cards start without
  // them and the page asks for the visible repos afterwards.
  //
  // The GitHub REST API allows only 60 unauthenticated requests/hour and the
  // endpoint has no batch form, so this has to spend that budget carefully:
  //   - one request per repo, so a page can never fill in more than a few dozen;
  //   - results (including misses) are cached for hours per repo;
  //   - when GitHub reports the limit as exhausted, enrichment stops until the
  //     window resets instead of burning the shared limit on guaranteed 403s.
  // Stars are decoration — the cards must stay complete without them.
  const repoStatsCache = new Map(); // 'owner/repo' -> { at, data }
  const REPO_STATS_TTL_MS = 6 * 60 * 60 * 1000;
  const REPO_STATS_MAX = 30;
  const REPO_STATS_BUDGET_TTL_MS = 10 * 60 * 1000;   // re-probe the limit every 10 min
  let repoStatsBudget = { at: 0, exhausted: false };

  async function doRepoStats({ repos = [], refresh = false } = {}) {
    const keys = [...new Set((Array.isArray(repos) ? repos : [])
      .map((r) => String(r ?? '').trim())
      .filter((r) => /^[\w.-]+\/[\w.-]+$/.test(r)))]
      .slice(0, REPO_STATS_MAX);
    const now = Date.now();
    const stats = {};
    const stale = [];
    for (const key of keys) {
      const hit = repoStatsCache.get(key);
      if (!refresh && hit && now - hit.at < REPO_STATS_TTL_MS) {
        if (hit.data) stats[key] = hit.data;
      } else {
        stale.push(key);
      }
    }

    // Rate-limited? Serve whatever is cached and say so rather than hammering.
    const budgetExpired = now - repoStatsBudget.at >= REPO_STATS_BUDGET_TTL_MS;
    if (repoStatsBudget.exhausted && !budgetExpired) {
      return { stats, requested: keys.length, cached: stale.length === 0, rateLimited: true };
    }

    if (stale.length) {
      const fetched = await fetchRepoStats(stale.map((key) => {
        const [owner, repo] = key.split('/');
        return { key, owner, repo };
      }));
      for (const key of stale) {
        const data = fetched[key] ?? null;   // negative-cache misses too
        repoStatsCache.set(key, { at: now, data });
        if (data) stats[key] = data;
      }
      // Track the upstream budget so the next open does not retry into a wall.
      if (fetched.rateLimited) {
        repoStatsBudget = { at: now, exhausted: true };
      } else if (Object.keys(fetched).some((k) => k !== 'rateLimited')) {
        repoStatsBudget = { at: now, exhausted: false };
      }
    }
    return {
      stats, requested: keys.length, cached: stale.length === 0,
      ...(repoStatsBudget.exhausted && now - repoStatsBudget.at < REPO_STATS_BUDGET_TTL_MS
        ? { rateLimited: true }
        : {}),
    };
  }

  /**
   * Preview pictures for the market cards.
   *
   * The catalogs publish no screenshots, so the only honest source is the
   * repository itself: its README (real screenshots, where they exist) and
   * GitHub's generated social card (always exists). Both are resolved to URLs
   * here — no bytes are proxied through the plugin — and cached per repo for
   * hours, because a README is up to a megabyte and paging back through the
   * market must not re-download it.
   *
   * Misses are cached too: a repo with neither a README nor a social card is
   * answered once and not asked again until the TTL expires.
   */
  const repoMediaCache = new Map(); // 'owner/repo' -> { at, data }
  const REPO_MEDIA_TTL_MS = 6 * 60 * 60 * 1000;
  const REPO_MEDIA_MAX = 24;

  async function doRepoMedia({ repos = [], refresh = false } = {}) {
    const keys = [...new Set((Array.isArray(repos) ? repos : [])
      .map((r) => String(r ?? '').trim())
      .filter((r) => /^[\w.-]+\/[\w.-]+$/.test(r)))]
      .slice(0, REPO_MEDIA_MAX);
    const now = Date.now();
    const media = {};
    const stale = [];
    for (const key of keys) {
      const hit = repoMediaCache.get(key);
      if (!refresh && hit && now - hit.at < REPO_MEDIA_TTL_MS) {
        media[key] = hit.data;
      } else {
        stale.push(key);
      }
    }
    if (stale.length) {
      const fetched = await collectRepoMedia(stale, { max: stale.length });
      for (const key of stale) {
        const data = fetched.media?.[key] ?? { repo: key, images: [], og: null };
        repoMediaCache.set(key, { at: now, data });
        media[key] = data;
      }
    }
    return { media, requested: keys.length, cached: stale.length === 0 };
  }

  // ---- management tools ----------------------------------------------------
  const jsonOut = { schema: { type: 'json' }, render: renderJson };

  const defs = [
    defineTool({
      name: 'overall_mcp_scan',
      description: 'Rescan well-known host MCP config files (Claude Desktop/Code, Cursor, VS Code, Windsurf, Codex CLI, Gemini CLI) and import new servers into the overall MCP registry. Existing entries are never overwritten.',
      parameters: {},
      output: jsonOut,
      execute: () => doScan(),
    }),
    defineTool({
      name: 'overall_mcp_list',
      description: 'List all servers in the overall MCP registry with transport, source, enabled and live connection state.',
      parameters: {},
      output: jsonOut,
      async execute() {
        return { servers: publicList() };
      },
    }),
    defineTool({
      name: 'overall_mcp_search',
      description: 'Search public open MCP server catalogs (official modelcontextprotocol registry, Smithery, Docker MCP Catalog, awesome-remote-mcp-servers, awesome-mcp-servers) by keyword and return installable candidates.',
      parameters: {
        query: { type: 'string', required: true, description: 'Search keywords, e.g. "github" or "postgres".' },
      },
      output: jsonOut,
      async execute({ query }) {
        return await searchOpenCatalogs(query);
      },
    }),
    defineTool({
      name: 'overall_mcp_install',
      description: 'Install one MCP server from catalog search results (pass the exact item object from overall_mcp_search) and connect it immediately. Its tools appear as mcp__<name>__<tool>.',
      parameters: {
        item: { type: 'json', required: true, description: 'One catalog item object exactly as returned by overall_mcp_search.' },
      },
      output: jsonOut,
      async execute({ item }) {
        return await doInstall(item);
      },
    }),
    defineTool({
      name: 'overall_mcp_set_enabled',
      description: 'Enable or disable one registry server. Disabling disconnects it (its tools disappear); enabling reconnects it.',
      parameters: {
        name: { type: 'string', required: true },
        enabled: { type: 'boolean', required: true },
      },
      output: jsonOut,
      async execute({ name, enabled }) {
        return await doSetEnabled(name, enabled);
      },
    }),
    defineTool({
      name: 'overall_mcp_set_source_enabled',
      description: 'Enable or disable every server imported from one source (the source-group switch shown in the settings page), e.g. source "claude-desktop" or "catalog:smithery".',
      parameters: {
        source: { type: 'string', required: true, description: 'Import source id, as shown by overall_mcp_list.' },
        enabled: { type: 'boolean', required: true },
      },
      output: jsonOut,
      async execute({ source, enabled }) {
        return await doSetSourceEnabled(source, enabled);
      },
    }),
    defineTool({
      name: 'overall_mcp_catalog',
      description: 'Browse the MCP marketplaces (official modelcontextprotocol registry, Smithery, Docker MCP Catalog, awesome-remote-mcp-servers, awesome-mcp-servers) for currently available MCP servers. Works without a query (top listings) and marks which entries are already installed.',
      parameters: {
        query: { type: 'string', description: 'Optional keyword filter, e.g. "database".' },
        limit: { type: 'integer', description: 'Maximum items to return (default 400).' },
        source: { type: 'string', description: 'Optional single source: official-registry | smithery | docker-catalog | awesome-remote | awesome-list.' },
        refresh: { type: 'boolean', description: 'Force a fresh fetch instead of the 10-minute cache.' },
      },
      output: jsonOut,
      async execute(args) {
        return await doBrowse(args ?? {});
      },
    }),
    defineTool({
      name: 'overall_mcp_check_updates',
      description: 'Check every enabled registry server for a newer published version (npm / PyPI). Only entries launched through npx/uvx can be checked.',
      parameters: {},
      output: jsonOut,
      execute: () => doCheckUpdates(),
    }),
    defineTool({
      name: 'overall_mcp_update',
      description: 'Update one registry server to its latest published version (repins the package argument) and reconnect it.',
      parameters: {
        name: { type: 'string', required: true },
      },
      output: jsonOut,
      async execute({ name }) {
        return await doUpdate(name);
      },
    }),
    defineTool({
      name: 'overall_mcp_remove',
      description: 'Remove one server from the overall MCP registry and disconnect it.',
      parameters: {
        name: { type: 'string', required: true },
      },
      output: jsonOut,
      async execute({ name }) {
        return await doRemove(name);
      },
    }),
  ];

  const disposers = defs.map((d) => ctx.tools.register(d));

  // ---- browser/desktop UI API (Connection-authenticated fetch routes) ------
  // Same-origin `/api/...` requests ride Connection's authentication fence
  // (browser session cookie), identical to dsh-client-ui-deliverables.
  ctx.inject(['connection'], (connCtx) => {
    const json = (value, status = 200) => new Response(JSON.stringify(value), {
      status,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    });
    const guard = (fn) => async (request) => {
      try { return await fn(request); }
      catch (err) { return json({ error: String(err?.message ?? err) }, 400); }
    };
    const readBody = async (request) => {
      try { return await request.json(); } catch { return {}; }
    };

    const routes = [
      ['/api/overall-mcp/servers', ['GET'], guard(async () => json({ servers: publicList() }))],
      ['/api/overall-mcp/scan', ['GET', 'POST'], guard(async () => json(await doScan()))],
      ['/api/overall-mcp/search', ['POST'], guard(async (req) => {
        const { query } = await readBody(req);
        if (typeof query !== 'string' || !query.trim()) return json({ error: 'query required' }, 400);
        return json(await searchOpenCatalogs(query));
      })],
      ['/api/overall-mcp/catalog', ['GET', 'POST'], guard(async (req) => {
        let body = {};
        if (req.method === 'POST') body = await readBody(req);
        const url = new URL(req.url);
        const query = typeof body.query === 'string' ? body.query : (url.searchParams.get('query') ?? '');
        const source = typeof body.source === 'string' ? body.source : (url.searchParams.get('source') ?? '');
        const limitRaw = body.limit ?? url.searchParams.get('limit');
        // Upstream cost is identical regardless of limit (the full READMEs are
        // parsed either way), so the cap only bounds the localhost payload;
        // 10000 admits the entire merged market (~5.4k items, ~2MB JSON).
        const limit = Math.min(Math.max(Number(limitRaw) || 400, 1), 10000);
        const refresh = body.refresh === true || url.searchParams.get('refresh') === '1';
        return json(await doBrowse({ query, source, limit, refresh }));
      })],
      ['/api/overall-mcp/repo-stats', ['GET', 'POST'], guard(async (req) => {
        let body = {};
        if (req.method === 'POST') body = await readBody(req);
        return json(await doRepoStats(body ?? {}));
      })],
      // Preview pictures for the market cards: README screenshots where they
      // exist, GitHub's own social card otherwise. URLs only — the client
      // loads them through a resize proxy, exactly like the plugin market.
      ['/api/overall-mcp/repo-media', ['GET', 'POST'], guard(async (req) => {
        let body = {};
        if (req.method === 'POST') body = await readBody(req);
        return json(await doRepoMedia(body ?? {}));
      })],
      ['/api/overall-mcp/install', ['POST'], guard(async (req) => {
        const { item } = await readBody(req);
        if (!item || typeof item !== 'object') return json({ error: 'item required' }, 400);
        return json(await doInstall(item));
      })],
      // Bookmark a market entry. The listing is annotated on every read, so the
      // next browse reflects the new state; the page also patches its own copy
      // so the star flips without a 2 MB re-fetch.
      ['/api/overall-mcp/favorite', ['POST'], guard(async (req) => {
        const { key } = await readBody(req);
        return json(await doToggleFavorite({ key }));
      })],
      ['/api/overall-mcp/set-enabled', ['POST'], guard(async (req) => {
        const { name, enabled } = await readBody(req);
        if (typeof name !== 'string' || typeof enabled !== 'boolean') return json({ error: 'name (string) and enabled (boolean) required' }, 400);
        return json(await doSetEnabled(name, enabled));
      })],
      ['/api/overall-mcp/set-source-enabled', ['POST'], guard(async (req) => {
        const { source, enabled } = await readBody(req);
        if (typeof source !== 'string' || typeof enabled !== 'boolean') return json({ error: 'source (string) and enabled (boolean) required' }, 400);
        return json(await doSetSourceEnabled(source, enabled));
      })],
      ['/api/overall-mcp/updates', ['GET', 'POST'], guard(async () => {
        // Both kinds of "is something newer?" in one answer: the mounted MCP
        // servers (`entries`) and this plugin itself (`self`).
        const result = await doCheckUpdates();
        return json({ ...result, self: await doCheckSelfUpdate() });
      })],
      ['/api/overall-mcp/self', ['GET'], guard(async () => json(await doCheckSelfUpdate()))],
      ['/api/overall-mcp/self-update', ['POST'], guard(async () => json(await doSelfUpdate()))],
      ['/api/overall-mcp/update', ['POST'], guard(async (req) => {
        const { name } = await readBody(req);
        if (typeof name !== 'string') return json({ error: 'name required' }, 400);
        return json(await doUpdate(name));
      })],
      ['/api/overall-mcp/remove', ['POST'], guard(async (req) => {
        const { name } = await readBody(req);
        if (typeof name !== 'string') return json({ error: 'name required' }, 400);
        return json(await doRemove(name));
      })],
      // Diagnostic: the schemas actually registered for mcp__* tools. Lets the
      // settings page (or a maintainer) confirm a provider-hostile pattern was
      // repaired rather than shipped to the model API.
      ['/api/overall-mcp/tools', ['GET'], guard(async () => {
        const schemas = typeof ctx.tools?.schemas === 'function' ? ctx.tools.schemas() : [];
        const mine = schemas
          .filter((s) => typeof s?.name === 'string' && s.name.startsWith('mcp__'))
          .map((s) => ({
            name: s.name,
            patterns: collectPatterns(s.parameters),
          }));
        return json({ count: mine.length, tools: mine });
      })],
    ];
    for (const [routePath, methods, handler] of routes) {
      connCtx.connection.fetch.register({
        path: routePath,
        methods: [...methods],
        requestBody: 'buffered',
        fetch: handler,
      });
    }
  });

  // Startup connections happen inside apply (cordis has no separate 'ready'
  // event; async apply IS the startup path, same as dsh-mcp-client itself).
  const startup = await connectEnabled();
  if (startup.some((r) => !r.ok)) {
    log?.warn?.(`some servers failed to connect: ${startup.filter((r) => !r.ok).map((r) => r.name).join(', ')}`);
  }

  ctx.effect(() => () => {
    for (const dispose of disposers) dispose();
    for (const fiber of fibers.values()) {
      Promise.resolve(fiber.dispose()).catch(() => {});
    }
    fibers.clear();
  }, 'overall-mcp.cleanup');
}
