// lib/install-diagnosis.js — what a failed mount is allowed to tell a model,
// and how the model's answer is read back.
//
// Why this is its own module: the interesting parts are text, not I/O. What the
// model is told, what must *never* be told to it, and how a stream of blocks
// becomes one short paragraph are all decisions that deserve tests without a
// host. The service plumbing (which model route, which stream) stays in
// index.js, which supplies the assembled blocks.
//
// The failure this exists for: the plugin wrote the entry into registry.json and
// the MCP client could not mount it. The user sees one raw line like
// `spawn npx ENOENT` or `MCP error -32000: Connection closed` and has no way to
// know whether the command is missing, the package name is wrong, the version
// was unpublished, or a proxy is in the way. Asking the user's own model to
// explain that line is cheaper than asking them to read it.

/** Hard cap on the diagnosis shown to the user. A panel row is not an essay. */
export const DIAGNOSIS_MAX_CHARS = 600;
/** Hard cap on the raw error quoted into the prompt. */
export const ERROR_MAX_CHARS = 800;
/** How many stdio arguments are quoted; longer tails are counted, not shown. */
export const ARG_LINES_MAX = 8;

/**
 * The instruction sent as the request's system prompt.
 *
 * Written in Chinese because the panel is Chinese and the answer is displayed
 * verbatim. The prohibitions are the point: a model that invents a flag or
 * tells the user to disable a sandbox or paste an API key onto a command line
 * has made the failure worse than the raw error did.
 */
export const DIAGNOSIS_SYSTEM = `你是 DSH 的 MCP 安装故障诊断助手。用户刚在市场里安装了一个 MCP 服务器：条目已经写进注册表，但宿主没能把它挂载起来。你会收到这次安装的条目事实和宿主报告的原始错误。

只输出诊断，不要复述错误，不要道歉，不要反问。最多三行：
第一行：最可能的原因，具体到事实（命令不存在、包名或版本不存在、需要环境变量或凭据、网络或代理、配置项非法、远端握手失败等）。
第二行：下一步该做什么，一条可执行的检查或动作。
第三行：只有在原始错误确实不足以判断原因时才写，说明还需要看到什么。

禁止：编造 URL、参数、版本号或配置键；声称你已经运行过任何命令或查看过任何日志；建议关闭沙箱、以管理员身份运行或跳过安全检查；建议把口令写进注册表、命令行或环境变量以外的地方。用简体中文回答，不要用 Markdown 标题或代码块。`;

// ---------------------------------------------------------------------------
// Redaction — the prompt crosses a trust boundary (the user's model provider)
// ---------------------------------------------------------------------------

/** Argument flags whose value is a credential, not a fact about the failure. */
const SENSITIVE_FLAG = /^--?[A-Za-z0-9_-]*(?:key|token|secret|password|passwd|pwd|auth|bearer|credential|signature)[A-Za-z0-9_-]*$/i;
/** Query parameters whose value is a credential. */
const SENSITIVE_QUERY = /^(?:api[-_]?key|key|token|access[-_]?token|auth|authorization|secret|client[-_]?secret|password|passwd|signature|sig|credential|bearer)$/i;
/** Values that look like a credential whatever their label says. */
const TOKEN_SHAPED = /\b(?:sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]{8,}|xox[baprs]-[A-Za-z0-9-]{6,}|AKIA[0-9A-Z]{12,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{4,})\b/g;

/**
 * Best-effort secret redaction for text that is about to leave the machine.
 *
 * This is deliberately narrow and honest about being best-effort: it catches
 * labelled credentials (`--api-key=…`, `?token=…`) and the token shapes worth
 * recognising on sight. It cannot catch a credential the user pasted as a bare
 * word, which is exactly why `diagnosisFactsOf` never quotes the entry's `env`
 * or `headers` at all — the reliable defence is not sending those fields.
 *
 * @param text - any string (command line, URL, error message).
 * @returns the same text with labelled and recognisable credentials masked.
 */
export function redactSecrets(text) {
  let out = String(text ?? '');
  // `--flag=value`, `--flag: value`, and `--flag value`, for flag names that
  // name a credential. The separator keeps whatever whitespace it had.
  out = out.replace(/(--?[A-Za-z0-9_-]+)([=:]\s*)(\S+)/g, (match, flag, sep, value) => (
    SENSITIVE_FLAG.test(flag) ? `${flag}${sep}<redacted>` : match
  ));
  out = out.replace(/(^|\s)(--?[A-Za-z0-9_-]+)(\s+)(\S+)/g, (match, lead, flag, space, value) => (
    SENSITIVE_FLAG.test(flag) ? `${lead}${flag}${space}<redacted>` : match
  ));
  out = out.replace(TOKEN_SHAPED, '<redacted>');
  return out;
}

