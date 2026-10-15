// lib/scanner.js — host-wide MCP config discovery & normalization (pure, zero-dependency).
// Only reads an explicit whitelist of well-known config paths; never recursive-scans the home dir.

import { promises as fs } from 'node:fs';
import os from 'node:os';

/** Expand ~ and well-known env roots across platforms. */
export function home() {
  return os.homedir();
}

/** Candidate config files to scan, keyed by app name. Paths use forward slashes; resolved per-platform. */
export function scanTargets(homedir = home()) {
  // Canonical forward-slash paths: fs accepts them on Windows too, and it keeps
  // path keys stable across platforms (path.join would flip to backslashes).
  const t = (p) => p.replace(/\/+/g, '/');
  const targets = [];
  const push = (app, file, label = '') => targets.push({ app, file, label });

  if (process.platform === 'win32') {
    const appdata = process.env.APPDATA || `${homedir}/AppData/Roaming`;
    const localappdata = process.env.LOCALAPPDATA || `${homedir}/AppData/Local`;
    push('claude-desktop', t(`${appdata}/Claude/claude_desktop_config.json`));
    // VS Code variants (user scope mcp.json)
    push('vscode', t(`${appdata}/Code/User/mcp.json`));
    push('vscode-insiders', t(`${appdata}/Code - Insiders/User/mcp.json`));
    push('windsurf', t(`${appdata}/Windsurf/User/mcp_config.json`));
    push('windsurf', t(`${homedir}/.codeium/windsurf/mcp_config.json`));
    push('gemini-cli', t(`${homedir}/.gemini/settings.json`));
  } else if (process.platform === 'darwin') {
    push('claude-desktop', t(`${homedir}/Library/Application Support/Claude/claude_desktop_config.json`));
    push('vscode', t(`${homedir}/Library/Application Support/Code/User/mcp.json`));
    push('windsurf', t(`${homedir}/.codeium/windsurf/mcp_config.json`));
    push('gemini-cli', t(`${homedir}/.gemini/settings.json`));
  } else {
    push('claude-desktop', t(`${homedir}/.config/Claude/claude_desktop_config.json`));
    push('vscode', t(`${homedir}/.config/Code/User/mcp.json`));
    push('windsurf', t(`${homedir}/.codeium/windsurf/mcp_config.json`));
    push('gemini-cli', t(`${homedir}/.gemini/settings.json`));
  }
  // Cross-platform dotfiles
  push('claude-code', t(`${homedir}/.claude.json`));
  push('claude-code', t(`${homedir}/.claude/settings.json`));
  push('cursor', t(`${homedir}/.cursor/mcp.json`));
  push('codex-cli', t(`${homedir}/.codex/config.toml`));
  return targets;
}

/**
 * Normalize one raw MCP server definition into the registry entry shape.
 * Accepts stdio ({command,args,env}) and http ({url,headers}) variants,
 * including {type:'stdio'|'http'} discriminators used by newer configs.
 * Returns null for unusable entries.
 */
export function normalizeServer(name, raw, source) {
  if (!raw || typeof raw !== 'object') return null;
  const base = {
    name,
    source,                  // app id the entry was imported from
    enabled: raw.disabled !== true && raw.enabled !== false,
  };
  const type = raw.type || (raw.url ? 'http' : 'stdio');
  if (type === 'http' || type === 'sse' || type === 'streamable-http') {
    if (!raw.url || typeof raw.url !== 'string') return null;
    return {
      ...base,
      transport: type === 'sse' ? 'sse' : 'streamable-http',
      url: raw.url,
      headers: sanitizeHeaders(raw.headers ?? raw.header),
    };
  }
  // stdio
  if (!raw.command || typeof raw.command !== 'string') return null;
  return {
    ...base,
    transport: 'stdio',
    command: raw.command,
    args: Array.isArray(raw.args) ? raw.args.filter((a) => typeof a === 'string') : [],
    env: sanitizeEnv(raw.env),
    cwd: typeof raw.cwd === 'string' ? raw.cwd : undefined,
  };
}

export function sanitizeHeaders(headers) {
  if (!headers || typeof headers !== 'object') return {};
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    if (typeof k === 'string' && typeof v === 'string') out[k] = v;
  }
  return out;
}

