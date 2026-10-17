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
import { fileURLToPath } from 'node:url';
import * as mcpClient from '@deepseek-ai/dsh-mcp-client';
import { BlockAssembler } from '@deepseek-ai/dsh-llm';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { describeAbout, toolNamesFor, aboutSourceLabel, needsInstructionsRead } from './lib/about.js';
import { scanHost, mergeIntoRegistry, collapseDuplicateRows, scannedSources, findOrphans, setMountHolder, clearMountHolder } from './lib/scanner.js';
import { browseCatalog, catalogItemToEntry, CENSUS_SOURCE, fetchRepoStats, githubSearchQuota, searchGithubRepos, USER_AGENT } from './lib/catalog.js';
import {
  BASE_QUERIES, INDEX_FILE, INDEX_TTL_MS,
  crawlGithubRepos, indexDocumentOf, indexFreshness, mergeIndexRows, needsGithubCrawl, readIndexDocument,
} from './lib/github-index.js';
import {
  EVIDENCE_FILE, applyInstallEvidence, crawlInstallEvidence, evidenceDocumentOf, needsInstallEvidence,
  readEvidenceDocument,
} from './lib/repo-install.js';
import { createCatalogCache } from './lib/catalog-cache.js';
import {
  SOURCES_MAX, addSourceTo, readSourcesDocument, removeSourceFrom, sourcesDocumentOf,
} from './lib/custom-sources.js';
import { buildIssueUrl, githubRepoOfSourceUrl } from './lib/submission.js';
import {
  readInstalls, writeInstalls, recordInstallIn, installKeyOf,
  localInstallsOf, localLastInstallOf,
} from './lib/installs.js';
import {
  DIAGNOSIS_SYSTEM, buildDiagnosisPrompt, capText, diagnosisFactsOf, diagnosisTextOf,
} from './lib/install-diagnosis.js';
import {
  applyValues, configSpecFor, configState, looksLikeCredentialFailure, maskedFields, specOf,
} from './lib/server-config.js';
import { collectRepoMedia } from './lib/media.js';
import { httpStatusFor } from './lib/http-status.js';
import { sanitizeToolDefinition } from './lib/schema-guard.js';
import { checkAllUpdates, checkDescribesEntry, checkEntryUpdate, parsePackageInvocation, pinArgs } from './lib/updates.js';
import { checkSelfUpdate, updateSelf } from './lib/self-update.js';
import { appendEvents, emit, eventFileFacts, readEvents, setEventSink } from './lib/events.js';
import { clearToken, deactivateGithubAuth, githubAuthStatus, resolveGithubAuth, storeToken, withGithubAuth } from './lib/github-auth.js';

export const name = 'overall-mcp';
export const inject = ['tools'];

const REGISTRY_VERSION = 1;
/**
 * When this process evaluated its own code. The plugin version cannot answer
 * "is the running build the one on disk?" — `package.json` and the client's
 * version chip both stay at 0.1.0 across releases — but a comparison with the
 * files' mtimes can, and that is the question the 2026-10-16 report turned on:
 * a host started 16:50 the previous day was still running code from before the
 * two batches that fixed the source it called unavailable (see `/status`).
 */
const LOADED_AT = new Date();
/** This checkout's directory, for the same answer's file list. */
const PLUGIN_DIR = path.dirname(fileURLToPath(import.meta.url));
const SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;
/** Bounded readiness wait for one mcp-client mount (see connect()). */
const CONNECT_WAIT_MS = 8000;
/**
 * How many mcp-client mounts may be starting at once.
 *
 * A mount is a child process plus a handshake, and the wait is bounded by
 * CONNECT_WAIT_MS — so doing them one at a time made the worst case (one group
 * whose whole membership fails to start) `members × 8s`: the 2026-10-16 report
 * measured a group of five taking 40 seconds with the panel sitting on
 * 「正在切换…」. Four in flight keeps a group's switch to the order of one
 * handshake while still bounding the process fan-out, and every result keeps its
 * original place in the reply either way.
 */
