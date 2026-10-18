import test from 'node:test';
import assert from 'node:assert/strict';

import {
  I18N_CACHE_MAX, I18N_MAX_CHARS, buildTranslationPrompt, cacheFromRows, cacheRowsOf,
  hasLocalizedScript, needsTranslation, parseTranslations, targetLang, translationKey,
} from '../lib/about-i18n.js';

// ---------------------------------------------------------------------------
// 语言标签. The panel only needs the primary subtag: every Chinese variant wants
// the same sentence, and asking a model once per region would be waste.
test('targetLang keeps the primary subtag and rejects what is not a language', () => {
  assert.equal(targetLang('zh-CN'), 'zh');
  assert.equal(targetLang('zh_TW'), 'zh');
  assert.equal(targetLang('EN'), 'en');
  assert.equal(targetLang('pt-BR'), 'pt');
  assert.equal(targetLang(''), '');
  assert.equal(targetLang('  '), '');
  assert.equal(targetLang('zh-CN-x-private'), 'zh');
  // Not languages: a whole sentence, a number, nothing at all.
  assert.equal(targetLang('chinese please'), '');
  assert.equal(targetLang('1'), '');
  assert.equal(targetLang(undefined), '');
  assert.equal(targetLang(null), '');
  assert.equal(targetLang(42), '');
});

test('hasLocalizedScript only claims what it can actually see', () => {
  assert.equal(hasLocalizedScript('工具：read、write', 'zh'), true);
  assert.equal(hasLocalizedScript('Tools for reading docs.', 'zh'), false);
  assert.equal(hasLocalizedScript('文書を読む', 'ja'), true);
  // A script this function cannot judge is never guessed at.
  assert.equal(hasLocalizedScript('Liest Dokumente.', 'de'), false);
  assert.equal(hasLocalizedScript(undefined, 'zh'), false);
});

// ---------------------------------------------------------------------------
// 该不该翻. English panel, empty line, or a line already carrying the target
// script: nothing to ask. Anything else is prose in a language the reader may
// not read.
test('needsTranslation asks only when the reader would see another language', () => {
  assert.equal(needsTranslation('Tools for reading docs.', 'zh-CN'), true);
  assert.equal(needsTranslation('Tools for reading docs.', 'en'), false, 'the panel is already in the source language');
  assert.equal(needsTranslation('工具：read、write 等 2 个', 'zh'), false, 'already Chinese');
  assert.equal(needsTranslation('文書を読む', 'ja'), false);
  assert.equal(needsTranslation('', 'zh'), false);
  assert.equal(needsTranslation('   ', 'zh'), false);
  assert.equal(needsTranslation(undefined, 'zh'), false);
  assert.equal(needsTranslation('Tools for reading docs.', ''), false, 'no target language, no request');
});

test('buildTranslationPrompt states the language, the count, and numbers every line', () => {
  const prompt = buildTranslationPrompt({ lang: 'zh-CN', texts: ['Tools for reading docs.', 'Searches the web.'] });
  assert.match(prompt, /^Target language: zh$/m);
  assert.match(prompt, /^Lines: 2$/m);
  assert.match(prompt, /^1\. Tools for reading docs\.$/m);
  assert.match(prompt, /^2\. Searches the web\.$/m);
  // A hostile 10k-character line cannot become a 10k-character request.
  const long = buildTranslationPrompt({ lang: 'zh', texts: ['x'.repeat(5000)] });
  assert.equal(long.split('\n').at(-1).length, I18N_MAX_CHARS + 3);
});

// ---------------------------------------------------------------------------
// 模型怎么答才算数. A paragraph, a shorter array, or an empty string is not a
// usable translation — the caller falls back to the sentence the user had.
test('parseTranslations accepts exactly one non-empty string per source line', () => {
  assert.deepEqual(parseTranslations('["用于读取文档。","搜索网页。"]', 2), ['用于读取文档。', '搜索网页。']);
  // Models like to wrap JSON in a code fence; the array is still unambiguous.
  assert.deepEqual(parseTranslations('```json\n["工具。"]\n```', 1), ['工具。']);
  assert.deepEqual(parseTranslations('Here you go:\n["工具。"]\nAnything else?', 1), ['工具。']);

  assert.equal(parseTranslations('Sure! Here is the translation:', 1), null, 'prose is not a translation');
  assert.equal(parseTranslations('["工具。"]', 2), null, 'a short array must not shift the rows');
  assert.equal(parseTranslations('["工具。",""]', 2), null, 'an empty line would blank a row');
  assert.equal(parseTranslations('["工具。",42]', 2), null);
  assert.equal(parseTranslations('[]', 0), null);
  assert.equal(parseTranslations(undefined, 1), null);
});

// ---------------------------------------------------------------------------
// 缓存. Keyed by language + source sentence, so a server that rewords its line is
// translated once more while every unchanged row stays free.
test('translationKey separates languages from each other', () => {
  assert.equal(translationKey('zh-CN', 'Tools.'), translationKey('zh', 'Tools.'));
  assert.notEqual(translationKey('zh', 'Tools.'), translationKey('ja', 'Tools.'));
  assert.notEqual(translationKey('zh', 'Tools.'), translationKey('zh', 'Tools!'));
});

test('the cache round-trips through its on-disk shape', () => {
  const cache = new Map([
    [translationKey('zh', 'Tools for reading docs.'), '用于读取文档的工具。'],
    [translationKey('ja', 'Tools for reading docs.'), 'ドキュメントを読むためのツール。'],
  ]);
  const rows = cacheRowsOf(cache);
  assert.equal(rows.length, 2);
  assert.deepEqual(cacheFromRows(rows), cache);
  // Damaged entries are dropped, not repaired into a wrong translation.
  assert.equal(cacheFromRows([{ lang: 'zh' }, null, 'nope', { lang: '', source: 'x', text: 'y' }]).size, 0);
  assert.equal(cacheFromRows(undefined).size, 0);
});

test('the cache file stays bounded and keeps the newest rows', () => {
  const cache = new Map();
  for (let index = 0; index < I18N_CACHE_MAX + 25; index += 1) {
    cache.set(translationKey('zh', `line ${index}`), `第 ${index} 行`);
  }
  const rows = cacheRowsOf(cache);
  assert.equal(rows.length, I18N_CACHE_MAX);
  assert.equal(rows.at(-1).source, `line ${I18N_CACHE_MAX + 24}`, 'the last thing translated survives');
  assert.equal(rows[0].source, 'line 25', 'the oldest are the ones dropped');
});
