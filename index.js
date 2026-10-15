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
import { describeAbout, toolNamesFor, aboutSourceLabel, needsInstructionsRead } from './lib/about.js';
import { scanHost, mergeIntoRegistry, scannedSources, findOrphans, setMountHolder, clearMountHolder } from './lib/scanner.js';
import { browseCatalog, catalogItemToEntry, fetchRepoStats } from './lib/catalog.js';
import { createCatalogCache } from './lib/catalog-cache.js';
import {
  SOURCES_MAX, addSourceTo, readSourcesDocument, removeSourceFrom, sourcesDocumentOf,
} from './lib/custom-sources.js';
import {
  readInstalls, writeInstalls, recordInstallIn, installKeyOf,
  localInstallsOf, localLastInstallOf,
} from './lib/installs.js';
import { collectRepoMedia } from './lib/media.js';
import { httpStatusFor } from './lib/http-status.js';
import { sanitizeToolDefinition } from './lib/schema-guard.js';
import { checkAllUpdates, checkDescribesEntry, checkEntryUpdate, parsePackageInvocation, pinArgs } from './lib/updates.js';
import { checkSelfUpdate, updateSelf } from './lib/self-update.js';

export const name = 'overall-mcp';
export const inject = ['tools'];

const REGISTRY_VERSION = 1;
const SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;
/** Bounded readiness wait for one mcp-client mount (see connect()). */
const CONNECT_WAIT_MS = 8000;

function dataDir() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  return path.join(home, 'overall-mcp');
}

/**
 * Write through a temp file + rename, so a crash mid-write cannot leave a
 * half-written document where a parseable one used to be. `lib/installs.js`
 * already did this for the install counter; the registry — the one file whose
 * silent loss unmounts every server — was still written in place.
 */
async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(value, null, 2), 'utf8');
  await fs.rename(tmp, file);
}

/**
 * Read the registry, keeping three cases apart that used to collapse into one
 * `null`: no file at all (a real first run), a file that does not parse or does
 * not look like a registry (damaged — the caller quarantines the bytes and says
 * so), and a valid document.
 */