/**
 * Rewrite a URL so it can be quoted to a model: credentials in the authority are
 * dropped, credential-valued query parameters are masked, everything else (host,
 * path, harmless query, fragment) is kept so the model can still reason about it.
 *
 * @param raw - a URL, or anything else (returned as a redacted string).
 * @returns a redacted absolute URL, or the redacted input when it does not parse.
 */
export function redactUrl(raw) {
  const text = String(raw ?? '');
  try {
    const url = new URL(text);
    url.username = '';
    url.password = '';
    for (const [name] of [...url.searchParams]) {
      if (SENSITIVE_QUERY.test(name)) url.searchParams.set(name, '<redacted>');
    }
    return redactSecrets(url.toString());
  } catch {
    return redactSecrets(text);
  }
}

// ---------------------------------------------------------------------------
// Facts → prompt
// ---------------------------------------------------------------------------

/**
 * Trim and cap one block of text, keeping the head (errors put the useful part
 * first; a stack tail rarely changes the diagnosis).
 *
 * @param text - any string.
 * @param max - maximum characters to keep.
 * @returns the trimmed text, capped with a single-character ellipsis.
 */
export function capText(text, max = ERROR_MAX_CHARS) {
  const trimmed = String(text ?? '').trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, Math.max(0, max - 1))}…`;
}

/**
 * Reduce one install attempt to the facts a diagnosis may use.
 *
 * Deliberately absent: `env`, `headers`, and anything else the user configured
 * as a secret. The registry entry carries both, and neither is a fact about why
 * a process failed to start.
 *
 * @param input - `{ item, entry, error }` as index.js has them at the failure.
 * @returns a flat, already-redacted fact record for `buildDiagnosisPrompt`.
 */
export function diagnosisFactsOf({ item = null, entry = null, error = '' } = {}) {
  const args = Array.isArray(entry?.args) ? entry.args.map((a) => String(a)) : [];
  return {
    name: String(entry?.name ?? item?.title ?? ''),
    source: String(item?.source ?? entry?.source ?? ''),
    transport: String(entry?.transport ?? item?.transport ?? 'unknown'),
    command: entry?.command === undefined ? '' : String(entry.command),
    args: args.slice(0, ARG_LINES_MAX),
    argsOmitted: Math.max(0, args.length - ARG_LINES_MAX),
    url: entry?.url === undefined ? '' : redactUrl(entry.url),
    repository: String(item?.repository ?? ''),
    homepage: String(item?.homepage ?? ''),
    version: String(item?.version ?? ''),
    category: String(item?.category ?? ''),
    error: capText(redactSecrets(error), ERROR_MAX_CHARS),
  };
}

/**
 * Render the prompt sent as the request's only user message.
 *
 * The shape is fixed rather than pretty-printed: a stable layout means a test
 * can assert that a secret-bearing field is absent, and the model gets the
 * command line and the error adjacent to each other.
 *
 * @param facts - output of `diagnosisFactsOf`.
 * @returns the prompt text.
 */
export function buildDiagnosisPrompt(facts) {
  const lines = ['安装条目'];
  lines.push(`- 名称：${facts.name || '(未命名)'}`);
  if (facts.source) lines.push(`- 来源：${facts.source}`);
  lines.push(`- 传输：${facts.transport === 'stdio' ? 'stdio 命令' : facts.transport === 'streamable-http' ? 'streamable-http 地址' : '未知'}`);
  if (facts.command) lines.push(`- 命令：${redactSecrets(facts.command)}`);
  for (const [index, arg] of (facts.args ?? []).entries()) {
    lines.push(`- 参数 ${index + 1}：${redactSecrets(arg)}`);
  }
  if (facts.argsOmitted > 0) lines.push(`- 另有 ${facts.argsOmitted} 个参数未列出`);
  if (facts.url) lines.push(`- 地址：${facts.url}`);
  if (facts.repository) lines.push(`- 仓库：${facts.repository}`);
  if (facts.homepage) lines.push(`- 主页：${facts.homepage}`);
  if (facts.version) lines.push(`- 版本：${facts.version}`);
  if (facts.category) lines.push(`- 分类：${facts.category}`);
  lines.push('', '宿主报告的错误', facts.error || '(没有错误文本)');
  return lines.join('\n');
}

/**
 * Read one short paragraph out of assembled stream blocks.
 *
 * Reasoning blocks are dropped: the panel wants the answer, not the model
 * thinking out loud. Blocks are joined with a blank line because a model that
 * answers in three paragraphs of one line each is following the format above.
 *
 * @param blocks - assembled blocks (`{type, text}`), as dsh-llm's BlockAssembler
 *   returns them.
 * @returns the diagnosis text, capped; `''` when the model produced no text.
 */
export function diagnosisTextOf(blocks) {
  const parts = (Array.isArray(blocks) ? blocks : [])
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text.trim())
    .filter((text) => text !== '');
  return capText(parts.join('\n\n'), DIAGNOSIS_MAX_CHARS);
}
