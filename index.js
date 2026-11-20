// Generated release host. Rebuild with npm run release:tree; do not overlay individual files.
import { createHash as releaseHash } from "node:crypto";
import { readFileSync as readReleaseFile } from "node:fs";
{
  const clientUrl = new URL("./client/client.js", import.meta.url);
  const manifestUrl = new URL("./package.json", import.meta.url);
  try {
    const manifest = JSON.parse(readReleaseFile(manifestUrl, "utf8"));
    if (manifest.version !== "1.0.7") throw new Error("package.json version does not match the host");
    const digest = releaseHash("sha256").update(readReleaseFile(clientUrl)).digest("hex");
    if (digest !== "9c071c110dd5606d372211c060d74d3bd620fab9896b70e0ad3035349f485505") throw new Error("client/client.js does not match the host");
  } catch (cause) {
    throw new Error("dsh-overall-mcp 1.0.7: 插件文件不完整或版本不一致，请用 DSH 重新安装完整插件包。原因：" + cause.message, { cause });
  }
}

// index.js
import { promises as fs5 } from "node:fs";
import { spawn } from "node:child_process";
import os3 from "node:os";
import path7 from "node:path";
import { fileURLToPath as fileURLToPath2 } from "node:url";
import * as mcpClient from "@deepseek-ai/dsh-mcp-client";
import { BlockAssembler } from "@deepseek-ai/dsh-llm";
import { defineTool } from "@deepseek-ai/dsh-tools";

// lib/about.js
var ABOUT_MAX_CHARS = 150;
var TRANSPORT_HEADING = /^#{1,6}\s*MCP server:\s*\S+\s*$/i;
var HEADING = /^#{1,6}\s*(.+)$/;
var RULE = /^([-*_])\1{2,}$/;
var IMAGE_ONLY = /^!\[[^\]]*\]\([^)]*\)$/;
function stripInlineMarkdown(text) {
  return String(text ?? "").replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/`{1,3}([^`]*)`{1,3}/g, "$1").replace(/\*\*([^*]+)\*\*/g, "$1").replace(/(^|\s)[*_](\S[^*_]*)[*_]/g, "$1$2").replace(/\s+/g, " ").trim();
}
function firstParagraph(instructions) {
  const lines = String(instructions ?? "").split(/\r?\n/);
  let heading = "";
  let current = [];
  const paragraphs = [];
  const flush = () => {
    if (current.length) {
      paragraphs.push(current.join(" "));
      current = [];
    }
  };
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) {
      flush();
      continue;
    }
    if (TRANSPORT_HEADING.test(line)) {
      flush();
      continue;
    }
    if (RULE.test(line)) {
      flush();
      continue;
    }
    const asHeading = HEADING.exec(line);
    if (asHeading) {
      flush();
      if (!heading) heading = stripInlineMarkdown(asHeading[1]);
      continue;
    }
    if (/^[A-Za-z][A-Za-z /&-]{0,30}:$/.test(line)) {
      flush();
      continue;
    }
    if (IMAGE_ONLY.test(line)) {
      flush();
      continue;
    }
    current.push(line);
  }
  flush();
  const paragraph = paragraphs.find((p) => stripInlineMarkdown(p).length >= 24);
  const cleaned = paragraph ? stripInlineMarkdown(paragraph) : "";
  return cleaned || heading || "";
}
function clampLine(text, maxChars = ABOUT_MAX_CHARS) {
  const value = stripInlineMarkdown(text);
  if (value.length <= maxChars) return value;
  const window = value.slice(0, maxChars);
  const sentence = Math.max(window.lastIndexOf("\u3002"), window.lastIndexOf(". "), window.lastIndexOf("\uFF1B"), window.lastIndexOf("; "));
  if (sentence >= maxChars * 0.5) return window.slice(0, sentence + 1).trim();
  const space = window.lastIndexOf(" ");
  const cut = space >= maxChars * 0.6 ? window.slice(0, space) : window;
  return `${cut.trim()}\u2026`;
}
function toolNamesFor(schemas, serverName) {
  const prefix = `mcp__${serverName}__`;
  if (!Array.isArray(schemas) || !serverName) return [];
  return schemas.map((s) => typeof s?.name === "string" ? s.name : "").filter((name2) => name2.startsWith(prefix)).map((name2) => name2.slice(prefix.length));
}
function describeAbout({ instructions, toolNames, command, maxChars = ABOUT_MAX_CHARS } = {}) {
  const fromServer = clampLine(firstParagraph(instructions), maxChars);
  if (fromServer) return { text: fromServer, source: "server", toolCount: 0 };
  const names = Array.isArray(toolNames) ? toolNames.filter(Boolean) : [];
  if (names.length) {
    const shown = names.slice(0, 3).join("\u3001");
    const text = names.length > 3 ? `\u5DE5\u5177\uFF1A${shown} \u7B49 ${names.length} \u4E2A` : `\u5DE5\u5177\uFF1A${shown}`;
    return { text: clampLine(text, maxChars), source: "tools", toolCount: names.length };
  }
  const line = clampLine(Array.isArray(command) ? command.filter(Boolean).join(" ") : command, maxChars);
  return line ? { text: line, source: "command", toolCount: 0 } : null;
}
function aboutSourceLabel(source, { connecting = false } = {}) {
  if (source === "server") return "\u6765\u81EA\u670D\u52A1\u5668\u81EA\u8EAB\u7684\u8BF4\u660E\uFF08MCP initialize\uFF09";
  if (source === "tools") return "\u6839\u636E\u8BE5\u670D\u52A1\u5668\u5DF2\u6CE8\u518C\u7684\u5DE5\u5177\u63A8\u65AD";
  if (source === "command") {
    return connecting ? "\u5C1A\u672A\u8FDE\u63A5\uFF0C\u5148\u663E\u793A\u542F\u52A8\u547D\u4EE4\uFF1B\u8FDE\u63A5\u6210\u529F\u540E\u6539\u4E3A\u670D\u52A1\u5668\u81EA\u8EAB\u8BF4\u660E" : "\u5C1A\u672A\u8FDE\u63A5\uFF0C\u663E\u793A\u542F\u52A8\u547D\u4EE4";
  }
  return "";
}
function needsInstructionsRead({ read, rememberedGen, live, name: name2 } = {}) {
  if (!name2) return false;
  if (!read) return true;
  return rememberedGen !== (live ? "live" : "down");
}

// lib/health.js
function waitedSeconds(waitedMs) {
  const ms = Number(waitedMs);
  if (!Number.isFinite(ms) || ms <= 0) return 0;
  return Math.max(1, Math.round(ms / 1e3));
}
function handshakeCheck({ mounted, starting, waitedMs = 0 } = {}) {
  if (!mounted) return { ok: false, detail: "\u672A\u5F00\u59CB" };
  if (!starting) return { ok: true, detail: "\u63E1\u624B\u5B8C\u6210" };
  const seconds = waitedSeconds(waitedMs);
  if (seconds === 0) {
    return { ok: false, detail: "\u63E1\u624B\u4ECD\u672A\u5B8C\u6210" };
  }
  return {
    ok: false,
    detail: `\u63E1\u624B\u5728 ${seconds}s \u5185\u4ECD\u672A\u5B8C\u6210\uFF08\u8FD9\u6761\u547D\u4EE4\u53EF\u80FD\u8981\u6C42\u4EA4\u4E92\u5F0F\u767B\u5F55\uFF0C\u6216\u9996\u6B21\u8FD0\u884C\u6B63\u5728\u4E0B\u8F7D\uFF09`
  };
}

// lib/remote-auth.js
var INITIALIZE_BODY = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "dsh-overall-mcp/probe", version: "0" }
  }
};
function challengeOf(header) {
  const text = typeof header === "string" ? header.trim() : "";
  if (text === "") return null;
  const space = text.search(/\s/);
  const scheme = (space === -1 ? text : text.slice(0, space)).toLowerCase();
  const params = {};
  const rest = space === -1 ? "" : text.slice(space + 1);
  for (const match of rest.matchAll(/([A-Za-z_][A-Za-z0-9_-]*)\s*=\s*"([^"]*)"/g)) {
    params[match[1].toLowerCase()] = match[2];
  }
  return { scheme, params };
}
function authDemandOf(status, header) {
  const code = Number(status);
  if (Number.isFinite(code) && code >= 200 && code < 300) return { status: code, required: false };
  if (code !== 401) return { status: Number.isFinite(code) ? code : null, required: null };
  const challenge = challengeOf(header);
  const bearer = challenge?.scheme === "bearer";
  return {
    status: 401,
    // A `401` without a `Bearer` challenge is still a `401`: something is gated.
    required: true,
    ...challenge ? { scheme: challenge.scheme } : {},
    ...challenge?.params?.error_description ? { description: challenge.params.error_description } : {},
    ...challenge?.params?.resource_metadata ? { resource: challenge.params.resource_metadata } : {},
    ...bearer ? {} : { raw: true }
  };
}
async function enrichOauth(demand) {
  if (!demand || demand.required !== true || typeof demand.resource !== "string") return demand;
  return { ...demand, oauth: true };
}
async function probeRemoteAuth(url, { timeoutMs = 5e3, fetchImpl = globalThis.fetch } = {}) {
  if (typeof url !== "string" || !/^https?:\/\//i.test(url)) return null;
  if (typeof fetchImpl !== "function") return null;
  try {
    const res = await fetchImpl(url, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify(INITIALIZE_BODY),
      signal: typeof AbortSignal?.timeout === "function" ? AbortSignal.timeout(timeoutMs) : void 0
    });
    try {
      await res.text();
    } catch {
    }
    return enrichOauth(authDemandOf(res.status, res.headers?.get?.("www-authenticate")), { fetchImpl });
  } catch {
    return null;
  }
}

// lib/scanner.js
import { promises as fs } from "node:fs";
import os from "node:os";
function home() {
  return os.homedir();
}
function scanTargets(homedir = home()) {
  const t = (p) => p.replace(/\/+/g, "/");
  const targets = [];
  const push = (app, file, label = "") => targets.push({ app, file, label });
  if (process.platform === "win32") {
    const appdata = process.env.APPDATA || `${homedir}/AppData/Roaming`;
    push("claude-desktop", t(`${appdata}/Claude/claude_desktop_config.json`));
    push("vscode", t(`${appdata}/Code/User/mcp.json`));
    push("vscode-insiders", t(`${appdata}/Code - Insiders/User/mcp.json`));
    push("windsurf", t(`${appdata}/Windsurf/User/mcp_config.json`));
    push("windsurf", t(`${homedir}/.codeium/windsurf/mcp_config.json`));
    push("gemini-cli", t(`${homedir}/.gemini/settings.json`));
  } else if (process.platform === "darwin") {
    push("claude-desktop", t(`${homedir}/Library/Application Support/Claude/claude_desktop_config.json`));
    push("vscode", t(`${homedir}/Library/Application Support/Code/User/mcp.json`));
    push("windsurf", t(`${homedir}/.codeium/windsurf/mcp_config.json`));
    push("gemini-cli", t(`${homedir}/.gemini/settings.json`));
  } else {
    push("claude-desktop", t(`${homedir}/.config/Claude/claude_desktop_config.json`));
    push("vscode", t(`${homedir}/.config/Code/User/mcp.json`));
    push("windsurf", t(`${homedir}/.codeium/windsurf/mcp_config.json`));
    push("gemini-cli", t(`${homedir}/.gemini/settings.json`));
  }
  push("claude-code", t(`${homedir}/.claude.json`));
  push("claude-code", t(`${homedir}/.claude/settings.json`));
  push("cursor", t(`${homedir}/.cursor/mcp.json`));
  push("codex-cli", t(`${homedir}/.codex/config.toml`));
  return targets;
}
function normalizeServer(name2, raw, source) {
  if (!raw || typeof raw !== "object") return null;
  const base = {
    name: name2,
    source,
    // app id the entry was imported from
    enabled: raw.disabled !== true && raw.enabled !== false
  };
  const url = typeof raw.url === "string" ? raw.url : typeof raw.httpUrl === "string" ? raw.httpUrl : "";
  const type = raw.type || (url ? "http" : "stdio");
  if (type === "http" || type === "sse" || type === "streamable-http") {
    if (!url) return null;
    return {
      ...base,
      transport: type === "sse" ? "sse" : "streamable-http",
      url,
      headers: sanitizeHeaders(raw.headers ?? raw.header)
    };
  }
  if (!raw.command || typeof raw.command !== "string") return null;
  return {
    ...base,
    transport: "stdio",
    command: raw.command,
    args: Array.isArray(raw.args) ? raw.args.filter((a) => typeof a === "string") : [],
    env: sanitizeEnv(raw.env),
    cwd: typeof raw.cwd === "string" ? raw.cwd : void 0
  };
}
function sanitizeHeaders(headers) {
  if (!headers || typeof headers !== "object") return {};
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    if (typeof k === "string" && typeof v === "string") out[k] = v;
  }
  return out;
}
function sanitizeEnv(env) {
  if (!env || typeof env !== "object") return {};
  const out = {};
  for (const [k, v] of Object.entries(env)) {
    if (typeof k === "string" && typeof v === "string") out[k] = v;
  }
  return out;
}
function extractJsonServers(doc) {
  if (!doc || typeof doc !== "object") return {};
  for (const candidate of [doc.mcpServers, doc.servers, doc.mcp?.servers]) {
    if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) return candidate;
  }
  if (doc.projects && typeof doc.projects === "object" && !Array.isArray(doc.projects)) {
    const merged = {};
    let any = false;
    for (const project of Object.values(doc.projects)) {
      const scoped = project?.mcpServers;
      if (!scoped || typeof scoped !== "object" || Array.isArray(scoped)) continue;
      any = true;
      Object.assign(merged, scoped);
    }
    if (any) return merged;
  }
  return {};
}
function extractCodexTomlServers(text) {
  const servers = {};
  if (typeof text !== "string") return servers;
  let current = null;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    const m = line.match(/^\[mcp_servers\.([A-Za-z0-9_.-]+)\]$/);
    if (m) {
      current = m[1];
      servers[current] = {};
      continue;
    }
    if (line.startsWith("[")) {
      current = null;
      continue;
    }
    if (!current) continue;
    const kv = line.match(/^([A-Za-z0-9_]+)\s*=\s*(.+)$/);
    if (!kv) continue;
    const [, key, valueRaw] = kv;
    const val = valueRaw.trim();
    if (val.startsWith("[")) {
      const items = [...val.matchAll(/"([^"]*)"/g)].map((x) => x[1]);
      servers[current][key] = items;
    } else if (val.startsWith("{")) {
      const pairs = [...val.matchAll(/(?:"([^"]*)"|([A-Za-z0-9_.-]+))\s*=\s*"([^"]*)"/g)];
      const table = {};
      for (const [, quoted, bare, value] of pairs) table[quoted ?? bare] = value;
      servers[current][key] = table;
    } else if (val.startsWith('"')) {
      servers[current][key] = val.slice(1, -1);
    } else if (val === "true" || val === "false") {
      servers[current][key] = val === "true";
    }
  }
  return servers;
}
async function scanHost({ homedir = home(), readFile: readFile3 = fs.readFile } = {}) {
  const report = [];
  const found = [];
  for (const target of scanTargets(homedir)) {
    const item = { app: target.app, file: target.file, serverNames: [] };
    try {
      const text = await readFile3(target.file, "utf8");
      let rawServers = {};
      if (target.file.endsWith(".toml")) {
        rawServers = extractCodexTomlServers(text);
      } else {
        rawServers = extractJsonServers(JSON.parse(text));
      }
      for (const [name2, raw] of Object.entries(rawServers)) {
        const entry = normalizeServer(name2, raw, target.app);
        if (entry) {
          found.push(entry);
          item.serverNames.push(name2);
        }
      }
    } catch (err) {
      item.error = err.code === "ENOENT" ? "not-found" : String(err.message || err);
    }
    if (item.serverNames.length || item.error && item.error !== "not-found") report.push(item);
    else if (item.serverNames.length === 0 && item.error === "not-found") {
    }
  }
  return { found, report };
}
function scannedSources(report) {
  const sources = {};
  const unreadable = [];
  for (const item of report ?? []) {
    if (item.error) {
      if (item.error !== "not-found") unreadable.push(item.file);
      continue;
    }
    const list = sources[item.app] ?? (sources[item.app] = []);
    for (const name2 of item.serverNames ?? []) {
      if (!list.includes(name2)) list.push(name2);
    }
  }
  return { sources, unreadable };
}
function findOrphans(registry, scanned) {
  const sources = scanned?.sources;
  if (!sources) return [];
  return (registry?.servers ?? []).filter((s) => {
    if (!s?.source || s.source === "manual") return false;
    if (s.serverName) return false;
    const names = sources[s.source];
    if (!Array.isArray(names)) return false;
    return !names.includes(s.name);
  });
}
function setMountHolder(servers, name2, holder, serverName) {
  for (const s of servers ?? []) {
    if (s?.name !== name2) continue;
    if (s === holder) s.serverName = serverName;
    else delete s.serverName;
  }
}
function clearMountHolder(servers, name2) {
  for (const s of servers ?? []) {
    if (s?.name === name2) delete s.serverName;
  }
}
function rowKey(row) {
  return [
    row?.name ?? "",
    row?.transport ?? "",
    row?.command ?? "",
    JSON.stringify(row?.args ?? []),
    row?.url ?? ""
  ].join("\0");
}
function sameContract(a, b) {
  return a?.transport === b?.transport && a?.command === b?.command && (a?.url ?? null) === (b?.url ?? null) && JSON.stringify(a?.args ?? []) === JSON.stringify(b?.args ?? []);
}
function collapseDuplicateRows(registry) {
  const groups = /* @__PURE__ */ new Map();
  const order = [];
  for (const row of registry?.servers ?? []) {
    if (!row) continue;
    const key = rowKey(row);
    if (!groups.has(key)) {
      groups.set(key, []);
      order.push(key);
    }
    groups.get(key).push(row);
  }
  const servers = [];
  const collapsed = [];
  for (const key of order) {
    const rows = groups.get(key);
    if (rows.length === 1) {
      servers.push(rows[0]);
      continue;
    }
    const owner = rows.find((r) => r.serverName) ?? rows.find((r) => r.providedExternally === true) ?? rows[0];
    const newest = rows.slice().sort((a, b) => (Date.parse(b.updatedAt ?? "") || 0) - (Date.parse(a.updatedAt ?? "") || 0))[0];
    servers.push({
      ...owner,
      ...newest?.updatedAt ? { updatedAt: newest.updatedAt } : {},
      ...newest?.updateCheck ? { updateCheck: newest.updateCheck } : {},
      ...newest?.about ? { about: newest.about } : {},
      ...rows.some((r) => r.providedExternally === true) ? { providedExternally: true } : {},
      importedAt: rows.map((r) => r.importedAt).filter(Boolean).sort()[0] ?? owner.importedAt
    });
    collapsed.push({ name: owner.name, dropped: rows.length - 1 });
  }
  return { registry: { ...registry ?? {}, servers }, collapsed };
}
function mergeIntoRegistry(registry, found) {
  const before = collapseDuplicateRows(registry);
  const reg = { ...before.registry ?? {}, version: 1, servers: [...before.registry?.servers ?? []] };
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
    const manual = !existing.source || existing.source === "manual";
    if (sameContract(existing, entry) || manual) {
      skipped.push(entry.name);
      continue;
    }
    const merged = {
      ...existing,
      ...entry,
      name: existing.name,
      // A local "停用" outranks the config file; otherwise the config wins.
      enabled: existing.enabled === false ? false : entry.enabled
    };
    reg.servers[reg.servers.indexOf(existing)] = merged;
    byName.set(merged.name, merged);
    updated.push(merged.name);
  }
  const after = collapseDuplicateRows(reg);
  return {
    registry: after.registry,
    added,
    updated,
    skipped,
    collapsed: [...before.collapsed, ...after.collapsed]
  };
}

// lib/updates.js
var NPM_RUNNERS = /* @__PURE__ */ new Set(["npx", "npx.cmd", "npm", "npm.cmd", "pnpm", "pnpm.cmd", "yarn", "yarn.cmd", "bunx"]);
var PY_RUNNERS = /* @__PURE__ */ new Set(["uvx", "uvx.exe", "uv", "pipx"]);
var SHELL_WRAPPERS = /(?:^|[\\/])(?:cmd|cmd\.exe|sh|bash|zsh)$/i;
var NPM_REGISTRY = "https://registry.npmjs.org";
var PYPI_REGISTRY = "https://pypi.org/pypi";
function splitPackageSpec(token) {
  if (typeof token !== "string" || token === "") return null;
  const at = token.startsWith("@") ? token.indexOf("@", 1) : token.indexOf("@");
  if (at > 0) {
    const version = token.slice(at + 1);
    return { pkg: token.slice(0, at), version: version === "" ? null : version };
  }
  return { pkg: token, version: null };
}
function packageSpec(pkg, version) {
  return version ? `${pkg}@${version}` : pkg;
}
function parsePackageInvocation(entry) {
  if (!entry || entry.transport !== "stdio") return null;
  const command = typeof entry.command === "string" ? entry.command : "";
  const original = Array.isArray(entry.args) ? entry.args.map(String) : [];
  let head = command.split(/[\\/]/).pop()?.toLowerCase() ?? "";
  let tokens = original;
  let offset = 0;
  if (SHELL_WRAPPERS.test(head)) {
    const index2 = tokens.findIndex((t) => t === "/c" || t === "-c");
    if (index2 < 0 || !tokens[index2 + 1] || tokens.some((token) => /[&|;<>]/.test(token))) return null;
    head = tokens[index2 + 1].split(/[\\/]/).pop().toLowerCase();
    offset = index2 + 2;
    tokens = tokens.slice(offset);
  }
  const manager = NPM_RUNNERS.has(head) ? "npm" : PY_RUNNERS.has(head) ? "pypi" : null;
  if (!manager) return null;
  const runner = head.replace(/\.(?:cmd|exe)$/, "");
  let index = 0;
  if (runner === "npm") {
    if (!["exec", "x"].includes(tokens[index])) return null;
    index += 1;
  } else if (runner === "pnpm" || runner === "yarn") {
    if (tokens[index] !== "dlx") return null;
    index += 1;
  } else if (runner === "uv") {
    if (tokens[index] !== "tool" || tokens[index + 1] !== "run") return null;
    index += 2;
  } else if (runner === "pipx") {
    if (tokens[index] !== "run") return null;
    index += 1;
  }
  const booleanFlags = /* @__PURE__ */ new Set(["-y", "--yes", "--no", "--no-install", "--quiet", "-q", "--verbose", "--offline", "--no-cache", "--isolated"]);
  const valueFlags = /* @__PURE__ */ new Set(["--registry", "--cache", "--cwd", "--directory", "--python", "--index-url", "--index", "--extra-index-url"]);
  const packageFlags = new Set(manager === "npm" ? ["--package", "-p"] : ["--from", "--spec"]);
  let selected = null;
  let positional = null;
  for (; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === "--") {
      index += 1;
      break;
    }
    if (!token.startsWith("-")) {
      positional ??= { token, at: index, prefix: "" };
      if (runner === "npm") continue;
      break;
    }
    const equals = token.indexOf("=");
    const flag = equals < 0 ? token : token.slice(0, equals);
    if (packageFlags.has(flag)) {
      if (selected) return null;
      const at = equals < 0 ? ++index : index;
      const prefix = equals < 0 ? "" : `${flag}=`;
      selected = { token: equals < 0 ? tokens[at] : token.slice(equals + 1), at, prefix };
    } else if (valueFlags.has(flag)) {
      if (equals < 0 && !tokens[++index]) return null;
    } else if (!booleanFlags.has(token)) return null;
  }
  selected ??= positional ?? { token: tokens[index], at: index, prefix: "" };
  const split = splitPackageSpec(selected.token);
  if (!split || !/^(?:@[A-Za-z0-9_.-]+\/)?[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(split.pkg)) return null;
  return { manager, ...split, argsIndex: offset + selected.at, ...selected.prefix ? { specPrefix: selected.prefix } : {} };
}
function compareVersions(a, b) {
  const parse = (value) => String(value ?? "").split("-")[0].split(".").map((n) => Number.parseInt(n, 10) || 0);
  const pre = (value) => String(value ?? "").includes("-") ? String(value).split("-").slice(1).join("-") : "";
  const [x, y] = [parse(a), parse(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i += 1) {
    const diff = (x[i] ?? 0) - (y[i] ?? 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  const pa = pre(a);
  const pb = pre(b);
  if (pa === pb) return 0;
  if (pa === "") return 1;
  if (pb === "") return -1;
  return pa > pb ? 1 : -1;
}
function pinArgs(entry, version) {
  const args = Array.isArray(entry.args) ? entry.args.map(String) : [];
  const invocation = parsePackageInvocation(entry);
  if (!invocation) return args;
  args[invocation.argsIndex] = `${invocation.specPrefix ?? ""}${packageSpec(invocation.pkg, version)}`;
  return args;
}
async function fetchJson(url, { fetchImpl = fetch, timeoutMs = 1e4 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { signal: controller.signal, headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}
async function latestPackageVersion(manager, pkg, opts = {}) {
  if (manager === "npm") {
    const data2 = await fetchJson(`${NPM_REGISTRY}/${pkg}`, opts);
    const latest2 = data2?.["dist-tags"]?.latest ?? data2?.version;
    if (!latest2) throw new Error("no published version found");
    return String(latest2);
  }
  const data = await fetchJson(`${PYPI_REGISTRY}/${pkg}/json`, opts);
  const latest = data?.info?.version;
  if (!latest) throw new Error("no published version found");
  return String(latest);
}
async function checkEntryUpdate(entry, opts = {}) {
  const invocation = parsePackageInvocation(entry);
  if (!invocation) {
    return { detectable: false, reason: "not launched through a package runner" };
  }
  const { manager, pkg, version } = invocation;
  try {
    const latest = await latestPackageVersion(manager, pkg, opts);
    const unpinned = version === null;
    return {
      detectable: true,
      manager,
      pkg,
      current: version ?? latest,
      latest,
      unpinned,
      // An unpinned runner already resolves to the newest release.
      updateAvailable: !unpinned && compareVersions(latest, version) > 0
    };
  } catch (err) {
    return {
      detectable: true,
      manager,
      pkg,
      current: version,
      latest: null,
      updateAvailable: false,
      error: String(err?.message ?? err)
    };
  }
}
function checkDescribesEntry(entry, stored) {
  if (!stored) return false;
  if (stored.current === void 0) return true;
  const pinned = parsePackageInvocation(entry)?.version ?? null;
  if (pinned === null) return true;
  return String(stored.current) === String(pinned);
}
async function checkAllUpdates(entries, opts = {}) {
  const list = Array.isArray(entries) ? entries : [];
  const limit = Math.max(1, Math.min(8, Math.trunc(Number(opts.concurrency)) || 4));
  const results = new Array(list.length);
  let next = 0;
  async function worker() {
    for (; ; ) {
      const i = next;
      next += 1;
      if (i >= list.length) return;
      const entry = list[i];
      const check = await checkEntryUpdate(entry, opts);
      results[i] = { name: entry.name, source: entry.source, enabled: entry.enabled !== false, ...check };
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, list.length) }, worker));
  const checked = results.filter((r) => r.detectable).length;
  const failed = results.filter((r) => r.error).length;
  return { entries: results, checked, updatable: results.filter((r) => r.updateAvailable).length, failed };
}

// lib/events.js
import fs2 from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

// lib/install-diagnosis.js
var DIAGNOSIS_MAX_CHARS = 600;
var ERROR_MAX_CHARS = 800;
var ARG_LINES_MAX = 8;
var DIAGNOSIS_SYSTEM = `\u4F60\u662F DSH \u7684 MCP \u5B89\u88C5\u6545\u969C\u8BCA\u65AD\u52A9\u624B\u3002\u7528\u6237\u521A\u5728\u5E02\u573A\u91CC\u5B89\u88C5\u4E86\u4E00\u4E2A MCP \u670D\u52A1\u5668\uFF1A\u6761\u76EE\u5DF2\u7ECF\u5199\u8FDB\u6CE8\u518C\u8868\uFF0C\u4F46\u5BBF\u4E3B\u6CA1\u80FD\u628A\u5B83\u6302\u8F7D\u8D77\u6765\u3002\u4F60\u4F1A\u6536\u5230\u8FD9\u6B21\u5B89\u88C5\u7684\u6761\u76EE\u4E8B\u5B9E\u548C\u5BBF\u4E3B\u62A5\u544A\u7684\u539F\u59CB\u9519\u8BEF\u3002

\u53EA\u8F93\u51FA\u8BCA\u65AD\uFF0C\u4E0D\u8981\u590D\u8FF0\u9519\u8BEF\uFF0C\u4E0D\u8981\u9053\u6B49\uFF0C\u4E0D\u8981\u53CD\u95EE\u3002\u6700\u591A\u4E09\u884C\uFF1A
\u7B2C\u4E00\u884C\uFF1A\u6700\u53EF\u80FD\u7684\u539F\u56E0\uFF0C\u5177\u4F53\u5230\u4E8B\u5B9E\uFF08\u547D\u4EE4\u4E0D\u5B58\u5728\u3001\u5305\u540D\u6216\u7248\u672C\u4E0D\u5B58\u5728\u3001\u9700\u8981\u73AF\u5883\u53D8\u91CF\u6216\u51ED\u636E\u3001\u7F51\u7EDC\u6216\u4EE3\u7406\u3001\u914D\u7F6E\u9879\u975E\u6CD5\u3001\u8FDC\u7AEF\u63E1\u624B\u5931\u8D25\u7B49\uFF09\u3002
\u7B2C\u4E8C\u884C\uFF1A\u4E0B\u4E00\u6B65\u8BE5\u505A\u4EC0\u4E48\uFF0C\u4E00\u6761\u53EF\u6267\u884C\u7684\u68C0\u67E5\u6216\u52A8\u4F5C\u3002
\u7B2C\u4E09\u884C\uFF1A\u53EA\u6709\u5728\u539F\u59CB\u9519\u8BEF\u786E\u5B9E\u4E0D\u8DB3\u4EE5\u5224\u65AD\u539F\u56E0\u65F6\u624D\u5199\uFF0C\u8BF4\u660E\u8FD8\u9700\u8981\u770B\u5230\u4EC0\u4E48\u3002

\u7981\u6B62\uFF1A\u7F16\u9020 URL\u3001\u53C2\u6570\u3001\u7248\u672C\u53F7\u6216\u914D\u7F6E\u952E\uFF1B\u58F0\u79F0\u4F60\u5DF2\u7ECF\u8FD0\u884C\u8FC7\u4EFB\u4F55\u547D\u4EE4\u6216\u67E5\u770B\u8FC7\u4EFB\u4F55\u65E5\u5FD7\uFF1B\u5EFA\u8BAE\u5173\u95ED\u6C99\u7BB1\u3001\u4EE5\u7BA1\u7406\u5458\u8EAB\u4EFD\u8FD0\u884C\u6216\u8DF3\u8FC7\u5B89\u5168\u68C0\u67E5\uFF1B\u5EFA\u8BAE\u628A\u53E3\u4EE4\u5199\u8FDB\u6CE8\u518C\u8868\u3001\u547D\u4EE4\u884C\u6216\u73AF\u5883\u53D8\u91CF\u4EE5\u5916\u7684\u5730\u65B9\u3002\u7528\u7B80\u4F53\u4E2D\u6587\u56DE\u7B54\uFF0C\u4E0D\u8981\u7528 Markdown \u6807\u9898\u6216\u4EE3\u7801\u5757\u3002`;
var SENSITIVE_FLAG = /^--?(?:.*[-_])?(?:key|token|secret|password|passwd|pwd|auth|authorization|bearer|credential|signature)(?:[-_].*)?$/i;
var SENSITIVE_QUERY = /^(?:api[-_]?key|key|token|access[-_]?token|auth|authorization|secret|client[-_]?secret|password|passwd|signature|sig|credential|bearer)$/i;
var TOKEN_SHAPED = /\b(?:sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]{8,}|xox[baprs]-[A-Za-z0-9-]{6,}|AKIA[0-9A-Z]{12,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{4,})\b/g;
var SENSITIVE_FIELD = /authorization|token|api[-_]?key|apikey|secret|cookie|password|credential|bearer/i;
function redactJson(value, depth = 0) {
  if (depth > 32) return "<redacted>";
  if (typeof value === "string") return redactSecrets(value);
  if (Array.isArray(value)) return value.map((item) => redactJson(item, depth + 1));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [
      key,
      SENSITIVE_FIELD.test(key) && item != null ? "<redacted>" : redactJson(item, depth + 1)
    ]));
  }
  return value;
}
function redactSecrets(text) {
  let out = String(text ?? "");
  if (/^\s*[\[{]/.test(out)) {
    let parsed;
    try {
      parsed = JSON.parse(out);
    } catch (err) {
      if (!(err instanceof SyntaxError)) throw err;
      if (/["'][^"']*(?:authorization|token|api[-_]?key|apikey|secret|cookie|password|credential|bearer)[^"']*["']\s*:/i.test(out)) {
        return "<redacted: malformed JSON credential preview>";
      }
    }
    if (parsed && typeof parsed === "object") return JSON.stringify(redactJson(parsed));
  }
  out = out.replace(/(https?:\/\/)[^\s/@]+@/gi, "$1<redacted>@");
  out = out.replace(
    /([?&](?:api[-_]?key|key|(?:access[-_]?)?token|auth|authorization|secret|client[-_]?secret|password|passwd|signature|sig|credential|bearer)=)([^&#\s"']*)/gi,
    (match, prefix, value) => /^(?:%3Credacted%3E|<redacted>)$/i.test(value) ? match : `${prefix}<redacted>`
  );
  out = out.replace(
    /(\b(?:(?:proxy-)?authorization|auth)\s*[:=]\s*)([^\r\n]+)/gi,
    (match, prefix, value) => `${prefix}${value.match(/^(?:bearer|basic)\s+/i)?.[0] ?? ""}<redacted>`
  );
  out = out.replace(/(\b(?:set-cookie|cookie)\s*[:=]\s*)[^\r\n]+/gi, "$1<redacted>");
  out = out.replace(
    /(^|[\s(,;])([A-Za-z_][A-Za-z0-9_-]*)(\s*[:=]\s*)("(?:\\.|[^"\\\r\n])*"?|'(?:\\.|[^'\\\r\n])*'?|<redacted>|[^\s,;\]}>"']+)/g,
    (match, lead, key, separator) => {
      if (/^(?:(?:proxy-)?authorization|auth|set-cookie|cookie)$/i.test(key)) return match;
      return SENSITIVE_FLAG.test(`--${key}`) || SENSITIVE_QUERY.test(key) ? `${lead}${key}${separator}<redacted>` : match;
    }
  );
  out = out.replace(/(--?[A-Za-z0-9_-]+)([=:]\s*)(\S+)/g, (match, flag, sep, value) => SENSITIVE_FLAG.test(flag) ? `${flag}${sep}<redacted>` : match);
  out = out.replace(/(^|\s)(--?[A-Za-z0-9_-]+)(\s+)(\S+)/g, (match, lead, flag, space, value) => SENSITIVE_FLAG.test(flag) ? `${lead}${flag}${space}<redacted>` : match);
  out = out.replace(TOKEN_SHAPED, "<redacted>");
  return out;
}
function redactArgs(args) {
  let secretNext = false;
  return (Array.isArray(args) ? args : []).map((value) => {
    const arg = String(value);
    if (secretNext) {
      secretNext = false;
      return "<redacted>";
    }
    const separator = arg.search(/[=:]/);
    if (separator >= 0 && /^--?/.test(arg)) {
      const prefix = arg.slice(0, separator + 1);
      return `${prefix}${SENSITIVE_FLAG.test(arg.slice(0, separator)) ? "<redacted>" : redactSecrets(arg.slice(separator + 1))}`;
    }
    secretNext = SENSITIVE_FLAG.test(arg);
    return redactSecrets(arg);
  });
}
function redactUrl(raw) {
  const text = String(raw ?? "");
  try {
    const url = new URL(text);
    url.username = "";
    url.password = "";
    for (const [name2] of [...url.searchParams]) {
      if (SENSITIVE_QUERY.test(name2)) url.searchParams.set(name2, "<redacted>");
    }
    return redactSecrets(url.toString());
  } catch {
    return redactSecrets(text);
  }
}
function capText(text, max = ERROR_MAX_CHARS) {
  const trimmed = String(text ?? "").trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, Math.max(0, max - 1))}\u2026`;
}
function diagnosisFactsOf({ item = null, entry = null, error = "" } = {}) {
  const args = redactArgs(entry?.args);
  return {
    name: String(entry?.name ?? item?.title ?? ""),
    source: String(item?.source ?? entry?.source ?? ""),
    transport: String(entry?.transport ?? item?.transport ?? "unknown"),
    command: entry?.command === void 0 ? "" : String(entry.command),
    args: args.slice(0, ARG_LINES_MAX),
    argsOmitted: Math.max(0, args.length - ARG_LINES_MAX),
    url: entry?.url === void 0 ? "" : redactUrl(entry.url),
    repository: String(item?.repository ?? ""),
    homepage: String(item?.homepage ?? ""),
    version: String(item?.version ?? ""),
    category: String(item?.category ?? ""),
    error: capText(redactSecrets(error), ERROR_MAX_CHARS)
  };
}
function buildDiagnosisPrompt(facts) {
  const lines = ["\u5B89\u88C5\u6761\u76EE"];
  lines.push(`- \u540D\u79F0\uFF1A${facts.name || "(\u672A\u547D\u540D)"}`);
  if (facts.source) lines.push(`- \u6765\u6E90\uFF1A${facts.source}`);
  lines.push(`- \u4F20\u8F93\uFF1A${facts.transport === "stdio" ? "stdio \u547D\u4EE4" : facts.transport === "streamable-http" ? "streamable-http \u5730\u5740" : "\u672A\u77E5"}`);
  if (facts.command) lines.push(`- \u547D\u4EE4\uFF1A${redactSecrets(facts.command)}`);
  for (const [index, arg] of redactArgs(facts.args).entries()) {
    lines.push(`- \u53C2\u6570 ${index + 1}\uFF1A${redactSecrets(arg)}`);
  }
  if (facts.argsOmitted > 0) lines.push(`- \u53E6\u6709 ${facts.argsOmitted} \u4E2A\u53C2\u6570\u672A\u5217\u51FA`);
  if (facts.url) lines.push(`- \u5730\u5740\uFF1A${facts.url}`);
  if (facts.repository) lines.push(`- \u4ED3\u5E93\uFF1A${facts.repository}`);
  if (facts.homepage) lines.push(`- \u4E3B\u9875\uFF1A${facts.homepage}`);
  if (facts.version) lines.push(`- \u7248\u672C\uFF1A${facts.version}`);
  if (facts.category) lines.push(`- \u5206\u7C7B\uFF1A${facts.category}`);
  lines.push("", "\u5BBF\u4E3B\u62A5\u544A\u7684\u9519\u8BEF", facts.error || "(\u6CA1\u6709\u9519\u8BEF\u6587\u672C)");
  return lines.join("\n");
}
function diagnosisTextOf(blocks) {
  const parts = (Array.isArray(blocks) ? blocks : []).filter((block) => block?.type === "text" && typeof block.text === "string").map((block) => block.text.trim()).filter((text) => text !== "");
  return capText(parts.join("\n\n"), DIAGNOSIS_MAX_CHARS);
}

// lib/events.js
var EVENT_LIMIT_LINES = 400;
var EVENT_LIMIT_BYTES = 256 * 1024;
var MAX_FIELD_CHARS = 600;
var MAX_ARRAY_ITEMS = 20;
var sink = null;
var reportSinkError = (error) => console.error("[overall-mcp] \u64CD\u4F5C\u65E5\u5FD7\u5931\u8D25\uFF1A" + redactSecrets(String(error?.message ?? error)));
function setEventSink(fn, { onError } = {}) {
  sink = typeof fn === "function" ? fn : null;
  reportSinkError = onError ?? ((error) => console.error("[overall-mcp] \u64CD\u4F5C\u65E5\u5FD7\u5931\u8D25\uFF1A" + redactSecrets(String(error?.message ?? error))));
}
function emit(event) {
  if (!sink || !event) return;
  try {
    const result = sink(event);
    if (result?.then) result.catch(reportSinkError);
  } catch (error) {
    reportSinkError(error);
  }
}
var chains = /* @__PURE__ */ new Map();
var persistence = /* @__PURE__ */ new Map();
var pendingEvents = /* @__PURE__ */ new Map();
function eventPersistence(file) {
  return { ...persistence.get(file) ?? { ok: true, error: null, at: null }, pending: pendingEvents.get(file)?.lines.length ?? 0 };
}
async function flushEvents(file) {
  let tail;
  do {
    tail = chains.get(file);
    if (tail) await tail;
  } while (chains.get(file) && chains.get(file) !== tail);
  if (pendingEvents.has(file)) await enqueue(file, () => persistPendingEvents(file));
  const state = eventPersistence(file);
  if (!state.ok) throw new Error(state.error);
}
async function persistPendingEvents(file) {
  const pending = pendingEvents.get(file);
  if (!pending) return null;
  const existing = (await readText(file)).split("\n").filter((line) => line.trim() !== "");
  const { lines, dropped } = retained(existing, pending.lines, pending.limits);
  await writeLines(file, lines);
  pendingEvents.delete(file);
  return { written: pending.lines.length, lines: lines.length, dropped };
}
function enqueue(file, task) {
  const previous = chains.get(file) ?? Promise.resolve();
  const next = previous.then(task, task).then((value) => {
    persistence.set(file, { ok: true, error: null, at: (/* @__PURE__ */ new Date()).toISOString() });
    return value;
  }, (cause) => {
    const error = new Error("\u64CD\u4F5C\u65E5\u5FD7\u5199\u5165\u5931\u8D25\uFF1A" + redactSecrets(String(cause?.message ?? cause)), { cause });
    persistence.set(file, { ok: false, error: error.message, at: (/* @__PURE__ */ new Date()).toISOString() });
    throw error;
  });
  const observed = next.then(() => {
  }, () => {
  });
  chains.set(file, observed);
  void observed.then(() => {
    if (chains.get(file) === observed) chains.delete(file);
  });
  return next;
}
function clip(value, depth = 0) {
  if (typeof value === "string") {
    const safe = redactSecrets(value);
    return safe.length > MAX_FIELD_CHARS ? `${safe.slice(0, MAX_FIELD_CHARS)}\u2026` : safe;
  }
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) {
    if (depth >= 2) return `[${value.length}]`;
    const items = value.slice(0, MAX_ARRAY_ITEMS).map((item) => clip(item, depth + 1));
    return value.length > MAX_ARRAY_ITEMS ? [...items, `\u2026${value.length - MAX_ARRAY_ITEMS} more`] : items;
  }
  if (value && typeof value === "object") {
    if (depth >= 2) return "{\u2026}";
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      const clipped = clip(item, depth + 1);
      if (clipped !== void 0) out[key] = clipped;
    }
    return out;
  }
  return void 0;
}
function normalizeEvent(event, at = /* @__PURE__ */ new Date()) {
  const stamp = at instanceof Date ? at.toISOString() : String(at);
  const clipped = clip(event);
  if (!clipped || typeof clipped !== "object" || Array.isArray(clipped)) {
    return { at: stamp, kind: "log", action: "unserializable" };
  }
  return { at: stamp, ...clipped };
}
async function readText(file) {
  try {
    return await fs2.readFile(file, "utf8");
  } catch (cause) {
    if (cause.code === "ENOENT") return "";
    throw new Error("\u64CD\u4F5C\u65E5\u5FD7\u8BFB\u53D6\u5931\u8D25\uFF1A" + redactSecrets(String(cause?.message ?? cause)), { cause });
  }
}
async function writeLines(file, lines) {
  await fs2.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${randomUUID()}.tmp`;
  try {
    await fs2.writeFile(tmp, lines.length > 0 ? `${lines.join("\n")}
` : "", { encoding: "utf8", flag: "wx", mode: 384 });
    await fs2.rename(tmp, file);
  } finally {
    await fs2.rm(tmp, { force: true });
  }
}
function retained(existing, appended, { maxLines, maxBytes }) {
  const lines = [...existing, ...appended];
  let dropped = 0;
  const byteLength = (list) => Buffer.byteLength(list.join("\n"), "utf8");
  while (lines.length > maxLines || lines.length > 1 && byteLength(lines) > maxBytes) {
    lines.shift();
    dropped += 1;
  }
  if (dropped > 0) {
    lines.unshift(JSON.stringify({
      at: (/* @__PURE__ */ new Date()).toISOString(),
      kind: "log",
      action: "trim",
      dropped,
      note: `\u53EA\u4FDD\u7559\u6700\u8FD1 ${maxLines} \u6761 / ${Math.round(maxBytes / 1024)} KB`
    }));
  }
  return { lines, dropped };
}
function appendEvents(file, events, { maxLines = EVENT_LIMIT_LINES, maxBytes = EVENT_LIMIT_BYTES } = {}) {
  const list = (Array.isArray(events) ? events : [events]).filter(Boolean);
  if (list.length === 0) return Promise.resolve(null);
  return enqueue(file, async () => {
    const appended = list.map((event) => {
      try {
        return JSON.stringify(normalizeEvent(event));
      } catch {
        return JSON.stringify({ at: (/* @__PURE__ */ new Date()).toISOString(), kind: "log", action: "unserializable" });
      }
    });
    const buffered = retained(pendingEvents.get(file)?.lines ?? [], appended, { maxLines, maxBytes });
    pendingEvents.set(file, { lines: buffered.lines, limits: { maxLines, maxBytes } });
    return persistPendingEvents(file);
  });
}
async function readEvents(file, { limit = 100 } = {}) {
  const raw = await readText(file);
  const events = [];
  let damaged = 0;
  let total = 0;
  for (const line of raw.split("\n")) {
    const text = line.trim();
    if (text === "") continue;
    total += 1;
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) events.push(normalizeEvent(parsed, parsed.at ?? /* @__PURE__ */ new Date()));
      else damaged += 1;
    } catch {
      damaged += 1;
    }
  }
  const capped = Number.isFinite(limit) && limit > 0 ? events.slice(-limit) : events;
  return { events: capped, damaged, total };
}
async function eventFileFacts(file) {
  try {
    const stat = await fs2.stat(file);
    const { events, damaged, total } = await readEvents(file, { limit: 1 });
    return {
      bytes: stat.size,
      at: stat.mtime.toISOString(),
      lines: total,
      damaged,
      lastAt: typeof events.at(-1)?.at === "string" ? events.at(-1).at : null,
      persistence: eventPersistence(file)
    };
  } catch (err) {
    if (err?.code === "ENOENT") return { bytes: 0, at: null, lines: 0, damaged: 0, lastAt: null };
    return { error: redactSecrets(String(err?.message ?? err)), persistence: eventPersistence(file) };
  }
}

// lib/github-auth.js
import { execFile } from "node:child_process";
import fs3 from "node:fs/promises";
import path2 from "node:path";
var AUTH_FILE = "github-auth.json";
var GH_CACHE_FILE = "gh-login.json";
var GH_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1e3;
var untrustedGhCaches = /* @__PURE__ */ new Set();
var GITHUB_AUTH_HOSTS = Object.freeze(["api.github.com", "raw.githubusercontent.com"]);
var API = "https://api.github.com";
var USER_AGENT = "dsh-overall-mcp (DeepSeek Harness plugin)";
var active = { source: "anonymous", token: null, login: null };
function setActiveGithubAuth(next) {
  active = next ? { source: String(next.source ?? "anonymous"), token: next.token ?? null, login: next.login ?? null } : { source: "anonymous", token: null, login: null };
}
function deactivateGithubAuth(reason, { dir = null } = {}) {
  authEpoch += 1;
  resetGhCache();
  resolvedState.until = 0;
  setActiveGithubAuth(null);
  pendingResolution = null;
  if (dir) untrustedGhCaches.add(dir);
  if (resolvedState.value) {
    resolvedState.value = {
      status: { ...resolvedState.value.status, inUse: false, error: String(reason ?? "token \u88AB\u4E0A\u6E38\u62D2\u7EDD"), needsLogin: true },
      active: null
    };
  }
  const promise = resolutionQueue.then(async () => {
    if (dir) await clearGhCache(dir);
    return String(reason ?? "");
  });
  resolutionQueue = promise.then(() => {
  }, () => {
  });
  return promise;
}
function githubAuthStatus() {
  return resolvedState.value?.status ?? UNRESOLVED;
}
function withGithubAuth(url, headers = {}) {
  if (!active.token) return headers;
  let host;
  try {
    host = new URL(String(url)).hostname.toLowerCase();
  } catch {
    return headers;
  }
  if (!GITHUB_AUTH_HOSTS.includes(host)) return headers;
  return { ...headers, authorization: `Bearer ${active.token}` };
}
function maskToken(token) {
  const value = String(token ?? "");
  if (!value) return null;
  if (value.length <= 12) return `${value.slice(0, 2)}\u2026${value.slice(-2)}`;
  return `${value.slice(0, 6)}\u2026${value.slice(-4)}`;
}
function readTokenFromEnv(env = process.env) {
  for (const name2 of ["DSH_GITHUB_TOKEN", "GITHUB_TOKEN"]) {
    const value = String(env?.[name2] ?? "").trim();
    if (value) return { token: value, source: "env", via: name2 };
  }
  return null;
}
var ghCache = { at: 0, token: null, ttl: 0 };
function resetGhCache() {
  ghCache.at = 0;
  ghCache.token = null;
  ghCache.ttl = 0;
}
function runGhOnce(binary, { timeoutMs = 4e3 } = {}) {
  return new Promise((resolve) => {
    try {
      execFile(binary, ["auth", "token"], { timeout: timeoutMs, windowsHide: true }, (err, stdout) => {
        if (err) return resolve(null);
        const value = String(stdout ?? "").trim();
        return resolve(value || null);
      });
    } catch {
      resolve(null);
    }
  });
}
async function readTokenFromGhCli({ run = runGhOnce, platform = process.platform, now = Date.now, force = false } = {}) {
  if (!force && ghCache.at && now() - ghCache.at < ghCache.ttl) {
    return ghCache.token ? { token: ghCache.token, source: "gh" } : null;
  }
  const found = await run("gh") ?? (platform === "win32" ? await run("gh.cmd") : null);
  ghCache.at = now();
  ghCache.token = found;
  ghCache.ttl = found ? 10 * 60 * 1e3 : 5 * 60 * 1e3;
  return found ? { token: found, source: "gh" } : null;
}
async function readStoredToken(dir, { readFile: readFile3 = (file, enc) => fs3.readFile(file, enc) } = {}) {
  try {
    const raw = await readFile3(path2.join(dir, AUTH_FILE), "utf8");
    const doc = JSON.parse(String(raw));
    const token = typeof doc?.token === "string" ? doc.token.trim() : "";
    if (!token) return null;
    return { token, source: "panel", at: typeof doc.at === "string" ? doc.at : null };
  } catch {
    return null;
  }
}
async function storeToken(dir, token, { now = Date.now } = {}) {
  const value = String(token ?? "").trim();
  if (!value) throw new Error("empty token");
  const file = path2.join(dir, AUTH_FILE);
  const tmp = `${file}.tmp`;
  const at = new Date(now()).toISOString();
  await fs3.mkdir(dir, { recursive: true });
  await fs3.writeFile(tmp, JSON.stringify({ token: value, at }, null, "	"), { mode: 384 });
  await fs3.rename(tmp, file);
  return { at, masked: maskToken(value) };
}
async function clearToken(dir, { unlink = (file) => fs3.unlink(file) } = {}) {
  try {
    await unlink(path2.join(dir, AUTH_FILE));
    return true;
  } catch {
    return false;
  }
}
async function probeToken(token, { fetchImpl = fetch, timeoutMs = 1e4 } = {}) {
  const headers = {
    "user-agent": USER_AGENT,
    accept: "application/vnd.github+json",
    authorization: `Bearer ${token}`
  };
  const ask = async (url) => {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      return await fetchImpl(url, { headers, signal: ctl.signal });
    } catch (err) {
      const failure = new Error(`\u8FDE\u4E0D\u4E0A GitHub\uFF1A${String(err?.message ?? err)}`);
      failure.code = "network";
      throw failure;
    } finally {
      clearTimeout(timer);
    }
  };
  const res = await ask(`${API}/user`);
  if (res.status === 401) {
    const err = new Error("GitHub \u8BF4\u8FD9\u4E2A token \u65E0\u6548\u6216\u5DF2\u8FC7\u671F\uFF08HTTP 401\uFF09");
    err.code = "unauthorized";
    throw err;
  }
  if (res.status === 403) {
    const err = new Error("GitHub \u62D2\u7EDD\u4E86\u8FD9\u4E2A token\uFF08HTTP 403\uFF09\u2014\u2014\u5B83\u53EF\u80FD\u7F3A\u5C11\u8BFB\u53D6\u516C\u5F00\u4FE1\u606F\u7684\u6743\u9650");
    err.code = "forbidden";
    throw err;
  }
  if (!res.ok) {
    const err = new Error(`GitHub \u6821\u9A8C token \u65F6\u8FD4\u56DE HTTP ${res.status}`);
    err.code = "network";
    throw err;
  }
  const scopes = String(res.headers?.get?.("x-oauth-scopes") ?? "").split(",").map((scope) => scope.trim()).filter(Boolean);
  let login = null;
  let organization = null;
  try {
    const body = await res.json();
    login = typeof body?.login === "string" ? body.login : null;
    organization = typeof body?.company === "string" && body.company ? body.company : null;
  } catch {
  }
  let rateLimit = null;
  try {
    const quotaRes = await ask(`${API}/rate_limit`);
    if (quotaRes.ok) {
      const body = await quotaRes.json();
      const core = body?.resources?.core;
      if (core && Number.isFinite(Number(core.limit))) {
        rateLimit = {
          limit: Number(core.limit),
          remaining: Number(core.remaining ?? 0),
          resetAt: Number.isFinite(Number(core.reset)) ? new Date(Number(core.reset) * 1e3).toISOString() : null
        };
      }
    }
  } catch {
  }
  return { login, scopes, rateLimit, organization };
}
async function readGhCache(dir, { now = Date.now, ttlMs = GH_CACHE_TTL_MS, readFile: readFile3 = (file, enc) => fs3.readFile(file, enc) } = {}) {
  try {
    const raw = await readFile3(path2.join(dir, GH_CACHE_FILE), "utf8");
    const doc = JSON.parse(String(raw));
    const token = typeof doc?.token === "string" ? doc.token.trim() : "";
    if (!token) return null;
    const at = typeof doc.at === "string" ? Date.parse(doc.at) : Number(doc.at);
    if (!Number.isFinite(at) || now() - at > ttlMs) return null;
    const status = doc?.status && typeof doc.status === "object" ? doc.status : {};
    return { token, at: new Date(at).toISOString(), status };
  } catch {
    return null;
  }
}
async function storeGhCache(dir, { token, status, at = Date.now() } = {}) {
  const value = String(token ?? "").trim();
  if (!value) return null;
  const file = path2.join(dir, GH_CACHE_FILE);
  const tmp = `${file}.${process.pid}.tmp`;
  const iso = new Date(at).toISOString();
  const safe = status && typeof status === "object" ? {
    login: status.login ?? null,
    masked: status.masked ?? maskToken(value),
    scopes: Array.isArray(status.scopes) ? status.scopes : [],
    rateLimit: status.rateLimit ?? null,
    checkedAt: status.checkedAt ?? iso
  } : { login: null, masked: maskToken(value), scopes: [], rateLimit: null, checkedAt: iso };
  await fs3.mkdir(dir, { recursive: true });
  await fs3.writeFile(tmp, JSON.stringify({ token: value, at: iso, status: safe }, null, "	"), { mode: 384 });
  await fs3.rename(tmp, file);
  untrustedGhCaches.delete(dir);
  return { at: iso };
}
async function clearGhCache(dir, { unlink = (file) => fs3.unlink(file) } = {}) {
  try {
    await unlink(path2.join(dir, GH_CACHE_FILE));
    untrustedGhCaches.delete(dir);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") {
      untrustedGhCaches.delete(dir);
      return false;
    }
    untrustedGhCaches.add(dir);
    throw error;
  }
}
var resolvedState = { at: 0, value: null, until: 0, key: null };
var authEpoch = 0;
var resolutionQueue = Promise.resolve();
var pendingResolution = null;
function resolveGithubAuth(options = {}) {
  const env = options.env ?? process.env;
  const key = JSON.stringify([options.dir, options.useGh ?? "auto", env.DSH_GITHUB_TOKEN ?? "", env.GITHUB_TOKEN ?? ""]);
  if (!options.force && pendingResolution?.key === key) return pendingResolution.promise;
  const promise = resolutionQueue.then(() => resolveGithubAuthImpl({ ...options, key }));
  resolutionQueue = promise.then(() => {
  }, () => {
  });
  pendingResolution = { key, promise };
  const clear = () => {
    if (pendingResolution?.promise === promise) pendingResolution = null;
  };
  void promise.then(clear, clear);
  return promise;
}
var UNRESOLVED = Object.freeze({
  source: "anonymous",
  masked: null,
  login: null,
  scopes: [],
  rateLimit: null,
  checkedAt: null,
  storedAt: null,
  error: null,
  needsLogin: false,
  inUse: false,
  note: "GitHub \u51ED\u636E\u5C1A\u672A\u68C0\u6D4B\u3002"
});
async function resolveGithubAuthImpl({
  dir,
  env = process.env,
  run,
  platform,
  fetchImpl = fetch,
  now = Date.now,
  ttlMs = 10 * 60 * 1e3,
  force = false,
  useGh = "auto",
  key
} = {}) {
  const epoch = authEpoch;
  if (!force && resolvedState.key === key && resolvedState.at && now() < resolvedState.until && resolvedState.value && !(resolvedState.value.status.cached && untrustedGhCaches.has(dir))) {
    setActiveGithubAuth(resolvedState.value.active);
    return resolvedState.value.status;
  }
  const stored = await readStoredToken(dir);
  let found = stored ?? readTokenFromEnv(env);
  let cliChecked = false;
  let cleanupError = null;
  if (!found) {
    const cached = !force && useGh !== true && !untrustedGhCaches.has(dir) ? await readGhCache(dir, { now }) : null;
    if (cached) found = { source: "gh", token: cached.token, cached, via: "cache" };
    else if (useGh !== false) {
      cliChecked = true;
      found = await readTokenFromGhCli({ ...run ? { run } : {}, ...platform ? { platform } : {}, now, force });
      if (found && useGh === "auto") found.via = "auto";
      if (!found) {
        if (epoch === authEpoch) setActiveGithubAuth(null);
        untrustedGhCaches.add(dir);
        try {
          await clearGhCache(dir);
        } catch (error) {
          cleanupError = `\u672A\u68C0\u6D4B\u5230\u672C\u673A\u767B\u5F55\uFF0C\u6E05\u7406\u65E7\u767B\u5F55\u7F13\u5B58\u5931\u8D25\uFF1A${String(error.code ?? error.message ?? error)}`;
        }
      }
    }
  }
  const remember = (status2, credential, lifetime = ttlMs) => {
    if (epoch !== authEpoch) return githubAuthStatus();
    setActiveGithubAuth(credential);
    resolvedState.at = now();
    resolvedState.until = now() + lifetime;
    resolvedState.value = { status: status2, active: credential };
    resolvedState.key = key;
    return status2;
  };
  const base = {
    source: found?.source ?? "anonymous",
    masked: found ? maskToken(found.token) : null,
    login: null,
    scopes: [],
    rateLimit: null,
    checkedAt: new Date(now()).toISOString(),
    storedAt: stored?.at ?? null,
    error: cleanupError,
    needsLogin: false,
    inUse: Boolean(found),
    ...found?.via ? { via: found.via } : {}
  };
  if (found?.cached) {
    const cached = found.cached;
    const status2 = {
      ...base,
      ...cached.status,
      source: "gh",
      inUse: true,
      cached: true,
      checkedAt: cached.status?.checkedAt ?? cached.at,
      note: `\u672C\u673A\u767B\u5F55\u5DF2\u5728 ${String(cached.at).slice(0, 16).replace("T", " ")} \u68C0\u6D4B\u8FC7\uFF0C\u8FD9\u6B21\u542F\u52A8\u6CA1\u6709\u518D\u68C0\u6D4B\u3002`
    };
    const nextActive2 = { source: "gh", token: found.token, login: status2.login ?? null };
    return remember(status2, nextActive2, Math.min(ttlMs, Math.max(0, Date.parse(cached.at) + GH_CACHE_TTL_MS - now())));
  }
  if (!found) {
    const status2 = { ...base, inUse: false, note: cliChecked ? "\u81EA\u52A8\u68C0\u6D4B\u672A\u53D1\u73B0\u53EF\u7528\u7684\u672C\u673A GitHub \u767B\u5F55\uFF0C\u6682\u7528\u533F\u540D\u8BBF\u95EE\uFF1B\u4E94\u5206\u949F\u540E\u518D\u6B21\u8BBF\u95EE\u65F6\u4F1A\u81EA\u52A8\u91CD\u8BD5\u3002" : "\u533F\u540D\u8BBF\u95EE\uFF1AGitHub \u6BCF\u5C0F\u65F6\u53EA\u7ED9 60 \u6B21\u8BF7\u6C42\u3002" };
    return remember(status2, null, Math.min(ttlMs, cleanupError ? 6e4 : 5 * 6e4));
  }
  let status = base;
  let usable = found;
  try {
    const probe = await probeToken(found.token, { fetchImpl });
    status = { ...base, ...probe, inUse: true };
  } catch (err) {
    status = { ...base, error: String(err?.message ?? err), needsLogin: true, inUse: false };
    usable = null;
  }
  const nextActive = usable ? { source: usable.source, token: usable.token, login: status.login } : null;
  if (found?.source === "gh") {
    if (usable) {
      try {
        await storeGhCache(dir, { token: usable.token, status, at: now() });
      } catch (error) {
        status = { ...status, error: `\u767B\u5F55\u53EF\u7528\uFF0C\u4F46\u4FDD\u5B58\u672C\u673A\u767B\u5F55\u7F13\u5B58\u5931\u8D25\uFF1A${String(error.code ?? error.message ?? error)}` };
      }
    } else {
      resetGhCache();
      untrustedGhCaches.add(dir);
      try {
        await clearGhCache(dir);
      } catch (error) {
        status = { ...status, error: `${status.error}\uFF1B\u6E05\u7406\u5DF2\u5931\u6548\u7684\u767B\u5F55\u7F13\u5B58\u5931\u8D25\uFF1A${String(error.code ?? error.message ?? error)}` };
      }
    }
    if (epoch !== authEpoch) {
      await clearGhCache(dir);
      return githubAuthStatus();
    }
  }
  if (usable && found?.via === "auto") status.note = "\u5DF2\u81EA\u52A8\u68C0\u6D4B\u5E76\u9A8C\u8BC1\u672C\u673A GitHub \u767B\u5F55\uFF0C\u65E0\u9700\u624B\u52A8\u70B9\u51FB\u3002";
  return remember(status, nextActive, status.error ? Math.min(ttlMs, 6e4) : ttlMs);
}

// lib/server-config.js
var MAX_CONFIG_FIELDS = 24;
var MAX_VALUE_CHARS = 4096;
var MAX_ECHO_CHARS = 200;
var ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
var HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;
var CONFIG_KEY = /^[A-Za-z0-9_][A-Za-z0-9_.:-]{0,63}$/;
var UNSAFE_KEYS = /* @__PURE__ */ new Set(["__proto__", "constructor", "prototype"]);
var RESERVED_HEADERS = /* @__PURE__ */ new Set([
  "host",
  "content-length",
  "transfer-encoding",
  "connection",
  "upgrade",
  "te",
  "trailer"
]);
var CODE_LOADING_ENV_VARS = /* @__PURE__ */ new Set([
  "NODE_OPTIONS",
  "NODE_PATH",
  "PATH",
  "COMSPEC",
  "PATHEXT",
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "DYLD_INSERT_LIBRARIES",
  "DYLD_LIBRARY_PATH",
  "BASH_ENV",
  "ENV",
  "SHELLOPTS",
  "PS4",
  "PROMPT_COMMAND",
  "PYTHONSTARTUP",
  "PYTHONPATH",
  "RUBYOPT",
  "PERL5OPT",
  "PERL5LIB",
  "JAVA_TOOL_OPTIONS",
  "_JAVA_OPTIONS",
  "JDK_JAVA_OPTIONS"
]);
var CREDENTIAL_SUFFIX = /(?:^|_)(?:API_?KEY|KEY|TOKEN|SECRET|PASSWORD|PASSWD|PWD|PAT|CREDENTIALS?|AUTH|DSN|CONNECTION_STRING)$|API[_-]?KEY|ACCESS[_-]?TOKEN/i;
var TARGET_SUFFIX = /_(?:URL|URI|ENDPOINT|HOST|BASE_URL|SERVER)$/;
var AUTH_FAILURE = new RegExp([
  "\\b(?:401|403)\\b",
  "unauthori[sz]ed",
  "\\bforbidden\\b",
  "invalid[ _-]?(?:api[ _-]?)?(?:key|token|credential)",
  "\\bapi[ _-]?key\\b",
  "\\baccess[ _-]?token\\b",
  "(?:missing|required|no|without)\\s+(?:an?\\s+)?(?:env|environment variable|credential|token|api key|secret)",
  "authenticat\\w*",
  "\\bcredential\\w*",
  "\\bnot (?:logged|signed) in\\b",
  "\u8BF7\u5148(?:\u767B\u5F55|\u914D\u7F6E|\u8BBE\u7F6E)",
  "\u672A\u914D\u7F6E",
  "\u7F3A\u5C11(?:\u5BC6\u94A5|\u4EE4\u724C|\u51ED\u636E|\u914D\u7F6E)"
].join("|"), "i");
var QUOTA_HINT = /\b(?:rate limit|quota|too many requests|\b429\b)/i;
function firstUrl(text) {
  const match = String(text ?? "").match(/https?:\/\/[^\s)\]"'<>]+/i);
  return match ? capText2(match[0].replace(/[.,;]+$/, ""), 300) : "";
}
function linkable(url) {
  return typeof url === "string" && /^https?:\/\//i.test(url) ? capText2(url.trim(), 300) : "";
}
function normalizeField(input, { kind = "env", origin = "manual" } = {}) {
  const key = typeof input?.key === "string" ? input.key.trim() : "";
  if (key === "" || UNSAFE_KEYS.has(key)) return null;
  const requested = input?.kind ?? kind;
  const fieldKind = requested === "header" ? "header" : requested === "config" ? "config" : "env";
  const legal = fieldKind === "env" ? ENV_NAME.test(key) : fieldKind === "header" ? HEADER_NAME.test(key) : CONFIG_KEY.test(key);
  if (!legal) return null;
  if (fieldKind === "header" && RESERVED_HEADERS.has(key.toLowerCase())) return null;
  const help = typeof input?.help === "string" ? input.help.trim() : "";
  const declared = input?.declared === true;
  const suggested = input?.default;
  const defaultValue = typeof suggested === "string" ? suggested : typeof suggested === "number" || typeof suggested === "boolean" ? String(suggested) : "";
  const choices = Array.isArray(input?.choices) ? input.choices.filter((choice) => typeof choice === "string" || typeof choice === "number").map(String) : [];
  return {
    key,
    kind: fieldKind,
    // The label is the key unless the catalogue published a human sentence; the
    // description goes in `help` either way, because a form field whose only
    // label is `GH_TOKEN` still needs to say what a GH_TOKEN is.
    label: typeof input?.label === "string" && input.label.trim() !== "" ? input.label.trim() : key,
    ...help === "" ? {} : { help: capText2(help, 400) },
    required: input?.required === true,
    secret: input?.secret === true || CREDENTIAL_SUFFIX.test(key),
    origin: typeof input?.origin === "string" && input.origin !== "" ? input.origin : origin,
    // 「必填」may only come from a published declaration. `declared` records that
    // this field did, so the panel can tell 「发布方要求的」 from 「从命令行猜的」 —
    // an undeclared key is never marked required, and the form says so instead of
    // pretending a guess is a requirement.
    ...declared ? { declared: true } : {},
    ...defaultValue === "" ? {} : { default: capText2(defaultValue, 200) },
    ...choices.length === 0 ? {} : { choices: choices.slice(0, 40) },
    // Where to go get it: an explicit link wins, otherwise the first URL the
    // description itself mentions (that is where publishers put it).
    ...(() => {
      const helpUrl = linkable(input?.helpUrl) || firstUrl(help);
      return helpUrl === "" ? {} : { helpUrl };
    })(),
    // Where the requirement came from — the endpoint's own authorization
    // metadata, when the 401 named one.
    ...linkable(input?.resourceUrl) === "" ? {} : { resourceUrl: linkable(input?.resourceUrl) },
    // A measured OAuth requirement: the endpoint named an authorization server,
    // so the form must not present its metadata document as a place to get a key.
    ...input?.oauth === true ? { oauth: true } : {}
  };
}
function capText2(text, max) {
  const trimmed = String(text ?? "").trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, Math.max(0, max - 1))}\u2026`;
}
function redactEchoValue(raw) {
  const str = String(raw ?? "");
  if (str === "") return "";
  const noUserInfo = str.replace(/(https?:\/\/)([^:\s/@]+):([^@\s/]+)@/g, "$1$2:\u2022\u2022\u2022\u2022@");
  const noQuerySecret = noUserInfo.replace(/([?&](?:api[ _-]?key|(?:access[ _-]?)?token|secret|password|passwd|auth|credential)=)[^&#\s]*/gi, "$1\u2022\u2022\u2022\u2022");
  return capText2(noQuerySecret, MAX_ECHO_CHARS);
}
function dedupe(fields) {
  const byId = /* @__PURE__ */ new Map();
  for (const field of fields) {
    const id = field.kind + ":" + (field.kind === "header" ? field.key.toLowerCase() : field.key);
    const existing = byId.get(id);
    if (existing) {
      existing.required ||= field.required === true;
      existing.secret ||= field.secret === true;
      continue;
    }
    if (byId.size < MAX_CONFIG_FIELDS) byId.set(id, { ...field });
  }
  return [...byId.values()];
}
function officialFields(item) {
  const raw = item?.raw;
  if (!raw || typeof raw !== "object") return null;
  const fields = [];
  for (const pkg of Array.isArray(raw.packages) ? raw.packages : []) {
    const vars = Array.isArray(pkg?.environmentVariables) ? pkg.environmentVariables : Array.isArray(pkg?.environment_variables) ? pkg.environment_variables : [];
    for (const variable of vars) {
      const field = normalizeField({
        key: variable?.name,
        label: variable?.name,
        help: variable?.description,
        required: (variable?.isRequired ?? variable?.is_required) === true,
        secret: variable?.isSecret ?? variable?.is_secret,
        default: variable?.default,
        choices: variable?.choices,
        declared: true,
        origin: "official"
      }, { kind: "env", origin: "official" });
      if (field) fields.push(field);
    }
  }
  for (const remote of Array.isArray(raw.remotes) ? raw.remotes : []) {
    for (const header of Array.isArray(remote?.headers) ? remote.headers : []) {
      const field = normalizeField({
        key: typeof header === "string" ? header : header?.name,
        label: typeof header === "string" ? header : header?.name,
        help: typeof header === "string" ? "" : header?.description,
        required: typeof header === "object" && (header?.isRequired ?? header?.is_required) === true,
        secret: typeof header === "object" && (header?.isSecret ?? header?.is_secret) !== false,
        declared: true,
        origin: "official"
      }, { kind: "header", origin: "official" });
      if (field) fields.push(field);
    }
  }
  return fields.length ? { fields: dedupe(fields), origin: "official" } : null;
}
function argFields(entry) {
  const args = (Array.isArray(entry?.args) ? entry.args : []).map((a) => String(a));
  const command = typeof entry?.command === "string" ? entry.command : "";
  const url = typeof entry?.url === "string" ? entry.url : "";
  const found = [];
  const add = (key, { secret } = {}) => {
    const isSecret = secret ?? secretLooking(key);
    const isRequired = false;
    const field = normalizeField({ key, label: key, origin: "args", secret: isSecret, required: isRequired }, { kind: "env", origin: "args" });
    if (field) found.push(field);
  };
  const secretLooking = (name2) => CREDENTIAL_SUFFIX.test(name2);
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    let envToken = null;
    const longMatch = arg.match(/^(?:--environment|--env)(?:=(.*)|$)/);
    if (longMatch) {
      envToken = longMatch[1] !== void 0 ? longMatch[1] : args[i + 1] ?? "";
    } else {
      const shortMatch = arg.match(/^-e(?:=(.*)|(?=[A-Z_])(.*)|$)/);
      if (shortMatch) {
        envToken = shortMatch[1] ?? shortMatch[2] ?? (args[i + 1] ?? "");
      }
    }
    if (envToken !== null) {
      const name2 = envToken.split("=")[0].trim();
      if (name2 !== "" && ENV_NAME.test(name2)) {
        add(name2, { secret: secretLooking(name2) });
      }
    }
    for (const token of arg.match(/\b[A-Z][A-Z0-9_]{3,}\b/g) ?? []) {
      if (CREDENTIAL_SUFFIX.test(token) || TARGET_SUFFIX.test(token)) {
        add(token, { secret: CREDENTIAL_SUFFIX.test(token) });
      }
    }
    for (const match of arg.matchAll(/\$\{([A-Z][A-Z0-9_]*)\}|\$([A-Z][A-Z0-9_]*)|(?<![A-Za-z0-9_$])\{([A-Z][A-Z0-9_]*)\}/g)) {
      const name2 = match[1] ?? match[2] ?? match[3];
      if (name2) add(name2, { secret: secretLooking(name2) });
    }
  }
  for (const text of [command, url]) {
    for (const match of String(text).matchAll(/\$\{([A-Z][A-Z0-9_]*)\}|\$([A-Z][A-Z0-9_]*)|(?<![A-Za-z0-9_$])\{([A-Z][A-Z0-9_]*)\}/g)) {
      const name2 = match[1] ?? match[2] ?? match[3];
      if (name2) add(name2, { secret: secretLooking(name2) });
    }
  }
  return found.length ? { fields: dedupe(found), origin: "args" } : null;
}
function remoteFields(entry) {
  if (entry?.transport !== "streamable-http" && entry?.transport !== "sse") return null;
  if (entry?.authDemand?.required !== true) return null;
  const field = normalizeField({
    key: "Authorization",
    kind: "header",
    label: "Authorization",
    help: "\u7AEF\u70B9\u56DE\u4E86 401\uFF1A\u6309\u5B83\u7684\u6587\u6863\u8981\u6C42\u7684\u683C\u5F0F\u586B\uFF08\u591A\u6570\u662F `Bearer <\u4EE4\u724C>`\uFF09\u3002",
    required: true,
    secret: true,
    origin: "observed"
  }, { kind: "header", origin: "observed" });
  return field ? { fields: [field], origin: "observed" } : null;
}
function configSpecFor(item, entry) {
  if (isSmitheryCli(entry)) {
    const declared = smitheryFieldsOf(entry);
    return { fields: declared, origin: "smithery", via: "cli-json", flag: "--config" };
  }
  const sources = [officialFields(item), argFields(entry), remoteFields(entry)].filter(Boolean);
  if (sources.length === 0) return null;
  const rank = { official: 3, args: 2, manual: 1 };
  const fields = dedupe(sources.flatMap((source) => source.fields));
  const origin = sources.map((source) => source.origin).sort((a, b) => (rank[b] ?? 0) - (rank[a] ?? 0))[0];
  return { fields, origin };
}
function isSmitheryCli(entry) {
  const args = Array.isArray(entry?.args) ? entry.args.map((arg) => String(arg)) : [];
  return args.some((arg) => arg.includes("@smithery/cli")) && args.includes("run");
}
function smitheryFieldsOf(entry) {
  const schema = entry?.config?.schema;
  if (!schema || typeof schema !== "object") return [];
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  const properties = schema.properties && typeof schema.properties === "object" ? schema.properties : {};
  return dedupe(Object.entries(properties).map(([key, property]) => normalizeField({
    key,
    kind: "config",
    label: typeof property?.title === "string" ? property.title : "",
    help: typeof property?.description === "string" ? property.description : "",
    required: required.has(key),
    // `format: password` is the schema saying so outright; a credential-shaped
    // key is the fallback (a published schema is not required to say it twice).
    secret: property?.format === "password" ? true : void 0,
    // A Smithery `configSchema` is a declaration like any other: it is the
    // server's own publisher saying which keys exist and which are required.
    // Without this flag the sheet would label `braveApiKey` 「来源未声明」 —
    // the one thing it is not.
    declared: true,
    default: property?.default,
    choices: property?.enum,
    origin: "smithery"
  }, { kind: "config" })).filter(Boolean));
}
function specOf(entry) {
  const stored = entry?.config;
  if (stored && Array.isArray(stored.fields)) {
    const fields = dedupe(stored.fields.map((field) => normalizeField(field, { kind: field?.kind ?? "env" })).filter(Boolean));
    if (fields.length > 0) {
      const channel = stored.via === "cli-json" ? { via: "cli-json", flag: typeof stored.flag === "string" ? stored.flag : "--config" } : {};
      return { fields, origin: typeof stored.origin === "string" ? stored.origin : "manual", ...channel };
    }
  }
  return configSpecFor(null, entry);
}
function channelOf(entry) {
  const spec = specOf(entry);
  if (spec?.via === "cli-json" || isSmitheryCli(entry)) return "cli-json";
  if ((spec?.fields ?? []).some((field) => field.kind === "header")) return "header";
  return "env";
}
function composeMountArgs(entry) {
  const spec = specOf(entry);
  if (spec?.via !== "cli-json") return [];
  const flag = spec.flag ?? "--config";
  const args = Array.isArray(entry?.args) ? entry.args.map((arg) => String(arg)) : [];
  if (args.includes(flag)) return [];
  const values = entry?.configValues;
  if (!values || typeof values !== "object") return [];
  const picked = {};
  for (const [key, value] of Object.entries(values)) {
    if (typeof value !== "string" || value === "" || !CONFIG_KEY.test(key) || UNSAFE_KEYS.has(key)) continue;
    picked[key] = value;
  }
  if (Object.keys(picked).length === 0) return [];
  return [flag, JSON.stringify(picked)];
}
function styleEnv(entry) {
  const bag = entry?.env;
  if (!bag || typeof bag !== "object") return {};
  const picked = {};
  for (const [key, value] of Object.entries(bag)) {
    if (typeof value !== "string" || value === "" || !ENV_NAME.test(key) || UNSAFE_KEYS.has(key)) continue;
    picked[key] = value;
  }
  return picked;
}
function imageIndex(args) {
  if (args[0] !== "run") return args.length;
  const valued = /* @__PURE__ */ new Set([
    "-e",
    "--env",
    "--env-file",
    "-v",
    "--volume",
    "-p",
    "--publish",
    "--name",
    "--network",
    "--net",
    "--entrypoint",
    "-u",
    "--user",
    "-w",
    "--workdir",
    "--mount",
    "--label",
    "-l",
    "--platform",
    "--add-host",
    "--restart",
    "-m",
    "--memory",
    "--memory-swap",
    "--memory-reservation",
    "--cpus",
    "--cpu-shares",
    "-c",
    "--cpuset-cpus",
    "--cpuset-mems",
    "--cpu-period",
    "--cpu-quota",
    "--cpu-rt-period",
    "--cpu-rt-runtime",
    "--device",
    "--device-cgroup-rule",
    "--cap-add",
    "--cap-drop",
    "--security-opt",
    "--group-add",
    "--sysctl",
    "--ulimit",
    "--oom-score-adj",
    "--pids-limit",
    "--log-driver",
    "--log-opt",
    "--tmpfs",
    "--shm-size",
    "--stop-signal",
    "--stop-timeout",
    "--runtime",
    "--userns",
    "--uts",
    "--cgroupns",
    "--cidfile",
    "--label-file",
    "--link",
    "--expose",
    "--health-cmd",
    "--health-interval",
    "--health-retries",
    "--health-timeout",
    "--health-start-period",
    "--gpus",
    "--hostname",
    "-h",
    "--domainname",
    "--dns",
    "--dns-search",
    "--dns-option",
    "--ipc",
    "--pid",
    "--ip",
    "--ip6",
    "--mac-address",
    "--network-alias",
    "--volumes-from",
    "--attach",
    "-a",
    "--detach-keys",
    "--blkio-weight",
    "--pull",
    "--isolation",
    "--storage-opt",
    "--annotation"
  ]);
  for (let i = 1; i < args.length; i += 1) {
    const arg = args[i];
    if (valued.has(arg)) {
      i += 1;
      continue;
    }
    if (arg.startsWith("-") && arg.includes("=")) continue;
    if (arg.startsWith("-")) continue;
    return i;
  }
  return args.length;
}
function mountArgv(entry) {
  const args = (Array.isArray(entry?.args) ? entry.args : []).map((arg) => String(arg));
  const extra = composeMountArgs(entry);
  if (entry?.command !== "docker") return [...args, ...extra];
  const env = styleEnv(entry);
  const flags = Object.entries(env).flatMap(([key, value]) => ["-e", `${key}=${value}`]);
  if (flags.length === 0) return [...args, ...extra];
  const at = imageIndex(args);
  return [...args.slice(0, at), ...flags, ...args.slice(at), ...extra];
}
function storedField(entry, field) {
  const bag = field.kind === "header" ? entry?.headers : field.kind === "config" ? entry?.configValues : entry?.env;
  const keys = bag && typeof bag === "object" ? field.kind === "header" ? Object.keys(bag).filter((key) => key.toLowerCase() === field.key.toLowerCase()) : [field.key] : [];
  const issue = field.kind === "header" && new Set(keys.map((key) => bag[key])).size > 1 ? `\u8BF7\u6C42\u5934 ${field.key} \u5B58\u5728\u5927\u5C0F\u5199\u91CD\u590D\u4E14\u503C\u51B2\u7A81\uFF0C\u8BF7\u6E05\u9664\u6216\u66FF\u6362\u540E\u91CD\u65B0\u914D\u7F6E` : "";
  const value = !issue && keys.length ? bag[keys[0]] : void 0;
  return { value: typeof value === "string" ? value : "", issue, hasValue: keys.some((key) => typeof bag[key] === "string" && bag[key].trim() !== "") };
}
function fieldGaps(spec, entry) {
  const missing = [];
  const pending = [];
  const conflicts = [];
  for (const field of spec?.fields ?? []) {
    const { value, issue } = storedField(entry, field);
    if (issue) {
      conflicts.push({ key: field.key, kind: field.kind, reason: issue });
      missing.push(field.key);
      continue;
    }
    if (value.trim() !== "") continue;
    if (field.required) missing.push(field.key);
    else pending.push(field.key);
  }
  return { missing, pending, ...conflicts.length ? { conflicts } : {} };
}
function maskedFields(spec, entry) {
  if (!spec || !Array.isArray(spec.fields) || spec.fields.length === 0) return null;
  const gaps = fieldGaps(spec, entry);
  return {
    origin: spec.origin ?? "manual",
    missing: gaps.missing,
    pending: gaps.pending,
    ...gaps.conflicts ? { conflicts: gaps.conflicts } : {},
    fields: spec.fields.map((field) => {
      const { value, issue, hasValue } = storedField(entry, field);
      const secret = field.secret === true || CREDENTIAL_SUFFIX.test(field.key);
      return {
        key: field.key,
        kind: field.kind,
        label: field.label,
        ...field.help || issue ? { help: [issue, field.help].filter(Boolean).join("\uFF1B") } : {},
        ...issue ? { issue } : {},
        // The two links a form needs when it asks for a credential: where to
        // obtain one, and (for a measured 401) what the endpoint's own
        // authorization metadata says. A row written before this field existed
        // still gets the link: the publisher's own sentence names the page, and
        // only *declared* text is mined that way — an error message's URL is
        // evidence, not a signup page.
        ...(() => {
          const helpUrl = field.helpUrl || (field.declared === true ? firstUrl(field.help) : "");
          return helpUrl ? { helpUrl } : {};
        })(),
        // An OAuth-gated endpoint's metadata document is machine JSON, not a
        // place a credential comes from — it is never offered as a link.
        ...field.oauth === true ? { oauth: true } : {},
        ...field.resourceUrl && field.oauth !== true ? { resourceUrl: field.resourceUrl } : {},
        required: field.required === true,
        secret,
        // Only present when the publisher declared this field, so the form can
        // label an inferred key 「来源未声明」 instead of asserting a rule nobody
        // published.
        ...field.declared === true ? { declared: true } : {},
        ...field.default ? { default: field.default } : {},
        ...Array.isArray(field.choices) && field.choices.length ? { choices: field.choices } : {},
        hasValue,
        value: secret ? hasValue ? "\u2022\u2022\u2022\u2022" : "" : redactEchoValue(value)
      };
    })
  };
}
function applyValues(entry, values = {}, { actor = "user" } = {}) {
  const changed = [];
  const rejected = [];
  const target = (kind) => {
    if (kind === "header") {
      if (!entry.headers || typeof entry.headers !== "object") entry.headers = {};
      return entry.headers;
    }
    if (kind === "config") {
      if (!entry.configValues || typeof entry.configValues !== "object") entry.configValues = {};
      return entry.configValues;
    }
    if (!entry.env || typeof entry.env !== "object") entry.env = {};
    return entry.env;
  };
  const kinds = [["env", values?.env], ["header", values?.headers], ["config", values?.config]];
  for (const [kind, bag] of kinds) {
    if (!bag || typeof bag !== "object") continue;
    for (const [rawKey, rawValue] of Object.entries(bag)) {
      const key = String(rawKey).trim();
      const pattern = kind === "env" ? ENV_NAME : kind === "header" ? HEADER_NAME : CONFIG_KEY;
      if (!pattern.test(key) || UNSAFE_KEYS.has(key)) {
        const what = kind === "env" ? "\u73AF\u5883\u53D8\u91CF\u540D" : kind === "header" ? "\u8BF7\u6C42\u5934\u540D" : "\u914D\u7F6E\u9879\u540D";
        rejected.push({ key, kind, reason: `\u4E0D\u662F\u5408\u6CD5\u7684${what}` });
        continue;
      }
      if (kind === "header" && RESERVED_HEADERS.has(key.toLowerCase())) {
        rejected.push({ key, kind, reason: "\u4F20\u8F93\u5C42\u4FDD\u7559\u8BF7\u6C42\u5934\u7981\u6B62\u914D\u7F6E" });
        continue;
      }
      if (actor === "model" && CODE_LOADING_ENV_VARS.has(key.toUpperCase())) {
        rejected.push({ key, kind, reason: "\u8BE5\u540D\u79F0\u53EF\u80FD\u5BFC\u81F4\u4EE3\u7801\u6267\u884C\uFF0C\u7981\u6B62\u6A21\u578B\u8C03\u7528\u914D\u7F6E" });
        continue;
      }
      const value = typeof rawValue === "string" ? rawValue : rawValue == null ? "" : String(rawValue);
      if (kind === "header" && /[\r\n]/.test(value)) {
        rejected.push({ key, kind, reason: "\u8BF7\u6C42\u5934\u7684\u503C\u4E0D\u80FD\u542B\u6362\u884C" });
        continue;
      }
      const store = target(kind);
      const trimmed = value.trim();
      const storedKeys = kind === "header" ? Object.keys(store).filter((name2) => name2.toLowerCase() === key.toLowerCase()) : Object.prototype.hasOwnProperty.call(store, key) ? [key] : [];
      if (trimmed === "") {
        if (storedKeys.length) {
          for (const storedKey of storedKeys) delete store[storedKey];
          changed.push({ key, kind, action: "cleared" });
        }
        continue;
      }
      const isTruncated = trimmed.length > MAX_VALUE_CHARS;
      const capped = isTruncated ? trimmed.slice(0, MAX_VALUE_CHARS) : trimmed;
      const prefixed = kind === "header" && key.toLowerCase() === "authorization" && entry?.authDemand?.scheme === "bearer" && !/^[A-Za-z][A-Za-z0-9_-]*\s+\S/.test(capped) ? `Bearer ${capped}` : capped;
      if (storedKeys.length === 1 && store[key] === prefixed) continue;
      for (const storedKey of storedKeys) delete store[storedKey];
      store[key] = prefixed;
      changed.push({ key, kind, action: prefixed !== capped ? "prefixed" : isTruncated ? "truncated" : "set" });
    }
  }
  return { changed, rejected };
}
function looksLikeCredentialFailure(errorText) {
  const text = String(errorText ?? "");
  if (text.trim() === "") return false;
  if (!AUTH_FAILURE.test(text)) return false;
  if (QUOTA_HINT.test(text) && !/unauthori[sz]ed|authenticat|credential|api[ _-]?key|请先|未配置/i.test(text)) return false;
  return true;
}
function configState(spec, entry) {
  if (!spec || !Array.isArray(spec.fields) || spec.fields.length === 0) return null;
  const gaps = fieldGaps(spec, entry);
  if (gaps.missing.length === 0 && gaps.pending.length === 0) return { needs: false, missing: [], pending: [] };
  return { needs: gaps.missing.length > 0, missing: gaps.missing, pending: gaps.pending, ...gaps.conflicts ? { conflicts: gaps.conflicts } : {} };
}

// lib/item-icons.js
import { isIP } from "node:net";
function publicIcon(value) {
  if (typeof value !== "string" || value.length > 2048 || !/^https:\/\//i.test(value)) return void 0;
  let url;
  try {
    url = new URL(value);
  } catch {
    return void 0;
  }
  const host = url.hostname.replace(/\.$/, "");
  if (url.username || url.password || !host.includes(".") || isIP(host) || /\.(?:localhost|local|internal|test|invalid)$/.test(host)) return void 0;
  return url.href;
}
function declaredIcon(metadata) {
  const records = Array.isArray(metadata?.icons) ? metadata.icons : [];
  const neutral = records.find((icon) => !icon?.theme && publicIcon(icon?.src));
  return publicIcon(neutral?.src) ?? publicIcon(records.find((icon) => publicIcon(icon?.src))?.src) ?? [metadata?.iconUrl, metadata?.icon, metadata?.logoUrl, metadata?.logo].map(publicIcon).find(Boolean);
}
function declaredEmoji(metadata) {
  const value = metadata?.emoji ?? metadata?.metadata?.emoji;
  return typeof value === "string" && value.length <= 24 && new RegExp("^(?=.*\\p{Emoji_Presentation}|.*\\uFE0F)[\\p{Emoji}\\p{Emoji_Component}\\u200D]+$", "u").test(value) ? value : void 0;
}
function githubOwnerIcon(owner) {
  return /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(owner ?? "") ? `https://github.com/${owner}.png?size=80` : void 0;
}
function publisherIcons(...publishedPages) {
  const owners = /* @__PURE__ */ new Set();
  for (const page of publishedPages) {
    const safe = publicIcon(page);
    if (!safe) continue;
    const url = new URL(safe);
    if (url.port || !["github.com", "www.github.com"].includes(url.hostname)) continue;
    const [, owner, repo] = url.pathname.split("/");
    if (repo && githubOwnerIcon(owner)) owners.add(githubOwnerIcon(owner));
  }
  return cleanPublisherIcons([...owners]);
}
function cleanPublisherIcons(value) {
  return Array.isArray(value) ? [...new Set(value.slice(0, 12).map(publicIcon).filter(Boolean))].slice(0, 3) : [];
}
var MCP_ARTWORK_KEYS = /* @__PURE__ */ new Map([
  ["official:uk.co.0sand1s/cis", "cis"],
  ["remote:https://0sand1s.co.uk/mcp", "cis"],
  ["https://0sand1s.co.uk/mcp", "cis"],
  ["official:ai.0si/disclosures", "disclosures"],
  ["official:com.3dtexel/mcp", "texel"],
  ["awesome:gatyh/3dtexel-mcp", "texel"],
  ["https://github.com/gatyh/3dtexel-mcp", "texel"],
  ["awesome:4everland/4everland-hosting-mcp", "hosting"],
  ["https://github.com/4everland/4everland-hosting-mcp", "hosting"],
  ["official:ai.1325/mcp", "business"],
  ["https://github.com/1325ai/1325ai", "business"],
  ["smithery:gmail", "gmail"],
  ["smithery:googlesheets", "sheets"]
]);
function mcpArtworkKey(catalogId, repository, endpoint) {
  return MCP_ARTWORK_KEYS.get(catalogId) ?? (typeof repository === "string" ? MCP_ARTWORK_KEYS.get(repository.toLowerCase().replace(/\/$/, "")) : void 0) ?? MCP_ARTWORK_KEYS.get(endpoint);
}

// lib/catalog.js
var DEFAULT_TIMEOUT_MS = 15e3;
var OFFICIAL_TIMEOUT_MS = 3e4;
var USER_AGENT2 = "dsh-overall-mcp (DeepSeek Harness plugin)";
var REQUEST_HEADERS = { "user-agent": USER_AGENT2 };
function awesomeMirrors(owner, repo, branch, path8) {
  const gh = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${path8}`;
  return [
    gh,
    `https://cdn.jsdelivr.net/gh/${owner}/${repo}@${branch}/${path8}`,
    `https://fastly.jsdelivr.net/gh/${owner}/${repo}@${branch}/${path8}`,
    `https://testingcf.jsdelivr.net/gh/${owner}/${repo}@${branch}/${path8}`
  ];
}
async function fetchFirstText(urls, opts = {}) {
  const { fetchImpl = fetch, cache } = opts;
  const MIRROR_TIMEOUT_MS = 3e4;
  const entries = urls.map((url) => ({ url, ctl: new AbortController() }));
  const failures = [];
  const attempts = entries.map(({ url, ctl }) => {
    const timer = setTimeout(() => ctl.abort(), MIRROR_TIMEOUT_MS);
    const etag = cache?.etagFor(url);
    cache?.noteRequest();
    return fetchImpl(url, {
      signal: ctl.signal,
      headers: withGithubAuth(url, { ...REQUEST_HEADERS, accept: "text/plain", ...etag ? { "if-none-match": etag } : {} })
    }).then(async (res) => {
      if (res.status === 304) {
        const body = cache?.reuse(url);
        if (body !== void 0) return body;
        throw new Error("HTTP 304 without a cached body");
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      cache?.noteDownload(text.length);
      cache?.remember(url, { etag: res.headers?.get?.("etag"), body: text, bytes: text.length });
      return text;
    }).catch((err) => {
      failures.push(`${new URL(url).hostname}: ${String(err?.message ?? err)}`);
      throw err;
    }).finally(() => clearTimeout(timer));
  });
  try {
    return await Promise.any(attempts);
  } catch {
    throw new Error(`all mirrors failed \u2014 ${failures.join(" | ")}`);
  } finally {
    for (const { ctl } of entries) ctl.abort();
  }
}
var FUNCTIONAL_GROUPS = [
  ["\u5F00\u53D1\u5DE5\u5177", ["Developer Tools", "Coding Agents", "Code Execution", "Command Line", "Version Control"]],
  ["\u6570\u636E\u4E0E\u5B58\u50A8", ["Databases", "Data Platforms", "Data Science Tools", "Data Visualization", "File Systems", "File Storage"]],
  ["\u641C\u7D22\u4E0E\u77E5\u8BC6", ["Search & Data Extraction", "end to end RAG platforms", "Knowledge & Memory", "Research", "Science & Research", "Conversational AI"]],
  ["\u5B89\u5168\u4E0E\u8EAB\u4EFD", ["Security", "Cryptography", "Identity"]],
  ["\u529E\u516C\u534F\u4F5C", ["Communication", "Workplace & Productivity", "Project Management", "Product Management", "Support & Service Management", "Agreements & Coordination"]],
  ["\u8425\u9500\u4E0E\u5BA2\u6237", ["Marketing", "Sales", "CRM", "Customer Data Platforms"]],
  ["\u91D1\u878D\u652F\u4ED8", ["Finance & Fintech", "Finance", "Payments"]],
  ["\u5546\u4E1A\u4E0E\u6CD5\u5F8B", ["E-Commerce", "Legal", "Real Estate"]],
  ["\u4E91\u4E0E\u8FD0\u7EF4", ["Cloud Platforms", "Monitoring", "OS Automation", "Embedded System", "Industrial & IoT"]],
  ["\u6D4F\u89C8\u5668\u81EA\u52A8\u5316", ["Browser Automation"]],
  ["\u793E\u4EA4\u5A92\u4F53", ["Social Media"]],
  ["\u591A\u5A92\u4F53\u521B\u4F5C", ["Multimedia Process", "Multimedia", "Art & Culture", "Art & Design", "Architecture & Design"]],
  ["\u8BED\u97F3\u4E0E\u8BED\u8A00", ["Text-to-Speech", "Speech-to-Text", "Translation Services", "Translation & Localization", "Podcasts"]],
  ["\u51FA\u884C\u4E0E\u751F\u6D3B", ["Travel & Transportation", "Location Services", "Delivery", "Food & Dining", "Home Automation"]],
  ["\u533B\u7597\u5065\u5EB7", ["Biology, Medicine and Bioinformatics", "Health & Fitness", "Health & Wellness"]],
  ["\u6559\u80B2\u5B66\u672F", ["Education", "Aerospace & Astrodynamics"]],
  ["\u6E38\u620F\u5A31\u4E50", ["Gaming", "Sports", "Spirituality & Esoterica"]],
  ["\u81EA\u7136\u73AF\u5883", ["Environment", "Environment & Nature", "Agriculture"]],
  ["\u805A\u5408\u7F51\u5173", ["Aggregators"]],
  ["\u5176\u4ED6", ["Other Tools and Integrations", "Other Tools & Integrations", "Accessibility"]]
];
var HEADING_TO_GROUP = new Map(FUNCTIONAL_GROUPS.flatMap(([group, headings]) => headings.map((h) => [h, group])));
var GROUP_KEYWORDS = [
  ["\u641C\u7D22\u4E0E\u77E5\u8BC6", ["search", "web search", "deep research", "crawl", "scrape", "scraping", "rag", "retrieval", "knowledge base", "knowledge graph", "documentation", "docs", "wiki", "wikipedia", "arxiv", "pubmed", "semantic search", "embedding", "embeddings", "research", "reading", "summariz", "directory"]],
  ["\u5F00\u53D1\u5DE5\u5177", ["github", "gitlab", "git", "code", "coding", "developer", "debug", "debugging", "refactor", "lint", "build", "compile", "typescript", "javascript", "python", "npm", "pypi", "repository", "repo", "test", "testing", "ci/cd", "sdk", "api client", "syntax", "terminal", "shell", "ide", "wordpress", "headless cms"]],
  ["\u529E\u516C\u534F\u4F5C", ["notion", "slack", "gmail", "email", "mail", "inbox", "draft", "thread", "label", "attachment", "messaging", "outlook", "calendar", "meeting", "spreadsheet", "google sheets", "google drive", "jira", "linear", "asana", "trello", "todo", "task management", "project management", "confluence", "zendesk", "intercom", "productivity", "workspace", "note-taking", "obsidian", "airtable", "monday.com", "team"]],
  ["\u6570\u636E\u4E0E\u5B58\u50A8", ["database", "sql", "postgres", "postgresql", "mysql", "sqlite", "mongodb", "redis", "elasticsearch", "clickhouse", "snowflake", "bigquery", "data warehouse", "etl", "dataset", "data science", "analytics", "vector database", "s3", "filesystem", "file storage", "csv", "parquet", "duckdb", "nosql"]],
  ["\u4E91\u4E0E\u8FD0\u7EF4", ["aws", "azure", "gcp", "google cloud", "kubernetes", "k8s", "docker", "terraform", "ansible", "devops", "cloud", "monitoring", "observability", "grafana", "prometheus", "datadog", "sentry", "logging", "logs", "infrastructure", "deploy", "deployment", "uptime", "incident"]],
  ["\u5B89\u5168\u4E0E\u8EAB\u4EFD", ["security", "vulnerability", "pentest", "penetration testing", "exploit", "cve", "oauth", "authentication", "authorization", "secrets", "encryption", "password", "sso", "iam", "threat", "malware", "forensic", "audit log"]],
  ["\u6D4F\u89C8\u5668\u81EA\u52A8\u5316", ["browser", "playwright", "puppeteer", "selenium", "headless", "chromium", "browser automation", "web automation", "screenshot", "form filling", "devtools"]],
  ["\u793E\u4EA4\u5A92\u4F53", ["twitter", "x.com", "reddit", "discord", "telegram", "mastodon", "bluesky", "linkedin", "facebook", "instagram", "tiktok", "youtube", "weibo", "social media", "social network", "community platform"]],
  ["\u591A\u5A92\u4F53\u521B\u4F5C", ["image", "video", "audio", "music", "photo", "ffmpeg", "design", "figma", "canvas", "graphics", "3d", "animation", "media", "drawing", "render", "illustration", "midjourney", "stable diffusion", "transcod", "gif", "font", "color palette"]],
  ["\u8BED\u97F3\u4E0E\u8BED\u8A00", ["speech", "text-to-speech", "tts", "speech-to-text", "stt", "voice", "transcription", "whisper", "translate", "translation", "linguistic", "podcast", "dub", "subtitle", "language detection"]],
  ["\u91D1\u878D\u652F\u4ED8", ["payment", "stripe", "paypal", "invoice", "billing", "accounting", "finance", "financial", "stock", "trading", "crypto", "bitcoin", "ethereum", "wallet", "banking", "expense", "tax", "ledger", "portfolio"]],
  ["\u8425\u9500\u4E0E\u5BA2\u6237", ["marketing", "seo", "advertising", "campaign", "crm", "sales", "lead generation", "customer support", "email marketing", "brand", "newsletter", "outreach", "growth", "conversion"]],
  ["\u5546\u4E1A\u4E0E\u6CD5\u5F8B", ["legal", "law", "lawyer", "contract", "compliance", "gdpr", "e-commerce", "ecommerce", "shopify", "real estate", "procurement", "human resources", "hiring", "resume", "recruit", "insurance", "supply chain"]],
  ["\u51FA\u884C\u4E0E\u751F\u6D3B", ["travel", "flight", "hotel", "booking", "map", "geocod", "transit", "train", "taxi", "ride", "delivery", "food", "recipe", "restaurant", "home automation", "smart home", "shopping", "lifestyle"]],
  ["\u533B\u7597\u5065\u5EB7", ["health", "medical", "medicine", "clinical", "patient", "fhir", "hl7", "drug", "biotech", "bioinformatics", "genom", "fitness", "nutrition", "symptom", "hospital", "mental health"]],
  ["\u6559\u80B2\u5B66\u672F", ["education", "learning", "course", "student", "teacher", "school", "university", "academic", "citation", "paper", "exam", "quiz", "tutor", "astronomy", "aerospace", "physics", "chemistry", "math"]],
  ["\u6E38\u620F\u5A31\u4E50", ["game", "gaming", "minecraft", "steam", "unity", "unreal", "emulator", "sports", "esport", "movie", "anime", "comic", "music discovery", "board game"]],
  ["\u81EA\u7136\u73AF\u5883", ["climate", "environment", "environmental", "earth", "geo", "gis", "satellite", "agriculture", "farm", "ocean", "wildlife", "biodiversity", "carbon", "weather", "earthquake", "ecology", "energy grid"]],
  ["\u805A\u5408\u7F51\u5173", ["aggregator", "gateway", "proxy", "router", "multi-server", "marketplace", "registry of", "bridge", "unified access", "mcp hub"]]
];
var GROUP_MATCHERS = GROUP_KEYWORDS.map(([group, words]) => [
  group,
  words.map((w) => ({
    re: new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "i"),
    weight: w.split(/\s+/).length
  }))
]);
function inferGroupOf(item) {
  const title = String(item?.title ?? "");
  const description = String(item?.description ?? "");
  if (!title.trim() && !description.trim()) return void 0;
  let best;
  let bestScore = 0;
  for (const [group, matchers] of GROUP_MATCHERS) {
    let score = 0;
    for (const { re, weight } of matchers) {
      if (re.test(title)) score += weight * 2;
      if (re.test(description)) score += weight;
    }
    if (score > bestScore) {
      bestScore = score;
      best = group;
    }
  }
  return best;
}
function functionalGroupOf(item) {
  if (item?.category) return HEADING_TO_GROUP.get(item.category) ?? "\u5176\u4ED6";
  return inferGroupOf(item);
}
function groupSourceOf(item) {
  if (!functionalGroupOf(item)) return void 0;
  return item?.category ? "upstream" : "inferred";
}
var searchQuota = { remaining: null, resetAt: 0, blockedUntil: 0, reason: null };
var GITHUB_SEARCH_URL = "https://api.github.com/search/repositories";
function isGithubSearch(url) {
  return typeof url === "string" && url.startsWith(GITHUB_SEARCH_URL);
}
function noteSearchQuota(res, { failed = false } = {}) {
  const remaining = Number(res?.headers?.get?.("x-ratelimit-remaining"));
  if (Number.isFinite(remaining)) searchQuota.remaining = remaining;
  const reset = Number(res?.headers?.get?.("x-ratelimit-reset"));
  if (Number.isFinite(reset) && reset > 0) searchQuota.resetAt = reset * 1e3;
  if (!failed) {
    if (searchQuota.blockedUntil) {
      searchQuota.blockedUntil = 0;
      searchQuota.reason = null;
      emit({ kind: "quota", action: "clear", remaining: searchQuota.remaining });
    }
    return;
  }
  const wasBlocked = searchQuota.blockedUntil > Date.now();
  const retryAfter = Number(res?.headers?.get?.("retry-after"));
  const until = Number.isFinite(retryAfter) && retryAfter > 0 ? Date.now() + retryAfter * 1e3 : searchQuota.resetAt > Date.now() ? searchQuota.resetAt : Date.now() + 6e4;
  searchQuota.blockedUntil = Math.max(searchQuota.blockedUntil, until);
  searchQuota.reason = "API rate limit exceeded";
  if (!wasBlocked) {
    emit({
      kind: "quota",
      action: "empty",
      remaining: searchQuota.remaining,
      waitMs: Math.max(0, searchQuota.blockedUntil - Date.now()),
      reason: searchQuota.reason
    });
  }
}
function githubSearchQuota() {
  return {
    remaining: searchQuota.remaining,
    resetAt: searchQuota.resetAt || null,
    blockedUntil: searchQuota.blockedUntil || null,
    waitMs: Math.max(0, searchQuota.blockedUntil - Date.now()),
    reason: searchQuota.reason
  };
}
function isSearchQuotaExhausted(err) {
  return Number(err?.status) === 403 && (err?.code === "quota" || /rate limit|secondary rate limit|abuse detection/i.test(String(err?.upstreamMessage ?? "")));
}
async function fetchJson2(url, { timeoutMs = DEFAULT_TIMEOUT_MS, fetchImpl = fetch, accept = "application/json", cache, onResponse } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const etag = cache?.etagFor(url);
    const res = await withFastRetry(async () => {
      cache?.noteRequest();
      const r = await fetchImpl(url, {
        signal: ctl.signal,
        headers: withGithubAuth(url, { ...REQUEST_HEADERS, accept, ...etag ? { "if-none-match": etag } : {} })
      });
      if (!r.ok && r.status !== 304) {
        const err = new Error(`HTTP ${r.status}`);
        err.status = r.status;
        try {
          const body2 = await r.json();
          if (typeof body2?.message === "string") err.upstreamMessage = body2.message;
        } catch {
        }
        const remaining = r.headers?.get?.("x-ratelimit-remaining");
        if (r.status === 429 || remaining != null && remaining !== "" && Number(remaining) === 0 || /rate limit|abuse detection/i.test(err.upstreamMessage ?? "")) err.code = "quota";
        const reset = Number(r.headers?.get?.("x-ratelimit-reset")) * 1e3;
        const wait = Number(r.headers?.get?.("retry-after")) * 1e3;
        if (r.status === 403 && /^https:\/\/api\.github\.com\//.test(String(url)) && err.code !== "quota") err.nonRetryable = true;
        if (reset > Date.now()) err.retryAt = reset;
        else if (wait > 0) err.retryAt = Date.now() + wait;
        if (isGithubSearch(url)) noteSearchQuota(r, { failed: true });
        throw err;
      }
      if (isGithubSearch(url)) noteSearchQuota(r);
      onResponse?.(r);
      return r;
    });
    if (res.status === 304) {
      const body2 = cache?.reuse(url);
      if (body2 !== void 0) return body2;
      throw new Error("HTTP 304 without a cached body");
    }
    const body = await res.json();
    const size = JSON.stringify(body ?? null)?.length ?? 0;
    cache?.noteDownload(size);
    cache?.remember(url, { etag: res.headers?.get?.("etag"), body, bytes: size });
    return body;
  } finally {
    clearTimeout(timer);
  }
}
async function withFastRetry(fn, { delayMs = 1500, statusDelayMs = 2500 } = {}) {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  try {
    return await fn();
  } catch (err) {
    if (isAnonymousPageLimit(err) || err.nonRetryable || err.code === "quota") throw err;
    if (isSearchQuotaExhausted(err)) throw err;
    const message = String(err?.cause?.message ?? err?.message ?? "");
    if (/fetch failed/i.test(message)) {
      await wait(delayMs);
      return fn();
    }
    const status = Number(err?.status);
    if (status === 403 || status === 408 || status === 425 || status === 429 || status >= 500) {
      await wait(statusDelayMs);
      return fn();
    }
    throw err;
  }
}
var clampText = (value, max = 300) => String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
function isAnonymousPageLimit(err) {
  return Number(err?.status) === 403 && /pagination offset too large for anonymous requests/i.test(String(err?.upstreamMessage ?? ""));
}
function authorFromQualified(qualified) {
  const s = String(qualified ?? "");
  const slash = s.indexOf("/");
  const scope = slash > 0 ? s.slice(0, slash) : "";
  return scope.replace(/^@/, "") || void 0;
}
var MAX_UPSTREAM_PAGES = 4;
async function fetchOfficialRegistry({ limit = 100, cursor, query = "", pages = 1, dedupe: dedupe2 = false, ...opts } = {}) {
  const items = [];
  let nextCursor = cursor;
  let page = 0;
  do {
    const url = new URL("https://registry.modelcontextprotocol.io/v0/servers");
    url.searchParams.set("limit", String(Math.min(limit, 100)));
    if (nextCursor) url.searchParams.set("cursor", nextCursor);
    if (query) url.searchParams.set("search", query);
    const data = await fetchJson2(url.toString(), { timeoutMs: OFFICIAL_TIMEOUT_MS, ...opts });
    for (const entry of data.servers ?? []) {
      const item = normalizeOfficialItem(entry);
      if (item) items.push(item);
    }
    nextCursor = data.metadata?.nextCursor ?? null;
    page += 1;
  } while (nextCursor && page < Math.min(pages, MAX_UPSTREAM_PAGES));
  if (!dedupe2) return { items, nextCursor };
  const best = /* @__PURE__ */ new Map();
  for (const item of items) {
    const key = item.raw?.name ?? item.id;
    const held = best.get(key);
    if (!held) {
      best.set(key, item);
      continue;
    }
    if (item.isLatest && !held.isLatest) {
      best.set(key, item);
      continue;
    }
    if (held.isLatest && !item.isLatest) continue;
    const rank = String(item.updatedAt ?? "");
    const heldRank = String(held.updatedAt ?? "");
    if (rank > heldRank) {
      best.set(key, item);
      continue;
    }
    if (rank === heldRank && compareVersions(item.version ?? "0", held.version ?? "0") > 0) best.set(key, item);
  }
  return { items: [...best.values()], nextCursor };
}
function normalizeOfficialItem(entry) {
  const s = entry?.server ?? entry;
  if (!s?.name) return null;
  const meta = entry?._meta?.["io.modelcontextprotocol.registry/official"] ?? entry?._meta ?? {};
  const packages = s.packages ?? [];
  const pkg = packages.find((p) => (p.registry_type ?? p.registryType) === "npm") ?? packages.find((p) => (p.registry_type ?? p.registryType) === "pypi");
  const remote = (s.remotes ?? [])[0];
  const repoUrl = s.repository?.url ?? s.repository;
  const identifier = pkg?.identifier ?? pkg?.name;
  let install = null;
  if (identifier && (pkg.registry_type ?? pkg.registryType) === "npm") {
    install = { transport: "stdio", command: "npx", args: ["-y", identifier] };
  } else if (identifier && (pkg.registry_type ?? pkg.registryType) === "pypi") {
    install = { transport: "stdio", command: "uvx", args: [identifier] };
  } else if (remote?.url) {
    install = { transport: "streamable-http", url: remote.url };
  }
  const tags = [];
  if (identifier) tags.push((pkg.registry_type ?? pkg.registryType) === "npm" ? "npm" : "pypi");
  const lastSegment = String(s.name).split("/").filter(Boolean).pop() ?? s.name;
  return {
    id: `official:${s.name}`,
    title: s.title || lastSegment,
    description: clampText(s.description),
    source: "official-registry",
    author: authorFromQualified(s.name),
    version: s.version ?? void 0,
    transport: install?.transport ?? "unknown",
    install,
    repository: typeof repoUrl === "string" ? repoUrl : void 0,
    homepage: typeof s.websiteUrl === "string" ? s.websiteUrl : void 0,
    icon: declaredIcon(s),
    tags,
    official: true,
    updatedAt: meta.updatedAt ?? meta.publishedAt ?? void 0,
    isLatest: meta.isLatest === true ? true : void 0,
    // The registry's own lifecycle flag, carried verbatim. Only `deprecated`
    // is acted on; anything else (including an unknown future status) is
    // surfaced as-is rather than guessed at.
    status: typeof meta.status === "string" ? meta.status : void 0,
    statusMessage: typeof meta.statusMessage === "string" ? meta.statusMessage : void 0,
    deprecated: meta.status === "deprecated" ? true : void 0,
    raw: s
  };
}
async function fetchSmithery({ query = "", page = 1, ...opts } = {}) {
  const url = new URL("https://registry.smithery.ai/servers");
  if (query) url.searchParams.set("q", query);
  url.searchParams.set("page", String(page));
  const data = await fetchJson2(url.toString(), opts);
  const list = data.servers ?? data ?? [];
  const items = (Array.isArray(list) ? list : []).map((s) => {
    const qualified = s.qualifiedName ?? s.name;
    return {
      id: `smithery:${qualified}`,
      title: s.displayName ?? s.name ?? qualified,
      description: clampText(s.description),
      source: "smithery",
      author: s.namespace ?? authorFromQualified(qualified),
      version: s.version ?? void 0,
      // What Smithery's own record says about reaching this server. `remote: true`
      // means *they* host it: the detail endpoint then reports an `http`
      // connection with a deployment URL, and the only correct install is that
      // URL. `npx @smithery/cli run` is not a local server for these — it is a
      // stdio proxy that resolves the record to the very same remote URL, spawns
      // `mcp-remote`, and waits for an interactive OAuth sign-in that a headless
      // mount can never complete. (Measured: `run upstash/context7-mcp` printed
      // 「Another instance is running the sign-in … on port 4814」 and answered no
      // `initialize` in 20 s.) So a hosted row declares http and resolves its
      // endpoint at install time; only locally-run ones keep the CLI command.
      transport: s.remote === true ? "streamable-http" : qualified ? "stdio" : "unknown",
      install: s.remote === true ? { transport: "streamable-http", url: null, deferred: true } : qualified ? { transport: "stdio", command: "npx", args: ["-y", "@smithery/cli", "run", qualified] } : null,
      repository: s.repository?.url ?? s.homepage,
      homepage: s.homepage,
      icon: declaredIcon(s),
      tags: [s.remote ? "\u6258\u7BA1" : "\u672C\u5730"].filter(Boolean),
      installs: typeof s.useCount === "number" ? s.useCount : void 0,
      // What `useCount` actually counts, so the card can say so rather than
      // presenting a platform-specific number as a universal popularity score.
      installsLabel: "\u6B21\u542F\u52A8",
      installsWindow: void 0,
      verified: s.verified === true ? true : void 0,
      // Smithery's own lifecycle flags. `inactive` means the upstream no longer
      // serves it; `unlisted` means it is hidden from their directory but still
      // works. Only the first is a deprecation.
      status: s.inactive === true ? "inactive" : s.unlisted === true ? "unlisted" : "active",
      deprecated: s.inactive === true ? true : void 0,
      raw: s
    };
  }).filter((i) => i.title);
  return { items, hasNext: Boolean(data.nextPage ?? data.hasNext) };
}
async function fetchSmitheryConfig(qualifiedName, { timeoutMs = 8e3, ...opts } = {}) {
  const name2 = typeof qualifiedName === "string" ? qualifiedName.trim() : "";
  if (name2 === "") return null;
  const url = `https://registry.smithery.ai/servers/${encodeURIComponent(name2)}`;
  try {
    const data = await fetchJson2(url, { ...opts, timeoutMs });
    const connections = Array.isArray(data?.connections) ? data.connections : [];
    const schema = connections.map((connection) => connection?.configSchema).find((candidate) => candidate && typeof candidate === "object");
    const hosted = connections.find((connection) => {
      const type = String(connection?.type ?? "").toLowerCase();
      const httpish = type === "http" || type === "streamable-http" || type === "sse";
      return httpish && typeof connection?.deploymentUrl === "string" && connection.deploymentUrl !== "";
    });
    const topLevel = typeof data?.deploymentUrl === "string" && data.deploymentUrl !== "" ? data.deploymentUrl : null;
    if (!schema && !hosted && !topLevel) {
      return { schema: null, remote: data?.remote === true, deploymentUrl: null, httpUrl: null, connectionTypes: [] };
    }
    return {
      schema,
      remote: data?.remote === true,
      deploymentUrl: connections.map((connection) => connection?.deploymentUrl).find((candidate) => typeof candidate === "string") ?? topLevel,
      httpUrl: hosted?.deploymentUrl ?? topLevel,
      connectionTypes: connections.map((connection) => typeof connection?.type === "string" ? connection.type : "unknown")
    };
  } catch (err) {
    return {
      schema: null,
      remote: false,
      deploymentUrl: null,
      httpUrl: null,
      connectionTypes: [],
      error: String(err?.message ?? err),
      status: Number.isFinite(err?.status) ? err.status : void 0
    };
  }
}
async function fetchDockerCatalog({ limit = 100, pages = 3, ...opts } = {}) {
  const items = [];
  let page = 1;
  let note;
  let lastCount;
  while (items.length < limit && page <= Math.min(pages, MAX_UPSTREAM_PAGES)) {
    const url = new URL(`https://hub.docker.com/v2/repositories/mcp/`);
    url.searchParams.set("page_size", "100");
    url.searchParams.set("page", String(page));
    let data;
    try {
      data = await fetchJson2(url.toString(), opts);
    } catch (err) {
      if (isAnonymousPageLimit(err)) {
        note = `Docker Hub \u533F\u540D\u53EA\u653E\u51FA\u7B2C\u4E00\u9875\uFF08\u5171 ${lastCount ?? "?"} \u4E2A\u955C\u50CF\uFF0C\u5DF2\u53D6 ${items.length}\uFF09\u2014\u2014\u7FFB\u9875\u9700\u8981\u767B\u5F55\u3002`;
        break;
      }
      throw err;
    }
    if (typeof data.count === "number") lastCount = data.count;
    const results = data.results ?? [];
    for (const repo of results) {
      const name2 = repo.name?.replace(/^mcp\//, "") ?? "";
      if (!name2) continue;
      const namespace = repo.namespace ?? "library";
      items.push({
        id: `docker:mcp/${name2}`,
        title: name2,
        description: clampText(repo.description),
        source: "docker-catalog",
        author: namespace,
        transport: "stdio",
        install: { transport: "stdio", command: "docker", args: ["run", "-i", "--rm", `mcp/${name2}`] },
        repository: `https://hub.docker.com/r/mcp/${name2}`,
        icon: declaredIcon(repo),
        homepage: `https://hub.docker.com/r/mcp/${name2}`,
        tags: namespace && namespace !== "library" ? [`Docker \xB7 ${namespace}`] : ["Docker"],
        installs: typeof repo.pull_count === "number" ? repo.pull_count : void 0,
        // Docker reports lifetime pulls, not a rolling window — a different
        // quantity from Smithery's use count and not comparable to it.
        installsLabel: "\u6B21\u62C9\u53D6",
        installsWindow: "\u7D2F\u8BA1",
        verified: repo.is_official === true || repo.affiliation === "OFFICIAL" ? true : void 0,
        official: repo.is_official === true || void 0,
        // Docker reports a numeric status (1 = active). Anything else means the
        // image is no longer published, which is a deprecation.
        status: repo.status === 1 || repo.status === void 0 ? "active" : `status:${repo.status}`,
        deprecated: repo.status !== void 0 && repo.status !== 1 ? true : void 0,
        // `last_updated` is the only staleness signal Docker gives; an image
        // untouched for years is a maintenance signal, not a verdict.
        updatedAt: typeof repo.last_updated === "string" ? repo.last_updated : void 0
      });
    }
    if (!data.next) break;
    page += 1;
  }
  return { items: items.slice(0, limit), note };
}
function describeAge(ageMs) {
  if (!Number.isFinite(ageMs)) return "\u65F6\u95F4\u672A\u77E5";
  const minutes = Math.floor(Math.max(0, ageMs) / 6e4);
  if (minutes < 1) return "\u521A\u521A";
  if (minutes < 60) return `${minutes} \u5206\u949F\u524D`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} \u5C0F\u65F6\u524D`;
  return `${Math.floor(hours / 24)} \u5929\u524D`;
}
async function searchGithubRepos({ query, page = 1, perPage = 100, ...opts } = {}) {
  const waitMs = searchQuota.blockedUntil - Date.now();
  if (waitMs > 0) {
    const err = new Error(`\u641C\u7D22\u914D\u989D\u5DF2\u7528\u5B8C\uFF08\u7EA6 ${Math.ceil(waitMs / 1e3)} \u79D2\u540E\u6062\u590D\uFF09`);
    err.status = 403;
    err.code = "quota";
    err.upstreamMessage = searchQuota.reason ?? "API rate limit exceeded";
    err.retryAfterMs = waitMs;
    throw err;
  }
  const url = new URL(GITHUB_SEARCH_URL);
  url.searchParams.set("q", String(query ?? ""));
  url.searchParams.set("sort", "stars");
  url.searchParams.set("order", "desc");
  url.searchParams.set("per_page", String(Math.max(1, Math.min(100, perPage))));
  url.searchParams.set("page", String(Math.max(1, page)));
  try {
    const data = await fetchJson2(url.toString(), { ...opts, accept: "application/vnd.github+json" });
    return {
      repos: Array.isArray(data?.items) ? data.items : [],
      totalCount: Number(data?.total_count ?? 0)
    };
  } catch (err) {
    if (isSearchQuotaExhausted(err)) {
      err.code = "quota";
      const wait = searchQuota.blockedUntil - Date.now();
      if (wait > 0) err.retryAfterMs = wait;
    }
    throw err;
  }
}
function githubItemOf(repo, { includeRaw = true } = {}) {
  const fullName = String(repo?.full_name ?? "");
  if (!fullName) return null;
  const [owner, name2] = fullName.split("/");
  return {
    id: `github:${fullName}`,
    title: clampText(name2 || fullName, 120),
    description: clampText(repo.description),
    source: "github-mcp",
    author: repo.owner?.login ?? owner,
    icon: publicIcon(repo.owner?.avatar_url) ?? githubOwnerIcon(repo.owner?.login ?? owner),
    // Nothing here is installable on evidence: no transport is declared
    // anywhere in a repository listing.
    transport: "unknown",
    install: null,
    repository: repo.html_url ?? `https://github.com/${fullName}`,
    homepage: repo.homepage || void 0,
    tags: Array.isArray(repo.topics) ? repo.topics.slice(0, 8) : [],
    // GitHub states no verification, and guessing "official" from a big owner
    // name would be exactly the kind of claim this panel refuses.
    verified: void 0,
    official: void 0,
    // The queries ask for `archived:false`, so this should never fire — but if
    // the upstream ever answers with an archived repository, saying so beats
    // calling a dead project active.
    status: repo.archived === true ? "archived" : "active",
    deprecated: repo.archived === true || void 0,
    // Stars come from the search response itself, so the card has them even
    // when the enrichment pass is skipped or its 60/hour budget is spent. The
    // same is true of the three facts below: they are already in this response,
    // and the card renders `item.*` as a fallback — a repository row should not
    // be a blank card just because /repos was not called.
    stars: typeof repo.stargazers_count === "number" ? repo.stargazers_count : void 0,
    language: typeof repo.language === "string" && repo.language ? repo.language : void 0,
    forks: typeof repo.forks_count === "number" ? repo.forks_count : void 0,
    openIssues: typeof repo.open_issues_count === "number" ? repo.open_issues_count : void 0,
    updatedAt: typeof repo.pushed_at === "string" ? repo.pushed_at : void 0,
    ...includeRaw ? { raw: repo } : {}
  };
}
function githubIndexNote(index, { listed = 0, indexOnly = false } = {}) {
  const total = index?.rows?.length ?? 0;
  const ageMs = Number.isFinite(index?.ageMs) ? index.ageMs : index?.at ? Date.now() - Date.parse(index.at) : NaN;
  const parts = [`\u672C\u5730\u7D22\u5F15 ${total} \u884C`, describeAge(ageMs)];
  if (index?.stale) parts.push("\u5F85\u66F4\u65B0");
  if (index?.partial) parts.push(`\u4E0A\u6B21\u6293\u53D6\u672A\u8D70\u5B8C\uFF1A${index.partial}`);
  return `${parts.join("\u30FB")}\uFF1B\u672C\u6B21\u5217\u51FA ${Math.max(0, listed)} \u6761${indexOnly ? "\uFF0C\u6CA1\u53D1\u8BF7\u6C42" : ""}`;
}
async function fetchGithubMcp({ limit = 200, pages = 3, query = "", githubIndex = null, githubWalk = null, indexOnly = false, ...opts } = {}) {
  if (githubIndex?.rows?.length) {
    const q = String(query ?? "").trim();
    const rows = q ? githubIndex.rows.filter((item) => matchItem(item, q)) : githubIndex.rows;
    const items2 = rows.slice(0, limit);
    return {
      items: items2,
      note: githubIndexNote(githubIndex, { listed: items2.length, indexOnly }),
      index: {
        rows: githubIndex.rows.length,
        matched: rows.length,
        at: githubIndex.at ?? null,
        ageMs: Number.isFinite(githubIndex.ageMs) ? githubIndex.ageMs : void 0,
        stale: githubIndex.stale === true,
        complete: githubIndex.complete === true,
        partial: githubIndex.partial ?? null
      },
      // The rows' own timestamp, so the panel reports the census's age rather
      // than the moment this listing happened to read it.
      dataAt: githubIndex.at ?? void 0
    };
  }
  if (githubWalk) {
    const held = Number(githubWalk.rows ?? 0);
    return {
      items: [],
      note: held > 0 ? `\u6B63\u5728\u5EFA\u7ACB\u672C\u673A\u666E\u67E5\u7D22\u5F15\uFF08\u5DF2\u6536 ${held} \u884C\uFF09\uFF0C\u7A0D\u540E\u8FD9\u91CC\u76F4\u63A5\u8BFB\u7D22\u5F15` : "\u6B63\u5728\u5EFA\u7ACB\u672C\u673A\u666E\u67E5\u7D22\u5F15\uFF08\u9996\u6B21\u5EFA\u7D22\u5F15\u9700\u8981\u51E0\u5206\u949F\uFF09\uFF0C\u7A0D\u540E\u8FD9\u91CC\u76F4\u63A5\u8BFB\u7D22\u5F15",
      walk: { requests: Number(githubWalk.requests ?? 0), rows: held }
    };
  }
  if (indexOnly) {
    return {
      items: [],
      note: githubIndex ? "\u672C\u673A\u666E\u67E5\u7D22\u5F15\u8FD8\u662F\u7A7A\u7684\uFF08\u4E00\u884C\u90FD\u8FD8\u6CA1\u8D70\u5230\uFF09\uFF1B\u5EFA\u597D\u540E\u8FD9\u91CC\u76F4\u63A5\u8BFB\u5B83\uFF0C\u4E0D\u53D1\u8BF7\u6C42" : "\u672C\u673A\u8FD8\u6CA1\u6709\u666E\u67E5\u7D22\u5F15\uFF1A\u5728 GitHub \u8BBF\u95EE\u5361\u91CC\u5F00\u59CB\u4E00\u6B21\u666E\u67E5\uFF0C\u5EFA\u597D\u540E\u8FD9\u91CC\u76F4\u63A5\u8BFB\u5B83\uFF0C\u4E0D\u53D1\u8BF7\u6C42",
      index: githubIndex ? {
        rows: githubIndex.rows.length,
        matched: 0,
        at: githubIndex.at ?? null,
        ageMs: Number.isFinite(githubIndex.ageMs) ? githubIndex.ageMs : void 0,
        stale: githubIndex.stale === true,
        complete: githubIndex.complete === true,
        partial: githubIndex.partial ?? null
      } : void 0,
      transient: true
    };
  }
  const QUERIES = [
    "mcp-server in:name archived:false",
    "topic:mcp-server mcp in:description archived:false",
    "topic:model-context-protocol mcp in:name archived:false"
  ];
  const items = [];
  const seen = /* @__PURE__ */ new Set();
  try {
    for (const q of QUERIES.slice(0, Math.max(1, pages))) {
      const { repos } = await searchGithubRepos({ query: q, perPage: 100, ...opts });
      for (const repo of repos) {
        const item = githubItemOf(repo);
        if (!item || seen.has(repo.full_name)) continue;
        seen.add(repo.full_name);
        items.push(item);
      }
    }
  } catch (err) {
    if (err?.code !== "quota") throw err;
    const seconds = Number.isFinite(err.retryAfterMs) ? Math.ceil(err.retryAfterMs / 1e3) : null;
    const rankedSoFar = items.slice().sort((a, b) => (b.stars ?? 0) - (a.stars ?? 0)).slice(0, limit);
    emit({
      kind: "source",
      source: "github-mcp",
      action: "fallback-stopped",
      items: rankedSoFar.length,
      ...seconds !== null ? { waitMs: err.retryAfterMs } : {}
    });
    return {
      items: rankedSoFar,
      note: seconds ? `GitHub \u641C\u7D22\u914D\u989D\u5DF2\u7528\u5B8C\uFF08\u7EA6 ${seconds} \u79D2\u540E\u6062\u590D\uFF09\uFF1B\u672C\u673A\u666E\u67E5\u7D22\u5F15\u5EFA\u597D\u540E\u8FD9\u91CC\u4E0D\u518D\u53D1\u8BF7\u6C42` : "GitHub \u641C\u7D22\u914D\u989D\u5DF2\u7528\u5B8C\uFF1B\u672C\u673A\u666E\u67E5\u7D22\u5F15\u5EFA\u597D\u540E\u8FD9\u91CC\u4E0D\u518D\u53D1\u8BF7\u6C42",
      quota: githubSearchQuota()
    };
  }
  const ranked = items.slice().sort((a, b) => (b.stars ?? 0) - (a.stars ?? 0));
  return { items: ranked.slice(0, limit) };
}
async function fetchAwesomeRemote({ limit = 200, text: injected, ...opts } = {}) {
  const text = injected ?? await fetchFirstText(
    awesomeMirrors("punkpeye", "awesome-remote-mcp-servers", "main", "README.md"),
    opts
  );
  const lines = String(text).split(/\r?\n/);
  const items = [];
  const seen = /* @__PURE__ */ new Set();
  let category = "";
  let pending = null;
  const flush = () => {
    if (!pending) return;
    if (pending.url && !seen.has(pending.url)) {
      seen.add(pending.url);
      items.push({
        id: `remote:${pending.url}`,
        title: pending.title,
        description: clampText(pending.description),
        source: "awesome-remote",
        author: hostOf(pending.url),
        transport: "streamable-http",
        install: { transport: "streamable-http", url: pending.url },
        repository: void 0,
        homepage: pending.homepage,
        category: category || void 0,
        tags: [category, pending.auth === "\u{1F510}" ? "\u9700\u767B\u5F55" : "\u514D\u767B\u5F55"].filter(Boolean),
        // No lifecycle field ships with these rows either. Note that the list
        // itself is the only freshness evidence available for a hosted
        // endpoint: if the URL stops answering, nothing here says so.
        status: void 0,
        deprecated: void 0
      });
    }
    pending = null;
  };
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    const h3 = line.match(/^###\s+(.*)$/);
    if (h3) {
      flush();
      category = stripAnchorTags(h3[1]).replace(/[\u{1F000}-\u{1FAFF}\u{2190}-\u{2BFF}\u{FE0F}\u{200D}]/gu, "").trim();
      continue;
    }
    if (/^##\s/.test(line)) {
      flush();
      category = "";
      continue;
    }
    const bullet = line.match(/^[-*]\s+\[([^\]]+)\]\(([^)\s]+)\)\s+`([^`]+)`/);
    if (bullet) {
      flush();
      pending = { title: bullet[1], homepage: bullet[2], url: bullet[3], description: "", auth: "" };
      const auth = line.match(/(🔓|🔐)/);
      if (auth) pending.auth = auth[1];
      continue;
    }
    if (pending) {
      const m = line.match(/(🔓|🔐)\s*[-–—]\s*(.+)$/);
      if (m) {
        pending.auth = m[1];
        pending.description = m[2];
        continue;
      }
      if (!/^\[?![^\]]*\]?\(/.test(line) && pending.description) {
        pending.description += ` ${line}`;
        continue;
      }
    }
  }
  flush();
  return { items: items.slice(0, limit) };
}
function hostOf(url) {
  try {
    return new URL(String(url ?? "")).hostname.replace(/^www\./, "");
  } catch {
    return void 0;
  }
}
var LEGEND = {
  "\u{1F40D}": "Python",
  "\u{1F4C7}": "TypeScript",
  "\u{1F3CE}\uFE0F": "Go",
  "\u{1F3CE}": "Go",
  "\u{1F980}": "Rust",
  "#\uFE0F\u20E3": "C#",
  "\u2615": "Java",
  "\u{1F30A}": "C/C++",
  "\u{1F48E}": "Ruby",
  "\u2601\uFE0F": "\u4E91\u670D\u52A1",
  "\u2601": "\u4E91\u670D\u52A1",
  "\u{1F3E0}": "\u672C\u5730",
  "\u{1F4DF}": "\u5D4C\u5165\u5F0F",
  "\u{1F34E}": "macOS",
  "\u{1FA9F}": "Windows",
  "\u{1F427}": "Linux",
  "\u{1F396}\uFE0F": "\u5B98\u65B9\u5B9E\u73B0",
  "\u{1F396}": "\u5B98\u65B9\u5B9E\u73B0"
};
function legendTags(text) {
  const found = [];
  for (const [emoji, label] of Object.entries(LEGEND)) {
    if (text.includes(emoji) && !found.includes(label)) found.push(label);
  }
  return found;
}
function firstRealLink(line) {
  const re = /(!?)\[([^\]]*)\]\(([^)\s]+)\)/g;
  let m;
  while ((m = re.exec(line)) !== null) {
    if (m[1] === "!") continue;
    return { text: m[2], url: m[3], index: m.index, length: m[0].length };
  }
  return null;
}
function parseGitHub(url) {
  const m = String(url ?? "").match(/^https?:\/\/(?:www\.)?github\.com\/([^/\s]+)\/([^/\s#?]+)/i);
  if (!m) return null;
  return { owner: m[1], repo: m[2].replace(/\.git$/i, "") };
}
var stripAnchorTags = (s) => String(s).replace(/<a\s+name="[^"]*"\s*><\/a>/gi, "").replace(/<[^>]+>/g, "");
async function fetchAwesomeList({ limit = 200, text: injected, ...opts } = {}) {
  const text = injected ?? await fetchFirstText(
    awesomeMirrors("punkpeye", "awesome-mcp-servers", "main", "README.md"),
    opts
  );
  const items = [];
  const seen = /* @__PURE__ */ new Set();
  let category = "";
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const h3 = line.match(/^###\s+(.*)$/);
    if (h3) {
      category = stripAnchorTags(h3[1]).replace(/[\u{1F000}-\u{1FAFF}\u{2190}-\u{2BFF}\u{FE0F}\u{200D}]/gu, "").trim();
      continue;
    }
    if (/^##\s/.test(line)) {
      category = "";
      continue;
    }
    if (line.startsWith("|")) {
      const cells = line.split("|").map((c) => c.trim()).filter((c) => c !== "");
      if (cells.length < 2) continue;
      const link0 = firstRealLink(cells[0]);
      if (!link0) continue;
      const entry2 = pushAwesome(items, seen, link0, cells.slice(1).join(" "), "", category);
      if (entry2 && items.length >= limit) break;
      continue;
    }
    if (!/^[-*]\s/.test(line)) continue;
    const link = firstRealLink(line);
    if (!link || !/^https?:\/\//i.test(link.url)) continue;
    const rest = line.replace(/!?\[[^\]]*\]\([^)\s]+\)/g, " ").replace(/^[-*]\s*/, "").trim();
    const parts = rest.split(/\s+[-–—]\s+/);
    const flags = parts.length > 1 ? parts[0] : "";
    const description = parts.length > 1 ? parts.slice(1).join(" - ") : rest;
    const entry = pushAwesome(items, seen, link, description, flags, category);
    if (entry && items.length >= limit) break;
  }
  return { items };
}
function pushAwesome(items, seen, link, rawDescription, flags, category) {
  const gh = parseGitHub(link.url);
  const key = (gh ? `${gh.owner}/${gh.repo}` : link.url).toLowerCase();
  if (seen.has(key)) return null;
  const description = clampText(rawDescription);
  if (!description && !gh) return null;
  seen.add(key);
  const legend = legendTags(flags);
  const tags = legend.slice();
  if (category) tags.unshift(category);
  items.push({
    id: `awesome:${key}`,
    title: gh ? gh.repo : link.text.replace(/^@/, ""),
    description,
    source: "awesome-list",
    author: gh?.owner,
    // The `###` heading the row sat under. A first-class field rather than
    // tags[0] so the market's category filter survives tag merging and so the
    // two lists' taxonomies (65 + 40 headings, with synonym drift between
    // them) are shown exactly as the upstreams wrote them.
    category: category || void 0,
    transport: "unknown",
    install: null,
    repository: gh ? `https://github.com/${gh.owner}/${gh.repo}` : link.url,
    homepage: gh ? `https://github.com/${gh.owner}/${gh.repo}` : void 0,
    icon: gh ? `https://github.com/${gh.owner}.png?size=80` : void 0,
    tags: tags.filter(Boolean),
    official: legend.includes("\u5B98\u65B9\u5B9E\u73B0") || void 0,
    stars: void 0,
    // No lifecycle field is published with these rows, so none is invented:
    // `status` stays absent and the UI says "未扫描" rather than "active".
    status: void 0,
    deprecated: void 0
  });
  return items[items.length - 1];
}
async function fetchPulseMcp({ page = 1, ...opts } = {}) {
  const url = `https://api.pulsemcp.com/v0beta/servers?count_per_page=100&offset=${(page - 1) * 100}`;
  const data = await fetchJson2(url, opts);
  const list = data.servers ?? [];
  const items = list.map((s) => ({
    id: `pulsemcp:${s.slug ?? s.name}`,
    title: s.name,
    description: clampText(s.short_description ?? s.description),
    source: "pulsemcp",
    author: parseGitHub(s.source_code_url ?? s.url)?.owner,
    transport: "unknown",
    install: null,
    repository: s.source_code_url ?? s.url,
    homepage: s.url,
    icon: parseGitHub(s.source_code_url ?? "") ? `https://github.com/${parseGitHub(s.source_code_url).owner}.png?size=80` : void 0,
    tags: [],
    raw: s
  })).filter((i) => i.title);
  return { items };
}
var CATALOG_SOURCES = [
  "official-registry",
  "smithery",
  "docker-catalog",
  "github-mcp",
  "awesome-remote",
  "awesome-list"
];
var CENSUS_SOURCE = "census";
function isCustomSourceId(id) {
  return typeof id === "string" && id.startsWith("custom:");
}
function mapCustomEntries(doc, def, { max = 1e3 } = {}) {
  const rows = Array.isArray(doc) ? doc : Array.isArray(doc?.servers) ? doc.servers : Array.isArray(doc?.items) ? doc.items : [];
  const items = [];
  const seen = /* @__PURE__ */ new Set();
  for (const row of rows) {
    if (items.length >= max) break;
    if (!row || typeof row !== "object" || Array.isArray(row)) continue;
    const title = String(row.name ?? row.title ?? "").trim().slice(0, 120);
    if (!title) continue;
    const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || `row-${items.length}`;
    const id = `${def.id}:${slug}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const gh = parseGitHub(row.repository);
    let install = null;
    if (typeof row.command === "string" && row.command.trim()) {
      const command = row.command.trim();
      if (!/\s/.test(command)) {
        install = {
          transport: "stdio",
          command,
          args: Array.isArray(row.args) ? row.args.filter((a) => typeof a === "string").slice(0, 32) : []
        };
      }
    } else if (typeof row.url === "string" && row.url.trim()) {
      install = { transport: "streamable-http", url: row.url.trim() };
    }
    items.push({
      id,
      title,
      description: clampText(row.description),
      source: def.id,
      author: typeof row.author === "string" && row.author ? row.author : gh?.owner,
      transport: install?.transport ?? "unknown",
      install,
      repository: typeof row.repository === "string" && row.repository ? row.repository : void 0,
      homepage: typeof row.homepage === "string" && row.homepage ? row.homepage : void 0,
      icon: gh ? `https://github.com/${gh.owner}.png?size=80` : void 0,
      tags: (Array.isArray(row.tags) ? row.tags : []).filter((t) => typeof t === "string").slice(0, 8),
      category: typeof row.category === "string" && row.category ? row.category : void 0,
      version: typeof row.version === "string" && row.version ? row.version : void 0,
      verified: row.verified === true || void 0,
      official: row.official === true || void 0,
      deprecated: row.deprecated === true || void 0,
      status: void 0,
      raw: row
    });
  }
  return items;
}
async function fetchCustomSource(def, opts = {}) {
  const doc = await fetchJson2(def.url, { ...opts, accept: "application/json" });
  return { items: mapCustomEntries(doc, def) };
}
var SOURCE_BROWSE_CAPS = {
  "official-registry": { pages: 8, items: 800 },
  // 8 pages x 100 records, deduped to servers
  smithery: { pages: 1, items: 10 },
  // the upstream listing caps at 10
  "docker-catalog": { pages: 3, items: 300 },
  // Three search requests (100 rows each) against a 10-per-minute anonymous
  // budget when there is no index yet; every query has tens of thousands of
  // hits, so that path is a slice by design and the three are ranked against
  // each other before the cut. With a local index the cap is the merge's, not
  // the request budget's: the index is filtered by the query *before* this cut,
  // so up to 800 of its rows may enter the listing without costing a request.
  "github-mcp": { pages: 3, items: 800 },
  "awesome-remote": { pages: 1, items: 1e3 },
  "awesome-list": { pages: 1, items: 5e3 }
};
var CUSTOM_BROWSE_CAP = { pages: 1, items: 1e3 };
function runSource(id, { query = "", perSource = 100, customSources = [], ...opts } = {}) {
  const cap = SOURCE_BROWSE_CAPS[id] ?? (isCustomSourceId(id) ? CUSTOM_BROWSE_CAP : { pages: 1, items: perSource });
  if (isCustomSourceId(id)) {
    const def = (customSources ?? []).find((s) => s?.id === id);
    if (!def) return Promise.reject(new Error(`unknown catalog source: ${id}`));
    return fetchCustomSource(def, opts).then((r) => [id, r.items.slice(0, cap.items)]);
  }
  switch (id) {
    case "official-registry":
      return fetchOfficialRegistry({ ...opts, query, limit: 100, pages: cap.pages, dedupe: true }).then((r) => [id, r.items.slice(0, cap.items)]);
    case "smithery":
      return fetchSmithery({ ...opts, query }).then((r) => [id, r.items.slice(0, cap.items)]);
    case "docker-catalog":
      return fetchDockerCatalog({ ...opts, limit: cap.items, pages: cap.pages }).then((r) => [id, r.items, r.note ? { note: r.note } : void 0]);
    case "github-mcp":
      return fetchGithubMcp({ ...opts, query, limit: cap.items, pages: cap.pages }).then((r) => [id, r.items, r.note || r.index ? {
        note: r.note,
        index: r.index,
        dataAt: r.dataAt,
        // Two answers here are about *now* rather than a listing: "a census
        // walk is building this", and the census view's "there is no index
        // yet". Remembering either would freeze an empty market in place for
        // the rest of the TTL, so both are marked and the next read asks again.
        transient: r.walk !== void 0 || r.transient === true
      } : void 0]);
    case "awesome-remote":
      return fetchAwesomeRemote({ ...opts, limit: cap.items }).then((r) => [id, r.items]);
    case "awesome-list":
      return fetchAwesomeList({ ...opts, limit: cap.items }).then((r) => [id, r.items]);
    case "pulsemcp":
      return fetchPulseMcp(opts).then((r) => [id, r.items]);
    default:
      return Promise.reject(new Error(`unknown catalog source: ${id}`));
  }
}
function matchItem(item, query) {
  const q = query.toLowerCase();
  return item.title?.toLowerCase().includes(q) || item.description?.toLowerCase().includes(q) || item.author?.toLowerCase().includes(q) || // The install command is searchable too: "docker run mcp/fetch" should find
  // `fetch`, and an endpoint hostname should find its remote server.
  JSON.stringify(item.install ?? {}).toLowerCase().includes(q) || (item.tags ?? []).some((t) => String(t).toLowerCase().includes(q));
}
function itemScore(item) {
  let score = 0;
  if (item.install) score += 1e3;
  if (item.deprecated) score -= 500;
  if (item.verified) score += 150;
  if (item.official) score += 80;
  if (typeof item.installs === "number") score += Math.min(400, Math.log10(item.installs + 1) * 80);
  if (typeof item.stars === "number") score += Math.min(400, Math.log10(item.stars + 1) * 80);
  if (item.source === "official-registry") score += 30;
  if (item.source === "smithery") score += 20;
  return score;
}
function mergeItems(collected) {
  const byKey = /* @__PURE__ */ new Map();
  for (const item of collected) {
    const gh = parseGitHub(item.repository);
    const key = gh ? `repo:${gh.owner}/${gh.repo}`.toLowerCase() : `id:${item.id}`;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, { ...item, tags: [...item.tags ?? []], sources: [item.source] });
      continue;
    }
    existing.sources = existing.sources.includes(item.source) ? existing.sources : [...existing.sources, item.source];
    if (itemScore(item) > itemScore(existing)) {
      const sources = existing.sources;
      Object.assign(existing, item, { sources, icon: item.icon ?? existing.icon, tags: [...item.tags ?? []] });
    } else {
      if (!existing.icon && item.icon) existing.icon = item.icon;
      if (existing.stars === void 0 && item.stars !== void 0) existing.stars = item.stars;
      if (existing.installs === void 0 && item.installs !== void 0) {
        existing.installs = item.installs;
        existing.installsLabel = item.installsLabel;
        existing.installsWindow = item.installsWindow;
      }
      if (!existing.version && item.version) existing.version = item.version;
      if (!existing.author && item.author) existing.author = item.author;
      if (!existing.description && item.description) existing.description = item.description;
      if (!existing.repository && item.repository) existing.repository = item.repository;
      if (!existing.status && item.status) existing.status = item.status;
      if (existing.deprecated === void 0 && item.deprecated !== void 0) existing.deprecated = item.deprecated;
      if (!existing.statusMessage && item.statusMessage) existing.statusMessage = item.statusMessage;
      if (!existing.category && item.category) existing.category = item.category;
      for (const tag of item.tags ?? []) if (!existing.tags.includes(tag)) existing.tags.push(tag);
    }
  }
  return [...byKey.values()];
}
async function browseCatalog({ query = "", limit = 400, perSource = 100, source = "", customSources = [], cache, force = false, ...opts } = {}) {
  const censusView = source === CENSUS_SOURCE;
  const ids = source ? [censusView ? "github-mcp" : source] : [...CATALOG_SOURCES, ...(customSources ?? []).map((s) => s.id)];
  const settled = await Promise.allSettled(ids.map(async (id) => {
    const key = `${id}|${query}|${perSource}${censusView ? "|census" : ""}`;
    const hit = force ? void 0 : cache?.sourceResult(key);
    if (hit !== void 0) return { items: hit.items, at: hit.at, cached: true, stale: false, notModified: 0, note: hit.note, index: hit.index, dataAt: hit.dataAt };
    const before = cache?.stats().notModified ?? 0;
    try {
      const [, items2, meta] = await runSource(id, { ...opts, query, perSource, cache, customSources, indexOnly: censusView });
      const at = Date.now();
      const notModified = (cache?.stats().notModified ?? 0) - before;
      if (!meta?.transient) {
        cache?.storeSourceResult(key, { items: items2, at, note: meta?.note, index: meta?.index, dataAt: meta?.dataAt });
      }
      return {
        items: items2,
        at,
        cached: false,
        stale: false,
        notModified,
        note: meta?.note,
        index: meta?.index,
        dataAt: meta?.dataAt,
        transient: meta?.transient === true
      };
    } catch (err) {
      const fallback = cache?.sourceResult(key, { fresh: false });
      if (fallback === void 0) throw err;
      return {
        items: fallback.items,
        at: fallback.at,
        cached: true,
        stale: true,
        notModified: 0,
        note: fallback.note,
        index: fallback.index,
        dataAt: fallback.dataAt,
        error: String(err?.message ?? err)
      };
    }
  }));
  const errors = [];
  const counts = {};
  const sources = {};
  const collected = [];
  settled.forEach((result, i) => {
    const sourceId = ids[i];
    if (result.status === "rejected") {
      const message = String(result.reason?.message ?? result.reason);
      errors.push({ source: sourceId, message });
      sources[sourceId] = { error: message };
      emit({ kind: "source", source: sourceId, items: 0, error: message });
      return;
    }
    const { items: items2, at, cached, stale, notModified, error, note, index, dataAt } = result.value;
    counts[sourceId] = items2.length;
    sources[sourceId] = {
      // A source reading a local index reports when its census was walked, not
      // when this listing read the file: the panel's timestamp is about the
      // data, and "just now" over a day-old census would be the wrong claim.
      at: new Date(dataAt ?? at).toISOString(),
      cached: cached === true,
      stale: stale === true,
      notModified,
      items: items2.length
    };
    if (note !== void 0) sources[sourceId].note = note;
    if (index !== void 0) sources[sourceId].index = index;
    if (error !== void 0) {
      sources[sourceId].error = error;
      errors.push({ source: sourceId, message: error, stale: true });
    }
    emit({
      kind: "source",
      source: sourceId,
      items: sources[sourceId].items,
      cached: sources[sourceId].cached,
      stale: sources[sourceId].stale,
      notModified: sources[sourceId].notModified,
      ...sources[sourceId].note !== void 0 ? { note: sources[sourceId].note } : {},
      ...sources[sourceId].index !== void 0 ? { index: sources[sourceId].index } : {},
      ...error !== void 0 ? { error } : {}
    });
    for (const item of items2) {
      if (query && !matchItem(item, query)) continue;
      collected.push(item);
    }
  });
  const officialIconsByEndpoint = /* @__PURE__ */ new Map();
  for (const item of collected) {
    if (item.source === "official-registry" && item.install?.url && item.icon) {
      officialIconsByEndpoint.set(item.install.url, item.icon);
    }
  }
  const merged = mergeItems(collected.map((item) => {
    const icon = !item.icon && officialIconsByEndpoint.get(item.install?.url);
    return icon ? { ...item, icon } : item;
  }));
  const mergedCounts = {};
  for (const item of merged) {
    for (const id of item.sources ?? [item.source]) {
      if (id) mergedCounts[id] = (mergedCounts[id] ?? 0) + 1;
    }
  }
  for (const [id, record] of Object.entries(sources)) {
    if (record && !record.error) {
      if (!(id in mergedCounts)) mergedCounts[id] = 0;
      record.merged = mergedCounts[id];
    }
  }
  const deduped = collected.length - merged.length;
  for (const item of merged) {
    item.group = functionalGroupOf(item);
    item.groupSource = groupSourceOf(item);
  }
  const items = orderItems(merged, source).slice(0, limit);
  return {
    items,
    errors,
    counts,
    mergedCounts,
    deduped,
    total: merged.length,
    sources,
    // Which upstream a view borrowed its rows from (`source: 'census'` →
    // `'github-mcp'`). Absent for a plain source read, so a caller that only ever
    // names real sources sees the payload it always saw.
    ...censusView ? { aliasOf: "github-mcp" } : {}
  };
}
function orderItems(items, sourceFilter) {
  const byScore = (a, b) => itemScore(b) - itemScore(a) || a.title.localeCompare(b.title);
  if (sourceFilter) return items.slice().sort(byScore);
  const buckets = /* @__PURE__ */ new Map();
  for (const item of items) {
    if (!buckets.has(item.source)) buckets.set(item.source, []);
    buckets.get(item.source).push(item);
  }
  const order = CATALOG_SOURCES.filter((id) => buckets.has(id));
  for (const id of buckets.keys()) if (!order.includes(id)) order.push(id);
  const queues = order.map((id) => buckets.get(id).sort(byScore));
  const out = [];
  for (let round = 0; out.length < items.length; round += 1) {
    let progressed = false;
    for (const queue of queues) {
      if (round < queue.length) {
        out.push(queue[round]);
        progressed = true;
      }
    }
    if (!progressed) break;
  }
  return out;
}
async function fetchRepoStats(repos, { fetchImpl = fetch } = {}) {
  const stats = {};
  const errors = [];
  let rateLimited = false;
  let retryAt = null;
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(4, (repos ?? []).length) }, async () => {
    while (cursor < repos.length && !rateLimited) {
      const { key, owner, repo, url } = repos[cursor++];
      try {
        const data = await fetchJson2(`https://api.github.com/repos/${owner}/${repo}`, {
          timeoutMs: 12e3,
          fetchImpl,
          accept: "application/vnd.github+json"
        });
        stats[key] = {
          stars: typeof data.stargazers_count === "number" ? data.stargazers_count : void 0,
          author: data.owner?.login ?? owner,
          avatar: data.owner?.avatar_url,
          description: clampText(data.description, 200) || void 0,
          homepage: data.homepage || url,
          topics: Array.isArray(data.topics) ? data.topics.slice(0, 6) : [],
          pushedAt: data.pushed_at,
          forks: typeof data.forks_count === "number" ? data.forks_count : void 0,
          openIssues: typeof data.open_issues_count === "number" ? data.open_issues_count : void 0,
          watchers: typeof data.subscribers_count === "number" ? data.subscribers_count : void 0,
          language: data.language || void 0,
          license: data.license?.spdx_id && data.license.spdx_id !== "NOASSERTION" ? data.license.spdx_id : void 0,
          archived: data.archived === true || void 0,
          createdAt: data.created_at,
          fetchedAt: (/* @__PURE__ */ new Date()).toISOString()
        };
      } catch (error) {
        const quota = error?.code === "quota" || error?.status === 429;
        if (quota) {
          rateLimited = true;
          retryAt = Math.max(retryAt ?? 0, error.retryAt ?? Date.now() + 6e4);
        }
        errors.push({
          repo: key,
          status: error?.status ?? null,
          rateLimited: quota,
          message: String(error?.message ?? error),
          ...error.retryAt ? { retryAt: error.retryAt } : {}
        });
      }
    }
  }));
  for (const { key } of (repos ?? []).slice(cursor)) errors.push({ repo: key, rateLimited: true, message: "GitHub \u8BBF\u95EE\u9650\u989D\u5DF2\u7528\u5B8C\uFF0C\u672C\u6B21\u672A\u66F4\u65B0" });
  return { ...stats, rateLimited, errors, ...retryAt ? { retryAt } : {} };
}
function proposedNameOf(item) {
  const raw = String(item?.title ?? item?.name ?? "").trim();
  const ascii = raw.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32);
  if (ascii && /[a-z0-9]/.test(ascii)) return ascii;
  if (!raw) return "mcp";
  let hash = 0;
  for (let i = 0; i < raw.length; i += 1) hash = hash * 31 + raw.charCodeAt(i) >>> 0;
  return `mcp-${hash.toString(36).slice(0, 6)}`;
}
function catalogItemToEntry(item) {
  if (!item?.install) return null;
  const name2 = proposedNameOf(item);
  const entry = item.install.transport === "stdio" ? {
    name: name2,
    source: `catalog:${item.source}`,
    transport: "stdio",
    command: item.install.command,
    args: item.install.args ?? [],
    env: {},
    enabled: true
  } : item.install.transport === "streamable-http" && typeof item.install.url === "string" && item.install.url !== "" ? { name: name2, source: `catalog:${item.source}`, transport: "streamable-http", url: item.install.url, headers: {}, enabled: true } : null;
  if (!entry) return null;
  if (typeof item.id === "string" && item.id) entry.catalogId = item.id;
  const icon = publicIcon(item.icon);
  if (icon) entry.icon = icon;
  const iconCandidates = publisherIcons(item.homepage, item.repository);
  if (iconCandidates.length) entry.iconCandidates = iconCandidates;
  const config = configSpecFor(item, entry);
  return config ? { ...entry, config } : entry;
}

// lib/github-index.js
var INDEX_VERSION = 1;
var INDEX_FILE = "github-index.json";
var MIN_STARS = 100;
var PER_PAGE = 100;
var WINDOW_MAX = 1e3;
var WINDOW_PAGES_MAX = WINDOW_MAX / PER_PAGE;
var MAX_WINDOWS = 8;
var MAX_REQUESTS = 48;
var MIN_INTERVAL_MS = 6500;
var INDEX_KEEP_MS = 30 * 24 * 60 * 60 * 1e3;
var INDEX_MAX_ROWS = 2e4;
var INDEX_TTL_MS = 24 * 60 * 60 * 1e3;
var BASE_QUERIES = [
  "mcp in:name archived:false",
  "topic:mcp-server mcp in:description archived:false"
];
function githubWindowQuery(base, { minStars = MIN_STARS, hi = null } = {}) {
  return hi === null ? `${base} stars:>=${minStars}` : `${base} stars:${minStars}..${hi}`;
}
function defaultSleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
async function crawlGithubRepos({
  search = searchGithubRepos,
  bases = BASE_QUERIES,
  minStars = MIN_STARS,
  maxRequests = MAX_REQUESTS,
  minIntervalMs = MIN_INTERVAL_MS,
  maxWindows = MAX_WINDOWS,
  sleep = defaultSleep,
  onProgress,
  signal,
  now = Date.now
} = {}) {
  const started = now();
  const byName = /* @__PURE__ */ new Map();
  const truncations = [];
  let requests = 0;
  let partial = null;
  const exhausted = () => requests >= maxRequests;
  const aborted = () => signal?.aborted === true;
  const ask = async (query, page) => {
    if (requests > 0 && minIntervalMs > 0) await sleep(minIntervalMs);
    if (aborted()) {
      const err = new Error("github index walk aborted");
      err.code = "aborted";
      throw err;
    }
    if (exhausted()) {
      const err = new Error(`github index request budget spent (${maxRequests})`);
      err.code = "budget";
      throw err;
    }
    requests += 1;
    const answer = await search({ query, page, perPage: PER_PAGE });
    onProgress?.({ requests, rows: byName.size, query, page, items: byName });
    return answer;
  };
  const keep = (repos, base, at) => {
    let added = 0;
    for (const repo of repos ?? []) {
      const fullName = String(repo?.full_name ?? "");
      if (!fullName || byName.has(fullName)) continue;
      const item = githubItemOf(repo, { includeRaw: false });
      if (!item) continue;
      byName.set(fullName, { ...item, query: base, lastSeen: at });
      added += 1;
    }
    return added;
  };
  for (const base of bases) {
    if (partial || aborted() || exhausted()) break;
    let hi = null;
    let windows = 0;
    while (windows < maxWindows) {
      windows += 1;
      const query = githubWindowQuery(base, { minStars, hi });
      let first;
      try {
        first = await ask(query, 1);
      } catch (err) {
        if (err?.code === "aborted") return finish(byName, { partial: "\u5DF2\u4E2D\u6B62", requests, started, truncations, now });
        partial = stopReason(err, { maxRequests, requests });
        return finish(byName, { partial, requests, started, truncations, now });
      }
      const total = Number(first?.totalCount ?? 0);
      const at = new Date(now()).toISOString();
      keep(first?.repos, base, at);
      const pages = Math.min(
        total > 0 ? Math.ceil(total / PER_PAGE) : 1,
        WINDOW_PAGES_MAX
      );
      let reached = 1;
      for (let page = 2; page <= pages; page += 1) {
        let answer;
        try {
          answer = await ask(query, page);
        } catch (err) {
          if (err?.code === "aborted") return finish(byName, { partial: "\u5DF2\u4E2D\u6B62", requests, started, truncations, now });
          partial = stopReason(err, { maxRequests, requests });
          return finish(byName, { partial, requests, started, truncations, now });
        }
        reached = page;
        keep(answer?.repos, base, at);
      }
      if (total <= WINDOW_MAX) break;
      const window = [...byName.values()].filter((row) => row.query === base);
      const minSeen = window.reduce((min, row) => typeof row.stars === "number" && row.stars < min ? row.stars : min, Infinity);
      if (!(minSeen > minStars)) {
        truncations.push({ query: base, reason: `stars:${minStars} \u5904\u6709\u8D85\u8FC7 ${WINDOW_MAX} \u4E2A\u4ED3\u5E93\uFF0C\u540C\u4E00 Star \u503C\u65E0\u6CD5\u7EE7\u7EED\u6536\u7A84` });
        break;
      }
      if (reached < pages) {
        truncations.push({ query: base, reason: `\u7A97\u53E3\u53EA\u53D6\u5230\u7B2C ${reached} \u9875` });
      }
      hi = minSeen;
    }
    if (windows >= maxWindows) truncations.push({ query: base, reason: `\u7A97\u53E3\u6570\u4E0A\u9650 ${maxWindows}` });
  }
  return finish(byName, { partial, requests, started, truncations, now });
}
function stopReason(err, { maxRequests, requests }) {
  if (err?.code === "quota") {
    const seconds = Number.isFinite(err.retryAfterMs) ? Math.ceil(err.retryAfterMs / 1e3) : null;
    return seconds ? `GitHub \u641C\u7D22\u914D\u989D\u5DF2\u7528\u5B8C\uFF08\u7EA6 ${seconds} \u79D2\u540E\u6062\u590D\uFF09\uFF0C\u4E0B\u6B21\u7EE7\u7EED` : "GitHub \u641C\u7D22\u914D\u989D\u5DF2\u7528\u5B8C\uFF0C\u4E0B\u6B21\u7EE7\u7EED";
  }
  if (err?.code === "budget") return `\u8BF7\u6C42\u9884\u7B97\u7528\u5B8C\uFF08${maxRequests} \u6B21\uFF09\uFF0C\u672A\u8D70\u5B8C`;
  return `\u7B2C ${requests} \u6B21\u8BF7\u6C42\u5931\u8D25\uFF1A${String(err?.message ?? err)}`;
}
function finish(byName, { partial, requests, started, truncations, now }) {
  const rows = [...byName.values()].sort((a, b) => (b.stars ?? 0) - (a.stars ?? 0));
  return {
    rows,
    requests,
    at: new Date(now()).toISOString(),
    tookMs: Math.max(0, now() - started),
    complete: !partial && truncations.length === 0,
    partial,
    truncations
  };
}
function mergeIndexRows(previous, fresh, { at = (/* @__PURE__ */ new Date()).toISOString(), keepMs = INDEX_KEEP_MS, maxRows = INDEX_MAX_ROWS, now = Date.now } = {}) {
  const merged = /* @__PURE__ */ new Map();
  const cutoff = now() - keepMs;
  for (const row of previous ?? []) {
    const name2 = String(row?.id ?? "");
    if (!name2) continue;
    const seen = Date.parse(row.lastSeen ?? "") || 0;
    if (seen && seen < cutoff) continue;
    merged.set(name2, row);
  }
  for (const row of fresh ?? []) {
    const name2 = String(row?.id ?? "");
    if (!name2) continue;
    const held = merged.get(name2);
    merged.set(name2, { ...row, firstSeen: held?.firstSeen ?? row.firstSeen ?? at, lastSeen: at });
  }
  const rows = [...merged.values()].sort((a, b) => (b.stars ?? 0) - (a.stars ?? 0));
  return rows.slice(0, maxRows);
}
function normalizeIndexDocument(raw) {
  const rows = Array.isArray(raw) ? raw : Array.isArray(raw?.rows) ? raw.rows : [];
  const clean2 = [];
  const seen = /* @__PURE__ */ new Set();
  for (const row of rows) {
    const id = String(row?.id ?? "");
    if (!id.startsWith("github:") || seen.has(id)) continue;
    seen.add(id);
    clean2.push({ ...row, id });
  }
  return {
    version: INDEX_VERSION,
    at: typeof raw?.at === "string" ? raw.at : null,
    minStars: Number.isFinite(raw?.minStars) ? raw.minStars : MIN_STARS,
    queries: Array.isArray(raw?.queries) ? raw.queries.filter((q) => typeof q === "string") : [...BASE_QUERIES],
    requests: Number.isFinite(raw?.requests) ? raw.requests : void 0,
    complete: raw?.complete === true,
    partial: typeof raw?.partial === "string" ? raw.partial : null,
    rows: clean2
  };
}
function indexDocumentOf(doc) {
  const normalized = normalizeIndexDocument(doc);
  return {
    version: INDEX_VERSION,
    at: normalized.at,
    minStars: normalized.minStars,
    queries: normalized.queries,
    requests: normalized.requests,
    complete: normalized.complete,
    partial: normalized.partial,
    rows: normalized.rows
  };
}
async function readIndexDocument(file, readFileImpl) {
  let raw;
  try {
    raw = await readFileImpl(file, "utf8");
  } catch (err) {
    if (err?.code === "ENOENT") return { doc: null, damaged: null };
    return { doc: null, damaged: String(err?.message ?? err) };
  }
  try {
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object") return { doc: null, damaged: "JSON \u9876\u5C42\u4E0D\u662F\u5BF9\u8C61" };
    const doc = normalizeIndexDocument(parsed);
    return { doc: doc.rows.length ? doc : null, damaged: null };
  } catch (err) {
    return { doc: null, damaged: String(err?.message ?? err) };
  }
}
function indexFreshness(doc, { now = Date.now, ttlMs = INDEX_TTL_MS } = {}) {
  const at = typeof doc?.at === "string" ? Date.parse(doc.at) : NaN;
  if (!Number.isFinite(at)) return { at: null, ageMs: null, stale: true };
  const ageMs = Math.max(0, now() - at);
  return { at: doc.at, ageMs, stale: ageMs > ttlMs };
}
function needsGithubCrawl(doc, { force = false, ...freshness } = {}) {
  if (force) return true;
  if (!doc?.rows?.length) return true;
  return indexFreshness(doc, freshness).stale;
}

// lib/repo-install.js
var EVIDENCE_VERSION = 1;
var EVIDENCE_FILE = "install-evidence.json";
var EVIDENCE_PATH = "HEAD";
var REPO_FILES = ["server.json", "package.json", "pyproject.toml", "README.md"];
var MAX_REQUESTS2 = 6e3;
var MIN_INTERVAL_MS2 = 150;
var MAX_WALK_MS = 25 * 60 * 1e3;
var MAX_ATTEMPTS = 3;
var BACKOFF_MS = 400;
var MAX_BACKOFF_MS = 5e3;
var MAX_REFUSALS = 3;
var RETRY_NONE_MS = 14 * 24 * 60 * 60 * 1e3;
var REFRESH_PLAN_MS = 30 * 24 * 60 * 60 * 1e3;
var EVIDENCE_KEEP_MS = 90 * 24 * 60 * 60 * 1e3;
var EVIDENCE_MAX_ROWS = 2e4;
var NPM_NAME = /^(?:@[a-z0-9-_.]+\/)?[a-z0-9-_.]+$/i;
var NOT_A_PACKAGE = /* @__PURE__ */ new Set(["install", "i", "init", "create", "run", "exec", "test", "update", "add", "-y", "--yes", "--package", "-p"]);
function clampText2(value, max = 500) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text.length > max ? text.slice(0, max) : text;
}
function npmInstall(name2) {
  return { transport: "stdio", command: "npx", args: ["-y", String(name2)] };
}
function pypiInstall(name2) {
  return { transport: "stdio", command: "uvx", args: [String(name2)] };
}
function packageJsonPlan(text) {
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }
  const name2 = typeof json?.name === "string" ? json.name.trim() : "";
  if (!name2 || !NPM_NAME.test(name2)) return null;
  if (json.private === true) return { name: name2, rejected: "\u4ED3\u5E93\u58F0\u660E\u8FD9\u662F\u79C1\u6709\u5305\uFF08private: true\uFF09\uFF0C\u6CA1\u6709\u53D1\u5E03\u5230 npm" };
  const bin = json.bin;
  const hasBin = typeof bin === "string" ? Boolean(bin) : Boolean(bin && typeof bin === "object" && Object.keys(bin).length);
  const mcpName = typeof json.mcpName === "string" ? json.mcpName.trim() : "";
  if (!hasBin && !mcpName) return { name: name2, rejected: "package.json \u91CC\u6CA1\u6709 bin\uFF08npx \u6CA1\u6709\u53EF\u6267\u884C\u5165\u53E3\uFF09" };
  return { name: name2, registry: "npm", install: npmInstall(name2), kind: "package.json", mcpName: mcpName || void 0 };
}
function pyprojectPlan(text) {
  const source = String(text ?? "");
  const sectionText = (header) => {
    const found = source.match(new RegExp(`^${header}\\s*$`, "m"));
    if (!found) return "";
    const rest = source.slice(found.index + found[0].length);
    const end = rest.search(/^\[[^\]]+\]\s*$/m);
    return end < 0 ? rest : rest.slice(0, end);
  };
  const pickName = () => {
    for (const header of ["\\[project\\]", "\\[tool\\.poetry\\]"]) {
      const body = sectionText(header);
      const match = body.match(/^\s*name\s*=\s*["']([^"']+)["']/m);
      const name3 = match?.[1]?.trim();
      if (name3 && NPM_NAME.test(name3)) return name3;
    }
    return null;
  };
  const pickScript = () => {
    for (const header of ["\\[project\\.scripts\\]", "\\[tool\\.poetry\\.scripts\\]"]) {
      const body = sectionText(header);
      const match = body.match(/^\s*([A-Za-z0-9_.-]+)\s*=\s*["']/m);
      if (match?.[1]) return match[1];
    }
    return null;
  };
  const name2 = pickName();
  if (!name2) return null;
  const script = pickScript();
  const install = script && script !== name2 ? { transport: "stdio", command: "uvx", args: ["--from", name2, script] } : pypiInstall(name2);
  return { name: name2, registry: "pypi", install, kind: "pyproject.toml", script: script || void 0 };
}
function serverJsonPlan(text) {
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }
  const packages = Array.isArray(json?.packages) ? json.packages : [];
  const pkg = packages.find((p) => (p?.registry_type ?? p?.registryType) === "npm") ?? packages.find((p) => (p?.registry_type ?? p?.registryType) === "pypi");
  const identifier = String(pkg?.identifier ?? pkg?.name ?? "").trim();
  const registry = pkg?.registry_type ?? pkg?.registryType ?? null;
  if (identifier && NPM_NAME.test(identifier)) {
    return {
      name: identifier,
      registry,
      install: registry === "npm" ? npmInstall(identifier) : pypiInstall(identifier),
      kind: "server.json"
    };
  }
  const remote = Array.isArray(json?.remotes) ? json.remotes[0] : null;
  if (typeof remote?.url === "string" && remote.url) {
    return {
      name: null,
      registry: null,
      install: { transport: "streamable-http", url: remote.url },
      kind: "server.json"
    };
  }
  return null;
}
function installPlanFromFiles({ serverJson, packageJson, pyproject } = {}) {
  let rejection = null;
  for (const [text, parse] of [[serverJson, serverJsonPlan], [packageJson, packageJsonPlan], [pyproject, pyprojectPlan]]) {
    if (typeof text !== "string" || !text.trim()) continue;
    const plan = parse(text);
    if (plan?.install) return plan;
    if (plan?.rejected && !rejection) rejection = plan.rejected;
  }
  return rejection ? { install: null, kind: null, rejected: rejection } : null;
}
function readmeCommands(text) {
  const source = String(text ?? "");
  const out = [];
  const seen = /* @__PURE__ */ new Set();
  const push = (registry, name2, install) => {
    const clean2 = String(name2 ?? "").replace(/[),.;:`'"]+$/, "");
    if (!clean2 || !NPM_NAME.test(clean2) || NOT_A_PACKAGE.has(clean2.toLowerCase())) return;
    const key = `${registry}:${clean2}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({
      registry,
      name: clean2,
      install: install ?? (registry === "npm" ? npmInstall(clean2) : pypiInstall(clean2)),
      kind: "readme"
    });
  };
  const VALUE_FLAGS = /* @__PURE__ */ new Set([
    "--transport",
    "--port",
    "--host",
    "--root",
    "--dir",
    "--data-dir",
    "--config",
    "--config-path",
    "--env",
    "--log-level",
    "--type",
    "--mode",
    "--timeout"
  ]);
  const tailOf = (index) => {
    const line = source.slice(index).split(/\r?\n|`/)[0];
    const kept = [];
    for (const token of line.trim().split(/\s+/).filter(Boolean)) {
      if (/^[|&;<>]/.test(token)) break;
      if (/^--?[A-Za-z]/.test(token)) {
        kept.push(token);
      } else if (VALUE_FLAGS.has(kept[kept.length - 1]) && /^[A-Za-z0-9_./:-]+$/.test(token)) {
        kept.push(token);
      } else {
        break;
      }
      if (kept.length >= 8) break;
    }
    return kept;
  };
  for (const match of source.matchAll(/\bnpx\s+(?:(?:-y|--yes)\s+)?((?:@[a-z0-9-_.]+\/)?[a-z0-9-_.]+)/gi)) {
    const name2 = match[1];
    const tail = tailOf(match.index + match[0].length);
    push("npm", name2, { transport: "stdio", command: "npx", args: ["-y", name2, ...tail] });
  }
  for (const match of source.matchAll(/\buvx\s+(?:--from\s+([A-Za-z0-9_.-]+)\s+([A-Za-z0-9_.-]+)|([A-Za-z0-9_.-]+))/gi)) {
    const from = match[1];
    const script = match[2];
    const plain = match[3];
    const tail = tailOf(match.index + match[0].length);
    if (from && script) {
      push("pypi", from, { transport: "stdio", command: "uvx", args: ["--from", from, script, ...tail] });
    } else if (plain) {
      push("pypi", plain, { transport: "stdio", command: "uvx", args: [plain, ...tail] });
    }
  }
  return out;
}
function evidenceRowOf(id, plan, { at }) {
  return {
    id,
    at,
    kind: plan?.kind ?? "none",
    registry: plan?.registry ?? null,
    name: plan?.name ?? null,
    install: plan?.install ?? null,
    reason: plan?.install ? null : clampText2(plan?.rejected ?? "\u4ED3\u5E93\u91CC\u6CA1\u6709\u53EF\u8BC6\u522B\u7684\u6E05\u5355\u6587\u4EF6\uFF08server.json / package.json / pyproject.toml / README\uFF09", 200)
  };
}
function mergeInstallEvidence(previous, fresh, { at = (/* @__PURE__ */ new Date()).toISOString(), keepMs = EVIDENCE_KEEP_MS, maxRows = EVIDENCE_MAX_ROWS, now = Date.now } = {}) {
  const merged = /* @__PURE__ */ new Map();
  const cutoff = now() - keepMs;
  for (const row of previous ?? []) {
    const id = String(row?.id ?? "");
    if (!id) continue;
    const seen = Date.parse(row.at ?? "") || 0;
    if (seen && seen < cutoff) continue;
    merged.set(id, row);
  }
  for (const row of fresh ?? []) {
    const id = String(row?.id ?? "");
    if (!id) continue;
    merged.set(id, { ...row, firstSeen: merged.get(id)?.firstSeen ?? row.firstSeen ?? at });
  }
  return [...merged.values()].slice(0, maxRows);
}
function normalizeEvidenceDocument(raw) {
  const rows = Array.isArray(raw?.rows) ? raw.rows.filter((row) => row && typeof row.id === "string") : [];
  return {
    version: EVIDENCE_VERSION,
    at: typeof raw?.at === "string" ? raw.at : null,
    requests: Number.isFinite(raw?.requests) ? raw.requests : 0,
    partial: typeof raw?.partial === "string" ? raw.partial : null,
    rows
  };
}
function evidenceDocumentOf({ at, rows, requests = 0, partial = null }) {
  return { version: EVIDENCE_VERSION, at, rows, requests, partial };
}
async function readEvidenceDocument(file, readFileImpl) {
  let text;
  try {
    text = await readFileImpl(file, "utf8");
  } catch (err) {
    if (err?.code === "ENOENT") return { doc: null, damaged: null };
    return { doc: null, damaged: `install evidence unreadable: ${String(err?.message ?? err)}` };
  }
  try {
    const doc = normalizeEvidenceDocument(JSON.parse(text));
    return { doc: doc.rows.length ? doc : null, damaged: null };
  } catch (err) {
    return { doc: null, damaged: `install evidence damaged: ${String(err?.message ?? err)}` };
  }
}
function needsInstallEvidence(row, evidence, { now = Date.now, retryNoneMs = RETRY_NONE_MS, refreshPlanMs = REFRESH_PLAN_MS } = {}) {
  if (!row?.id) return false;
  if (!evidence) return true;
  const checked = Date.parse(evidence.at ?? "") || 0;
  if (!checked) return true;
  if (evidence.install) return now() - checked > refreshPlanMs;
  return now() - checked > retryNoneMs;
}
function applyInstallEvidence(item, evidence) {
  if (!item || !evidence?.install) return item;
  return {
    ...item,
    transport: evidence.install.transport,
    install: evidence.install,
    // The sentence is computed here rather than in the panel: the panel is a
    // browser bundle and cannot import this module, and the one thing the reader
    // must not lose is *where the command came from*.
    installSource: {
      kind: evidence.kind,
      registry: evidence.registry ?? null,
      name: evidence.name ?? null,
      at: evidence.at ?? null,
      text: describeInstallSource(evidence)
    }
  };
}
function describeInstallSource(evidence) {
  if (!evidence?.install) return "";
  const registry = evidence.registry === "npm" ? "npm" : evidence.registry === "pypi" ? "PyPI" : null;
  switch (evidence.kind) {
    case "server.json":
      return registry ? `\u547D\u4EE4\u6765\u81EA\u4ED3\u5E93 server.json\uFF0C\u4F5C\u8005\u81EA\u5DF1\u58F0\u660E\uFF1B${registry} \u4E0A\u5DF2\u786E\u8BA4\u8FD9\u4E2A\u5305\u5B58\u5728` : "\u547D\u4EE4\u6765\u81EA\u4ED3\u5E93 server.json\uFF0C\u4F5C\u8005\u81EA\u5DF1\u58F0\u660E";
    case "package.json":
      return "\u547D\u4EE4\u6765\u81EA\u4ED3\u5E93 package.json\uFF1Bnpm \u4E0A\u5DF2\u786E\u8BA4\u8FD9\u4E2A\u5305\u5B58\u5728";
    case "pyproject.toml":
      return "\u547D\u4EE4\u6765\u81EA\u4ED3\u5E93 pyproject.toml\uFF1BPyPI \u4E0A\u5DF2\u786E\u8BA4\u8FD9\u4E2A\u5305\u5B58\u5728";
    case "readme":
      return registry ? `\u547D\u4EE4\u6765\u81EA\u4ED3\u5E93 README \u91CC\u4F5C\u8005\u81EA\u5DF1\u5199\u7684\u547D\u4EE4\uFF1B${registry} \u4E0A\u5DF2\u786E\u8BA4\u8FD9\u4E2A\u5305\u5B58\u5728` : "\u547D\u4EE4\u6765\u81EA\u4ED3\u5E93 README \u91CC\u4F5C\u8005\u81EA\u5DF1\u5199\u7684\u547D\u4EE4";
    default:
      return "\u547D\u4EE4\u6765\u81EA\u4ED3\u5E93\u8BC1\u636E";
  }
}
async function crawlInstallEvidence({
  rows = [],
  previous = [],
  fetchText,
  verifyPackage,
  rawBase = "https://raw.githubusercontent.com",
  maxRequests = MAX_REQUESTS2,
  minIntervalMs = MIN_INTERVAL_MS2,
  maxMs = MAX_WALK_MS,
  maxAttempts = MAX_ATTEMPTS,
  backoffMs = BACKOFF_MS,
  maxBackoffMs = MAX_BACKOFF_MS,
  maxRefusals = MAX_REFUSALS,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  signal,
  now = Date.now,
  onProgress
} = {}) {
  const fresh = [];
  const spent = { requests: 0 };
  const retried = { count: 0 };
  let refusals = 0;
  let partial = null;
  const startedAt = now();
  const planned = rows.filter((row) => row?.id && row?.repository).length;
  let attempted = 0;
  const aborted = () => signal?.aborted === true;
  const exhausted = () => spent.requests >= maxRequests;
  const overDeadline = () => maxMs > 0 && now() - startedAt >= maxMs;
  const deadlineNote = () => `\u672C\u6B21\u65F6\u95F4\u7528\u5B8C\uFF08\u7EA6 ${Math.round(maxMs / 6e4)} \u5206\u949F\uFF09\uFF0C\u4E0B\u6B21\u7EE7\u7EED`;
  const budgetNote = () => `\u8BF7\u6C42\u9884\u7B97\u7528\u5B8C\uFF08${maxRequests} \u6B21\uFF09\uFF0C\u4E0B\u6B21\u7EE7\u7EED`;
  const retryNote = () => retried.count > 0 ? `\uFF08\u91CD\u8BD5 ${retried.count} \u6B21\u4ECD\u5931\u8D25\uFF09` : "";
  const stopNote = (err) => {
    if (err?.code === "aborted") return "\u5DF2\u4E2D\u6B62";
    if (err?.code === "deadline") return deadlineNote();
    if (err?.code === "budget") return budgetNote();
    if (err?.code === "refused") return `\u4E0A\u6E38\u8981\u6C42\u964D\u901F\uFF1A${String(err.message ?? err)}${retryNote()}`;
    return `\u7B2C ${spent.requests} \u6B21\u8BF7\u6C42\u5931\u8D25\uFF1A${String(err?.message ?? err)}${retryNote()}`;
  };
  const pacing = { extraMs: 0 };
  const pace = async () => {
    const wait = Math.max(0, minIntervalMs) + pacing.extraMs;
    if (wait > 0) await sleep(wait);
  };
  const ease = () => {
    if (pacing.extraMs > 0) pacing.extraMs = Math.floor(pacing.extraMs / 2);
  };
  const harden = () => {
    const start = Math.max(0, backoffMs);
    pacing.extraMs = Math.min(pacing.extraMs > 0 ? pacing.extraMs * 2 : start, Math.max(0, maxBackoffMs));
  };
  const retryable = (err) => err?.code === "network" || err?.code === "upstream" || err?.code === "refused";
  const canRetry = (tries) => tries < maxAttempts && refusals < maxRefusals && !aborted() && !exhausted() && !overDeadline();
  const readOnce = async (url) => {
    if (spent.requests > 0) await pace();
    if (aborted()) {
      const err = new Error("install evidence walk aborted");
      err.code = "aborted";
      throw err;
    }
    if (exhausted()) {
      const err = new Error(`install evidence request budget spent (${maxRequests})`);
      err.code = "budget";
      throw err;
    }
    if (overDeadline()) {
      const err = new Error(`install evidence walk deadline reached (${maxMs}ms)`);
      err.code = "deadline";
      throw err;
    }
    spent.requests += 1;
    return fetchText(url, { signal });
  };
  const patient = async (send) => {
    for (let tries = 1; ; tries += 1) {
      try {
        const value = await send();
        refusals = 0;
        ease();
        return value;
      } catch (err) {
        if (!retryable(err)) throw err;
        if (err.code === "refused") refusals += 1;
        harden();
        if (!canRetry(tries)) throw err;
        retried.count += 1;
      }
    }
  };
  const read = (url) => patient(() => readOnce(url));
  const confirm = async (plan) => {
    if (!plan?.install) return null;
    if (!plan.registry) return plan;
    const verifyOnce = async () => {
      if (spent.requests > 0) await pace();
      if (aborted()) {
        const err = new Error("install evidence walk aborted");
        err.code = "aborted";
        throw err;
      }
      if (exhausted()) {
        const err = new Error(`install evidence request budget spent (${maxRequests})`);
        err.code = "budget";
        throw err;
      }
      if (overDeadline()) {
        const err = new Error(`install evidence walk deadline reached (${maxMs}ms)`);
        err.code = "deadline";
        throw err;
      }
      spent.requests += 1;
      return verifyPackage({ registry: plan.registry, name: plan.name, signal });
    };
    const ok = await patient(verifyOnce);
    return ok ? plan : { ...plan, install: null, rejected: `${plan.registry === "npm" ? "npm" : "PyPI"} \u4E0A\u6CA1\u6709\u8FD9\u4E2A\u5305\uFF08${plan.name}\uFF09` };
  };
  const progressOf = (id, kind) => ({ id, kind, requests: spent.requests, attempted, planned });
  for (const row of rows) {
    if (aborted() || exhausted() || overDeadline()) break;
    const id = String(row?.id ?? "");
    const repository = String(row?.repository ?? "");
    if (!id || !repository) continue;
    attempted += 1;
    const files = {};
    const slug = repository.replace(/^https?:\/\/github\.com\//, "");
    let plan = null;
    let rejection = null;
    try {
      for (const name2 of REPO_FILES) {
        const text = await read(`${rawBase}/${slug}/${EVIDENCE_PATH}/${name2}`);
        files[name2] = text;
        if (name2 === "README.md" || typeof text !== "string" || !text.trim()) continue;
        const candidate = installPlanFromFiles({
          serverJson: name2 === "server.json" ? text : void 0,
          packageJson: name2 === "package.json" ? text : void 0,
          pyproject: name2 === "pyproject.toml" ? text : void 0
        });
        if (candidate?.install) {
          plan = candidate;
          break;
        }
        if (candidate?.rejected && !rejection) rejection = candidate.rejected;
      }
      if (plan) {
        fresh.push(evidenceRowOf(id, await confirm(plan), { at: new Date(now()).toISOString() }));
        onProgress?.(progressOf(id, plan.kind));
        continue;
      }
    } catch (err) {
      partial = stopNote(err);
      break;
    }
    if (typeof files["README.md"] === "string" && files["README.md"].trim()) {
      let settled = null;
      let failure = null;
      for (const candidate of readmeCommands(files["README.md"])) {
        let confirmed;
        try {
          confirmed = await confirm(candidate);
        } catch (err) {
          failure = err;
          break;
        }
        if (confirmed?.install) {
          settled = confirmed;
          break;
        }
      }
      if (failure) {
        partial = partial ?? stopNote(failure);
        break;
      }
      if (settled) {
        fresh.push(evidenceRowOf(id, settled, { at: new Date(now()).toISOString() }));
        onProgress?.(progressOf(id, "readme"));
      } else {
        fresh.push(evidenceRowOf(id, rejection ? { install: null, rejected: rejection } : null, { at: new Date(now()).toISOString() }));
        onProgress?.(progressOf(id, "none"));
      }
      continue;
    }
    fresh.push(evidenceRowOf(id, rejection ? { install: null, rejected: rejection } : null, { at: new Date(now()).toISOString() }));
    onProgress?.(progressOf(id, "none"));
  }
  const at = new Date(now()).toISOString();
  if (!partial && exhausted()) partial = budgetNote();
  if (!partial && overDeadline()) partial = deadlineNote();
  if (!partial && aborted()) partial = "\u5DF2\u4E2D\u6B62";
  return {
    rows: mergeInstallEvidence(previous, fresh, { at, now }),
    checked: fresh.length,
    requests: spent.requests,
    // `requests` counts retries and confirmations; `checked` counts repositories
    // that produced evidence. The caller shows both, because "6000 requests for
    // 1500 repositories" is only alarming until you see it is 4 per row.
    retries: retried.count,
    planned,
    attempted,
    remaining: Math.max(0, planned - attempted),
    at,
    partial,
    complete: !partial
  };
}

// lib/catalog-cache.js
var DEFAULT_SOURCE_TTL_MS = 60 * 1e3;
var DEFAULT_MAX_URLS = 64;
var DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
function sizeOf(body) {
  if (typeof body === "string") return body.length;
  try {
    return JSON.stringify(body ?? null)?.length ?? 0;
  } catch {
    return DEFAULT_MAX_BYTES;
  }
}
function createCatalogCache({
  sourceTtlMs = DEFAULT_SOURCE_TTL_MS,
  maxUrls = DEFAULT_MAX_URLS,
  maxBytes = DEFAULT_MAX_BYTES,
  now = Date.now
} = {}) {
  const urls = /* @__PURE__ */ new Map();
  const sources = /* @__PURE__ */ new Map();
  const counters = { requests: 0, notModified: 0, downloaded: 0, saved: 0 };
  let heldBytes = 0;
  function evict() {
    while (urls.size > maxUrls || heldBytes > maxBytes) {
      let oldestKey;
      let oldestAt = Infinity;
      for (const [key, entry] of urls) {
        if (entry.at < oldestAt) {
          oldestAt = entry.at;
          oldestKey = key;
        }
      }
      if (oldestKey === void 0) return;
      heldBytes -= urls.get(oldestKey).bytes;
      urls.delete(oldestKey);
    }
  }
  return {
    sourceTtlMs,
    /** The validator to send as `if-none-match`, when we have one for this URL. */
    etagFor(url) {
      return urls.get(url)?.etag;
    },
    /** The body a 304 for this URL would stand for, or undefined. */
    rememberedBody(url) {
      return urls.get(url)?.body;
    },
    /** Count a request we are about to make (the panel reports what it cost). */
    noteRequest() {
      counters.requests += 1;
    },
    /** Count bytes handed back by a 200. */
    noteDownload(bytes) {
      counters.downloaded += bytes;
    },
    /** Remember a 200 answer: its validator (when the server sent one) and body. */
    remember(url, { etag, body, bytes = sizeOf(body) } = {}) {
      const previous = urls.get(url);
      if (previous) heldBytes -= previous.bytes;
      urls.delete(url);
      urls.set(url, {
        etag: typeof etag === "string" && etag ? etag : void 0,
        body,
        bytes,
        at: now(),
        reused: previous?.reused ?? 0
      });
      heldBytes += bytes;
      evict();
    },
    /**
     * Use the remembered body for a 304: it is served again, so it counts as
     * recently used, and what it saved is the point of the whole exercise.
     */
    reuse(url) {
      const entry = urls.get(url);
      if (entry === void 0) return void 0;
      entry.at = now();
      entry.reused += 1;
      counters.notModified += 1;
      counters.saved += entry.bytes;
      return entry.body;
    },
    /**
     * A source's remembered result. `fresh: true` (the normal read) refuses an
     * entry past the TTL; `fresh: false` (a failed walk) takes any age, because
     * yesterday's listing beats an empty market.
     */
    sourceResult(key, { fresh = true } = {}) {
      const entry = sources.get(key);
      if (entry === void 0) return void 0;
      if (fresh && now() - entry.at >= sourceTtlMs) return void 0;
      entry.hits += 1;
      return entry;
    },
    /** Remember one source walk's items. */
    storeSourceResult(key, { items, at = now(), note, index, dataAt } = {}) {
      sources.set(key, { items, at, note, index, dataAt, hits: 0 });
    },
    /**
     * Drop every remembered result of one source (all queries). Called when a
     * user removes a source: its rows must not come back from a TTL entry, and
     * they must not be reachable as the "stale" fallback of a source that is no
     * longer configured. The URL layer is left alone: it is keyed by address and
     * ages out on its own, and a removed address is simply never asked again.
     */
    forgetSourceId(id) {
      const prefix = `${id}|`;
      let dropped = 0;
      for (const key of [...sources.keys()]) {
        if (key.startsWith(prefix)) {
          sources.delete(key);
          dropped += 1;
        }
      }
      return dropped;
    },
    /** Counters for the panel and the exported log. */
    stats() {
      return { ...counters, urls: urls.size, bytesHeld: heldBytes, sources: sources.size };
    }
  };
}

// lib/custom-sources.js
var SOURCES_VERSION = 1;
var SOURCES_MAX = 8;
var LABEL_MAX = 40;
var URL_MAX = 600;
var ID_MAX = 48;
function emptySources() {
  return { version: SOURCES_VERSION, sources: [] };
}
function normalizeSourcesDocument(raw) {
  const doc = emptySources();
  const rows = Array.isArray(raw) ? raw : Array.isArray(raw?.sources) ? raw.sources : [];
  const seen = /* @__PURE__ */ new Set();
  for (const row of rows) {
    if (doc.sources.length >= SOURCES_MAX) break;
    const typed = typeof row?.url === "string" ? row.url.trim() : "";
    if (!typed) continue;
    const vetted = normalizeSourceUrl(typed);
    if (vetted.error) continue;
    const url = vetted.url;
    const id = typeof row?.id === "string" && row.id.startsWith("custom:") ? row.id : sourceIdFor(url);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const label = typeof row?.label === "string" && row.label.trim() ? row.label.trim().slice(0, LABEL_MAX) : defaultLabelFor(url);
    doc.sources.push({ id, label, url });
  }
  return doc;
}
async function readSourcesDocument(file, readFileImpl) {
  let raw;
  try {
    raw = await readFileImpl(file, "utf8");
  } catch (err) {
    if (err?.code === "ENOENT") return { sources: [], damaged: null };
    return { sources: [], damaged: String(err?.message ?? err) };
  }
  try {
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object") return { sources: [], damaged: "JSON \u9876\u5C42\u4E0D\u662F\u5BF9\u8C61\u6216\u6570\u7EC4" };
    return { sources: normalizeSourcesDocument(parsed).sources, damaged: null };
  } catch (err) {
    return { sources: [], damaged: String(err?.message ?? err) };
  }
}
function sourcesDocumentOf(sources) {
  const rows = Array.isArray(sources) ? sources : Array.isArray(sources?.sources) ? sources.sources : [];
  return { version: SOURCES_VERSION, sources: rows.map((s) => ({ id: s.id, label: s.label, url: s.url })) };
}
function normalizeSourceUrl(raw) {
  if (typeof raw !== "string") return { error: "\u5730\u5740\u5FC5\u987B\u662F\u5B57\u7B26\u4E32", status: 400 };
  const text = raw.trim();
  if (!text) return { error: "\u5730\u5740\u4E0D\u80FD\u4E3A\u7A7A", status: 400 };
  if (text.length > URL_MAX) return { error: `\u5730\u5740\u8FC7\u957F\uFF08\u4E0A\u9650 ${URL_MAX} \u5B57\u7B26\uFF09`, status: 400 };
  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    return { error: "\u4E0D\u662F\u4E00\u4E2A\u5408\u6CD5\u7684 URL\uFF08\u9700\u8981 http(s)://\u2026\uFF09", status: 400 };
  }
  if (parsed.protocol !== "https:") {
    return { error: `\u53EA\u63A5\u53D7 https \u5730\u5740\uFF08\u5F53\u524D\u662F ${parsed.protocol.replace(":", "")}\uFF09\u2014\u2014\u8FD9\u4E2A\u6587\u4EF6\u91CC\u7684\u5B89\u88C5\u547D\u4EE4\u4F1A\u88AB\u672C\u673A\u6267\u884C\uFF0C\u660E\u6587\u4F20\u8F93\u7B49\u4E8E\u628A\u5B83\u4EEC\u4EA4\u7ED9\u8DEF\u5F84\u4E0A\u7684\u4EFB\u4F55\u4EBA`, status: 400 };
  }
  if (parsed.username || parsed.password) {
    return { error: "\u5730\u5740\u91CC\u4E0D\u80FD\u5E26\u7528\u6237\u540D/\u5BC6\u7801\uFF1A\u5B83\u4F1A\u88AB\u660E\u6587\u5B58\u8FDB sources.json \u5E76\u51FA\u73B0\u5728\u65E5\u5FD7\u91CC", status: 400 };
  }
  parsed.hash = "";
  return { url: parsed.toString() };
}
function sourceIdFor(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const slug = `${parsed.host}${parsed.pathname}`.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, ID_MAX - "custom:".length);
  return slug ? `custom:${slug}` : null;
}
function defaultLabelFor(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return "\u81EA\u5B9A\u4E49\u6E90";
  }
  const parts = parsed.pathname.split("/").filter(Boolean);
  if (parsed.host === "raw.githubusercontent.com" && parts.length >= 2) return `${parts[0]}/${parts[1]}`.slice(0, LABEL_MAX);
  if (parsed.host.endsWith("jsdelivr.net") && parts[0] === "gh" && parts.length >= 3) {
    return `${parts[1]}/${parts[2].replace(/@.*$/, "")}`.slice(0, LABEL_MAX);
  }
  return (parts.length ? `${parsed.host}/${parts[0]}` : parsed.host).slice(0, LABEL_MAX);
}
function validateSourceInput(input = {}, { existing = [], selfId = null } = {}) {
  const vetted = normalizeSourceUrl(input.url);
  if (vetted.error) return { ok: false, error: vetted.error, status: vetted.status ?? 400 };
  const url = vetted.url;
  const id = sourceIdFor(url);
  if (!id) return { ok: false, error: "\u65E0\u6CD5\u4ECE\u5730\u5740\u751F\u6210\u4E00\u4E2A\u7A33\u5B9A\u7684\u6765\u6E90 id", status: 400 };
  const clash = (existing ?? []).find((s) => s.id !== selfId && (s.url === url || s.id === id));
  if (clash) return { ok: false, error: `\u8FD9\u4E2A\u5730\u5740\u5DF2\u7ECF\u6DFB\u52A0\u8FC7\u4E86\uFF08${clash.label}\uFF09`, status: 409 };
  const label = typeof input.label === "string" && input.label.trim() ? input.label.trim().slice(0, LABEL_MAX) : defaultLabelFor(url);
  return { ok: true, source: { id, label, url } };
}
function addSourceTo(doc, input) {
  const sources = doc?.sources ?? [];
  if (sources.length >= SOURCES_MAX) {
    const err = new Error(`\u81EA\u5B9A\u4E49\u76EE\u5F55\u6E90\u6700\u591A ${SOURCES_MAX} \u4E2A`);
    err.code = "too-many-sources";
    err.status = 409;
    throw err;
  }
  const checked = validateSourceInput(input, { existing: sources });
  if (!checked.ok) {
    const err = new Error(checked.error);
    err.code = "invalid-source";
    err.status = checked.status ?? 400;
    throw err;
  }
  return { doc: { version: SOURCES_VERSION, sources: [...sources, checked.source] }, source: checked.source };
}
function removeSourceFrom(doc, id) {
  const sources = doc?.sources ?? [];
  const removed = sources.find((s) => s.id === id) ?? null;
  return {
    doc: { version: SOURCES_VERSION, sources: sources.filter((s) => s.id !== id) },
    removed
  };
}

// lib/submission.js
var NAME_MAX = 120;
var SUBMISSION_FIELDS = [
  { key: "name", label: "\u540D\u79F0", required: true, hint: "\u8FD9\u4E2A MCP \u670D\u52A1\u53EB\u4EC0\u4E48\uFF08\u5217\u8868\u91CC\u663E\u793A\u7684\u540D\u5B57\uFF09" },
  { key: "description", label: "\u8BF4\u660E", required: true, hint: "\u4E00\u4E24\u53E5\u8BDD\uFF1A\u5B83\u80FD\u505A\u4EC0\u4E48" },
  { key: "command", label: "\u542F\u52A8\u547D\u4EE4", required: false, hint: "stdio \u578B\u586B\u8FD9\u4E00\u4E2A\uFF1Anpx\u3001uvx\u3001docker \u7B49\u53EF\u6267\u884C\u6587\u4EF6" },
  { key: "args", label: "\u547D\u4EE4\u53C2\u6570", required: false, hint: "\u4F20\u7ED9\u4E0A\u9762\u90A3\u6761\u547D\u4EE4\u7684\u53C2\u6570\uFF0C\u7528\u7A7A\u683C\u5206\u9694" },
  { key: "url", label: "\u670D\u52A1\u5730\u5740", required: false, hint: "streamable-http \u578B\u586B\u8FD9\u4E00\u4E2A\uFF1Ahttps \u7AEF\u70B9" },
  { key: "repository", label: "\u4ED3\u5E93", required: false, hint: "\u6E90\u7801\u5730\u5740\uFF08https://github.com/owner/repo\uFF09" },
  { key: "homepage", label: "\u4E3B\u9875", required: false, hint: "\u6587\u6863\u6216\u4E3B\u9875\u5730\u5740" },
  { key: "tags", label: "\u6807\u7B7E", required: false, hint: "\u9017\u53F7\u5206\u9694\uFF0C\u6700\u591A 8 \u4E2A" },
  { key: "category", label: "\u5206\u7C7B", required: false, hint: "\u4F8B\u5982\uFF1A\u5F00\u53D1\u8005\u5DE5\u5177" }
];
var FIELD_BY_LABEL = new Map(SUBMISSION_FIELDS.map((f) => [f.label, f]));
function clean(value, max) {
  if (typeof value !== "string") return "";
  const text = value.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, " ").replace(/[ \t]+/g, " ");
  return text.trim().slice(0, max);
}
function githubRepoSlug(raw) {
  const text = clean(raw, 300);
  if (!text) return null;
  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:") return null;
  if (parsed.host !== "github.com" && parsed.host !== "www.github.com") return null;
  const parts = parsed.pathname.split("/").filter(Boolean);
  if (parts.length < 2) return null;
  return `${parts[0]}/${parts[1].replace(/\.git$/, "")}`.toLowerCase();
}
function githubRepoOfSourceUrl(raw) {
  const text = clean(raw, URL_MAX);
  if (!text) return null;
  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    return null;
  }
  const parts = parsed.pathname.split("/").filter(Boolean);
  if (parsed.host === "raw.githubusercontent.com" && parts.length >= 2) {
    return { owner: parts[0], repo: parts[1] };
  }
  if (parsed.host.endsWith("jsdelivr.net") && parts[0] === "gh" && parts.length >= 3) {
    return { owner: parts[1], repo: parts[2].replace(/@.*$/, "") };
  }
  if (parsed.protocol === "https:" && (parsed.host === "github.com" || parsed.host === "www.github.com") && parts.length >= 2) {
    return { owner: parts[0], repo: parts[1].replace(/\.git$/, "") };
  }
  return null;
}
function buildSubmissionBody(fields = {}) {
  const lines = [];
  for (const field of SUBMISSION_FIELDS) {
    lines.push(`### ${field.label}`, "");
    const value = fields[field.key];
    lines.push(typeof value === "string" && value.trim() ? value.trim() : "_No response_", "");
  }
  return lines.join("\n").trimEnd();
}
function fieldsOfRow(row = {}) {
  return {
    name: row.name ?? "",
    description: row.description ?? "",
    command: row.command ?? "",
    args: Array.isArray(row.args) ? row.args.join(" ") : "",
    url: row.url ?? "",
    repository: row.repository ?? "",
    homepage: row.homepage ?? "",
    tags: Array.isArray(row.tags) ? row.tags.join(", ") : "",
    category: row.category ?? ""
  };
}
function buildIssueUrl({ repo, row = {}, title } = {}) {
  const slug = githubRepoSlug(/^https?:/.test(String(repo)) ? repo : `https://github.com/${String(repo ?? "")}`);
  if (!slug) return null;
  const name2 = clean(title ?? row.name, NAME_MAX);
  const body = buildSubmissionBody(fieldsOfRow(row));
  const params = new URLSearchParams();
  if (name2) params.set("title", `[MCP \u6536\u5F55] ${name2}`);
  params.set("body", body);
  return `https://github.com/${slug}/issues/new?${params.toString()}`;
}

// lib/installs.js
import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { dirname } from "node:path";
var INSTALLS_VERSION = 1;
var KEY_MAX = 200;
function installKeyOf(item, fallback = null) {
  const id = typeof item?.id === "string" ? item.id.trim() : "";
  if (id) return id.slice(0, KEY_MAX);
  const name2 = typeof fallback === "string" ? fallback.trim() : "";
  return name2 ? `name:${name2}`.slice(0, KEY_MAX) : null;
}
function emptyInstalls() {
  return { version: INSTALLS_VERSION, entries: {} };
}
function normalizeInstalls(raw) {
  const store = emptyInstalls();
  const entries = raw && typeof raw === "object" ? raw.entries : null;
  if (!entries || typeof entries !== "object" || Array.isArray(entries)) return store;
  for (const [key, value] of Object.entries(entries)) {
    if (!key) continue;
    const count = Number(value?.count);
    if (!Number.isFinite(count) || count <= 0) continue;
    const entry = { count: Math.floor(count) };
    if (typeof value?.firstAt === "string") entry.firstAt = value.firstAt;
    if (typeof value?.lastAt === "string") entry.lastAt = value.lastAt;
    if (typeof value?.name === "string" && value.name) entry.name = value.name.slice(0, KEY_MAX);
    store.entries[key.slice(0, KEY_MAX)] = entry;
  }
  return store;
}
async function readInstalls(file, readFileImpl = readFile) {
  try {
    return normalizeInstalls(JSON.parse(await readFileImpl(file, "utf8")));
  } catch {
    return emptyInstalls();
  }
}
function recordInstallIn(store, { key, name: name2 = null, at = null } = {}) {
  const target = store && typeof store === "object" ? store : emptyInstalls();
  if (!target.entries || typeof target.entries !== "object") target.entries = {};
  if (!key) return null;
  const iso = typeof at === "string" && at ? at : (/* @__PURE__ */ new Date()).toISOString();
  const existing = target.entries[key];
  const entry = {
    count: (Number.isFinite(existing?.count) ? existing.count : 0) + 1,
    firstAt: existing?.firstAt ?? iso,
    lastAt: iso
  };
  if (name2) entry.name = String(name2).slice(0, KEY_MAX);
  else if (existing?.name) entry.name = existing.name;
  target.entries[key] = entry;
  return entry;
}
function localInstallsOf(store, item, fallback = null) {
  const key = typeof item === "string" ? item : installKeyOf(item, fallback);
  if (!key) return 0;
  const count = store?.entries?.[key]?.count;
  return Number.isFinite(count) && count > 0 ? count : 0;
}
function localLastInstallOf(store, item, fallback = null) {
  const key = typeof item === "string" ? item : installKeyOf(item, fallback);
  if (!key) return null;
  const at = store?.entries?.[key]?.lastAt;
  return typeof at === "string" && at ? at : null;
}
async function writeInstalls(file, store, fsImpl = { mkdir, writeFile, rename }) {
  await fsImpl.mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await fsImpl.writeFile(tmp, JSON.stringify({ version: INSTALLS_VERSION, entries: store?.entries ?? {} }, null, 2), "utf8");
  await fsImpl.rename(tmp, file);
}

// lib/about-i18n.js
var I18N_MAX_ITEMS = 40;
var I18N_MAX_CHARS = 600;
var I18N_CACHE_MAX = 400;
var I18N_SYSTEM = [
  "You translate short descriptions of MCP servers for a developer tool panel.",
  "Translate each numbered line into the requested language.",
  "Keep unchanged: product names, package names, command names, flag names, file paths, URLs, and code identifiers.",
  "If a line is already in the requested language, repeat it unchanged.",
  "Keep each translation about the same length as its source; it is a one-line subtitle, not an explanation.",
  "Reply with a JSON array of strings and nothing else: same length, same order, no keys, no commentary."
].join(" ");
var CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
function targetLang(value) {
  if (typeof value !== "string") return "";
  const primary = value.trim().toLowerCase().split(/[-_]/)[0];
  return /^[a-z]{2,3}$/.test(primary) ? primary : "";
}
function hasLocalizedScript(text, lang) {
  if (typeof text !== "string") return false;
  if (lang === "zh" || lang === "ja") return CJK.test(text);
  return false;
}
function needsTranslation(text, lang) {
  if (typeof text !== "string") return false;
  const trimmed = text.trim();
  if (trimmed === "") return false;
  const target = targetLang(lang) || (typeof lang === "string" ? lang : "");
  if (target === "" || target === "en") return false;
  return !hasLocalizedScript(trimmed, target);
}
function buildTranslationPrompt({ lang, texts }) {
  const target = targetLang(lang) || String(lang ?? "");
  const lines = (Array.isArray(texts) ? texts : []).map((text, index) => `${index + 1}. ${String(text).slice(0, I18N_MAX_CHARS)}`);
  return [
    `Target language: ${target}`,
    `Lines: ${lines.length}`,
    "",
    ...lines
  ].join("\n");
}
function parseTranslations(raw, count) {
  if (typeof raw !== "string" || !Number.isInteger(count) || count <= 0) return null;
  const start = raw.indexOf("[");
  const end = raw.lastIndexOf("]");
  if (start < 0 || end <= start) return null;
  let parsed;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length !== count) return null;
  const out = parsed.map((value) => typeof value === "string" ? value.trim() : "");
  return out.every((value) => value !== "") ? out : null;
}
function translationKey(lang, text) {
  const target = targetLang(lang) || String(lang ?? "");
  return `${target}\0${text}`;
}
function cacheRowsOf(cache, max = I18N_CACHE_MAX) {
  const rows = [];
  if (!(cache instanceof Map)) return rows;
  for (const [key, value] of cache) {
    const sep = key.indexOf("\0");
    if (sep <= 0) continue;
    rows.push({ lang: key.slice(0, sep), source: key.slice(sep + 1), text: value });
  }
  return rows.slice(Math.max(0, rows.length - max));
}
function cacheFromRows(rows) {
  const cache = /* @__PURE__ */ new Map();
  if (!Array.isArray(rows)) return cache;
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const { lang, source, text } = row;
    if (typeof lang !== "string" || typeof source !== "string" || typeof text !== "string") continue;
    if (lang === "" || source === "" || text === "") continue;
    cache.set(translationKey(lang, source), text);
  }
  return cache;
}

// lib/media.js
var README_HEADERS = { "user-agent": "dsh-overall-mcp (DeepSeek Harness plugin)", accept: "text/plain" };
var IMAGE_EXT = /\.(png|jpe?g|gif|webp|avif|svg)(?:[?#]|$)/i;
var BADGE_HOSTS = /* @__PURE__ */ new Set([
  "img.shields.io",
  "shields.io",
  "flat.badgen.net",
  "badgen.net",
  "badge.fury.io",
  "nodei.co",
  "snyk.io",
  "codecov.io",
  "coveralls.io",
  "travis-ci.com",
  "travis-ci.org",
  "circleci.com",
  "dependabot.com",
  "github-readme-stats.vercel.app",
  "github-profile-trophy.vercel.app",
  "repobeats.xyz",
  "actions-badge.herokuapp.com",
  "opencollective.com",
  "img.youtube.com",
  // MCP directories and CI hosts that publish "listed on" score cards.
  "glama.ai",
  "mcpservers.org",
  "mcp.so",
  "smithery.io",
  "sonarcloud.io",
  "codacy.com",
  "codeclimate.com",
  "deepscan.io",
  "bettercodehub.com",
  "lgtm.com",
  "fossa.io",
  "dev.azure.com",
  "visualstudio.com",
  "gitlab.com",
  "npmstack.com",
  "packagephobia.com",
  "bundlephobia.com",
  "apex.sh"
]);
var BADGE_URL = /\/(?:badges?|shields?|score|status)(?:[/.]|$)/i;
var BADGE_PATH = /github\.com\/[^/]+\/[^/]+\/(?:badge|actions\/workflows)/i;
function hostOf2(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}
var STRONG_WORDS = /(screenshot|screen shot|demo|preview|overview|architecture|diagram|workflow|flow|banner|hero|cover|dashboard|ui|interface|terminal|cli|example|gallery)/i;
function ogImageOf(repo) {
  const m = /^([^/\s]+)\/([^/\s]+)$/.exec(String(repo ?? "").trim());
  return m ? `https://opengraph.githubassets.com/${m[1]}/${m[2]}` : null;
}
function normalizeImageUrl(raw, repo) {
  let url = String(raw ?? "").trim();
  if (!url) return null;
  url = url.replace(/\s+["'(].*$/, "").trim();
  if (url.startsWith("<") && url.endsWith(">")) url = url.slice(1, -1).trim();
  if (!url) return null;
  if (!/^https?:\/\//i.test(url)) {
    if (/^(?:data|mailto|javascript|blob):/i.test(url)) return null;
    const [owner, name2] = String(repo ?? "").split("/");
    if (!owner || !name2) return null;
    if (/^\/[^/]+\/[^/]+\/blob\//i.test(url)) url = `https://github.com${url}`;
    else url = `https://raw.githubusercontent.com/${owner}/${name2}/HEAD/${url.replace(/^\.?\//, "")}`;
  }
  const blob = /^https?:\/\/(?:www\.)?github\.com\/([^/\s]+)\/([^/\s]+)\/blob\/([^/\s]+)\/(.+)$/i.exec(url);
  if (blob) url = `https://raw.githubusercontent.com/${blob[1]}/${blob[2]}/${blob[3]}/${blob[4]}`;
  if (!IMAGE_EXT.test(url)) return null;
  if (BADGE_HOSTS.has(hostOf2(url)) || BADGE_PATH.test(url) || BADGE_URL.test(url)) return null;
  return url;
}
function collectImageRefs(markdown) {
  const out = [];
  const text = String(markdown ?? "");
  for (const m of text.matchAll(/!\[([^\]]*)\]\(\s*([^)\s]+)/g)) {
    out.push({ alt: m[1] ?? "", url: m[2] });
  }
  for (const m of text.matchAll(/<img\b([^>]*)>/gi)) {
    const attrs = m[1] ?? "";
    const src = /\bsrc\s*=\s*["']([^"']+)["']/i.exec(attrs)?.[1] ?? /\bsource\s*=\s*["']([^"']+)["']/i.exec(attrs)?.[1];
    if (!src) continue;
    const width = Number(/(?:^|\s)width\s*=\s*["']?(\d+)/i.exec(attrs)?.[1]);
    const height = Number(/(?:^|\s)height\s*=\s*["']?(\d+)/i.exec(attrs)?.[1]);
    out.push({
      alt: /\balt\s*=\s*["']([^"']*)["']/i.exec(attrs)?.[1] ?? "",
      url: src,
      width: Number.isFinite(width) && width > 0 ? width : null,
      height: Number.isFinite(height) && height > 0 ? height : null
    });
  }
  for (const m of text.matchAll(/^\s{0,3}\[([^\]]+)\]:\s*(https?:\/\/\S+)\s*$/gm)) {
    out.push({ alt: m[1] ?? "", url: m[2] });
  }
  return out;
}
function imageKindOf(url, alt) {
  const hay = `${url} ${alt}`;
  if (/star-history|starchart/i.test(hay)) return "chart";
  if (STRONG_WORDS.test(hay)) return "screenshot";
  return "image";
}
function rankImages(candidates, max = 6) {
  const scored = [];
  const seen = /* @__PURE__ */ new Set();
  candidates.forEach((c, index) => {
    const url = normalizeImageUrl(c.url, c.repo);
    if (!url || seen.has(url)) return;
    seen.add(url);
    const width = Number.isFinite(c.width) && c.width > 0 ? c.width : null;
    const height = Number.isFinite(c.height) && c.height > 0 ? c.height : null;
    if (width && height && Math.min(width, height) < 200) return;
    const svg = /\.svg(?:[?#]|$)/i.test(url);
    if (svg && !(width && height)) return;
    const kind = imageKindOf(url, c.alt);
    const raster = /\.(png|jpe?g|gif|webp|avif)(?:[?#]|$)/i.test(url);
    let score = 0;
    if (kind === "screenshot") score += 60;
    if (kind === "chart") score += 25;
    if (raster) score += 12;
    if (String(c.alt ?? "").trim()) score += 6;
    if (width && height) score += 8;
    score -= Math.min(index, 20) * 0.4;
    scored.push({ url, alt: String(c.alt ?? "").trim(), kind, score, width, height });
  });
  return scored.sort((a, b) => b.score - a.score).slice(0, max);
}
var README_NAMES = ["README.md", "README.rst", "README"];
async function fetchReadmeText(repo, fetchImpl = fetch) {
  const carriers = README_NAMES.map((name2) => `https://raw.githubusercontent.com/${repo}/HEAD/${name2}`).concat([`https://cdn.jsdelivr.net/gh/${repo}/README.md`]);
  for (const url of carriers) {
    try {
      const res = await fetchImpl(url, {
        signal: AbortSignal.timeout(1e4),
        headers: withGithubAuth(url, README_HEADERS)
      });
      if (!res.ok) continue;
      const text = await res.text();
      if (text && !/^404: Not Found/i.test(text.trim())) return text;
    } catch {
    }
  }
  return null;
}
async function repoMediaFor(repo, fetchImpl = fetch, maxImages = 4) {
  const markdown = await fetchReadmeText(repo, fetchImpl);
  const images = markdown ? rankImages(collectImageRefs(markdown).map((c) => ({ ...c, repo })), maxImages) : [];
  const og = ogImageOf(repo);
  return { repo, images, og: images.length ? null : og };
}
async function collectRepoMedia(repos, { fetchImpl = fetch, max = 24, maxImages = 4 } = {}) {
  const media = {};
  const errors = [];
  let spent = 0;
  for (const repo of repos) {
    if (spent >= max) break;
    spent += 1;
    try {
      const entry = await repoMediaFor(repo, fetchImpl);
      media[repo] = { ...entry, images: entry.images.slice(0, maxImages) };
    } catch (err) {
      errors.push({ repo, error: String(err?.message ?? err) });
    }
  }
  return { media, errors };
}

// lib/http-status.js
function httpStatusFor(err) {
  const explicit = Number(err?.status);
  if (Number.isInteger(explicit) && explicit >= 400 && explicit <= 599) return explicit;
  const message = String(err?.message ?? err ?? "");
  if (/^unknown (server|source)\b/.test(message)) return 404;
  if (/^(item|key|name|source|enabled)\b[\s\S]*\brequired\b/.test(message)) return 400;
  if (/\bmust be a boolean\b/.test(message)) return 400;
  if (/\bno installable transport\b/.test(message)) return 400;
  if (/\bis not launched through a package runner\b/.test(message)) return 400;
  if (/^unknown [\w -]+ action\b/.test(message)) return 400;
  if (/\baction(?:\s+\S+)?\s+must be sent as a POST\b/.test(message)) return 400;
  if (/^ambiguous server name\b/.test(message)) return 409;
  if (/^stale entry\b/.test(message)) return 409;
  if (/^manual entry\b/.test(message)) return 409;
  if (/^version lookup failed\b/.test(message)) return 502;
  return 500;
}

// lib/schema-guard.js
var UNPORTABLE = /\\[1-9]|\\k<|\(\?<=|\(\?<!|\(\?<[A-Za-z]|\(\?\(|\\p\{|\\(?![0abfnrtvxu.]|$)/;
function rewriteNulEscape(source) {
  return source.replace(/\\0(?![0-9])/g, "\\x00");
}
function repairRegexSource(source) {
  if (typeof source !== "string") return { action: "drop", from: String(source) };
  const rewritten = rewriteNulEscape(source);
  if (rewritten !== source) {
    if (UNPORTABLE.test(rewritten)) return { action: "drop", from: source };
    return { action: "rewrite", value: rewritten, from: source };
  }
  if (UNPORTABLE.test(source)) return { action: "drop", from: source };
  return { action: "keep", value: source, from: source };
}
function sanitizeSchema(schema) {
  const changes = [];
  const walk = (node, path8) => {
    if (node === null || typeof node !== "object") return node;
    if (Array.isArray(node)) return node.map((item, i) => walk(item, `${path8}[${i}]`));
    const out = {};
    for (const [key, value] of Object.entries(node)) {
      const here = path8 ? `${path8}.${key}` : key;
      if (key === "pattern" && typeof value === "string") {
        const repair = repairRegexSource(value);
        if (repair.action === "drop") {
          changes.push({ path: here, action: "dropped", from: repair.from });
          continue;
        }
        if (repair.action === "rewrite") {
          changes.push({ path: here, action: "rewritten", from: repair.from, to: repair.value });
          out[key] = repair.value;
          continue;
        }
        out[key] = value;
        continue;
      }
      if (key === "patternProperties" && value && typeof value === "object") {
        const kept = {};
        for (const [source, sub] of Object.entries(value)) {
          const repair = repairRegexSource(source);
          if (repair.action === "drop") {
            changes.push({ path: `${here}.${source}`, action: "dropped", from: repair.from });
            continue;
          }
          const finalKey = repair.action === "rewrite" ? repair.value : source;
          if (repair.action === "rewrite") {
            changes.push({ path: `${here}.${source}`, action: "rewritten", from: repair.from, to: repair.value });
          }
          kept[finalKey] = walk(sub, `${here}.${finalKey}`);
        }
        out[key] = kept;
        continue;
      }
      out[key] = walk(value, here);
    }
    return out;
  };
  return { schema: walk(schema, ""), changes };
}
function sanitizeToolDefinition(definition, { onlyPrefixed = "mcp__", onChange } = {}) {
  if (!definition || typeof definition !== "object") return definition;
  const name2 = definition.name;
  if (typeof name2 !== "string" || !name2.startsWith(onlyPrefixed)) return definition;
  if (!definition.parameters || typeof definition.parameters !== "object") return definition;
  const { schema, changes } = sanitizeSchema(definition.parameters);
  if (changes.length === 0) return definition;
  onChange?.({ name: name2, changes });
  return { ...definition, parameters: schema };
}

// lib/self-update.js
import { readFile as readFile2 } from "node:fs/promises";
import { execFile as execFile2 } from "node:child_process";
import { existsSync } from "node:fs";
import path3 from "node:path";
import { fileURLToPath } from "node:url";
var PACKAGE_NAME = "dsh-overall-mcp";
var DEFAULT_CACHE_MS = 10 * 60 * 1e3;
async function readSelfPackage(moduleUrl) {
  const dir = path3.dirname(fileURLToPath(moduleUrl));
  const raw = await readFile2(path3.join(dir, "package.json"), "utf8");
  const pkg = JSON.parse(raw);
  return { name: typeof pkg.name === "string" && pkg.name ? pkg.name : PACKAGE_NAME, version: String(pkg.version ?? "") };
}
function resolveInstall(modulePath) {
  const packageDir = path3.dirname(modulePath);
  const marker = `${path3.sep}node_modules${path3.sep}`;
  let at = modulePath.indexOf(marker);
  if (at === -1) {
    return { mode: "link", packageDir, profileDir: null, profileName: null, spec: null };
  }
  for (let cursor = at; cursor !== -1; cursor = modulePath.indexOf(marker, cursor + marker.length)) {
    const candidate = modulePath.slice(0, cursor);
    if (path3.basename(path3.dirname(candidate)) === "profiles") {
      at = cursor;
      break;
    }
  }
  const profileDir = modulePath.slice(0, at);
  const profileName = path3.basename(profileDir);
  return { mode: "registry", packageDir, profileDir, profileName, spec: null };
}
async function readInstalledSpec(profileDir, name2 = PACKAGE_NAME) {
  if (!profileDir) return null;
  try {
    const raw = await readFile2(path3.join(profileDir, "package.json"), "utf8");
    const pkg = JSON.parse(raw);
    const spec = pkg?.dependencies?.[name2] ?? pkg?.devDependencies?.[name2];
    return typeof spec === "string" ? spec : null;
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw new Error(`\u65E0\u6CD5\u8BFB\u53D6\u66F4\u65B0\u6240\u5C5E profile \u7684 package.json\uFF1A${error.message}`, { cause: error });
  }
}
function isGitSpec(spec) {
  if (typeof spec !== "string") return false;
  const value = spec.trim();
  return /^github:/i.test(value) || /^git\+/i.test(value) || /^git:/i.test(value) || /^https?:\/\/\S+\.git(#.*)?$/i.test(value);
}
async function checkSelfUpdate({
  moduleUrl,
  fetchImpl = fetch,
  cacheMs = DEFAULT_CACHE_MS,
  force = false,
  cache = null
} = {}) {
  const self = await readSelfPackage(moduleUrl);
  const install = resolveInstall(fileURLToPath(moduleUrl));
  const base = {
    name: self.name,
    version: self.version,
    install: install.mode,
    packageDir: install.packageDir,
    profileDir: install.profileDir,
    profileName: install.profileName
  };
  if (install.mode === "link") {
    return {
      ...base,
      checked: false,
      latest: null,
      updateAvailable: false,
      reason: "linked",
      hint: "\u5F53\u524D profile \u4EE5 link: \u6307\u5411\u672C\u5730\u76EE\u5F55\uFF0C\u76F4\u63A5\u6539\u672C\u5730\u4EE3\u7801\u5373\u53EF\uFF1B\u4E0D\u63D0\u4F9B\u4ECE npm \u66F4\u65B0"
    };
  }
  const spec = await readInstalledSpec(install.profileDir, self.name);
  if (!spec) {
    return {
      ...base,
      checked: false,
      latest: null,
      updateAvailable: false,
      reason: "unknown-profile",
      hint: "\u6240\u5C5E profile \u672A\u58F0\u660E\u672C\u63D2\u4EF6\u4F9D\u8D56\uFF0C\u65E0\u6CD5\u5B89\u5168\u786E\u5B9A\u66F4\u65B0\u76EE\u6807"
    };
  }
  if (/^(link|file|workspace|portal):/.test(spec)) {
    return {
      ...base,
      spec,
      checked: false,
      latest: null,
      updateAvailable: false,
      reason: "linked",
      hint: `profile \u91CC\u58F0\u660E\u4E3A ${spec}\uFF0C\u672C\u5730\u76EE\u5F55\u5C31\u662F\u7248\u672C\u6765\u6E90`
    };
  }
  if (spec && isGitSpec(spec)) {
    return {
      ...base,
      spec,
      checked: false,
      latest: null,
      updateAvailable: false,
      reason: "git",
      hint: `\u8BF7\u5B8C\u5168\u9000\u51FA DSH\uFF0C\u518D\u7528 dsh plugin --profile ${install.profileName} add ${spec.split("#", 1)[0]}#<\u65B0\u63D0\u4EA4\u6216\u6807\u7B7E> \u5B89\u88C5\u5B8C\u6574\u66F4\u65B0\u5305\uFF0C\u7136\u540E\u91CD\u5F00 DSH\u3002`
    };
  }
  const key = `${self.name}@${self.version}`;
  if (!force && cache && cacheMs > 0 && cache.key === key && Date.now() - cache.at < cacheMs) {
    return { ...cache.value, cached: true };
  }
  let latest = null;
  try {
    latest = await latestPackageVersion("npm", self.name, { fetchImpl });
  } catch (err) {
    const value2 = {
      ...base,
      spec,
      checked: true,
      latest: null,
      updateAvailable: false,
      reason: "lookup-failed",
      hint: `npm \u4E0A\u67E5\u4E0D\u5230 ${self.name} \u7684\u53D1\u5E03\u7248\u672C\uFF1A${String(err?.message ?? err)}`
    };
    if (cache) Object.assign(cache, { key, at: Date.now(), value: value2 });
    return value2;
  }
  const updateAvailable = compareVersions(latest, self.version) > 0;
  const value = {
    ...base,
    spec,
    checked: true,
    latest,
    updateAvailable,
    reason: updateAvailable ? "newer-published" : "up-to-date"
  };
  if (cache) Object.assign(cache, { key, at: Date.now(), value });
  return value;
}
function resolveLauncher() {
  if (process.env.DSH_BIN && existsSync(process.env.DSH_BIN)) return process.env.DSH_BIN;
  const appData = process.env.APPDATA;
  if (appData) {
    for (const candidate of ["dsh.cmd", "dsh.exe", "dsh"]) {
      const full = path3.join(appData, "npm", candidate);
      if (existsSync(full)) return full;
    }
  }
  return "dsh";
}
async function runSelfUpdateCommand(file, args, { cwd, timeoutMs = 18e4 } = {}) {
  let executable = file;
  let argv = args;
  let env = process.env;
  const extension = path3.extname(file).toLowerCase();
  if (extension === ".cmd" || extension === ".bat") {
    const packageDir = path3.join(path3.dirname(file), "node_modules", "@deepseek-ai", "dsh");
    const pkg = JSON.parse(await readFile2(path3.join(packageDir, "package.json"), "utf8"));
    const bin = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.dsh;
    if (pkg.name !== "@deepseek-ai/dsh" || typeof bin !== "string" || !bin) {
      throw new Error(`\u65E0\u6CD5\u89E3\u6790 DSH \u542F\u52A8\u5165\u53E3\uFF1A${file}`);
    }
    const entry = path3.resolve(packageDir, bin);
    const relative = path3.relative(packageDir, entry);
    if (!relative || relative.startsWith("..") || path3.isAbsolute(relative) || !existsSync(entry)) {
      throw new Error(`DSH \u542F\u52A8\u5165\u53E3\u4E0D\u5728\u5DF2\u5B89\u88C5\u5305\u4E2D\uFF1A${file}`);
    }
    executable = process.execPath;
    argv = [entry, ...args];
    env = { ...process.env, ELECTRON_RUN_AS_NODE: "1" };
  } else if ([".js", ".mjs", ".cjs"].includes(extension)) {
    executable = process.execPath;
    argv = [file, ...args];
    env = { ...process.env, ELECTRON_RUN_AS_NODE: "1" };
  }
  return new Promise((resolve) => {
    execFile2(
      executable,
      argv,
      { cwd, env, timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => {
        resolve({
          code: error ? typeof error.code === "number" ? error.code : 1 : 0,
          stdout: String(stdout ?? ""),
          stderr: String(stderr ?? "") || (error ? String(error.message ?? "") : "")
        });
      }
    );
  });
}
async function updateSelf({ moduleUrl, fetchImpl = fetch, run = runSelfUpdateCommand, launcher = resolveLauncher() } = {}) {
  const check = await checkSelfUpdate({ moduleUrl, fetchImpl, force: true });
  if (!check.checked) {
    return { ok: false, updated: false, reason: check.reason, hint: check.hint, command: null };
  }
  if (!check.updateAvailable) {
    return { ok: false, updated: false, reason: check.reason, version: check.version, latest: check.latest, command: null };
  }
  if (!check.profileName) {
    return { ok: false, updated: false, reason: "unknown-profile", hint: "\u65E0\u6CD5\u786E\u5B9A\u5F53\u524D profile \u540D\u79F0", command: null };
  }
  const args = ["plugin", "--profile", check.profileName, "add", `${check.name}@${check.latest}`];
  const command = `dsh ${args.join(" ")}`;
  const result = await run(launcher, args, { cwd: check.profileDir });
  return {
    ok: result.code === 0,
    updated: result.code === 0,
    command,
    from: check.version,
    to: check.latest,
    code: result.code,
    stdout: result.stdout.trim().slice(-4e3),
    stderr: result.stderr.trim().slice(-4e3),
    restartRequired: result.code === 0,
    hint: result.code === 0 ? `\u5DF2\u5B89\u88C5 ${check.name}@${check.latest}\uFF1B\u91CD\u542F DSH \u540E\u751F\u6548` : "\u81EA\u52A8\u66F4\u65B0\u5931\u8D25\uFF0C\u53EF\u5728\u7EC8\u7AEF\u624B\u52A8\u6267\u884C\u4E0A\u9762\u8FD9\u6761\u547D\u4EE4"
  };
}

// lib/skill-market.js
import nodeFs from "node:fs/promises";
import path5 from "node:path";

// lib/zip.js
import zlib from "node:zlib";
var END_SIGNATURE = 101010256;
var CENTRAL_SIGNATURE = 33639248;
var LOCAL_SIGNATURE = 67324752;
var MAX_ENTRIES = 5e3;
var MAX_UNPACKED_BYTES = 64 * 1024 * 1024;
function findEndRecord(buffer) {
  const floor = Math.max(0, buffer.length - 22 - 65535);
  for (let offset = buffer.length - 22; offset >= floor; offset -= 1) {
    if (buffer.readUInt32LE(offset) === END_SIGNATURE) return offset;
  }
  return -1;
}
function listZip(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 22) {
    return { entries: [], error: "not a zip archive" };
  }
  const end = findEndRecord(buffer);
  if (end < 0) return { entries: [], error: "no end-of-central-directory record" };
  const count = buffer.readUInt16LE(end + 10);
  const directoryOffset = buffer.readUInt32LE(end + 16);
  if (count > MAX_ENTRIES) return { entries: [], error: `too many entries (${count})` };
  if (directoryOffset >= buffer.length) return { entries: [], error: "central directory is outside the archive" };
  const entries = [];
  let cursor = directoryOffset;
  for (let index = 0; index < count; index += 1) {
    if (cursor + 46 > buffer.length || buffer.readUInt32LE(cursor) !== CENTRAL_SIGNATURE) {
      return { entries: [], error: "central directory is truncated" };
    }
    const flags = buffer.readUInt16LE(cursor + 8);
    const method = buffer.readUInt16LE(cursor + 10);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const uncompressedSize = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const externalAttributes = buffer.readUInt32LE(cursor + 38);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const name2 = buffer.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8");
    cursor += 46 + nameLength + extraLength + commentLength;
    const unixMode = externalAttributes >>> 16;
    entries.push({
      name: name2,
      method,
      encrypted: (flags & 1) === 1,
      compressedSize,
      uncompressedSize,
      localOffset,
      isDirectory: name2.endsWith("/"),
      isSymlink: (unixMode & 61440) === 40960
    });
  }
  return { entries, error: null };
}
function safeName(name2) {
  if (typeof name2 !== "string" || name2.length === 0) return null;
  if (name2.includes("\\")) return null;
  if (name2.startsWith("/") || /^[a-z]:/i.test(name2)) return null;
  const parts = name2.split("/").filter((part) => part.length > 0 && part !== ".");
  if (parts.length === 0) return null;
  if (parts.some((part) => part === "..")) return null;
  return parts.join("/");
}
function readZipFiles(buffer, { accept } = {}) {
  const { entries, error } = listZip(buffer);
  if (error) return { files: [], skipped: [], error };
  const files = [];
  const skipped = [];
  let unpacked = 0;
  for (const entry of entries) {
    if (entry.isDirectory) continue;
    const path8 = safeName(entry.name);
    if (!path8) {
      skipped.push({ name: entry.name, reason: "unsafe path" });
      continue;
    }
    if (entry.isSymlink) {
      skipped.push({ name: entry.name, reason: "symlink" });
      continue;
    }
    if (entry.encrypted) {
      skipped.push({ name: entry.name, reason: "encrypted" });
      continue;
    }
    if (entry.method !== 0 && entry.method !== 8) {
      skipped.push({ name: entry.name, reason: `compression method ${entry.method}` });
      continue;
    }
    if (!accept || accept(path8)) {
      const remaining = MAX_UNPACKED_BYTES - unpacked;
      if (entry.uncompressedSize > remaining) {
        return { files: [], skipped, error: `archive expands past ${MAX_UNPACKED_BYTES} bytes` };
      }
      const local = entry.localOffset;
      if (local + 30 > buffer.length || buffer.readUInt32LE(local) !== LOCAL_SIGNATURE) {
        skipped.push({ name: entry.name, reason: "missing local header" });
        continue;
      }
      const localNameLength = buffer.readUInt16LE(local + 26);
      const localExtraLength = buffer.readUInt16LE(local + 28);
      const dataStart = local + 30 + localNameLength + localExtraLength;
      const dataEnd = dataStart + entry.compressedSize;
      if (dataEnd > buffer.length) {
        skipped.push({ name: entry.name, reason: "payload runs past the archive" });
        continue;
      }
      const raw = buffer.subarray(dataStart, dataEnd);
      let bytes;
      try {
        if (entry.method === 0 && raw.length > Math.min(entry.uncompressedSize, remaining)) {
          return { files: [], skipped, error: `invalid expansion size: ${path8}` };
        }
        bytes = entry.method === 0 ? Buffer.from(raw) : zlib.inflateRawSync(raw, {
          maxOutputLength: Math.max(1, Math.min(entry.uncompressedSize, remaining))
        });
      } catch (inflateError) {
        return { files: [], skipped, error: `inflate failed for ${path8}: ${inflateError.message}` };
      }
      if (bytes.length !== entry.uncompressedSize || bytes.length > remaining) {
        return { files: [], skipped, error: `invalid expansion size: ${path8}` };
      }
      unpacked += bytes.length;
      files.push({ path: path8, bytes });
    } else {
      skipped.push({ name: entry.name, reason: "filtered" });
    }
  }
  return { files, skipped, error: null };
}

// lib/skills.js
import os2 from "node:os";
import path4 from "node:path";
import { createHash } from "node:crypto";
var SKILL_FILE = "SKILL.md";
var SKILL_ICON_METADATA = ".overall-mcp-icon.json";
var SKILL_ICON_BYTES = 64 * 1024;
var SKILL_ICON_TYPES = { ".png": "png", ".webp": "webp", ".jpg": "jpeg", ".jpeg": "jpeg", ".gif": "gif" };
function webSkillUrl(value) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (text.length > 2048 || !/^https?:\/\/[^/]/i.test(text) || /[\u0000-\u0020\u007f\\]/.test(text)) return null;
  const url = URL.parse(text);
  return url && !url.username && !url.password ? url : null;
}
function skillSourcePage({ pageUrl, homepage, repository, source, marketId } = {}) {
  const id = typeof marketId === "string" ? marketId : "";
  const url = webSkillUrl(pageUrl);
  if (url && (source === "skillhub" || id.startsWith("skillhub:")) && url.host === "api.skillhub.cn") {
    const listing = /^\/([\w-][\w.-]*)\/([\w-][\w.-]*)\/?$/.exec(url.pathname);
    if (listing) {
      const [, owner, slug] = listing;
      const mirror = /^clawhub_([\w-][\w.-]*)$/.exec(owner);
      return mirror ? `https://clawhub.ai/${mirror[1]}/skills/${slug}` : `https://skillhub.cn/skills/${owner}/${slug}`;
    }
  } else if (url) {
    return url.href;
  }
  const claw = /^clawhub:([\w-][\w.-]*)\/([\w-][\w.-]*)$/.exec(id);
  if (claw) return `https://clawhub.ai/${claw[1]}/skills/${claw[2]}`;
  const official = /^official:([\w.-]+)$/.exec(id);
  if (official && official[1] !== "." && official[1] !== "..") return `https://github.com/anthropics/skills/tree/main/skills/${official[1]}`;
  const github = /^github:([\w-]+)\/([\w.-]+)(?::.*)?$/.exec(id);
  if (github && github[2] !== "." && github[2] !== "..") return `https://github.com/${github[1]}/${github[2]}`;
  return webSkillUrl(homepage)?.href ?? webSkillUrl(repository)?.href;
}
async function readSkillIconFile(dir, relative, fs6, limit) {
  if (!relative || relative.split(/[\\/]/).some((part) => !part || part === "." || part === ".." || part.includes(":"))) {
    throw new Error("\u56FE\u6807\u8DEF\u5F84\u5FC5\u987B\u5728\u6280\u80FD\u76EE\u5F55\u5185");
  }
  const root = await fs6.realpath(dir);
  const file = await fs6.realpath(path4.join(dir, relative));
  const inside = path4.relative(root, file);
  if (!inside || inside === ".." || inside.startsWith(".." + path4.sep) || path4.isAbsolute(inside)) {
    throw new Error("\u56FE\u6807\u8DEF\u5F84\u8D85\u51FA\u6280\u80FD\u76EE\u5F55");
  }
  const stat = await fs6.stat(file);
  if (!stat.isFile() || stat.size === 0 || stat.size > limit) throw new Error("\u56FE\u6807\u6587\u4EF6\u4E3A\u7A7A\u3001\u4E0D\u662F\u666E\u901A\u6587\u4EF6\u6216\u8D85\u8FC7\u5927\u5C0F\u9650\u5236");
  const handle = await fs6.open(file, "r");
  try {
    const { buffer, bytesRead } = await handle.read({ buffer: Buffer.alloc(limit + 1), length: limit + 1 });
    if (!bytesRead || bytesRead > limit) throw new Error("\u56FE\u6807\u6587\u4EF6\u4E3A\u7A7A\u6216\u8D85\u8FC7\u5927\u5C0F\u9650\u5236");
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}
async function skillIconMeta(meta, dir, fs6) {
  const issueText = (error) => error.code ? `\u8BFB\u53D6\u6280\u80FD\u56FE\u6807\u5931\u8D25\uFF1A${error.code}` : error.message;
  const issues = [];
  let icon = declaredIcon(meta) ?? declaredIcon(meta.metadata);
  let emoji = declaredEmoji(meta);
  let marketId;
  let installedPage;
  const candidates = publisherIcons(meta.homepage, meta.metadata?.homepage, meta.repository, meta.metadata?.repository);
  if (!icon) {
    const rawPath = meta.icon ?? meta.logo ?? meta.metadata?.icon ?? meta.metadata?.logo;
    const relative = typeof rawPath === "string" && !/^[a-z][a-z0-9+.-]*:\/\//i.test(rawPath) ? rawPath.trim().replace(/^\.\//, "") : "";
    try {
      for (const candidate of relative ? [relative] : ["icon.png", "icon.webp", "logo.png"]) {
        const mime = SKILL_ICON_TYPES[path4.extname(candidate).toLowerCase()];
        if (!mime) throw new Error("\u6280\u80FD\u5185\u7684\u56FE\u6807\u987B\u4E3A PNG\u3001WebP\u3001JPEG \u6216 GIF");
        try {
          const data = await readSkillIconFile(dir, candidate, fs6, SKILL_ICON_BYTES);
          icon = `data:image/${mime};base64,${data.toString("base64")}`;
          break;
        } catch (error) {
          if (relative || error.code !== "ENOENT") throw error;
        }
      }
    } catch (error) {
      issues.push(issueText(error));
    }
  }
  {
    try {
      const raw = await readSkillIconFile(dir, SKILL_ICON_METADATA, fs6, 16 * 1024);
      const stored = JSON.parse(raw.toString("utf8"));
      const savedIcon = declaredIcon(stored);
      const savedEmoji = declaredEmoji(stored);
      const savedCandidates = cleanPublisherIcons(stored?.iconCandidates);
      if (stored?.marketId != null) {
        if (typeof stored.marketId !== "string" || !stored.marketId.trim() || stored.marketId.length > 512) throw new Error("\u5B89\u88C5\u6765\u6E90\u6807\u8BC6\u65E0\u6548");
        marketId = stored.marketId;
      }
      if (stored?.pageUrl != null) {
        installedPage = skillSourcePage({ pageUrl: stored.pageUrl, source: marketId?.split(":", 1)[0] });
        if (!installedPage) issues.push("\u5B89\u88C5\u65F6\u8BB0\u5F55\u7684\u6765\u6E90\u7F51\u5740\u65E0\u6548");
      }
      if (!marketId && !installedPage && !savedIcon && !savedEmoji && !savedCandidates.length) throw new Error("\u5B89\u88C5\u65F6\u8BB0\u5F55\u7684\u56FE\u6807\u4FE1\u606F\u65E0\u6548");
      if (icon && savedIcon && icon !== savedIcon) candidates.push(savedIcon);
      icon ??= savedIcon;
      emoji ??= savedEmoji;
      candidates.push(...savedCandidates);
    } catch (error) {
      if (error.code !== "ENOENT") issues.push(issueText(error));
    }
  }
  const pageUrl = installedPage ?? skillSourcePage({ marketId }) ?? [meta, meta.metadata].map((fields) => skillSourcePage(fields ?? {})).find(Boolean);
  return { icon, emoji, ...marketId ? { marketId } : {}, ...pageUrl ? { pageUrl } : {}, iconCandidates: cleanPublisherIcons(candidates), ...issues.length ? { iconIssue: issues.join("\uFF1B") } : {} };
}
var MAX_FILES_PER_SKILL = 500;
function skillRoots({ dshHome, home: home2 = os2.homedir() } = {}) {
  const base = dshHome ?? process.env.DSH_HOME ?? path4.join(home2, ".dsh");
  return [
    { id: "plugin", label: "\u672C\u63D2\u4EF6", dir: path4.join(base, "skills"), note: "\u672C\u63D2\u4EF6\u5199\u5165" },
    { id: "user", label: "\u672C\u673A", dir: path4.join(home2, ".agents", "skills"), note: "\u5BBF\u4E3B\u542F\u52A8\u65F6\u8BFB\u53D6" },
    { id: "claude", label: "Claude", dir: path4.join(home2, ".claude", "skills"), note: "Claude Code \u7684\u76EE\u5F55" },
    { id: "codex", label: "Codex", dir: path4.join(home2, ".codex", "skills"), note: "Codex CLI \u7684\u76EE\u5F55" }
  ];
}
var TRASH_DIR = "skills-trash";
function parseFrontmatter(text) {
  const source = String(text ?? "");
  const lines = source.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return {};
  let end = lines.findIndex((line, index2) => index2 > 0 && line.trim() === "---");
  if (end < 0) end = lines.length;
  const body = lines.slice(1, end);
  const out = {};
  let index = 0;
  while (index < body.length) {
    const line = body[index];
    const head = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (!head) {
      index += 1;
      continue;
    }
    const key = head[1];
    const rest = head[2].trim();
    index += 1;
    if (rest === "|" || rest === "|-" || rest === ">" || rest === ">-") {
      const block = [];
      while (index < body.length && (body[index].trim() === "" || /^\s/.test(body[index]))) {
        block.push(body[index].replace(/^\s{0,2}/, ""));
        index += 1;
      }
      out[key] = rest.startsWith("|") ? block.join("\n").trim() : block.join(" ").replace(/\s+/g, " ").trim();
      continue;
    }
    if (rest === "") {
      const indented = [];
      while (index < body.length && /^\s+\S/.test(body[index])) {
        indented.push(body[index].trim());
        index += 1;
      }
      if (indented.length === 0) continue;
      const mapping = /^([A-Za-z][\w-]*):(?:\s+(.*)|$)/;
      if (mapping.test(indented[0])) {
        const nested = {};
        for (const entry of indented) {
          const inner = mapping.exec(entry);
          if (inner) nested[inner[1]] = unquote(inner[2] ?? "");
        }
        out[key] = nested;
      } else {
        out[key] = unquote(indented.join(" "));
      }
      continue;
    }
    let value = unquote(rest);
    const folded = [];
    while (index < body.length && /^\s+\S/.test(body[index])) {
      folded.push(body[index].trim());
      index += 1;
    }
    if (folded.length > 0) value = `${value} ${folded.join(" ")}`.replace(/\s+/g, " ").trim();
    out[key] = value;
  }
  return out;
}
function unquote(value) {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replace(/\\"/g, '"').replace(/\\n/g, "\n");
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/''/g, "'");
  }
  return value;
}
async function measure(dir, fs6) {
  let files = 0;
  let bytes = 0;
  const queue = [dir];
  while (queue.length > 0 && files < MAX_FILES_PER_SKILL) {
    const current = queue.shift();
    let entries;
    try {
      entries = await fs6.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (files >= MAX_FILES_PER_SKILL) break;
      const full = path4.join(current, entry.name);
      if (entry.isDirectory()) {
        queue.push(full);
        continue;
      }
      if (!entry.isFile() || current === dir && entry.name === SKILL_ICON_METADATA) continue;
      files += 1;
      try {
        const stat = await fs6.stat(full);
        bytes += stat?.size ?? 0;
      } catch {
      }
    }
  }
  return { files, bytes };
}
async function readRoot(root, fs6) {
  const out = { ...root, skills: [], bytes: 0, error: null };
  let entries;
  try {
    entries = await fs6.readdir(root.dir, { withFileTypes: true });
  } catch (err) {
    out.error = err?.code === "ENOENT" ? "missing" : String(err?.message ?? err);
    return out;
  }
  const dirs = entries.filter((entry) => entry.isDirectory() && !entry.name.startsWith(".")).map((entry) => entry.name).sort((a, b) => a.localeCompare(b));
  for (const name2 of dirs) {
    const dir = path4.join(root.dir, name2);
    const file = path4.join(dir, SKILL_FILE);
    let text;
    let modifiedAt = null;
    try {
      text = await fs6.readFile(file, "utf8");
    } catch (error) {
      if (error?.code !== "ENOENT") {
        const issue = `${name2}/${SKILL_FILE} \u8BFB\u53D6\u5931\u8D25\uFF1A${String(error?.message ?? error)}`;
        out.error = out.error ? `${out.error}\uFF1B${issue}` : issue;
      }
      continue;
    }
    try {
      const stat = await fs6.stat(file);
      modifiedAt = stat?.mtime ? stat.mtime.toISOString() : null;
    } catch {
      modifiedAt = null;
    }
    const meta = parseFrontmatter(text);
    const { files, bytes } = await measure(dir, fs6);
    out.bytes += bytes;
    out.skills.push({
      id: `${root.id}:${name2}`,
      root: root.id,
      name: typeof meta.name === "string" && meta.name.trim() ? meta.name.trim() : name2,
      dirName: name2,
      description: typeof meta.description === "string" ? meta.description.trim() : "",
      version: typeof meta.version === "string" ? meta.version.trim() : "",
      origin: originOf(meta),
      license: typeof meta.license === "string" ? meta.license.trim() : "",
      author: typeof meta.author === "string" ? meta.author.trim() : "",
      homepage: typeof meta.homepage === "string" ? meta.homepage.trim() : "",
      ...await skillIconMeta(meta, dir, fs6),
      tools: typeof meta.tools === "string" ? meta.tools.trim() : "",
      toolsOff: meta["disable-model-invocation"] === "true",
      files,
      bytes,
      modifiedAt,
      dir
    });
  }
  return out;
}
function originOf(meta) {
  const direct = typeof meta.origin === "string" ? meta.origin.trim() : "";
  if (direct) return direct;
  const nested = meta.metadata && typeof meta.metadata === "object" ? meta.metadata : {};
  for (const key of ["origin", "source", "sourceRepo"]) {
    const value = nested[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}
async function readSkills({ dshHome, home: home2, roots, fs: fs6, now = () => Date.now() } = {}) {
  const impl = fs6 ?? (await import("node:fs")).promises;
  const wanted = roots ?? skillRoots({ dshHome, home: home2 });
  const groups = [];
  for (const root of wanted) groups.push(await readRoot(root, impl));
  const seen = /* @__PURE__ */ new Set();
  const skills = [];
  const shadowed = /* @__PURE__ */ new Map();
  const installedMarketIds = /* @__PURE__ */ new Set();
  let duplicates = 0;
  for (const group of groups) {
    for (const skill of group.skills) {
      if (skill.marketId) installedMarketIds.add(skill.marketId);
      const key = skill.marketId ? `market\0${skill.marketId}` : `local\0${skill.name}\0${skill.description}`;
      if (seen.has(key)) {
        duplicates += 1;
        shadowed.set(group.id, (shadowed.get(group.id) ?? 0) + 1);
        continue;
      }
      seen.add(key);
      if (skill.marketId) seen.add(`local\0${skill.name}\0${skill.description}`);
      skills.push(skill);
    }
  }
  skills.sort((a, b) => a.name.localeCompare(b.name));
  return {
    skills,
    installedMarketIds: [...installedMarketIds],
    duplicates,
    roots: groups.map((group) => ({
      id: group.id,
      label: group.label,
      dir: group.dir,
      note: group.note ?? "",
      count: skills.filter((skill) => skill.root === group.id).length,
      found: group.skills.length,
      folded: shadowed.get(group.id) ?? 0,
      bytes: group.bytes,
      error: group.error
    })),
    totals: {
      count: skills.length,
      files: skills.reduce((sum, skill) => sum + skill.files, 0),
      bytes: skills.reduce((sum, skill) => sum + skill.bytes, 0)
    },
    scannedAt: new Date(now()).toISOString()
  };
}
var trashMoves = /* @__PURE__ */ new Set();
async function moveToTrash({ skill, trashRoot, stamp, fs: fs6 } = {}) {
  if (!skill || typeof skill.dir !== "string" || !skill.dir) return { ok: false, error: "unknown skill" };
  if (!trashRoot || !stamp) return { ok: false, error: "no trash directory" };
  const impl = fs6 ?? (await import("node:fs")).promises;
  const folder = path4.join(String(trashRoot), String(stamp));
  let dest = path4.join(folder, `${skill.root}-${skill.dirName}`);
  const source = path4.resolve(skill.dir);
  const key = process.platform === "win32" ? source.toLowerCase() : source;
  if (trashMoves.has(key)) return { ok: false, status: 409, error: "\u6B64 Skill \u6B63\u5728\u79FB\u9664" };
  trashMoves.add(key);
  try {
    for (let suffix = 2; await statIfPresent(impl, dest); suffix += 1) {
      dest = path4.join(folder, `${skill.root}-${skill.dirName}-${suffix}`);
    }
    await impl.mkdir(folder, { recursive: true });
    try {
      await impl.rename(source, dest);
      return { ok: true, dest };
    } catch (error) {
      if (error?.code !== "EXDEV") throw error;
    }
    const retirement = await impl.mkdtemp(path4.join(path4.dirname(source), ".skill-trash-"));
    const retired = path4.join(retirement, "skill");
    try {
      await impl.rename(source, retired);
    } catch (error) {
      try {
        await impl.rmdir(retirement);
      } catch (cleanup) {
        throw new Error(`${error.message}\u3002\u4E34\u65F6\u76EE\u5F55\u672A\u6E05\u7406\uFF1A${retirement}\uFF08${cleanup.message}\uFF09`, { cause: error });
      }
      throw error;
    }
    const warnings = [];
    let stage;
    try {
      stage = await impl.mkdtemp(path4.join(folder, ".copy-"));
      const copy = path4.join(stage, "skill");
      await impl.cp(retired, copy, { recursive: true, force: false, errorOnExist: true, verbatimSymlinks: true });
      if (await statIfPresent(impl, dest)) throw new Error("\u56DE\u6536\u8DEF\u5F84\u5DF2\u88AB\u5360\u7528\uFF0C\u8BF7\u91CD\u8BD5");
      await impl.rename(copy, dest);
    } catch (error) {
      const notes = [`\u8DE8\u76D8\u56DE\u6536\u5931\u8D25\uFF1A${error.message}`];
      if (stage) {
        try {
          await impl.rm(stage, { recursive: true, force: true });
        } catch (cleanup) {
          notes.push(`\u4E34\u65F6\u76EE\u5F55\u672A\u6E05\u7406\uFF1A${stage}\uFF08${cleanup.message}\uFF09`);
        }
      }
      try {
        if (await statIfPresent(impl, source)) throw new Error("\u6E90\u76EE\u5F55\u5DF2\u91CD\u65B0\u521B\u5EFA");
        await impl.rename(retired, source);
      } catch (restore) {
        notes.push(`\u539F\u76EE\u5F55\u672A\u6062\u590D\uFF1A${restore.message}`);
        return { ok: false, dest: retired, error: notes.join("\u3002") };
      }
      try {
        await impl.rmdir(retirement);
      } catch (cleanup) {
        notes.push(`\u4E34\u65F6\u76EE\u5F55\u672A\u6E05\u7406\uFF1A${retirement}\uFF08${cleanup.message}\uFF09`);
      }
      return { ok: false, error: notes.join("\u3002") };
    }
    try {
      await impl.rm(stage, { recursive: true, force: true });
    } catch (error) {
      warnings.push(`\u56DE\u6536\u4E34\u65F6\u76EE\u5F55\u672A\u6E05\u7406\uFF1A${stage}\uFF08${error.message}\uFF09`);
    }
    try {
      await impl.rm(retirement, { recursive: true, force: true });
    } catch (error) {
      warnings.push(`\u539F\u76EE\u5F55\u7684\u4E34\u65F6\u526F\u672C\u672A\u6E05\u7406\uFF1A${retired}\uFF08${error.message}\uFF09`);
    }
    return { ok: true, dest, ...warnings.length ? { warning: warnings.join("\u3002") } : {} };
  } finally {
    trashMoves.delete(key);
  }
}
async function statIfPresent(fs6, target) {
  try {
    return await fs6.lstat(target);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return null;
  }
}
async function marketSkillTarget(root, folder, marketId, fs6) {
  const primary = path4.join(root, folder);
  const suffix = createHash("sha256").update(marketId).digest("hex").slice(0, 16);
  const alternate = path4.join(root, `${folder.slice(0, 200)}--${suffix}`);
  const occupied = await statIfPresent(fs6, alternate);
  if (occupied) throw Object.assign(new Error(`Skill \u5B89\u88C5\u76EE\u5F55\u5DF2\u5B58\u5728\uFF1A${alternate}`), { status: 409 });
  const current = await statIfPresent(fs6, primary);
  if (!current) return primary;
  if (current.isDirectory()) {
    try {
      const raw = await readSkillIconFile(primary, SKILL_ICON_METADATA, fs6, 16 * 1024);
      if (JSON.parse(raw.toString("utf8")).marketId === marketId) {
        throw Object.assign(new Error("\u8FD9\u4E2A Skill \u5DF2\u5B89\u88C5\u5230\u6240\u9009\u76EE\u5F55"), { status: 409 });
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  return alternate;
}

// lib/featured-skills.json
var featured_skills_default = [
  {
    repo: "obra/superpowers",
    root: "skills",
    ref: "22f0b463e7a5e579904dd6211a520321035526f7",
    skills: [
      {
        name: "brainstorming",
        title: "brainstorming",
        description: "You MUST use this before any creative work - creating features, building components, adding functionality, modifying behavior, or planning anything new, in software or out of it (a talk, a business, a renovation)."
      },
      {
        name: "diagnosing-superpowers",
        title: "diagnosing-superpowers",
        description: `Use when a superpowers session went wrong and your human partner wants to know why \u2014 repeated work, ignored plans, stumbles, poor results, a skill that didn't fire, "it took too long", "why is it so expensive", "what is it doing" \u2014 or wants to build a bug report for the superpowers maintainers, for the current session or a past one identified by id or path, on any harness.`
      },
      {
        name: "dispatching-parallel-agents",
        title: "dispatching-parallel-agents",
        description: "Use when facing 2+ independent tasks that can be worked on without shared state or sequential dependencies"
      },
      {
        name: "executing-plans",
        title: "executing-plans",
        description: "Use when executing an implementation plan in the current session as the implementer yourself \u2014 your human partner chose inline execution, or no subagent tool is available"
      },
      {
        name: "finishing-a-development-branch",
        title: "finishing-a-development-branch",
        description: "Use when implementation is complete, all tests pass, and you need to decide how to integrate the work"
      },
      {
        name: "receiving-code-review",
        title: "receiving-code-review",
        description: "Use when receiving code review feedback, before implementing suggestions, especially if feedback seems unclear or technically questionable - requires technical rigor and verification, not performative agreement or blind implementation"
      },
      {
        name: "requesting-code-review",
        title: "requesting-code-review",
        description: "Use when completing tasks, implementing major features, or before merging to verify work meets requirements"
      },
      {
        name: "subagent-driven-development",
        title: "subagent-driven-development",
        description: "Use when executing implementation plans with independent tasks in the current session"
      },
      {
        name: "systematic-debugging",
        title: "systematic-debugging",
        description: "Use when encountering any bug, test failure, or unexpected behavior, before proposing fixes"
      },
      {
        name: "test-driven-development",
        title: "test-driven-development",
        description: "Use when implementing any feature or bugfix, before writing implementation code"
      },
      {
        name: "using-git-worktrees",
        title: "using-git-worktrees",
        description: "Use when starting feature work that needs isolation from current workspace or before executing implementation plans - ensures an isolated workspace exists via native tools or git worktree fallback"
      },
      {
        name: "using-superpowers",
        title: "using-superpowers",
        description: "Use when starting any conversation - establishes how to find and use skills, requiring skill invocation before ANY response including clarifying questions"
      },
      {
        name: "verification-before-completion",
        title: "verification-before-completion",
        description: "Use when about to claim work is complete, fixed, or passing, before committing or creating PRs - requires running verification commands and confirming output before making any success claims; evidence before assertions always"
      },
      {
        name: "writing-plans",
        title: "writing-plans",
        description: "Use when you have a spec or requirements for a multi-step task, before touching code"
      },
      {
        name: "writing-skills",
        title: "writing-skills",
        description: "Use when creating new skills, editing existing skills, or verifying skills work before deployment"
      }
    ]
  },
  {
    repo: "openai/skills",
    root: "skills/.curated",
    ref: "49f948faa9258a0c61caceaf225e179651397431",
    skills: [
      {
        name: "aspnet-core",
        title: "aspnet-core",
        description: "Build, review, refactor, or architect ASP.NET Core web applications using current official guidance for .NET web development. Use when working on Blazor Web Apps, Razor Pages, MVC, Minimal APIs, controller-based Web APIs, SignalR, gRPC, middleware, dependency injection, configuration, authentication, authorization, testing, performance, deployment, or ASP.NET Core upgrades."
      },
      {
        name: "chatgpt-apps",
        title: "chatgpt-apps",
        description: "Build, scaffold, refactor, and troubleshoot ChatGPT Apps SDK applications that combine an MCP server and widget UI. Use when Codex needs to design tools, register UI resources, wire the MCP Apps bridge or ChatGPT compatibility APIs, apply Apps SDK metadata or CSP or domain settings, or produce a docs-aligned project scaffold. Prefer a docs-first workflow by invoking the openai-docs skill or OpenAI developer docs MCP tools before generating code."
      },
      {
        name: "cli-creator",
        title: "cli-creator",
        description: "Build a composable CLI for Codex from API docs, an OpenAPI spec, existing curl examples, an SDK, a web app, an admin tool, or a local script. Use when the user wants Codex to create a command-line tool that can run from any repo, expose composable read/write commands, return stable JSON, manage auth, and pair with a companion skill."
      },
      {
        name: "cloudflare-deploy",
        title: "cloudflare-deploy",
        description: "Deploy applications and infrastructure to Cloudflare using Workers, Pages, and related platform services. Use when the user asks to deploy, host, publish, or set up a project on Cloudflare."
      },
      {
        name: "define-goal",
        title: "define-goal",
        description: "Help the user define a concrete, measurable goal before starting work, especially when they ask to use the goal tool, create a goal, set an objective, clarify success criteria, or turn a fuzzy intention into a quantitative outcome. Use this skill for goal creation and goal refinement only; it does not manage durable snapshots, decision logs, or long-running execution artifacts."
      },
      {
        name: "figma",
        title: "figma",
        description: "Use the Figma MCP server to fetch design context, screenshots, variables, and assets from Figma, and to translate Figma nodes into production code. Trigger when a task involves Figma URLs, node IDs, design-to-code implementation, or Figma MCP setup and troubleshooting."
      },
      {
        name: "figma-code-connect-components",
        title: "figma-code-connect-components",
        description: 'Connects Figma design components to code components using Code Connect mapping tools. Use when user says "code connect", "connect this component to code", "map this component", "link component to code", "create code connect mapping", or wants to establish mappings between Figma designs and code implementations. For canvas writes via `use_figma`, use `figma-use`.'
      },
      {
        name: "figma-create-design-system-rules",
        title: "figma-create-design-system-rules",
        description: `Generates custom design system rules for the user's codebase. Use when user says "create design system rules", "generate rules for my project", "set up design rules", "customize design system guidelines", or wants to establish project-specific conventions for Figma-to-code workflows. Requires Figma MCP server connection.`
      },
      {
        name: "figma-create-new-file",
        title: "figma-create-new-file",
        description: "Create a new blank Figma file. Use when the user wants to create a new Figma design or FigJam file, or when you need a new file before calling use_figma. Handles plan resolution via whoami if needed. Usage \u2014 /figma-create-new-file [editorType] [fileName] (e.g. /figma-create-new-file figjam My Whiteboard)"
      },
      {
        name: "figma-generate-design",
        title: "figma-generate-design",
        description: "Use this skill alongside figma-use when the task involves translating an application page, view, or multi-section layout into Figma. Triggers: 'write to Figma', 'create in Figma from code', 'push page to Figma', 'take this app/page and build it in Figma', 'create a screen', 'build a landing page in Figma', 'update the Figma screen to match code'. This is the preferred workflow skill whenever the user wants to build or update a full page, screen, or view in Figma from code or a description. Discovers design system components, variables, and styles via search_design_system, imports them, and assembles screens incrementally section-by-section using design system tokens instead of hardcoded values."
      },
      {
        name: "figma-generate-library",
        title: "figma-generate-library",
        description: "Build or update a professional-grade design system in Figma from a codebase. Use when the user wants to create variables/tokens, build component libraries, set up theming (light/dark modes), document foundations, or reconcile gaps between code and Figma. This skill teaches WHAT to build and in WHAT ORDER \u2014 it complements the `figma-use` skill which teaches HOW to call the Plugin API. Both skills should be loaded together."
      },
      {
        name: "figma-implement-design",
        title: "figma-implement-design",
        description: 'Translates Figma designs into production-ready application code with 1:1 visual fidelity. Use when implementing UI code from Figma files, when user mentions "implement design", "generate code", "implement component", provides Figma URLs, or asks to build components matching Figma specs. For Figma canvas writes via `use_figma`, use `figma-use`.'
      },
      {
        name: "figma-use",
        title: "figma-use",
        description: "**MANDATORY prerequisite** \u2014 you MUST invoke this skill BEFORE every `use_figma` tool call. NEVER call `use_figma` directly without loading this skill first. Skipping it causes common, hard-to-debug failures. Trigger whenever the user wants to perform a write action or a unique read action that requires JavaScript execution in the Figma file context \u2014 e.g. create/edit/delete nodes, set up variables or tokens, build components and variants, modify auto-layout or fills, bind variables to properties, or inspect file structure programmatically."
      },
      {
        name: "gh-address-comments",
        title: "gh-address-comments",
        description: "Help address review/issue comments on the open GitHub PR for the current branch using gh CLI; verify gh auth first and prompt the user to authenticate if not logged in."
      },
      {
        name: "gh-fix-ci",
        title: "gh-fix-ci",
        description: "Use when a user asks to debug or fix failing GitHub PR checks that run in GitHub Actions; use `gh` to inspect checks and logs, summarize failure context, draft a fix plan, and implement only after explicit approval. Treat external providers (for example Buildkite) as out of scope and report only the details URL."
      },
      {
        name: "hatch-pet",
        title: "hatch-pet",
        description: "Create, repair, validate, visually QA, and package Codex-compatible animated pets and pet spritesheets from character art, generated images, company or prospect brand cues, or visual references. Use when a user wants a lightweight-worker Codex pet workflow, a non-pixel custom pet style, a prospect or company mascot pet, or a full 8x9 animated pet atlas with transparent unused cells, QA contact sheets, and pet.json packaging. This skill composes the installed $imagegen system skill for visual generation and uses bundled scripts for deterministic spritesheet assembly."
      },
      {
        name: "jupyter-notebook",
        title: "jupyter-notebook",
        description: "Use when the user asks to create, scaffold, or edit Jupyter notebooks (`.ipynb`) for experiments, explorations, or tutorials; prefer the bundled templates and run the helper script `new_notebook.py` to generate a clean starting notebook."
      },
      {
        name: "linear",
        title: "linear",
        description: "Manage issues, projects & team workflows in Linear. Use when the user wants to read, create or updates tickets in Linear."
      },
      {
        name: "migrate-to-codex",
        title: "migrate-to-codex",
        description: "Migrate supported instruction files, skills, agents, and MCP config into Codex project and global files."
      },
      {
        name: "netlify-deploy",
        title: "netlify-deploy",
        description: "Deploy web projects to Netlify using the Netlify CLI (`npx netlify`). Use when the user asks to deploy, host, publish, or link a site/repo on Netlify, including preview and production deploys."
      },
      {
        name: "notion-knowledge-capture",
        title: "notion-knowledge-capture",
        description: "Capture conversations and decisions into structured Notion pages; use when turning chats/notes into wiki entries, how-tos, decisions, or FAQs with proper linking."
      },
      {
        name: "notion-meeting-intelligence",
        title: "notion-meeting-intelligence",
        description: "Prepare meeting materials with Notion context and Codex research; use when gathering context, drafting agendas/pre-reads, and tailoring materials to attendees."
      },
      {
        name: "notion-research-documentation",
        title: "notion-research-documentation",
        description: "Research across Notion and synthesize into structured documentation; use when gathering info from multiple Notion sources to produce briefs, comparisons, or reports with citations."
      },
      {
        name: "notion-spec-to-implementation",
        title: "notion-spec-to-implementation",
        description: "Turn Notion specs into implementation plans, tasks, and progress tracking; use when implementing PRDs/feature specs and creating Notion plans + tasks from them."
      },
      {
        name: "openai-docs",
        title: "openai-docs",
        description: "Use when the user asks how to build with OpenAI products or APIs, asks about Codex itself or choosing Codex surfaces, needs up-to-date official documentation with citations, help choosing the latest model for a use case, or model upgrade and prompt-upgrade guidance; use OpenAI docs MCP tools for non-Codex docs questions, use the Codex manual helper first for broad Codex self-knowledge, and restrict fallback browsing to official OpenAI domains."
      },
      {
        name: "pdf",
        title: "pdf",
        description: "Use when tasks involve reading, creating, or reviewing PDF files where rendering and layout matter; prefer visual checks by rendering pages (Poppler) and use Python tools such as `reportlab`, `pdfplumber`, and `pypdf` for generation and extraction."
      },
      {
        name: "playwright",
        title: "playwright",
        description: "Use when the task requires automating a real browser from the terminal (navigation, form filling, snapshots, screenshots, data extraction, UI-flow debugging) via `playwright-cli` or the bundled wrapper script."
      },
      {
        name: "playwright-interactive",
        title: "playwright-interactive",
        description: "Persistent browser and Electron interaction through `js_repl` for fast iterative UI debugging."
      },
      {
        name: "render-deploy",
        title: "render-deploy",
        description: "Deploy applications to Render by analyzing codebases, generating render.yaml Blueprints, and providing Dashboard deeplinks. Use when the user wants to deploy, host, publish, or set up their application on Render's cloud platform."
      },
      {
        name: "screenshot",
        title: "screenshot",
        description: "Use when the user explicitly asks for a desktop or system screenshot (full screen, specific app or window, or a pixel region), or when tool-specific capture capabilities are unavailable and an OS-level capture is needed."
      },
      {
        name: "security-best-practices",
        title: "security-best-practices",
        description: "Perform language and framework specific security best-practice reviews and suggest improvements. Trigger only when the user explicitly requests security best practices guidance, a security review/report, or secure-by-default coding help. Trigger only for supported languages (python, javascript/typescript, go). Do not trigger for general code review, debugging, or non-security tasks."
      },
      {
        name: "security-ownership-map",
        title: "security-ownership-map",
        description: "Analyze git repositories to build a security ownership topology (people-to-file), compute bus factor and sensitive-code ownership, and export CSV/JSON for graph databases and visualization. Trigger only when the user explicitly wants a security-oriented ownership or bus-factor analysis grounded in git history (for example: orphaned sensitive code, security maintainers, CODEOWNERS reality checks for risk, sensitive hotspots, or ownership clusters). Do not trigger for general maintainer lists or non-security ownership questions."
      },
      {
        name: "security-threat-model",
        title: "security-threat-model",
        description: "Repository-grounded threat modeling that enumerates trust boundaries, assets, attacker capabilities, abuse paths, and mitigations, and writes a concise Markdown threat model. Trigger only when the user explicitly asks to threat model a codebase or path, enumerate threats/abuse paths, or perform AppSec threat modeling. Do not trigger for general architecture summaries, code review, or non-security design work."
      },
      {
        name: "sentry",
        title: "sentry",
        description: "Use when the user asks to inspect Sentry issues or events, summarize recent production errors, or pull basic Sentry health data via the Sentry CLI; perform read-only queries using the `sentry` command."
      },
      {
        name: "speech",
        title: "speech",
        description: "Use when the user asks for text-to-speech narration or voiceover, accessibility reads, audio prompts, or batch speech generation via the OpenAI Audio API; run the bundled CLI (`scripts/text_to_speech.py`) with built-in voices and require `OPENAI_API_KEY` for live calls. Custom voice creation is out of scope."
      },
      {
        name: "transcribe",
        title: "transcribe",
        description: "Transcribe audio files to text with optional diarization and known-speaker hints. Use when a user asks to transcribe speech from audio/video, extract text from recordings, or label speakers in interviews or meetings."
      },
      {
        name: "vercel-deploy",
        title: "vercel-deploy",
        description: 'Deploy applications and websites to Vercel. Use when the user requests deployment actions like "deploy my app", "deploy and give me the link", "push this live", or "create a preview deployment".'
      },
      {
        name: "winui-app",
        title: "winui-app",
        description: "Bootstrap, develop, and design modern WinUI 3 desktop applications with C# and the Windows App SDK using official Microsoft guidance, WinUI Gallery patterns, Windows App SDK samples, and CommunityToolkit components. Use when creating a brand new app, preparing a machine for WinUI, reviewing, refactoring, planning, troubleshooting, environment-checking, or setting up WinUI 3 XAML, controls, navigation, windowing, theming, accessibility, responsiveness, performance, deployment, or related Windows app design and development work."
      },
      {
        name: "yeet",
        title: "yeet",
        description: "Use only when the user explicitly asks to stage, commit, push, and open a GitHub pull request in one flow using the GitHub CLI (`gh`)."
      }
    ]
  },
  {
    repo: "vercel-labs/agent-skills",
    root: "skills",
    ref: "1a2c79d4e6c4a2283dc2c614b6538cbe1ed5ca62",
    skills: [
      {
        name: "composition-patterns",
        title: "vercel-composition-patterns",
        description: "React composition patterns that scale. Use when refactoring components with boolean prop proliferation, building flexible component libraries, or designing reusable APIs. Triggers on tasks involving compound components, render props, context providers, or component architecture. Includes React 19 API changes."
      },
      {
        name: "deploy-to-vercel",
        title: "deploy-to-vercel",
        description: 'Deploy applications and websites to Vercel. Use when the user requests deployment actions like "deploy my app", "deploy and give me the link", "push this live", or "create a preview deployment".'
      },
      {
        name: "react-best-practices",
        title: "vercel-react-best-practices",
        description: "React and Next.js performance optimization guidelines from Vercel Engineering. This skill should be used when writing, reviewing, or refactoring React/Next.js code to ensure optimal performance patterns. Triggers on tasks involving React components, Next.js pages, data fetching, bundle optimization, or performance improvements."
      },
      {
        name: "react-native-skills",
        title: "vercel-react-native-skills",
        description: "React Native and Expo best practices for building performant mobile apps. Use when building React Native components, optimizing list performance, implementing animations, or working with native modules. Triggers on tasks involving React Native, Expo, mobile performance, or native platform APIs."
      },
      {
        name: "react-view-transitions",
        title: "vercel-react-view-transitions",
        description: "Guide for implementing smooth, native-feeling animations using React's View Transition API (`<ViewTransition>` component, `addTransitionType`, and CSS view transition pseudo-elements). Use this skill whenever the user wants to add page transitions, animate route changes, create shared element animations, animate enter/exit of components, animate list reorder, implement directional (forward/back) navigation animations, or integrate view transitions in Next.js. Also use when the user mentions view transitions, `startViewTransition`, `ViewTransition`, transition types, or asks about animating between UI states in React without third-party animation libraries."
      },
      {
        name: "vercel-cli-with-tokens",
        title: "vercel-cli-with-tokens",
        description: 'Deploy and manage projects on Vercel using token-based authentication. Use when working with Vercel CLI using access tokens rather than interactive login \u2014 e.g. "deploy to vercel", "set up vercel", "add environment variables to vercel".'
      },
      {
        name: "vercel-optimize",
        title: "vercel-optimize",
        description: "Use for Vercel cost and performance optimization on deployed projects, especially Next.js, SvelteKit, Nuxt, and limited Astro apps. Collect Vercel metrics, usage, project config, and code scan results first; investigate only metric-backed candidates; produce ranked recommendations grounded in verified files and version-aware Vercel/framework docs. Trigger for Vercel bill reduction, slow or expensive routes, caching opportunities, Function Invocations, Build Minutes, Fast Data Transfer, Core Web Vitals, Bot Management, Fluid compute, or cost breakdown requests."
      },
      {
        name: "web-design-guidelines",
        title: "web-design-guidelines",
        description: 'Review UI code for Web Interface Guidelines compliance. Use when asked to "review my UI", "check accessibility", "audit design", "review UX", or "check my site against best practices".'
      },
      {
        name: "writing-guidelines",
        title: "writing-guidelines",
        description: 'Review docs/prose for Writing Guidelines compliance. Use when asked to "review my docs", "check writing style", "audit prose", "review docs voice and tone", or "check this page against the writing handbook".'
      }
    ]
  },
  {
    repo: "makenotion/skills",
    root: "skills",
    ref: "10e976aa591995fd60c75ef13beba1a8aa827fcc",
    skills: [
      {
        name: "notion-apps",
        title: "notion-apps",
        description: "Set up and scaffold Notion Apps with the Notion Apps SDK and `ntn`; use when starting a Notion App project."
      },
      {
        name: "notion-cli",
        title: "notion-cli",
        description: 'Use the Notion CLI (`ntn`) to interact with the Notion API, manage workers, and upload files. Use when the user asks to "call the Notion API", "deploy a worker", "upload a file to Notion", "create a page", "query a database", or any task involving the `ntn` command.'
      }
    ]
  },
  {
    repo: "n8n-io/skills",
    root: "skills",
    ref: "626f50fdf2934116eea2c5469339e03d2d524e83",
    skills: [
      {
        name: "n8n-agents-official",
        title: "n8n-agents-official",
        description: 'Use when the user wants an agent, assistant, or bot in n8n, or is building, editing, testing, publishing, or debugging a first-class n8n Agent. Covers choosing an Agent vs a workflow vs the AI Agent node, the Agent MCP tools (create_agent, mutate_agent, validate_agent, call_agent, publish_agent, update_agent_integration), Agent config JSON, tools and approvals, skills, sub-agents, model routing, knowledge files, vector stores, memory and sessions, Slack / Telegram / Discord / Linear / n8n Chat channels, scheduled tasks, the Message an Agent node, and reading Agent sessions and traces. Triggers on "build me an agent", "assistant", "chatbot", "Slack bot", "Telegram bot", "agent skills", "sub-agent", "knowledge base", "agent memory", "session", "Message an Agent", "publish the agent", or any Agent tool call.'
      },
      {
        name: "n8n-ai-nodes-official",
        title: "n8n-ai-nodes-official",
        description: 'Use when building or editing AI inside an n8n workflow: the AI Agent node, Text Classifier, Information Extractor, Sentiment Analysis, Summarization Chain, Basic LLM Chain, embeddings, vector stores, single one-shot LLM calls, or AI media generation (image / audio / video) via the native LangChain provider nodes. Also when a first-class n8n Agent can\'t do the job: trigger data mapped exactly into tool parameters, or memory shared across workflows. Triggers on any `@n8n/n8n-nodes-langchain.*` node, "AI Agent node", "LLM with tools", "tool calling", "fromAi", "system prompt", "memory window", "structured output", "outputParser", "RAG", "vector store", "embeddings", "classify with AI", "extract fields with LLM", "sentiment analysis", "summarize with LLM", "single LLM call", chat triggers with files, Slack / Discord / Teams / Telegram bot workflows, AI image / video / audio generation, or any multi-turn or one-shot LLM step in a workflow.'
      },
      {
        name: "n8n-binary-and-data-official",
        title: "n8n-binary-and-data-official",
        description: 'Use when handling files, images, attachments, or binary data in n8n, OR when an AI agent needs to take a user-uploaded file as tool input or return a generated file. For Data Tables (schemas, dedup, persistent state), see the separate n8n-data-tables-official skill. Triggers on "file", "image", "PDF", "attachment", "binary", "upload", "download", chat trigger with files, agent tool that needs a file, vision/multimodal, or any handling of non-JSON file data.'
      },
      {
        name: "n8n-code-nodes-official",
        title: "n8n-code-nodes-official",
        description: 'Use when the user reaches for a Code node, mentions writing JavaScript or Python in n8n, or any custom logic comes up in workflow design. Triggers on "Code node", "Code", "JavaScript", "Python", "custom logic", "transform data", "$input", "$json transformation", "loop in code", "write a function", or any time the obvious answer seems to be "just put it in code."'
      },
      {
        name: "n8n-credentials-and-security-official",
        title: "n8n-credentials-and-security-official",
        description: 'Use when handling any auth, API keys, tokens, OAuth, bearer tokens, basic auth, or secret values in n8n workflows. Triggers on "API key", "token", "bearer", "OAuth", "secret", "auth", "credentials", "Authorization header", "x-api-key", or any node configuration that mentions a third-party service.'
      },
      {
        name: "n8n-data-tables-official",
        title: "n8n-data-tables-official",
        description: 'Use when working with n8n\'s built-in Data Tables, designing schemas, inserting/updating/upserting rows, deduping, or querying. Triggers on "Data Table", "data table", `n8n-nodes-base.dataTable`, "dedup", "idempotency", "lookup", "persistent state", "store across executions", or any schema design discussion inside n8n.'
      },
      {
        name: "n8n-debugging-official",
        title: "n8n-debugging-official",
        description: `Use when an n8n workflow isn't working, errors appear, results don't match what was expected, or the user says "this isn't working." Triggers on errors, unexpected output, "it's not working", "why is this happening", "the workflow stopped", failure investigation, or any debugging context.`
      },
      {
        name: "n8n-error-handling-official",
        title: "n8n-error-handling-official",
        description: 'Use when building any webhook-triggered workflow, scheduled/production-bound workflow, wiring a per-node error output, or any workflow where silent failure would drop user-visible work. Triggers on "webhook", "respond to webhook", "API", "production", "error", "failure", "5xx", "try/catch", "error workflow", "onError", "continueErrorOutput", "error branch", "node error output", "output(1)", "main[1]", "scheduled", or any workflow that runs unattended.'
      },
      {
        name: "n8n-expressions-official",
        title: "n8n-expressions-official",
        description: 'Use when writing or reviewing n8n expressions (`{{...}}` syntax), `$json` / `$node` references, Luxon date code, or expression errors. Triggers on `{{}}`, `$json`, `$node`, `$input`, `DateTime`, `Luxon`, "expression error", "evaluating", "format date", "transform field", or any node-parameter assignment.'
      },
      {
        name: "n8n-extending-mcp-official",
        title: "n8n-extending-mcp-official",
        description: `Use when you want to expose an n8n workflow as a tool the coding agent can call. Two cases. (1) Wrap n8n API capabilities the MCP doesn't natively expose: folder deletion, project create/rename, tag rename/delete, instance metadata, credential creation. (2) Expose a general-purpose workflow as an agent tool: a workflow that calls a third-party API, runs business logic, or does any task you want the agent to invoke. Triggers on "expose as MCP tool", "build a tool for my agent", "I need to know X" where X isn't an MCP tool, "delete folder", "rename tag", or any capability gap.`
      },
      {
        name: "n8n-loops-official",
        title: "n8n-loops-official",
        description: 'Use when working with multi-item data, batches, paginated APIs, rate-limited APIs, fan-out across multiple branches, anything that needs to "do this for each", or any time the user mentions looping, iterating, batching, paging, parallelism, or "loop over items". Triggers on "loop", "iterate", "for each", "batch", "page through", "paginate", "rate limit", "process all", "fan-out", "parallel branches", "concurrency", or any node that should run once vs once-per-item.'
      },
      {
        name: "n8n-node-configuration-official",
        title: "n8n-node-configuration-official",
        description: "Use when configuring any n8n node: HTTP, webhooks, database, comms (Slack/Gmail/Discord), AI, triggers, Merge, anything. Triggers on any node-builder call (`node(...)`, `trigger(...)`, `tool(...)`, `memory(...)`, `languageModel(...)`, `ifElse(...)`, `merge(...)`, etc.), configuring a parameter, `useDataOfInput`, `numberOfInputs`, fan-in convergence, or any node-specific debugging."
      },
      {
        name: "n8n-subworkflows-official",
        title: "n8n-subworkflows-official",
        description: 'Use when building anything multi-step, anything that looks repeatable, anything the user mentions reusing, or any workflow with more than ~10 nodes. Triggers on "reuse", "I do this in another workflow", "extract", "modular", "shared logic", "subworkflow", multi-step builds, or any task that mentions logic the user has built before.'
      },
      {
        name: "n8n-workflow-lifecycle-official",
        title: "n8n-workflow-lifecycle-official",
        description: 'Use when starting, designing, organizing, finishing, or shipping an n8n workflow. Covers visual layout (sticky notes), descriptions that capture the *why*, node names, validation, testing, folders/projects, and publishing. Triggers on create_workflow_from_code, update_workflow, validate_workflow, publish_workflow, archive_workflow, "design", "lay out", "organize", "structure", "sticky", "describe this workflow", "ship", "deploy", "publish", "name this workflow", or any folder/project organization request.'
      },
      {
        name: "using-n8n-skills-official",
        title: "using-n8n-skills-official",
        description: "Use when working with n8n workflows in any capacity. The always-on protocol for the n8n-skills plugin, loaded by the SessionStart hook every session. Routes to the right skill, summarizes every n8n MCP tool (closing the deferred-description gap), and lists the cross-cutting rules."
      }
    ]
  },
  {
    repo: "expo/skills",
    root: "plugins/expo/skills",
    ref: "88d9bd79f3fa8452a778fbac65bae162c0b32ce4",
    skills: [
      {
        name: "eas-app-stores",
        title: "eas-app-stores",
        description: "Build and submit iOS and Android apps with EAS to TestFlight, the App Store, or Google Play. Supports Expo and other React Native projects, plus existing native apps. Use for eas.json setup, release pipelines, signing, app versions and build numbers, store submissions, and listing metadata. For Expo websites and API routes, use eas-hosting; for adding React Native screens to a native app, use expo-brownfield."
      },
      {
        name: "eas-hosting",
        title: "eas-hosting",
        description: "Deploy Expo websites and Expo Router API routes to EAS Hosting - export the web bundle, deploy to production or PR preview URLs, manage environment secrets and custom domains, and work within the Cloudflare Workers runtime. Also covers authoring API routes (+api.ts handlers, HTTP methods, request handling, CORS). Use when deploying an Expo web app or API routes, setting up EAS Hosting, or configuring hosting environments and domains. Not for native builds or store releases - use the eas-app-stores skill for those."
      },
      {
        name: "eas-observe",
        title: "eas-observe",
        description: "Use for anything related to EAS Observe - adding `expo-observe` to an Expo project (AppMetricsRoot/ObserveRoot HOC, markInteractive and ObserveInteractiveMarker, the useObserve hook, the Expo Router / React Navigation integrations for per-route metrics, the expo-image and Reanimated integrations, user-defined events via `Observe.logEvent`, error reporting via ObserveErrorBoundary and `Observe.reportError`, native crash reporting, source map upload for symbolicated stack traces, and runtime config such as sampleRate and dispatchInDebug), querying via the EAS CLI (`eas observe:metrics-summary`, `observe:metrics`, `observe:routes`, `observe:events`, `observe:session`, `observe:versions`, `observe:errors`, `observe:event`) or the Expo MCP `observe_*` tools, interpreting the resulting metrics (cold/warm launch, TTR, TTI, navigation cold/warm TTR, update download, and the TTI frameRate/device/network params for triaging slow startups), or shipping an Observe integration inside a third-party package."
      },
      {
        name: "eas-simulator",
        title: "eas-simulator",
        description: "Run and control a user's app on a remote iOS/Android simulator with Expo Simulators (also called EAS Simulator). Read before running any `eas simulator:*` commands - it has the current syntax and workflow. Use whenever the user needs a simulator they can't run locally - 'run my app on a cloud simulator', 'use eas simulator to run/install/screenshot my app', 'I'm on Linux/Cursor and need an iOS device', 'no sim on this box / headless CI', 'let an agent click through my app and screenshot it', 'test my dev build on a remote sim with live reload', 'stream a sim to my browser' - even when they don't say 'Expo Simulators', 'EAS Simulator', or 'cloud'. On a host WITHOUT a local simulator (Linux, CI, cloud sandbox) it's the default; on macOS, do NOT auto-trigger for a plain 'run on the simulator' - use it only for a cloud/remote/shareable sim, an iOS version they lack, or an agent-driven session. NOT for local sims (expo run:ios, Xcode, Android Studio), EAS Build/Update, web preview, or physical devices."
      },
      {
        name: "eas-update",
        title: "eas-update",
        description: "Configure and use EAS Update for over-the-air JavaScript and asset updates with expo-updates and EAS CLI. Use when setting up OTA updates, configuring branches/channels/runtime versions, publishing to preview/staging/production, testing updates, or debugging why an installed build still shows old code. Load for TestFlight, preview, or production updates that do not appear, including questions about cold launches or reopening the app. Not for update health metrics; use eas-update-insights for adoption, crashes, and rollout monitoring."
      },
      {
        name: "eas-update-insights",
        title: "eas-update-insights",
        description: "Check the health of published EAS Update: crash rates, install/launch counts, unique users, payload size, and the split between embedded and OTA users per channel. Use when the user asks how an update is performing, whether a rollout is healthy, how many users are on the embedded build vs OTA, or wants to gate CI on update health."
      },
      {
        name: "eas-workflows",
        title: "eas-workflows",
        description: "Helps understand and write EAS workflow YAML files for Expo projects. Use this skill when the user asks about CI/CD or workflows in an Expo or EAS context, mentions .eas/workflows/, or wants help with EAS build pipelines or deployment automation."
      },
      {
        name: "expo-animation",
        title: "expo-animation",
        description: "Build animations in React Native and Expo, making the decisions in the order that determines whether they feel right \u2014 should it animate, which thread it runs on, which properties, spring or timing, how the gesture hands off, how it degrades. Writes the implementation with Reanimated, Gesture Handler, Expo Router and expo-haptics. Use when animating anything in an Expo app, adding gestures, sheets, screen transitions, press feedback or haptics, or fixing motion that stutters on device. For web animation use `animate`."
      },
      {
        name: "expo-app-clip",
        title: "expo-app-clip",
        description: "Add an iOS App Clip target to an Expo app. Use when the user mentions App Clip, AASA, apple-app-site-association, appclips, smart app banner, or wants to ship a lightweight iOS Clip invoked from a URL alongside their parent app."
      },
      {
        name: "expo-brownfield",
        title: "expo-brownfield",
        description: "Integrate Expo and React Native into an existing native iOS or Android app. Use for brownfield, embedding a React Native screen in SwiftUI/UIKit or Kotlin, or AAR/XCFramework packaging. Covers isolated and integrated approaches. For building or distributing a purely native app with EAS, use eas-app-stores."
      },
      {
        name: "expo-data-fetching",
        title: "expo-data-fetching",
        description: "Implement or debug data fetching in Expo apps. Use for fetch API calls, React Query, SWR, authenticated requests, caching, retries, offline support, loading and error states, or Expo Router data loaders (useLoaderData)."
      },
      {
        name: "expo-design-system",
        title: "expo-design-system",
        description: "Create or extend an Expo app's theme, design tokens, and reusable component conventions. Use for inconsistent styling, generic or AI-generated screens, component libraries, or audits of hardcoded colors, spacing, and fonts. Works with existing NativeWind, Tamagui, Restyle, and Unistyles systems. For platform styling and native controls, use expo-native-ui; for new app folder layouts, use expo-project-structure."
      },
      {
        name: "expo-dev-client",
        title: "expo-dev-client",
        description: "Build and distribute Expo development clients locally or via TestFlight for internal testing. For production TestFlight releases and store submission, use the eas-app-stores skill."
      },
      {
        name: "expo-dom",
        title: "expo-dom",
        description: "Use Expo DOM components to run web code in a webview on native and as-is on web. Migrate web code to native incrementally. For the end-to-end migration of a whole web app, use the expo-web-to-native skill."
      },
      {
        name: "expo-examples",
        title: "expo-examples",
        description: "Expo's official example projects - the expo/examples repo of ~70 `with-*` integrations (Stripe, Clerk, Supabase, OpenAI, maps, Reanimated, SQLite, Skia, NativeWind, and more). Use when integrating a third-party library or service into an existing Expo app and you want the canonical, version-matched pattern to adapt, or when scaffolding a new project from one with `npx create-expo --example`."
      },
      {
        name: "expo-module",
        title: "expo-module",
        description: "Guide for creating and writing Expo native modules and views using the Expo Modules API (Swift, Kotlin, TypeScript). Covers module definition DSL, native views, shared objects, config plugins, lifecycle hooks, autolinking, and type system. Use when building or modifying native modules for Expo. Not for migrating an existing Swift module from the definition DSL to the Expo Modules API 2.0 macros; use expo-migrate-module (from the expo-experiments plugin) for that."
      },
      {
        name: "expo-native-ui",
        title: "expo-native-ui",
        description: "Build beautiful, native-feeling Expo screens. Covers Apple HIG styling, semantic colors, native controls, SF Symbols, media, visual effects, gradients, storage, and responsive layout. For routing and navigation, use the expo-router skill; for motion and animation, use the expo-animation skill."
      },
      {
        name: "expo-overview",
        title: "expo-overview",
        description: "Entry point for Expo and EAS tasks. Load first when the request mentions Expo, EAS, Expo Go, or an expo-* package, or the project has an expo dependency. Identify the goal, apply shared SDK and setup rules, and select the relevant skill. Includes fully specified tasks; excludes React Native projects without Expo or EAS signals."
      },
      {
        name: "expo-project-structure",
        title: "expo-project-structure",
        description: "Folder structure for a new Expo app. Use when scaffolding or laying out a new Expo project with Expo Router, or deciding where a file should live in one. For new projects only \u2014 never restructure an existing app to match."
      },
      {
        name: "expo-router",
        title: "expo-router",
        description: "Navigation and routing for Expo Router. Covers file-based routes, groups and dynamic routes, folder organization, Link with previews and context menus, native Stack, page titles, modals and form sheets, NativeTabs, headers and toolbars, and header search bars."
      },
      {
        name: "expo-ui",
        title: "expo-ui",
        description: "Build native UI with the @expo/ui package: real SwiftUI on iOS and Jetpack Compose on Android. Default to @expo/ui for sheets (BottomSheet), pickers, sliders, toggles, menus, and grouped-form sections \u2014 do NOT reach for Reanimated, @gorhom/bottom-sheet, or RN built-in Picker/Switch; use @expo/ui instead. Fall back to RN built-ins only when @expo/ui is missing the component. NOTE: @expo/ui List renders native grouped rows like an iOS Settings screen \u2014 it is NOT a virtualized list; use FlatList/FlashList for large datasets. Covers universal components (Host, Column, Row, Button, Text, List, BottomSheet, FieldGroup, Switch, Slider, Picker, Menu), drop-in replacements for RN community libraries, and platform-specific SwiftUI/Jetpack Compose trees. Not for Expo Router navigation, Reanimated, or data fetching."
      },
      {
        name: "expo-upgrade",
        title: "expo-upgrade",
        description: "Guidelines for upgrading Expo SDK versions and fixing dependency issues"
      },
      {
        name: "expo-web-to-native",
        title: "expo-web-to-native",
        description: "Migrate an existing web React app to a native iOS/Android app with Expo. Use when the user wants to turn a website into a mobile app, port a Next.js/Vite/CRA React codebase to React Native, reuse web code on native incrementally, or asks how web idioms (the DOM, CSS, React Router, localStorage, window) map to native. This is the end-to-end migration guide; use the `expo-dom` skill for the DOM-component mechanism itself."
      }
    ]
  },
  {
    repo: "ChromeDevTools/chrome-devtools-mcp",
    root: "skills",
    ref: "bdecb63549a0b1a6d073fdf69ecc264bf46adda9",
    skills: [
      {
        name: "a11y-debugging",
        title: "a11y-debugging",
        description: "Uses Chrome DevTools MCP for accessibility (a11y) debugging and auditing based on web.dev guidelines. Use when testing semantic HTML, ARIA labels, focus states, keyboard navigation, tap targets, and color contrast."
      },
      {
        name: "chrome-devtools",
        title: "chrome-devtools",
        description: "Uses Chrome DevTools via MCP for efficient debugging, troubleshooting and browser automation. Use when debugging web pages, automating browser interactions, analyzing performance, or inspecting network requests. This skill does not apply to `--slim` mode (MCP configuration)."
      },
      {
        name: "chrome-devtools-cli",
        title: "chrome-devtools-cli",
        description: "Use this skill to write shell scripts or run shell commands to automate tasks in the browser or otherwise use Chrome DevTools via CLI."
      },
      {
        name: "cookie-debugging",
        title: "cookie-debugging",
        description: "Uses Chrome DevTools MCP for inspecting, debugging, and testing cookies, session state, authentication issues, and cookie consent compliance. Use when diagnosing 401/403 errors, authentication redirects, session expiration, Cookie/Set-Cookie header issues, cookie banner consent conformance, or third-party cookie/SameSite/Partitioned cookie warnings."
      },
      {
        name: "debug-optimize-lcp",
        title: "debug-optimize-lcp",
        description: `Guides debugging and optimizing Largest Contentful Paint (LCP) using Chrome DevTools MCP tools. Use this skill whenever the user asks about LCP performance, slow page loads, Core Web Vitals optimization, or wants to understand why their page's main content takes too long to appear. Also use when the user mentions "largest contentful paint", "page load speed", "CWV", or wants to improve how fast their hero image or main content renders.`
      },
      {
        name: "inspect-in-devtools",
        title: "inspect-in-devtools",
        description: "Use this skill to connect to the Chrome DevTools UI for interactive debugging, UI/UX review, Q&A, showing elements/network requests/panels to the user, inspecting the user's current DevTools selection, and addressing or polling for DevTools UI comment threads."
      },
      {
        name: "memory-leak-debugging",
        title: "memory-leak-debugging",
        description: "Diagnoses and resolves memory leaks in JavaScript/Node.js applications. Use when a user reports high memory usage, OOM errors, or wants to capture, compare, or inspect heap snapshots with Chrome DevTools MCP memory tools."
      },
      {
        name: "troubleshooting",
        title: "troubleshooting",
        description: "Uses Chrome DevTools MCP and documentation to troubleshoot connection and target issues. Trigger this skill when list_pages, new_page, or navigate_page fail, or when the server initialization fails."
      }
    ]
  },
  {
    repo: "supabase/agent-skills",
    root: "skills",
    ref: "c9be0e931b7930f7d02126d04774d904c381e7d7",
    skills: [
      {
        name: "supabase",
        title: "supabase",
        description: "Use when doing ANY task involving Supabase. Triggers: Supabase products (Database, Auth, Edge Functions, Realtime, Storage, Vectors, Cron, Queues); client libraries and SSR integrations (supabase-js, @supabase/ssr) in Next.js, React, SvelteKit, Astro, Remix; auth issues (login, logout, sessions, JWT, cookies, getSession, getUser, getClaims, RLS); Supabase CLI or MCP server; schema changes, migrations, declarative schemas, security audits, Postgres extensions (pg_graphql, pg_cron, pg_vector); debugging and troubleshooting errors or unexpected behavior on Supabase projects (HTTP errors, Postgres errors, RLS surprises, permission denied, schema cache issues, timeouts, Edge Function crashes, Realtime drops, Storage failures) and reading or querying logs (Logs Explorer, ClickHouse)."
      },
      {
        name: "supabase-postgres-best-practices",
        title: "supabase-postgres-best-practices",
        description: "Postgres best practices maintained by Supabase, for Postgres running anywhere. Load this skill BEFORE writing or changing anything that lives in a Postgres database: creating or altering tables and columns (including choosing column types), schema design, migrations and declarative schema files, RLS policies and the tests that verify them, indexes, triggers, database functions, queues and scheduled jobs (pg_cron, pgmq), vector/semantic search (pgvector), and restoring dumps (pg_restore) or importing data. Also load it when diagnosing slow queries, high CPU, timeouts, EXPLAIN plans, connection exhaustion, locking, bloat, or rows visible to the wrong user or tenant. This is not just a performance guide \u2014 schema, migration, security, and SQL authoring tasks need these rules too, even for a one-column change or a single query."
      }
    ]
  },
  {
    repo: "stripe/ai",
    root: "skills",
    ref: "119bc4a8de4eb4370db1f5838275bc9e7a0d8e4a",
    skills: [
      {
        name: "connect-recommend",
        title: "connect-recommend",
        description: "Use this skill when the user asks about Stripe Connect configuration, charge patterns, Dashboard access, or how to get started with Connect, is building a marketplace, platform, multi-vendor store, gig platform, or subscription platform, needs to pay out sellers, vendors, or providers, mentions split payments, revenue sharing, multi-party payments, or similar payment distribution concepts, provides a company URL or business description for a recommendation, builds SaaS that routes money between parties (for example, POS, booking, invoicing \u2014 not operational SaaS without payment routing), asks about onboarding or KYC for merchants, sellers, and vendors, mentions connected account Dashboard or responsibility configurations, or asks about payment flows, white-label payments, or embedded payments."
      },
      {
        name: "connect-required-verification-information",
        title: "connect-required-verification-information",
        description: "Use this skill when the user asks what information a Stripe Connect connected account must provide for verification, onboarding, KYC, or account requirements; when they need to compare requirements between connected-account setups; or when they ask which verification fields, documents, or business details are required for a particular platform country, account country, business type, dashboard, service agreement, or capability."
      },
      {
        name: "metronome",
        title: "metronome",
        description: "Guides Metronome usage-based billing integration decisions \u2014 event ingestion (single and batch, idempotency, billable metrics), contract design (rate cards, overrides, dimensional pricing, products), invoicing lifecycle (grace periods, finalization, Stripe sync), credit and commit management (prepaid, postpaid, thresholds, auto-recharge), and Stripe integration (arrears invoicing, tax providers, line item limits). Use when building, modifying, or reviewing any Metronome integration \u2014 including ingesting usage events, creating customers, contracts, or rate cards, designing billable metric group keys, managing credits and commits, configuring invoicing, syncing invoices with Stripe Billing, billing AI applications for token usage, setting up self-serve (PLG) pricing, reviewing customer health, commit burn, portfolios, or renewals, or migrating from Stripe Billing Meters to Metronome."
      },
      {
        name: "stripe-apps",
        title: "stripe-apps",
        description: "Build, modify, or review Stripe Apps and extensions using the relevant documentation and reference guides. Use for custom Stripe Dashboard UI, stripe-app.yaml, @stripe/ui-extension-sdk, @stripe/extensibility-sdk, script extensions, extension interfaces, custom workflow actions, and apps that authenticate to Stripe or react to events. Also use when deciding whether a Stripe extension can support the user's billing or workflow requirements."
      },
      {
        name: "stripe-best-practices",
        title: "stripe-best-practices",
        description: "Guides Stripe integration decisions across development and test environment planning (separate sandboxes vs the shared test mode sandbox), API selection (Checkout Sessions vs PaymentIntents), Connect platform setup (Accounts v2, controller properties), billing/subscriptions, tax and registrations (Stripe Tax, automatic_tax, product tax codes), Treasury financial accounts, integration options (Checkout, Payment Element), migrating from deprecated Stripe APIs, and security best practices (API key management, API key permissions, webhooks, OAuth). Use when planning, building, modifying, testing, or reviewing any Stripe integration, including choosing a development environment, accepting payments, building marketplaces, integrating Stripe, processing payments, setting up subscriptions, collecting sales tax, VAT, or GST, creating connected accounts, or implementing secure key handling."
      },
      {
        name: "stripe-bfcm-dashboard",
        title: "stripe-bfcm-dashboard",
        description: `Builds a Black Friday and Cyber Monday (BFCM) season dashboard of payments, customers, and recurring revenue from the connected Stripe MCP account, as a hosted dashboard or artifact where the agent's tools support one, otherwise as one HTML file. For the 2026 BFCM season only. Use when a merchant asks for a BFCM, Black Friday, Cyber Monday, holiday, holiday sales, or peak-season dashboard, such as "build me a holiday dashboard" or "build me a Cyber Monday dashboard," even without the word BFCM.`
      },
      {
        name: "stripe-directory",
        title: "stripe-directory",
        description: `Identifies external providers, merchants, nonprofits, platforms, APIs, and software services, and resolves the documented way to engage them \u2014 to pay, donate, subscribe, book, provision, or integrate with them. MUST be used BEFORE web search, model memory, or any other directory/vendor-lookup skill for ANY request that requires selecting, finding, or engaging an external provider or organization \u2014 whether a specific one is named ("pay my Twilio bill"), implied ("donate to the Red Cross"), or only a category is stated ("set up a mailing client", "I need a database", "find me a CRM"). Directory supplies verified recipients and their documented payment or engagement path. Results are ranked by agent-readiness (how reliably an agent can complete the interaction), relevance and popularity. Don't treat this as a search-only tool. Examples: "setup a database", "find hosting", "pay X", "use Twilio", "donate $50 to the Red Cross", "book a table at Y", "subscribe to a CRM".`
      },
      {
        name: "stripe-docs",
        title: "stripe-docs",
        description: "Use when the user or agent needs to read, search, or look up Stripe documentation or API reference. Prefer this over curl or WebFetch for any docs.stripe.com content. Use to fetch gated documentation."
      },
      {
        name: "stripe-implementation-planner",
        title: "stripe-implementation-planner",
        description: "Plans Stripe product selection and integration architecture for an initial Stripe setup or a material expansion of an existing setup. Use when the user needs personalized recommendations based on their business model, payment models, sales channels, geography, or platform requirements, including requests to plan and build an integration. Don't use for API-version upgrades, product-availability questions, existing-integration debugging, webhook troubleshooting, narrow code changes, product explanations, PR review alone, unrelated implementation planning, or when the user explicitly asks to skip planning."
      },
      {
        name: "stripe-pay",
        title: "stripe-pay",
        description: "Helps users send funds to another Stripe business, transfer money to a Stripe Profile handle or network ID, or ask whether an agent can pay a Stripe business. Use Stripe Directory to find or verify a recipient when the user doesn't provide an exact Stripe Profile handle or network ID."
      },
      {
        name: "stripe-projects",
        title: "stripe-projects",
        description: `Use when the user wants to provision infrastructure or third-party services using Stripe Projects. Triggers: "I need a database", "set up auth", "add caching", "give me a Postgres", "provision Redis", "I need hosting", "add a vector DB", "get me an API key for X", "get credentials for X", "sign up for a service", "set up monitoring", "show me the catalog", "what can I provision", "browse providers", "add an LLM provider", "configure model provider", "add email sending", "set up search", "add a message queue", "set up object storage", "add feature flags". Also trigger when the user asks how to get an API key or credentials for any third-party service \u2014 don't tell them to sign up manually; check the Projects catalog first. Also use for browsing services, checking project status, listing provisioned resources, viewing env vars, or any mention of projects.dev or adding/provisioning/connecting a cloud service.`
      }
    ]
  },
  {
    repo: "google-gemini/gemini-skills",
    root: "skills",
    ref: "c4d0c62c1240e08a90546186bf320600ab6a039a",
    skills: [
      {
        name: "gemini-api-cli",
        title: "gemini-api-cli",
        description: "Call the Gemini API from the shell with gemini-api. Use for media generation (images, TTS, music, video), file and YouTube analysis, audio/video transcription, Deep Research, and sandboxed agents."
      },
      {
        name: "gemini-api-dev",
        title: "gemini-api-dev",
        description: "Use this skill when writing code that calls the Gemini API for text generation, multi-turn chat, multimodal understanding, image generation, video generation, speech generation (TTS), voice design, voice replication, streaming responses, background research tasks, function calling, structured output, calibrated decisions (yes/no, choice, rubric scoring), or migrating from the old generateContent API. Covers SDK usage and best practices for Gemini models and agents in Python and TypeScript."
      },
      {
        name: "gemini-live-api-dev",
        title: "gemini-live-api-dev",
        description: "Use this skill when building real-time, bidirectional streaming applications with the Gemini Live API, or migrating legacy Live models (2.0/2.5/3.1) to Gemini 3.8 Live. Covers WebSocket-based audio/video/text streaming, voice activity detection (VAD), background reasoning (extended thinking), asynchronous function calling, session management, ephemeral tokens, live transcription, and live translation. SDKs covered - google-genai (Python), @google/genai (JavaScript/TypeScript)."
      },
      {
        name: "gemini-omni-flash-api",
        title: "gemini-omni-flash-api",
        description: "Use this skill for generative video editing, text-to-video, image- and video-referenced video generation, first-frame-to-video, first-and-last-frame transitions, and video extensions using Gemini Omni 1.2 Flash (gemini-omni-1.2-flash) via the official google-genai SDK. Includes workflows for pre-processing/optimizing high-resolution or long source videos with ffmpeg, stripping audio for full sound regeneration, and handling turn-by-turn video editing and parallel execution."
      }
    ]
  },
  {
    repo: "huggingface/skills",
    root: "skills",
    ref: "5291c2b9365e06b175dc04817610c778623f4836",
    skills: [
      {
        name: "hf-cli",
        title: "hf-cli",
        description: "Hugging Face Hub CLI (`hf`) for downloading, uploading, and managing models, datasets, spaces, buckets, repos, papers, jobs, and more on the Hugging Face Hub. Use when: handling authentication; managing local cache; managing Hugging Face Buckets; running or scheduling jobs on Hugging Face infrastructure; managing Hugging Face repos; discussions and pull requests; browsing models, datasets and spaces; reading, searching, or browsing academic papers; managing collections; querying datasets; configuring spaces; setting up webhooks; or deploying and managing HF Inference Endpoints. Make sure to use this skill whenever the user mentions 'hf', 'huggingface', 'Hugging Face', 'huggingface-cli', or 'hugging face cli', or wants to do anything related to the Hugging Face ecosystem and to AI and ML in general. Also use for cloud storage needs like training checkpoints, data pipelines, or agent traces. Use even if the user doesn't explicitly ask for a CLI command. Replaces the deprecated `huggingface-cli`."
      },
      {
        name: "hf-cloud-aws-context-discovery",
        title: "hf-cloud-aws-context-discovery",
        description: `Discover the user's local AWS context (active profile, region, account ID, caller identity) at the start of any AWS task. Use this skill before any other AWS work \u2014 deploying to SageMaker, creating resources, calling AWS APIs, or anything that touches an AWS account. Use it especially when the user has not specified a region or profile explicitly, when they say things like "use my AWS account", "deploy to AWS", "use my profile", or when about to make any AWS CLI or SDK call. Never guess the region or account ID \u2014 always use this skill to read it from the local configuration first.`
      },
      {
        name: "hf-cloud-python-env-setup",
        title: "hf-cloud-python-env-setup",
        description: 'Set up an isolated Python environment for SageMaker / AWS work, with the right Python version and current boto3. Use this skill whenever Python code will be executed for a SageMaker deployment, training job, or any AWS automation \u2014 including when about to run `pip install`, when about to invoke `boto3`, when creating or activating a virtualenv, or when the user asks to "set up the environment". Never use system Python and never `pip install` into it. Always isolate. This skill prevents the most common failure modes: wrong Python version, dependency conflicts, and stale SDKs.'
      },
      {
        name: "hf-cloud-sagemaker-deployment-planner",
        title: "hf-cloud-sagemaker-deployment-planner",
        description: 'Plan and coordinate the deployment of a model to Amazon SageMaker AI. Use this skill whenever the user wants to deploy, host, serve, or expose a model on SageMaker or AWS \u2014 including phrases like "deploy a model", "host this LLM on AWS", "serve this embedding model", "deploy a reranker", "deploy a text-to-image / diffusion model", "host this for async inference", "create an endpoint", "serve my fine-tuned model", or any request that involves making a model available for inference on AWS. Use this even when the user is vague (e.g. "I just want to get this running on AWS, you figure it out"). Works for text-generation LLMs, embedding models, rerankers, classifiers, text-to-image / diffusion models \u2014 picks the right serving stack and chooses between real-time and async inference. This is the entry-point skill for SageMaker deployment work \u2014 it asks clarifying questions, picks a deployment pathway, and coordinates the other deployment skills.'
      },
      {
        name: "hf-cloud-sagemaker-iam-preflight",
        title: "hf-cloud-sagemaker-iam-preflight",
        description: "Ensure a usable SageMaker execution role exists before deploying or training. Use this skill whenever about to create a SageMaker endpoint, model, training job, or any resource that requires an execution role. Use it especially when the user has not provided a role ARN explicitly, when scripts are about to call `iam:CreateRole`, or when an AccessDenied error mentions an IAM action. Never blindly call `iam:CreateRole` \u2014 always check for existing roles first. This skill prevents the most common SageMaker deployment failure: trying to create IAM resources from an SSO principal that has no IAM write permissions."
      },
      {
        name: "hf-cloud-sagemaker-production-defaults",
        title: "hf-cloud-sagemaker-production-defaults",
        description: "Create a SageMaker endpoint (real-time, real-time scale-to-zero, or async) with autoscaling, CloudWatch alarms, and tagging enabled by default. Use this skill whenever about to create a SageMaker endpoint, write deployment code that calls `create_endpoint`, or finalize a deployment after the image URI and IAM role are known. Provides deploy.py for real-time endpoints, deploy_ic.py for real-time endpoints that scale to zero instances via inference components, and deploy_async.py for async endpoints (also scale-to-zero). This is the last step in the SageMaker deployment workflow. Never generate a bare `create_endpoint` call without these defaults \u2014 endpoints without autoscaling or alarms are demos, not deployments."
      },
      {
        name: "hf-cloud-serving-image-selection",
        title: "hf-cloud-serving-image-selection",
        description: 'Pick the right serving container for a SageMaker model deployment and find its current image URI. Use this skill whenever about to deploy a model to a SageMaker endpoint and an image URI needs to be chosen \u2014 including when the user says "deploy this LLM", "host this HuggingFace model", "serve this fine-tuned model", "deploy this embedding model", "host a reranker", "serve a sentence-transformers model", or when about to hardcode any container URI in deployment code. HuggingFace-curated Deep Learning Containers are ALWAYS preferred: HuggingFace vLLM (LLMs and generative rerankers), HuggingFace vLLM-Omni (multimodal), TEI (embeddings/cross-encoder rerankers), HF Inference Toolkit (other transformers). Generic images (AWS vLLM, DJL-LMI, SGLang) are used only when no HuggingFace image is compatible \u2014 never merely because they carry a newer version. Never hardcode a container URI from memory and never default to TGI. Prevents stale-image failures and wrong-region URIs.'
      },
      {
        name: "hf-mem",
        title: "hf-mem",
        description: "Estimate the GPU memory needed to run a Hugging Face model (weights, KV cache and inference overhead) and whether it fits on given GPUs, without downloading it. Use when asked how much VRAM a model needs, whether it fits on a GPU, the longest context that fits, or which GGUF quantization to pick."
      },
      {
        name: "huggingface-best",
        title: "huggingface-best",
        description: `Use when the user asks about finding the best, top, or recommended model for a task, wants to know what AI model to use, or wants to compare models by benchmark scores. Triggers on: "best model for X", "what model should I use for", "top models for [task]", "which model runs on my laptop/machine/device", "recommend a model for", "what LLM should I use for", "compare models for", "what's state of the art for", or any question about choosing an AI model for a specific use case. Always use this skill when the user wants model recommendations or comparisons, even if they don't explicitly mention HuggingFace or benchmarks.`
      },
      {
        name: "huggingface-community-evals",
        title: "huggingface-community-evals",
        description: "Run evaluations for Hugging Face Hub models using inspect-ai and lighteval on local hardware. Use for backend selection, local GPU evals, and choosing between vLLM / Transformers / accelerate. Not for HF Jobs orchestration, model-card PRs, .eval_results publication, or community-evals automation."
      },
      {
        name: "huggingface-datasets",
        title: "huggingface-datasets",
        description: "Use this skill for Hugging Face Dataset Viewer API workflows that fetch subset/split metadata, paginate rows, search text, apply filters, download parquet URLs, and read size or statistics."
      },
      {
        name: "huggingface-gradio",
        title: "huggingface-gradio",
        description: "Build Gradio web UIs and demos in Python. Use when creating or editing Gradio apps, components, event listeners, layouts, or chatbots."
      },
      {
        name: "huggingface-llm-trainer",
        title: "huggingface-llm-trainer",
        description: "Train or fine-tune language and vision models using TRL (Transformer Reinforcement Learning) or Unsloth with Hugging Face Jobs infrastructure. Covers SFT, DPO, GRPO and reward modeling training methods, plus GGUF conversion for local deployment. Includes guidance on the TRL Jobs package, UV scripts with PEP 723 format, dataset preparation and validation, hardware selection, cost estimation, Trackio monitoring, Hub authentication, model selection/leaderboards and model persistence. Use for tasks involving cloud GPU training, GGUF conversion, or when users mention training on Hugging Face Jobs without local GPU setup."
      },
      {
        name: "huggingface-local-models",
        title: "huggingface-local-models",
        description: "Use to select models to run locally with llama.cpp and GGUF on CPU, Mac Metal, CUDA, or ROCm. Covers finding GGUFs, quant selection, running servers, exact GGUF file lookup, conversion, and OpenAI-compatible local serving."
      },
      {
        name: "huggingface-lora-space-builder",
        title: "huggingface-lora-space-builder",
        description: "Build and publish a Gradio demo on Hugging Face Spaces for a user-provided LoRA. Use when someone asks to create, generate, ship, or publish a Space, demo, Gradio app, or playground for a LoRA \u2014 including LoRAs for Qwen-Image, Qwen-Image-Edit, LTX-Video, Wan, FLUX, SDXL, or other diffusion base models. Also triggers when someone describes a LoRA they trained or hosts on the Hub and wants to share it. Covers picking the right base pipeline and `diffusers` inference recipe, designing a UI tailored to the LoRA's task and inputs (Union/multi-task control, edit, video, image, etc.), respecting model-card recommendations (trigger words, steps, guidance, LoRA scale, example inputs), and shipping to ZeroGPU hardware as a private Space by default."
      },
      {
        name: "huggingface-paper-publisher",
        title: "huggingface-paper-publisher",
        description: "Publish and manage research papers on Hugging Face Hub. Supports creating paper pages, linking papers to models/datasets, claiming authorship, and generating professional markdown-based research articles."
      },
      {
        name: "huggingface-papers",
        title: "huggingface-papers",
        description: "Look up and read Hugging Face paper pages in markdown, and use the papers API for structured metadata such as authors, linked models/datasets/spaces, Github repo and project page. Use when the user shares a Hugging Face paper page URL, an arXiv URL or ID, or asks to summarize, explain, or analyze an AI research paper."
      },
      {
        name: "huggingface-spaces",
        title: "huggingface-spaces",
        description: "Build, deploy, and maintain applications on Hugging Face Spaces \u2014 Gradio / Docker / Static SDKs, ZeroGPU and dedicated hardware, model loading, debugging, buckets, inference providers, community grants. Use whenever the user asks to create or host an app on Hugging Face, port code onto ZeroGPU, fix a Space that won't build or run, or otherwise work with `hf spaces \u2026`, `@spaces.GPU`, Space README frontmatter, or the `spaces` Python package."
      },
      {
        name: "huggingface-tool-builder",
        title: "huggingface-tool-builder",
        description: "Use this skill when the user wants to build tool/scripts or achieve a task where using data from the Hugging Face API would help. This is especially useful when chaining or combining API calls or the task will be repeated/automated. This Skill creates a reusable script to fetch, enrich or process data."
      },
      {
        name: "huggingface-trackio",
        title: "huggingface-trackio",
        description: "Track and visualize ML training experiments with Trackio. Use when logging metrics during training (Python API), firing alerts for training diagnostics, or retrieving/analyzing logged metrics (CLI). Supports real-time dashboard visualization, alerts with webhooks, HF Space syncing, and JSON output for automation."
      },
      {
        name: "huggingface-vision-trainer",
        title: "huggingface-vision-trainer",
        description: "Trains and fine-tunes vision models for object detection (D-FINE, RT-DETR v2, DETR, YOLOS), image classification (timm models \u2014 MobileNetV3, MobileViT, ResNet, ViT/DINOv3 \u2014 plus any Transformers classifier), and SAM/SAM2 segmentation using Hugging Face Transformers on Hugging Face Jobs cloud GPUs. Covers COCO-format dataset preparation, Albumentations augmentation, mAP/mAR evaluation, accuracy metrics, SAM segmentation with bbox/point prompts, DiceCE loss, hardware selection, cost estimation, Trackio monitoring, and Hub persistence. Use when users mention training object detection, image classification, SAM, SAM2, segmentation, image matting, DETR, D-FINE, RT-DETR, ViT, timm, MobileNet, ResNet, bounding box models, or fine-tuning vision models on Hugging Face Jobs."
      },
      {
        name: "huggingface-zerogpu",
        title: "huggingface-zerogpu",
        description: "AI demos and GPU compute with Gradio Spaces and Hugging Face Spaces ZeroGPU. Use when writing or reviewing code that uses `@spaces.GPU`, configuring `python_version` or `requirements.txt` for a ZeroGPU Space, or handling ZeroGPU-specific code constraints \u2014 pickle-based process isolation, `gr.State` semantics across the worker boundary, no `torch.compile` (use AoTI instead), CUDA wheel-only builds (no `nvcc` at build or runtime), large vs xlarge sizing, and dynamic duration callables. Make sure to use this skill whenever the user mentions ZeroGPU, `@spaces.GPU`, or the `spaces` Python package, or hits ZeroGPU-specific code errors like `PicklingError` across the worker boundary, `illegal duration`, or `flash-attn` wheel-build failures \u2014 even when the user does not explicitly ask for ZeroGPU coding guidance. Trigger on `import spaces` or `@spaces.GPU` in code."
      },
      {
        name: "train-sentence-transformers",
        title: "train-sentence-transformers",
        description: "Train or fine-tune sentence-transformers models across `SentenceTransformer` (bi-encoder, dense or static embedding model for retrieval, similarity, clustering, classification, paraphrase mining, dedup, multimodal), `CrossEncoder` (reranker, pair scoring for two-stage retrieval / pair classification), `SparseEncoder` (SPLADE, sparse embedding model for learned-sparse retrieval), and `MultiVectorEncoder` (ColBERT / late-interaction, per-token embeddings scored with MaxSim). Covers loss selection, hard-negative mining, evaluators, distillation, LoRA, Matryoshka, and Hugging Face Hub publishing. Use for any sentence-transformers training task."
      },
      {
        name: "transformers-js",
        title: "transformers-js",
        description: "Use Transformers.js to run state-of-the-art machine learning models directly in JavaScript/TypeScript. Supports NLP (text classification, translation, summarization), computer vision (image classification, object detection), audio (speech recognition, audio classification), and multimodal tasks. Works in browsers and server-side runtimes (Node.js, Bun, Deno) with WebGPU/WASM using pre-trained models from Hugging Face Hub."
      },
      {
        name: "trl-training",
        title: "trl-training",
        description: "Post-train LLMs with TRL (Transformers Reinforcement Learning) \u2014 SFT, DPO, GRPO, KTO, and reward-model training. Use when writing or debugging training code with the TRL Python API or the trl CLI."
      }
    ]
  }
];

// lib/skill-market.js
var SKILL_LIVE_REPO_SOURCES = ["official"];
var SKILL_MARKET_SOURCES = ["clawhub", ...SKILL_LIVE_REPO_SOURCES, "skillhub", "github"];
var SKILL_MARKET_LABELS = {
  clawhub: "ClawHub",
  official: "anthropics",
  skillhub: "SkillHub",
  github: "GitHub"
};
var CLAWHUB_BASE = "https://clawhub.ai";
var CLAWHUB_TTL_MS = 60 * 1e3;
var OFFICIAL_REPO = "anthropics/skills";
var OFFICIAL_TTL_MS = 10 * 60 * 1e3;
var SKILLHUB_BASE = "https://api.skillhub.cn";
var SKILLHUB_TTL_MS = 10 * 60 * 1e3;
var GITHUB_TTL_MS = 60 * 1e3;
var REQUEST_TIMEOUT_MS = 2e4;
var MAX_INSTALL_BYTES = 64 * 1024 * 1024;
var installing = /* @__PURE__ */ new Set();
async function readDownload(response, maxBytes = MAX_INSTALL_BYTES) {
  const length = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(length) && length > maxBytes) {
    await response.body?.cancel();
    throw new Error(`download exceeds ${maxBytes} bytes`);
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (; ; ) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new Error(`download exceeds ${maxBytes} bytes`);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, size);
}
function nowMs() {
  return Date.now();
}
function filterByQuery(items, query) {
  const term = typeof query === "string" ? query.trim().toLowerCase() : "";
  if (!term) return items;
  return items.filter(
    (item) => `${item.id} ${item.install?.slug ?? ""} ${item.install?.repo ?? ""} ${item.owner ?? ""} ${item.name} ${item.title} ${item.summary} ${item.category ?? ""}`.toLowerCase().includes(term)
  );
}
function clip2(text, limit) {
  if (typeof text !== "string") return "";
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > limit ? `${flat.slice(0, limit - 1)}\u2026` : flat;
}
var featuredRepos = new Map(featured_skills_default.map(({ repo }) => [repo.toLowerCase(), repo]));
var featuredSkills = new Map(featured_skills_default.flatMap(({ repo, root, ref, skills }) => skills.map(({ name: name2, title, description }) => {
  const dir = `${root}/${name2}`;
  const id = `github:${repo}:${dir}`;
  const repository = `https://github.com/${repo}`;
  return [id, {
    id,
    source: "github",
    name: name2,
    title,
    summary: clip2(description, 240),
    collection: repo,
    repository,
    icon: githubOwnerIcon(repo.split("/")[0]),
    pageUrl: `${repository}/tree/${ref}/${dir}`,
    installable: true,
    install: { kind: "github-dir", repo, dir, ref }
  }];
})));
var FEATURED_GITHUB_SKILL_COUNT = featuredSkills.size;
var featuredGithubSkill = (id) => featuredSkills.get(id);
function withFeaturedGithubSkills(rows, query = "") {
  const discovered = rows.filter((row) => {
    if (row.source !== "github") return true;
    const repository = row.install?.repo;
    if (typeof repository !== "string") return true;
    const repo = featuredRepos.get(repository.toLowerCase());
    if (!repo) return true;
    const dir = row.install.dir;
    return dir !== "" && !featuredSkills.has(`github:${repo}:${dir}`);
  });
  return discovered.concat(filterByQuery([...featuredSkills.values()], query));
}
async function fetchWithTimeout(url, { headers = {}, timeout = REQUEST_TIMEOUT_MS, fetchImpl = fetch } = {}) {
  const response = await fetchImpl(url, {
    headers: { "user-agent": "dsh-overall-mcp skill market", ...headers },
    signal: AbortSignal.timeout(timeout)
  });
  return response;
}
async function readJson(response, label) {
  const text = await response.text();
  if (!response.ok) {
    const error = new Error(`${label} returned ${response.status}: ${clip2(text, 200) || "no body"}`);
    error.status = response.status;
    const remaining = response.headers?.get?.("x-ratelimit-remaining");
    error.rateLimited = response.status === 429 || remaining != null && remaining !== "" && Number(remaining) === 0 || /API rate limit exceeded|secondary rate limit/i.test(text);
    const reset = Number(response.headers?.get?.("x-ratelimit-reset")) * 1e3;
    const wait = Number(response.headers?.get?.("retry-after")) * 1e3;
    if (reset > Date.now()) error.retryAt = reset;
    else if (wait > 0) error.retryAt = Date.now() + wait;
    throw error;
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${label} returned ${response.status} but not JSON: ${clip2(text, 120)}`);
  }
}
function clawhubItem(raw) {
  const owner = typeof raw.ownerHandle === "string" ? raw.ownerHandle : "";
  const slug = typeof raw.slug === "string" ? raw.slug : "";
  if (!slug) return null;
  const version = raw.latestVersion && typeof raw.latestVersion.version === "string" ? raw.latestVersion.version : raw.version;
  const stats = raw.stats && typeof raw.stats === "object" ? raw.stats : {};
  return {
    id: `clawhub:${owner ? `${owner}/` : ""}${slug}`,
    source: "clawhub",
    name: slug,
    icon: declaredIcon(raw),
    emoji: declaredEmoji(raw),
    title: typeof raw.displayName === "string" && raw.displayName ? raw.displayName : slug,
    summary: clip2(raw.summary ?? raw.description ?? "", 240),
    version: typeof version === "string" ? version : void 0,
    updatedAt: Number.isFinite(raw.updatedAt) ? raw.updatedAt : void 0,
    downloads: Number.isFinite(stats.downloads) ? stats.downloads : void 0,
    stars: Number.isFinite(stats.stars) ? stats.stars : void 0,
    topics: Array.isArray(raw.topics) ? raw.topics.filter((t) => typeof t === "string").slice(0, 6) : [],
    pageUrl: owner ? `https://clawhub.ai/${owner}/skills/${slug}` : void 0,
    installable: true,
    install: { kind: "clawhub-zip", owner: owner || void 0, slug, version: typeof version === "string" ? version : void 0 },
    installNote: "\u5B89\u88C5\u65F6\u4ECE ClawHub \u53D6\u5B98\u65B9\u5206\u53D1\u7684 ZIP"
  };
}
async function loadClawhub({ refresh = false, query, limit, state }) {
  const cached = state.clawhub;
  if (!refresh && cached && nowMs() - cached.at < CLAWHUB_TTL_MS && !cached.query && !query) return cached;
  let url;
  if (query) {
    url = `${CLAWHUB_BASE}/api/v1/search?q=${encodeURIComponent(query)}&limit=${limit}`;
  } else {
    url = `${CLAWHUB_BASE}/api/v1/skills?limit=${limit}&sort=downloads&nonSuspiciousOnly=true`;
  }
  const body = await readJson(await fetchWithTimeout(url, { fetchImpl: state.fetch }), "ClawHub");
  const raw = Array.isArray(body.items) ? body.items : Array.isArray(body.results) ? body.results : [];
  const items = raw.map(clawhubItem).filter(Boolean);
  const next = { at: nowMs(), query: query || "", items, total: Number.isFinite(body.total) ? body.total : void 0, nextCursor: body.nextCursor ?? null };
  if (!query) state.clawhub = next;
  return next;
}
async function clawhubFiles(item, state) {
  const target = item.install || {};
  const params = new URLSearchParams({ slug: target.slug });
  if (target.owner) params.set("ownerHandle", target.owner);
  if (target.version) params.set("version", target.version);
  const response = await fetchWithTimeout(`${CLAWHUB_BASE}/api/v1/download?${params}`, {
    timeout: 6e4,
    fetchImpl: state.fetch
  });
  const type = response.headers.get("content-type") || "";
  if (type.includes("application/json")) {
    const body = await readJson(response, "ClawHub download");
    throw new Error(
      `\u8FD9\u4E2A\u6280\u80FD\u6258\u7BA1\u5728 GitHub\uFF0CClawHub \u53EA\u7ED9\u8F6C\u4EA4\u4FE1\u606F\uFF1A${clip2(body.repo || body.sourceRef || "unknown", 80)}`
    );
  }
  if (!response.ok) {
    throw new Error(`ClawHub download returned ${response.status}: ${clip2(await response.text(), 200)}`);
  }
  const buffer = await readDownload(response);
  const { files, skipped, error } = readZipFiles(buffer);
  if (error) throw new Error(`archive unreadable: ${error}`);
  if (skipped.some((entry) => entry.reason !== "filtered")) throw new Error(`archive contains refused entries: ${skipped.map((entry) => `${entry.name}: ${entry.reason}`).join("; ")}`);
  if (!files.some((file) => file.path === "SKILL.md")) {
    throw new Error("archive has no SKILL.md at its root");
  }
  return { files, skipped };
}
async function githubJson(url, label, state) {
  const headers = { accept: "application/vnd.github+json" };
  if (state.token) headers.authorization = `Bearer ${state.token}`;
  const response = await fetchWithTimeout(url, { headers, fetchImpl: state.fetch });
  return readJson(response, label);
}
async function loadOfficial({ refresh = false, state, query }) {
  const cached = state.official;
  if (!refresh && cached && nowMs() - cached.at < OFFICIAL_TTL_MS) {
    const cachedItems = Array.isArray(cached.items) ? cached.items : [];
    return {
      at: cached.at,
      items: query ? filterByQuery(cachedItems, query) : cachedItems,
      total: cachedItems.length,
      nextCursor: null
    };
  }
  const listing = await githubJson(
    `https://api.github.com/repos/${OFFICIAL_REPO}/contents/skills`,
    "Official skills listing",
    state
  );
  const dirs = listing.filter((entry) => entry.type === "dir").map((entry) => entry.name);
  const items = [];
  for (const name2 of dirs) {
    let meta = {};
    try {
      const raw = await fetchWithTimeout(
        `https://raw.githubusercontent.com/${OFFICIAL_REPO}/main/skills/${name2}/SKILL.md`,
        { fetchImpl: state.fetch }
      );
      if (raw.ok) meta = parseFrontmatter(await raw.text());
    } catch {
    }
    items.push({
      id: `official:${name2}`,
      source: "official",
      name: name2,
      icon: declaredIcon(meta) ?? declaredIcon(meta.metadata),
      emoji: declaredEmoji(meta),
      title: typeof meta.name === "string" && meta.name ? meta.name : name2,
      summary: clip2(meta.description ?? "", 240),
      pageUrl: `https://github.com/${OFFICIAL_REPO}/tree/main/skills/${name2}`,
      installable: true,
      install: { kind: "github-dir", repo: OFFICIAL_REPO, dir: `skills/${name2}`, ref: "main" },
      installNote: "\u5B89\u88C5\u65F6\u4ECE anthropics/skills \u53D6\u8FD9\u4E2A\u76EE\u5F55\u7684\u6587\u4EF6"
    });
  }
  state.official = { at: nowMs(), items };
  return {
    at: state.official.at,
    items: query ? filterByQuery(items, query) : items,
    total: items.length,
    nextCursor: null
  };
}
function skillhubItem(raw) {
  const slug = typeof raw?.slug === "string" ? raw.slug : "";
  const name2 = typeof raw?.name === "string" && raw.name ? raw.name : slug;
  const description = String(raw?.description_zh || raw?.description || "").trim();
  const updated = Number(raw?.updated_at);
  return {
    id: `skillhub:${slug}`,
    source: "skillhub",
    name: name2,
    icon: declaredIcon(raw),
    emoji: declaredEmoji(raw),
    title: name2,
    summary: clip2(description, 240),
    version: typeof raw?.version === "string" ? raw.version : void 0,
    owner: typeof raw?.ownerName === "string" ? raw.ownerName : void 0,
    downloads: raw?.downloads != null && raw.downloads !== "" && Number.isFinite(Number(raw.downloads)) ? Number(raw.downloads) : void 0,
    stars: raw?.stars != null && raw.stars !== "" && Number.isFinite(Number(raw.stars)) ? Number(raw.stars) : void 0,
    category: typeof raw?.category === "string" ? raw.category : void 0,
    verified: raw?.verified === true,
    updatedAt: Number.isFinite(updated) && updated > 0 ? updated : void 0,
    pageUrl: skillSourcePage({ source: "skillhub", pageUrl: raw?.homepage }),
    installable: Boolean(slug),
    install: slug ? { kind: "skillhub-zip", slug, version: typeof raw?.version === "string" ? raw.version : void 0 } : void 0
  };
}
async function loadSkillhub({ refresh = false, state, query, limit }) {
  const cached = state.skillhub;
  if (!refresh && !String(query ?? "").trim() && cached && cached.limit >= limit && nowMs() - cached.at < SKILLHUB_TTL_MS) {
    return { at: cached.at, items: cached.items.slice(0, limit), total: cached.total, nextCursor: null };
  }
  const params = new URLSearchParams({
    page: "1",
    pageSize: String(Math.min(Math.max(limit, 1), 100)),
    sortBy: "downloads",
    order: "desc"
  });
  const needle = String(query ?? "").trim();
  if (needle) params.set("keyword", needle);
  const response = await fetchWithTimeout(`${SKILLHUB_BASE}/api/skills?${params}`, { fetchImpl: state.fetch });
  const body = await readJson(response, "SkillHub");
  const rows = Array.isArray(body?.data?.skills) ? body.data.skills : [];
  const items = rows.map(skillhubItem).filter((item) => item.name);
  const total = Number(body?.data?.total);
  if (!needle) state.skillhub = { at: nowMs(), items, total: Number.isFinite(total) ? total : items.length, limit };
  return { at: nowMs(), items: filterByQuery(items, needle), total: Number.isFinite(total) ? total : items.length, nextCursor: null };
}
function stripSingleRoot(files) {
  if (!files.length) return files;
  if (files.some((file) => file.path === "SKILL.md")) return files;
  const tops = new Set(files.map((file) => file.path.split("/")[0]));
  if (tops.size !== 1) return files;
  const [top] = [...tops];
  if (!files.some((file) => file.path === `${top}/SKILL.md`)) return files;
  return files.map((file) => ({ ...file, path: file.path.slice(top.length + 1) }));
}
async function skillhubFiles(item, state) {
  const install = item.install ?? {};
  const slug = install.slug || item.name;
  const response = await fetchWithTimeout(`${SKILLHUB_BASE}/api/v1/download?slug=${encodeURIComponent(slug)}`, {
    timeout: 6e4,
    fetchImpl: state.fetch
  });
  if (!response.ok) {
    const text = clip2(await response.text().catch(() => ""), 200);
    throw new Error(`SkillHub download returned ${response.status}: ${text}`);
  }
  const bytes = await readDownload(response);
  const unpacked = readZipFiles(bytes);
  if (unpacked.error) throw new Error(`SkillHub \u5305\u89E3\u4E0D\u5F00\uFF1A${unpacked.error}`);
  if (unpacked.skipped.some((entry) => entry.reason !== "filtered")) throw new Error("SkillHub \u5305\u542B\u4E0D\u5B89\u5168\u6216\u4E0D\u53EF\u8BFB\u53D6\u7684\u6587\u4EF6");
  const root = stripSingleRoot(unpacked.files);
  if (!root.some((file) => file.path === "SKILL.md")) {
    throw new Error("SkillHub \u4E0B\u8F7D\u56DE\u6765\u7684\u5305\u91CC\u6CA1\u6709 SKILL.md\uFF0C\u8FD9\u4E2A slug \u53EF\u80FD\u4E0D\u5B58\u5728");
  }
  return { files: root, skipped: unpacked.skipped };
}
function parseRepoRef(value) {
  if (typeof value !== "string") return null;
  const match = /^(?:https?:\/\/github\.com\/)?([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/?$/.exec(value.trim());
  if (!match) return null;
  return { owner: match[1], repo: match[2].replace(/\.git$/, "") };
}
async function loadGithub({ refresh = false, state, query, limit }) {
  const term = query && query.trim() ? query.trim() : "agent-skills";
  const authenticated = state.isGithubAuthenticated();
  const key = `github:${authenticated ? "code" : "repositories"}:${term}:${limit}`;
  const cached = state.github.get(key);
  if (!refresh && cached && nowMs() - cached.at < GITHUB_TTL_MS) {
    return { at: cached.at, items: cached.items, total: cached.items.length, nextCursor: null };
  }
  if (authenticated) {
    const url2 = `https://api.github.com/search/code?q=${encodeURIComponent(`filename:SKILL.md ${term}`)}&per_page=${limit}`;
    const body2 = await githubJson(url2, "GitHub code search", state);
    const items2 = (body2.items || []).map((hit) => {
      const repo = hit.repository || {};
      const filePath = typeof hit.path === "string" ? hit.path : "";
      const dir = filePath.replace(/\/?SKILL\.md$/i, "");
      return {
        id: `github:${repo.full_name}:${dir || "."}`,
        source: "github",
        name: dir ? path5.posix.basename(dir) : repo.name,
        title: dir ? path5.posix.basename(dir) : repo.name,
        summary: clip2(path5.posix.dirname(dir) === "." ? repo.name : `${dir} \xB7 ${repo.full_name}`, 120),
        repo: repo.full_name,
        icon: githubOwnerIcon(repo.owner?.login ?? repo.full_name?.split("/")[0]),
        pageUrl: hit.html_url,
        installable: true,
        install: { kind: "github-dir", repo: repo.full_name, dir, ref: repo.default_branch },
        installNote: "\u5B89\u88C5\u65F6\u4ECE\u8FD9\u4E2A\u4ED3\u5E93\u53D6\u8BE5\u76EE\u5F55\u7684\u6587\u4EF6"
      };
    });
    state.github.set(key, { at: nowMs(), items: items2 });
    return { at: nowMs(), items: items2, total: Number.isFinite(body2.total_count) ? body2.total_count : items2.length, nextCursor: null };
  }
  const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(`topic:agent-skills ${term === "agent-skills" ? "" : term}`.trim())}&sort=stars&per_page=${Math.min(limit, 20)}`;
  const body = await githubJson(url, "GitHub repository search", state);
  const items = (body.items || []).map((repo) => ({
    id: `github:${repo.full_name}`,
    source: "github",
    name: repo.name,
    title: repo.full_name,
    icon: githubOwnerIcon(repo.owner?.login ?? repo.full_name?.split("/")[0]),
    summary: clip2(repo.description || "", 200),
    stars: Number.isFinite(repo.stargazers_count) ? repo.stargazers_count : void 0,
    updatedAt: repo.pushed_at ? Date.parse(repo.pushed_at) : void 0,
    pageUrl: repo.html_url,
    installable: true,
    install: { kind: "github-dir", repo: repo.full_name, dir: "", ref: repo.default_branch },
    installNote: "\u6CA1\u6709 GitHub token \u65F6\u53EA\u80FD\u6309\u4ED3\u5E93\u627E\uFF1B\u5B89\u88C5\u4F1A\u53D6\u4ED3\u5E93\u6839\u76EE\u5F55\u7684 SKILL.md"
  }));
  state.github.set(key, { at: nowMs(), items });
  return { at: nowMs(), items, total: Number.isFinite(body.total_count) ? body.total_count : items.length, nextCursor: null };
}
function pickGithubDir(files, dir) {
  if (!dir) {
    const root = files.find((file) => /^SKILL\.md$/i.test(file.path));
    if (root) return "";
    return null;
  }
  const prefix = `${dir.replace(/\/+$/, "")}/`;
  if (!files.some((file) => file.path.toLowerCase() === `${prefix}skill.md`.toLowerCase())) return null;
  return prefix;
}
async function githubDirFiles(item, state) {
  const target = item.install || {};
  const ref = target.ref || (await githubJson(`https://api.github.com/repos/${target.repo}`, "GitHub repository", state)).default_branch;
  if (typeof ref !== "string" || !ref) throw new Error("GitHub did not provide a default branch");
  const tree = await githubJson(
    `https://api.github.com/repos/${target.repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`,
    "GitHub tree",
    state
  );
  if (tree.truncated) throw new Error("\u8FD9\u4E2A\u4ED3\u5E93\u592A\u5927\uFF0CGitHub \u622A\u65AD\u4E86\u6587\u4EF6\u5217\u8868\uFF0C\u65E0\u6CD5\u6309\u76EE\u5F55\u5B89\u88C5");
  const blobs = (tree.tree || []).filter((entry) => entry.type === "blob").map((entry) => entry.path);
  const prefix = pickGithubDir(blobs.map((p) => ({ path: p })), target.dir);
  if (prefix === null) throw new Error(`\u8FD9\u4E2A\u4ED3\u5E93\u5728 ${target.dir || "\u6839\u76EE\u5F55"} \u91CC\u6CA1\u6709 SKILL.md`);
  const wanted = blobs.filter((p) => p.startsWith(prefix));
  if (wanted.length > 5e3) throw new Error("skill contains more than 5000 files");
  const files = [];
  let totalBytes = 0;
  for (const filePath of wanted) {
    const raw = await fetchWithTimeout(
      `https://raw.githubusercontent.com/${target.repo}/${encodeURIComponent(ref)}/${filePath.split("/").map(encodeURIComponent).join("/")}`,
      { fetchImpl: state.fetch }
    );
    if (!raw.ok) throw new Error(`raw.githubusercontent returned ${raw.status} for ${filePath}`);
    const bytes = await readDownload(raw, MAX_INSTALL_BYTES - totalBytes);
    totalBytes += bytes.length;
    files.push({ path: filePath.slice(prefix.length), bytes });
  }
  if (files.length === 0) throw new Error("\u76EE\u5F55\u91CC\u6CA1\u6709\u6587\u4EF6");
  return { files, skipped: [] };
}
function createSkillMarket({ token, metricsAuthKey = () => token ?? "", isGithubAuthenticated = () => Boolean(token), fs: fsImpl = nodeFs, fetchImpl } = {}) {
  const state = {
    clawhub: null,
    official: null,
    skillhub: null,
    github: /* @__PURE__ */ new Map(),
    token: token || null,
    isGithubAuthenticated,
    fetch: fetchImpl || fetch
  };
  const fs6 = fsImpl;
  const metricCache = /* @__PURE__ */ new Map();
  const metricRevision = /* @__PURE__ */ new Map();
  const metricCooldown = /* @__PURE__ */ new Map();
  let metricAuth = metricsAuthKey();
  const METRIC_TTL_MS = 5 * 6e4;
  const metricIdentity = (item) => JSON.stringify([item.source, item.owner ?? "", item.install?.owner ?? "", item.install?.repo ?? "", item.install?.slug ?? item.name]);
  function applyMetrics(items) {
    return items.map((item) => {
      const saved = metricCache.get(item.id);
      return saved?.identity === metricIdentity(item) ? { ...item, ...saved.values, metrics: { at: saved.at, stale: Boolean(saved.error) || Date.now() - Date.parse(saved.at) >= METRIC_TTL_MS, ...saved.error ? { error: saved.error } : {} } } : item;
    });
  }
  async function metrics({ items = [], refresh = false } = {}) {
    if (metricsAuthKey() !== metricAuth) {
      metricAuth = metricsAuthKey();
      metricCooldown.delete("github");
    }
    const batchAuth = metricAuth;
    const deadline = AbortSignal.timeout(15e3);
    const fetchImpl2 = (url, init = {}) => state.fetch(url, {
      ...init,
      signal: init.signal ? AbortSignal.any([deadline, init.signal]) : deadline
    });
    const results = {};
    const tasks = items.slice(0, 200).filter((item) => !item.collection && ["clawhub", "skillhub", "github"].includes(item.source));
    let cursor = 0;
    await Promise.all(Array.from({ length: Math.min(4, tasks.length) }, async () => {
      while (cursor < tasks.length) {
        const item = tasks[cursor++];
        const cached = metricCache.get(item.id);
        const identity = metricIdentity(item);
        const saved = cached?.identity === identity ? cached : null;
        if (!refresh && saved && !saved.error && Date.now() - Date.parse(saved.at) < METRIC_TTL_MS) {
          results[item.id] = { ...saved.values, metrics: { at: saved.at, stale: false } };
          continue;
        }
        const revision = (metricRevision.get(item.id) ?? 0) + 1;
        metricRevision.set(item.id, revision);
        try {
          if (deadline.aborted) throw new Error("\u672C\u6B21\u7EDF\u8BA1\u66F4\u65B0\u8D85\u65F6\uFF0C\u5269\u4F59\u6761\u76EE\u672A\u66F4\u65B0");
          if ((metricCooldown.get(item.source) ?? 0) > Date.now()) throw new Error("\u6765\u6E90\u8BF7\u6C42\u6B21\u6570\u53D7\u9650\uFF0C\u672C\u6B21\u4FDD\u7559\u4E0A\u6B21\u7EDF\u8BA1");
          let raw;
          if (item.source === "clawhub") {
            const slug = item.install?.slug || item.name;
            if (typeof slug !== "string" || !slug || slug.length > 200) throw new Error("\u6280\u80FD\u6765\u6E90\u7F3A\u5C11\u6709\u6548\u6807\u8BC6");
            const body = await readJson(await fetchWithTimeout(`${CLAWHUB_BASE}/api/v1/skills/${encodeURIComponent(slug)}${item.install?.owner ? `?ownerHandle=${encodeURIComponent(item.install.owner)}` : ""}`, { fetchImpl: fetchImpl2, timeout: 8e3 }), "ClawHub statistics");
            if (body?.skill?.slug !== slug) throw new Error("\u6765\u6E90\u8FD4\u56DE\u7684\u6280\u80FD\u6807\u8BC6\u4E0D\u5339\u914D");
            if (item.install?.owner && body?.owner?.handle?.toLowerCase() !== item.install.owner.toLowerCase()) throw new Error("\u6765\u6E90\u8FD4\u56DE\u7684\u6280\u80FD\u53D1\u5E03\u8005\u4E0D\u5339\u914D\uFF0C\u672A\u66F4\u65B0\u7EDF\u8BA1");
            raw = body.skill.stats;
          } else if (item.source === "skillhub") {
            const listing = await loadSkillhub({ refresh: true, state: { ...state, fetch: fetchImpl2 }, query: item.install?.slug || item.name, limit: 100 });
            const matches = listing.items.filter((row) => row.id === item.id && (!item.owner || row.owner === item.owner));
            if (matches.length > 1) throw new Error("\u6765\u6E90\u5B58\u5728\u540C\u540D\u6280\u80FD\uFF0C\u65E0\u6CD5\u53EF\u9760\u786E\u8BA4\u7EDF\u8BA1\u5F52\u5C5E");
            const match = matches[0];
            if (!match) throw new Error("\u6765\u6E90\u672A\u8FD4\u56DE\u8BE5\u6280\u80FD\u7684\u6700\u65B0\u7EDF\u8BA1");
            raw = match;
          } else {
            const repo = parseRepoRef(item.install?.repo);
            if (!repo) throw new Error("\u6280\u80FD\u7F3A\u5C11\u6709\u6548\u7684 GitHub \u4ED3\u5E93\u6807\u8BC6");
            const body = await githubJson(`https://api.github.com/repos/${repo.owner}/${repo.repo}`, "GitHub statistics", { ...state, fetch: fetchImpl2 });
            raw = { stars: body.stargazers_count };
          }
          const values = {};
          for (const key of ["downloads", "stars"]) if (typeof raw?.[key] === "number" && Number.isFinite(raw[key]) && raw[key] >= 0) values[key] = raw[key];
          if (!Object.keys(values).length) throw new Error("\u6765\u6E90\u672A\u63D0\u4F9B\u53EF\u7528\u7684\u4E0B\u8F7D\u91CF\u6216 Star \u7EDF\u8BA1");
          const missing = ["downloads", "stars"].filter((key) => typeof (saved?.values[key] ?? item[key]) === "number" && !(key in values));
          const partialError = missing.length ? `\u6765\u6E90\u672A\u8FD4\u56DE${missing.map((key) => key === "downloads" ? "\u4E0B\u8F7D\u91CF" : "Star").join("\u3001")}\uFF0C\u4FDD\u7559\u4E0A\u6B21\u6570\u5B57` : null;
          if (metricRevision.get(item.id) === revision) {
            metricCache.delete(item.id);
            metricCache.set(item.id, { values: { ...saved?.values, ...values }, identity, at: (/* @__PURE__ */ new Date()).toISOString(), ...partialError ? { error: partialError } : {} });
            while (metricCache.size > 2e3) {
              const oldest = metricCache.keys().next().value;
              metricCache.delete(oldest);
              metricRevision.delete(oldest);
            }
          }
          const latest = metricCache.get(item.id);
          const current = latest?.identity === identity ? latest : saved;
          results[item.id] = { ...current?.values, metrics: { at: current?.at, stale: Boolean(current?.error), ...current?.error ? { error: current.error } : {} } };
        } catch (error) {
          if (error.rateLimited && metricRevision.get(item.id) === revision && (item.source !== "github" || metricsAuthKey() === batchAuth)) metricCooldown.set(item.source, error.retryAt ?? Date.now() + 6e4);
          const latest = metricCache.get(item.id);
          const current = latest?.identity === identity ? latest : saved;
          if (metricRevision.get(item.id) === revision) {
            metricCache.set(item.id, { values: current?.values ?? {}, identity, at: current?.at ?? item.lastSeen ?? null, error: String(error.message ?? error) });
            while (metricCache.size > 2e3) {
              const oldest = metricCache.keys().next().value;
              metricCache.delete(oldest);
              metricRevision.delete(oldest);
            }
          }
          results[item.id] = { ...current?.values, metrics: { at: current?.at ?? item.lastSeen ?? null, stale: true, error: String(error.message ?? error) } };
        }
      }
    }));
    return {
      items: results,
      requested: tasks.length,
      updated: Object.values(results).filter((row) => !row.metrics.stale).length,
      errors: Object.entries(results).filter(([, row]) => row.metrics.error).map(([id, row]) => ({ id, message: row.metrics.error }))
    };
  }
  async function list({ source = "all", query = "", limit = 20, refresh = false } = {}) {
    const wanted = source && source !== "all" ? [source] : SKILL_MARKET_SOURCES;
    const size = Math.min(Math.max(Number(limit) || 20, 1), 60);
    const sources = [];
    const items = [];
    for (const id of wanted) {
      if (!SKILL_MARKET_SOURCES.includes(id)) {
        sources.push({ id, label: id, count: 0, error: "unknown source" });
        continue;
      }
      try {
        let result;
        if (id === "clawhub") result = await loadClawhub({ refresh, query, limit: size, state });
        else if (id === "official") result = await loadOfficial({ refresh, state, query });
        else if (id === "skillhub") result = await loadSkillhub({ refresh, state, query, limit });
        else result = await loadGithub({ refresh, state, query, limit: size });
        const rows = (result.items || []).slice(0, size);
        items.push(...rows);
        sources.push({
          id,
          label: SKILL_MARKET_LABELS[id],
          count: rows.length,
          total: result.total,
          cachedAt: result.at,
          error: null
        });
      } catch (error) {
        sources.push({ id, label: SKILL_MARKET_LABELS[id], count: 0, error: clip2(error.message, 240) });
      }
    }
    if (!wanted.includes("github")) return { sources, items };
    const combined = withFeaturedGithubSkills(items, query);
    const github = sources.find((row) => row.id === "github");
    github.count = combined.filter((row) => row.source === "github").length;
    github.featured = FEATURED_GITHUB_SKILL_COUNT;
    return { sources, items: combined };
  }
  async function install({ item, targetDir }) {
    if (!item || !item.installable) throw new Error("\u8FD9\u4E2A\u6761\u76EE\u4E0D\u80FD\u76F4\u63A5\u5B89\u88C5");
    const kind = item.install && item.install.kind;
    if (kind !== "clawhub-zip" && kind !== "skillhub-zip" && kind !== "github-dir") {
      throw new Error(`unknown install kind ${kind}`);
    }
    if (!targetDir || typeof targetDir !== "string") throw new Error("no target directory");
    const reservation = process.platform === "win32" ? path5.resolve(targetDir).toLowerCase() : path5.resolve(targetDir);
    if (installing.has(reservation)) throw Object.assign(new Error("skill installation is already in progress"), { status: 409 });
    installing.add(reservation);
    let stage = null;
    const refuseExisting = async () => {
      try {
        await fs6.lstat(targetDir);
      } catch (err) {
        if (err.code === "ENOENT") return;
        throw err;
      }
      throw Object.assign(new Error(`skill directory already exists: ${targetDir}`), { status: 409 });
    };
    try {
      await refuseExisting();
      const { files, skipped } = kind === "clawhub-zip" ? await clawhubFiles(item, state) : kind === "skillhub-zip" ? await skillhubFiles(item, state) : await githubDirFiles(item, state);
      if (!files.some((file) => file.path.toLowerCase() === "skill.md")) {
        throw new Error("\u4E0B\u8F7D\u7ED3\u679C\u91CC\u6CA1\u6709 SKILL.md\uFF0C\u4E0D\u6562\u5F80 skill \u76EE\u5F55\u91CC\u653E");
      }
      await fs6.mkdir(path5.dirname(targetDir), { recursive: true });
      stage = await fs6.mkdtemp(path5.join(path5.dirname(targetDir), `.${path5.basename(targetDir)}.install-`));
      const written = [];
      for (const file of files) {
        if (file.path.toLowerCase() === SKILL_ICON_METADATA) continue;
        const destination = path5.join(stage, ...file.path.split("/"));
        const relative = path5.relative(stage, destination);
        if (!relative || file.path.includes("\\") || file.path.includes(":") || relative.startsWith("..") || path5.isAbsolute(relative)) {
          throw new Error(` refusing to write outside the target: ${file.path}`);
        }
        await fs6.mkdir(path5.dirname(destination), { recursive: true });
        await fs6.writeFile(destination, file.bytes, { flag: "wx" });
        written.push(file.path);
      }
      const icon = declaredIcon(item);
      const emoji = declaredEmoji(item);
      const iconCandidates = publisherIcons(item.homepage, item.pageUrl, item.repository);
      const pageUrl = skillSourcePage({ ...item, marketId: item.id });
      if (item.id || pageUrl || icon || emoji || iconCandidates.length) {
        await fs6.writeFile(path5.join(stage, SKILL_ICON_METADATA), JSON.stringify({
          marketId: item.id,
          pageUrl,
          icon,
          emoji,
          ...iconCandidates.length ? { iconCandidates } : {}
        }), { flag: "wx" });
      }
      await refuseExisting();
      await fs6.rename(stage, targetDir);
      stage = null;
      return { dir: targetDir, files: written, skipped: skipped.filter((entry) => entry.reason !== "filtered").slice(0, 10) };
    } finally {
      try {
        if (stage) await fs6.rm(stage, { recursive: true, force: true });
      } finally {
        installing.delete(reservation);
      }
    }
  }
  return { list, install, metrics, applyMetrics, sources: SKILL_MARKET_SOURCES };
}
var _internal = { skillhubItem, clawhubItem, pickGithubDir, frontmatter: parseFrontmatter, parseRepoRef };

// lib/skill-index.js
var { skillhubItem: skillhubItem2, clawhubItem: clawhubItem2 } = _internal;
var SKILL_INDEX_VERSION = 1;
var SKILL_INDEX_FILE = "skills-index.json";
var SKILL_INDEX_TTL_MS = 24 * 60 * 60 * 1e3;
var SKILL_INDEX_KEEP_MS = 30 * 24 * 60 * 60 * 1e3;
var SKILL_INDEX_MAX_ROWS = 24e3;
var SKILL_INDEX_MAX_ROWS_FULL = 4e5;
var WALK_SOURCES = ["skillhub", "clawhub", "github"];
var SLICES = {
  skillhub: { target: 1e4, pageSize: 100, pacingMs: 400, maxPages: 150 },
  // GitHub is not paged to a row limit any more: a search cannot pass 1000
  // results, so the slice descends through star bands instead (see
  // `walkGithubWindows`). `minStars` defines the population — measured
  // 2026-10-29, `topic:agent-skills` holds 38,486 repositories with no floor,
  // 20,503 at >=1, 8,387 at >=5, 2,521 at >=20 and 1,584 at >=50. Five is the
  // first floor that is a real long tail rather than a stub, and it costs
  // about nine windows; `target` stays as a safety cap above that population.
  github: {
    target: 12e3,
    pageSize: 100,
    pacingMs: 6500,
    pagesPerWindow: 10,
    minStars: 5,
    // Nine bands cover the floor; the extra headroom is for tie blocks, where
    // the descent has to spend one band proving it cannot page past 1,000.
    maxWindows: 16
  },
  // ClawHub publishes no total, so this is a safety cap rather than a slice of
  // a known population: 100 pages of 20 is where a background walk stops.
  clawhub: { target: 2e3, pageSize: 20, pacingMs: 3e3, maxPages: 100 }
};
var FULL_SLICES = {
  skillhub: { target: 4e5, pageSize: 100, pacingMs: 400, maxPages: 3e3 },
  github: {
    target: 6e4,
    pageSize: 100,
    pacingMs: 6500,
    pagesPerWindow: 10,
    // No floor: the population becomes every repository with the topic. The
    // descent then ends by proving the 0-star band is wider than a window,
    // which is reported like any other unreachable tie block.
    minStars: 0,
    maxWindows: 80
  },
  clawhub: { target: 6e4, pageSize: 20, pacingMs: 3e3, maxPages: 3e3 }
};
var MAX_RUN_REQUESTS = 400;
var MAX_RUN_REQUESTS_FULL = 3500;
function resolveSlices(full = []) {
  const wanted = new Set((Array.isArray(full) ? full : []).filter((id) => SLICES[id]));
  const slices = { ...SLICES };
  for (const id of wanted) slices[id] = { ...FULL_SLICES[id] };
  return slices;
}
function normalizeModes(modes) {
  const out = {};
  for (const id of WALK_SOURCES) out[id] = modes?.[id] === "full" ? "full" : "slice";
  return out;
}
function limitsForModes(modes) {
  const full = WALK_SOURCES.some((id) => modes?.[id] === "full");
  return {
    maxRequests: full ? MAX_RUN_REQUESTS_FULL : MAX_RUN_REQUESTS,
    maxRows: full ? SKILL_INDEX_MAX_ROWS_FULL : SKILL_INDEX_MAX_ROWS
  };
}
function sameWalkSelection(modes, full) {
  const wanted = new Set((Array.isArray(full) ? full : []).filter((id) => WALK_SOURCES.includes(id)));
  for (const id of WALK_SOURCES) {
    if (modes?.[id] === "full" !== wanted.has(id)) return false;
  }
  return true;
}
function mergeTruncations(previous, fresh, cursors, walked = null) {
  const visited = Array.isArray(walked) ? new Set(walked.map(String)) : null;
  const kept = (Array.isArray(previous) ? previous : []).filter((entry) => {
    const source = String(entry?.source ?? "");
    if (!source) return false;
    if (cursors?.[source]?.done !== true) return true;
    if (visited === null) return false;
    return !visited.has(source);
  });
  const out = [];
  const seen = /* @__PURE__ */ new Set();
  for (const entry of [...kept, ...Array.isArray(fresh) ? fresh : []]) {
    const source = String(entry?.source ?? "");
    const reason = String(entry?.reason ?? "");
    if (!source || !reason) continue;
    const key = `${source}\0${reason}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ source, reason });
  }
  return out;
}
var REQUEST_TIMEOUT_MS2 = 2e4;
var SKILLHUB_LIST = "https://api.skillhub.cn/api/skills";
var CLAWHUB_LIST = "https://clawhub.ai/api/v1/skills";
var GITHUB_SEARCH = "https://api.github.com/search/repositories";
var GITHUB_QUERY = "topic:agent-skills";
function clip3(text, limit) {
  if (typeof text !== "string") return "";
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > limit ? `${flat.slice(0, limit - 1)}\u2026` : flat;
}
function defaultSleep2(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
function abortError() {
  const err = new Error("skill index walk aborted");
  err.code = "aborted";
  return err;
}
function githubRepoItem(repo) {
  const fullName = typeof repo?.full_name === "string" ? repo.full_name : "";
  if (!fullName) return null;
  const name2 = typeof repo.name === "string" && repo.name ? repo.name : fullName.split("/").pop();
  return {
    id: `github:${fullName}`,
    source: "github",
    name: name2,
    title: fullName,
    icon: githubOwnerIcon(repo.owner?.login ?? fullName.split("/")[0]),
    summary: clip3(repo.description || "", 200),
    stars: Number.isFinite(repo.stargazers_count) ? repo.stargazers_count : void 0,
    updatedAt: repo.pushed_at ? Date.parse(repo.pushed_at) : void 0,
    pageUrl: repo.html_url,
    installable: true,
    install: { kind: "github-dir", repo: fullName, dir: "", ref: repo.default_branch },
    installNote: "\u6CA1\u6709 GitHub token \u65F6\u53EA\u80FD\u6309\u4ED3\u5E93\u627E\uFF1B\u5B89\u88C5\u4F1A\u53D6\u4ED3\u5E93\u6839\u76EE\u5F55\u7684 SKILL.md"
  };
}
var SKILLHUB_POPULARITY_WEIGHT = 0.3;
var SKILLHUB_FIRST_RANK = 21;
function compareRows(a, b, market = false) {
  const weightA = market && a?.source === "skillhub" ? SKILLHUB_POPULARITY_WEIGHT : 1;
  const weightB = market && b?.source === "skillhub" ? SKILLHUB_POPULARITY_WEIGHT : 1;
  const downloads = (Number(b?.downloads) || 0) * weightB - (Number(a?.downloads) || 0) * weightA;
  if (downloads !== 0) return downloads;
  const stars = (Number(b?.stars) || 0) * weightB - (Number(a?.stars) || 0) * weightA;
  if (stars !== 0) return stars;
  return String(a?.id ?? "").localeCompare(String(b?.id ?? ""));
}
function emptyCursors() {
  const cursors = {};
  for (const source of WALK_SOURCES) {
    cursors[source] = { page: 0, cursor: null, done: false, rows: 0, total: void 0, hi: null, windows: 0 };
  }
  return cursors;
}
function normalizeCursor(raw) {
  const held = raw && typeof raw === "object" ? raw : {};
  return {
    ...typeof raw?.sampleStartedAt === "string" && Number.isFinite(Date.parse(raw.sampleStartedAt)) ? { sampleStartedAt: raw.sampleStartedAt } : {},
    page: Number.isFinite(held.page) && held.page > 0 ? Math.floor(held.page) : 0,
    cursor: typeof held.cursor === "string" && held.cursor ? held.cursor : null,
    done: held.done === true,
    rows: Number.isFinite(held.rows) && held.rows > 0 ? Math.floor(held.rows) : 0,
    total: Number.isFinite(held.total) ? held.total : void 0,
    hi: Number.isFinite(held.hi) ? held.hi : null,
    windows: Number.isFinite(held.windows) && held.windows > 0 ? Math.floor(held.windows) : 0
  };
}
function cursorsForWalk(previousCursors, previousModes, modes, { restartCompleted = false, now = Date.now } = {}) {
  const before = normalizeModes(previousModes);
  const cursors = normalizeCursors(previousCursors);
  for (const id of WALK_SOURCES) {
    if (modes?.[id] === before[id] && !(restartCompleted && cursors[id].done)) continue;
    cursors[id] = { ...cursors[id], done: false, page: 0, windows: 0, hi: null, cursor: null, sampleStartedAt: new Date(now()).toISOString() };
  }
  return cursors;
}
function minStarsForWalk({ previous, modes, slices } = {}) {
  const sliceFloor = slices?.github?.minStars ?? null;
  if (modes?.github === "full") return sliceFloor ?? 0;
  const held = Number(previous?.minStars);
  if (!Number.isFinite(held)) return sliceFloor;
  return sliceFloor === null ? held : Math.min(held, sliceFloor);
}
function normalizeCursors(raw) {
  const cursors = emptyCursors();
  for (const source of WALK_SOURCES) cursors[source] = normalizeCursor(raw?.[source]);
  return cursors;
}
function reasonOf(err, { maxRequests, requests }) {
  if (err?.code === "aborted") return "\u5DF2\u4E2D\u6B62";
  if (err?.code === "quota") {
    const seconds = Number.isFinite(err.retryAfterMs) ? Math.ceil(err.retryAfterMs / 1e3) : null;
    return seconds ? `\u4E0A\u6E38\u9650\u6D41\uFF08\u7EA6 ${seconds} \u79D2\u540E\u6062\u590D\uFF09\uFF0C\u4E0B\u6B21\u7EE7\u7EED` : "\u4E0A\u6E38\u9650\u6D41\uFF0C\u4E0B\u6B21\u7EE7\u7EED";
  }
  if (err?.code === "budget") return `\u8BF7\u6C42\u9884\u7B97\u7528\u5B8C\uFF08${maxRequests} \u6B21\uFF09\uFF0C\u4E0B\u6B21\u7EE7\u7EED`;
  return `\u7B2C ${requests} \u6B21\u8BF7\u6C42\u5931\u8D25\uFF1A${String(err?.message ?? err)}`;
}
async function walkSkillIndex({
  fetch: fetchImpl = (...args) => globalThis.fetch(...args),
  token = null,
  cursors = {},
  // Rows already on disk. Needed because a resumed slice re-reads bands and
  // pages it already has: counting "baseline + this run" double-counts every
  // repeated id and makes a safety cap fire long before the slice is full.
  previous = [],
  slices = SLICES,
  maxRequests = MAX_RUN_REQUESTS,
  sleep = defaultSleep2,
  signal = null,
  onProgress,
  now = Date.now
} = {}) {
  const started = now();
  const state = normalizeCursors(cursors);
  const byId = /* @__PURE__ */ new Map();
  const truncations = [];
  let requests = 0;
  let partial = null;
  const aborted = () => signal?.aborted === true;
  const baselineIds = {};
  for (const source of WALK_SOURCES) baselineIds[source] = /* @__PURE__ */ new Set();
  for (const row of Array.isArray(previous) ? previous : []) {
    const id = String(row?.id ?? "");
    const source = String(row?.source ?? "");
    const ids = baselineIds[source];
    if (!id || !ids) continue;
    const generation = Date.parse(state[source]?.sampleStartedAt ?? "");
    if (Number.isFinite(generation) && !(Date.parse(row.lastSeen ?? "") >= generation)) continue;
    ids.add(id);
  }
  const heldOf = (source) => {
    const ids = new Set(baselineIds[source]);
    for (const row of byId.values()) if (row.source === source) ids.add(row.id);
    return ids.size;
  };
  const keep = (source, items, at) => {
    for (const item of items ?? []) {
      if (!item?.id) continue;
      const held = byId.get(item.id);
      byId.set(item.id, { ...item, firstSeen: held?.firstSeen ?? at, lastSeen: at });
    }
  };
  const headersFor = (source) => {
    const headers = { "user-agent": USER_AGENT2 };
    if (source === "github") {
      headers.accept = "application/vnd.github+json";
      if (token) headers.authorization = `Bearer ${token}`;
    }
    return headers;
  };
  const ask = async (source, url, pacingMs, firstOfSource) => {
    if (aborted()) throw abortError();
    if (requests >= maxRequests) {
      const err = new Error(`skill index request budget spent (${maxRequests})`);
      err.code = "budget";
      throw err;
    }
    if (!firstOfSource && pacingMs > 0) await sleep(pacingMs);
    if (aborted()) throw abortError();
    requests += 1;
    const response = await fetchImpl(url, {
      headers: headersFor(source),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS2)
    });
    const status = Number(response?.status ?? 0);
    if (status === 429 || status === 403 && Number(response?.headers?.get?.("x-ratelimit-remaining")) === 0) {
      const retryAfter = Number(response?.headers?.get?.("retry-after"));
      const reset = Number(response?.headers?.get?.("x-ratelimit-reset"));
      const err = new Error(`${source} rate limited`);
      err.code = "quota";
      err.retryAfterMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1e3 : Number.isFinite(reset) && reset * 1e3 > Date.now() ? reset * 1e3 - Date.now() : 6e4;
      throw err;
    }
    if (!response?.ok) {
      const text = await response?.text?.().catch(() => "") ?? "";
      throw new Error(`${source} returned ${status}: ${clip3(text, 200) || "no body"}`);
    }
    return response.json();
  };
  const tick = (source, page, at) => {
    onProgress?.({
      requests,
      rows: byId.size,
      source,
      page,
      cursors: JSON.parse(JSON.stringify(state)),
      items: byId,
      at
    });
  };
  async function walkGithubWindows(cursor, plan) {
    const windowMax = plan.pagesPerWindow * plan.pageSize;
    let firstOfSource = true;
    let bandStartRows = cursor.rows;
    while (!cursor.done) {
      const qualifier = cursor.hi === null ? `stars:>=${plan.minStars}` : `stars:${plan.minStars}..${cursor.hi}`;
      const page = cursor.page + 1;
      if (page === 1) bandStartRows = cursor.rows;
      if (page > plan.pagesPerWindow) {
        cursor.page = 0;
        continue;
      }
      let body;
      try {
        const query = `${GITHUB_QUERY} ${qualifier}`;
        const url = `${GITHUB_SEARCH}?q=${encodeURIComponent(query)}&sort=stars&order=desc&per_page=${plan.pageSize}&page=${page}`;
        body = await ask("github", url, plan.pacingMs, firstOfSource);
      } catch (err) {
        partial = reasonOf(err, { maxRequests, requests });
        return;
      }
      firstOfSource = false;
      const at = new Date(now()).toISOString();
      const raw = Array.isArray(body?.items) ? body.items : [];
      const total = Number(body?.total_count);
      if (Number.isFinite(total) && cursor.hi === null) cursor.total = total;
      cursor.page = page;
      if (page === 1) cursor.windows += 1;
      keep("github", raw.map(githubRepoItem).filter(Boolean), at);
      cursor.rows = heldOf("github");
      tick("github", cursor.page, at);
      if (raw.length === 0 || cursor.rows >= plan.target) {
        cursor.done = true;
        break;
      }
      const pagesInWindow = Math.min(
        plan.pagesPerWindow,
        Math.max(1, Math.ceil((Number.isFinite(total) ? total : windowMax) / plan.pageSize))
      );
      if (page < pagesInWindow) continue;
      if (Number.isFinite(total) && total <= windowMax) {
        cursor.done = true;
        break;
      }
      const lowest = raw.reduce((min, repo) => {
        const stars = Number(repo?.stargazers_count);
        return Number.isFinite(stars) && stars < min ? stars : min;
      }, Infinity);
      if (!Number.isFinite(lowest)) {
        cursor.done = true;
        break;
      }
      const gained = cursor.rows - bandStartRows;
      const bandCeiling = cursor.hi;
      const repeatsBand = !(lowest < (bandCeiling ?? Infinity)) || gained === 0;
      const nextHi = repeatsBand ? lowest - 1 : lowest;
      if (nextHi < plan.minStars) {
        truncations.push({
          source: "github",
          reason: `stars:${plan.minStars} \u4E00\u6863\u5C31\u6709\u8D85\u8FC7 ${windowMax} \u4E2A\u4ED3\u5E93\uFF0C\u540C\u4E00 Star \u503C\u65E0\u6CD5\u7EE7\u7EED\u6536\u7A84`
        });
        cursor.done = true;
        break;
      }
      if (cursor.windows >= plan.maxWindows) {
        truncations.push({ source: "github", reason: `\u7A97\u53E3\u6570\u4E0A\u9650 ${plan.maxWindows}\uFF0C\u505C\u5728 ${cursor.rows} \u884C` });
        cursor.done = true;
        break;
      }
      if (repeatsBand && gained > 0) {
        truncations.push({
          source: "github",
          reason: `stars:${lowest} \u7684\u540C\u661F\u5757\u8D85\u8FC7\u7A97\u53E3\u5BB9\u91CF\uFF0C\u8FD9\u4E00\u6863\u5C11\u6536\u4E86\u82E5\u5E72\u884C`
        });
      }
      cursor.hi = nextHi;
      cursor.page = 0;
    }
  }
  const walked = /* @__PURE__ */ new Set();
  for (const source of WALK_SOURCES) {
    if (partial) break;
    const plan = slices?.[source] ?? SLICES[source];
    const cursor = state[source];
    if (cursor.done) continue;
    cursor.rows = heldOf(source);
    if (cursor.rows >= plan.target) {
      cursor.done = true;
      continue;
    }
    walked.add(source);
    if (source === "github") {
      await walkGithubWindows(cursor, plan);
      continue;
    }
    const pageCap = Math.max(1, plan.maxPages);
    let firstOfSource = true;
    let stop = false;
    while (!cursor.done && !stop) {
      const page = cursor.page + 1;
      if (page > pageCap) {
        cursor.done = true;
        break;
      }
      let body;
      try {
        if (source === "skillhub") {
          const url = `${SKILLHUB_LIST}?page=${page}&pageSize=${plan.pageSize}&sortBy=downloads&order=desc`;
          body = await ask(source, url, plan.pacingMs, firstOfSource);
        } else {
          const params = new URLSearchParams({
            limit: String(plan.pageSize),
            sort: "downloads",
            nonSuspiciousOnly: "true"
          });
          if (cursor.cursor) params.set("cursor", cursor.cursor);
          body = await ask(source, `${CLAWHUB_LIST}?${params}`, plan.pacingMs, firstOfSource);
        }
      } catch (err) {
        partial = reasonOf(err, { maxRequests, requests });
        stop = true;
        break;
      }
      firstOfSource = false;
      const at = new Date(now()).toISOString();
      let empty = false;
      if (source === "skillhub") {
        const raw = Array.isArray(body?.data?.skills) ? body.data.skills : [];
        const total = Number(body?.data?.total);
        if (Number.isFinite(total)) cursor.total = total;
        cursor.page = page;
        keep(source, raw.map(skillhubItem2).filter((item) => item && item.name), at);
        empty = raw.length === 0;
      } else {
        const raw = Array.isArray(body?.items) ? body.items : Array.isArray(body?.results) ? body.results : [];
        cursor.page = page;
        cursor.cursor = typeof body?.nextCursor === "string" && body.nextCursor ? body.nextCursor : null;
        keep(source, raw.map(clawhubItem2).filter(Boolean), at);
        empty = raw.length === 0 || !cursor.cursor;
      }
      cursor.rows = heldOf(source);
      tick(source, cursor.page, at);
      if (empty) cursor.done = true;
      else if (cursor.rows >= plan.target) {
        if (source === "clawhub" && cursor.cursor) {
          truncations.push({ source, reason: `\u5B89\u5168\u4E0A\u9650 ${plan.target} \u884C\uFF0C\u6E38\u6807\u8FD8\u6CA1\u8D70\u5B8C` });
        }
        cursor.done = true;
      } else if (page >= pageCap) {
        const moreRemains = source === "clawhub" ? Boolean(cursor.cursor) : Number.isFinite(cursor.total) ? page * plan.pageSize < cursor.total : true;
        if (moreRemains) truncations.push({ source, reason: `\u9875\u6570\u4E0A\u9650 ${pageCap} \u9875\uFF0C\u8FD8\u6CA1\u8D70\u5230\u5E95` });
        cursor.done = true;
      } else if (source === "skillhub" && Number.isFinite(cursor.total) && page * plan.pageSize >= cursor.total) {
        cursor.done = true;
      }
      if (cursor.done) break;
    }
  }
  return {
    rows: [...byId.values()].sort(compareRows),
    cursors: state,
    requests,
    at: new Date(now()).toISOString(),
    tookMs: Math.max(0, now() - started),
    // "Complete" means every source reached *its own* stop condition — the
    // slice budget, the upstream end, or the API ceiling. It never means "this
    // is the catalogue": `truncations` is where a source admits it stopped
    // before the end, and the panel repeats that instead of hiding it.
    complete: !partial && WALK_SOURCES.every((source) => state[source].done),
    partial,
    truncations,
    walked: [...walked]
  };
}
function mergeSkillRows(previous, fresh, {
  at = (/* @__PURE__ */ new Date()).toISOString(),
  keepMs = SKILL_INDEX_KEEP_MS,
  maxRows = SKILL_INDEX_MAX_ROWS,
  now = Date.now
} = {}) {
  const merged = /* @__PURE__ */ new Map();
  const cutoff = now() - keepMs;
  const previousRows = Array.isArray(previous) ? previous.filter((row) => row?.id) : [];
  for (const row of previousRows) {
    const seen = Date.parse(row.lastSeen ?? "") || 0;
    if (seen && seen < cutoff) continue;
    merged.set(String(row.id), row);
  }
  for (const row of fresh ?? []) {
    const id = String(row?.id ?? "");
    if (!id) continue;
    const held = merged.get(id);
    merged.set(id, { ...row, firstSeen: held?.firstSeen ?? row.firstSeen ?? at, lastSeen: at });
  }
  const cap = Math.max(1, Number(maxRows) || 0, previousRows.length);
  return [...merged.values()].sort(compareRows).slice(0, cap);
}
function normalizeSkillIndexDocument(raw) {
  const sources = new Set(SKILL_MARKET_SOURCES);
  const rows = [];
  const seen = /* @__PURE__ */ new Set();
  for (const row of Array.isArray(raw?.rows) ? raw.rows : []) {
    const id = String(row?.id ?? "");
    if (!id || seen.has(id) || !sources.has(String(row?.source ?? ""))) continue;
    seen.add(id);
    rows.push({ ...row, id });
  }
  return {
    version: SKILL_INDEX_VERSION,
    at: typeof raw?.at === "string" ? raw.at : null,
    complete: raw?.complete === true,
    partial: typeof raw?.partial === "string" ? raw.partial : null,
    requests: Number.isFinite(raw?.requests) ? raw.requests : void 0,
    // The GitHub slice is "above this star floor", so the file has to say what
    // the floor was: a row count without it is not a population definition.
    minStars: Number.isFinite(raw?.minStars) ? raw.minStars : SLICES.github.minStars,
    // Which sources the user asked to walk to their end. Recorded because a
    // row count alone cannot say whether this file is a slice of SkillHub or
    // all of it, and the panel must be able to tell the two apart.
    modes: normalizeModes(raw?.modes),
    cursors: normalizeCursors(raw?.cursors),
    truncations: Array.isArray(raw?.truncations) ? raw.truncations.filter((entry) => entry && typeof entry.reason === "string").map((entry) => ({ source: String(entry.source ?? ""), reason: entry.reason })) : [],
    rows: rows.sort(compareRows)
  };
}
function skillIndexDocumentOf(doc) {
  const normalized = normalizeSkillIndexDocument(doc);
  return {
    version: SKILL_INDEX_VERSION,
    at: normalized.at,
    complete: normalized.complete,
    partial: normalized.partial,
    requests: normalized.requests,
    minStars: normalized.minStars,
    modes: normalized.modes,
    cursors: normalized.cursors,
    truncations: normalized.truncations,
    rows: normalized.rows
  };
}
async function readSkillIndexDocument(file, readFileImpl) {
  let raw;
  try {
    raw = await readFileImpl(file, "utf8");
  } catch (err) {
    if (err?.code === "ENOENT") return { doc: null, damaged: null };
    return { doc: null, damaged: String(err?.message ?? err) };
  }
  try {
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object") return { doc: null, damaged: "JSON \u9876\u5C42\u4E0D\u662F\u5BF9\u8C61" };
    const doc = normalizeSkillIndexDocument(parsed);
    return { doc: doc.rows.length ? doc : null, damaged: null };
  } catch (err) {
    return { doc: null, damaged: String(err?.message ?? err) };
  }
}
function skillIndexFreshness(doc, { now = Date.now, ttlMs = SKILL_INDEX_TTL_MS } = {}) {
  const at = typeof doc?.at === "string" ? Date.parse(doc.at) : NaN;
  if (!Number.isFinite(at)) return { at: null, ageMs: null, stale: true };
  const ageMs = Math.max(0, now() - at);
  return { at: doc.at, ageMs, stale: ageMs > ttlMs };
}
function needsSkillWalk(doc, { force = false, ...freshness } = {}) {
  if (force) return true;
  if (!doc?.rows?.length) return true;
  if (doc.complete !== true) return true;
  return skillIndexFreshness(doc, freshness).stale;
}
function skillIndexSummary(doc, { now = Date.now, ttlMs = SKILL_INDEX_TTL_MS } = {}) {
  const rows = Array.isArray(doc?.rows) ? doc.rows : [];
  const counts = {};
  for (const row of rows) counts[row.source] = (counts[row.source] ?? 0) + 1;
  const { at, ageMs, stale } = skillIndexFreshness(doc, { now, ttlMs });
  const cursors = normalizeCursors(doc?.cursors);
  const modes = normalizeModes(doc?.modes);
  return {
    rows: rows.length,
    counts,
    at,
    ageMs,
    stale,
    complete: doc?.complete === true,
    partial: doc?.partial ?? null,
    requests: doc?.requests,
    // The population definition for the GitHub slice: repositories at or above
    // this star count. Without it, "GitHub 8.4k" would read as "all of them".
    minStars: Number.isFinite(doc?.minStars) ? doc.minStars : SLICES.github.minStars,
    // Which sources were walked to their end rather than to a slice.
    modes,
    truncations: Array.isArray(doc?.truncations) ? doc.truncations : [],
    sources: WALK_SOURCES.map((source) => ({
      id: source,
      rows: counts[source] ?? 0,
      total: Number.isFinite(cursors[source].total) ? cursors[source].total : void 0,
      done: cursors[source].done,
      page: cursors[source].page,
      mode: modes[source],
      // Only the GitHub slice descends; how many bands it has read is the
      // one progress fact a page number cannot express.
      windows: cursors[source].windows
    }))
  };
}
var SKILL_MARKET_CATEGORIES = ["dev", "search", "office", "content", "data", "knowledge", "agent", "other"];
var skillHubBuckets = new Map(Object.entries({
  "dev-programming": "dev",
  "it-ops-security": "dev",
  "ai-agent": "agent",
  "office-efficiency": "office",
  "business-ops": "office",
  professional: "office",
  "content-creation": "content",
  "design-media": "content",
  "data-analysis": "data",
  "knowledge-management": "knowledge",
  education: "knowledge",
  "life-service": "other"
}));
var bucketRules = [
  ["search", /\b(?:search|web browser|browser automation|crawler|scraping|news|rss|research)\b|搜索|检索|爬虫/iu],
  ["office", /\b(?:pdf|docx|xlsx|excel|spreadsheet|slides?|pptx|powerpoint|office|document|invoice)\b|办公|公文|表格|文档/iu],
  ["content", /\b(?:image|video|audio|music|design|branding|writing|translate|subtitle|poster)\b|视频|音频|创作|翻译/iu],
  ["data", /\b(?:data analysis|analytics|sql|database|charts?|metrics?|statistics|pandas|csv)\b|数据分析|数据库/iu],
  ["knowledge", /\b(?:notes?|memory|knowledge|wiki|obsidian|notion|learning)\b|知识库|笔记/iu],
  ["agent", /\b(?:agents?|automation|workflow|mcp|llm|prompts?|orchestration)\b|智能体|自动化/iu],
  ["dev", /\b(?:code|coding|development|developer|git|github|typescript|python|rust|java|cli|debugging|deployment|docker|refactor|security)\b|编程|代码|开发|调试/iu]
];
var marketRowInfo = /* @__PURE__ */ new WeakMap();
function infoFor(row) {
  let info = marketRowInfo.get(row);
  if (info) return info;
  const name2 = String(row.name ?? "").toLowerCase();
  const title = String(row.title ?? "").toLowerCase();
  const topics = Array.isArray(row.topics) ? row.topics.join(" ") : "";
  const category = row.source === "skillhub" ? skillHubBuckets.get(String(row.category ?? "").toLowerCase()) : void 0;
  const classify = (text) => bucketRules.find(([, pattern]) => pattern.test(text))?.[0];
  info = {
    name: name2,
    title,
    text: [name2, title, row.summary, row.category, topics, row.owner, row.install?.owner, row.install?.repo].join(" ").toLowerCase(),
    category: category ?? classify(topics) ?? classify(name2 + " " + title) ?? classify(row.summary ?? "") ?? "other"
  };
  marketRowInfo.set(row, info);
  return info;
}
var titleOrder = new Intl.Collator(void 0, { sensitivity: "base", numeric: true });
function querySkillRows(rows, { query = "", source = "all", category = "all", sort = "default", offset = 0, limit = 20 } = {}) {
  const term = typeof query === "string" ? query.trim().toLowerCase() : "";
  const wanted = source && source !== "all" ? String(source) : null;
  const available = Array.isArray(rows) ? rows : [];
  const matches = [];
  const categories = {};
  for (const row of available) {
    if (wanted && row.source !== wanted) continue;
    const info = infoFor(row);
    if (term && !info.text.includes(term)) continue;
    categories[info.category] = (categories[info.category] ?? 0) + 1;
    if (category !== "all" && info.category !== category) continue;
    matches.push({ row, info });
  }
  matches.sort((a, b) => {
    if (sort === "name") return titleOrder.compare(a.info.title || a.info.name, b.info.title || b.info.name) || a.row.id.localeCompare(b.row.id);
    return compareRows(a.row, b.row, true);
  });
  let ranked = matches;
  let deferredSkillHub = 0;
  if (!wanted && !term && sort !== "name") {
    const front = [];
    const rest = [];
    for (const match of matches) {
      if (front.length < SKILLHUB_FIRST_RANK - 1 && match.row.source !== "skillhub") front.push(match);
      else rest.push(match);
    }
    if (front.length === SKILLHUB_FIRST_RANK - 1) ranked = front.concat(rest);
    else {
      ranked = front;
      deferredSkillHub = rest.length;
    }
  }
  const size = Math.min(Math.max(Math.floor(Number(limit) || 20), 1), 200);
  const requested = Math.floor(Math.max(0, Number(offset) || 0) / size) * size;
  const last = Math.floor(Math.max(0, ranked.length - 1) / size) * size;
  const start = Math.min(requested, last);
  return {
    items: ranked.slice(start, start + size).map(({ row, info }) => ({
      ...row,
      marketCategory: info.category,
      icon: row.icon || (row.source === "github" ? githubOwnerIcon(row.install?.repo?.split("/")[0]) : void 0)
    })),
    matched: ranked.length,
    ...deferredSkillHub ? { deferredSkillHub } : {},
    categories,
    offset: start,
    limit: size
  };
}

// lib/calls.js
import fs4 from "node:fs/promises";
import path6 from "node:path";
import { randomUUID as randomUUID2 } from "node:crypto";
var CALL_KEEP_MS = 7 * 24 * 60 * 60 * 1e3;
var CALL_LIMIT_LINES = 2e4;
var CALL_LIMIT_BYTES = 8 * 1024 * 1024;
var CALL_MEMORY_LIMIT = 4e3;
var PRUNE_EVERY = 200;
var CALL_RANGES = { "1h": 60 * 60 * 1e3, "24h": 24 * 60 * 60 * 1e3, "7d": CALL_KEEP_MS };
var MAX_TEXT = 400;
var SENSITIVE_KEY = /(authorization|token|api[-_]?key|apikey|secret|cookie|password|credential|bearer)/i;
function redactValue(value, depth = 0) {
  if (typeof value === "string") {
    const safe = redactSecrets(value);
    return safe.length > MAX_TEXT ? `${safe.slice(0, MAX_TEXT)}\u2026` : safe;
  }
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) {
    if (depth >= 3) return `[${value.length}]`;
    const items = value.slice(0, 12).map((item) => redactValue(item, depth + 1));
    return value.length > 12 ? [...items, `\u2026${value.length - 12} more`] : items;
  }
  if (value && typeof value === "object") {
    if (depth >= 3) return "{\u2026}";
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = SENSITIVE_KEY.test(key) && item !== void 0 && item !== null ? "\u2022\u2022\u2022\u2022" : redactValue(item, depth + 1);
    }
    return out;
  }
  return void 0;
}
function argsOf(raw) {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw;
  if (typeof raw === "string" && raw.trim().startsWith("{")) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    } catch {
    }
  }
  return {};
}
function textOf(value) {
  if (typeof value === "string") return redactValue(value);
  try {
    const text = JSON.stringify(redactValue(value));
    if (typeof text !== "string") return "";
    return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}\u2026` : text;
  } catch {
    return "";
  }
}
function classifyCall(name2, args) {
  if (typeof name2 !== "string" || name2 === "") return null;
  if (name2.startsWith("mcp__")) {
    const parts = name2.split("__");
    if (parts.length < 3 || parts[1] === "") return null;
    return { space: "mcp", server: parts[1], tool: parts.slice(2).join("__") };
  }
  if (name2 === "skill") {
    const skill = argsOf(args).name;
    if (typeof skill !== "string" || skill === "") return { space: "skill", skill: null, tool: name2 };
    return { space: "skill", skill, tool: name2 };
  }
  return null;
}
function shortSession(sessionId) {
  const text = typeof sessionId === "string" ? sessionId : "";
  return text.length <= 6 ? text : text.slice(-6);
}
function runningRowOf(sessionId, event, at = Date.now()) {
  const data = event?.data;
  if (!data || typeof data !== "object") return null;
  const name2 = data.name;
  const kind = classifyCall(name2, data.arguments);
  if (!kind) return null;
  const callId = typeof data.callId === "string" && data.callId !== "" ? data.callId : null;
  return {
    id: `${sessionId ?? "unknown"}#${callId ?? `${name2}@${at}`}`,
    space: kind.space,
    kind: kind.space === "skill" ? "\u89E6\u53D1" : void 0,
    name: name2,
    tool: kind.tool,
    server: kind.server,
    skill: kind.skill,
    status: "running",
    startedAt: new Date(at).toISOString(),
    ms: null,
    session: shortSession(sessionId),
    ...Number.isInteger(data.turn) ? { callTurn: data.turn } : {},
    ...Number.isInteger(data.step) ? { callStep: data.step } : {},
    req: textOf(data.arguments),
    res: null,
    note: null
  };
}
var SKILL_BLOCK = /<skill_content\s+name="([^"]{1,120})"/g;
var SKILL_SCAN_BUDGET = 1024 * 1024;
var USER_SKILL_MERGE_MS = 5 * 60 * 1e3;
function skillReferencesIn(value, limit = 8) {
  const found = [];
  const seen = /* @__PURE__ */ new Set();
  let budget = SKILL_SCAN_BUDGET;
  const walk = (node, depth) => {
    if (found.length >= limit || budget <= 0 || depth > 6 || node === null || node === void 0) return;
    if (typeof node === "string") {
      budget -= node.length;
      for (const match of node.matchAll(SKILL_BLOCK)) {
        const name2 = match[1].trim();
        if (!name2 || seen.has(name2)) continue;
        seen.add(name2);
        found.push(name2);
        if (found.length >= limit) return;
      }
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) walk(item, depth + 1);
      return;
    }
    if (typeof node === "object") {
      for (const item of Object.values(node)) walk(item, depth + 1);
    }
  };
  walk(value, 0);
  return found;
}
var USER_SKILL_NOTE = "\u4F60\u5728\u8F93\u5165\u6846\u91CC\u7528\u659C\u6760\u547D\u4EE4\u5F15\u7528\u4E86\u8FD9\u4E2A\u6280\u80FD\uFF08\u5BBF\u4E3B\u628A\u5B83\u5C55\u5F00\u6CE8\u5165\u672C\u6B21\u8BF7\u6C42\uFF09";
function userSkillRowOf(sessionId, skill, at = Date.now(), note = USER_SKILL_NOTE) {
  return {
    id: `${sessionId ?? "unknown"}#user-skill-${skill}@${at}`,
    schema: 2,
    count: 1,
    space: "skill",
    kind: "\u89E6\u53D1",
    name: "skill",
    tool: "skill",
    skill,
    via: "\u7528\u6237\u5F15\u7528",
    status: "ok",
    startedAt: new Date(at).toISOString(),
    ms: null,
    session: shortSession(sessionId),
    req: "",
    res: null,
    note
  };
}
function eventCount(row) {
  return row.via === "\u7528\u6237\u5F15\u7528" && Number.isInteger(row.count) && row.count > 0 ? row.count : 1;
}
function summarizeSkillUsage(rows, now = Date.now()) {
  const usage = /* @__PURE__ */ new Map();
  for (const row of rows) {
    if (row?.space !== "skill" || row.status !== "ok" || row.kind === "\u4F1A\u8BDD\u52A0\u8F7D") continue;
    const name2 = typeof row.skill === "string" ? row.skill.trim() : "";
    const at = Date.parse(row.startedAt);
    if (!name2 || !Number.isFinite(at) || at < now - CALL_KEEP_MS || at > now) continue;
    const current = usage.get(name2) ?? { name: name2, count: 0, lastUsedAt: at };
    current.count += eventCount(row);
    current.lastUsedAt = Math.max(current.lastUsedAt, at);
    usage.set(name2, current);
  }
  return [...usage.values()];
}
function foldReferences(rows, windowMs = USER_SKILL_MERGE_MS) {
  const list = Array.isArray(rows) ? rows : [];
  if (!(windowMs > 0)) return list.slice();
  const out = [];
  const groups = /* @__PURE__ */ new Map();
  for (const row of list) {
    if (row?.via !== "\u7528\u6237\u5F15\u7528") {
      out.push(row);
      continue;
    }
    const key = `${row.session ?? ""}#${row.skill ?? ""}`;
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
function userSkillRowsOf(sessionId, event, at = Date.now()) {
  const data = event?.data;
  if (!data || typeof data !== "object") return [];
  const source = data.source;
  if (!source || typeof source !== "object" || source.kind !== "skill-invocation") return [];
  const named = typeof source.name === "string" && source.name.trim() !== "" ? [source.name.trim()] : skillReferencesIn(data);
  return named.map((skill) => userSkillRowOf(sessionId, skill, at));
}
function settlementOf(event) {
  const data = event?.data;
  if (!data || typeof data !== "object") return null;
  const error = data.error;
  const failed = Boolean(error) || data.isError === true || data.message?.isError === true;
  const reason = failed ? textOf(typeof error === "string" ? error : error?.info ?? error?.message ?? data.message?.content ?? "\u5DE5\u5177\u8FD4\u56DE\u5931\u8D25") : null;
  return { failed, reason, res: textOf(data.message ?? data.result ?? "") };
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
function summarize(rows, { space = "mcp", range = "24h", filter = "", q = "", merge = USER_SKILL_MERGE_MS, now = Date.now() } = {}) {
  const rangeMs = CALL_RANGES[range] ?? CALL_RANGES["24h"];
  const since = now - rangeMs;
  const inSpace = (rows ?? []).filter((row) => row && row.space === space);
  const todayStart = startOfDay(now);
  const today = inSpace.reduce((sum, row) => sum + (Date.parse(row.startedAt) >= todayStart && Date.parse(row.startedAt) <= now ? eventCount(row) : 0), 0);
  const inWindow = inSpace.filter((row) => {
    const at = Date.parse(row.startedAt);
    return Number.isFinite(at) && at >= since && at <= now;
  });
  const needle = typeof q === "string" ? q.trim().toLowerCase() : "";
  const wanted = typeof filter === "string" ? filter.trim() : "";
  const filtered = inWindow.filter((row) => {
    if (wanted !== "") {
      const key = space === "mcp" ? row.server ?? "" : row.skill ?? "";
      if (key !== wanted) return false;
    }
    if (needle !== "") {
      const hay = [row.tool, row.name, row.skill, row.kind, row.session, shortSession(row.session)].filter((part) => typeof part === "string").join(" ").toLowerCase();
      if (!hay.includes(needle)) return false;
    }
    return true;
  });
  const ordered = filtered.slice().sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
  const view = space === "skill" ? foldReferences(ordered, merge) : ordered;
  const references = filtered.filter((row) => row.via === "\u7528\u6237\u5F15\u7528").reduce((sum, row) => sum + eventCount(row), 0);
  const completedLoads = filtered.filter((row) => row.via !== "\u7528\u6237\u5F15\u7528" && (row.status === "ok" || row.status === "fail"));
  const loaded = completedLoads.filter((row) => row.status === "ok").length;
  const ok = loaded + references;
  const fail = completedLoads.length - loaded;
  const settled = ok + fail;
  const timed = completedLoads.filter((row) => Number.isFinite(row.ms));
  const avgMs = timed.length === 0 ? null : Math.round(timed.reduce((sum, row) => sum + row.ms, 0) / timed.length);
  const buckets = 24;
  const spark = new Array(buckets).fill(0);
  for (const row of filtered) {
    spark[bucketOf(Date.parse(row.startedAt) - since, rangeMs, buckets)] += eventCount(row);
  }
  const groups = /* @__PURE__ */ new Map();
  const keyOf = (row) => space === "mcp" ? row.server ?? "\u672A\u77E5\u670D\u52A1\u5668" : row.skill ?? "\u672A\u8BB0\u5F55 skill";
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
    merge: space === "skill" ? merge : 0,
    stats: {
      today,
      inRange: inWindow.reduce((sum, row) => sum + eventCount(row), 0),
      ok,
      fail,
      settled,
      ...space === "skill" ? { references } : {},
      rate: settled === 0 ? null : Math.round(ok / settled * 1e3) / 10,
      avgMs,
      shown: view.length,
      spark
    },
    rail,
    rows: view.slice(0, 300)
  };
}
var callWriteChains = /* @__PURE__ */ new Map();
var CallStore = class {
  constructor({ file, now = () => Date.now(), memoryLimit = CALL_MEMORY_LIMIT, pendingLimit = CALL_MEMORY_LIMIT, fileLimits = {}, onError = (error) => console.error(error.message) } = {}) {
    this.file = file;
    this.now = now;
    this.memoryLimit = memoryLimit;
    this.pendingLimit = pendingLimit;
    this.limits = { lines: fileLimits.lines ?? CALL_LIMIT_LINES, bytes: fileLimits.bytes ?? CALL_LIMIT_BYTES };
    this.rows = [];
    this.byId = /* @__PURE__ */ new Map();
    this.ownedIds = /* @__PURE__ */ new Set();
    this.dropped = 0;
    this.damaged = 0;
    this.loaded = false;
    this.sig = null;
    this.appends = 0;
    this.chain = Promise.resolve();
    this.pending = [];
    this.pendingBytes = 0;
    this.pendingDropped = 0;
    this.appendScheduled = false;
    this.pruneScheduled = false;
    this.repairedDamaged = 0;
    this.warnedResultIssues = /* @__PURE__ */ new Set();
    this.storageErrors = /* @__PURE__ */ new Map();
    this.onError = onError;
    this.lastSavedAt = null;
  }
  storageFailure(operation, cause) {
    const error = new Error(`\u8C03\u7528\u8BB0\u5F55 ${operation} \u5931\u8D25\uFF1A${redactSecrets(String(cause?.message ?? cause))}`, { cause });
    if (this.storageErrors.get(operation)?.message !== error.message) {
      this.storageErrors.set(operation, { operation, message: error.message, at: new Date(this.now()).toISOString() });
      this.onError(error);
    }
    return error;
  }
  enqueueWrite(operation, task) {
    const previous = callWriteChains.get(this.file) ?? this.chain;
    const result = previous.then(async () => {
      try {
        const value = await task();
        this.storageErrors.delete(operation);
        this.lastSavedAt = new Date(this.now()).toISOString();
        return value;
      } catch (error) {
        throw this.storageFailure(operation, error);
      }
    });
    this.chain = result.then(() => {
    }, () => {
    });
    const observed = this.chain;
    callWriteChains.set(this.file, observed);
    void observed.then(() => {
      if (callWriteChains.get(this.file) === observed) callWriteChains.delete(this.file);
    });
    return result;
  }
  async drainPending() {
    if (!this.pending.length) return;
    await fs4.mkdir(path6.dirname(this.file), { recursive: true });
    let separator = "";
    let handle;
    try {
      handle = await fs4.open(this.file, "r");
      const { size } = await handle.stat();
      if (size > 0) {
        const last = Buffer.alloc(1);
        const { bytesRead } = await handle.read(last, 0, 1, size - 1);
        if (bytesRead === 1 && last[0] !== 10) separator = "\n";
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    } finally {
      await handle?.close();
    }
    while (this.pending.length) {
      const entry = this.pending.shift();
      this.pendingBytes -= entry.bytes;
      try {
        await fs4.appendFile(this.file, separator + entry.line, "utf8");
        separator = "";
      } catch (error) {
        this.pending.unshift(entry);
        this.pendingBytes += entry.bytes;
        this.boundPending();
        throw error;
      }
    }
    this.storageErrors.delete("append");
  }
  /** Read failures remain visible and are retried on the next access. */
  async load({ strict = false } = {}) {
    if (this.loaded) return this;
    return this.readFromDisk({ strict });
  }
  /**
   * Pick up what the subscriber appended after the first read.
   *
   * The reader asks on demand, so the feed must include rows written since the
   * plugin started; the size/mtime pair keeps that honest without re-reading
   * the file on every scroll.
   */
  async refresh({ strict = false } = {}) {
    await this.chain;
    if (!this.loaded) return this.load({ strict });
    if (!this.file) return this;
    let stat = null;
    try {
      stat = await fs4.stat(this.file);
    } catch (error) {
      if (error.code !== "ENOENT") {
        const failure = this.storageFailure("read", error);
        if (strict) throw failure;
      } else this.storageErrors.delete("read");
      return this;
    }
    if (`${stat.size}:${stat.mtimeMs}` === this.sig && !this.storageErrors.has("read")) return this;
    return this.readFromDisk({ strict });
  }
  async readFromDisk({ strict = false } = {}) {
    if (!this.file) return this;
    let raw = "";
    try {
      raw = await fs4.readFile(this.file, "utf8");
    } catch (error) {
      if (error.code === "ENOENT") {
        this.loaded = true;
        this.storageErrors.delete("read");
        return this;
      }
      const failure = this.storageFailure("read", error);
      if (strict) throw failure;
      return this;
    }
    this.loaded = true;
    this.storageErrors.delete("read");
    this.damaged = 0;
    const stat = await fs4.stat(this.file).catch(() => null);
    if (stat) this.sig = `${stat.size}:${stat.mtimeMs}`;
    const oldest = this.now() - CALL_KEEP_MS;
    const diskOrder = /* @__PURE__ */ new Map();
    for (const line of raw.split("\n")) {
      const text = line.trim();
      if (text === "") continue;
      let row = null;
      try {
        row = JSON.parse(text);
      } catch {
        this.damaged += 1;
        continue;
      }
      if (!row || typeof row !== "object" || typeof row.id !== "string" || !row.id || !Number.isFinite(Date.parse(row.startedAt))) {
        this.damaged += 1;
        continue;
      }
      if (row.kind === "\u4F1A\u8BDD\u52A0\u8F7D") continue;
      if (row.via === "\u7528\u6237\u5F15\u7528" && row.schema !== 2) continue;
      if (Date.parse(row.startedAt) < oldest) continue;
      if (!diskOrder.has(row.id)) diskOrder.set(row.id, diskOrder.size);
      for (const field of ["req", "res", "note"]) if (typeof row[field] === "string") row[field] = redactSecrets(row[field]);
      if (!this.ownedIds.has(row.id)) this.put(row, { write: false });
    }
    for (const row of this.rows) {
      if (row.via === "\u7528\u6237\u5F15\u7528") {
        row.status = "ok";
        row.ms = null;
        row.count = eventCount(row);
        continue;
      }
      if (row.status === "running" && !this.ownedIds.has(row.id)) {
        row.status = "lost";
        row.ms = null;
        row.note = "\u5BBF\u4E3B\u5728\u8FD9\u6B21\u8C03\u7528\u8FD4\u56DE\u524D\u9000\u51FA\u4E86\uFF0C\u7ED3\u679C\u6CA1\u80FD\u53D6\u5230";
      }
    }
    const unsavedOrder = Number.MAX_SAFE_INTEGER;
    this.rows.sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt) || (diskOrder.get(a.id) ?? unsavedOrder) - (diskOrder.get(b.id) ?? unsavedOrder));
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
    if (write) {
      if (this.rows.length > this.memoryLimit) this.trim();
      this.appendToFile(merged);
    }
    return merged;
  }
  /** Start a call. Returns the row, or null when the event was not ours. */
  start(row) {
    if (!row) return null;
    return this.put({ ...row, status: "running" });
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
      status: failed ? "fail" : "ok",
      ms,
      res: res ?? row.res,
      note: failed ? reason ?? "\u5DE5\u5177\u8FD4\u56DE\u5931\u8D25" : row.note ?? null
    });
  }
  settleEvent(sessionId, event) {
    if (event?.surfaceOp === "replace" || event?.surfaceOp?.op === "replace") return null;
    const nested = event?.data?.message?.source?.callId;
    const legacy = event?.data?.callId;
    const callId = typeof nested === "string" && nested ? nested : legacy;
    const conflict = typeof nested === "string" && nested && typeof legacy === "string" && legacy && nested !== legacy;
    if (!sessionId || typeof callId !== "string" || !callId || conflict) {
      const reason = conflict ? "\u8C03\u7528\u6807\u8BC6\u51B2\u7A81" : "\u7F3A\u5C11\u4F1A\u8BDD\u6216\u8C03\u7528\u6807\u8BC6";
      if (!this.warnedResultIssues.has(reason)) {
        this.warnedResultIssues.add(reason);
        this.onError(new Error(`\u8C03\u7528\u7ED3\u679C\u672A\u8BB0\u5F55\uFF1A${reason}\u3002`));
      }
      return null;
    }
    const id = `${sessionId}#${callId}`;
    const row = this.byId.get(id);
    if (row?.status !== "running") return null;
    if (Number.isInteger(row.callTurn) && Number.isInteger(event.data.turn) && row.callTurn !== event.data.turn) return null;
    if (Number.isInteger(row.callStep) && Number.isInteger(event.data.step) && row.callStep !== event.data.step) return null;
    return this.settle(id, settlementOf(event));
  }
  /**
   * The newest still-running row of one session.
   *
   * A display lookup only. Result events must use the exact call ID.
   */
  newestRunning(sessionId) {
    const short = shortSession(sessionId);
    for (let i = this.rows.length - 1; i >= 0; i -= 1) {
      const row = this.rows[i];
      if (row.status === "running" && row.session === short) return row;
    }
    return null;
  }
  /** Mark a call whose result never arrived (session ended, host stopped waiting). */
  abandon(id, note) {
    const row = this.byId.get(id);
    if (!row || row.status !== "running") return null;
    return this.put({ ...row, status: "lost", ms: null, note: note ?? "\u6CA1\u6709\u7B49\u5230\u7ED3\u679C\u4E8B\u4EF6" });
  }
  appendToFile(row) {
    if (!this.file) return;
    const line = `${JSON.stringify(row)}
`;
    const bytes = Buffer.byteLength(line, "utf8");
    this.pending.push({ line, bytes });
    this.pendingBytes += bytes;
    this.boundPending();
    this.scheduleAppend();
    this.appends += 1;
    if (this.appends % PRUNE_EVERY === 0 && !this.pruneScheduled) {
      this.pruneScheduled = true;
      this.enqueueWrite("prune", async () => {
        try {
          await this.pruneOnDisk();
        } finally {
          this.pruneScheduled = false;
        }
      });
    }
  }
  scheduleAppend() {
    if (this.appendScheduled) return;
    this.appendScheduled = true;
    this.enqueueWrite("append", async () => {
      try {
        await this.drainPending();
      } finally {
        this.appendScheduled = false;
      }
      if (this.pending.length) this.scheduleAppend();
    });
  }
  boundPending() {
    while (this.pending.length > this.pendingLimit || this.pendingBytes > CALL_LIMIT_BYTES) {
      this.pendingBytes -= this.pending.shift().bytes;
      this.pendingDropped++;
    }
  }
  /** Drop the old end of memory; returns how many rows went. */
  trim() {
    const oldest = this.now() - CALL_KEEP_MS;
    let kept = [];
    for (const row of this.rows) {
      const at = Date.parse(row.startedAt);
      if (Number.isFinite(at) && at >= oldest) kept.push(row);
      else this.dropped += 1;
    }
    let excess = kept.length - this.memoryLimit;
    if (excess > 0) {
      kept = kept.filter((row) => {
        if (excess <= 0 || row.status === "running" && this.ownedIds.has(row.id)) return true;
        excess--;
        this.dropped++;
        return false;
      });
      if (excess > 0) {
        this.dropped += excess;
        kept = kept.slice(excess);
        if (!this.warnedResultIssues.has("\u8FDB\u884C\u4E2D\u8C03\u7528\u8D85\u9650")) {
          this.warnedResultIssues.add("\u8FDB\u884C\u4E2D\u8C03\u7528\u8D85\u9650");
          this.onError(new Error("\u8FDB\u884C\u4E2D\u7684\u8C03\u7528\u8D85\u51FA\u8BB0\u5F55\u4E0A\u9650\uFF0C\u90E8\u5206\u8F83\u65E9\u8C03\u7528\u65E0\u6CD5\u7EE7\u7EED\u8DDF\u8E2A\u3002"));
        }
      }
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
  prune() {
    if (!this.file) return Promise.resolve(null);
    return this.enqueueWrite("prune", () => this.pruneOnDisk());
  }
  async pruneOnDisk() {
    if (!this.file) return null;
    await this.drainPending();
    let raw = "";
    try {
      raw = await fs4.readFile(this.file, "utf8");
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
    const onDisk = raw.split("\n").filter((line) => line.trim() !== "").length;
    const diskBytes = Buffer.byteLength(raw, "utf8");
    if (onDisk <= this.limits.lines && diskBytes <= this.limits.bytes) return null;
    const latest = /* @__PURE__ */ new Map();
    let damaged = 0;
    for (const text of raw.split("\n")) {
      if (!text.trim()) continue;
      let row;
      try {
        row = JSON.parse(text);
      } catch {
        damaged++;
        continue;
      }
      if (!row || typeof row !== "object" || typeof row.id !== "string" || !row.id || !Number.isFinite(Date.parse(row.startedAt))) {
        damaged++;
        continue;
      }
      for (const field of ["req", "res", "note"]) if (typeof row[field] === "string") row[field] = redactSecrets(row[field]);
      latest.set(row.id, row);
    }
    const oldest = this.now() - CALL_KEEP_MS;
    const snapshot = [...latest.values()].filter((row) => Date.parse(row.startedAt) >= oldest);
    const kept = [];
    let size = 0;
    for (const row of snapshot.reverse()) {
      const line = JSON.stringify(row);
      const bytes = Buffer.byteLength(line + "\n", "utf8");
      if (size + bytes > this.limits.bytes) break;
      kept.unshift(row);
      size += bytes;
      if (kept.length >= this.limits.lines) break;
    }
    const tmp = `${this.file}.${randomUUID2()}.tmp`;
    try {
      await fs4.mkdir(path6.dirname(this.file), { recursive: true });
      await fs4.writeFile(tmp, kept.map((row) => JSON.stringify(row)).join("\n") + (kept.length > 0 ? "\n" : ""), { encoding: "utf8", flag: "wx", mode: 384 });
      await fs4.rename(tmp, this.file);
    } finally {
      await fs4.rm(tmp, { force: true });
    }
    this.trim();
    this.repairedDamaged += damaged;
    this.damaged = 0;
    if (damaged) this.onError(new Error(`\u8C03\u7528\u65E5\u5FD7\u6E05\u7406\u65F6\u79FB\u9664\u4E86 ${damaged} \u6761\u635F\u574F\u8BB0\u5F55\uFF0C\u5176\u4ED6\u6709\u6548\u8BB0\u5F55\u5DF2\u4FDD\u7559\u3002`));
    return { kept: kept.length, damaged };
  }
  /** Wait for queued writes to land (tests and shutdown). */
  async retryPersistence() {
    await this.enqueueWrite("append", () => this.drainPending());
    if (this.storageErrors.has("prune")) await this.prune();
    if (this.storageErrors.has("read")) await this.refresh({ strict: true });
    await this.flush();
  }
  async flush() {
    let tail;
    do {
      tail = this.chain;
      await tail;
    } while (tail !== this.chain);
    const failure = this.storageErrors.values().next().value;
    if (failure) throw new Error(failure.message);
  }
  coverage() {
    const oldest = this.rows.length === 0 ? null : this.rows[0].startedAt;
    return {
      since: oldest,
      kept: this.rows.length,
      dropped: this.dropped,
      damaged: this.damaged,
      ...this.repairedDamaged ? { repairedDamaged: this.repairedDamaged } : {},
      running: this.rows.filter((row) => row.status === "running").length,
      persistence: {
        ok: this.storageErrors.size === 0,
        pending: this.pending.length,
        ...this.pendingDropped ? { dropped: this.pendingDropped } : {},
        lastSavedAt: this.lastSavedAt,
        errors: [...this.storageErrors.values()]
      }
    };
  }
};

// index.js
var name = "overall-mcp";
var inject = ["tools"];
var REGISTRY_VERSION = 1;
var LOADED_AT = /* @__PURE__ */ new Date();
var PLUGIN_DIR = path7.dirname(fileURLToPath2(import.meta.url));
var SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;
var CONNECT_WAIT_MS = 8e3;
var CONNECT_CONCURRENCY = 4;
var STARTUP_WAIT_MS = 2500;
var DIAGNOSIS_TIMEOUT_MS = 2e4;
var DIAGNOSIS_CACHE_MAX = 32;
var DIAGNOSIS_TTL_MS = 10 * 60 * 1e3;
var ABOUT_I18N_TIMEOUT_MS = 15e3;
var HEALTH_HANDSHAKE_WAIT_MS = 12e3;
var MOUNT_RETRY_MS = [800, 2500];
var TRANSIENT_MOUNT_ERROR = /ECONNRESET|ECONNREFUSED|ECONNABORTED|EPIPE|ETIMEDOUT|ENETUNREACH|EAI_AGAIN|ENOTFOUND|socket hang up|fetch failed|network|timed out|aborted/i;
function dataDir() {
  const home2 = process.env.DSH_HOME || path7.join(os3.homedir(), ".dsh");
  return path7.join(home2, "overall-mcp");
}
var tempSerial = 0;
async function writeJson(file, value) {
  await fs5.mkdir(path7.dirname(file), { recursive: true, mode: 448 });
  tempSerial += 1;
  const tmp = `${file}.${process.pid}.${tempSerial}.tmp`;
  await fs5.writeFile(tmp, JSON.stringify(value, null, 2), { encoding: "utf8", mode: 384 });
  try {
    await fs5.chmod(tmp, 384);
  } catch {
  }
  try {
    await fs5.rename(tmp, file);
  } catch (err) {
    try {
      await fs5.unlink(tmp);
    } catch {
    }
    throw err;
  }
  try {
    await fs5.chmod(file, 384);
  } catch {
  }
}
async function readRegistryDocument(file) {
  let raw;
  try {
    raw = await fs5.readFile(file, "utf8");
    try {
      await fs5.chmod(file, 384);
    } catch {
    }
  } catch (err) {
    if (err?.code === "ENOENT") return { registry: null, damaged: null };
    return { registry: null, damaged: String(err?.message ?? err) };
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.servers)) {
      return { registry: null, damaged: "JSON \u91CC\u6CA1\u6709 servers \u6570\u7EC4" };
    }
    return { registry: parsed, damaged: null };
  } catch (err) {
    return { registry: null, damaged: String(err?.message ?? err) };
  }
}
function toServerName(name2) {
  let slug = String(name2).toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32);
  return SERVER_NAME_PATTERN.test(slug) ? slug : null;
}
function toMcpConfig(entry, serverName) {
  if (!serverName) return null;
  if (entry.transport === "streamable-http" || entry.transport === "sse") {
    return { transport: "streamable-http", serverName, url: entry.url, headers: entry.headers ?? {} };
  }
  return {
    transport: "stdio",
    serverName,
    command: entry.command,
    // `mountArgv` owns the argv: a CLI-channel entry appends its `--config` JSON,
    // and a `docker run` entry threads its stored env through `-e KEY=value`
    // before the image (docker's own process env never reaches the container).
    args: mountArgv(entry),
    env: entry.env ?? {},
    cwd: entry.cwd ?? ""
  };
}
function isNameConflict(err) {
  return /already in use|unique serverName/i.test(String(err?.message ?? err));
}
function installSchemaGuard(ctx, log) {
  const registry = ctx.tools;
  const original = registry?.register;
  if (typeof original !== "function") return;
  const wrapper = function guardedRegister(definition) {
    return original.call(this, sanitizeToolDefinition(definition, {
      onChange: ({ name: name2, changes }) => {
        log?.warn?.(`overall-mcp: repaired ${changes.length} regex keyword(s) in ${name2} (${changes.map((c) => `${c.path}:${c.action}`).join(", ")})`);
      }
    }));
  };
  try {
    Object.defineProperty(registry, "register", { value: wrapper, configurable: true, writable: true });
  } catch (err) {
    log?.warn?.(`overall-mcp: schema guard unavailable: ${String(err?.message ?? err)}`);
    return;
  }
  log?.info?.("overall-mcp: schema guard installed for mcp__* tool schemas");
  ctx.effect(() => () => {
    try {
      delete registry.register;
    } catch {
    }
  }, "overall-mcp.schema-guard");
}
function renderJson(args, value) {
  return [{ type: "text", text: JSON.stringify(toJsonSafe(value), null, 2) }];
}
function toJsonSafe(value, seen = /* @__PURE__ */ new WeakSet()) {
  if (value === null) return null;
  const type = typeof value;
  if (type === "string" || type === "boolean") return value;
  if (type === "number") return Number.isFinite(value) ? value : null;
  if (type === "bigint") return value.toString();
  if (type === "undefined" || type === "function" || type === "symbol") return void 0;
  if (type !== "object") return value;
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  try {
    if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
    if (Array.isArray(value)) return Array.from(value, (item) => toJsonSafe(item, seen));
    if (value instanceof Map) return toJsonSafe(Object.fromEntries(value), seen);
    if (value instanceof Set) return toJsonSafe([...value], seen);
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      const safe = toJsonSafe(item, seen);
      if (safe !== void 0) out[key] = safe;
    }
    return out;
  } finally {
    seen.delete(value);
  }
}
function withJsonSafeOutput(definition) {
  const execute = definition?.execute;
  if (typeof execute !== "function") return definition;
  return {
    ...definition,
    async execute(...callArgs) {
      return toJsonSafe(await execute.apply(this, callArgs));
    }
  };
}
function collectPatterns(schema, path8 = "", found = []) {
  if (schema === null || typeof schema !== "object") return found;
  for (const [key, value] of Object.entries(schema)) {
    const here = path8 ? `${path8}.${key}` : key;
    if (key === "pattern" && typeof value === "string") found.push({ path: here, pattern: value });
    else if (key === "patternProperties" && value && typeof value === "object") {
      for (const source of Object.keys(value)) found.push({ path: `${here}.${source}`, pattern: source });
    }
    collectPatterns(value, here, found);
  }
  return found;
}
async function apply(ctx) {
  const log = ctx.logger?.("overall-mcp") ?? ctx.logger;
  const dir = dataDir();
  const registryFile = path7.join(dir, "registry.json");
  const aboutI18nFile = path7.join(dir, "about-i18n.json");
  const reportFile = path7.join(dir, "scan-report.json");
  const eventsFile = path7.join(dir, "events.ndjson");
  setEventSink((event) => appendEvents(eventsFile, [event]), { onError: (error) => log?.error?.(`overall-mcp: ${error.message}`) });
  const callsFile = path7.join(dir, "calls.jsonl");
  const callStore = new CallStore({ file: callsFile, onError: (error) => log?.error?.(`overall-mcp: ${error.message}`) });
  void callStore.load();
  const prefsFile = path7.join(dir, "ui-prefs.json");
  const CALL_MERGE_MAX = 7 * 24 * 3600 * 1e3;
  const readPrefs = async () => {
    try {
      const parsed = JSON.parse(await fs5.readFile(prefsFile, "utf8"));
      const merge = Number(parsed?.merge);
      return Number.isFinite(merge) && merge >= 0 ? { merge: Math.min(merge, CALL_MERGE_MAX) } : {};
    } catch {
      return {};
    }
  };
  const writePrefs = async (next) => {
    await fs5.mkdir(dir, { recursive: true });
    const tmp = `${prefsFile}.tmp-${process.pid}`;
    await fs5.writeFile(tmp, JSON.stringify(next, null, 2) + "\n", "utf8");
    await fs5.rename(tmp, prefsFile);
  };
  const unmodelledEventTypes = /* @__PURE__ */ new Set();
  const subscribeCalls = () => {
    if (typeof ctx.on !== "function") return false;
    try {
      ctx.on("session/event", (session, event) => {
        try {
          const sessionId = session?.id ?? session?.header?.id ?? null;
          const type = typeof event?.type === "string" ? event.type : "";
          if (type === "tool/call") {
            callStore.start(runningRowOf(sessionId, event, callStore.now()));
            return;
          }
          if (type === "tool/result") {
            callStore.settleEvent(sessionId, event);
            return;
          }
          if (type === "user/message") {
            for (const row of userSkillRowsOf(sessionId, event, callStore.now())) {
              callStore.recordReference(sessionId, row.skill, Date.parse(row.startedAt));
            }
            return;
          }
          if (!unmodelledEventTypes.has(type)) {
            unmodelledEventTypes.add(type);
            emit({ kind: "session-event", action: "unmodelled", type, keys: Object.keys(event?.data ?? {}) });
          }
        } catch (err) {
          log?.warn?.(`overall-mcp: \u8C03\u7528\u8BB0\u5F55\u8DF3\u8FC7\u4E00\u6761\u4E8B\u4EF6 \u2014 ${String(err?.message ?? err)}`);
        }
      });
      return true;
    } catch (err) {
      log?.warn?.(`overall-mcp: \u65E0\u6CD5\u8BA2\u9605\u4F1A\u8BDD\u4E8B\u4EF6\uFF0C\u8C03\u7528\u9875\u5C06\u662F\u7A7A\u7684 \u2014 ${String(err?.message ?? err)}`);
      return false;
    }
  };
  subscribeCalls();
  let lastAuthObservation = "";
  const refreshGithubAuth = async ({ force = false, useGh = "auto" } = {}) => {
    try {
      const status = await resolveGithubAuth({ dir, force, useGh });
      const observation = `${status.checkedAt}:${status.source}:${status.error ?? ""}`;
      if (observation !== lastAuthObservation && useGh === "auto") {
        lastAuthObservation = observation;
        emit({ kind: "auth", action: "auto-resolve", source: status.source, inUse: status.inUse, cached: status.cached === true, ...status.error ? { error: status.error } : {} });
        if (status.error) log?.warn?.(`overall-mcp: automatic GitHub login detection: ${status.error}`);
      }
      return status;
    } catch (err) {
      log?.warn?.(`overall-mcp: GitHub credential resolution failed: ${String(err?.message ?? err)}`);
      return githubAuthStatus();
    }
  };
  void refreshGithubAuth();
  const installsFile = path7.join(dir, "installs.json");
  let installs = await readInstalls(installsFile);
  const sourcesFile = path7.join(dir, "sources.json");
  const loadedSources = await readSourcesDocument(sourcesFile, (file, enc) => fs5.readFile(file, enc));
  let customSources = loadedSources.sources;
  let sourcesLoadError = null;
  if (loadedSources.damaged) {
    const stamp = (/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-");
    const backup = `${sourcesFile}.corrupt-${stamp}`;
    try {
      await fs5.copyFile(sourcesFile, backup);
    } catch {
    }
    sourcesLoadError = `\u81EA\u5B9A\u4E49\u76EE\u5F55\u6E90\u6587\u4EF6\u65E0\u6CD5\u89E3\u6790\uFF08${loadedSources.damaged}\uFF09\uFF0C\u672C\u6B21\u4EE5\u7A7A\u5217\u8868\u542F\u52A8\uFF1B\u539F\u6587\u4EF6\u5DF2\u5907\u4EFD\u4E3A ${path7.basename(backup)}`;
    log?.warn?.(`overall-mcp: ${sourcesLoadError}`);
    emit({ kind: "sources", action: "damaged", error: loadedSources.damaged, backup: path7.basename(backup) });
  }
  async function saveSources() {
    await writeJson(sourcesFile, sourcesDocumentOf(customSources));
  }
  const loaded = await readRegistryDocument(registryFile);
  let registry = loaded.registry;
  let writeChain = Promise.resolve();
  let registryLoadError = null;
  if (loaded.damaged) {
    const stamp = (/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-");
    const backup = `${registryFile}.corrupt-${stamp}`;
    try {
      await fs5.copyFile(registryFile, backup);
    } catch {
    }
    registryLoadError = `\u6CE8\u518C\u8868\u6587\u4EF6\u65E0\u6CD5\u89E3\u6790\uFF08${loaded.damaged}\uFF09\uFF0C\u672C\u6B21\u4EE5\u7A7A\u6CE8\u518C\u8868\u542F\u52A8\uFF1B\u539F\u6587\u4EF6\u5DF2\u5907\u4EFD\u4E3A ${path7.basename(backup)}`;
    log?.warn?.(`overall-mcp: ${registryLoadError}`);
    emit({ kind: "registry", action: "damaged", error: loaded.damaged, backup: path7.basename(backup) });
  }
  const firstRun = registry === null && loaded.damaged === null;
  if (!registry) registry = { version: REGISTRY_VERSION, servers: [] };
  const favorites = new Set(Array.isArray(registry.favorites) ? registry.favorites.filter((k) => typeof k === "string") : []);
  {
    const repaired = collapseDuplicateRows(registry);
    if (repaired.collapsed.length > 0) {
      registry = repaired.registry;
      log?.warn?.(`overall-mcp: collapsed ${repaired.collapsed.length} duplicate row(s) \u2014 ${repaired.collapsed.map((c) => `${c.name} (-${c.dropped})`).join(", ")}`);
      emit({ kind: "registry", action: "collapse", collapsed: repaired.collapsed });
      await save();
    }
  }
  {
    let stripped = 0;
    for (const s of registry.servers) {
      if (s && Object.prototype.hasOwnProperty.call(s, "health")) {
        delete s.health;
        stripped += 1;
      }
    }
    if (stripped > 0) await save();
  }
  {
    let invented = 0;
    for (const entry of registry.servers ?? []) {
      const stored = entry?.config;
      if (!stored || stored.origin !== "manual" || !Array.isArray(stored.fields) || stored.fields.length !== 1) continue;
      if (entry.transport !== "streamable-http" && entry.transport !== "sse") continue;
      const only = stored.fields[0];
      if (!(only?.key === "Authorization" && only?.kind === "header")) continue;
      if (configSpecFor(null, entry) !== null) continue;
      const value = entry.headers && typeof entry.headers === "object" ? entry.headers.Authorization : void 0;
      if (typeof value === "string" && value !== "") continue;
      delete entry.config;
      invented += 1;
    }
    if (invented > 0) await save();
  }
  let aboutI18nCache = /* @__PURE__ */ new Map();
  try {
    aboutI18nCache = cacheFromRows(JSON.parse(await fs5.readFile(aboutI18nFile, "utf8")));
  } catch {
  }
  async function saveAboutI18n() {
    try {
      await writeJson(aboutI18nFile, cacheRowsOf(aboutI18nCache, I18N_CACHE_MAX));
    } catch (err) {
      log?.warn?.(`overall-mcp: \u7FFB\u8BD1\u7F13\u5B58\u5199\u5165\u5931\u8D25 \u2014 ${err?.message ?? err}`);
    }
  }
  const fibers = /* @__PURE__ */ new Map();
  const starting = /* @__PURE__ */ new Set();
  const health = /* @__PURE__ */ new Map();
  const rowFingerprint = (row) => [row?.name, row?.transport, row?.command ?? row?.url ?? "", (row?.args ?? []).join(" ")].join("");
  installSchemaGuard(ctx, log);
  async function save() {
    registry.version = REGISTRY_VERSION;
    const run = writeChain.then(
      () => writeJson(registryFile, registry),
      () => writeJson(registryFile, registry)
    );
    writeChain = run.then(() => {
    }, () => {
    });
    return run;
  }
  let mutationQueue = Promise.resolve();
  function serialized(fn) {
    return (...args) => {
      const run = mutationQueue.then(() => fn(...args), () => fn(...args));
      mutationQueue = run.then(() => {
      }, () => {
      });
      return run;
    };
  }
  const mountAttempts = /* @__PURE__ */ new Map();
  let disposed = false;
  const mountRetryTimers = /* @__PURE__ */ new Set();
  function scheduleMountRetry(entry) {
    if (disposed) return;
    const error = String(entry.connectError ?? "");
    if (!TRANSIENT_MOUNT_ERROR.test(error)) return;
    if (entry.enabled === false || entry.providedExternally === true) return;
    if (fibers.has(entry.name) || starting.has(entry.name)) return;
    const used = mountAttempts.get(entry.name) ?? 0;
    if (used >= MOUNT_RETRY_MS.length) {
      log?.warn?.(`overall-mcp: giving up on ${entry.name} after ${used + 1} mount attempts: ${error}`);
      return;
    }
    const delay = MOUNT_RETRY_MS[used];
    mountAttempts.set(entry.name, used + 1);
    const timer = setTimeout(() => {
      mountRetryTimers.delete(timer);
      if (disposed) return;
      serialized(async () => {
        if (disposed) return;
        if (entry.enabled === false || entry.providedExternally === true) return;
        if (fibers.has(entry.name) || starting.has(entry.name)) return;
        if (!(registry.servers ?? []).includes(entry)) return;
        log?.info?.(`overall-mcp: retrying mount of ${entry.name} (attempt ${used + 2}) after: ${error}`);
        await connect(entry);
      })().catch((err) => {
        log?.warn?.(`overall-mcp: retry of ${entry.name} threw: ${redactSecrets(err?.message ?? err)}`);
      });
    }, delay);
    mountRetryTimers.add(timer);
    if (typeof timer.unref === "function") timer.unref();
  }
  async function connect(entry) {
    if (disposed) return { ok: false, error: "plugin disposed" };
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
        entry.connectError = void 0;
        delete entry.serverName;
        log?.info?.(`overall-mcp: ${entry.name} is already provided by another mcp-client mount, skipping`);
        return { ok: true, skipped: "already-provided", serverName };
      }
      entry.connectError = redactSecrets(err?.message ?? err);
      log?.warn?.(`overall-mcp: could not mount ${entry.name}: ${entry.connectError}`);
      scheduleMountRetry(entry);
      return { ok: false, error: entry.connectError };
    }
    let failure = null;
    let timedOut = false;
    await Promise.race([
      fiber.await().catch((err) => {
        failure = err;
      }),
      new Promise((resolve) => {
        setTimeout(() => {
          timedOut = true;
          resolve();
        }, CONNECT_WAIT_MS);
      })
    ]);
    if (failure) {
      try {
        await fiber.dispose();
      } catch {
      }
      if (isNameConflict(failure)) {
        entry.providedExternally = true;
        entry.connectError = void 0;
        delete entry.serverName;
        log?.info?.(`overall-mcp: ${entry.name} is already provided by another mcp-client mount, skipping`);
        return { ok: true, skipped: "already-provided", serverName };
      }
      entry.connectError = redactSecrets(failure?.message ?? failure);
      log?.warn?.(`overall-mcp: could not connect ${entry.name}: ${entry.connectError}`);
      scheduleMountRetry(entry);
      return { ok: false, error: entry.connectError };
    }
    if (disposed) {
      await fiber.dispose();
      return { ok: false, error: "plugin disposed" };
    }
    fibers.set(entry.name, fiber);
    setMountHolder(registry.servers, entry.name, entry, serverName);
    entry.connectError = void 0;
    entry.providedExternally = false;
    if (!timedOut) mountAttempts.delete(entry.name);
    if (timedOut) {
      starting.add(entry.name);
      fiber.await().then(
        () => {
          if (disposed || fibers.get(entry.name) !== fiber) return;
          starting.delete(entry.name);
          mountAttempts.delete(entry.name);
          log?.info?.(`overall-mcp: ${entry.name} finished connecting in the background`);
        },
        async (err) => {
          if (disposed || fibers.get(entry.name) !== fiber) return;
          starting.delete(entry.name);
          entry.connectError = redactSecrets(err?.message ?? err);
          if (fibers.get(entry.name) === fiber) {
            fibers.delete(entry.name);
            clearMountHolder(registry.servers, entry.name);
            try {
              await fiber.dispose();
            } catch {
            }
          }
          log?.warn?.(`overall-mcp: ${entry.name} failed to connect: ${entry.connectError}`);
          scheduleMountRetry(entry);
        }
      );
    }
    return { ok: true, serverName, toolPrefix: `mcp__${serverName}__`, starting: timedOut };
  }
  async function disconnect(name2) {
    const fiber = fibers.get(name2);
    starting.delete(name2);
    mountAttempts.delete(name2);
    if (!fiber) return;
    fibers.delete(name2);
    clearMountHolder(registry.servers, name2);
    try {
      await fiber.dispose();
    } catch {
    }
  }
  async function mapLimited(items, limit, worker) {
    const list = [...items];
    const results = new Array(list.length);
    let next = 0;
    const width = Math.max(1, Math.min(limit, list.length));
    await Promise.all(Array.from({ length: width }, async () => {
      for (; ; ) {
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
    const names = [...new Set(enabled.map((entry) => entry.name))];
    const answers = await mapLimited(names, CONNECT_CONCURRENCY, async (name2) => {
      const entry = enabled.find((row) => row.name === name2);
      return { name: name2, ...await connect(entry) };
    });
    const byName = new Map(answers.map((answer) => [answer.name, answer]));
    return enabled.map((entry) => byName.get(entry.name));
  }
  let healthVerdict = null;
  function publicList() {
    const orphans = new Set(orphanEntries());
    return registry.servers.map((s, slot) => {
      const enabled = s.enabled !== false;
      const mounted = fibers.has(s.name);
      const startingNow = mounted && starting.has(s.name) && !s.connectError;
      const connected = mounted && !startingNow;
      const providedExternally = !mounted && s.providedExternally === true;
      const status = s.connectError ? "error" : providedExternally ? "provided-externally" : startingNow ? "starting" : connected ? "connected" : enabled ? "idle" : "stopped";
      const stored = s.updateCheck ?? null;
      const describesThisEntry = checkDescribesEntry(s, stored);
      const spec = specOf(s);
      const config = maskedFields(spec, s);
      const configNeeds = configState(spec, s)?.needs === true;
      const channel = channelOf(s);
      const cachedHealth = health.get(s.name)?.fingerprint === rowFingerprint(s) ? health.get(s.name) : null;
      if (cachedHealth && cachedHealth.ok === false && !s.connectError) {
        const live = healthVerdict?.(s, {
          attempted: cachedHealth.attempted === true,
          waitedMs: Number.isFinite(cachedHealth.waitedMs) ? cachedHealth.waitedMs : 0
        });
        if (live.ok) health.set(s.name, { ...live, fingerprint: rowFingerprint(s) });
      }
      return {
        name: s.name,
        // Position in the registry. Two rows can share a name (one client config
        // may define the same server twice), so anything that has to act on "the
        // row that was clicked" needs a per-row identity, not a name.
        slot,
        transport: s.transport,
        source: s.source,
        artworkKey: mcpArtworkKey(s.catalogId, void 0, s.url),
        icon: publicIcon(s.icon),
        iconCandidates: cleanPublisherIcons(s.iconCandidates),
        // The last scan read this entry's source and it no longer defines a
        // server by this name: the row is a leftover, not a config anyone has.
        orphan: orphans.has(s),
        enabled,
        connected,
        // Mounted, handshake still in flight: connected is false and status is
        // 'starting', so the panel can show 正在连接 instead of a green dot.
        starting: startingNow,
        status,
        providedExternally,
        // This session's 检查 verdict for the row, verbatim (`{ at, ok,
        // toolCount, checks, ms }`). Absent until someone asks for one in this
        // host run — it is never read back from the registry, because a verdict
        // that outlives the process that computed it is just an old guess.
        ...health.get(s.name)?.fingerprint === rowFingerprint(s) ? { health: health.get(s.name) } : {},
        serverName: s.serverName ?? toServerName(s.name) ?? void 0,
        error: s.connectError ? redactSecrets(s.connectError) : s.connectError,
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
        aboutLabel: s.about ? aboutSourceLabel(s.about.source) : "",
        // The masked config projection. Only present when the entry declares
        // fields, so every existing consumer of this payload is unchanged.
        config,
        // A required value is absent, so the server cannot work yet. This is the
        // fact the panel badges and the model is told about in `overall_mcp_list`.
        needConfig: configNeeds,
        // `env` | `headers` | `cli-json`: where the form writes and how the mount
        // delivers it. Always present, because a row with no declared fields still
        // has a channel the panel can offer.
        channel
      };
    });
  }
  const instructionSections = /* @__PURE__ */ new Map();
  const instructionGen = /* @__PURE__ */ new Map();
  let instructionsRead = false;
  const ABOUT_RETRY_MS = 30 * 1e3;
  function readInstructionSections() {
    return new Promise((resolve) => {
      let settled = false;
      let dispose = null;
      const timer = setTimeout(() => finish2(null), 2500);
      timer.unref?.();
      function finish2(value) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (typeof dispose === "function") {
          try {
            dispose();
          } catch {
          }
        }
        resolve(value);
      }
      try {
        const maybeDispose = ctx.inject(["systemPrompt"], (inner) => {
          Promise.resolve().then(() => inner.systemPrompt?.assemble?.({})).then((assembly) => {
            const found = /* @__PURE__ */ new Map();
            for (const section of assembly?.sections ?? []) {
              const sectionName = typeof section?.name === "string" ? section.name : "";
              if (sectionName.startsWith("mcp:")) {
                found.set(sectionName.slice(4), String(section?.text ?? ""));
              }
            }
            finish2(found);
          }, () => finish2(null));
        });
        if (typeof maybeDispose === "function") dispose = maybeDispose;
        if (settled && typeof dispose === "function") {
          try {
            dispose();
          } catch {
          }
        }
      } catch {
        finish2(null);
      }
    });
  }
  const serverIsLive = (s) => fibers.has(s.name) || s.providedExternally === true;
  const aboutGen = (s) => serverIsLive(s) ? "live" : "down";
  function aboutIsCurrent(s, now) {
    if (!s.about?.text) return false;
    if (s.about.source === "server") return true;
    if (!serverIsLive(s)) return false;
    const at = Date.parse(s.aboutAt ?? "");
    return Number.isFinite(at) && now - at < ABOUT_RETRY_MS;
  }
  async function refreshAbout() {
    const now = Date.now();
    const pending = registry.servers.filter((s) => s.enabled !== false && !aboutIsCurrent(s, now));
    if (!pending.length) return false;
    const wanted = pending.map((s) => ({ s, name: s.serverName ?? toServerName(s.name) }));
    const stale = wanted.some(({ s, name: name2 }) => needsInstructionsRead({
      read: instructionsRead,
      rememberedGen: name2 ? instructionGen.get(name2) : void 0,
      live: serverIsLive(s),
      name: name2
    }));
    if (stale) {
      const sections = await readInstructionSections();
      instructionsRead = true;
      if (sections) {
        for (const [sectionName, text] of sections) {
          instructionSections.set(sectionName, text);
          instructionGen.set(sectionName, "live");
        }
      }
      for (const { s, name: name2 } of wanted) if (name2) instructionGen.set(name2, aboutGen(s));
    }
    const schemas = typeof ctx.tools?.schemas === "function" ? ctx.tools.schemas() : [];
    let changed = false;
    for (const { s, name: name2 } of wanted) {
      const about = describeAbout({
        instructions: name2 ? instructionSections.get(name2) : "",
        toolNames: toolNamesFor(schemas, name2),
        command: s.transport === "stdio" || !s.transport ? [s.command, ...s.args ?? []] : [s.url]
      });
      if (!about) continue;
      s.about = about;
      s.aboutAt = new Date(now).toISOString();
      changed = true;
    }
    if (changed) {
      await save();
      const tally = {};
      for (const s of registry.servers) if (s.about) tally[s.about.source] = (tally[s.about.source] ?? 0) + 1;
      log?.info?.(`overall-mcp: purpose lines \u2014 ${Object.entries(tally).map(([k, v]) => `${k} ${v}`).join(", ")}`);
    }
    return changed;
  }
  async function serversPayload() {
    await refreshAbout();
    const servers = publicList();
    const needConfig = servers.filter((s) => s.needConfig && s.enabled).length;
    return { servers, needConfig, ...registryLoadError ? { registryError: registryLoadError } : {} };
  }
  const SKILLS_TTL_MS = 6e4;
  let skillsCache = null;
  let skillsCacheAt = 0;
  async function skillsPayload({ refresh = false } = {}) {
    const now = Date.now();
    if (!refresh && skillsCache && now - skillsCacheAt < SKILLS_TTL_MS) return skillsCache;
    const answer = await readSkills({ dshHome: path7.dirname(dataDir()) });
    const needsPage = new Set(answer.skills.filter((row) => !row.pageUrl && row.marketId?.startsWith("skillhub:")).map((row) => row.marketId));
    if (needsPage.size) {
      const pages = /* @__PURE__ */ new Map();
      const index = await skillIndexPayload();
      for (const item of index?.rows ?? []) {
        if (item.source !== "skillhub" || !needsPage.has(item.id)) continue;
        const page = skillSourcePage(item);
        if (!page) continue;
        pages.set(item.id, page);
        needsPage.delete(item.id);
        if (!needsPage.size) break;
      }
      for (const row of answer.skills) {
        if (!row.pageUrl && pages.has(row.marketId)) row.pageUrl = pages.get(row.marketId);
      }
    }
    skillsCache = answer;
    skillsCacheAt = now;
    return answer;
  }
  async function revealSkill(id) {
    const { skills } = await skillsPayload();
    const skill = skills.find((row) => row.id === id);
    if (!skill) return { ok: false, status: 404, error: "unknown skill" };
    const opener = process.platform === "win32" ? "explorer.exe" : process.platform === "darwin" ? "open" : "xdg-open";
    try {
      const child = spawn(opener, [skill.dir], { detached: true, stdio: "ignore" });
      child.unref();
    } catch (err) {
      return { ok: false, status: 500, error: String(err?.message ?? err) };
    }
    return { ok: true, dir: skill.dir };
  }
  async function removeSkill(id) {
    const { skills } = await skillsPayload();
    const skill = skills.find((row) => row.id === id);
    if (!skill) return { ok: false, status: 404, error: "unknown skill" };
    const stamp = (/* @__PURE__ */ new Date()).toISOString().replace(/\.\d+Z$/, "").replace(/[T:]/g, "-");
    let out;
    try {
      out = await moveToTrash({ skill, trashRoot: path7.join(dataDir(), TRASH_DIR), stamp });
    } catch (err) {
      return { ok: false, status: 500, error: String(err?.message ?? err) };
    }
    if (!out.ok) {
      if (out.dest) skillsCache = null;
      const error = out.dest ? `${out.error}\u3002\u6062\u590D\u526F\u672C\uFF1A${out.dest}` : out.error;
      emit({ kind: "skill-remove", id, ok: false, error });
      return { ok: false, status: out.status ?? 500, error, ...out.dest ? { trashedTo: out.dest } : {} };
    }
    skillsCache = null;
    skillsCacheAt = 0;
    if (out.warning) emit({ kind: "skill-remove", id, ok: true, warning: out.warning });
    return { ok: true, dir: skill.dir, trashedTo: out.dest, name: skill.name, warning: out.warning };
  }
  const MARKET_ITEM_TTL_MS = 30 * 6e4;
  let marketInstance = null;
  let marketIndexAt = 0;
  const marketIndex = /* @__PURE__ */ new Map();
  const skillInstallQueues = /* @__PURE__ */ new Map();
  const skillInstallIds = /* @__PURE__ */ new Set();
  function marketFor() {
    if (marketInstance) return marketInstance;
    const fetchImpl = (url, init) => fetch(url, { ...init, headers: withGithubAuth(url, init?.headers ?? {}) });
    marketInstance = createSkillMarket({ fetchImpl, metricsAuthKey: () => withGithubAuth("https://api.github.com").authorization ?? "", isGithubAuthenticated: () => githubAuthStatus().inUse === true });
    return marketInstance;
  }
  const skillIndexFile = path7.join(dir, SKILL_INDEX_FILE);
  let skillIndexDoc = null;
  let skillIndexLoaded = false;
  let skillIndexKnownStamp = null;
  let skillIndexDamaged = null;
  let skillWalk = null;
  let skillWalkProgress = null;
  let skillWalkStop = null;
  let skillWalkEnded = null;
  let skillWalkWriteError = null;
  async function readSkillIndex({ force = false } = {}) {
    if (!force && skillWalk && skillIndexLoaded) return skillIndexDoc;
    const stamp = await skillIndexFileStamp();
    if (!force && skillIndexLoaded && stamp === skillIndexKnownStamp) return skillIndexDoc;
    const { doc, damaged } = await readSkillIndexDocument(skillIndexFile, (file, enc) => fs5.readFile(file, enc));
    skillIndexDoc = doc;
    skillIndexDamaged = damaged;
    skillIndexLoaded = true;
    skillIndexKnownStamp = stamp;
    if (damaged) log?.warn?.(`overall-mcp: skill index damaged: ${damaged}`);
    return skillIndexDoc;
  }
  async function skillIndexFileStamp() {
    try {
      const info = await fs5.stat(skillIndexFile);
      return `${info.mtimeMs}:${info.size}`;
    } catch {
      return "missing";
    }
  }
  async function writeSkillIndex(doc) {
    await writeJson(skillIndexFile, doc);
    skillIndexKnownStamp = await skillIndexFileStamp();
    skillIndexDoc = doc;
    skillIndexLoaded = true;
  }
  async function skillIndexPayload({ refresh = false } = {}) {
    const doc = await readSkillIndex({ force: refresh });
    return doc?.rows?.length ? doc : null;
  }
  function stopSkillWalk(reason = "user") {
    const stop = skillWalkStop;
    if (!stop) return false;
    if (!stop.reason) stop.reason = reason;
    emit({ kind: "skill-index", action: "stopping", reason: stop.reason, ...skillWalkProgress ?? {} });
    stop.controller.abort();
    return true;
  }
  async function skillIndexState() {
    const doc = await skillIndexPayload();
    return {
      ...skillIndexSummary(doc ?? {}),
      walking: skillWalk !== null,
      progress: skillWalkProgress,
      ended: skillWalkEnded,
      writeError: skillWalkWriteError,
      loaded: skillIndexLoaded,
      damaged: skillIndexDamaged ?? null
    };
  }
  function startSkillWalk({ force = true, full = [] } = {}) {
    if (skillWalk) return skillWalk;
    if (!needsSkillWalk(skillIndexDoc, { force })) return null;
    const modes = normalizeModes(Object.fromEntries(
      (Array.isArray(full) ? full : []).filter((id) => WALK_SOURCES.includes(id)).map((id) => [id, "full"])
    ));
    const cursors = cursorsForWalk(skillIndexDoc?.cursors, skillIndexDoc?.modes, modes, { restartCompleted: force });
    const slices = resolveSlices(Object.keys(modes).filter((id) => modes[id] === "full"));
    const limits = limitsForModes(modes);
    const stop = { controller: new AbortController(), reason: null };
    skillWalkStop = stop;
    skillWalkEnded = null;
    skillWalkWriteError = null;
    skillWalk = (async () => {
      log?.info?.(`overall-mcp: walking the skill index (${Object.entries(modes).filter(([, mode]) => mode === "full").map(([id]) => id).join(",") || "slices"})`);
      skillWalkProgress = { requests: 0, rows: 0, source: null, modes };
      emit({ kind: "skill-index", action: "start", force: force === true, modes });
      let lastWrite = 0;
      let checkpoint = null;
      const reportWriteFailure = (phase, error) => {
        skillWalkWriteError = `Skill \u7D22\u5F15${phase}\u4FDD\u5B58\u5931\u8D25\uFF1A${redactSecrets(error?.message ?? error)}`;
        log?.warn?.(skillWalkWriteError);
        emit({ kind: "skill-index", action: "write-failed", phase, error: skillWalkWriteError });
      };
      const walk = await walkSkillIndex({
        fetch: (url, init) => fetch(url, { ...init, headers: withGithubAuth(url, init?.headers ?? {}) }),
        cursors,
        // A resumed walk re-reads rows it already has; without them the held
        // count double-counts every repeat and the safety cap fires early.
        previous: skillIndexDoc?.rows ?? [],
        slices,
        maxRequests: limits.maxRequests,
        signal: stop.controller.signal,
        // A 6.5s GitHub gap must not outlive 停止, and a pacing timer must never
        // be the thing keeping `node --test` alive.
        sleep: (ms) => new Promise((resolve) => {
          const done = () => {
            stop.controller.signal.removeEventListener("abort", done);
            clearTimeout(timer);
            resolve();
          };
          const timer = setTimeout(done, ms);
          timer.unref?.();
          stop.controller.signal.addEventListener("abort", done, { once: true });
        }),
        onProgress: ({ requests, rows: rows2, source, cursors: cursors2, items }) => {
          skillWalkProgress = { requests, rows: rows2, source };
          const stamp = Date.now();
          if (rows2 === 0 || checkpoint || stamp - lastWrite < 5e3) return;
          lastWrite = stamp;
          const at = new Date(stamp).toISOString();
          const merged = mergeSkillRows(skillIndexDoc?.rows ?? [], [...items.values()], {
            at,
            maxRows: limits.maxRows
          });
          checkpoint = writeSkillIndex(skillIndexDocumentOf({
            at,
            rows: merged,
            cursors: cursors2,
            requests,
            complete: false,
            partial: `\u6B63\u5728\u6536\u5F55\uFF08\u5DF2\u6536 ${merged.length} \u884C\uFF09`,
            modes,
            minStars: minStarsForWalk({ previous: skillIndexDoc, modes, slices })
          })).then(() => {
            skillWalkWriteError = null;
          }).catch((error) => reportWriteFailure("\u8FDB\u5EA6", error)).finally(() => {
            checkpoint = null;
          });
        }
      });
      const rows = mergeSkillRows(skillIndexDoc?.rows ?? [], walk.rows, {
        at: walk.at,
        maxRows: limits.maxRows
      });
      const held = `\u5DF2\u6536 ${rows.length} \u884C\uFF0C\u4E0B\u6B21\u63A5\u7740\u8D70`;
      const partial = stop.reason === "user" ? `\u5DF2\u624B\u52A8\u505C\u6B62\uFF08${held}\uFF09` : stop.reason === "dispose" ? `\u63D2\u4EF6\u5378\u8F7D\u65F6\u505C\u6B62\uFF08${held}\uFF09` : walk.partial;
      const doc = skillIndexDocumentOf({
        at: walk.rows.length ? walk.at : skillIndexDoc?.at ?? walk.at,
        rows,
        cursors: walk.cursors,
        requests: walk.requests,
        complete: walk.complete && !partial,
        partial: partial ?? null,
        // This run's admissions plus the ones still true from before: a run where
        // every cursor was already `done` walks nothing, and writing `[]` here
        // would erase "ClawHub stopped at the page ceiling" while claiming the
        // file is complete.
        truncations: mergeTruncations(skillIndexDoc?.truncations, walk.truncations, walk.cursors, walk.walked),
        // Which sources this walk was asked to take to the end. Without it a
        // later reader cannot tell "all of SkillHub" from "the top 10,000".
        modes,
        minStars: minStarsForWalk({ previous: skillIndexDoc, modes, slices })
      });
      await checkpoint;
      try {
        await writeSkillIndex(doc);
        skillWalkWriteError = null;
      } catch (error) {
        reportWriteFailure("\u6700\u7EC8\u7ED3\u679C", error);
        throw error;
      }
      emit({ kind: "skill-index", action: "finish", rows: rows.length, requests: walk.requests, partial: doc.partial });
      return doc;
    })().catch((err) => {
      log?.warn?.(`overall-mcp: skill index walk failed: ${String(err?.message ?? err)}`);
      emit({ kind: "skill-index", action: "failed", error: String(err?.message ?? err) });
      return null;
    }).finally(() => {
      skillWalkEnded = stop.reason ? { reason: stop.reason, at: (/* @__PURE__ */ new Date()).toISOString() } : null;
      skillWalk = null;
      skillWalkProgress = null;
      if (skillWalkStop === stop) skillWalkStop = null;
    });
    return skillWalk;
  }
  async function skillMarketPayload({ source = "all", query = "", category = "all", sort = "default", limit = 20, offset = 0, refresh = false } = {}) {
    const auth = await refreshGithubAuth();
    const index = await skillIndexPayload({ refresh });
    const options = { source, query, category, sort, limit, offset };
    let out;
    if (index) {
      out = await indexedSkillMarket(index, { ...options, refresh });
    } else {
      const listing = await marketFor().list({ source, query, limit: 60, refresh });
      const { items: items2, ...page } = querySkillRows(marketFor().applyMetrics(listing.items), options);
      out = { sources: listing.sources, items: items2, paging: { mode: "live", ...page, rows: listing.items.length } };
    }
    const now = Date.now();
    if (now - marketIndexAt > MARKET_ITEM_TTL_MS) marketIndex.clear();
    marketIndexAt = now;
    const items = out.items.map((item) => ({
      ...item,
      pageUrl: skillSourcePage({ ...item, marketId: item.id }),
      iconCandidates: publisherIcons(item.homepage, item.pageUrl, item.repository)
    }));
    for (const item of items) marketIndex.set(item.id, item);
    const summary = index ? skillIndexSummary(index) : null;
    return {
      ...out,
      items,
      github: { source: auth?.source ?? null, active: auth?.inUse === true },
      index: summary ? {
        rows: summary.rows,
        at: summary.at,
        ageMs: summary.ageMs,
        stale: summary.stale,
        // True when a fresh walk would add something (empty, unfinished, or
        // older than the TTL). The panel uses it for a hint only: 收录 stays an
        // explicit verb, so a stale file never starts a walk behind the user's
        // back — that decision belongs to the click, not to opening the page.
        needsWalk: needsSkillWalk(index),
        complete: summary.complete,
        partial: summary.partial,
        counts: summary.counts,
        minStars: summary.minStars,
        // Per-source slice vs full, so the chips can say which sources are
        // complete and which are still the top of a listing.
        modes: summary.modes
      } : null,
      walk: skillWalkProgress ? { ...skillWalkProgress } : null,
      walkWriteError: skillWalkWriteError
    };
  }
  async function indexedSkillMarket(index, options) {
    const { source, refresh } = options;
    const summary = skillIndexSummary(index);
    const wanted = source && source !== "all" ? [source] : [...SKILL_MARKET_SOURCES];
    const live = await Promise.all(SKILL_LIVE_REPO_SOURCES.filter((id) => wanted.includes(id)).map((id) => marketFor().list({ source: id, limit: 60, refresh })));
    const liveSources = new Map(live.flatMap((result) => result.sources.map((row) => [row.id, row])));
    const heldRows = index.rows.concat(live.flatMap((result) => result.items));
    const rows = wanted.includes("github") ? withFeaturedGithubSkills(heldRows) : heldRows;
    const { items, ...page } = querySkillRows(marketFor().applyMetrics(rows), options);
    const sources = SKILL_MARKET_SOURCES.filter((id) => wanted.includes(id)).map((id) => {
      const label = SKILL_MARKET_LABELS[id];
      if (liveSources.has(id)) {
        return { ...liveSources.get(id), count: items.filter((item) => item.source === id).length };
      }
      const held = summary.sources.find((row) => row.id === id) ?? { rows: 0, done: false };
      return {
        id,
        label,
        count: items.filter((item) => item.source === id).length,
        // The upstream's own number, when it publishes one. ClawHub does not,
        // and this must stay undefined rather than quietly become our count.
        total: held.total,
        // What we hold — a different fact, which is why it has its own field
        // instead of overwriting `total`.
        indexed: held.rows,
        done: held.done === true,
        // The GitHub population is "repositories at or above this star floor",
        // so the chip can say what the total counts instead of implying all.
        ...id === "github" ? { minStars: summary.minStars, featured: FEATURED_GITHUB_SKILL_COUNT } : {},
        error: null
      };
    });
    return {
      sources,
      items,
      paging: { mode: "index", ...page, rows: index.rows.length }
    };
  }
  async function installMarketSkill(id, { root = "plugin" } = {}) {
    let item = featuredGithubSkill(id) ?? marketIndex.get(id);
    if (!item) {
      const index = await skillIndexPayload();
      item = index?.rows?.find((row) => row.id === id);
      if (item) marketIndex.set(id, item);
    }
    if (!item) return { ok: false, status: 404, error: "unknown skill id, list the market first" };
    if (!item.installable) {
      return { ok: false, status: 400, error: item.installNote || "this source only publishes an index" };
    }
    await refreshGithubAuth();
    const roots = skillRoots({ dshHome: path7.dirname(dataDir()) });
    const bucket = roots.find((entry) => entry.id === root);
    if (!bucket) return { ok: false, status: 400, error: `unknown root: ${root}` };
    const folder = String(item.name || "").replace(/[^\w.@-]+/g, "-").replace(/^[-.]+/, "");
    if (!folder) return { ok: false, status: 400, error: "this item has no usable name" };
    const targetKey = path7.resolve(bucket.dir, folder);
    const key = process.platform === "win32" ? targetKey.toLowerCase() : targetKey;
    const identity = JSON.stringify([bucket.id, id]);
    if (skillInstallIds.has(identity)) return { ok: false, status: 409, error: "\u8FD9\u4E2A Skill \u6B63\u5728\u5B89\u88C5" };
    skillInstallIds.add(identity);
    const install = (skillInstallQueues.get(key) ?? Promise.resolve()).then(async () => {
      const { installedMarketIds } = await readSkills({ roots: [bucket] });
      if (installedMarketIds.includes(id)) {
        throw Object.assign(new Error("\u8FD9\u4E2A Skill \u5DF2\u5B89\u88C5\u5230\u6240\u9009\u76EE\u5F55"), { status: 409 });
      }
      const targetDir = await marketSkillTarget(bucket.dir, folder, id, fs5);
      return marketFor().install({ item, targetDir });
    });
    const pending = install.then(() => {
    }, () => {
    });
    skillInstallQueues.set(key, pending);
    let out;
    try {
      out = await install;
    } catch (err) {
      const error = redactSecrets(err?.message ?? err);
      emit({ kind: "skill-install", itemId: id, source: item.source, ok: false, error });
      return { ok: false, status: err?.status ?? 502, error };
    } finally {
      skillInstallIds.delete(identity);
      if (skillInstallQueues.get(key) === pending) skillInstallQueues.delete(key);
    }
    skillsCache = null;
    skillsCacheAt = 0;
    emit({ kind: "skill-install", itemId: id, source: item.source, ok: true, files: out.files?.length ?? 0 });
    return { ok: true, dir: out.dir, name: item.name, source: item.source, files: out.files?.length ?? 0 };
  }
  if (firstRun) {
    try {
      const { found, report } = await scanHost({});
      const merged = mergeIntoRegistry(registry, found);
      registry = merged.registry;
      recordScan(report);
      await save();
      await writeJson(reportFile, { scannedAt: (/* @__PURE__ */ new Date()).toISOString(), report });
      log?.info?.(`first-run scan imported ${merged.added.length} servers (skipped ${merged.skipped.length})`);
    } catch (err) {
      log?.warn?.(`overall-mcp: first-run scan failed: ${String(err?.message ?? err)}`);
    }
  }
  function recordScan(report) {
    const { sources, unreadable } = scannedSources(report);
    registry.scanned = { at: (/* @__PURE__ */ new Date()).toISOString(), sources, unreadable };
  }
  function orphanEntries() {
    return findOrphans(registry, registry.scanned);
  }
  async function doScanImpl() {
    const { found, report } = await scanHost({});
    const merged = mergeIntoRegistry(registry, found);
    registry = merged.registry;
    recordScan(report);
    await save();
    await writeJson(reportFile, { scannedAt: (/* @__PURE__ */ new Date()).toISOString(), report });
    const changed = new Set(merged.updated);
    const wanted = [.../* @__PURE__ */ new Set([...merged.added, ...merged.updated])];
    const connected = await mapLimited(wanted, CONNECT_CONCURRENCY, async (name2) => {
      const entry = registry.servers.find((row) => row.name === name2 && row.enabled !== false && row.serverName) ?? registry.servers.find((row) => row.name === name2 && row.enabled !== false);
      if (changed.has(name2)) await disconnect(name2);
      return { name: name2, ...entry ? await connect(entry) : { ok: true, deferred: true } };
    });
    emit({
      kind: "scan",
      files: report.length,
      added: merged.added.length,
      updated: merged.updated.length,
      skipped: merged.skipped.length,
      collapsed: merged.collapsed?.length ?? 0,
      connected: connected.length,
      orphans: orphanEntries().length
    });
    return {
      added: merged.added,
      skipped: merged.skipped,
      collapsed: merged.collapsed ?? [],
      connected,
      scannedFiles: report.length,
      orphans: orphanEntries().map((s) => s.name)
    };
  }
  let llmService = null;
  ctx.inject(["llm"], (llmCtx) => {
    llmService = llmCtx?.llm ?? null;
    return () => {
      llmService = null;
    };
  });
  const diagnosisCache = /* @__PURE__ */ new Map();
  function diagnosisRoute() {
    const selection = typeof ctx.get === "function" ? ctx.get("agentDefaultModel")?.currentSelection?.() : null;
    const provider = selection?.provider;
    const model = selection?.model;
    if (typeof provider !== "string" || typeof model !== "string" || provider === "" || model === "") return null;
    return { provider, model };
  }
  async function diagnoseFailure(entry, item, errorText) {
    if (!llmService) return { ok: false, reason: "no-llm" };
    const route = diagnosisRoute();
    if (!route) return { ok: false, reason: "no-route" };
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
      messages: [{ role: "user", content: [{ type: "text", text: buildDiagnosisPrompt(facts) }] }],
      temperature: 0,
      signal: AbortSignal.timeout(DIAGNOSIS_TIMEOUT_MS)
    };
    for await (const chunk of llmService.stream(options)) {
      assembler.push(chunk);
      if (chunk?.type === "finish" && (chunk.reason?.kind === "error" || chunk.reason?.kind === "aborted")) {
        const failure = chunk.reason.failure ?? {};
        throw new Error(`\u8BCA\u65AD\u6A21\u578B\u4EE5 ${chunk.reason.kind} \u7ED3\u675F\uFF1A${failure.message ?? failure.code ?? "\u672A\u77E5\u539F\u56E0"}`);
      }
    }
    const text = diagnosisTextOf(assembler.blocks());
    if (text === "") throw new Error("\u8BCA\u65AD\u6A21\u578B\u6CA1\u6709\u8F93\u51FA\u6587\u672C");
    const value = { text, route: `${route.provider}/${route.model}` };
    diagnosisCache.set(key, { at: now, value });
    evictOldest(diagnosisCache, DIAGNOSIS_CACHE_MAX);
    return { ok: true, ...value };
  }
  async function translateAboutLines({ lang, route, texts }) {
    const assembler = new BlockAssembler();
    const options = {
      provider: route.provider,
      model: route.model,
      system: I18N_SYSTEM,
      messages: [{ role: "user", content: [{ type: "text", text: buildTranslationPrompt({ lang, texts }) }] }],
      temperature: 0,
      signal: AbortSignal.timeout(ABOUT_I18N_TIMEOUT_MS)
    };
    for await (const chunk of llmService.stream(options)) {
      assembler.push(chunk);
      if (chunk?.type === "finish" && (chunk.reason?.kind === "error" || chunk.reason?.kind === "aborted")) {
        const failure = chunk.reason.failure ?? {};
        throw new Error(`\u7FFB\u8BD1\u6A21\u578B\u4EE5 ${chunk.reason.kind} \u7ED3\u675F\uFF1A${failure.message ?? failure.code ?? "\u672A\u77E5\u539F\u56E0"}`);
      }
    }
    const lines = parseTranslations(diagnosisTextOf(assembler.blocks()), texts.length);
    if (!lines) throw new Error("\u7FFB\u8BD1\u6A21\u578B\u6CA1\u6709\u7ED9\u51FA\u7B49\u957F\u7684 JSON \u6570\u7EC4");
    return lines;
  }
  function qualifiedNameOf(item) {
    const raw = item?.raw ?? {};
    const candidates = [raw.qualifiedName, item?.qualifiedName, raw.name];
    for (const candidate of candidates) {
      if (typeof candidate === "string" && candidate.trim() !== "") return candidate.trim();
    }
    return "";
  }
  async function attachSmitherySchema(item, entry) {
    if (item?.source !== "smithery" || !entry) return;
    if (entry.transport !== "stdio") return;
    if (entry.config?.schema) return;
    const qualified = qualifiedNameOf(item);
    if (qualified === "") return;
    const found = await fetchSmitheryConfig(qualified);
    if (!found?.schema) return;
    const schema = found.schema;
    const next = { ...entry.config ?? {}, origin: "smithery", via: "cli-json", flag: "--config", schema };
    if (!Array.isArray(next.fields) || next.fields.length === 0) {
      next.fields = smitheryFieldsOf({ ...entry, config: next });
    }
    entry.config = next;
  }
  async function healSmitheryRow(row) {
    if (!row || !isSmitheryCli(row) || row?.config?.schema) return false;
    const at = Array.isArray(row.args) ? row.args.findIndex((arg) => String(arg) === "run") : -1;
    const qualified = at >= 0 && typeof row.args[at + 1] === "string" ? row.args[at + 1].trim() : "";
    if (qualified === "") return false;
    const found = await fetchSmitheryConfig(qualified);
    if (!found?.schema) return false;
    const next = { ...row.config ?? {}, origin: "smithery", via: "cli-json", flag: "--config", schema: found.schema };
    if (!Array.isArray(next.fields) || next.fields.length === 0) {
      next.fields = smitheryFieldsOf({ ...row, config: next });
    }
    row.config = next;
    return true;
  }
  async function backfillSmitheryConfigs(limit = 8) {
    const rows = (registry.servers ?? []).filter((row) => isSmitheryCli(row) && !row?.config?.schema).slice(0, limit);
    if (rows.length === 0) return 0;
    let healed = 0;
    await Promise.all(rows.map(async (row) => {
      if (await healSmitheryRow(row)) healed += 1;
    }));
    if (healed > 0) log?.info?.(`overall-mcp: filled in the configuration schema for ${healed} Smithery row(s)`);
    return healed;
  }
  function hostOfUrl(url) {
    try {
      return new URL(url).host;
    } catch {
      return "";
    }
  }
  function humanPageFor(entry) {
    const homepage = typeof entry?.homepage === "string" ? entry.homepage : "";
    if (/^https?:\/\//i.test(homepage)) return homepage;
    const host = hostOfUrl(entry?.url);
    const hosted = /^([a-z0-9][a-z0-9-]*)--([a-z0-9][a-z0-9-]*)\.run\.tools$/i.exec(host);
    if (hosted) return `https://smithery.ai/servers/@${hosted[2]}/${hosted[1]}`;
    return "";
  }
  async function attachObservedAuth(entry) {
    if (!entry || entry.transport !== "streamable-http" || typeof entry.url !== "string") return;
    const demand = await probeRemoteAuth(entry.url, { timeoutMs: 5e3 });
    if (demand) entry.authDemand = demand;
    if (demand?.required !== true) return;
    const spec = configSpecFor(null, entry);
    const help = demand.oauth === true ? [
      "\u7AEF\u70B9\u56DE\u4E86 401\uFF0C\u8981\u7684\u662F OAuth \u767B\u5F55\u3002",
      "\u6D4F\u89C8\u5668\u6388\u6743\u8FD9\u4E00\u6B65\u63D2\u4EF6\u8D70\u4E0D\u5B8C\uFF0C\u88C5\u4E0A\u4E5F\u8C03\u4E0D\u901A\uFF1B\u9664\u975E\u670D\u52A1\u5546\u53E6\u5916\u53D1\u4E86 API key \u2014\u2014 \u90A3\u79CD\u60C5\u51B5\u628A\u4EE4\u724C\u6309 `Bearer <\u4EE4\u724C>` \u586B\u5728\u8FD9\u91CC\u5C31\u80FD\u7528\u3002"
    ].join(" ") : [
      demand.description ? `\u7AEF\u70B9\u56DE\u4E86 401\uFF1A${demand.description}` : "\u7AEF\u70B9\u56DE\u4E86 401\uFF0C\u8981\u6C42\u8BC1\u660E\u8EAB\u4EFD\u3002",
      "\u6309\u670D\u52A1\u5546\u7684\u6587\u6863\u586B\uFF0C\u591A\u6570\u662F `Bearer <\u4EE4\u724C>`\u3002"
    ].join(" ");
    const page = humanPageFor(entry);
    const field = normalizeField(
      {
        key: "Authorization",
        kind: "header",
        label: "Authorization",
        help,
        required: true,
        secret: true,
        origin: "observed",
        ...demand.oauth === true ? { oauth: true } : {},
        // A page a person can open — never the machine-readable metadata
        // document: a link labelled 「去获取」 that lands on JSON is not a way to
        // get anything.
        ...page ? { helpUrl: page } : {}
      },
      { kind: "header", origin: "observed" }
    );
    if (!field) return;
    const rest = (spec?.fields ?? []).filter((existing) => existing.key !== "Authorization");
    entry.config = { ...entry.config ?? {}, origin: "observed", via: "header", fields: [field, ...rest] };
  }
  async function healObservedAuths() {
    const rows = (registry.servers ?? []).filter((row) => row?.transport === "streamable-http" && Array.isArray(row.config?.fields) && row.config.fields.some((field) => typeof field.resourceUrl === "string"));
    if (rows.length === 0) return 0;
    let healed = 0;
    await Promise.all(rows.map(async (row) => {
      try {
        await attachObservedAuth(row);
        if (!row.config?.fields?.some((field) => field.resourceUrl)) healed += 1;
      } catch {
      }
    }));
    return healed;
  }
  async function doInstallImpl(item, { overwrite = false } = {}) {
    let resolved = item;
    if (item?.install?.deferred === true) {
      const qualified = qualifiedNameOf(item);
      const found = qualified === "" ? null : await fetchSmitheryConfig(qualified);
      if (!found?.httpUrl) {
        if (found?.error) {
          throw new Error(`${item?.name ?? "this server"}: \u8BE6\u60C5\u7AEF\u70B9\u8FD9\u6B21\u6CA1\u7B54\u4E0A\u6765\uFF08${found.error}\uFF09\u2014\u2014 \u4E0D\u662F\u5B83\u6CA1\u7ED9\u7AEF\u70B9\uFF1B\u7B49\u51E0\u79D2\u518D\u70B9\u4E00\u6B21\u5B89\u88C5\u3002`);
        }
        throw new Error(`${item?.name ?? "this server"}: Smithery \u8BF4\u5B83\u7531\u5B98\u65B9\u6258\u7BA1\uFF0C\u4F46\u8BE6\u60C5\u7AEF\u70B9\u6CA1\u6709\u7ED9\u51FA deploymentUrl \u2014\u2014 \u88C5\u4E0D\u4E86\uFF08\u539F\u6765\u7684 \`npx @smithery/cli run\` \u53EA\u4F1A\u62C9\u8D77\u4EA4\u4E92\u5F0F\u767B\u5F55\uFF0C\u4E0D\u4F1A\u6210\u4E3A\u4E00\u53F0\u672C\u5730\u670D\u52A1\u5668\uFF09`);
      }
      resolved = { ...item, install: { ...item.install, url: found.httpUrl, deferred: false, resolvedAt: (/* @__PURE__ */ new Date()).toISOString() } };
    }
    const entry = catalogItemToEntry(resolved);
    if (!entry) throw new Error("item has no installable transport (stdio command or http url)");
    await attachSmitherySchema(resolved, entry);
    await attachObservedAuth(entry);
    const i = registry.servers.findIndex((s) => s.name === entry.name);
    if (i >= 0) {
      const existing = registry.servers[i];
      if (!overwrite && (!existing.source || existing.source === "manual")) {
        throw new Error(`manual entry ${entry.name}: \u8FD9\u662F\u624B\u5DE5\u6DFB\u52A0\u7684\u8BB0\u5F55\uFF0C\u5B89\u88C5\u4E0D\u4F1A\u8986\u76D6\u5B83\uFF1B\u8BF7\u5148\u79FB\u9664\u5B83\uFF0C\u6216\u5E26 overwrite=true \u660E\u786E\u66FF\u6362`);
      }
      if (registry.servers.filter((s) => s.name === entry.name).length > 1) {
        throw new Error(`ambiguous server name: ${entry.name}`);
      }
      const sameItem = Boolean(entry.catalogId) && entry.catalogId === existing.catalogId && entry.source === existing.source;
      if (!overwrite && !sameItem) {
        throw Object.assign(new Error(`catalog entry conflict: ${entry.name} already belongs to ${existing.source}; explicit overwrite is required`), { status: 409 });
      }
      if (sameItem && !overwrite) {
        entry.env = { ...existing.env ?? {} };
        if (existing.headers) entry.headers = { ...existing.headers };
        if (existing.configValues) entry.configValues = { ...existing.configValues };
        entry.enabled = existing.enabled;
      }
      await disconnect(entry.name);
      registry.servers[i] = entry;
    } else registry.servers.push(entry);
    const configBefore = configState(specOf(entry), entry);
    await save();
    const conn = entry.enabled !== false ? await connect(entry) : { ok: true, deferred: true };
    let record = null;
    if (conn.ok !== false) {
      const installKey = installKeyOf(item, entry.name);
      record = recordInstallIn(installs, { key: installKey, name: entry.name });
      if (record) await writeInstalls(installsFile, installs);
    } else {
      log?.warn?.(`overall-mcp: ${entry.name} was added to the registry but did not mount, so it is not counted as an install`);
    }
    let diagnosis = null;
    let diagnosisSkipped = null;
    let diagnosisError = null;
    if (conn.ok === false) {
      if (configBefore?.needs === true || looksLikeCredentialFailure(conn.error)) {
        diagnosisSkipped = "needs-config";
      } else {
        try {
          const outcome = await diagnoseFailure(entry, item, String(conn.error ?? "mount failed"));
          if (outcome.ok) diagnosis = { text: outcome.text, route: outcome.route, ...outcome.cached ? { cached: true } : {} };
          else diagnosisSkipped = outcome.reason;
        } catch (err) {
          diagnosisError = capText(String(err?.message ?? err), 200);
          log?.warn?.(`overall-mcp: could not explain the failed install of ${entry.name}: ${diagnosisError}`);
        }
      }
    }
    emit({
      kind: "install",
      server: entry.name,
      source: item?.source ?? null,
      itemId: item?.id ?? null,
      mounted: conn.ok !== false,
      counted: record !== null,
      ...conn.ok === false ? { error: capText(String(conn.error ?? "mount failed"), 200) } : {},
      ...diagnosis ? { diagnosis: true } : {},
      ...diagnosisError ? { diagnosisError } : {}
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
      ...conn.ok === false ? {
        counted: false,
        // A missing required setting is the most likely reason the mount failed,
        // and it is the one the user can act on right here, so it wins the line.
        note: configBefore?.needs === true ? `${entry.name} \u5DF2\u5199\u5165\u6CE8\u518C\u8868\uFF0C\u4F46\u8FD8\u7F3A ${configBefore.missing.join("\u3001")}\uFF0C\u586B\u597D\u4E4B\u524D\u5B83\u7684\u5DE5\u5177\u8C03\u7528\u4E0D\u901A\u3002` : `${entry.name} \u5DF2\u5199\u5165\u6CE8\u518C\u8868\uFF0C\u4F46\u6302\u8F7D\u6CA1\u6709\u6210\u529F\uFF0C\u56E0\u6B64\u6CA1\u6709\u8BA1\u5165\u672C\u5E02\u573A\u5B89\u88C5\u6570\uFF1B\u4FEE\u597D\u540E\u53EF\u7528\u300C\u66F4\u65B0\u300D\u6216\u91CD\u65B0\u542F\u7528\u6765\u91CD\u8BD5\u3002`
      } : {},
      ...diagnosis ? { diagnosis } : {},
      ...diagnosisSkipped ? { diagnosisSkipped } : {},
      ...diagnosisError ? { diagnosisError } : {},
      // What this row still needs, masked (the value never comes back), plus the
      // one-line flag the panel badges. Both are also on the fresh `servers` list
      // just above; repeating them here saves the client a lookup after install.
      config: maskedFields(specOf(entry), entry),
      needConfig: configBefore?.needs === true,
      // Where this row's settings go, so the panel can open the right form even
      // when the schema was never fetched (a Smithery row installed earlier).
      channel: channelOf(entry)
    };
  }
  const externallyProvided = (entry) => entry?.providedExternally === true;
  function resolveEntry(name2, { slot = null, from = null } = {}) {
    const matches = registry.servers.filter((s) => s.name === name2);
    if (matches.length === 0) throw new Error(`unknown server: ${name2}`);
    if (Number.isInteger(slot)) {
      const at = registry.servers[slot];
      if (at && at.name === name2 && (from == null || (parsePackageInvocation(at)?.version ?? null) === from)) return at;
      throw new Error(`stale entry: ${name2}\uFF08\u5217\u8868\u4F4D\u7F6E\u5DF2\u53D8\u5316\uFF0C\u8BF7\u5237\u65B0\u540E\u91CD\u8BD5\uFF09`);
    }
    if (from != null) {
      const byVersion = matches.filter((s) => (parsePackageInvocation(s)?.version ?? null) === from);
      if (byVersion.length === 1) return byVersion[0];
      if (byVersion.length === 0) throw new Error(`stale entry: ${name2}\uFF08\u7248\u672C\u5DF2\u53D8\u5316\uFF0C\u8BF7\u5237\u65B0\u540E\u91CD\u8BD5\uFF09`);
      throw new Error(`ambiguous server name: ${name2}\uFF08\u540C\u7248\u672C\u6709 ${byVersion.length} \u6761\u8BB0\u5F55\uFF09\uFF1B\u8BF7\u5E26\u4E0A slot`);
    }
    if (matches.length === 1) return matches[0];
    throw new Error(`ambiguous server name: ${name2}\uFF08${matches.length} \u6761\u540C\u540D\u8BB0\u5F55\uFF09\uFF1B\u8BF7\u5E26\u4E0A slot`);
  }
  async function syncFiber(name2) {
    const rows = registry.servers.filter((s) => s.name === name2);
    const wanted = rows.find((s) => s.enabled !== false) ?? null;
    if (!wanted) return disconnect(name2);
    if (!fibers.has(name2)) await connect(wanted);
  }
  async function doSetEnabledImpl(name2, enabled, { slot = null, from = null } = {}) {
    const entry = resolveEntry(name2, { slot, from });
    entry.enabled = enabled;
    await save();
    await syncFiber(name2);
    return {
      name: name2,
      enabled,
      connected: fibers.has(name2),
      ...externallyProvided(entry) ? {
        providedExternally: true,
        stillProvided: true,
        note: `${name2} \u7684\u5DE5\u5177\u7531\u53E6\u4E00\u4E2A mcp-client \u6302\u8F7D\u63D0\u4F9B\uFF0C\u672C\u63D2\u4EF6\u4ECE\u672A\u6302\u8F7D\u5B83\uFF1A\u505C\u7528\u53EA\u8BB0\u5F55\u672C\u63D2\u4EF6\u7684\u610F\u56FE\uFF0C\u90A3\u4E9B\u5DE5\u5177\u4E0D\u4F1A\u6D88\u5931\u3002`
      } : {}
    };
  }
  async function doConfigureImpl(name2, values, { slot = null, from = null, actor = "user" } = {}) {
    const entry = resolveEntry(name2, { slot, from });
    const before = configState(specOf(entry), entry);
    const { changed, rejected } = applyValues(entry, values ?? {}, { actor });
    if (changed.length === 0) {
      let note = "\u6CA1\u6709\u9700\u8981\u5199\u5165\u7684\u503C\uFF08\u7A7A\u503C\u7B49\u4E8E\u6E05\u9664\uFF0C\u672A\u586B\u5199\u4EFB\u4F55\u5185\u5BB9\uFF09\u3002";
      if (rejected.length > 0) {
        note = `\u672A\u5199\u5165\u4EFB\u4F55\u914D\u7F6E\uFF1A${rejected.map((r) => `${r.key}\uFF08${r.reason}\uFF09`).join("\uFF1B")}\u3002`;
      }
      return {
        name: name2,
        changed: [],
        rejected,
        saved: false,
        config: maskedFields(specOf(entry), entry),
        needConfig: before?.needs === true,
        note
      };
    }
    await save();
    let mount = null;
    if (entry.enabled !== false && !externallyProvided(entry)) {
      await disconnect(entry.name);
      mount = await connect(entry);
    }
    const after = configState(specOf(entry), entry);
    emit({
      kind: "configure",
      server: entry.name,
      changed: changed.length,
      rejected: rejected.length,
      mounted: mount ? mount.ok !== false : null,
      ...after?.needs ? { stillMissing: after.missing.length } : {}
    });
    const notes = [];
    const truncated = changed.filter((c) => c.action === "truncated");
    if (truncated.length > 0) {
      notes.push(`\u914D\u7F6E\u9879 ${truncated.map((c) => c.key).join("\u3001")} \u8D85\u8FC7 4096 \u5B57\u7B26\uFF0C\u5DF2\u622A\u65AD\u4FDD\u5B58\u3002`);
    }
    if (rejected.length > 0) {
      notes.push(`\u4EE5\u4E0B\u914D\u7F6E\u672A\u5199\u5165\uFF1A${rejected.map((r) => `${r.key}\uFF08${r.reason}\uFF09`).join("\uFF1B")}\u3002`);
    }
    if (externallyProvided(entry)) {
      notes.push(`${name2} \u7684\u5DE5\u5177\u7531\u53E6\u4E00\u4E2A mcp-client \u6302\u8F7D\u63D0\u4F9B\uFF1A\u503C\u5DF2\u5199\u5165\u672C\u63D2\u4EF6\u7684\u6CE8\u518C\u8868\uFF0C\u4F46\u90A3\u4E00\u4EFD\u6302\u8F7D\u8BFB\u7684\u662F\u5B83\u81EA\u5DF1\u7684\u914D\u7F6E\uFF0C\u6539\u52A8\u8981\u7B49\u5B83\u91CD\u65B0\u52A0\u8F7D\u624D\u751F\u6548\u3002`);
    }
    if (after?.needs) notes.push(`\u8FD8\u7F3A ${after.missing.join("\u3001")}\uFF0C\u586B\u597D\u5E76\u91CD\u65B0\u6302\u8F7D\u540E\u5DE5\u5177\u624D\u4F1A\u901A\u3002`);
    return {
      name: name2,
      changed,
      rejected,
      saved: true,
      ...mount ? { connect: mount } : {},
      ...externallyProvided(entry) ? { providedExternally: true } : {},
      config: maskedFields(specOf(entry), entry),
      needConfig: after?.needs === true,
      ...after?.needs ? { missing: after.missing } : {},
      ...notes.length ? { note: notes.join(" ") } : {}
    };
  }
  async function doSetSourceEnabledImpl(source, enabled) {
    const targets = registry.servers.filter((s) => (s.source ?? "manual") === source);
    if (targets.length === 0) throw new Error(`unknown source: ${source}`);
    for (const entry of targets) entry.enabled = enabled;
    await save();
    await mapLimited(
      [...new Set(targets.map((s) => s.name))],
      CONNECT_CONCURRENCY,
      (name2) => syncFiber(name2)
    );
    const external = targets.filter(externallyProvided).length;
    return {
      source,
      enabled,
      changed: targets.length,
      ...external ? {
        externallyProvided: external,
        note: `\u5176\u4E2D ${external} \u53F0\u7531\u53E6\u4E00\u4E2A mcp-client \u6302\u8F7D\u63D0\u4F9B\uFF0C\u672C\u63D2\u4EF6\u7684\u5F00\u5173\u4E0D\u5F71\u54CD\u5B83\u4EEC\u5DF2\u7ECF\u6302\u8F7D\u7684\u5DE5\u5177\u3002`
      } : {},
      ...await serversPayload()
    };
  }
  async function doRemoveImpl(name2, { slot = null, from = null } = {}) {
    const entry = resolveEntry(name2, { slot, from });
    const external = externallyProvided(entry);
    const at = registry.servers.indexOf(entry);
    if (at < 0) throw new Error(`stale entry: ${name2}\uFF08\u6CE8\u518C\u8868\u5DF2\u53D8\u5316\uFF0C\u8BF7\u5237\u65B0\u540E\u91CD\u8BD5\uFF09`);
    registry.servers.splice(at, 1);
    await save();
    await syncFiber(name2);
    return {
      removed: name2,
      ...external ? {
        providedExternally: true,
        stillProvided: true,
        note: `${name2} \u5DF2\u4ECE\u672C\u63D2\u4EF6\u7684\u6CE8\u518C\u8868\u79FB\u9664\uFF1B\u5B83\u7684\u5DE5\u5177\u4ECD\u7531\u53E6\u4E00\u4E2A mcp-client \u6302\u8F7D\u63D0\u4F9B\uFF0C\u4E0D\u4F1A\u6D88\u5931\u3002`
      } : {},
      ...await serversPayload()
    };
  }
  async function doForgetOrphansImpl() {
    const orphans = orphanEntries();
    if (orphans.length === 0) return { removed: [], count: 0, ...await serversPayload() };
    const gone = new Set(orphans);
    const names = [...new Set(orphans.map((s) => s.name))];
    const removed = orphans.map((s) => ({
      name: s.name,
      source: s.source,
      version: parsePackageInvocation(s)?.version ?? null
    }));
    registry.servers = registry.servers.filter((s) => !gone.has(s));
    await save();
    log?.info?.(`overall-mcp: forgot ${removed.length} orphaned ${removed.length === 1 ? "entry" : "entries"} (${names.join(", ")})`);
    emit({ kind: "registry", action: "forget-orphans", count: removed.length, names });
    return { removed, count: removed.length, ...await serversPayload() };
  }
  const selfUpdateCache = {};
  const doCheckSelfUpdate = () => checkSelfUpdate({ moduleUrl: import.meta.url, cache: selfUpdateCache });
  const doSelfUpdate = async () => {
    const result = await updateSelf({ moduleUrl: import.meta.url });
    emit({
      kind: "update",
      target: "dsh-overall-mcp",
      updated: result?.updated === true,
      ...result?.ok === false ? { error: result.reason ?? "failed" } : {},
      ...result?.version ? { from: result.version } : {},
      ...result?.latest ? { to: result.latest } : {}
    });
    return result;
  };
  async function doCheckUpdates() {
    const rows = registry.servers.filter((s) => s.enabled !== false);
    const result = await checkAllUpdates(rows, { concurrency: 4, timeoutMs: 6e3 });
    await backfillSmitheryConfigs();
    let healedAuth = 0;
    try {
      healedAuth = await healObservedAuths();
    } catch (err) {
      log?.warn?.(`overall-mcp: the authorization re-probe failed: ${err?.message ?? err}`);
    }
    if (healedAuth > 0) log?.info?.(`overall-mcp: refreshed the authorization requirement of ${healedAuth} row(s)`);
    return serialized(async () => {
      result.entries.forEach((check, i) => {
        const entry = rows[i];
        if (!entry || !registry.servers.includes(entry)) return;
        entry.updateCheck = check.detectable ? { at: (/* @__PURE__ */ new Date()).toISOString(), current: check.current, latest: check.latest, updateAvailable: check.updateAvailable, error: check.error } : { at: (/* @__PURE__ */ new Date()).toISOString(), detectable: false, reason: check.reason };
      });
      await save();
      return { ...result, ...await serversPayload() };
    })();
  }
  async function doUpdateImpl(name2, { slot = null, from = null } = {}) {
    const entry = resolveEntry(name2, { slot, from });
    if (!Array.isArray(entry.config?.fields) || entry.config.fields.length === 0) {
      const spec = specOf(entry);
      if (spec) entry.config = { ...entry.config ?? {}, ...spec };
    }
    const check = await checkEntryUpdate(entry);
    if (!check.detectable) throw new Error(`${name2} is not launched through a package runner; update it manually`);
    if (check.error) throw new Error(`version lookup failed for ${check.pkg}: ${check.error}`);
    if (!check.updateAvailable) {
      entry.updateCheck = { at: (/* @__PURE__ */ new Date()).toISOString(), current: check.current, latest: check.latest, updateAvailable: false };
      await save();
      return { name: name2, updated: false, package: check.pkg, version: check.latest, reason: check.unpinned ? "unpinned runner always resolves to the newest release" : "already up to date" };
    }
    const previous = check.current;
    entry.args = pinArgs(entry, check.latest);
    entry.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
    entry.updateCheck = { at: (/* @__PURE__ */ new Date()).toISOString(), current: check.latest, latest: check.latest, updateAvailable: false };
    await save();
    const wasConnected = fibers.has(name2);
    if (wasConnected) await disconnect(name2);
    const conn = entry.enabled !== false ? await connect(entry) : { ok: true, deferred: true };
    log?.info?.(`overall-mcp: updated ${name2} from ${previous} to ${check.latest}`);
    return { name: name2, updated: true, package: check.pkg, from: previous, to: check.latest, reconnected: wasConnected, connect: conn };
  }
  const catalogCache = createCatalogCache();
  const CATALOG_QUERY_MAX = 200;
  const githubIndexFile = path7.join(dir, INDEX_FILE);
  let githubIndexDoc = null;
  let githubIndexLoaded = false;
  let githubIndexDamaged = null;
  let githubCrawl = null;
  let githubWalkProgress = null;
  let githubCrawlStop = null;
  let githubCrawlEnded = null;
  async function readGithubIndex() {
    if (!githubIndexLoaded) {
      const { doc, damaged } = await readIndexDocument(githubIndexFile, (file, enc) => fs5.readFile(file, enc));
      githubIndexDoc = doc;
      githubIndexDamaged = damaged;
      githubIndexLoaded = true;
      if (damaged) log?.warn?.(`overall-mcp: github index damaged: ${damaged}`);
    }
    return githubIndexDoc;
  }
  async function githubIndexPayload() {
    const doc = await readGithubIndex();
    if (!doc?.rows?.length) return null;
    return { ...doc, ...indexFreshness(doc, { ttlMs: INDEX_TTL_MS }) };
  }
  function maybeCrawlGithubIndex({ force = false } = {}) {
    if (githubCrawl) return githubCrawl;
    const held = githubIndexDoc;
    if (!needsGithubCrawl(held, { force })) return null;
    const quota = githubSearchQuota();
    if (quota.waitMs > 0) {
      log?.warn?.(`overall-mcp: GitHub search budget is empty for another ${Math.ceil(quota.waitMs / 1e3)}s; not walking`);
      emit({ kind: "census", action: "skipped", waitMs: quota.waitMs });
      return null;
    }
    const stop = { controller: new AbortController(), reason: null };
    githubCrawlStop = stop;
    githubCrawlEnded = null;
    githubCrawl = (async () => {
      log?.info?.("overall-mcp: walking the GitHub index");
      githubWalkProgress = { requests: 0, rows: 0 };
      emit({ kind: "census", action: "start", force: force === true });
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
            stop.controller.signal.removeEventListener("abort", done);
            clearTimeout(timer);
            resolve();
          };
          const timer = setTimeout(done, ms);
          timer.unref?.();
          stop.controller.signal.addEventListener("abort", done, { once: true });
        }),
        onProgress: ({ requests, rows: rows2, items }) => {
          githubWalkProgress = { requests, rows: rows2 };
          const stamp = Date.now();
          if (rows2 === 0 || stamp - lastWrite < 5e3) return;
          lastWrite = stamp;
          const at = new Date(stamp).toISOString();
          const merged = mergeIndexRows(held?.rows ?? [], [...items.values()], { at });
          void writeJson(githubIndexFile, indexDocumentOf({
            at,
            rows: merged,
            queries: [...BASE_QUERIES],
            requests,
            complete: false,
            partial: `\u6B63\u5728\u6293\u53D6\uFF08\u5DF2\u6536 ${rows2} \u884C\uFF09`
          })).catch(() => {
          });
        }
      });
      const rows = mergeIndexRows(held?.rows ?? [], walk.rows, { at: walk.at });
      const partial = stop.reason === "user" ? `\u5DF2\u624B\u52A8\u505C\u6B62\uFF08\u5DF2\u6536 ${rows.length} \u884C\uFF0C\u4E0B\u6B21\u63A5\u7740\u8D70\uFF09` : stop.reason === "dispose" ? `\u63D2\u4EF6\u88AB\u5378\u8F7D\uFF0C\u5DF2\u505C\u6B62\uFF08\u5DF2\u6536 ${rows.length} \u884C\uFF09` : walk.partial || (walk.truncations.length ? walk.truncations.map((t) => t.reason).join("\uFF1B") : null);
      const doc = indexDocumentOf({
        at: walk.at,
        rows,
        queries: [...BASE_QUERIES],
        requests: walk.requests,
        complete: walk.complete,
        partial
      });
      await writeJson(githubIndexFile, doc);
      githubIndexDoc = doc;
      githubIndexLoaded = true;
      githubIndexDamaged = null;
      log?.info?.(`overall-mcp: github index ${doc.rows.length} rows in ${walk.requests} requests (complete=${walk.complete})`);
      emit({
        kind: "census",
        action: stop.reason ? "stopped" : "stop",
        ...stop.reason ? { reason: stop.reason } : {},
        requests: walk.requests,
        rows: doc.rows.length,
        complete: walk.complete === true,
        ...doc.partial ? { partial: doc.partial } : {}
      });
      if (!stop.reason) maybeCrawlInstallEvidence({ force });
      return doc;
    })().catch((err) => {
      log?.warn?.(`overall-mcp: github index walk failed: ${String(err?.message ?? err)}`);
      emit({ kind: "census", action: "failed", error: String(err?.message ?? err) });
      return null;
    }).finally(() => {
      githubCrawlEnded = stop.reason ? { reason: stop.reason, at: (/* @__PURE__ */ new Date()).toISOString() } : null;
      githubCrawl = null;
      githubWalkProgress = null;
      if (githubCrawlStop === stop) githubCrawlStop = null;
    });
    return githubCrawl;
  }
  function stopCensus(reason = "user") {
    const stop = githubCrawlStop;
    if (!stop) return false;
    if (!stop.reason) stop.reason = reason;
    emit({ kind: "census", action: "stopping", reason: stop.reason, ...githubWalkProgress ?? {} });
    stop.controller.abort();
    return true;
  }
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
      damaged: githubIndexDamaged ?? null
    };
  }
  async function doCensus({ action = null } = {}) {
    await readGithubIndex();
    if (action === "stop") {
      const stopping = stopCensus("user");
      const state = await censusState();
      return { ...state, stopping };
    }
    if (action === "start") {
      const before = githubCrawl;
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
        ...walk === null && !before && quota.waitMs > 0 ? { skipped: "quota", waitMs: quota.waitMs } : {}
      };
    }
    return censusState();
  }
  const evidenceFile = path7.join(dir, EVIDENCE_FILE);
  let evidenceDoc = null;
  let evidenceLoaded = false;
  let evidenceDamaged = null;
  let evidenceCrawl = null;
  let evidenceStop = null;
  let evidenceEnded = null;
  let evidenceProgress = null;
  let evidenceLast = null;
  async function readEvidence() {
    if (!evidenceLoaded) {
      const { doc, damaged } = await readEvidenceDocument(evidenceFile, (file, enc) => fs5.readFile(file, enc));
      evidenceDoc = doc;
      evidenceDamaged = damaged;
      evidenceLoaded = true;
      if (damaged) log?.warn?.(`overall-mcp: ${damaged}`);
    }
    return evidenceDoc;
  }
  async function evidenceById() {
    const doc = await readEvidence();
    return new Map((doc?.rows ?? []).map((row) => [row.id, row]));
  }
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
      damaged: evidenceDamaged ?? null
    };
  }
  const EVIDENCE_MAX_BYTES = 512 * 1024;
  async function readRepoFile(url, { signal } = {}) {
    let res;
    try {
      res = await fetch(url, { headers: withGithubAuth(url, { "user-agent": USER_AGENT2, accept: "text/plain" }), signal });
    } catch (err) {
      if (signal?.aborted || err?.name === "AbortError") {
        const stopped = new Error("the walk was stopped");
        stopped.code = "aborted";
        throw stopped;
      }
      const failure = new Error(String(err?.message ?? err));
      failure.code = "network";
      throw failure;
    }
    if (res.status === 404 || res.status === 410) return null;
    if (res.status === 401) {
      await deactivateGithubAuth("GitHub \u62D2\u7EDD\u4E86\u8FD9\u4E2A token\uFF08HTTP 401\uFF09\uFF0C\u5DF2\u6539\u7528\u533F\u540D\u8BBF\u95EE", { dir });
      const err = new Error("HTTP 401");
      err.code = "refused";
      throw err;
    }
    if (res.status === 403 || res.status === 429) {
      const err = new Error(`HTTP ${res.status}`);
      err.code = "refused";
      throw err;
    }
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status}`);
      err.code = res.status >= 500 ? "upstream" : "http";
      throw err;
    }
    const text = await res.text();
    return text.length > EVIDENCE_MAX_BYTES ? null : text;
  }
  async function packageExists({ registry: registry2, name: name2, signal }) {
    const url = registry2 === "npm" ? `https://registry.npmjs.org/${encodeURIComponent(name2)}` : `https://pypi.org/pypi/${encodeURIComponent(name2)}/json`;
    const send = async (method) => {
      try {
        return await fetch(url, { method, headers: { "user-agent": USER_AGENT2, accept: "application/json" }, signal });
      } catch (err) {
        if (signal?.aborted || err?.name === "AbortError") {
          const stopped = new Error("the walk was stopped");
          stopped.code = "aborted";
          throw stopped;
        }
        const failure = new Error(String(err?.message ?? err));
        failure.code = "network";
        throw failure;
      }
    };
    const res = await send("HEAD");
    if (res.status === 403 || res.status === 429) {
      const err = new Error(`HTTP ${res.status}`);
      err.code = "refused";
      throw err;
    }
    if (res.status >= 500) {
      const err = new Error(`HTTP ${res.status}`);
      err.code = "upstream";
      throw err;
    }
    if (res.status === 405 || res.status === 501) return (await send("GET")).ok;
    return res.ok;
  }
  function maybeCrawlInstallEvidence({ force = false } = {}) {
    if (evidenceCrawl) return evidenceCrawl;
    const census = githubIndexDoc;
    if (!census?.rows?.length) return null;
    const held = evidenceDoc;
    const window = force ? { retryNoneMs: 0, refreshPlanMs: 0 } : {};
    const byId = new Map((held?.rows ?? []).map((row) => [row.id, row]));
    const rows = census.rows.filter((row) => typeof row.repository === "string" && row.repository && needsInstallEvidence(row, byId.get(row.id), window)).map((row) => ({ id: row.id, repository: row.repository, stars: row.stars }));
    if (!rows.length) return null;
    const stop = { controller: new AbortController(), reason: null };
    evidenceStop = stop;
    evidenceEnded = null;
    evidenceCrawl = (async () => {
      log?.info?.(`overall-mcp: recovering install commands for ${rows.length} repositories`);
      evidenceProgress = { requests: 0, attempted: 0, planned: rows.length };
      emit({ kind: "evidence", action: "start", rows: rows.length, force: force === true });
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
            stop.controller.signal.removeEventListener("abort", done);
            clearTimeout(timer);
            resolve();
          };
          const timer = setTimeout(done, ms);
          timer.unref?.();
          stop.controller.signal.addEventListener("abort", done, { once: true });
        }),
        signal: stop.controller.signal,
        onProgress: ({ requests, attempted, planned }) => {
          evidenceProgress = { requests, attempted, planned };
          if (requests % 200 === 0) log?.info?.(`overall-mcp: install evidence at ${requests} requests`);
        }
      });
      const reasonNote = stop.reason === "user" ? `\u5DF2\u624B\u52A8\u505C\u6B62\uFF08\u5DF2\u8BD5 ${walk.attempted} \u4E2A\u4ED3\u5E93\uFF0C\u4E0B\u6B21\u63A5\u7740\u8D70\uFF09` : stop.reason === "dispose" ? `\u63D2\u4EF6\u88AB\u5378\u8F7D\uFF0C\u5DF2\u505C\u6B62\uFF08\u5DF2\u8BD5 ${walk.attempted} \u4E2A\u4ED3\u5E93\uFF09` : null;
      const body = reasonNote ?? walk.partial;
      const hint = body && !stop.reason && !githubAuthStatus().inUse ? "\uFF08\u533F\u540D\u8BBF\u95EE\uFF1A\u5728\u5DF2\u6CE8\u518C\u6807\u7B7E\u9875\u91CC\u586B\u4E00\u4E2A GitHub token\uFF0C\u4E0A\u9650\u4ECE 60 \u6B21/\u5C0F\u65F6\u5347\u5230 5000 \u6B21/\u5C0F\u65F6\uFF09" : "";
      const doc = evidenceDocumentOf({
        at: walk.at,
        rows: walk.rows,
        requests: walk.requests,
        partial: body ? `${body}${hint}` : null
      });
      await writeJson(evidenceFile, doc);
      evidenceDoc = doc;
      evidenceLoaded = true;
      evidenceDamaged = null;
      evidenceLast = {
        at: walk.at,
        planned: walk.planned,
        attempted: walk.attempted,
        remaining: walk.remaining,
        retries: walk.retries,
        requests: walk.requests,
        stopped: stop.reason ?? null
      };
      const withCommand = doc.rows.filter((row) => row.install).length;
      log?.info?.(`overall-mcp: install evidence ${doc.rows.length} rows, ${withCommand} with a command (${walk.requests} requests, ${walk.retries} retries)`);
      emit({
        kind: "evidence",
        action: stop.reason ? "stopped" : "stop",
        ...stop.reason ? { reason: stop.reason } : {},
        requests: walk.requests,
        retries: walk.retries,
        rows: doc.rows.length,
        withCommand,
        planned: walk.planned,
        attempted: walk.attempted,
        remaining: walk.remaining,
        ...doc.partial ? { partial: doc.partial } : {}
      });
      return doc;
    })().catch((err) => {
      log?.warn?.(`overall-mcp: install evidence walk failed: ${String(err?.message ?? err)}`);
      emit({ kind: "evidence", action: "failed", error: String(err?.message ?? err) });
      return null;
    }).finally(() => {
      evidenceEnded = stop.reason ? { reason: stop.reason, at: (/* @__PURE__ */ new Date()).toISOString() } : null;
      evidenceCrawl = null;
      evidenceProgress = null;
      if (evidenceStop === stop) evidenceStop = null;
    });
    return evidenceCrawl;
  }
  function stopEvidence(reason = "user") {
    const stop = evidenceStop;
    if (!stop) return false;
    if (!stop.reason) stop.reason = reason;
    emit({ kind: "evidence", action: "stopping", reason: stop.reason, ...evidenceProgress ?? {} });
    stop.controller.abort();
    return true;
  }
  async function doEvidence({ action = null, force = false } = {}) {
    await readGithubIndex();
    await readEvidence();
    if (action === "stop") {
      const stopping = stopEvidence("user");
      const state = await evidenceState();
      return { ...state, stopping };
    }
    if (action === "start") {
      const before = evidenceCrawl;
      const walk = maybeCrawlInstallEvidence({ force: force === true });
      const state = await evidenceState();
      const skipped = walk !== null ? null : githubIndexDoc?.rows?.length ? "nothing-to-do" : "no-census";
      return {
        ...state,
        // "Did *this* call start a walk?" — not "is one running now?", which
        // `walking` already answers.
        started: walk !== null && walk !== before,
        ...skipped ? { skipped } : {}
      };
    }
    return evidenceState();
  }
  function evictOldest(map, max) {
    while (map.size > max) {
      let oldestKey;
      let oldestAt = Infinity;
      for (const [key, value] of map) {
        const at = typeof value?.at === "number" ? value.at : 0;
        if (at <= oldestAt) {
          oldestAt = at;
          oldestKey = key;
        }
      }
      map.delete(oldestKey);
    }
  }
  function favoriteKeyOf(item) {
    const source = String(item?.source ?? "unknown");
    const id = item?.id ?? item?.title;
    return `${source}:${id ?? ""}`;
  }
  const pendingCatalogBackfills = /* @__PURE__ */ new Map();
  function annotateItem(item) {
    const entry = catalogItemToEntry(item);
    const name2 = entry?.name ?? (item?.install ? proposedNameOf(item) : null);
    const match = name2 === null ? null : registry.servers.find((s) => s.name === name2 && (s.catalogId ? s.catalogId === item.id && s.source === `catalog:${item.source}` : s.source === `catalog:${item.source}`));
    const installed = Boolean(match);
    const icon = publicIcon(item.icon);
    const iconCandidates = publisherIcons(item.homepage, item.repository);
    const iconMatch = match?.catalogId ? match : (icon || iconCandidates.length) && item.source === "official-registry" && entry?.url ? registry.servers.find((row) => !row.catalogId && row.url === entry.url) : null;
    const fillIcon = iconMatch && icon && !publicIcon(iconMatch.icon);
    const heldCandidates = cleanPublisherIcons(iconMatch?.iconCandidates);
    const mergedCandidates = cleanPublisherIcons([...iconCandidates, ...heldCandidates]);
    const fillCandidates = iconMatch && iconCandidates.length && mergedCandidates.some((url, i) => url !== heldCandidates[i]);
    if (fillIcon || fillCandidates) {
      if (fillIcon) iconMatch.icon = icon;
      if (fillCandidates) iconMatch.iconCandidates = mergedCandidates;
      pendingCatalogBackfills.set(iconMatch.name, { kind: "catalog-icon-restored", source: item.source, id: item.id });
    }
    if (installed && entry?.config) {
      if (match && !match.config) {
        match.config = entry.config;
        if (!pendingCatalogBackfills.has(match.name)) pendingCatalogBackfills.set(match.name, { kind: "catalog-config-restored", source: item.source, id: item.id });
      }
    }
    return {
      ...item,
      artworkKey: mcpArtworkKey(item.id, item.repository, item.install?.url),
      iconCandidates,
      raw: void 0,
      qualifiedName: item.raw?.qualifiedName ?? void 0,
      proposedName: name2,
      // `catalogItemToEntry` refuses an http item that has no url yet, and a
      // hosted Smithery row only learns its url at install time. Calling that
      // 「需手动配置」 would hide the install button on every hosted entry —
      // the transport is declared, so the row is installable by definition.
      installable: entry !== null || item?.install?.deferred === true,
      installed,
      favorite: favorites.has(favoriteKeyOf(item)),
      // Installs made from this panel, so the card can show them next to the
      // upstream's own figure instead of silently mixing the two.
      localInstalls: localInstallsOf(installs, item, name2),
      localInstallLastAt: localLastInstallOf(installs, item, name2)
    };
  }
  async function doToggleFavoriteImpl({ key, on } = {}) {
    if (typeof key !== "string" || !key.trim()) throw new Error("key required");
    if (on !== void 0 && typeof on !== "boolean") throw new Error("on must be a boolean when given");
    const normalized = key.trim().slice(0, 200);
    if (on === true) favorites.add(normalized);
    else if (on === false) favorites.delete(normalized);
    else if (favorites.has(normalized)) favorites.delete(normalized);
    else favorites.add(normalized);
    registry.favorites = [...favorites].sort();
    await save();
    return { key: normalized, favorite: favorites.has(normalized), favorites: registry.favorites };
  }
  async function statusPayload() {
    const statOf = async (file) => {
      try {
        const s = await fs5.stat(file);
        return { bytes: s.size, at: s.mtime.toISOString() };
      } catch {
        return null;
      }
    };
    const relative = ["index.js", "client/client.js"];
    try {
      for (const name2 of await fs5.readdir(path7.join(PLUGIN_DIR, "lib"))) {
        if (name2.endsWith(".js")) relative.push(`lib/${name2}`);
      }
    } catch {
    }
    const sourceFiles = [];
    for (const rel of relative) {
      const facts = await statOf(path7.join(PLUGIN_DIR, rel));
      if (facts) sourceFiles.push({ name: rel, at: facts.at, bytes: facts.bytes });
    }
    const newestSource = sourceFiles.map((f) => f.at).sort().at(-1) ?? null;
    let version = null;
    try {
      version = JSON.parse(await fs5.readFile(path7.join(PLUGIN_DIR, "package.json"), "utf8"))?.version ?? null;
    } catch {
    }
    const dataFiles = [];
    for (const file of [registryFile, reportFile, sourcesFile, installsFile, githubIndexFile, skillIndexFile, evidenceFile, eventsFile]) {
      const facts = await statOf(file);
      dataFiles.push({ name: path7.basename(file), ...facts ?? { bytes: null, at: null } });
    }
    const census = await githubIndexPayload();
    const uptimeMs = Math.round(process.uptime() * 1e3);
    return {
      plugin: {
        id: "dsh-overall-mcp",
        version,
        dir: PLUGIN_DIR,
        loadedAt: LOADED_AT.toISOString(),
        // The question the panel could not ask: is the code on disk newer than
        // the code this process is running?
        source: {
          newestAt: newestSource,
          stale: newestSource !== null && newestSource > LOADED_AT.toISOString(),
          files: sourceFiles
        }
      },
      host: {
        pid: process.pid,
        startedAt: new Date(Date.now() - uptimeMs).toISOString(),
        uptimeMs,
        node: process.versions.node ?? null,
        electron: process.versions.electron ?? null,
        platform: process.platform,
        arch: process.arch
      },
      data: { dir, files: dataFiles },
      census: await censusState(),
      // The skill index in one shape: rows held per source, plus the two facts
      // only this process knows (a walk is running / how the last one ended).
      skillIndex: await skillIndexState(),
      evidence: await evidenceState(),
      quota: githubSearchQuota(),
      // Which credential the GitHub requests are going out with, and how much
      // quota it has left. Token-free by construction (lib/github-auth.js).
      auth: githubAuthStatus(),
      events: await eventFileFacts(eventsFile),
      errors: { registry: registryLoadError, sources: sourcesLoadError }
    };
  }
  async function doBrowse({ query = "", limit = 120, source = "", refresh = false } = {}) {
    const startedAt = Date.now();
    const q = typeof query === "string" ? query.slice(0, CATALOG_QUERY_MAX) : "";
    const githubIndex = await githubIndexPayload();
    const censusView = source === CENSUS_SOURCE;
    const walk = !source || source === "github-mcp" ? maybeCrawlGithubIndex({ force: refresh }) : null;
    const githubWalk = !githubIndex && (censusView || walk) ? githubWalkProgress ?? (censusView ? null : { requests: 0, rows: 0 }) : null;
    const evidence = await evidenceById();
    const result = await browseCatalog({
      query: q,
      limit,
      source,
      customSources,
      cache: catalogCache,
      force: refresh,
      githubIndex,
      githubWalk
    });
    if (result.sources["github-mcp"] && evidence.size) {
      result.sources["github-mcp"].install = await evidenceState();
    }
    const oldest = Object.values(result.sources).map((s) => s.at).filter((at) => typeof at === "string").sort()[0];
    emit({
      kind: "browse",
      source: source || "all",
      query: q || null,
      items: result.items.length,
      total: result.total,
      cached: Object.values(result.sources).every((s) => s.cached === true),
      errors: result.errors.length,
      ms: Date.now() - startedAt
    });
    const items = result.items.map((item) => applyInstallEvidence(item, evidence.get(item.id))).map(annotateItem).map((item) => ({ ...item, statsAt: result.sources[item.source]?.at ?? null, statsStale: result.sources[item.source]?.stale === true }));
    if (pendingCatalogBackfills.size) {
      const pending = [...pendingCatalogBackfills];
      try {
        await save();
      } catch (error) {
        emit({ kind: "catalog-backfill-save-failed", count: pending.length, error: String(error?.code ?? error?.name ?? "write") });
        throw error;
      }
      for (const [name2, event] of pending) {
        if (pendingCatalogBackfills.get(name2) !== event) continue;
        pendingCatalogBackfills.delete(name2);
        emit(event);
      }
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
      ...result.aliasOf ? { aliasOf: result.aliasOf } : {},
      servers: (await serversPayload()).servers
    };
  }
  function sourcesPayload() {
    return {
      sources: customSources.map((s) => ({ id: s.id, label: s.label, url: s.url, submission: submissionTargetFor(s.url) })),
      max: SOURCES_MAX,
      error: sourcesLoadError
    };
  }
  function submissionTargetFor(url) {
    const coords = githubRepoOfSourceUrl(url);
    if (!coords) return null;
    const repo = `${coords.owner}/${coords.repo}`;
    const issueUrl = buildIssueUrl({ repo, row: {} });
    return issueUrl ? { repo, url: issueUrl } : null;
  }
  async function doAddSource({ url, label } = {}) {
    const next = addSourceTo({ version: 1, sources: customSources }, { url, label });
    customSources = next.doc.sources;
    await saveSources();
    catalogCache.forgetSourceId(next.source.id);
    log?.info?.(`overall-mcp: custom source added \u2014 ${next.source.label} (${next.source.url})`);
    emit({ kind: "source-config", action: "add", id: next.source.id, url: next.source.url, label: next.source.label });
    return { source: next.source, ...sourcesPayload() };
  }
  async function doRemoveSource({ id } = {}) {
    if (typeof id !== "string" || !id.trim()) throw new Error("id required");
    const { doc, removed } = removeSourceFrom({ version: 1, sources: customSources }, id.trim());
    if (!removed) throw new Error(`unknown source: ${id.trim()}`);
    customSources = doc.sources;
    await saveSources();
    const dropped = catalogCache.forgetSourceId(removed.id);
    log?.info?.(`overall-mcp: custom source removed \u2014 ${removed.label} (${dropped} cached result(s) dropped)`);
    emit({ kind: "source-config", action: "remove", id: removed.id, url: removed.url, label: removed.label, dropped });
    return { removed, dropped, ...sourcesPayload() };
  }
  const repoStatsCache = /* @__PURE__ */ new Map();
  const repoStatsRevision = /* @__PURE__ */ new Map();
  const REPO_STATS_TTL_MS = 5 * 60 * 1e3;
  const REPO_STATS_MAX = 30;
  let repoStatsBatch = 0;
  let repoStatsBudget = { auth: "", retryAt: 0 };
  async function doRepoStats({ repos = [], refresh = false } = {}) {
    await refreshGithubAuth();
    const auth = withGithubAuth("https://api.github.com").authorization ?? "";
    if (repoStatsBudget.auth !== auth) repoStatsBudget = { auth, retryAt: 0 };
    const keys = [...new Set((Array.isArray(repos) ? repos : []).map((r) => String(r ?? "").trim()).filter((r) => /^[\w.-]+\/[\w.-]+$/.test(r)))].slice(0, REPO_STATS_MAX);
    const now = Date.now();
    const stats = {};
    const stale = [];
    for (const key of keys) {
      const hit = repoStatsCache.get(key);
      if (hit?.data) stats[key] = hit.data;
      if (refresh || !hit || hit.error || now - hit.at >= REPO_STATS_TTL_MS) stale.push(key);
    }
    if (repoStatsBudget.retryAt > now && stale.length) {
      return {
        stats,
        requested: keys.length,
        cached: false,
        rateLimited: true,
        retryAt: repoStatsBudget.retryAt,
        stale,
        errors: stale.map((repo) => ({ repo, rateLimited: true, message: "GitHub \u8BBF\u95EE\u9650\u989D\u5DF2\u7528\u5B8C\uFF0C\u4FDD\u7559\u4E0A\u6B21\u7EDF\u8BA1" }))
      };
    }
    const batch = ++repoStatsBatch;
    const revisions = new Map(stale.map((key) => {
      const id = (repoStatsRevision.get(key) ?? 0) + 1;
      repoStatsRevision.set(key, id);
      return [key, id];
    }));
    const fetched = stale.length ? await fetchRepoStats(stale.map((key) => {
      const [owner, repo] = key.split("/");
      return { key, owner, repo };
    })) : { errors: [], rateLimited: false };
    for (const key of stale) {
      if (repoStatsRevision.get(key) === revisions.get(key) && fetched[key]) {
        repoStatsCache.set(key, { at: Date.now(), data: fetched[key] });
      }
      const error = fetched.errors?.find((row) => row.repo === key);
      if (error && repoStatsRevision.get(key) === revisions.get(key)) {
        const held = repoStatsCache.get(key);
        repoStatsCache.set(key, { at: held?.at ?? 0, data: held?.data ?? null, error: error.message });
      }
      const current = repoStatsCache.get(key);
      if (current?.data) stats[key] = current.data;
    }
    if (batch === repoStatsBatch && repoStatsBudget.auth === auth && fetched.rateLimited) repoStatsBudget = { auth, retryAt: fetched.retryAt ?? Date.now() + 6e4 };
    const errors = fetched.errors ?? [];
    if (errors.length) log?.warn?.(`overall-mcp: repository statistics refresh incomplete: ${errors.map((row) => `${row.repo}: ${row.message}`).join("; ")}`);
    return {
      stats,
      requested: keys.length,
      cached: stale.length === 0,
      errors,
      stale: errors.map((row) => row.repo),
      rateLimited: fetched.rateLimited === true,
      ...fetched.retryAt ? { retryAt: fetched.retryAt } : {}
    };
  }
  const repoMediaCache = /* @__PURE__ */ new Map();
  const repoMediaRevision = /* @__PURE__ */ new Map();
  const REPO_MEDIA_TTL_MS = 6 * 60 * 60 * 1e3;
  const REPO_MEDIA_FAIL_TTL_MS = 5 * 60 * 1e3;
  const REPO_MEDIA_MAX = 24;
  const REPO_MEDIA_CACHE_MAX = 120;
  async function doRepoMedia({ repos = [], refresh = false } = {}) {
    const keys = [...new Set((Array.isArray(repos) ? repos : []).map((r) => String(r ?? "").trim()).filter((r) => /^[\w.-]+\/[\w.-]+$/.test(r)))].slice(0, REPO_MEDIA_MAX);
    const now = Date.now();
    const media = {};
    const stale = [];
    const errors = [];
    for (const key of keys) {
      const hit = repoMediaCache.get(key);
      const ttl = hit?.failed ? REPO_MEDIA_FAIL_TTL_MS : REPO_MEDIA_TTL_MS;
      if (!refresh && hit && now - hit.at < ttl) {
        media[key] = hit.data;
        if (hit.error) errors.push({ repo: key, error: hit.error });
      } else {
        stale.push(key);
      }
    }
    if (stale.length) {
      const revisions = new Map(stale.map((key) => {
        const id = (repoMediaRevision.get(key) ?? 0) + 1;
        repoMediaRevision.set(key, id);
        return [key, id];
      }));
      const fetched = await collectRepoMedia(stale, { max: stale.length });
      const failed = new Set((fetched.errors ?? []).map((e) => e.repo));
      for (const key of stale) {
        const data = fetched.media?.[key] ?? { repo: key, images: [], og: null };
        const error = fetched.errors?.find((row) => row.repo === key)?.error;
        if (repoMediaRevision.get(key) === revisions.get(key)) repoMediaCache.set(key, { at: Date.now(), data: failed.has(key) ? repoMediaCache.get(key)?.data ?? data : data, ...failed.has(key) ? { failed: true, error } : {} });
        media[key] = repoMediaCache.get(key)?.data ?? data;
      }
      evictOldest(repoMediaCache, REPO_MEDIA_CACHE_MAX);
      for (const e of fetched.errors ?? []) errors.push({ repo: e.repo, error: e.error });
    }
    return {
      media,
      requested: keys.length,
      cached: stale.length === 0,
      ...errors.length ? { errors } : {}
    };
  }
  const doScan = serialized(doScanImpl);
  const doInstall = serialized(doInstallImpl);
  const doSetEnabled = serialized(doSetEnabledImpl);
  const doConfigure = serialized(doConfigureImpl);
  const doSetSourceEnabled = serialized(doSetSourceEnabledImpl);
  const doRemove = serialized(doRemoveImpl);
  const doForgetOrphans = serialized(doForgetOrphansImpl);
  const doUpdate = serialized(doUpdateImpl);
  const doToggleFavorite = serialized(doToggleFavoriteImpl);
  const jsonOut = { schema: { type: "json" }, render: renderJson };
  const rawDefs = [
    defineTool({
      name: "overall_mcp_scan",
      description: "Rescan well-known host MCP config files (Claude Desktop/Code, Cursor, VS Code, Windsurf, Codex CLI, Gemini CLI) and import new servers into the overall MCP registry. An entry keeps its name: a server imported before is updated in place when its command/args/url changed, and an entry the user added by hand is never overwritten (it is reported as skipped). The answer also lists `orphans`: registry entries whose source was read by this scan and no longer defines that name (they mount nothing but still count as servers and answer to their name). Remove them with overall_mcp_forget_orphans.",
      parameters: {},
      output: jsonOut,
      execute: () => doScan()
    }),
    defineTool({
      name: "overall_mcp_list",
      description: "List all servers in the overall MCP registry with transport, source, enabled, live connection state, and whether the entry's own source still defines it (orphan: true means no config file read by the last scan contains that name).",
      parameters: {},
      output: jsonOut,
      async execute() {
        return serversPayload();
      }
    }),
    defineTool({
      name: "overall_mcp_search",
      description: "Search public open MCP server catalogs (official modelcontextprotocol registry, Smithery, Docker MCP Catalog, GitHub repository search for MCP servers, awesome-remote-mcp-servers, awesome-mcp-servers) by keyword and return up to 50 installable candidates.",
      parameters: {
        query: { type: "string", required: true, description: 'Search keywords, e.g. "github" or "postgres".' }
      },
      output: jsonOut,
      async execute({ query }) {
        return await browseCatalog({
          query,
          limit: 50,
          customSources,
          cache: catalogCache,
          githubIndex: await githubIndexPayload()
        });
      }
    }),
    defineTool({
      name: "overall_mcp_install",
      description: "Install one MCP server from catalog search results (pass the exact item object from overall_mcp_search) and connect it immediately. Its tools appear as mcp__<name>__<tool>. If another mcp-client mount already serves that DSH server name, this plugin records the entry as provided externally instead of mounting a second copy \u2014 the tools are already there. A server name that a hand-added entry already owns is refused; pass overwrite: true to replace that record with the catalogue entry.",
      parameters: {
        item: { type: "json", required: true, description: "One catalog item object exactly as returned by overall_mcp_search." },
        overwrite: { type: "boolean", description: "Replace a hand-added entry that already owns this name (default false: refuse instead)." }
      },
      output: jsonOut,
      async execute({ item, overwrite }) {
        return await doInstall(item, { overwrite: overwrite === true });
      }
    }),
    defineTool({
      name: "overall_mcp_set_enabled",
      description: 'Enable or disable one registry server. Enabling mounts and connects it; disabling unmounts the copy this plugin mounted and disconnects it, so its mcp__<name>__ tools disappear. An entry overall_mcp_list reports as status "provided-externally" is served by a different mcp-client mount that this plugin never mounted: disabling only records the intent, and those tools stay available (the reply carries stillProvided). A name defined more than once is refused unless `slot` picks the row (disabling the wrong row stops real tools).',
      parameters: {
        name: { type: "string", required: true },
        enabled: { type: "boolean", required: true },
        slot: { type: "integer", description: "Position of the row in the overall_mcp_list answer, to pick one of several same-named entries." },
        from: { type: "string", description: "Version the row displayed (fallback for a client that rendered before slots existed)." }
      },
      output: jsonOut,
      async execute({ name: name2, enabled, slot, from }) {
        return await doSetEnabled(name2, enabled, {
          slot: Number.isInteger(slot) ? slot : null,
          from: typeof from === "string" && from !== "" ? from : null
        });
      }
    }),
    defineTool({
      name: "overall_mcp_configure",
      description: `Save the settings one installed MCP server needs before its tools work (API keys, tokens, base URLs, auth headers) and remount it so they take effect. overall_mcp_list marks those rows with needConfig: true and lists the required keys in config.missing; each row's config.fields says which of them are secrets and which env/header they belong to. Pass values keyed by those field names \u2014 {"env": {"GITHUB_PERSONAL_ACCESS_TOKEN": "\u2026"}} or {"headers": {"Authorization": "Bearer \u2026"}}. An empty string clears a key. Values are write-only: the reply echoes secrets as \u2022\u2022\u2022\u2022 and never returns them.`,
      parameters: {
        name: { type: "string", required: true },
        env: { type: "json", description: 'Environment values keyed by variable name, e.g. {"GITHUB_PERSONAL_ACCESS_TOKEN": "ghp_\u2026"}.' },
        headers: { type: "json", description: 'HTTP header values for a remote (streamable-http) entry, e.g. {"Authorization": "Bearer \u2026"}.' },
        config: { type: "json", description: "Values for a server that takes its settings as a JSON flag (a Smithery CLI entry: `--config`), keyed by the field names whose kind is `config`. Sending such a key through `env` writes it where that CLI never reads, and the row keeps reporting it as missing." },
        slot: { type: "integer", description: "Position of the row in the overall_mcp_list answer, to pick one of several same-named entries." },
        from: { type: "string", description: "Version the row displayed (fallback for a client that rendered before slots existed)." }
      },
      output: jsonOut,
      async execute({ name: name2, env, headers, config, slot, from }) {
        return await doConfigure(name2, { env, headers, config }, {
          slot: Number.isInteger(slot) ? slot : null,
          from: typeof from === "string" && from !== "" ? from : null,
          actor: "model"
        });
      }
    }),
    defineTool({
      name: "overall_mcp_set_source_enabled",
      description: 'Enable or disable every server imported from one source (the source-group switch shown in the settings page), e.g. source "claude-desktop" or "catalog:smithery". Entries another mcp-client mount already provides are unaffected: the reply reports how many there were (externallyProvided).',
      parameters: {
        source: { type: "string", required: true, description: "Import source id, as shown by overall_mcp_list." },
        enabled: { type: "boolean", required: true }
      },
      output: jsonOut,
      async execute({ source, enabled }) {
        return await doSetSourceEnabled(source, enabled);
      }
    }),
    defineTool({
      name: "overall_mcp_catalog",
      description: "Browse the MCP marketplaces (official modelcontextprotocol registry, Smithery, Docker MCP Catalog, awesome-remote-mcp-servers, awesome-mcp-servers) for currently available MCP servers. Works without a query (top listings) and marks which entries are already installed.",
      parameters: {
        query: { type: "string", description: 'Optional keyword filter, e.g. "database".' },
        limit: { type: "integer", description: "Maximum items to return (default 400)." },
        source: { type: "string", description: "Optional single source: official-registry | smithery | docker-catalog | awesome-remote | awesome-list." },
        refresh: { type: "boolean", description: "Force a fresh fetch instead of the 10-minute cache." }
      },
      output: jsonOut,
      async execute(args) {
        return await doBrowse(args ?? {});
      }
    }),
    defineTool({
      name: "overall_mcp_check_updates",
      description: "Check every enabled registry server for a newer published version (npm / PyPI). Only entries launched through npx/uvx can be checked.",
      parameters: {},
      output: jsonOut,
      execute: () => doCheckUpdates()
    }),
    defineTool({
      name: "overall_mcp_update",
      description: "Update one registry server to its latest published version (repins the package argument) and reconnect it. When several registry entries share a name, pass `slot` (the row position from overall_mcp_list) or `from` (the version that row showed) to name the row; otherwise the name being ambiguous is an error rather than a guess.",
      parameters: {
        name: { type: "string", required: true },
        slot: { type: "integer", description: "Position of the row in the overall_mcp_list answer, to pick one of several same-named entries." },
        from: { type: "string", description: "Version the row displayed (fallback for a client that rendered before slots existed)." }
      },
      output: jsonOut,
      async execute({ name: name2, slot, from }) {
        return await doUpdate(name2, {
          slot: Number.isInteger(slot) ? slot : null,
          from: typeof from === "string" && from !== "" ? from : null
        });
      }
    }),
    defineTool({
      name: "overall_mcp_remove",
      description: "Remove one server from this plugin's registry. When this plugin mounted it, the mount is disconnected and its tools disappear. A server that overall_mcp_list reports as status \"provided-externally\" keeps working: only this plugin's registry record is removed (the reply carries stillProvided). A name defined more than once is refused unless `slot` (the row position from overall_mcp_list) or `from` (the version that row showed) picks the row \u2014 acting on the wrong row deletes real bookkeeping.",
      parameters: {
        name: { type: "string", required: true },
        slot: { type: "integer", description: "Position of the row in the overall_mcp_list answer, to pick one of several same-named entries." },
        from: { type: "string", description: "Version the row displayed (fallback for a client that rendered before slots existed)." }
      },
      output: jsonOut,
      async execute({ name: name2, slot, from }) {
        return await doRemove(name2, {
          slot: Number.isInteger(slot) ? slot : null,
          from: typeof from === "string" && from !== "" ? from : null
        });
      }
    }),
    defineTool({
      name: "overall_mcp_forget_orphans",
      description: "Remove every registry entry whose own source no longer defines it (the rows overall_mcp_scan reports as `orphans`, shown in the panel as \u6765\u6E90\u5DF2\u5220\u9664). These are leftovers of an old scanner rename; they mount nothing, but they still count as servers and answer to their name. Entries from a source that could not be read are never touched.",
      parameters: {},
      output: jsonOut,
      execute: () => doForgetOrphans()
    })
  ];
  const defs = rawDefs.map(withJsonSafeOutput);
  const disposers = defs.map((d) => ctx.tools.register(d));
  ctx.inject(["connection"], (connCtx) => {
    const json = (value, status = 200) => new Response(JSON.stringify(value), {
      status,
      headers: { "content-type": "application/json", "cache-control": "no-store" }
    });
    const guard = (fn) => async (request) => {
      try {
        return await fn(request);
      } catch (err) {
        const status = httpStatusFor(err);
        const message = redactSecrets(err?.message ?? err);
        if (status >= 500) {
          log?.warn?.(`overall-mcp: ${request?.method ?? "GET"} ${request?.url ?? ""} -> ${status}: ${message}`);
        }
        return json({ error: message, status }, status);
      }
    };
    const readBody = async (request) => {
      try {
        return await request.json();
      } catch {
        return {};
      }
    };
    healthVerdict = function healthVerdict2(row, { attempted = false, waitedMs = 0, startedAt = Date.now() } = {}) {
      const serverName = row.serverName ?? toServerName(row.name);
      const mounted = row.providedExternally === true || fibers.has(row.name);
      const handshaking = starting.has(row.name);
      const tools = serverName && typeof ctx.tools?.schemas === "function" ? ctx.tools.schemas().filter((s) => typeof s?.name === "string" && s.name.startsWith(`mcp__${serverName}__`)).length : null;
      const spec = specOf(row);
      const gaps = spec ? fieldGaps(spec, row) : { missing: [], pending: [] };
      const remote = row.transport === "streamable-http" || row.transport === "sse";
      const denied = remote && row.authDemand?.required === true ? row.authDemand : null;
      const checks = [
        { id: "enabled", ok: row.enabled !== false, detail: row.enabled === false ? "\u5DF2\u505C\u7528" : "\u5DF2\u542F\u7528" },
        {
          id: "mounted",
          ok: mounted,
          detail: mounted ? row.providedExternally === true ? "\u7531\u5176\u4ED6\u63D2\u4EF6\u63D0\u4F9B\u540C\u4E00\u4E2A serverName" : "\u5DF2\u6302\u8F7D" : row.connectError ? `\u672A\u6302\u8F7D\uFF1A${capText(row.connectError, 180)}` : "\u672A\u6302\u8F7D"
        },
        { id: "handshake", ...handshakeCheck({ mounted, starting: handshaking, waitedMs }) },
        {
          id: "tools",
          ok: tools === null ? true : tools > 0,
          detail: tools === null ? "\u5DE5\u5177\u8868\u4E0D\u53EF\u8BFB" : tools > 0 ? `${tools} \u4E2A\u5DE5\u5177\u5728\u518C` : denied ? `\u7AEF\u70B9\u62D2\u7EDD\u4E86\u8FD9\u6B21\u4F1A\u8BDD\uFF08HTTP ${denied.status}${denied.description ? `\uFF1A${capText(denied.description, 120)}` : ""}\uFF09\uFF1A\u5148\u786E\u8BA4\u914D\u7F6E\u91CC\u7684\u51ED\u636E\u5BF9\u4E0D\u5BF9\uFF0C\u518D\u68C0\u67E5\u4E00\u6B21` : !mounted ? `\u884C\u672A\u6302\u8F7D\uFF0C\u5DE5\u5177\u81EA\u7136\u4E3A 0${row.connectError ? `\uFF1A${capText(row.connectError, 160)}` : ""}${TRANSIENT_MOUNT_ERROR.test(String(row.connectError ?? "")) ? "\uFF08\u7F51\u7EDC\u5F02\u5E38\u6700\u591A\u81EA\u52A8\u91CD\u8BD5\u4E24\u6B21\uFF1B\u9700\u8981\u624B\u52A8\u91CD\u8FDE\u65F6\uFF0C\u53EF\u5148\u505C\u7528\u518D\u542F\u7528\uFF09" : ""}` : remote ? "\u5DF2\u8FDE\u63A5\u4F46\u5DE5\u5177\u8868\u4E3A\u7A7A\uFF1A\u5148\u786E\u8BA4\u670D\u52A1\u662F\u5426\u5DF2\u5C31\u7EEA\u53CA\u5730\u5740\u662F\u5426\u4E3A MCP \u7AEF\u70B9\uFF1B\u9700\u8981\u91CD\u8FDE\u65F6\uFF0C\u53EF\u5148\u505C\u7528\u518D\u542F\u7528" : "\u4E00\u4E2A\u5DE5\u5177\u90FD\u6CA1\u6CE8\u518C\uFF1A\u670D\u52A1\u8FDB\u7A0B\u53EF\u80FD\u5DF2\u7ECF\u9000\u51FA"
        },
        {
          id: "config",
          ok: gaps.missing.length === 0,
          detail: gaps.missing.length > 0 ? `\u8FD8\u7F3A ${gaps.missing.join("\u3001")}` : "\u58F0\u660E\u7684\u8981\u6C42\u5DF2\u9F50"
        }
      ];
      return {
        at: (/* @__PURE__ */ new Date()).toISOString(),
        ok: checks.every((check) => check.ok),
        attempted,
        waitedMs,
        waitedSeconds: waitedSeconds(waitedMs),
        toolCount: tools,
        checks,
        ms: Date.now() - startedAt
      };
    };
    const routes = [
      // Which build is running, and what it has been doing. The panel showed a
      // source as unavailable while the reason lived in a process that had
      // already exited; these two are the answer to "which build is this, and
      // what happened?" (see lib/events.js).
      ["/api/overall-mcp/status", ["GET"], guard(async () => json(await statusPayload()))],
      // The GitHub credential, as a separate resource rather than a corner of
      // /status. One entry per path: the host keys registrations by path, so a
      // second entry for `/auth` would replace this one instead of adding a
      // method (the test harness maps routes the same way).
      //
      // Ordinary reads automatically renew a missing/expired remembered login;
      // `?gh=1` explicitly bypasses both credential and discovery caches.
      ["/api/overall-mcp/auth", ["GET", "POST", "DELETE"], guard(async (req) => {
        if (req.method === "POST") {
          const body = await readBody(req);
          const token = typeof body.token === "string" ? body.token.trim() : "";
          if (!token) return json({ error: "token \u4E0D\u80FD\u4E3A\u7A7A", status: 400 }, 400);
          try {
            const stored = await storeToken(dir, token);
            const status = await refreshGithubAuth({ force: true });
            emit({
              kind: "auth",
              action: "set",
              source: status.source,
              masked: status.masked,
              login: status.login,
              ok: !status.error,
              ...status.error ? { error: status.error } : {}
            });
            return json({ ...status, storedAt: stored.at });
          } catch (err) {
            const message = String(err?.message ?? err);
            emit({ kind: "auth", action: "set", ok: false, error: message });
            return json({ error: `\u4FDD\u5B58 token \u5931\u8D25\uFF1A${message}`, status: 500 }, 500);
          }
        }
        if (req.method === "DELETE") {
          const removed = await clearToken(dir);
          const status = await refreshGithubAuth({ force: true });
          emit({ kind: "auth", action: "clear", removed, source: status.source });
          return json({ ...status, removed });
        }
        const force = new URL(req.url).searchParams.get("gh") === "1";
        return json(await refreshGithubAuth({ useGh: force ? true : "auto", force }));
      })],
      ["/api/overall-mcp/events", ["GET"], guard(async (req) => {
        const url = new URL(req.url);
        const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 100, 1), 500);
        const { events, damaged, total } = await readEvents(eventsFile, { limit });
        return json({ events, damaged, total, persistence: eventPersistence(eventsFile) });
      })],
      ["/api/overall-mcp/events/retry", ["POST"], guard(async () => {
        await flushEvents(eventsFile);
        return json({ ok: true, persistence: eventPersistence(eventsFile) });
      })],
      ["/api/overall-mcp/servers", ["GET"], guard(async () => json(await serversPayload()))],
      // The skill space: directories on this machine, read into the same panel.
      // `?refresh=1` skips the 60-second cache — the 扫描 button and the first
      // open after install both want the disk, not the last answer.
      ["/api/overall-mcp/skills", ["GET", "POST"], guard(async (req) => {
        const url = new URL(req.url);
        const refresh = url.searchParams.get("refresh") === "1";
        return json(await skillsPayload({ refresh }));
      })],
      ["/api/overall-mcp/skills/usage", ["GET"], guard(async () => {
        await callStore.refresh({ strict: true });
        return json({ usage: summarizeSkillUsage(callStore.rows, callStore.now()) });
      })],
      ["/api/overall-mcp/skills/reveal", ["POST"], guard(async (req) => {
        const body = await readBody(req);
        const out = await revealSkill(typeof body?.id === "string" ? body.id : "");
        return json(out, out.status ?? 200);
      })],
      // Removal is a move into our own trash directory, and it needs an explicit
      // `confirm: true`: a POST with just an id would let a stale page move a
      // skill the reader never saw.
      ["/api/overall-mcp/skills/remove", ["POST"], guard(async (req) => {
        const body = await readBody(req);
        if (body?.confirm !== true) return json({ ok: false, error: "confirm must be true" }, 400);
        const out = await removeSkill(typeof body?.id === "string" ? body.id : "");
        return json(out, out.status ?? 200);
      })],
      // The skill market: several sources behind one list, then one install verb.
      // `?source=` and `?query=` are read from the URL on GET and from the body
      // on POST, the same shape the MCP catalog uses.
      ["/api/overall-mcp/skills/market", ["GET", "POST"], guard(async (req) => {
        let body = {};
        if (req.method === "POST") body = await readBody(req);
        const url = new URL(req.url);
        const query = typeof body.query === "string" ? body.query : url.searchParams.get("query") ?? "";
        const source = typeof body.source === "string" ? body.source : url.searchParams.get("source") ?? "all";
        const limit = Math.min(Math.max(Number(body.limit ?? url.searchParams.get("limit")) || 20, 1), 200);
        const offset = Math.max(Number(body.offset ?? url.searchParams.get("offset")) || 0, 0);
        const category = body.category ?? url.searchParams.get("category") ?? "all";
        const sort = body.sort ?? url.searchParams.get("sort") ?? "default";
        if (!["all", ...SKILL_MARKET_CATEGORIES].includes(category) || !["default", "popular", "name"].includes(sort)) {
          return json({ error: "\u65E0\u6548\u7684 Skill \u5E02\u573A\u5206\u7C7B\u6216\u6392\u5E8F" }, 400);
        }
        if (source !== "all" && !SKILL_MARKET_SOURCES.includes(source)) {
          return json({ error: "\u672A\u77E5\u7684 Skill \u5E02\u573A\u6765\u6E90" }, 400);
        }
        const refresh = body.refresh === true || url.searchParams.get("refresh") === "1";
        return json(await skillMarketPayload({ source, query, category, sort, limit, offset, refresh }));
      })],
      // The index walk, and the two verbs a reader owns: `start` (walk now) and
      // `stop` (end the one in flight). Opening the market never starts it: ten
      // thousand rows is not something to begin because somebody looked.
      ["/api/overall-mcp/skills/market/walk", ["GET", "POST"], guard(async (req) => {
        const body = req.method === "POST" ? await readBody(req) : {};
        const url = new URL(req.url);
        const actionRaw = body.action ?? url.searchParams.get("action");
        const action = typeof actionRaw === "string" ? actionRaw.trim().toLowerCase() : "";
        if (action && action !== "start" && action !== "stop") {
          throw new Error(`unknown skill index action: ${actionRaw}`);
        }
        if (req.method === "GET" && action) {
          throw new Error(`the skill index action ${actionRaw} must be sent as a POST`);
        }
        await readSkillIndex();
        if (action === "stop") {
          const stopping = stopSkillWalk("user");
          return json({ ...await skillIndexState(), stopping });
        }
        if (action === "start") {
          const before = skillWalk;
          const full = Array.isArray(body.full) ? body.full.filter((id) => typeof id === "string") : [];
          if (before && !sameWalkSelection(skillWalkProgress?.modes, full)) {
            return json({
              ...await skillIndexState(),
              started: false,
              reason: "busy",
              error: "\u6B63\u5728\u6536\u5F55\u4E2D\uFF0C\u5F53\u524D\u9009\u62E9\u4E0E\u672C\u6B21\u4E0D\u540C\uFF1A\u5148\u70B9\u300C\u505C\u6B62\u6536\u5F55\u300D\uFF0C\u518D\u6309\u65B0\u7684\u9009\u62E9\u91CD\u6765"
            }, 409);
          }
          const walk = startSkillWalk({ force: true, full });
          const state = await skillIndexState();
          return json({
            ...state,
            // "Did *this* call start a walk" — not "is one running", which
            // `walking` already answers. A second click while the first is in
            // flight must not report a start it did not perform.
            started: walk !== null && walk !== before
          });
        }
        return json(await skillIndexState());
      })],
      // Installing writes a directory into one of the four roots we scanned.
      // The body names a bucket, never a path, and an id we listed ourselves.
      ["/api/overall-mcp/skills/market/metrics", ["POST"], guard(async (req) => {
        const body = await readBody(req);
        if (!Array.isArray(body.ids) || body.ids.length > 200 || body.ids.some((id) => typeof id !== "string" || id.length > 512)) return json({ error: "\u6280\u80FD\u7EDF\u8BA1\u8BF7\u6C42\u9700\u8981\u6709\u6548\u7684 id \u5217\u8868\uFF08\u6700\u591A200\u4E2A\uFF09" }, 400);
        await refreshGithubAuth();
        const items = [...new Set(body.ids)].map((id) => {
          const item = marketIndex.get(id);
          if (!item) throw Object.assign(new Error("unknown skill id, list the market first"), { status: 404 });
          return item;
        });
        const result = await marketFor().metrics({ items, refresh: body.refresh === true });
        if (result.errors.length) log?.warn?.(`overall-mcp: skill statistics refresh incomplete: ${result.errors.map((row) => `${row.id}: ${row.message}`).join("; ")}`);
        emit({ kind: "skill-metrics", requested: result.requested, updated: result.updated, errors: result.errors.length });
        return json(result);
      })],
      ["/api/overall-mcp/skills/market/install", ["POST"], guard(async (req) => {
        const body = await readBody(req);
        const id = typeof body?.id === "string" ? body.id : "";
        const root = typeof body?.root === "string" && body.root ? body.root : "plugin";
        const out = await installMarketSkill(id, { root });
        return json(out, out.status ?? 200);
      })],
      // The runtime feed: read-only, one answer per query — `space` picks the
      // surface, `range` the window, `filter` one server or skill, `q` free text.
      // Nothing here writes configuration; 「已注册」 and 「市场」 own that.
      ["/api/overall-mcp/prefs", ["GET", "POST"], guard(async (req) => {
        if (req.method === "GET") {
          const merge = (await readPrefs()).merge;
          return json({ merge: merge ?? null });
        }
        const body = await readBody(req);
        const raw = Number(body?.merge);
        if (!Number.isFinite(raw) || raw < 0 || raw > CALL_MERGE_MAX) {
          return json({ error: `unknown fold window: ${String(body?.merge)}` }, 400);
        }
        await writePrefs({ merge: raw });
        return json({ merge: raw });
      })],
      ["/api/overall-mcp/calls", ["GET"], guard(async (req) => {
        const url = new URL(req.url);
        const space = url.searchParams.get("space") === "skill" ? "skill" : "mcp";
        const asked = url.searchParams.get("range") ?? "24h";
        const range = Object.hasOwn(CALL_RANGES, asked) ? asked : "24h";
        const mergeAsked = url.searchParams.get("merge") === null ? NaN : Number(url.searchParams.get("merge"));
        const mergeStored = (await readPrefs()).merge;
        const merge = Number.isFinite(mergeAsked) && mergeAsked >= 0 ? Math.min(mergeAsked, CALL_MERGE_MAX) : Number.isFinite(mergeStored) ? mergeStored : void 0;
        await callStore.refresh();
        return json({
          ...summarize(callStore.rows, {
            space,
            range,
            filter: url.searchParams.get("filter") ?? "",
            q: url.searchParams.get("q") ?? "",
            ...merge === void 0 ? {} : { merge }
          }),
          coverage: callStore.coverage()
        });
      })],
      ["/api/overall-mcp/calls/retry", ["POST"], guard(async () => {
        await callStore.retryPersistence();
        return json({ ok: true, coverage: callStore.coverage() });
      })],
      ["/api/overall-mcp/scan", ["GET", "POST"], guard(async () => json(await doScan()))],
      ["/api/overall-mcp/catalog", ["GET", "POST"], guard(async (req) => {
        let body = {};
        if (req.method === "POST") body = await readBody(req);
        const url = new URL(req.url);
        const query = typeof body.query === "string" ? body.query : url.searchParams.get("query") ?? "";
        const source = typeof body.source === "string" ? body.source : url.searchParams.get("source") ?? "";
        const limitRaw = body.limit ?? url.searchParams.get("limit");
        const limit = Math.min(Math.max(Number(limitRaw) || 400, 1), 1e4);
        const refresh = body.refresh === true || url.searchParams.get("refresh") === "1";
        return json(await doBrowse({ query, source, limit, refresh }));
      })],
      // The census, and the two verbs a reader owns: `start` (a walk now, fresh
      // or not) and `stop` (end the one in flight). Before this route the walk
      // was only ever started as a side effect of browsing, which meant nobody
      // could ask for one — and, worse, nobody could end one: a census paces
      // itself at 6.5s per request for up to 48 requests, so "I did not want
      // this" had no answer. GET reads; only POST acts.
      ["/api/overall-mcp/census", ["GET", "POST"], guard(async (req) => {
        const body = req.method === "POST" ? await readBody(req) : {};
        const url = new URL(req.url);
        const actionRaw = body.action ?? url.searchParams.get("action");
        const action = typeof actionRaw === "string" ? actionRaw.trim().toLowerCase() : "";
        if (action && action !== "start" && action !== "stop") {
          throw new Error(`unknown census action: ${actionRaw}`);
        }
        if (req.method === "GET" && action) {
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
      ["/api/overall-mcp/install-evidence", ["GET", "POST"], guard(async (req) => {
        const body = req.method === "POST" ? await readBody(req) : {};
        const url = new URL(req.url);
        const actionRaw = body.action ?? url.searchParams.get("action");
        const action = typeof actionRaw === "string" ? actionRaw.trim().toLowerCase() : "";
        if (action && action !== "start" && action !== "stop") {
          throw new Error(`unknown evidence action: ${actionRaw}`);
        }
        if (req.method === "GET" && action) {
          throw new Error(`the evidence action ${actionRaw} must be sent as a POST`);
        }
        const force = body.force === true || url.searchParams.get("force") === "1";
        const state = await doEvidence({ action: action || (req.method === "POST" ? "start" : null), force });
        return json(state);
      })],
      ["/api/overall-mcp/repo-stats", ["GET", "POST"], guard(async (req) => {
        let body = {};
        if (req.method === "POST") body = await readBody(req);
        return json(await doRepoStats(body ?? {}));
      })],
      // Preview pictures for the market cards: README screenshots where they
      // exist, GitHub's own social card otherwise. URLs only — the client
      // loads them through a resize proxy, exactly like the plugin market.
      ["/api/overall-mcp/repo-media", ["GET", "POST"], guard(async (req) => {
        let body = {};
        if (req.method === "POST") body = await readBody(req);
        return json(await doRepoMedia(body ?? {}));
      })],
      ["/api/overall-mcp/install", ["POST"], guard(async (req) => {
        const { item, overwrite } = await readBody(req);
        if (!item || typeof item !== "object") return json({ error: "item required" }, 400);
        return json(await doInstall(item, { overwrite: overwrite === true }));
      })],
      // Bookmark a market entry. The listing is annotated on every read, so the
      // next browse reflects the new state; the page also patches its own copy
      // so the star flips without a 2 MB re-fetch.
      ["/api/overall-mcp/favorite", ["POST"], guard(async (req) => {
        const { key, on } = await readBody(req);
        return json(await doToggleFavorite({ key, on }));
      })],
      // The read side of the same set. `/catalog` marks each entry it returns,
      // but the marks only exist for entries the current query happens to
      // include — a source filter or a search would hide the rest, so "what have
      // I starred" needs an answer that does not depend on the listing on screen.
      ["/api/overall-mcp/favorites", ["GET"], guard(async () => json({
        favorites: [...favorites].sort(),
        count: favorites.size
      }))],
      // The user's own catalogue sources. GET is what the page reads before it
      // has any listing; POST adds one. Removal is its own path (POST), because
      // "add" and "remove" carry different bodies and a 405 is a worse answer
      // than a named route.
      ["/api/overall-mcp/sources", ["GET", "POST"], guard(async (req) => {
        if (req.method !== "POST") return json(sourcesPayload());
        const { url, label } = await readBody(req);
        return json(await doAddSource({ url, label }));
      })],
      ["/api/overall-mcp/sources/remove", ["POST"], guard(async (req) => {
        const { id } = await readBody(req);
        return json(await doRemoveSource({ id }));
      })],
      ["/api/overall-mcp/set-enabled", ["POST"], guard(async (req) => {
        const { name: name2, enabled, slot, from } = await readBody(req);
        if (typeof name2 !== "string" || typeof enabled !== "boolean") return json({ error: "name (string) and enabled (boolean) required" }, 400);
        const result = await doSetEnabled(name2, enabled, {
          slot: Number.isInteger(slot) ? slot : null,
          from: typeof from === "string" && from !== "" ? from : null
        });
        emit({
          kind: "mount",
          name: name2,
          enabled,
          ...result?.status ? { status: result.status } : {},
          ...result?.error ? { error: String(result.error) } : {}
        });
        return json(result);
      })],
      ["/api/overall-mcp/configure", ["POST"], guard(async (req) => {
        const { name: name2, env, headers, config, slot, from } = await readBody(req);
        if (typeof name2 !== "string" || name2 === "") return json({ error: "name (string) required" }, 400);
        return json(await doConfigure(name2, { env, headers, config }, {
          slot: Number.isInteger(slot) ? slot : null,
          from: typeof from === "string" && from !== "" ? from : null,
          actor: "user"
        }));
      })],
      // 「打开配置」这一步就该把要求问清楚. A row can know it takes configuration
      // (a Smithery entry: `--config` is visible in its args) without knowing
      // *what* — installed before the detail endpoint was consulted, or written
      // by an older build. Showing the user a free-form form in that state is
      // what they described as 「没有配置界面」: the server does declare a key,
      // the panel just never asked. So ask here, on the click, and answer with
      // the row as it is *now*: the form states the server's own requirements.
      ["/api/overall-mcp/config-hints", ["POST"], guard(async (req) => {
        const { name: name2, slot, from } = await readBody(req);
        if (typeof name2 !== "string" || name2 === "") return json({ error: "name (string) required" }, 400);
        const row = resolveEntry(name2, { slot, from });
        let healed = false;
        try {
          healed = await healSmitheryRow(row);
        } catch (err) {
          log?.warn?.(`overall-mcp: could not read the configuration hints for ${name2}: ${err?.message ?? err}`);
        }
        if (healed) {
          await save();
          emit({ kind: "config", action: "hints", target: name2, healed: true });
        }
        const { servers } = await serversPayload();
        const currentSlot = registry.servers.indexOf(row);
        if (currentSlot < 0) throw new Error(`stale entry: ${name2}\uFF08\u8BB0\u5F55\u5DF2\u79FB\u9664\uFF09`);
        const fresh = servers[currentSlot];
        if (!fresh || fresh.name !== name2) throw new Error(`stale entry: ${name2}\uFF08\u5217\u8868\u4F4D\u7F6E\u5DF2\u53D8\u5316\uFF09`);
        return json({ healed, server: fresh });
      })],
      // 「测一下这台服务器到底能不能用」. Local, cheap, no model call: what decides
      // a mount is the plugin's own bookkeeping (`fibers` / `starting` /
      // `connectError`), the host's tool registry (are any `mcp__<server>__`
      // tools actually published?), and the declarations (is a required value
      // still missing?). The tool count is the part the dot cannot show: a
      // server whose process died still has its row, and 「已连接」 on a row the
      // model cannot see a single tool on is exactly the lie this answers.
      ["/api/overall-mcp/health", ["POST"], guard(async (req) => {
        const { name: name2, slot, from, retry } = await readBody(req);
        if (typeof name2 !== "string" || name2 === "") return json({ error: "name (string) required" }, 400);
        const row = resolveEntry(name2, { slot, from });
        const startedAt = Date.now();
        let attempted = false;
        let waitedMs = 0;
        const inFlight = starting.has(row.name) ? fibers.get(row.name) : null;
        if (inFlight && typeof inFlight.await === "function") {
          attempted = true;
          const waitFrom = Date.now();
          await Promise.race([
            inFlight.await().catch(() => {
            }),
            new Promise((resolve) => {
              setTimeout(resolve, HEALTH_HANDSHAKE_WAIT_MS);
            })
          ]);
          waitedMs = Date.now() - waitFrom;
        }
        if (retry === true && row.enabled !== false && row.providedExternally !== true && !fibers.has(row.name)) {
          attempted = true;
          try {
            await serialized(async () => {
              if (!(registry.servers ?? []).includes(row)) return;
              if (row.enabled === false || fibers.has(row.name)) return;
              await connect(row);
            })();
          } catch (err) {
            row.connectError = redactSecrets(err?.message ?? err);
          }
        }
        const verdict = { ...healthVerdict(row, { attempted, waitedMs, startedAt }), fingerprint: rowFingerprint(row) };
        const ok = verdict.ok;
        health.set(row.name, verdict);
        emit({ kind: "health", action: "check", target: name2, ok, toolCount: verdict.toolCount });
        const { servers } = await serversPayload();
        const currentSlot = registry.servers.indexOf(row);
        if (currentSlot < 0) throw new Error(`stale entry: ${name2}\uFF08\u8BB0\u5F55\u5DF2\u79FB\u9664\uFF09`);
        const fresh = servers[currentSlot];
        if (!fresh || fresh.name !== name2) throw new Error(`stale entry: ${name2}\uFF08\u5217\u8868\u4F4D\u7F6E\u5DF2\u53D8\u5316\uFF09`);
        const { fingerprint: _fingerprint, ...sharedVerdict } = verdict;
        return json({ ok, health: sharedVerdict, server: fresh });
      })],
      // ---- purpose lines in the reader's language ---------------------------
      // 「这台服务器是干什么的」 comes from the server's own initialize block, in
      // the language its author wrote. This route is the only place that ever
      // asks a model to reword it: the client sends the language the page is in,
      // gets back what it already had for every line that needs nothing, and
      // costs a model call only for sentences no earlier visit has seen.
      ["/api/overall-mcp/about-i18n", ["POST"], guard(async (req) => {
        const { lang, items } = await readBody(req);
        const target = targetLang(lang);
        if (target === "") return json({ lang: "", translations: {}, unavailable: "no-lang" });
        const wanted = (Array.isArray(items) ? items : []).filter((it) => it && typeof it.name === "string" && it.name !== "" && typeof it.text === "string" && it.text.trim() !== "").slice(0, I18N_MAX_ITEMS);
        const translations = {};
        const pending = [];
        for (const item of wanted) {
          if (item.source !== void 0 && item.source !== "server") {
            translations[item.name] = item.text;
            continue;
          }
          if (!needsTranslation(item.text, target)) {
            translations[item.name] = item.text;
            continue;
          }
          const hit = aboutI18nCache.get(translationKey(target, item.text));
          if (typeof hit === "string") {
            translations[item.name] = hit;
            continue;
          }
          pending.push(item);
        }
        let unavailable = null;
        if (pending.length > 0) {
          const route = diagnosisRoute();
          if (!llmService) unavailable = "no-llm";
          else if (!route) unavailable = "no-route";
          else {
            try {
              const lines = await translateAboutLines({ lang: target, route, texts: pending.map((it) => it.text) });
              pending.forEach((item, index) => {
                translations[item.name] = lines[index];
                aboutI18nCache.set(translationKey(target, item.text), lines[index]);
              });
              while (aboutI18nCache.size > I18N_CACHE_MAX) {
                aboutI18nCache.delete(aboutI18nCache.keys().next().value);
              }
              await saveAboutI18n();
            } catch (err) {
              unavailable = "translate-failed";
              log?.warn?.(`overall-mcp: \u8BF4\u660E\u6587\u5B57\u7FFB\u8BD1\u5931\u8D25 \u2014 ${err?.message ?? err}`);
            }
          }
        }
        return json({ lang: target, translations, unavailable, cached: wanted.length - pending.length });
      })],
      ["/api/overall-mcp/set-source-enabled", ["POST"], guard(async (req) => {
        const { source, enabled } = await readBody(req);
        if (typeof source !== "string" || typeof enabled !== "boolean") return json({ error: "source (string) and enabled (boolean) required" }, 400);
        return json(await doSetSourceEnabled(source, enabled));
      })],
      ["/api/overall-mcp/updates", ["GET", "POST"], guard(async () => {
        const result = await doCheckUpdates();
        return json({ ...result, self: await doCheckSelfUpdate() });
      })],
      ["/api/overall-mcp/self", ["GET"], guard(async () => json(await doCheckSelfUpdate()))],
      ["/api/overall-mcp/self-update", ["POST"], guard(async () => json(await doSelfUpdate()))],
      ["/api/overall-mcp/update", ["POST"], guard(async (req) => {
        const { name: name2, slot, from } = await readBody(req);
        if (typeof name2 !== "string") return json({ error: "name required" }, 400);
        const result = await doUpdate(name2, {
          slot: Number.isInteger(slot) ? slot : null,
          from: typeof from === "string" && from !== "" ? from : null
        });
        emit({
          kind: "update",
          target: name2,
          updated: result?.updated === true,
          ...result?.from ? { from: result.from } : {},
          ...result?.to ? { to: result.to } : {},
          ...result?.reason ? { reason: result.reason } : {}
        });
        return json(result);
      })],
      ["/api/overall-mcp/remove", ["POST"], guard(async (req) => {
        const { name: name2, slot, from } = await readBody(req);
        if (typeof name2 !== "string") return json({ error: "name required" }, 400);
        return json(await doRemove(name2, {
          slot: Number.isInteger(slot) ? slot : null,
          from: typeof from === "string" && from !== "" ? from : null
        }));
      })],
      // Remove the rows the last scan proved are gone (来源已删除). One action
      // for the whole set: they are all the same kind of leftover, and removing
      // them one row at a time is what a name-keyed 移除 was doing wrong.
      ["/api/overall-mcp/forget-orphans", ["POST"], guard(async () => json(await doForgetOrphans()))],
      // Diagnostic: the schemas actually registered for mcp__* tools. Lets the
      // settings page (or a maintainer) confirm a provider-hostile pattern was
      // repaired rather than shipped to the model API.
      ["/api/overall-mcp/tools", ["GET"], guard(async () => {
        const schemas = typeof ctx.tools?.schemas === "function" ? ctx.tools.schemas() : [];
        const mine = schemas.filter((s) => typeof s?.name === "string" && s.name.startsWith("mcp__")).map((s) => ({
          name: s.name,
          patterns: collectPatterns(s.parameters)
        }));
        return json({ count: mine.length, tools: mine });
      })]
    ];
    for (const [routePath, methods, handler] of routes) {
      connCtx.connection.fetch.register({
        path: routePath,
        methods: [...methods],
        requestBody: "buffered",
        fetch: handler
      });
    }
  });
  const startupRuns = connectEnabled();
  let startupTimer = null;
  const startupBudget = new Promise((resolve) => {
    startupTimer = setTimeout(() => resolve(null), STARTUP_WAIT_MS);
    startupTimer.unref?.();
  });
  const startup = await Promise.race([startupRuns, startupBudget]);
  clearTimeout(startupTimer);
  const warnFailed = (results) => {
    const failed = results.filter((r) => !r.ok);
    if (failed.length) log?.warn?.(`some servers failed to connect: ${failed.map((r) => r.name).join(", ")}`);
  };
  if (startup) {
    warnFailed(startup);
  } else {
    startupRuns.then(warnFailed).catch(() => {
    });
  }
  ctx.effect(() => async () => {
    if (disposed) return;
    disposed = true;
    stopCensus("dispose");
    stopEvidence("dispose");
    stopSkillWalk("dispose");
    for (const timer of mountRetryTimers) clearTimeout(timer);
    mountRetryTimers.clear();
    mountAttempts.clear();
    for (const dispose of disposers) dispose();
    for (const fiber of fibers.values()) {
      Promise.resolve(fiber.dispose()).catch(() => {
      });
    }
    fibers.clear();
    starting.clear();
    setEventSink(null);
    await Promise.all([callStore.flush(), flushEvents(eventsFile)]);
  }, "overall-mcp.cleanup");
}
export {
  apply,
  inject,
  name
};