/** Keep only string env values; never expand referenced variables at import time. */
export function sanitizeEnv(env) {
  if (!env || typeof env !== 'object') return {};
  const out = {};
  for (const [k, v] of Object.entries(env)) {
    if (typeof k === 'string' && typeof v === 'string') out[k] = v;
  }
  return out;
}

/** Extract { name: rawServer } maps from a parsed JSON config document. */
export function extractJsonServers(doc) {
  if (!doc || typeof doc !== 'object') return {};
  return doc.mcpServers && typeof doc.mcpServers === 'object' ? doc.mcpServers : {};
}

/**
 * Minimal TOML [mcp_servers.<name>] extraction for Codex CLI config.toml.
 * Handles: string values, arrays of strings, inline tables skipped (rare).
 * Not a full TOML parser — intentionally conservative.
 */
export function extractCodexTomlServers(text) {
  const servers = {};
  if (typeof text !== 'string') return servers;
  let current = null;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    const m = line.match(/^\[mcp_servers\.([A-Za-z0-9_.-]+)\]$/);
    if (m) {
      current = m[1];
      servers[current] = {};
      continue;
    }
    if (line.startsWith('[')) { current = null; continue; }
    if (!current) continue;
    const kv = line.match(/^([A-Za-z0-9_]+)\s*=\s*(.+)$/);
    if (!kv) continue;
    const [, key, valueRaw] = kv;
    const val = valueRaw.trim();
    if (val.startsWith('[')) {
      // string array
      const items = [...val.matchAll(/"([^"]*)"/g)].map((x) => x[1]);
      servers[current][key] = items;
    } else if (val.startsWith('"')) {
      servers[current][key] = val.slice(1, -1);
    } else if (val === 'true' || val === 'false') {
      servers[current][key] = val === 'true';
    }
  }
  return servers;
}

/**
 * Scan the host whitelist and return { found: Entry[], report: {app,file,serverNames,error?}[] }.
 * Missing/unreadable files are reported and skipped — scan never throws.
 */
export async function scanHost({ homedir = home(), readFile = fs.readFile } = {}) {
  const report = [];
  const found = [];
  for (const target of scanTargets(homedir)) {
    const item = { app: target.app, file: target.file, serverNames: [] };
    try {
      const text = await readFile(target.file, 'utf8');
      let rawServers = {};
      if (target.file.endsWith('.toml')) {
        rawServers = extractCodexTomlServers(text);
      } else {
        rawServers = extractJsonServers(JSON.parse(text));
      }
      for (const [name, raw] of Object.entries(rawServers)) {
        const entry = normalizeServer(name, raw, target.app);
        if (entry) {
          found.push(entry);
          item.serverNames.push(name);
        }
      }
    } catch (err) {
      item.error = err.code === 'ENOENT' ? 'not-found' : String(err.message || err);
    }
    if (item.serverNames.length || (item.error && item.error !== 'not-found')) report.push(item);
    else if (item.serverNames.length === 0 && item.error === 'not-found') { /* skip silent */ }
  }
  return { found, report };
}

/**
 * Summarize a scan report as `{ sources: { app: [name] }, unreadable: [file] }`.
 *
 * A source appears only when at least one of its files was actually READ, so
 * "this app defines no server" and "this app is not installed here" never look
 * alike. That distinction is what lets findOrphans() stay silent instead of
 * guessing.
 */
export function scannedSources(report) {
  const sources = {};
  const unreadable = [];
  for (const item of report ?? []) {
    if (item.error) {
      if (item.error !== 'not-found') unreadable.push(item.file);
      continue;
    }
    const list = sources[item.app] ?? (sources[item.app] = []);
    for (const name of item.serverNames ?? []) {
      if (!list.includes(name)) list.push(name);
    }
  }
  return { sources, unreadable };
}