const CONNECT_CONCURRENCY = 4;
/** How long a failed-mount diagnosis may take before the install reply wins. */
const DIAGNOSIS_TIMEOUT_MS = 20000;
/** Diagnoses kept in memory: retrying the same broken entry must not re-ask. */
const DIAGNOSIS_CACHE_MAX = 32;
/** How long one (entry, error) diagnosis is reused. */
const DIAGNOSIS_TTL_MS = 10 * 60 * 1000;

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
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600 });
  try { await fs.chmod(tmp, 0o600); } catch {}
  await fs.rename(tmp, file);
  try { await fs.chmod(file, 0o600); } catch {}
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
    try { await fs.chmod(file, 0o600); } catch {}
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
  // The plugin's own activity log (lib/events.js explains why). The sink is
  // installed before anything else in `apply()` runs, so the repairs and
  // damaged-file reports below are the log's first entries rather than its first
  // invisible ones. Writes are fire-and-forget: `appendEvents` never rejects.
  const eventsFile = path.join(dir, 'events.ndjson');
  setEventSink((event) => { void appendEvents(eventsFile, [event]); });
  /**
   * GitHub credentials (lib/github-auth.js explains the whole design).
   *
   * Resolved in the background, and only from the sources that cost nothing to
   * ask — a pasted token or the environment. `gh auth token` is deliberately
   * left for the panel's own request: it spawns a process, and startup is not
   * the moment to spawn one to answer a question nobody has asked. Until a
   * credential lands, requests go out anonymously, which is a working state.
   */
  const refreshGithubAuth = async ({ force = false, useGh = false } = {}) => {
    try {
      return await resolveGithubAuth({ dir, force, useGh });
    } catch (err) {
      // Resolution failure means "no credential", never "no plugin": the census
      // and the market run anonymously, exactly as they did before.
      log?.warn?.(`overall-mcp: GitHub credential resolution failed: ${String(err?.message ?? err)}`);
      return githubAuthStatus();
    }
  };
  void refreshGithubAuth();
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
    emit({ kind: 'sources', action: 'damaged', error: loadedSources.damaged, backup: path.basename(backup) });
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
    emit({ kind: 'registry', action: 'damaged', error: loaded.damaged, backup: path.basename(backup) });
  }
  const firstRun = registry === null && loaded.damaged === null;
  if (!registry) registry = { version: REGISTRY_VERSION, servers: [] };  // Favourite market entries, keyed exactly like the client's React key
  // (`<source>:<id|title>`) so the card and the stored state cannot disagree.
  // Kept beside `servers` rather than inside it: a favourite is a UI bookmark,
  // not a mounted server, and mixing the two would make scans write over it.
  const favorites = new Set(Array.isArray(registry.favorites) ? registry.favorites.filter((k) => typeof k === 'string') : []);

  // Repair duplicate rows the old rename left in the file, before anything reads
  // the list (see lib/scanner.js collapseDuplicateRows). This machine's registry
  // held four rows for the one `rea-cursor` mount — three of them carrying a
  // stale mount stamp from a version that did not stamp exclusively, which is
  // why the orphan cleanup refused to touch them and the panel kept showing
  // four. Collapsing keeps the row that owns the mount, so a restart repairs the
  // bookkeeping without changing what is mounted.
  {
    const repaired = collapseDuplicateRows(registry);
    if (repaired.collapsed.length > 0) {
      registry = repaired.registry;
      log?.warn?.(`overall-mcp: collapsed ${repaired.collapsed.length} duplicate row(s) — ${repaired.collapsed.map((c) => `${c.name} (-${c.dropped})`).join(', ')}`);
      emit({ kind: 'registry', action: 'collapse', collapsed: repaired.collapsed });
      await save();
    }
  }

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

  /**
   * Run `worker` over `items` with at most `limit` of them in flight, and keep
   * the answers in the input's order.
   *
   * Written by hand rather than reached for from a library because the two
   * callers below are the only place in this plugin that fan out, and because
   * the ordering guarantee is the point: `connectEnabled()` returns one result
   * per registry row, and the client indexes into that array.
   */
  async function mapLimited(items, limit, worker) {
    const list = [...items];
    const results = new Array(list.length);
    let next = 0;
    const width = Math.max(1, Math.min(limit, list.length));
    await Promise.all(Array.from({ length: width }, async () => {
      for (;;) {
        const index = next;
        next += 1;
        if (index >= list.length) return;
        results[index] = await worker(list[index], index);
      }
    }));
    return results;
  }

  async function connectEnabled() {
    const enabled = registry.servers.filter((entry) => entry.enabled !== false);
    // One *mount* per name, but one *answer* per enabled row — the caller
    // indexes into this array by registry position.
    //
    // Concurrency is why this cannot simply loop: two rows can share a name (one
    // client config may define the same server twice), and a concurrent pair
    // would both pass `connect()`'s `fibers.has()` guard before either had set a
    // fiber — the second mcp-client launch would collide on the serverName and
    // be recorded as an external mount it never was (see branch 2 in connect()).
    // Rows that share a name therefore get the first row's verdict verbatim:
    // there is nothing else to try, and a second identical attempt would only
    // produce a second identical failure.
    const names = [...new Set(enabled.map((entry) => entry.name))];
    const answers = await mapLimited(names, CONNECT_CONCURRENCY, async (name) => {
      const entry = enabled.find((row) => row.name === name);
      return { name, ...(await connect(entry)) };
    });
    const byName = new Map(answers.map((answer) => [answer.name, answer]));
    return enabled.map((entry) => byName.get(entry.name));
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
      // 「这个 MCP 还差配置」: what an installed server needs before its tools
      // work, masked. `needs` is true only for a missing *required* value — see
      // lib/server-config.js on why an empty optional field is not a problem.
      const spec = specOf(s);
      const config = maskedFields(spec, s);
      const configNeeds = configState(spec, s)?.needs === true;
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
        // The masked config projection. Only present when the entry declares
        // fields, so every existing consumer of this payload is unchanged.
        config,
        // A required value is absent, so the server cannot work yet. This is the
        // fact the panel badges and the model is told about in `overall_mcp_list`.
        needConfig: configNeeds,
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
    // One number the panel can show without walking the rows: how many enabled
    // servers are mounted-but-unusable because a required value is missing.
    const needConfig = servers.filter((s) => s.needConfig && s.enabled).length;
    return { servers, needConfig, ...(registryLoadError ? { registryError: registryLoadError } : {}) };
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
    // Newly found servers mount with the same bounded fan-out as a group switch:
    // a scan that adds several servers must not cost one CONNECT_WAIT_MS each,
    // and the names in `merged.added` are already unique.
    const wanted = merged.added
      .map((name) => registry.servers.find((s) => s.name === name))
      .filter((entry) => entry && entry.enabled !== false);
    const connected = await mapLimited(wanted, CONNECT_CONCURRENCY, async (entry) => ({
      name: entry.name,
      ...(await connect(entry)),
    }));
    emit({
      kind: 'scan',
      files: report.length,
      added: merged.added.length,
      skipped: merged.skipped.length,
      collapsed: merged.collapsed?.length ?? 0,
      connected: connected.length,
      orphans: orphanEntries().length,
    });
    return {
      added: merged.added,
      skipped: merged.skipped,
      collapsed: merged.collapsed ?? [],
      connected,
      scannedFiles: report.length,
      orphans: orphanEntries().map((s) => s.name),
    };
  }

  // ---- install-failure diagnosis (optional) ---------------------------------
  // A failed mount leaves one raw line — `spawn npx ENOENT`, `MCP error -32000:
  // Connection closed` — that says nothing about what to do next. When the host
  // has both a model route and the `llm` service, that line is sent to the
  // user's own model, silently: no session, no message in any conversation, and
  // nothing written to disk. Without either piece the install reply is exactly
  // what it was before this existed.
  //
  // `llm` is captured through optional injection rather than declared in the
  // plugin's `inject`, because a host with no model configured must still load
  // this plugin — declaring it would make the whole market disappear instead of
  // one extra paragraph.
  let llmService = null;
  ctx.inject(['llm'], (llmCtx) => {
    llmService = llmCtx?.llm ?? null;
    return () => { llmService = null; };
  });

  /** `${name}|${error}` -> { at, value }. Retrying a broken row must not re-ask. */
  const diagnosisCache = new Map();

  /** The user's configured default route, or null when it is incomplete. */
  function diagnosisRoute() {
    const selection = typeof ctx.get === 'function' ? ctx.get('agentDefaultModel')?.currentSelection?.() : null;
    const provider = selection?.provider;
    const model = selection?.model;
    if (typeof provider !== 'string' || typeof model !== 'string' || provider === '' || model === '') return null;
    return { provider, model };
  }

  /**
   * Ask the user's own model to explain one failed mount.
   *
   * @param entry - the registry entry that was written.
   * @param item - the catalogue item it came from (for repository/version facts).
   * @param errorText - exactly what the mount reported.
   * @returns `{ ok: true, text, route, cached? }`, or `{ ok: false, reason }`
   *   when this host cannot ask (`no-llm` / `no-route`) — the caller reports the
   *   reason, because "no explanation" and "explaining is not configured here"
   *   are different facts for the user.
   * @throws when the model was reachable but the call or its output failed.
   */
  async function diagnoseFailure(entry, item, errorText) {
    if (!llmService) return { ok: false, reason: 'no-llm' };
    const route = diagnosisRoute();
    if (!route) return { ok: false, reason: 'no-route' };
    const key = `${entry.name}|${errorText}`;
    const now = Date.now();
    const hit = diagnosisCache.get(key);
    if (hit && now - hit.at < DIAGNOSIS_TTL_MS) return { ok: true, ...hit.value, cached: true };

    const facts = diagnosisFactsOf({ item, entry, error: errorText });
    const assembler = new BlockAssembler();
    const options = {
      provider: route.provider,
      model: route.model,
      system: DIAGNOSIS_SYSTEM,
      messages: [{ role: 'user', content: [{ type: 'text', text: buildDiagnosisPrompt(facts) }] }],
      temperature: 0,
      signal: AbortSignal.timeout(DIAGNOSIS_TIMEOUT_MS),
    };
    for await (const chunk of llmService.stream(options)) {
      assembler.push(chunk);
      if (chunk?.type === 'finish' && (chunk.reason?.kind === 'error' || chunk.reason?.kind === 'aborted')) {
        const failure = chunk.reason.failure ?? {};
        throw new Error(`诊断模型以 ${chunk.reason.kind} 结束：${failure.message ?? failure.code ?? '未知原因'}`);
      }
    }
    const text = diagnosisTextOf(assembler.blocks());
    if (text === '') throw new Error('诊断模型没有输出文本');
    const value = { text, route: `${route.provider}/${route.model}` };
    diagnosisCache.set(key, { at: now, value });
    evictOldest(diagnosisCache, DIAGNOSIS_CACHE_MAX);
    return { ok: true, ...value };
  }

  async function doInstallImpl(item, { overwrite = false } = {}) {
    const entry = catalogItemToEntry(item);
    if (!entry) throw new Error('item has no installable transport (stdio command or http url)');
    // Whether this row is missing a required setting, read before mounting: a
    // declared-but-unfilled field predicts the auth failure, and the same fields
    // must be named by the badge, the reply and the config form.
    const configBefore = configState(specOf(entry), entry);
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
    // The failed-mount path is the one users actually hit, and the raw error is
    // rarely actionable on its own. The diagnosis is additive: the host's own
    // error stays the source of truth, and a model that cannot be reached, is
    // not configured, or answers with nothing adds nothing but a reason.
    let diagnosis = null;
    let diagnosisSkipped = null;
    let diagnosisError = null;
    if (conn.ok === false) {
      // Two failures, two answers. A missing credential is *declared*: the
      // catalogue said which field is required and the config form fills it, so
      // asking a model to re-derive it from `401` would be slower and worse.
      // Everything else still gets the diagnosis.
      if (configBefore?.needs === true || looksLikeCredentialFailure(conn.error)) {
        diagnosisSkipped = 'needs-config';
      } else {
        try {
          const outcome = await diagnoseFailure(entry, item, String(conn.error ?? 'mount failed'));
          if (outcome.ok) diagnosis = { text: outcome.text, route: outcome.route, ...(outcome.cached ? { cached: true } : {}) };
          else diagnosisSkipped = outcome.reason;
        } catch (err) {
          diagnosisError = capText(String(err?.message ?? err), 200);
          log?.warn?.(`overall-mcp: could not explain the failed install of ${entry.name}: ${diagnosisError}`);
        }
      }
    }
    // The install is the action a user most often needs to reconstruct ("it said
    // it installed — did it mount?"). Two facts in one line: the mount verdict,
    // and whether it was counted as an install of this market.
    emit({
      kind: 'install',
      server: entry.name,
      source: item?.source ?? null,
      itemId: item?.id ?? null,
      mounted: conn.ok !== false,
      counted: record !== null,
      ...(conn.ok === false ? { error: capText(String(conn.error ?? 'mount failed'), 200) } : {}),
      ...(diagnosis ? { diagnosis: true } : {}),
      ...(diagnosisError ? { diagnosisError } : {}),
    });
    return {
      // `server` is the name of the row that was written; `installed` is the
      // market's own boolean — the same one every catalog row carries. The two
      // used to share this one key, so the client read a string here and a
      // boolean on a card: one word, two meanings, one place to get it wrong.
      server: entry.name,
      installed: true,
      localInstalls: record?.count ?? localInstallsOf(installs, item, entry.name),
      servers: (await serversPayload()).servers,
      connect: conn,
      ...(conn.ok === false ? {
        counted: false,
        // A missing required setting is the most likely reason the mount failed,
        // and it is the one the user can act on right here, so it wins the line.
        note: configBefore?.needs === true
          ? `${entry.name} 已写入注册表，但还缺 ${configBefore.missing.join('、')}，填好之前它的工具调用不通。`
          : `${entry.name} 已写入注册表，但挂载没有成功，因此没有计入本市场安装数；修好后可用「更新」或重新启用来重试。`,
      } : {}),
      ...(diagnosis ? { diagnosis } : {}),
      ...(diagnosisSkipped ? { diagnosisSkipped } : {}),
      ...(diagnosisError ? { diagnosisError } : {}),
      // What this row still needs, masked (the value never comes back), plus the
      // one-line flag the panel badges. Both are also on the fresh `servers` list
      // just above; repeating them here saves the client a lookup after install.
      config: maskedFields(specOf(entry), entry),
      needConfig: configBefore?.needs === true,
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

  /**
   * Save configuration values for one row, then remount it.
   *
   * The remount is the point. `env` and `headers` are read when an mcp-client
   * fiber starts, so a value written under a live fiber changes nothing until
   * the fiber is replaced — the same sequence 停用→启用 performs. A row the user
   * had stopped stays stopped: saving its values must not start it.
   *
   * @param name - the row's name.
   * @param values - `{ env?, headers? }`; an empty string clears a key.
   * @param options - `{ slot, from }` to address one of several same-named rows.
   * @returns the masked config, the mount verdict, and what is still missing.
   */
  async function doConfigureImpl(name, values, { slot = null, from = null, actor = 'user' } = {}) {
    const entry = resolveEntry(name, { slot, from });
    const before = configState(specOf(entry), entry);
    const { changed, rejected } = applyValues(entry, values ?? {}, { actor });
    if (changed.length === 0) {
      // Nothing was written, so nothing is saved and nothing is remounted. A
      // reply saying 「已保存」 here would be the lie that makes the badge stay on
      // with no explanation.
      let note = '没有需要写入的值（空值等于清除，未填写任何内容）。';
      if (rejected.length > 0) {
        note = `未写入任何配置：${rejected.map((r) => `${r.key}（${r.reason}）`).join('；')}。`;
      }
      return {
        name,
        changed: [],
        rejected,
        saved: false,
        config: maskedFields(specOf(entry), entry),
        needConfig: before?.needs === true,
        note,
      };
    }
    await save();
    // mount, not connect: a local named connect would shadow the mount
    // helper and turn this line into a call on a null variable.
    let mount = null;
    if (entry.enabled !== false && !externallyProvided(entry)) {
      await disconnect(entry.name);
      mount = await connect(entry);
    }
    const after = configState(specOf(entry), entry);
    emit({
      kind: 'configure',
      server: entry.name,
      changed: changed.length,
      rejected: rejected.length,
      mounted: mount ? mount.ok !== false : null,
      ...(after?.needs ? { stillMissing: after.missing.length } : {}),
    });
    const notes = [];
    const truncated = changed.filter((c) => c.action === 'truncated');
    if (truncated.length > 0) {
      notes.push(`配置项 ${truncated.map((c) => c.key).join('、')} 超过 4096 字符，已截断保存。`);
    }
    if (rejected.length > 0) {
      notes.push(`以下配置未写入：${rejected.map((r) => `${r.key}（${r.reason}）`).join('；')}。`);
    }
    if (externallyProvided(entry)) {
      notes.push(`${name} 的工具由另一个 mcp-client 挂载提供：值已写入本插件的注册表，但那一份挂载读的是它自己的配置，改动要等它重新加载才生效。`);
    }
    if (after?.needs) notes.push(`还缺 ${after.missing.join('、')}，填好并重新挂载后工具才会通。`);
    return {
      name,
      changed,
      rejected,
      saved: true,
      ...(mount ? { connect: mount } : {}),
      ...(externallyProvided(entry) ? { providedExternally: true } : {}),
      config: maskedFields(specOf(entry), entry),
      needConfig: after?.needs === true,
      ...(after?.needs ? { missing: after.missing } : {}),
      ...(notes.length ? { note: notes.join(' ') } : {}),
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
    // Bounded fan-out: a group of N rows used to cost N × CONNECT_WAIT_MS when
    // its mounts could not start (measured: 40s for five). Each name is still
    // its own fiber, so these do not touch each other's state.
    await mapLimited(
      [...new Set(targets.map((s) => s.name))],
      CONNECT_CONCURRENCY,
      (name) => syncFiber(name),
    );
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
    emit({ kind: 'registry', action: 'forget-orphans', count: removed.length, names });
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

  const doSelfUpdate = async () => {
    const result = await updateSelf({ moduleUrl: import.meta.url });
    emit({
      kind: 'update',
      target: 'dsh-overall-mcp',
      updated: result?.updated === true,
      ...(result?.ok === false ? { error: result.reason ?? 'failed' } : {}),
      ...(result?.version ? { from: result.version } : {}),
      ...(result?.latest ? { to: result.latest } : {}),
    });
    return result;
  };

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
    if (!entry.config) {
      const spec = specOf(entry);
      if (spec) entry.config = spec;
    }
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

  // ---------------------------------------------------------------------------
  // The local GitHub index (lib/github-index.js)
  //
  // GitHub's search API cannot page past 1000 results per query and allows 10
  // anonymous requests a minute, so "the MCP servers on GitHub" cannot be listed
  // by asking. It has to be *walked* — narrowly enough to stay under the ceiling
  // — and remembered. The walk is slow (minutes, paced to the quota) and it is
  // derived data, so it happens in the background: a listing answers with the
  // census we hold and says how old it is, and a stale one is refreshed behind
  // the panel rather than in front of it.
  // ---------------------------------------------------------------------------
  const githubIndexFile = path.join(dir, INDEX_FILE);
  let githubIndexDoc = null;
  let githubIndexLoaded = false;
  let githubIndexDamaged = null;
  let githubCrawl = null;
  /** Progress of the walk in flight, for the panel's "building" sentence. */
  let githubWalkProgress = null;
  /**
   * The handle that can end the walk in flight. A census paces itself at one
   * search request per 6.5s and can run for minutes (48 requests worst case), so
   * "stop" has to be something a reader can do mid-walk — and the reason has to
   * be recorded here, because the walk itself only knows it was aborted.
   */
  let githubCrawlStop = null;
  /** How the last walk ended early, or null if it ran to its own stop. */
  let githubCrawlEnded = null;

  /** Read the census once per process; the crawl below keeps it current. */
  async function readGithubIndex() {
    if (!githubIndexLoaded) {
      const { doc, damaged } = await readIndexDocument(githubIndexFile, (file, enc) => fs.readFile(file, enc));
      githubIndexDoc = doc;
      githubIndexDamaged = damaged;
      githubIndexLoaded = true;
      if (damaged) log?.warn?.(`overall-mcp: github index damaged: ${damaged}`);
    }
    return githubIndexDoc;
  }

  /** The census plus its freshness, in the shape `fetchGithubMcp` reads. */
  async function githubIndexPayload() {
    const doc = await readGithubIndex();
    if (!doc?.rows?.length) return null;
    return { ...doc, ...indexFreshness(doc, { ttlMs: INDEX_TTL_MS }) };
  }

  /**
   * Walk the census in the background, unless one is already walking or the one
   * we hold is fresh enough. Never awaited by a request: a panel read must not
   * wait minutes for a crawl, and a crawl that fails changes nothing except the
   * next attempt (`derived data, already reported as stale`).
   */
  function maybeCrawlGithubIndex({ force = false } = {}) {
    if (githubCrawl) return githubCrawl;
    const held = githubIndexDoc;
    if (!needsGithubCrawl(held, { force })) return null;
    // Do not start a walk into a window the upstream has already told us is
    // empty: the first request would fail, and every retry inside the same
    // minute is another request against a budget that has none. The next browse
    // after the reset starts it.
    const quota = githubSearchQuota();
    if (quota.waitMs > 0) {
      log?.warn?.(`overall-mcp: GitHub search budget is empty for another ${Math.ceil(quota.waitMs / 1000)}s; not walking`);
      emit({ kind: 'census', action: 'skipped', waitMs: quota.waitMs });
      return null;
    }
    // The handle a reader stops this walk with. `reason` stays null until
    // something asks it to end, so "why did it stop" is answered by the one
    // place that knows, not inferred from the walk's own flat "已中止".
    const stop = { controller: new AbortController(), reason: null };
    githubCrawlStop = stop;
    githubCrawlEnded = null;
    githubCrawl = (async () => {
      log?.info?.('overall-mcp: walking the GitHub index');
      githubWalkProgress = { requests: 0, rows: 0 };
      emit({ kind: 'census', action: 'start', force: force === true });
      let lastWrite = 0;
      const walk = await crawlGithubRepos({
        search: searchGithubRepos,
        signal: stop.controller.signal,
        // The walk paces itself with 6.5s waits, so a sleep that cannot be
        // interrupted would make "停止" mean "stop after up to 6.5 more
        // seconds". Unref'd for the same reason as the evidence walk: a pacing
        // timer must never be the thing keeping `node --test` alive.
        sleep: (ms) => new Promise((resolve) => {
          const done = () => {
            stop.controller.signal.removeEventListener('abort', done);
            clearTimeout(timer);
            resolve();
          };
          const timer = setTimeout(done, ms);
          timer.unref?.();
          stop.controller.signal.addEventListener('abort', done, { once: true });
        }),
        onProgress: ({ requests, rows, items }) => {
          githubWalkProgress = { requests, rows };
          // Minutes-long walk, desktop process: what has been collected is
          // written as it arrives, marked unfinished so a restart resumes from a
          // truthful "partial census" rather than from nothing.
          const stamp = Date.now();
          if (rows === 0 || stamp - lastWrite < 5000) return;
          lastWrite = stamp;
          const at = new Date(stamp).toISOString();
          const merged = mergeIndexRows(held?.rows ?? [], [...items.values()], { at });
          void writeJson(githubIndexFile, indexDocumentOf({
            at,
            rows: merged,
            queries: [...BASE_QUERIES],
            requests,
            complete: false,
            partial: `正在抓取（已收 ${rows} 行）`,
          })).catch(() => {});
        },
      });
      const rows = mergeIndexRows(held?.rows ?? [], walk.rows, { at: walk.at });
      // `crawlGithubRepos` reports an abort as a flat "已中止", which is true but
      // useless in the panel: the reader wants to know whether *they* stopped it
      // or the host went away. The reason is ours, so it is stated here.
      const partial = stop.reason === 'user'
        ? `已手动停止（已收 ${rows.length} 行，下次接着走）`
        : stop.reason === 'dispose'
          ? `插件被卸载，已停止（已收 ${rows.length} 行）`
          : (walk.partial || (walk.truncations.length ? walk.truncations.map((t) => t.reason).join('；') : null));
      const doc = indexDocumentOf({
        at: walk.at,
        rows,
        queries: [...BASE_QUERIES],
        requests: walk.requests,
        complete: walk.complete,
        partial,
      });
      await writeJson(githubIndexFile, doc);
      githubIndexDoc = doc;
      githubIndexLoaded = true;
      githubIndexDamaged = null;
      log?.info?.(`overall-mcp: github index ${doc.rows.length} rows in ${walk.requests} requests (complete=${walk.complete})`);
      // The census's outcome is the fact a stale面板 cannot show: how many rows
      // the walk actually kept, and whether it finished.
      emit({
        kind: 'census',
        action: stop.reason ? 'stopped' : 'stop',
        ...(stop.reason ? { reason: stop.reason } : {}),
        requests: walk.requests,
        rows: doc.rows.length,
        complete: walk.complete === true,
        ...(doc.partial ? { partial: doc.partial } : {}),
      });
      // A census that just grew is the cheapest moment to ask the repositories
      // themselves how they are run: the two walks share no quota (search API
      // vs raw.githubusercontent), and this one is deliberately not awaited.
      // A walk the reader stopped is the one exception: they stopped paying for
      // discovery, so it would be perverse to answer by spending on something
      // else.
      if (!stop.reason) maybeCrawlInstallEvidence({ force });
      return doc;
    })()
      .catch((err) => {
        log?.warn?.(`overall-mcp: github index walk failed: ${String(err?.message ?? err)}`);
        emit({ kind: 'census', action: 'failed', error: String(err?.message ?? err) });
        return null;
      })
      .finally(() => {
        githubCrawlEnded = stop.reason ? { reason: stop.reason, at: new Date().toISOString() } : null;
        githubCrawl = null;
        githubWalkProgress = null;
        if (githubCrawlStop === stop) githubCrawlStop = null;
      });
    return githubCrawl;
  }

  /**
   * End the census in flight, if one is walking.
   *
   * @param reason - 'user' (panel button or route) or 'dispose' (host unload).
   * @returns true when a walk was actually asked to stop.
   */
  function stopCensus(reason = 'user') {
    const stop = githubCrawlStop;
    if (!stop) return false;
    // First reason wins: a reader's stop must not be rewritten as "unloaded"
    // when the plugin disposes a moment later (that is what the disposal path
    // does, and the panel would then report a stop the reader never asked for).
    if (!stop.reason) stop.reason = reason;
    emit({ kind: 'census', action: 'stopping', reason: stop.reason, ...(githubWalkProgress ?? {}) });
    stop.controller.abort();
    return true;
  }

  /**
   * The census in one shape, for `/status` and the census route: what the file
   * holds, whether a walk is running, how far it has got, and how the last one
   * ended when it ended early. The file alone cannot say the last two — it says
   * "正在抓取" while a walk runs and "已手动停止" after a stop, and never says
   * which request the walk is on.
   */
  async function censusState() {
    const census = await githubIndexPayload();
    return {
      rows: census?.rows?.length ?? 0,
      at: census?.at ?? null,
      complete: census?.complete === true,
      partial: census?.partial ?? null,
      requests: census?.requests ?? null,
      walking: githubCrawl !== null,
      progress: githubWalkProgress,
      ended: githubCrawlEnded,
      loaded: githubIndexLoaded,
      damaged: githubIndexDamaged ?? null,
    };
  }

  /**
   * The census verbs, in one place so the route and any future caller agree.
   *
   * @param action - 'start' (walk now, fresh or not) | 'stop' | null (read).
   */
  async function doCensus({ action = null } = {}) {
    // Read the file before anything starts: `maybeCrawlGithubIndex` merges the
    // walk into `githubIndexDoc`, so starting one while that is still null would
    // write a census built from an empty past — the rows collected yesterday
    // would be replaced by the ones collected in the next six minutes.
    await readGithubIndex();
    if (action === 'stop') {
      const stopping = stopCensus('user');
      const state = await censusState();
      return { ...state, stopping };
    }
    if (action === 'start') {
      const before = githubCrawl;
      // `force` because "start" is a reader asking for a walk now; refusing
      // because the one we hold is fresh would make the button do nothing.
      const walk = maybeCrawlGithubIndex({ force: true });
      const state = await censusState();
      const quota = githubSearchQuota();
      return {
        ...state,
        // "Did *this* call start a walk?" — not "is one running now?", which is
        // what `walking` already answers. A second click while the first walk is
        // in flight used to be reported as `started: true` (the existing walk
        // was returned), so the panel said "已开始" about something it had not
        // started.
        started: walk !== null && walk !== before,
        // A start that did not start has to say why. There is exactly one such
        // reason: the search budget is empty, and the walk would spend its first
        // request on a 403.
        ...(walk === null && !before && quota.waitMs > 0 ? { skipped: 'quota', waitMs: quota.waitMs } : {}),
      };
    }
    return censusState();
  }

  // ---------------------------------------------------------------------------
  // Install evidence recovered from the repository itself (lib/repo-install.js)
  //
  // The GitHub source is a *discovery* source: a repository listing says what a
  // project is and never how to run it, so its rows ship `install: null` and the
  // panel asks the reader to configure it by hand. But the author did write the
  // command down — in `server.json`, `package.json`, `pyproject.toml` or the
  // README — so this walk reads those files, confirms the package really exists
  // on npm / PyPI, and only then turns a row into an installable one carrying its
  // provenance ("命令来自仓库 package.json"). It reads raw.githubusercontent.com,
  // which is a CDN rather than the rate-limited API, so its pacing is politeness
  // rather than a quota; the walk is resumable and bounded by time and requests.
  // ---------------------------------------------------------------------------
  const evidenceFile = path.join(dir, EVIDENCE_FILE);
  let evidenceDoc = null;
  let evidenceLoaded = false;
  let evidenceDamaged = null;
  let evidenceCrawl = null;
  // The handle a reader stops *this* walk with, how the last one ended early,
  // and how far the one in flight has got. All three are per-walk for the same
  // reason the census's are: an AbortController is spent once signalled, so a
  // second walk reusing one would be born aborted. `reason` stays null until
  // something asks it to end, so "why did it stop" is answered where the asking
  // happened rather than inferred from the walk's own flat "已中止".
  let evidenceStop = null;
  let evidenceEnded = null;
  let evidenceProgress = null;
  let evidenceLast = null;

  /** Read the evidence once per process; the walk below keeps it current. */
  async function readEvidence() {
    if (!evidenceLoaded) {
      const { doc, damaged } = await readEvidenceDocument(evidenceFile, (file, enc) => fs.readFile(file, enc));
      evidenceDoc = doc;
      evidenceDamaged = damaged;
      evidenceLoaded = true;
      if (damaged) log?.warn?.(`overall-mcp: ${damaged}`);
    }
    return evidenceDoc;
  }

  /** `id -> evidence row`, so annotating a 2 MB listing is one map lookup per row. */
  async function evidenceById() {
    const doc = await readEvidence();
    return new Map((doc?.rows ?? []).map((row) => [row.id, row]));
  }

  /**
   * How the recovery is going, for the panel's source line and the route: what
   * the file holds, whether a walk is running, how far through its plan that
   * walk is, and how the last one ended when it ended early.
   *
   * The file alone cannot say the last four. It says "正在抓取" while a walk
   * runs and carries the last `partial` after one stops, but it never says which
   * repository is being read right now, how many of the plan have been tried, or
   * whether it was a reader or the host unload that ended it.
   */
  async function evidenceState() {
    const doc = await readEvidence();
    const rows = doc?.rows ?? [];
    return {
      rows: rows.length,
      withCommand: rows.filter((row) => row.install).length,
      at: doc?.at ?? null,
      walking: evidenceCrawl !== null,
      // Carried so the panel can say why a walk stopped and offer to carry on
      // from there: without it, a partial recovery reads as a finished one.
      requests: doc?.requests ?? null,
      partial: doc?.partial ?? null,
      progress: evidenceProgress,
      ended: evidenceEnded,
      // The last pass's own plan, so "77 of 2111" survives a reload: the file
      // holds the rows but not how many the walk set out to read.
      plan: evidenceLast,
      complete: doc ? doc.partial == null : false,
      damaged: evidenceDamaged ?? null,
    };
  }

  /** A manifest bigger than this is a generated dump, not evidence. */
  const EVIDENCE_MAX_BYTES = 512 * 1024;

  /**
   * One raw file. `null` means "the repository does not have it" (the walk's own
   * contract); a refusal is thrown so the walk stops and says who refused.
   */
  async function readRepoFile(url, { signal } = {}) {
    let res;
    try {
      res = await fetch(url, { headers: withGithubAuth(url, { 'user-agent': USER_AGENT, accept: 'text/plain' }), signal });
    } catch (err) {
      // A stopped walk is not a dropped connection. Both arrive here as a
      // rejected fetch, and they mean opposite things: one says "try again",
      // the other says "the reader asked you to stop", so the abort is labelled
      // as what it is and the walk reports 已中止 rather than blaming the host.
      if (signal?.aborted || err?.name === 'AbortError') {
        const stopped = new Error('the walk was stopped');
        stopped.code = 'aborted';
        throw stopped;
      }
      // A dropped connection says nothing about the repository, and the walk
      // cannot tell the two apart unless the failure is labelled: `network` is
      // what it retries, `http` is what stops it.
      const failure = new Error(String(err?.message ?? err));
      failure.code = 'network';
      throw failure;
    }
    if (res.status === 404 || res.status === 410) return null;
    if (res.status === 401) {
      // A stored token that GitHub no longer accepts is worse than none: every
      // request would fail the same way and the walk would stop over a file
      // that is perfectly readable anonymously. Drop the credential and let the
      // walk's retry go out without it.
      deactivateGithubAuth('GitHub 拒绝了这个 token（HTTP 401），已改用匿名访问');
      const err = new Error('HTTP 401');
      err.code = 'refused';
      throw err;
    }
    if (res.status === 403 || res.status === 429) {
      const err = new Error(`HTTP ${res.status}`);
      err.code = 'refused';
      throw err;
    }
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status}`);
      err.code = res.status >= 500 ? 'upstream' : 'http';
      throw err;
    }
    const text = await res.text();
    return text.length > EVIDENCE_MAX_BYTES ? null : text;
  }

  /** Is the package really published? A command that 404s is not a button. */
  async function packageExists({ registry, name, signal }) {
    const url = registry === 'npm'
      ? `https://registry.npmjs.org/${encodeURIComponent(name)}`
      : `https://pypi.org/pypi/${encodeURIComponent(name)}/json`;
    const send = async (method) => {
      try {
        return await fetch(url, { method, headers: { 'user-agent': USER_AGENT, accept: 'application/json' }, signal });
      } catch (err) {
        if (signal?.aborted || err?.name === 'AbortError') {
          const stopped = new Error('the walk was stopped');
          stopped.code = 'aborted';
          throw stopped;
        }
        const failure = new Error(String(err?.message ?? err));
        failure.code = 'network';
        throw failure;
      }
    };
    const res = await send('HEAD');
    if (res.status === 403 || res.status === 429) {
      const err = new Error(`HTTP ${res.status}`);
      err.code = 'refused';
      throw err;
    }
    if (res.status >= 500) {
      const err = new Error(`HTTP ${res.status}`);
      err.code = 'upstream';
      throw err;
    }
    // Some registries answer HEAD badly rather than answering it.
    if (res.status === 405 || res.status === 501) return (await send('GET')).ok;
    return res.ok;
  }

  /**
   * Walk the repositories the census knows about and that still need a look, in
   * the census's own order (most stars first), so a stop lands on the rows that
   * matter least. Never awaited by a request — like the census walk this is
   * derived data: an unfinished one changes nothing except the next attempt.
   */
  function maybeCrawlInstallEvidence({ force = false } = {}) {
    if (evidenceCrawl) return evidenceCrawl;
    const census = githubIndexDoc;
    if (!census?.rows?.length) return null;
    const held = evidenceDoc;
    const window = force ? { retryNoneMs: 0, refreshPlanMs: 0 } : {};
    const byId = new Map((held?.rows ?? []).map((row) => [row.id, row]));
    const rows = census.rows
      .filter((row) => typeof row.repository === 'string' && row.repository
        && needsInstallEvidence(row, byId.get(row.id), window))
      .map((row) => ({ id: row.id, repository: row.repository, stars: row.stars }));
    if (!rows.length) return null;
    // The handle a reader stops this walk with, created per walk: an
    // AbortController is spent once signalled, so a second walk must not inherit
    // the first one's — "stop, then start again" would otherwise begin a walk
    // that is aborted before its first request.
    const stop = { controller: new AbortController(), reason: null };
    evidenceStop = stop;
    evidenceEnded = null;
    evidenceCrawl = (async () => {
      log?.info?.(`overall-mcp: recovering install commands for ${rows.length} repositories`);
      evidenceProgress = { requests: 0, attempted: 0, planned: rows.length };
      emit({ kind: 'evidence', action: 'start', rows: rows.length, force: force === true });
      const walk = await crawlInstallEvidence({
        rows,
        previous: held?.rows ?? [],
        fetchText: readRepoFile,
        verifyPackage: packageExists,
        // `node --test` waits for the event loop to drain, so a pacing timer must
        // never be the thing keeping the process alive. Interruptible for the
        // same reason the census's is: this walk waits 150ms between rows and up
        // to 5s after a failure, and "停止" should not mean "stop after 5 more
        // seconds".
        sleep: (ms) => new Promise((resolve) => {
          const done = () => {
            stop.controller.signal.removeEventListener('abort', done);
            clearTimeout(timer);
            resolve();
          };
          const timer = setTimeout(done, ms);
          timer.unref?.();
          stop.controller.signal.addEventListener('abort', done, { once: true });
        }),
        signal: stop.controller.signal,
        onProgress: ({ requests, attempted, planned }) => {
          evidenceProgress = { requests, attempted, planned };
          if (requests % 200 === 0) log?.info?.(`overall-mcp: install evidence at ${requests} requests`);
        },
      });
      // Why it ended, in the walk's own words where the walk can say it and in
      // the host's where only the host knows: `crawlInstallEvidence` reports a
      // flat "已中止" whether a reader stopped it or the plugin unloaded, and a
      // reader who pressed stop is owed the difference.
      const reasonNote = stop.reason === 'user'
        ? `已手动停止（已试 ${walk.attempted} 个仓库，下次接着走）`
        : stop.reason === 'dispose'
          ? `插件被卸载，已停止（已试 ${walk.attempted} 个仓库）`
          : null;
      const body = reasonNote ?? walk.partial;
      // What the user can act on, said once: a pass that stopped because the
      // upstream pushed back is the only stop a credential would have helped —
      // and a stop a reader asked for is not that.
      const hint = body && !stop.reason && !githubAuthStatus().inUse
        ? '（匿名访问：在已注册标签页里填一个 GitHub token，上限从 60 次/小时升到 5000 次/小时）'
        : '';
      const doc = evidenceDocumentOf({
        at: walk.at,
        rows: walk.rows,
        requests: walk.requests,
        partial: body ? `${body}${hint}` : null,
      });
      await writeJson(evidenceFile, doc);
      evidenceDoc = doc;
      evidenceLoaded = true;
      evidenceDamaged = null;
      // The plan this pass set out with. The file keeps the rows but not how
      // many the walk meant to read, so "已试 77 / 2111" would otherwise be
      // forgotten the moment the process reloads the file.
      evidenceLast = {
        at: walk.at,
        planned: walk.planned,
        attempted: walk.attempted,
        remaining: walk.remaining,
        retries: walk.retries,
        requests: walk.requests,
        stopped: stop.reason ?? null,
      };
      const withCommand = doc.rows.filter((row) => row.install).length;
      log?.info?.(`overall-mcp: install evidence ${doc.rows.length} rows, ${withCommand} with a command (${walk.requests} requests, ${walk.retries} retries)`);
      emit({
        kind: 'evidence',
        action: stop.reason ? 'stopped' : 'stop',
        ...(stop.reason ? { reason: stop.reason } : {}),
        requests: walk.requests,
        retries: walk.retries,
        rows: doc.rows.length,
        withCommand,
        planned: walk.planned,
        attempted: walk.attempted,
        remaining: walk.remaining,
        ...(doc.partial ? { partial: doc.partial } : {}),
      });
      return doc;
    })()
      .catch((err) => {
        log?.warn?.(`overall-mcp: install evidence walk failed: ${String(err?.message ?? err)}`);
        emit({ kind: 'evidence', action: 'failed', error: String(err?.message ?? err) });
        return null;
      })
      .finally(() => {
        evidenceEnded = stop.reason ? { reason: stop.reason, at: new Date().toISOString() } : null;
        evidenceCrawl = null;
        evidenceProgress = null;
        if (evidenceStop === stop) evidenceStop = null;
      });
    return evidenceCrawl;
  }

  /**
   * End the install-command walk in flight, if one is walking.
   *
   * @param reason - 'user' (panel button or route) or 'dispose' (host unload).
   * @returns true when a walk was actually asked to stop.
   */
  function stopEvidence(reason = 'user') {
    const stop = evidenceStop;
    if (!stop) return false;
    // First reason wins, exactly as for the census: a reader's stop must not be
    // rewritten as "unloaded" when the plugin disposes a moment later.
    if (!stop.reason) stop.reason = reason;
    emit({ kind: 'evidence', action: 'stopping', reason: stop.reason, ...(evidenceProgress ?? {}) });
    stop.controller.abort();
    return true;
  }

  /**
   * The recovery verbs, in one place so the route and any future caller agree.
   *
   * @param action - 'start' (walk now, fresh or not) | 'stop' | null (read).
   */
  async function doEvidence({ action = null, force = false } = {}) {
    // Read the list of repositories before anything starts: the walk can only
    // read repositories the census knows about, and `maybeCrawlInstallEvidence`
    // reads `githubIndexDoc` directly rather than waiting for a load.
    await readGithubIndex();
    // …and read what has already been recovered, for the same reason plus one
    // that loses data: the walk merges into `evidenceDoc`, so a walk started
    // before the file was read would both re-read rows that already have an
    // answer and write a document containing only the rows *it* touched. The
    // panel happens to read the listing first, which is why this only showed up
    // when a caller started the walk as its very first request.
    await readEvidence();
    if (action === 'stop') {
      const stopping = stopEvidence('user');
      const state = await evidenceState();
      return { ...state, stopping };
    }
    if (action === 'start') {
      const before = evidenceCrawl;
      // `force` here means "re-check rows whose last look found nothing", which
      // is a different promise from "carry on with the rows that are missing":
      // the walk already skips rows that have evidence, and the freshness window
      // is what stops it from re-reading two thousand repositories that
      // genuinely have no manifest every time a reader asks. So the panel's
      // button does not force, and says "没有需要补的仓库" when that is the
      // truth; a forced pass stays available to callers that ask for one.
      const walk = maybeCrawlInstallEvidence({ force: force === true });
      const state = await evidenceState();
      // A start that did not start has to say why, and there are two reasons:
      // no census to read from, or nothing in it still needs a look.
      const skipped = walk !== null
        ? null
        : (githubIndexDoc?.rows?.length ? 'nothing-to-do' : 'no-census');
      return {
        ...state,
        // "Did *this* call start a walk?" — not "is one running now?", which
        // `walking` already answers.
        started: walk !== null && walk !== before,
        ...(skipped ? { skipped } : {}),
      };
    }
    return evidenceState();
  }

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
  let backfilledSpecs = false;
  function annotateItem(item) {
    const entry = catalogItemToEntry(item);
    const name = entry?.name ?? null;
    const installed = name !== null && registry.servers.some((s) => s.name === name);
    if (installed && entry?.config) {
      const match = registry.servers.find((s) => s.name === name);
      if (match && !match.config) {
        match.config = entry.config;
        backfilledSpecs = true;
      }
    }
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
  /**
   * What code is running here, and what this process has been doing.
   *
   * The panel's version chip cannot answer the first question: it is a literal
   * compiled into the page, and a process loads its code once at startup — a
   * checkout edited afterwards keeps reporting the old story.
   * On 2026-10-16 that cost a whole diagnostic round: 「github-mcp 源不可用」 came
   * from a host started the previous day, before the batches that fixed it
   * existed. `source.stale` is exactly that comparison, from file mtimes;
   * `data`/`census`/`quota`/`events` are the second half — which file the panel
   * is actually reading, and how old what it holds is.
   */
  async function statusPayload() {
    const statOf = async (file) => {
      try {
        const s = await fs.stat(file);
        return { bytes: s.size, at: s.mtime.toISOString() };
      } catch {
        return null;
      }
    };
    const relative = ['index.js', 'client/client.js'];
    try {
      for (const name of await fs.readdir(path.join(PLUGIN_DIR, 'lib'))) {
        if (name.endsWith('.js')) relative.push(`lib/${name}`);
      }
    } catch { /* a checkout without lib/ is not worth failing the status over */ }
    const sourceFiles = [];
    for (const rel of relative) {
      const facts = await statOf(path.join(PLUGIN_DIR, rel));
      if (facts) sourceFiles.push({ name: rel, at: facts.at, bytes: facts.bytes });
    }
    const newestSource = sourceFiles.map((f) => f.at).sort().at(-1) ?? null;
    let version = null;
    try {
      version = JSON.parse(await fs.readFile(path.join(PLUGIN_DIR, 'package.json'), 'utf8'))?.version ?? null;
    } catch { /* unreadable package.json is a fact about the checkout, not a failure */ }
    const dataFiles = [];
    for (const file of [registryFile, reportFile, sourcesFile, installsFile, githubIndexFile, evidenceFile, eventsFile]) {
      const facts = await statOf(file);
      dataFiles.push({ name: path.basename(file), ...(facts ?? { bytes: null, at: null }) });
    }
    const census = await githubIndexPayload();
    const uptimeMs = Math.round(process.uptime() * 1000);
    return {
      plugin: {
        id: 'dsh-overall-mcp',
        version,
        dir: PLUGIN_DIR,
        loadedAt: LOADED_AT.toISOString(),
        // The question the panel could not ask: is the code on disk newer than
        // the code this process is running?
        source: {
          newestAt: newestSource,
          stale: newestSource !== null && newestSource > LOADED_AT.toISOString(),
          files: sourceFiles,
        },
      },
      host: {
        pid: process.pid,
        startedAt: new Date(Date.now() - uptimeMs).toISOString(),
        uptimeMs,
        node: process.versions.node ?? null,
        electron: process.versions.electron ?? null,
        platform: process.platform,
        arch: process.arch,
      },
      data: { dir, files: dataFiles },
      census: await censusState(),
      evidence: await evidenceState(),
      quota: githubSearchQuota(),
      // Which credential the GitHub requests are going out with, and how much
      // quota it has left. Token-free by construction (lib/github-auth.js).
      auth: githubAuthStatus(),
      events: await eventFileFacts(eventsFile),
      errors: { registry: registryLoadError, sources: sourcesLoadError },
    };
  }

  async function doBrowse({ query = '', limit = 120, source = '', refresh = false } = {}) {
    const startedAt = Date.now();
    const q = typeof query === 'string' ? query.slice(0, CATALOG_QUERY_MAX) : '';
    // The GitHub census is handed to the browse, so that source reads 1700+
    // repositories off disk instead of 200 off the network. The crawl behind a
    // stale one starts here and is deliberately not awaited.
    const githubIndex = await githubIndexPayload();
    // The census view reads `github-mcp` and only the index half of it. It is
    // told about a walk that is already running — otherwise it would answer
    // "there is no census yet" while one is being built three lines away — but it
    // never *starts* one: starting a census is an explicit action on the GitHub
    // access card, not a side effect of choosing a filter in the market.
    const censusView = source === CENSUS_SOURCE;
    // A walk just started (or is running) and has produced nothing yet. The
    // browse is told, so the GitHub source answers "正在建立索引" instead of
    // spending the *same* 10-per-minute search budget the walk is spending —
    // which is how this source used to report itself as unavailable.
    const walk = (!source || source === 'github-mcp') ? maybeCrawlGithubIndex({ force: refresh }) : null;
    const githubWalk = !githubIndex && (censusView || walk)
      ? (githubWalkProgress ?? (censusView ? null : { requests: 0, rows: 0 }))
      : null;
    // Rows the census cannot install by itself get their command from their own
    // repository when that walk has already recovered one. The listing is
    // annotated here rather than in the source, so the cached census stays a
    // faithful copy of what GitHub answered and the evidence stays swappable.
    // The walk itself is *not* started here: reading the market must not cost
    // thousands of requests, so it starts from the census walk or an explicit
    // POST — the panel asks for one when the market page opens.
    const evidence = await evidenceById();
    // The listing is cached RAW: the installed flag depends on the registry and
    // is recomputed on every read, so installing/removing never shows a stale badge.
    const result = await browseCatalog({
      query: q, limit, source, customSources, cache: catalogCache, force: refresh, githubIndex, githubWalk,
    });
    // The GitHub row count is the census; how many of those rows came back with a
    // command from their own repository is a second number the panel has to be
    // able to tell apart, so it travels on the source record.
    if (result.sources['github-mcp'] && evidence.size) {
      result.sources['github-mcp'].install = await evidenceState();
    }
    // The panel says how old the listing is; with several sources that can
    // differ, so the age reported is the oldest one still standing.
    const oldest = Object.values(result.sources)
      .map((s) => s.at)
      .filter((at) => typeof at === 'string')
      .sort()[0];
    // One line per read of the market: what was asked, and how it went. The
    // per-source lines are already emitted inside `browseCatalog`.
    emit({
      kind: 'browse',
      source: source || 'all',
      query: q || null,
      items: result.items.length,
      total: result.total,
      cached: Object.values(result.sources).every((s) => s.cached === true),
      errors: result.errors.length,
      ms: Date.now() - startedAt,
    });
    const items = result.items
      .map((item) => applyInstallEvidence(item, evidence.get(item.id)))
      .map(annotateItem);
    if (backfilledSpecs) {
      backfilledSpecs = false;
      await save();
    }
    return {
      // Evidence first: `annotateItem` derives `installable` from the row's
      // install, so a recovered command has to be on the row before it runs.
      items,
      errors: result.errors,
      // The panel prints one number per source beside 「共 N 条」, so it has to be
      // the number of *cards* that source is credited with after the merge — the
      // raw walked counts still live in `sources[id].items`, and the overlap is
      // carried separately (`deduped`) so the line can say where the difference
      // went instead of leaving the reader to wonder why the parts sum to more
      // than the whole.
      counts: result.mergedCounts,
      deduped: result.deduped,
      sources: result.sources,
      total: result.total,
      // "cached" means every source answered from what we already held — the
      // panel writes the listing's age next to it, so a mixed read must not
      // claim to be one.
      cached: Object.values(result.sources).every((s) => s.cached === true),
      notModified: Object.values(result.sources).reduce((sum, s) => sum + (s.notModified ?? 0), 0),
      fetchedAt: new Date(oldest ?? Date.now()).toISOString(),
      // A view says whose rows it borrowed, so the panel can label a number it
      // would otherwise attribute to the upstream alone. Absent for every real
      // source read, which is every read that existed before this.
      ...(result.aliasOf ? { aliasOf: result.aliasOf } : {}),
      servers: (await serversPayload()).servers,
    };
  }

  /**
   * The user's own catalogue sources, as the panel reads them. The listing is
   * kept out of `/catalog`: it answers "what is on the market", not "what am I
   * pointing at", and the page needs the second before it has a listing at all.
   *
   * Each row also carries where that list *accepts submissions*, when it is a
   * GitHub repository — derived here rather than in the panel so the URL shapes
   * (`raw.githubusercontent.com/…`, `cdn.jsdelivr.net/gh/…`, a plain repo link)
   * are known in one place. A source hosted anywhere else simply has no
   * `submission`, which is what keeps the panel's 「投稿」 link hidden by default.
   */
  function sourcesPayload() {
    return {
      sources: customSources.map((s) => ({ id: s.id, label: s.label, url: s.url, submission: submissionTargetFor(s.url) })),
      max: SOURCES_MAX,
      error: sourcesLoadError,
    };
  }

  /**
   * The issue an entry for this catalogue should be filed as. The body is the
   * template with its placeholders left in: the panel knows the *list*, not the
   * server the user means to add, so it pre-fills the form rather than the facts.
   */
  function submissionTargetFor(url) {
    const coords = githubRepoOfSourceUrl(url);
    if (!coords) return null;
    const repo = `${coords.owner}/${coords.repo}`;
    const issueUrl = buildIssueUrl({ repo, row: {} });
    return issueUrl ? { repo, url: issueUrl } : null;
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
    emit({ kind: 'source-config', action: 'add', id: next.source.id, url: next.source.url, label: next.source.label });
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
    emit({ kind: 'source-config', action: 'remove', id: removed.id, url: removed.url, label: removed.label, dropped });
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
  const doConfigure = serialized(doConfigureImpl);
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
      description: 'Search public open MCP server catalogs (official modelcontextprotocol registry, Smithery, Docker MCP Catalog, GitHub repository search for MCP servers, awesome-remote-mcp-servers, awesome-mcp-servers) by keyword and return up to 50 installable candidates.',
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
        // The GitHub census is read here too (no request, no crawl): an agent
        // asking about a repository ranked 900th should find it.
        return await browseCatalog({
          query, limit: 50, customSources, cache: catalogCache, githubIndex: await githubIndexPayload(),
        });
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
      name: 'overall_mcp_configure',
      description: 'Save the settings one installed MCP server needs before its tools work (API keys, tokens, base URLs, auth headers) and remount it so they take effect. overall_mcp_list marks those rows with needConfig: true and lists the required keys in config.missing; each row\'s config.fields says which of them are secrets and which env/header they belong to. Pass values keyed by those field names — {"env": {"GITHUB_PERSONAL_ACCESS_TOKEN": "…"}} or {"headers": {"Authorization": "Bearer …"}}. An empty string clears a key. Values are write-only: the reply echoes secrets as •••• and never returns them.',
      parameters: {
        name: { type: 'string', required: true },
        env: { type: 'json', description: 'Environment values keyed by variable name, e.g. {"GITHUB_PERSONAL_ACCESS_TOKEN": "ghp_…"}.' },
        headers: { type: 'json', description: 'HTTP header values for a remote (streamable-http) entry, e.g. {"Authorization": "Bearer …"}.' },
        slot: { type: 'integer', description: 'Position of the row in the overall_mcp_list answer, to pick one of several same-named entries.' },
        from: { type: 'string', description: 'Version the row displayed (fallback for a client that rendered before slots existed).' },
      },
      output: jsonOut,
      async execute({ name, env, headers, slot, from }) {
        return await doConfigure(name, { env, headers }, {
          slot: Number.isInteger(slot) ? slot : null,
          from: typeof from === 'string' && from !== '' ? from : null,
          actor: 'model',
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
      // Which build is running, and what it has been doing. The panel showed a
      // source as unavailable while the reason lived in a process that had
      // already exited; these two are the answer to "which build is this, and
      // what happened?" (see lib/events.js).
      ['/api/overall-mcp/status', ['GET'], guard(async () => json(await statusPayload()))],
      // The GitHub credential, as a separate resource rather than a corner of
      // /status. One entry per path: the host keys registrations by path, so a
      // second entry for `/auth` would replace this one instead of adding a
      // method (the test harness maps routes the same way).
      //
      // Reading it is free; `?gh=1` additionally asks `gh auth token`, which
      // spawns a process — that is a discovery the panel requests explicitly
      // (`重新检测本机登录`), never a side effect of opening a page.
      ['/api/overall-mcp/auth', ['GET', 'POST', 'DELETE'], guard(async (req) => {
        if (req.method === 'POST') {
          const body = await readBody(req);
          const token = typeof body.token === 'string' ? body.token.trim() : '';
          if (!token) return json({ error: 'token 不能为空', status: 400 }, 400);
          try {
            const stored = await storeToken(dir, token);
            const status = await refreshGithubAuth({ force: true });
            emit({
              kind: 'auth',
              action: 'set',
              source: status.source,
              masked: status.masked,
              login: status.login,
              ok: !status.error,
              ...(status.error ? { error: status.error } : {}),
            });
            return json({ ...status, storedAt: stored.at });
          } catch (err) {
            const message = String(err?.message ?? err);
            emit({ kind: 'auth', action: 'set', ok: false, error: message });
            return json({ error: `保存 token 失败：${message}`, status: 500 }, 500);
          }
        }
        if (req.method === 'DELETE') {
          const removed = await clearToken(dir);
          const status = await refreshGithubAuth({ force: true });
          emit({ kind: 'auth', action: 'clear', removed, source: status.source });
          return json({ ...status, removed });
        }
        const useGh = new URL(req.url).searchParams.get('gh') === '1';
        return json(await refreshGithubAuth({ useGh, force: useGh }));
      })],
      ['/api/overall-mcp/events', ['GET'], guard(async (req) => {
        const url = new URL(req.url);
        const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 100, 1), 500);
        const { events, damaged, total } = await readEvents(eventsFile, { limit });
        return json({ events, damaged, total });
      })],
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
      // The census, and the two verbs a reader owns: `start` (a walk now, fresh
      // or not) and `stop` (end the one in flight). Before this route the walk
      // was only ever started as a side effect of browsing, which meant nobody
      // could ask for one — and, worse, nobody could end one: a census paces
      // itself at 6.5s per request for up to 48 requests, so "I did not want
      // this" had no answer. GET reads; only POST acts.
      ['/api/overall-mcp/census', ['GET', 'POST'], guard(async (req) => {
        const body = req.method === 'POST' ? await readBody(req) : {};
        const url = new URL(req.url);
        const actionRaw = body.action ?? url.searchParams.get('action');
        const action = typeof actionRaw === 'string' ? actionRaw.trim().toLowerCase() : '';
        if (action && action !== 'start' && action !== 'stop') {
          // A verb we do not know is a caller error, not a no-op: answering
          // "here is the state" to a mistyped `action: "stop "` would read as
          // success (the same reason `on` must be a boolean elsewhere).
          throw new Error(`unknown census action: ${actionRaw}`);
        }
        if (req.method === 'GET' && action) {
          // Reading never changes state, even here: the two verbs are POSTs.
          throw new Error(`the census action ${actionRaw} must be sent as a POST`);
        }
        return json(await doCensus({ action: action || null }));
      })],
      // The install evidence behind the GitHub rows: what has been recovered,
      // and the two verbs over the walk that recovers it. The panel asks for a
      // walk when it opens the market, so a reader who never opens it never pays
      // for it; before this route took verbs, a walk in flight could only be
      // ended by unloading the plugin, and the reader who started it had no way
      // to say stop.
      //
      // `POST` without an `action` still means "start" (that is what the market
      // page has always sent when it opens), so the older callers keep working.
      ['/api/overall-mcp/install-evidence', ['GET', 'POST'], guard(async (req) => {
        const body = req.method === 'POST' ? await readBody(req) : {};
        const url = new URL(req.url);
        const actionRaw = body.action ?? url.searchParams.get('action');
        const action = typeof actionRaw === 'string' ? actionRaw.trim().toLowerCase() : '';
        if (action && action !== 'start' && action !== 'stop') {
          // A verb we do not know is a caller error, not a no-op (the same
          // reason the census route refuses one).
          throw new Error(`unknown evidence action: ${actionRaw}`);
        }
        if (req.method === 'GET' && action) {
          // Reading never changes state: a GET that stops a walk would make an
          // innocent prefetch the difference between a running and a stopped
          // recovery (and the same two lines guard the census route now).
          throw new Error(`the evidence action ${actionRaw} must be sent as a POST`);
        }
        const force = body.force === true || url.searchParams.get('force') === '1';
        const state = await doEvidence({ action: action || (req.method === 'POST' ? 'start' : null), force });
        return json(state);
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
        const result = await doSetEnabled(name, enabled, {
          slot: Number.isInteger(slot) ? slot : null,
          from: typeof from === 'string' && from !== '' ? from : null,
        });
        // Mounting is the other action worth a line: the panel's badges say what
        // is mounted *now*, never that a user asked for a change.
        emit({
          kind: 'mount',
          name,
          enabled,
          ...(result?.status ? { status: result.status } : {}),
          ...(result?.error ? { error: String(result.error) } : {}),
        });
        return json(result);
      })],
      ['/api/overall-mcp/configure', ['POST'], guard(async (req) => {
        const { name, env, headers, slot, from } = await readBody(req);
        if (typeof name !== 'string' || name === '') return json({ error: 'name (string) required' }, 400);
        return json(await doConfigure(name, { env, headers }, {
          slot: Number.isInteger(slot) ? slot : null,
          from: typeof from === 'string' && from !== '' ? from : null,
          actor: 'user',
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
        const result = await doUpdate(name, {
          slot: Number.isInteger(slot) ? slot : null,
          from: typeof from === 'string' && from !== '' ? from : null,
        });
        emit({
          kind: 'update',
          target: name,
          updated: result?.updated === true,
          ...(result?.from ? { from: result.from } : {}),
          ...(result?.to ? { to: result.to } : {}),
          ...(result?.reason ? { reason: result.reason } : {}),
        });
        return json(result);
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
    // A walk in flight reads the network; it stops with the plugin rather than
    // outliving it (it writes what it found, so nothing is lost by stopping).
    // Both walks get the same treatment now — before this, the census outlived
    // the plugin and kept spending a search budget nobody was reading.
    stopCensus('dispose');
    stopEvidence('dispose');
    for (const dispose of disposers) dispose();
    for (const fiber of fibers.values()) {
      Promise.resolve(fiber.dispose()).catch(() => {});
    }
    fibers.clear();
  }, 'overall-mcp.cleanup');
}
