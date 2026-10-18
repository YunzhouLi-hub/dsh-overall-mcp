// lib/about-i18n.js — 「这台服务器是干什么的」那句话，按用户的语言显示。
//
// Where the sentence comes from (`lib/about.js`): the server's own `initialize`
// instructions, first paragraph — prose written by whoever built the server, in
// whatever language they wrote it. For an English server on a Chinese panel that
// is one English line sitting in an otherwise Chinese row, which is what the行
// looked like to the author of this panel.
//
// Two rules keep this honest:
//
//   1. Nothing is translated unless the sentence needs it. A row whose purpose
//      line is 「工具：a、b 等 5 个」 is already Chinese (this plugin wrote it),
//      and a command line is a command line.
//   2. The model is only a translator, never an author: the prompt says the
//      output must be the same number of lines, product/package/CLI names stay
//      verbatim, and a line already in the target language is repeated as-is.
//
// The result is cached per (language, source line) on disk, so a panel opened a
// hundred times asks the model once per sentence.

/** How many lines one request may carry; the route rejects more. */
export const I18N_MAX_ITEMS = 40;

/** Longest source line worth translating; `describeAbout` clamps far below this. */
export const I18N_MAX_CHARS = 600;

/** Translations kept on disk; the oldest are dropped first. */
export const I18N_CACHE_MAX = 400;

export const I18N_SYSTEM = [
  'You translate short descriptions of MCP servers for a developer tool panel.',
  'Translate each numbered line into the requested language.',
  'Keep unchanged: product names, package names, command names, flag names, file paths, URLs, and code identifiers.',
  'If a line is already in the requested language, repeat it unchanged.',
  'Keep each translation about the same length as its source; it is a one-line subtitle, not an explanation.',
  'Reply with a JSON array of strings and nothing else: same length, same order, no keys, no commentary.',
].join(' ');

const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;

/**
 * `zh-CN` → `zh`, `EN` → `en`, anything unusable → ''.
 *
 * Only the primary subtag matters: every Chinese variant wants the same
 * sentence, and asking one model call per region would be waste.
 */
export function targetLang(value) {
  if (typeof value !== 'string') return '';
  const primary = value.trim().toLowerCase().split(/[-_]/)[0];
  return /^[a-z]{2,3}$/.test(primary) ? primary : '';
}

export function hasLocalizedScript(text, lang) {
  if (typeof text !== 'string') return false;
  if (lang === 'zh' || lang === 'ja') return CJK.test(text);
  return false;
}

/**
 * Should this line be sent to the translator?
 *
 * `en` is the source language of essentially every server instruction block, so
 * an English panel asks for nothing. A line that already carries the target
 * script is left alone: translating it again would be the one change the user
 * could actually see and not want.
 */
export function needsTranslation(text, lang) {
  if (typeof text !== 'string') return false;
  const trimmed = text.trim();
  if (trimmed === '') return false;
  const target = targetLang(lang) || (typeof lang === 'string' ? lang : '');
  if (target === '' || target === 'en') return false;
  return !hasLocalizedScript(trimmed, target);
}

/** The user message for one batch. Numbered so a short reply is diagnosable. */
export function buildTranslationPrompt({ lang, texts }) {
  const target = targetLang(lang) || String(lang ?? '');
  const lines = (Array.isArray(texts) ? texts : []).map((text, index) => `${index + 1}. ${String(text).slice(0, I18N_MAX_CHARS)}`);
  return [
    `Target language: ${target}`,
    `Lines: ${lines.length}`,
    '',
    ...lines,
  ].join('\n');
}

/**
 * Parse the model's answer into `count` strings, or `null`.
 *
 * A model that answers with a paragraph, a shorter array, or one string per
 * line instead of a JSON array is not an error worth surfacing: the caller falls
 * back to the original text, which is the sentence the user already had.
 */
export function parseTranslations(raw, count) {
  if (typeof raw !== 'string' || !Number.isInteger(count) || count <= 0) return null;
  const start = raw.indexOf('[');
  const end = raw.lastIndexOf(']');
  if (start < 0 || end <= start) return null;
  let parsed;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length !== count) return null;
  const out = parsed.map((value) => (typeof value === 'string' ? value.trim() : ''));
  return out.every((value) => value !== '') ? out : null;
}

/** `${lang}\u0000${text}` — one key per sentence per language. */
export function translationKey(lang, text) {
  const target = targetLang(lang) || String(lang ?? '');
  return `${target}\u0000${text}`;
}

/**
 * Keep the cache file small and inspectable: a plain array of
 * `{ lang, source, text }` rows, newest last, capped.
 */
export function cacheRowsOf(cache, max = I18N_CACHE_MAX) {
  const rows = [];
  if (!(cache instanceof Map)) return rows;
  for (const [key, value] of cache) {
    const sep = key.indexOf('\u0000');
    if (sep <= 0) continue;
    rows.push({ lang: key.slice(0, sep), source: key.slice(sep + 1), text: value });
  }
  return rows.slice(Math.max(0, rows.length - max));
}

export function cacheFromRows(rows) {
  const cache = new Map();
  if (!Array.isArray(rows)) return cache;
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const { lang, source, text } = row;
    if (typeof lang !== 'string' || typeof source !== 'string' || typeof text !== 'string') continue;
    if (lang === '' || source === '' || text === '') continue;
    cache.set(translationKey(lang, source), text);
  }
  return cache;
}