/**
 * Registry entries a scan can *prove* are gone.
 *
 * An entry qualifies only when its source was read by that scan and no longer
 * defines a server by this name. Anything less stays out:
 * - an entry the user added by hand (`source` absent or `'manual'`) is theirs;
 * - a source the scan could not read (file missing, permission denied) is
 *   unknown, not empty — deleting on that basis would throw away a working
 *   entry because a file moved;
 * - an entry that HOLDS A MOUNT (`serverName` set) is serving tools right now.
 *   On this machine that is the `rea-cursor` row pinned at 6.5.0: no config file
 *   mentions it either, yet it is the mount behind the `mcp__rea-cursor__*`
 *   tools, so a cleanup must not be able to take it away. It is a leftover only
 *   in the bookkeeping sense, and the panel shows it as an ordinary live server.
 *   The marker has to be *exclusive* for that to mean anything — see
 *   setMountHolder().
 *
 * This exists because the first version of the merge renamed a conflicting
 * import to `name-<source>` and pushed it as a new row on every scan, so a
 * config that defined `rea` while an entry named `rea` already existed left
 * `rea-cursor` ghosts behind (three of them, pinned to a stale version, none of
 * them mounted). The rename is gone; this is how those rows are found again and
 * cleaned up, with the evidence that they are really gone.
 */
export function findOrphans(registry, scanned) {
  const sources = scanned?.sources;
  if (!sources) return [];
  return (registry?.servers ?? []).filter((s) => {
    if (!s?.source || s.source === 'manual') return false;
    if (s.serverName) return false;
    const names = sources[s.source];
    if (!Array.isArray(names)) return false;
    return !names.includes(s.name);
  });
}

/**
 * Stamp the one row of a name that actually holds the mount.
 *
 * `fibers` is keyed by server name, so at most one row per name can own a mount
 * at a time — but `connect()` only ever stamped the row it mounted, and nothing
 * cleared the previous holder. A run of per-row 「更新」 on four same-named rows
 * therefore left three of them carrying `serverName` while only the last mount
 * existed, and since findOrphans() reads that field to tell a live server from a
 * leftover, three inert ghosts became un-cleanable (the panel offered to clean
 * one of four). Here the marker is exclusive by construction, or absent.
 *
 * Mutates the rows in place: this is bookkeeping on the live registry, not a
 * value the caller threads back.
 */
export function setMountHolder(servers, name, holder, serverName) {
  for (const s of servers ?? []) {
    if (s?.name !== name) continue;
    if (s === holder) s.serverName = serverName;
    else delete s.serverName;
  }
}

/** Nothing is mounted for this name any more, so no row of it may claim one. */
export function clearMountHolder(servers, name) {
  for (const s of servers ?? []) {
    if (s?.name === name) delete s.serverName;
  }
}

/**
 * Merge scan results into an existing registry. Dedup by name:
 * - an entry the user added by hand (`source` absent or `'manual'`) owns its
 *   name and is never overwritten by a scan;
 * - an imported entry whose contract changed on disk is updated **in place**,
 *   so the name stays stable and a re-scan cannot pile up `name-<source>` rows;
 * - an imported entry that is byte-identical is reported as skipped, which
 *   preserves local state (an explicit `enabled: false` survives a re-scan).
 * Returns { registry, added, updated, skipped } without mutating inputs.
 */
export function mergeIntoRegistry(registry, found) {
  // Every top-level key the document carries survives the merge — notably
  // `favorites` (the market bookmarks), which this function used to drop: the
  // caller then saved the merged object, so one scan silently un-starred
  // everything the user had bookmarked.
  const reg = { ...(registry ?? {}), version: 1, servers: [...(registry?.servers ?? [])] };
  const byName = new Map(reg.servers.map((s) => [s.name, s]));
  const added = [], updated = [], skipped = [];
  for (const entry of found) {
    const existing = byName.get(entry.name);
    if (!existing) {
      reg.servers.push(entry);
      byName.set(entry.name, entry);
      added.push(entry.name);
      continue;
    }
    const sameContract =
      existing.transport === entry.transport &&
      existing.command === entry.command &&
      existing.url === entry.url &&
      JSON.stringify(existing.args ?? []) === JSON.stringify(entry.args ?? []);
    const manual = !existing.source || existing.source === 'manual';
    if (sameContract || manual) {
      skipped.push(entry.name);
      continue;
    }
    const merged = {
      ...existing,
      ...entry,
      name: existing.name,
      // A local "停用" outranks the config file; otherwise the config wins.
      enabled: existing.enabled === false ? false : entry.enabled,
    };
    reg.servers[reg.servers.indexOf(existing)] = merged;
    byName.set(merged.name, merged);
    updated.push(merged.name);
  }
  return { registry: reg, added, updated, skipped };
}
