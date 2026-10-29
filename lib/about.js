/**
 * 「这个 MCP 是干什么的」—— the line that follows a registered server's name.
 *
 * The 已注册 rows used to say `stdio · 已连接 · 工具前缀 mcp__x__` and nothing
 * about what the server *does*; the user asked for the opposite
 * (「MCP下载好之后后面的应该是解释这个MCP的作用」). The best possible source is
 * the server's own `instructions` from the MCP `initialize` result — dsh-mcp-client
 * publishes them verbatim as the system-prompt section `mcp:<serverName>`, so the
 * host can read back what the server says about itself instead of guessing from a
 * name.
 *
 * Ordering below is deliberate: the server's own words, then the capability list
 * we can actually observe (its registered tools), then the launch command, which
 * at least names what is being run. Nothing is invented: every source is labelled
 * so the row can say where the sentence came from, and a server we know nothing
 * about shows no purpose line at all rather than a fabricated one.
 */

/** Longest purpose line we keep; the row renders two lines at any width. */
export const ABOUT_MAX_CHARS = 150;

/** `### MCP server: <name>` is added by dsh-mcp-client, not by the server. */
const TRANSPORT_HEADING = /^#{1,6}\s*MCP server:\s*\S+\s*$/i;
const HEADING = /^#{1,6}\s*(.+)$/;
const RULE = /^([-*_])\1{2,}$/;
const IMAGE_ONLY = /^!\[[^\]]*\]\([^)]*\)$/;

/** Drop the markdown that would look like debris inside a 12px row. */
export function stripInlineMarkdown(text) {
  return String(text ?? '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/`{1,3}([^`]*)`{1,3}/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/(^|\s)[*_](\S[^*_]*)[*_]/g, '$1$2')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The first readable paragraph of a server's `instructions`, plus the first
 * heading as a fallback: several servers open with `# Name — what it does` and
 * put the prose two paragraphs later, or ship no prose at all.
 */
export function firstParagraph(instructions) {
  const lines = String(instructions ?? '').split(/\r?\n/);
  let heading = '';
  let current = [];

  const paragraphs = [];
  const flush = () => {
    if (current.length) {
      paragraphs.push(current.join(' '));
      current = [];
    }
  };

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) { flush(); continue; }
    if (TRANSPORT_HEADING.test(line)) { flush(); continue; }
    if (RULE.test(line)) { flush(); continue; }
    const asHeading = HEADING.exec(line);
    if (asHeading) {
      flush();
      // A heading is usually the one-line summary; keep it only in case no
      // paragraph follows (or the paragraph is too short to be a sentence).
      if (!heading) heading = stripInlineMarkdown(asHeading[1]);
      continue;
    }
    // A label like "Tools:" followed by a list is navigation, not purpose.
    if (/^[A-Za-z][A-Za-z /&-]{0,30}:$/.test(line)) { flush(); continue; }
    if (IMAGE_ONLY.test(line)) { flush(); continue; }
    current.push(line);
  }
  flush();

  const paragraph = paragraphs.find((p) => stripInlineMarkdown(p).length >= 24);
  const cleaned = paragraph ? stripInlineMarkdown(paragraph) : '';
  return cleaned || heading || '';
}

/** Cut at a sentence or word boundary so a truncated line still reads. */
export function clampLine(text, maxChars = ABOUT_MAX_CHARS) {
  const value = stripInlineMarkdown(text);
  if (value.length <= maxChars) return value;
  const window = value.slice(0, maxChars);
  const sentence = Math.max(window.lastIndexOf('。'), window.lastIndexOf('. '), window.lastIndexOf('；'), window.lastIndexOf('; '));
  if (sentence >= maxChars * 0.5) return window.slice(0, sentence + 1).trim();
  const space = window.lastIndexOf(' ');
  const cut = space >= maxChars * 0.6 ? window.slice(0, space) : window;
  return `${cut.trim()}…`;
}

/** `mcp__<server>__raw` → `raw`, for the servers we are describing. */
export function toolNamesFor(schemas, serverName) {
  const prefix = `mcp__${serverName}__`;
  if (!Array.isArray(schemas) || !serverName) return [];
  return schemas
    .map((s) => (typeof s?.name === 'string' ? s.name : ''))
    .filter((name) => name.startsWith(prefix))
    .map((name) => name.slice(prefix.length));
}

/**
 * Build the purpose line from whatever evidence exists.
 *
 * @returns {{text: string, source: 'server'|'tools'|'command', toolCount: number}|null}
 *   `source` names the evidence, so the UI can say where the sentence came from
 *   (`server` = the server's own instructions, `tools` = its registered tools,
 *   `command` = the launch command, used before a first successful connect).
 */
export function describeAbout({ instructions, toolNames, command, maxChars = ABOUT_MAX_CHARS } = {}) {
  const fromServer = clampLine(firstParagraph(instructions), maxChars);
  if (fromServer) return { text: fromServer, source: 'server', toolCount: 0 };

  const names = Array.isArray(toolNames) ? toolNames.filter(Boolean) : [];
  if (names.length) {
    const shown = names.slice(0, 3).join('、');
    const text = names.length > 3
      ? `工具：${shown} 等 ${names.length} 个`
      : `工具：${shown}`;
    return { text: clampLine(text, maxChars), source: 'tools', toolCount: names.length };
  }

  const line = clampLine(Array.isArray(command) ? command.filter(Boolean).join(' ') : command, maxChars);
  return line ? { text: line, source: 'command', toolCount: 0 } : null;
}

/** Human-readable evidence label; the row shows it as the purpose line's tooltip. */
export function aboutSourceLabel(source, { connecting = false } = {}) {
  if (source === 'server') return '来自服务器自身的说明（MCP initialize）';
  if (source === 'tools') return '根据该服务器已注册的工具推断';
  if (source === 'command') {
    return connecting
      ? '尚未连接，先显示启动命令；连接成功后改为服务器自身说明'
      : '尚未连接，显示启动命令';
  }
  return '';
}

/**
 * Should the host assemble the system prompt again to look for this server?
 *
 * dsh-mcp-client publishes the `mcp:<serverName>` section only while the server
 * is connected, so "no section" means "not connected yet" and must NOT be cached
 * as final: the first payload after a connect has to read again, or the row would
 * keep the launch command forever. Remembering the liveness we saw is what makes
 * that both correct and bounded — a steady state re-reads only when a server
 * transitions, instead of on every page load.
 *
 * @param {{read: boolean, rememberedGen?: string, live: boolean, name?: string}} state
 */
export function needsInstructionsRead({ read, rememberedGen, live, name } = {}) {
  if (!name) return false;
  if (!read) return true;
  return rememberedGen !== (live ? 'live' : 'down');
}