async function readRegistryDocument(file) {
  let raw;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch (err) {
    if (err?.code === 'ENOENT') return { registry: null, damaged: null };
    return { registry: null, damaged: String(err?.message ?? err) };
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.servers)) {
      return { registry: null, damaged: 'JSON 里没有 servers 数组' };
    }
    return { registry: parsed, damaged: null };
  } catch (err) {
    return { registry: null, damaged: String(err?.message ?? err) };
  }
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
  // Installs made from this panel, counted locally (lib/installs.js). The
  // sources publish their own usage figures; neither counts our installs, and
  // the user asked for them (「下载量以后从我们市场下载的也要统计一下」).
  const installsFile = path.join(dir, 'installs.json');
  let installs = await readInstalls(installsFile);

  // User-added catalogue sources (lib/custom-sources.js). Same treatment as the
  // registry: a damaged file is quarantined and reported rather than silently
  // treated as "no sources yet" and then overwritten.
  const sourcesFile = path.join(dir, 'sources.json');
  const loadedSources = await readSourcesDocument(sourcesFile, (file, enc) => fs.readFile(file, enc));
  let customSources = loadedSources.sources;
  let sourcesLoadError = null;
  if (loadedSources.damaged) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backup = `${sourcesFile}.corrupt-${stamp}`;
    try { await fs.copyFile(sourcesFile, backup); } catch { /* keep going: reporting beats failing */ }
    sourcesLoadError = `自定义目录源文件无法解析（${loadedSources.damaged}），本次以空列表启动；原文件已备份为 ${path.basename(backup)}`;
    log?.warn?.(`overall-mcp: ${sourcesLoadError}`);
  }

  /** Persist the custom source list (temp file + rename, like every document here). */
  async function saveSources() {
    await writeJson(sourcesFile, sourcesDocumentOf(customSources));
  }

  const loaded = await readRegistryDocument(registryFile);
  let registry = loaded.registry;
  // A damaged file is not a first run: the difference matters, because treating
  // it as one and then saving would overwrite the only copy of the user's
  // servers with an empty document. The bytes are quarantined first, and the
  // reason is carried into every payload so the panel can say what happened.
  let registryLoadError = null;
  if (loaded.damaged) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backup = `${registryFile}.corrupt-${stamp}`;
    try { await fs.copyFile(registryFile, backup); } catch { /* keep going: reporting beats failing */ }
    registryLoadError = `注册表文件无法解析（${loaded.damaged}），本次以空注册表启动；原文件已备份为 ${path.basename(backup)}`;
    log?.warn?.(`overall-mcp: ${registryLoadError}`);
  }
  const firstRun = registry === null && loaded.damaged === null;
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
   * One promise chain per plugin instance, for every action that reads the whole
   * registry, awaits something slow (a scan of the host, an `npx` mount, a
   * registry lookup) and then writes the document back.
   *
   * Two such actions interleaving means the later `save()` writes a snapshot
   * taken before the earlier one's change: a scan that started before an install
   * — or a 「检查更新」 verdict that landed while a row was being removed — used
   * to be able to drop it. The queue makes the read-modify-write pairs atomic
   * with respect to each other; plain reads (the server list, the catalogue) do
   * not hold the queue and stay parallel.
   */
  let mutationQueue = Promise.resolve();
  function serialized(fn) {
    return (...args) => {
      const run = mutationQueue.then(() => fn(...args), () => fn(...args));
      mutationQueue = run.then(() => {}, () => {});
      return run;
    };
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
  async function connect(entry) {
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
      new Promise((resolve) => { setTimeout(() => { timedOut = true; resolve(); }, CONNECT_WAIT_MS); }),
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
    // Exactly one row per name may carry the mount marker: `fibers` is keyed by
    // name, so the row that mounted owns the name and every sibling gives the
    // mark up (see lib/scanner.js setMountHolder).
    setMountHolder(registry.servers, entry.name, entry, serverName);
    entry.connectError = undefined;
    entry.providedExternally = false;
    if (timedOut) {
      // Keep the fiber and let it finish in the background; a later
      // `overall_mcp_list` / page refresh shows the settled state.
      fiber.await().then(
        () => log?.info?.(`overall-mcp: ${entry.name} finished connecting in the background`),
        async (err) => {
          entry.connectError = String(err?.message ?? err);
          // The 8 s deadline only deferred this failure. Leaving the fiber in
          // the map made it permanent: every retry path asks `fibers.has(name)`
          // first (syncFiber, 停用→启用, doScan), so the row kept reporting
          // 已连接 while no tools existed and only 更新 or a plugin restart
          // could repair it.
          if (fibers.get(entry.name) === fiber) {
            fibers.delete(entry.name);
            clearMountHolder(registry.servers, entry.name);
            try { await fiber.dispose(); } catch { /* already gone */ }
          }
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
    // Nothing is mounted for this name any more, so no row of it may keep
    // claiming the mount that findOrphans() protects.
    clearMountHolder(registry.servers, name);
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
    const orphans = new Set(orphanEntries());
    return registry.servers.map((s, slot) => {
      const enabled = s.enabled !== false;
      const connected = fibers.has(s.name);
      const providedExternally = !connected && s.providedExternally === true;
      const status = s.connectError ? 'error'
        : providedExternally ? 'provided-externally'
          : connected ? 'connected'
            : enabled ? 'idle' : 'stopped';
      // A stored verdict describes the entry as it was written, not as it is now.
      // If this entry's pinned version has moved since (a re-import from the
      // client's config, a hand edit), the badge belongs to a different launch
      // and advertising it would offer an update the entry already runs. See
      // checkDescribesEntry().
      const stored = s.updateCheck ?? null;
      const describesThisEntry = checkDescribesEntry(s, stored);
      return {
        name: s.name,
        // Position in the registry. Two rows can share a name (one client config
        // may define the same server twice), so anything that has to act on "the
        // row that was clicked" needs a per-row identity, not a name.
        slot,
        transport: s.transport,
        source: s.source,
        // The last scan read this entry's source and it no longer defines a
        // server by this name: the row is a leftover, not a config anyone has.
        orphan: orphans.has(s),
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
        updateAvailable: describesThisEntry && stored.updateAvailable === true,
        update: describesThisEntry ? stored : null,
        updatedAt: s.updatedAt,
        // 「这个 MCP 是干什么的」: the sentence shown after the name. Null until
        // refreshAbout() has something honest to say.
        about: s.about ?? null,
        aboutAt: s.aboutAt,
        aboutLabel: s.about ? aboutSourceLabel(s.about.source) : '',
      };
    });
  }

  // ---- 「这个 MCP 是干什么的」 ------------------------------------------------
  //
  // A registered row should explain the server, not just its transport. The
  // authoritative source is the server's own `instructions` from the MCP
  // `initialize` result: dsh-mcp-client publishes them verbatim as the
  // system-prompt section `mcp:<serverName>`, so assembling the prompt once and
  // reading those sections back gives the server's own words. Two fallbacks keep
  // the line useful when that is empty: the server's registered tools, and —
  // before a first successful connect — the launch command.
  //
  // The assembled prompt is not read on every payload: `instructionGen` records
  // whether the server was live the last time we looked, so a server that has
  // since connected (or dropped) is re-read exactly once, and a live server is
  // re-read only when its about line is due for its 30s retry.

  /** serverName → instructions text (verbatim, as published by dsh-mcp-client). */
  const instructionSections = new Map();
  /** serverName → 'live' | 'down' at the moment we last read its section. */
  const instructionGen = new Map();
  let instructionsRead = false;
  /** A line built from tools/command is retried at most this often per server. */
  const ABOUT_RETRY_MS = 30 * 1000;

  /**
   * Assemble the system prompt and return its `mcp:*` sections.
   *
   * `systemPrompt` is injected rather than assumed: on a host without it the
   * promise resolves to null and every server falls back to its tools/command.
   * Bounded, because a provider that never settles must not stall the page, and
   * released as soon as the read is over — a one-shot injection that outlived its
   * read would keep the whole prompt assembly scope alive for the session.
   */
  function readInstructionSections() {
    return new Promise((resolve) => {
      let settled = false;
      let dispose = null;
      const timer = setTimeout(() => finish(null), 2500);
      timer.unref?.();
      function finish(value) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        // The service reference we already took stays valid after dispose; only
        // the reactive scope goes away.
        if (typeof dispose === 'function') {
          try { dispose(); } catch { /* scope already gone */ }
        }
        resolve(value);
      }
      try {
        const maybeDispose = ctx.inject(['systemPrompt'], (inner) => {
          Promise.resolve()
            .then(() => inner.systemPrompt?.assemble?.({}))
            .then((assembly) => {
              const found = new Map();
              for (const section of assembly?.sections ?? []) {
                const sectionName = typeof section?.name === 'string' ? section.name : '';
                if (sectionName.startsWith('mcp:')) {
                  found.set(sectionName.slice(4), String(section?.text ?? ''));
                }
              }
              finish(found);
            }, () => finish(null));
        });
        if (typeof maybeDispose === 'function') dispose = maybeDispose;
        // A synchronous callback can settle before `inject` hands back its
        // disposer, in which case `finish` above saw a null one.
        if (settled && typeof dispose === 'function') {
          try { dispose(); } catch { /* scope already gone */ }
        }
      } catch {
        finish(null);
      }
    });
  }

  const serverIsLive = (s) => fibers.has(s.name) || s.providedExternally === true;
  const aboutGen = (s) => (serverIsLive(s) ? 'live' : 'down');

  function aboutIsCurrent(s, now) {
    if (!s.about?.text) return false;
    if (s.about.source === 'server') return true;
    // Tools/command lines are placeholders: retry while the server is live, at
    // most once per ABOUT_RETRY_MS, so a stopped server stops costing anything.
    if (!serverIsLive(s)) return false;
    const at = Date.parse(s.aboutAt ?? '');
    return Number.isFinite(at) && now - at < ABOUT_RETRY_MS;
  }

  /** Fill in (or upgrade) the purpose line for every server that needs one. */
  async function refreshAbout() {
    const now = Date.now();
    const pending = registry.servers.filter((s) => s.enabled !== false && !aboutIsCurrent(s, now));
    if (!pending.length) return false;

    const wanted = pending.map((s) => ({ s, name: s.serverName ?? toServerName(s.name) }));
    // Read again when we have never read, or when this server's liveness changed
    // since we did: a section only appears once dsh-mcp-client connects, so a
    // "not connected yet" answer must not be cached as final.
    const stale = wanted.some(({ s, name }) => needsInstructionsRead({
      read: instructionsRead, rememberedGen: name ? instructionGen.get(name) : undefined,
      live: serverIsLive(s), name,
    }));
    if (stale) {
      const sections = await readInstructionSections();
      instructionsRead = true;
      if (sections) {
        for (const [sectionName, text] of sections) {
          instructionSections.set(sectionName, text);
          instructionGen.set(sectionName, 'live');
        }
      }
      for (const { s, name } of wanted) if (name) instructionGen.set(name, aboutGen(s));
    }

    const schemas = typeof ctx.tools?.schemas === 'function' ? ctx.tools.schemas() : [];
    let changed = false;
    for (const { s, name } of wanted) {
      const about = describeAbout({
        instructions: name ? instructionSections.get(name) : '',
        toolNames: toolNamesFor(schemas, name),
        command: s.transport === 'stdio' || !s.transport
          ? [s.command, ...(s.args ?? [])]
          : [s.url],
      });
      if (!about) continue;
      s.about = about;
      s.aboutAt = new Date(now).toISOString();
      changed = true;
    }
    if (changed) {
      await save();
      // One line per change, so the source that actually supplied each server's
      // sentence is checkable from the harness log instead of guessed at.
      const tally = {};
      for (const s of registry.servers) if (s.about) tally[s.about.source] = (tally[s.about.source] ?? 0) + 1;
      log?.info?.(`overall-mcp: purpose lines — ${Object.entries(tally).map(([k, v]) => `${k} ${v}`).join(', ')}`);
    }
    return changed;
  }

  /**
   * Every payload that carries the server list goes through here, so a row's
   * purpose line is present (or upgraded) by the time the client renders it.
   * Cheap when nothing needs refreshing: refreshAbout() then returns at once.
   *
   * A damaged registry file rides along as `registryError` (see
   * `readRegistryDocument`): the panel would otherwise show an empty list that
   * looks exactly like "you have never added a server".
   */
  async function serversPayload() {
    await refreshAbout();
    const servers = publicList();
    return { servers, ...(registryLoadError ? { registryError: registryLoadError } : {}) };
  }

  // First install: scan well-known host MCP configs and import them.
  // Contained: a scan failure must never fail this plugin's activation.
  if (firstRun) {
    try {
      const { found, report } = await scanHost({});
      const merged = mergeIntoRegistry(registry, found);
      registry = merged.registry;
      recordScan(report);
      await save();
      await writeJson(reportFile, { scannedAt: new Date().toISOString(), report });
      log?.info?.(`first-run scan imported ${merged.added.length} servers (skipped ${merged.skipped.length})`);
    } catch (err) {
      log?.warn?.(`overall-mcp: first-run scan failed: ${String(err?.message ?? err)}`);
    }
  }

  // ---- shared management actions (used by model tools AND /api routes) ----

  /**
   * What the last scan actually read, kept on the registry so the panel can
   * still tell a removed entry from an unread file after a restart.
   *
   * `mergeIntoRegistry` returns a fresh object, so this must be assigned to the
   * merged registry rather than to the one that was passed in.
   */
  function recordScan(report) {
    const { sources, unreadable } = scannedSources(report);
    registry.scanned = { at: new Date().toISOString(), sources, unreadable };
  }

  /** Entries the last scan proved are gone (see lib/scanner.js findOrphans). */
  function orphanEntries() {
    return findOrphans(registry, registry.scanned);
  }

  async function doScanImpl() {
    const { found, report } = await scanHost({});
    const merged = mergeIntoRegistry(registry, found);
    registry = merged.registry;
    recordScan(report);
    await save();
    await writeJson(reportFile, { scannedAt: new Date().toISOString(), report });
    const connected = [];
    for (const name of merged.added) {
      const entry = registry.servers.find((s) => s.name === name);
      if (entry && entry.enabled !== false) connected.push({ name, ...(await connect(entry)) });
    }
    return {
      added: merged.added,
      skipped: merged.skipped,
      connected,
      scannedFiles: report.length,
      orphans: orphanEntries().map((s) => s.name),
    };
  }

  async function doInstallImpl(item, { overwrite = false } = {}) {
    const entry = catalogItemToEntry(item);
    if (!entry) throw new Error('item has no installable transport (stdio command or http url)');
    const i = registry.servers.findIndex((s) => s.name === entry.name);
    if (i >= 0) {
      const existing = registry.servers[i];
      // A hand-added row is the user's own configuration — `mergeIntoRegistry`
      // refuses to overwrite it too, and an install must not be the one path
      // that silently replaces its command, env and notes with a catalogue
      // entry. Replacement needs an explicit `overwrite`.
      if (!overwrite && (!existing.source || existing.source === 'manual')) {
        throw new Error(`manual entry ${entry.name}: 这是手工添加的记录，安装不会覆盖它；请先移除它，或带 overwrite=true 明确替换`);
      }
      await disconnect(entry.name);
      registry.servers[i] = entry;
    } else registry.servers.push(entry);
    await save();
    // Mount first, count second: a row whose mount failed is in the registry
    // (the user can retry) but serves nothing, and counting it would make
    // 「本市场 N 次」 claim installs that never ran.
    const conn = entry.enabled !== false ? await connect(entry) : { ok: true, deferred: true };
    let record = null;
    if (conn.ok !== false) {
      const installKey = installKeyOf(item, entry.name);
      record = recordInstallIn(installs, { key: installKey, name: entry.name });
      if (record) await writeInstalls(installsFile, installs);
    } else {
      log?.warn?.(`overall-mcp: ${entry.name} was added to the registry but did not mount, so it is not counted as an install`);
    }
    return {
      installed: entry.name,
      localInstalls: record?.count ?? localInstallsOf(installs, item, entry.name),
      servers: (await serversPayload()).servers,
      connect: conn,
      ...(conn.ok === false ? {
        counted: false,
        note: `${entry.name} 已写入注册表，但挂载没有成功，因此没有计入本市场安装数；修好后可用「更新」或重新启用来重试。`,
      } : {}),
    };
  }

  // ---- mutations ------------------------------------------------------------
  // A `providedExternally` entry is one that another mcp-client mount already
  // serves under the same DSH server name (see `connect`): this plugin skipped
  // mounting its own copy, so it owns no fiber for it and *cannot* stop those
  // tools. `overall_mcp_list` already reports that as `status:
  // "provided-externally"`; these mutations must not claim otherwise, so each
  // one that touched such an entry says so in its reply.
  const externallyProvided = (entry) => entry?.providedExternally === true;

  /**
   * Resolve one registry row for a row action.
   *
   * The panel addresses rows by `slot` (their position in the list it rendered)
   * because names are not unique here. A config that defined `rea` while an
   * entry named `rea` already existed left three `rea-cursor` rows behind
   * (the old merge renamed a conflicting import to `name-<source>`), and every
   * name-keyed action then hit the first match: 移除 on row 7 removed row 2, and
   * one row's version verdict was written onto another. `from` (the version the
   * row displayed) is a fallback for a client that rendered before slots
   * existed. A name that still matches several rows is an error rather than a
   * guess, because acting on the wrong row deletes real bookkeeping — every row
   * action (enable, update, remove, and the MCP tools) goes through here, so
   * none of them can silently take the first twin.
   */
  function resolveEntry(name, { slot = null, from = null } = {}) {
    const matches = registry.servers.filter((s) => s.name === name);
    if (matches.length === 0) throw new Error(`unknown server: ${name}`);
    if (Number.isInteger(slot)) {
      const at = registry.servers[slot];
      if (at && at.name === name) return at;
    }
    if (from != null) {
      const byVersion = matches.find((s) => (parsePackageInvocation(s)?.version ?? null) === from);
      if (byVersion) return byVersion;
    }
    if (matches.length === 1) return matches[0];
    throw new Error(`ambiguous server name: ${name}（${matches.length} 条同名记录）；请带上 slot`);
  }

  /**
   * Make the fiber for one name match the registry: it exists while at least one
   * non-disabled row with that name does.
   *
   * `fibers` is keyed by serverName (one mcp-client mount per name), so duplicate
   * rows never had their own fiber — only the first one connected and the rest
   * reported `already-provided`. Acting on "the entry" therefore cannot just
   * disconnect the name (that would take the tools away while an enabled row
   * still claims them) nor just connect (the name may be mounted already).
   */
  async function syncFiber(name) {
    const rows = registry.servers.filter((s) => s.name === name);
    const wanted = rows.find((s) => s.enabled !== false) ?? null;
    if (!wanted) return disconnect(name);
    if (!fibers.has(name)) await connect(wanted);
  }

  async function doSetEnabledImpl(name, enabled, { slot = null, from = null } = {}) {
    const entry = resolveEntry(name, { slot, from });
    entry.enabled = enabled;
    await save();
    await syncFiber(name);
    // `enabled: false` still means "this plugin should not mount it"; on a
    // provided-externally entry that was already true, so nothing observable
    // changes and the reply must say so rather than read as "已停用".
    return {
      name,
      enabled,
      connected: fibers.has(name),
      ...(externallyProvided(entry) ? {
        providedExternally: true,
        stillProvided: true,
        note: `${name} 的工具由另一个 mcp-client 挂载提供，本插件从未挂载它：停用只记录本插件的意图，那些工具不会消失。`,
      } : {}),
    };
  }

  /** Bulk enable/disable every server imported from one source (group switch). */
  async function doSetSourceEnabledImpl(source, enabled) {
    const targets = registry.servers.filter((s) => (s.source ?? 'manual') === source);
    if (targets.length === 0) throw new Error(`unknown source: ${source}`);
    for (const entry of targets) entry.enabled = enabled;
    await save();
    // Per *name*, not per row: the same name can be claimed by rows from other
    // sources, and its fiber must exist while ANY enabled row still wants it.
    // The old loop disconnected every target name and reconnected only the rows
    // this source owns, so switching one source off could take the tools away
    // from a same-named row that still had 「启用」 on.
    for (const name of new Set(targets.map((s) => s.name))) await syncFiber(name);
    const external = targets.filter(externallyProvided).length;
    return {
      source,
      enabled,
      changed: targets.length,
      ...(external ? {
        externallyProvided: external,
        note: `其中 ${external} 台由另一个 mcp-client 挂载提供，本插件的开关不影响它们已经挂载的工具。`,
      } : {}),
      ...(await serversPayload()),
    };
  }

  async function doRemoveImpl(name, { slot = null, from = null } = {}) {
    const entry = resolveEntry(name, { slot, from });
    const external = externallyProvided(entry);
    // `resolveEntry` always hands back a row of the live registry, so this is a
    // guard against a future call path rather than a live case — but the failure
    // it prevents is the worst one in this file: `splice(-1, 1)` deletes the LAST
    // row of the registry instead of the intended one, silently, and the caller
    // still gets `removed: <name>` back.
    const at = registry.servers.indexOf(entry);
    if (at < 0) throw new Error(`stale entry: ${name}（注册表已变化，请刷新后重试）`);
    registry.servers.splice(at, 1);
    await save();
    // Removing one row of a duplicated name leaves the name mounted as long as
    // another enabled row still claims it — and unmounts it when this was the
    // last one — instead of keying off whichever row happened to hold the fiber.
    await syncFiber(name);
    // Removing a *provided-externally* record deletes this plugin's bookkeeping
    // only; the other mount keeps the tools alive, and the panel must not imply
    // otherwise.
    return {
      removed: name,
      ...(external ? {
        providedExternally: true,
        stillProvided: true,
        note: `${name} 已从本插件的注册表移除；它的工具仍由另一个 mcp-client 挂载提供，不会消失。`,
      } : {}),
      ...(await serversPayload()),
    };
  }

  /**
   * Drop the rows the last scan proved are gone.
   *
   * These are leftovers of the old `name-<source>` rename in the scanner:
   * nothing on this machine defines them any more, yet they still counted as
   * servers, answered to their name for row actions, and (the first of them)
   * held the fiber for that name while the others sat inert. Only rows the scan
   * *proved* orphaned are removed — a source that could not be read is never
   * treated as empty, and a hand-added entry is never touched (see
   * lib/scanner.js findOrphans).
   */
  async function doForgetOrphansImpl() {
    const orphans = orphanEntries();
    if (orphans.length === 0) return { removed: [], count: 0, ...(await serversPayload()) };
    // findOrphans excludes rows that hold a mount, so no fiber can be touched
    // here: these are pure bookkeeping rows. The one `rea-cursor` row that does
    // serve tools is never in this list, however few config files mention it.
    const gone = new Set(orphans);
    const names = [...new Set(orphans.map((s) => s.name))];
    const removed = orphans.map((s) => ({
      name: s.name,
      source: s.source,
      version: parsePackageInvocation(s)?.version ?? null,
    }));
    registry.servers = registry.servers.filter((s) => !gone.has(s));
    await save();
    log?.info?.(`overall-mcp: forgot ${removed.length} orphaned ${removed.length === 1 ? 'entry' : 'entries'} (${names.join(', ')})`);
    return { removed, count: removed.length, ...(await serversPayload()) };
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

  // No option pass-through here on purpose: `/self` and the `self` field of
  // `/updates` are documented as memoized for 10 minutes (README.zh-CN.md), and
  // the only caller that must bypass the memo is `updateSelf()`, which passes
  // `force: true` itself.
  const doCheckSelfUpdate = () => checkSelfUpdate({ moduleUrl: import.meta.url, cache: selfUpdateCache });

  const doSelfUpdate = () => updateSelf({ moduleUrl: import.meta.url });

  async function doCheckUpdatesImpl() {
    const entries = registry.servers.filter((s) => s.enabled !== false);
    const result = await checkAllUpdates(entries);
    // Write each verdict back to the entry it was computed FROM, positionally.
    // Matching by name once stamped one entry with a verdict computed from a
    // different one: a config that defines the same server twice produced four
    // results for one name, all of them landing on the first entry, which then
    // advertised a version it did not run while the others kept none at all.
    result.entries.forEach((check, i) => {
      const entry = entries[i];
      if (!entry) return;
      entry.updateCheck = check.detectable
        ? { at: new Date().toISOString(), current: check.current, latest: check.latest, updateAvailable: check.updateAvailable, error: check.error }
        : { at: new Date().toISOString(), detectable: false, reason: check.reason };
    });
    await save();
    return { ...result, ...(await serversPayload()) };
  }

  /**
   * Update one registry entry.
   *
   * `slot` names the exact row the click came from; `from` is the version that
   * row was showing. Either one resolves the entry when two rows share a name —
   * without them, clicking the 6.1.0 row could update its 6.5.0 twin and answer
   * 「无需更新」 about work nobody asked for.
   */
  async function doUpdateImpl(name, { slot = null, from = null } = {}) {
    // Strict on ambiguity — the same rule every other row action uses. It used
    // to fall back to the first match here, which meant an MCP client that only
    // knew the name could update the wrong twin of a duplicated name and report
    // 「无需更新」 about work nobody asked for. The panel always sends the row's
    // slot; an agent can do the same now (`slot`/`from` on overall_mcp_update).
    const entry = resolveEntry(name, { slot, from });
    const check = await checkEntryUpdate(entry);
    if (!check.detectable) throw new Error(`${name} is not launched through a package runner; update it manually`);
    if (check.error) throw new Error(`version lookup failed for ${check.pkg}: ${check.error}`);
    if (!check.updateAvailable) {
      // Nothing to do — but record the answer the same way 检查更新 does.
      // Without this the entry keeps whatever badge the PREVIOUS check left
      // behind, so a stale 「可更新」 (and the client's 「全部更新（N）」 count
      // built from it) outlives the update that already answered it. An
      // unpinned runner resolves to the newest release on every launch, so
      // there is nothing to pin and nothing to advertise either.
      entry.updateCheck = { at: new Date().toISOString(), current: check.current, latest: check.latest, updateAvailable: false };
      await save();
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
  // Reading the market costs two different things, and they are held
  // separately (see `lib/catalog-cache.js`): how often we *ask* a source, and
  // how much we *download* when we do. The first is a 60-second TTL per
  // (source, query); the second is an ETag per URL, so a reread that is due is
  // usually answered 304 instead of shipping the two community READMEs again.
  //
  // `refresh: true` (the panel's 刷新 button) skips the TTL but still sends the
  // validators — a forced refresh should cost a round trip, not 3 MB.
  const catalogCache = createCatalogCache();
  // A search query longer than this is a caller mistake, not a search; the cut
  // keeps one absurd query from occupying a cache entry (and a key) of its own.
  const CATALOG_QUERY_MAX = 200;

  /** Keep a `key -> { at }` map bounded by dropping its oldest entries. */
  function evictOldest(map, max) {
    while (map.size > max) {
      let oldestKey;
      let oldestAt = Infinity;
      for (const [key, value] of map) {
        const at = typeof value?.at === 'number' ? value.at : 0;
        if (at <= oldestAt) { oldestAt = at; oldestKey = key; }
      }
      map.delete(oldestKey);
    }
  }

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
      // Installs made from this panel, so the card can show them next to the
      // upstream's own figure instead of silently mixing the two.
      localInstalls: localInstallsOf(installs, item, name),
      localInstallLastAt: localLastInstallOf(installs, item, name),
    };
  }

  /**
   * Toggle one market entry's favourite, or set it when the caller says which.
   *
   * `key` alone toggles — the panel's star has no other way to express "flip
   * what you have". An optional boolean `on` makes the same route idempotent
   * for callers that do know the state they want (a script, the probe, a future
   * multi-select), which is what a POST to a named resource normally means.
   */
  async function doToggleFavoriteImpl({ key, on } = {}) {
    if (typeof key !== 'string' || !key.trim()) throw new Error('key required');
    if (on !== undefined && typeof on !== 'boolean') throw new Error('on must be a boolean when given');
    const normalized = key.trim().slice(0, 200);
    if (on === true) favorites.add(normalized);
    else if (on === false) favorites.delete(normalized);
    else if (favorites.has(normalized)) favorites.delete(normalized);
    else favorites.add(normalized);
    registry.favorites = [...favorites].sort();
    await save();
    return { key: normalized, favorite: favorites.has(normalized), favorites: registry.favorites };
  }
  async function doBrowse({ query = '', limit = 120, source = '', refresh = false } = {}) {
    const q = typeof query === 'string' ? query.slice(0, CATALOG_QUERY_MAX) : '';
    // The listing is cached RAW: the installed flag depends on the registry and
    // is recomputed on every read, so installing/removing never shows a stale badge.
    const result = await browseCatalog({
      query: q, limit, source, customSources, cache: catalogCache, force: refresh,
    });
    // The panel says how old the listing is; with several sources that can
    // differ, so the age reported is the oldest one still standing.
    const oldest = Object.values(result.sources)
      .map((s) => s.at)
      .filter((at) => typeof at === 'string')
      .sort()[0];
    return {
      items: result.items.map(annotateItem),
      errors: result.errors,
      counts: result.counts,
      sources: result.sources,
      total: result.total,
      // "cached" means every source answered from what we already held — the
      // panel writes the listing's age next to it, so a mixed read must not
      // claim to be one.
      cached: Object.values(result.sources).every((s) => s.cached === true),
      notModified: Object.values(result.sources).reduce((sum, s) => sum + (s.notModified ?? 0), 0),
      fetchedAt: new Date(oldest ?? Date.now()).toISOString(),
      servers: (await serversPayload()).servers,
    };
  }

  /**
   * The user's own catalogue sources, as the panel reads them. The listing is
   * kept out of `/catalog`: it answers "what is on the market", not "what am I
   * pointing at", and the page needs the second before it has a listing at all.
   */
  function sourcesPayload() {
    return {
      sources: customSources.map((s) => ({ id: s.id, label: s.label, url: s.url })),
      max: SOURCES_MAX,
      error: sourcesLoadError,
    };
  }

  /**
   * Add one custom source. A new source must not be served from the cache of a
   * source that used to own this id, so its remembered rows are dropped.
   */
  async function doAddSource({ url, label } = {}) {
    const next = addSourceTo({ version: 1, sources: customSources }, { url, label });
    customSources = next.doc.sources;
    await saveSources();
    catalogCache.forgetSourceId(next.source.id);
    log?.info?.(`overall-mcp: custom source added — ${next.source.label} (${next.source.url})`);
    return { source: next.source, ...sourcesPayload() };
  }

  /** Remove one custom source, dropping whatever the market remembered of it. */
  async function doRemoveSource({ id } = {}) {
    if (typeof id !== 'string' || !id.trim()) throw new Error('id required');
    const { doc, removed } = removeSourceFrom({ version: 1, sources: customSources }, id.trim());
    if (!removed) throw new Error(`unknown source: ${id.trim()}`);
    customSources = doc.sources;
    await saveSources();
    const dropped = catalogCache.forgetSourceId(removed.id);
    log?.info?.(`overall-mcp: custom source removed — ${removed.label} (${dropped} cached result(s) dropped)`);
    return { removed, dropped, ...sourcesPayload() };
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
   * Misses are cached too: a repo the lookup answered — with a README, or with
   * neither a README nor a social card — is not asked again until the TTL
   * expires. A *failure* is different: see `REPO_MEDIA_FAIL_TTL_MS`.
   */
  const repoMediaCache = new Map(); // 'owner/repo' -> { at, data, failed? }
  const REPO_MEDIA_TTL_MS = 6 * 60 * 60 * 1000;
  // A failed lookup is cached, but only briefly. The honest causes are
  // transient (a network blip, or GitHub's rate limit), and reusing the
  // six-hour TTL for the empty result this failure produces would hide a repo's
  // screenshots for the rest of the session — and make them indistinguishable
  // from "this repo has no images".
  const REPO_MEDIA_FAIL_TTL_MS = 5 * 60 * 1000;
  const REPO_MEDIA_MAX = 24;
  // How many repos may stay cached overall (see `evictOldest`). Five pages' worth
  // covers paging back and forth without keeping a session's whole history.
  const REPO_MEDIA_CACHE_MAX = 120;

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
      const ttl = hit?.failed ? REPO_MEDIA_FAIL_TTL_MS : REPO_MEDIA_TTL_MS;
      if (!refresh && hit && now - hit.at < ttl) {
        media[key] = hit.data;
      } else {
        stale.push(key);
      }
    }
    const errors = [];
    if (stale.length) {
      const fetched = await collectRepoMedia(stale, { max: stale.length });
      const failed = new Set((fetched.errors ?? []).map((e) => e.repo));
      for (const key of stale) {
        const data = fetched.media?.[key] ?? { repo: key, images: [], og: null };
        repoMediaCache.set(key, { at: now, data, ...(failed.has(key) ? { failed: true } : {}) });
        media[key] = data;
      }
      // Entries are small (ranked URL lists, never the README bytes), but the key
      // is a repo name that arrives from the caller, so this map is capped too.
      evictOldest(repoMediaCache, REPO_MEDIA_CACHE_MAX);
      // Reported, not swallowed: the caller can then say "配图加载失败" instead of
      // rendering an empty strip as if it were the repo's real answer.
      for (const e of fetched.errors ?? []) errors.push({ repo: e.repo, error: e.error });
    }
    return {
      media,
      requested: keys.length,
      cached: stale.length === 0,
      ...(errors.length ? { errors } : {}),
    };
  }

  // ---- the serialized faces of the mutations -------------------------------
  // Everything below reads the registry, awaits, and writes it back; each of
  // these is the queue's entry point (see `serialized`). Calls between them stay
  // on the `*Impl` names, so a nested call can never wait on a queue slot its
  // own caller is holding. `refreshAbout` is deliberately NOT queued: the read
  // routes call it too, and it only annotates rows.
  const doScan = serialized(doScanImpl);
  const doInstall = serialized(doInstallImpl);
  const doSetEnabled = serialized(doSetEnabledImpl);
  const doSetSourceEnabled = serialized(doSetSourceEnabledImpl);
  const doRemove = serialized(doRemoveImpl);
  const doForgetOrphans = serialized(doForgetOrphansImpl);
  const doCheckUpdates = serialized(doCheckUpdatesImpl);
  const doUpdate = serialized(doUpdateImpl);
  const doToggleFavorite = serialized(doToggleFavoriteImpl);

  // ---- management tools ----------------------------------------------------
  const jsonOut = { schema: { type: 'json' }, render: renderJson };

  const defs = [
    defineTool({
      name: 'overall_mcp_scan',
      description: 'Rescan well-known host MCP config files (Claude Desktop/Code, Cursor, VS Code, Windsurf, Codex CLI, Gemini CLI) and import new servers into the overall MCP registry. An entry keeps its name: a server imported before is updated in place when its command/args/url changed, and an entry the user added by hand is never overwritten (it is reported as skipped). The answer also lists `orphans`: registry entries whose source was read by this scan and no longer defines that name (they mount nothing but still count as servers and answer to their name). Remove them with overall_mcp_forget_orphans.',
      parameters: {},
      output: jsonOut,
      execute: () => doScan(),
    }),
    defineTool({
      name: 'overall_mcp_list',
      description: 'List all servers in the overall MCP registry with transport, source, enabled, live connection state, and whether the entry\'s own source still defines it (orphan: true means no config file read by the last scan contains that name).',
      parameters: {},
      output: jsonOut,
      async execute() {
        return serversPayload();
      },
    }),
    defineTool({
      name: 'overall_mcp_search',
      description: 'Search public open MCP server catalogs (official modelcontextprotocol registry, Smithery, Docker MCP Catalog, awesome-remote-mcp-servers, awesome-mcp-servers) by keyword and return up to 50 installable candidates.',
      parameters: {
        query: { type: 'string', required: true, description: 'Search keywords, e.g. "github" or "postgres".' },
      },
      output: jsonOut,
      async execute({ query }) {
        // Same all-source query the settings page uses, so the agent and the UI
        // rank and dedupe identically; the cap keeps the reply inside a context.
        // Shares the panel's cache: an agent search and a page search of the same
        // words cost one walk between them. The user's own sources are part of
        // "all sources" — an agent that cannot find what they added would be
        // answering a different question than the tab they are looking at.
        return await browseCatalog({ query, limit: 50, customSources, cache: catalogCache });
      },
    }),
    defineTool({
      name: 'overall_mcp_install',
      description: 'Install one MCP server from catalog search results (pass the exact item object from overall_mcp_search) and connect it immediately. Its tools appear as mcp__<name>__<tool>. If another mcp-client mount already serves that DSH server name, this plugin records the entry as provided externally instead of mounting a second copy — the tools are already there. A server name that a hand-added entry already owns is refused; pass overwrite: true to replace that record with the catalogue entry.',
      parameters: {
        item: { type: 'json', required: true, description: 'One catalog item object exactly as returned by overall_mcp_search.' },
        overwrite: { type: 'boolean', description: 'Replace a hand-added entry that already owns this name (default false: refuse instead).' },
      },
      output: jsonOut,
      async execute({ item, overwrite }) {
        return await doInstall(item, { overwrite: overwrite === true });
      },
    }),
    defineTool({
      name: 'overall_mcp_set_enabled',
      description: 'Enable or disable one registry server. Enabling mounts and connects it; disabling unmounts the copy this plugin mounted and disconnects it, so its mcp__<name>__ tools disappear. An entry overall_mcp_list reports as status "provided-externally" is served by a different mcp-client mount that this plugin never mounted: disabling only records the intent, and those tools stay available (the reply carries stillProvided). A name defined more than once is refused unless `slot` picks the row (disabling the wrong row stops real tools).',
      parameters: {
        name: { type: 'string', required: true },
        enabled: { type: 'boolean', required: true },
        slot: { type: 'integer', description: 'Position of the row in the overall_mcp_list answer, to pick one of several same-named entries.' },
        from: { type: 'string', description: 'Version the row displayed (fallback for a client that rendered before slots existed).' },
      },
      output: jsonOut,
      async execute({ name, enabled, slot, from }) {
        return await doSetEnabled(name, enabled, {
          slot: Number.isInteger(slot) ? slot : null,
          from: typeof from === 'string' && from !== '' ? from : null,
        });
      },
    }),
    defineTool({
      name: 'overall_mcp_set_source_enabled',
      description: 'Enable or disable every server imported from one source (the source-group switch shown in the settings page), e.g. source "claude-desktop" or "catalog:smithery". Entries another mcp-client mount already provides are unaffected: the reply reports how many there were (externallyProvided).',
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
      description: 'Update one registry server to its latest published version (repins the package argument) and reconnect it. When several registry entries share a name, pass `slot` (the row position from overall_mcp_list) or `from` (the version that row showed) to name the row; otherwise the name being ambiguous is an error rather than a guess.',
      parameters: {
        name: { type: 'string', required: true },
        slot: { type: 'integer', description: 'Position of the row in the overall_mcp_list answer, to pick one of several same-named entries.' },
        from: { type: 'string', description: 'Version the row displayed (fallback for a client that rendered before slots existed).' },
      },
      output: jsonOut,
      async execute({ name, slot, from }) {
        return await doUpdate(name, {
          slot: Number.isInteger(slot) ? slot : null,
          from: typeof from === 'string' && from !== '' ? from : null,
        });
      },
    }),
    defineTool({
      name: 'overall_mcp_remove',
      description: 'Remove one server from this plugin\'s registry. When this plugin mounted it, the mount is disconnected and its tools disappear. A server that overall_mcp_list reports as status "provided-externally" keeps working: only this plugin\'s registry record is removed (the reply carries stillProvided). A name defined more than once is refused unless `slot` (the row position from overall_mcp_list) or `from` (the version that row showed) picks the row — acting on the wrong row deletes real bookkeeping.',
      parameters: {
        name: { type: 'string', required: true },
        slot: { type: 'integer', description: 'Position of the row in the overall_mcp_list answer, to pick one of several same-named entries.' },
        from: { type: 'string', description: 'Version the row displayed (fallback for a client that rendered before slots existed).' },
      },
      output: jsonOut,
      async execute({ name, slot, from }) {
        return await doRemove(name, {
          slot: Number.isInteger(slot) ? slot : null,
          from: typeof from === 'string' && from !== '' ? from : null,
        });
      },
    }),
    defineTool({
      name: 'overall_mcp_forget_orphans',
      description: 'Remove every registry entry whose own source no longer defines it (the rows overall_mcp_scan reports as `orphans`, shown in the panel as 来源已删除). These are leftovers of an old scanner rename; they mount nothing, but they still count as servers and answer to their name. Entries from a source that could not be read are never touched.',
      parameters: {},
      output: jsonOut,
      execute: () => doForgetOrphans(),
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
    // Status per failure class (see lib/http-status.js), and the log line the
    // old always-400 catch never wrote: a 5xx means the plugin or an upstream
    // broke, which is the one a maintainer has to be able to see.
    const guard = (fn) => async (request) => {
      try { return await fn(request); }
      catch (err) {
        const status = httpStatusFor(err);
        const message = String(err?.message ?? err);
        if (status >= 500) {
          log?.warn?.(`overall-mcp: ${request?.method ?? 'GET'} ${request?.url ?? ''} -> ${status}: ${message}`);
        }
        return json({ error: message, status }, status);
      }
    };
    const readBody = async (request) => {
      try { return await request.json(); } catch { return {}; }
    };

    const routes = [
      ['/api/overall-mcp/servers', ['GET'], guard(async () => json(await serversPayload()))],
      ['/api/overall-mcp/scan', ['GET', 'POST'], guard(async () => json(await doScan()))],
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
        const { item, overwrite } = await readBody(req);
        if (!item || typeof item !== 'object') return json({ error: 'item required' }, 400);
        return json(await doInstall(item, { overwrite: overwrite === true }));
      })],
      // Bookmark a market entry. The listing is annotated on every read, so the
      // next browse reflects the new state; the page also patches its own copy
      // so the star flips without a 2 MB re-fetch.
      ['/api/overall-mcp/favorite', ['POST'], guard(async (req) => {
        const { key, on } = await readBody(req);
        return json(await doToggleFavorite({ key, on }));
      })],
      // The read side of the same set. `/catalog` marks each entry it returns,
      // but the marks only exist for entries the current query happens to
      // include — a source filter or a search would hide the rest, so "what have
      // I starred" needs an answer that does not depend on the listing on screen.
      ['/api/overall-mcp/favorites', ['GET'], guard(async () => json({
        favorites: [...favorites].sort(),
        count: favorites.size,
      }))],
      // The user's own catalogue sources. GET is what the page reads before it
      // has any listing; POST adds one. Removal is its own path (POST), because
      // "add" and "remove" carry different bodies and a 405 is a worse answer
      // than a named route.
      ['/api/overall-mcp/sources', ['GET', 'POST'], guard(async (req) => {
        if (req.method !== 'POST') return json(sourcesPayload());
        const { url, label } = await readBody(req);
        return json(await doAddSource({ url, label }));
      })],
      ['/api/overall-mcp/sources/remove', ['POST'], guard(async (req) => {
        const { id } = await readBody(req);
        return json(await doRemoveSource({ id }));
      })],
      ['/api/overall-mcp/set-enabled', ['POST'], guard(async (req) => {
        const { name, enabled, slot, from } = await readBody(req);
        if (typeof name !== 'string' || typeof enabled !== 'boolean') return json({ error: 'name (string) and enabled (boolean) required' }, 400);
        // `slot` / `from` say which row was clicked when a name has several
        // rows; without them an ambiguous name is an error rather than a guess,
        // because toggling the wrong row disconnects real tools.
        return json(await doSetEnabled(name, enabled, {
          slot: Number.isInteger(slot) ? slot : null,
          from: typeof from === 'string' && from !== '' ? from : null,
        }));
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
        const { name, slot, from } = await readBody(req);
        if (typeof name !== 'string') return json({ error: 'name required' }, 400);
        // `slot` / `from` are optional: a caller that only knows the name still
        // works, and one that knows which row it clicked can say so (two rows
        // may share a name).
        return json(await doUpdate(name, {
          slot: Number.isInteger(slot) ? slot : null,
          from: typeof from === 'string' && from !== '' ? from : null,
        }));
      })],
      ['/api/overall-mcp/remove', ['POST'], guard(async (req) => {
        const { name, slot, from } = await readBody(req);
        if (typeof name !== 'string') return json({ error: 'name required' }, 400);
        return json(await doRemove(name, {
          slot: Number.isInteger(slot) ? slot : null,
          from: typeof from === 'string' && from !== '' ? from : null,
        }));
      })],
      // Remove the rows the last scan proved are gone (来源已删除). One action
      // for the whole set: they are all the same kind of leftover, and removing
      // them one row at a time is what a name-keyed 移除 was doing wrong.
      ['/api/overall-mcp/forget-orphans', ['POST'], guard(async () => json(await doForgetOrphans()))],
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
