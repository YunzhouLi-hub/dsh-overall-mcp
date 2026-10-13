// test/media.test.mjs — the repo-media pipeline. These are pure functions over
// README text, so every case is a fixture rather than a live fetch: the network
// is what makes this feature unreliable, and the ranking is the part that has
// to be right offline.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeImageUrl, collectImageRefs, rankImages, imageKindOf, ogImageOf,
  fetchReadmeText, collectRepoMedia, repoMediaFor,
} from '../lib/media.js';

const README = [
  '# Demo',
  '',
  '[![CI](https://img.shields.io/badge/build-passing-green)](https://github.com/o/r/actions)',
  '[![npm](https://badge.fury.io/js/demo.svg)](https://npmjs.com/demo)',
  '',
  '![logo](./docs/logo.png)',
  '',
  '<img src="https://user-images.githubusercontent.com/123/abc.png" width="800">',
  '',
  '![架构图](https://github.com/o/r/blob/main/docs/arch.png)',
  '',
  '![shot](docs/screenshot.png "The screenshot")',
  '',
  '[ref]: https://raw.githubusercontent.com/o/r/HEAD/docs/ref.png',
  '',
  '![inline data](data:image/png;base64,iVBORw0KGgo=)',
  '',
  '![remote](https://example.com/a.jpeg)',
].join('\n');

test('normalizeImageUrl resolves every README shape', () => {
  assert.equal(normalizeImageUrl('./docs/logo.png', 'o/r'), 'https://raw.githubusercontent.com/o/r/HEAD/docs/logo.png');
  assert.equal(normalizeImageUrl('docs/x.png', 'o/r'), 'https://raw.githubusercontent.com/o/r/HEAD/docs/x.png');
  assert.equal(normalizeImageUrl('https://github.com/o/r/blob/main/docs/arch.png', 'o/r'),
    'https://raw.githubusercontent.com/o/r/main/docs/arch.png');
  assert.equal(normalizeImageUrl('https://example.com/a.png', 'o/r'), 'https://example.com/a.png');
  assert.equal(normalizeImageUrl('https://example.com/a.png "title"', 'o/r'), 'https://example.com/a.png');
  assert.equal(normalizeImageUrl('<https://example.com/a.png>', 'o/r'), 'https://example.com/a.png');
});

test('normalizeImageUrl drops what cannot be a preview', () => {
  assert.equal(normalizeImageUrl('data:image/png;base64,iVBORw0KGgo=', 'o/r'), null);
  assert.equal(normalizeImageUrl('https://img.shields.io/badge/x-y-green', 'o/r'), null);
  assert.equal(normalizeImageUrl('https://badge.fury.io/js/demo.svg', 'o/r'), null);
  assert.equal(normalizeImageUrl('https://example.com/not-an-image', 'o/r'), null);
  assert.equal(normalizeImageUrl('', 'o/r'), null);
  assert.equal(normalizeImageUrl('./x.png', ''), null);
});

test('collectImageRefs finds inline, html and reference images', () => {
  const refs = collectImageRefs(README);
  const urls = refs.map((r) => r.url);
  assert.ok(urls.includes('./docs/logo.png'));
  assert.ok(urls.includes('https://user-images.githubusercontent.com/123/abc.png'));
  assert.ok(urls.includes('https://github.com/o/r/blob/main/docs/arch.png'));
  assert.ok(urls.includes('docs/screenshot.png'));
  assert.ok(urls.includes('https://raw.githubusercontent.com/o/r/HEAD/docs/ref.png'));
});

test('rankImages drops badges and puts screenshots first', () => {
  const ranked = rankImages(collectImageRefs(README).map((c) => ({ ...c, repo: 'o/r' })));
  const urls = ranked.map((r) => r.url);
  // Badge hosts never survive, however many of them a README has.
  assert.ok(!urls.some((u) => /shields\.io|fury\.io/.test(u)), urls.join('\n'));
  assert.ok(!urls.includes('data:image/png;base64,iVBORw0KGgo='));
  // The README's only screenshot-shaped names lead.
  assert.equal(ranked[0].url, 'https://raw.githubusercontent.com/o/r/HEAD/docs/screenshot.png');
  assert.ok(ranked.length <= 6);
});

// A live run of punkpeye/awesome-mcp-servers came back with four glama.ai score
// badges filling the preview slot: the host was not on the list, the path was
// /badges/score.svg, and every one of them was an SVG with no stated size.
test('rankImages rejects the MCP directory score badges', () => {
  const md = [
    '[![a](https://glama.ai/mcp/servers/x/y/badges/score.svg)](https://glama.ai/mcp/servers/x)',
    '![b](https://mcpservers.org/badge.svg)',
    '![架构图](docs/arch.png)',
  ].join('\n');
  const urls = rankImages(collectImageRefs(md).map((c) => ({ ...c, repo: 'o/r' }))).map((r) => r.url);
  assert.deepEqual(urls, ['https://raw.githubusercontent.com/o/r/HEAD/docs/arch.png']);
});

