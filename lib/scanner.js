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
    notes: '',
    importedAt: new Date().toISOString(),
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
 * Merge scan results into an existing registry. Dedup by name:
 * existing manual entries win; imported entries update in place if unchanged.
 * Returns { registry, added, updated, skipped } without mutating inputs.
 */
export function mergeIntoRegistry(registry, found) {
  const reg = { version: 1, servers: [...(registry?.servers ?? [])] };
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
    if (sameContract) {
      skipped.push(entry.name);
    } else {
      const renamed = { ...entry, name: `${entry.name}-${entry.source}` };
      reg.servers.push(renamed);
      added.push(renamed.name);
    }
  }
  return { registry: reg, added, updated, skipped };
}