test('rankImages uses stated geometry and rejects thumbnails', () => {
  const ranked = rankImages([
    { url: 'https://a/tiny.png', alt: 'shot', repo: 'o/r', width: 88, height: 31 },
    { url: 'https://a/big.png', alt: 'shot', repo: 'o/r', width: 1200, height: 600 },
    { url: 'https://a/nosize.svg', alt: 'shot', repo: 'o/r' },
  ]);
  const urls = ranked.map((r) => r.url);
  assert.ok(!urls.includes('https://a/tiny.png'), 'a badge-sized picture is not a screenshot');
  assert.ok(!urls.includes('https://a/nosize.svg'), 'an unsized SVG is a generated card, not a picture');
  assert.equal(urls[0], 'https://a/big.png');
  assert.equal(ranked[0].width, 1200);
});

test('rankImages dedupes and caps', () => {
  const ranked = rankImages([
    { url: 'https://a/x.png', alt: '', repo: 'o/r' },
    { url: 'https://a/x.png', alt: '', repo: 'o/r' },
    ...Array.from({ length: 20 }, (_, i) => ({ url: `https://a/${i}.png`, alt: '', repo: 'o/r' })),
  ], 4);
  assert.equal(ranked.length, 4);
  assert.equal(new Set(ranked.map((r) => r.url)).size, 4);
});

test('imageKindOf separates screenshots, charts and plain images', () => {
  assert.equal(imageKindOf('https://x/demo.png', ''), 'screenshot');
  assert.equal(imageKindOf('https://x/a.svg', 'Architecture diagram'), 'screenshot');
  assert.equal(imageKindOf('https://api.star-history.com/svg?repos=a/b', ''), 'chart');
  assert.equal(imageKindOf('https://x/logo.png', ''), 'image');
});

test('ogImageOf builds the social card URL or nothing', () => {
  assert.equal(ogImageOf('punkpeye/awesome-mcp-servers'),
    'https://opengraph.githubassets.com/punkpeye/awesome-mcp-servers');
  assert.equal(ogImageOf('not-a-repo'), null);
  assert.equal(ogImageOf(''), null);
});

test('fetchReadmeText returns null when no carrier answers', async () => {
  const dead = async () => ({ ok: false, text: async () => '' });
  assert.equal(await fetchReadmeText('o/r', dead), null);
});

test('fetchReadmeText accepts the first good carrier', async () => {
  let calls = 0;
  const impl = async (url) => {
    calls += 1;
    return { ok: true, text: async () => (calls === 1 ? '# hi' : '# other') };
  };
  assert.equal(await fetchReadmeText('o/r', impl), '# hi');
  assert.equal(calls, 1);
});

test('collectRepoMedia caches nothing across calls and bounds its budget', async () => {
  let calls = 0;
  const impl = async () => { calls += 1; return { ok: true, text: async () => '![s](docs/shot.png)' }; };
  const { media, errors } = await collectRepoMedia(['o/a', 'o/b', 'o/c'], { fetchImpl: impl, max: 2 });
  assert.equal(calls, 2);           // budget honoured, third repo untouched
  assert.deepEqual(Object.keys(media).sort(), ['o/a', 'o/b']);
  assert.equal(errors.length, 0);
  assert.equal(media['o/a'].images.length, 1);
  // README pictures win, so the social card is not used.
  assert.equal(media['o/a'].og, null);
});

test('collectRepoMedia falls back to the social card with no README', async () => {
  const impl = async () => ({ ok: false, text: async () => '' });
  const { media } = await collectRepoMedia(['punkpeye/awesome-mcp-servers'], { fetchImpl: impl });
  assert.equal(media['punkpeye/awesome-mcp-servers'].images.length, 0);
  assert.equal(media['punkpeye/awesome-mcp-servers'].og,
    'https://opengraph.githubassets.com/punkpeye/awesome-mcp-servers');
});

test('collectRepoMedia degrades to the social card when every carrier fails', async () => {
  // fetchReadmeText swallows per-carrier failures, so a repo with no readable
  // README is answered with the social card rather than an error — the strip
  // must never be the reason a market page fails to load.
  const impl = async () => { throw new Error('boom'); };
  const { media, errors } = await collectRepoMedia(['o/a'], { fetchImpl: impl });
  assert.equal(errors.length, 0);
  assert.equal(media['o/a'].images.length, 0);
  assert.equal(media['o/a'].og, 'https://opengraph.githubassets.com/o/a');
});

test('repoMediaFor caps the strip at four pictures', async () => {
  const md = Array.from({ length: 12 }, (_, i) => `![s${i}](docs/shot${i}.png)`).join('\n');
  const impl = async () => ({ ok: true, text: async () => md });
  const entry = await repoMediaFor('o/r', impl);
  assert.equal(entry.images.length, 4);
});
