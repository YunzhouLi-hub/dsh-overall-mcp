// tools/verify-detail-links.mjs — what the detail panel offers for each source.
//
// The card previously exposed only 仓库/主页 + 安装, and for two of the five
// sources that left the user with no way to reach the upstream at all. This
// checks the link-selection rules the panel applies, per source, against the
// live catalog.
import { browseCatalog } from '../lib/catalog.js';

const r = await browseCatalog({ limit: 400 });

// A source that failed this run simply does not appear below; say so instead
// of letting its absence read as "no links".
if (r.errors.length) {
  console.log(`source failures this run: ${r.errors.map((e) => `${e.source} (${e.message})`).join(', ')}\n`);
}

function repoKeyOf(item) {
  const m = String(item?.repository ?? '').match(/^https?:\/\/(?:www\.)?github\.com\/([^/\s]+)\/([^/\s#?]+)/i);
  return m ? `${m[1]}/${m[2].replace(/\.git$/i, '')}` : null;
}

/** The panel's own link selection, mirrored. Each pair is `[url, label]`. */
function linksOf(item) {
  const repo = repoKeyOf(item);
  const homepage = item.homepage && item.homepage !== item.repository ? item.homepage : null;
  // Verified: smithery.ai/server/<name> 308-redirects to /servers/<name>.
  // `qualifiedName` is promoted out of `raw` by the host's annotateItem; the
  // raw browseCatalog items still carry it under `raw`.
  const qualifiedName = item.qualifiedName ?? item.raw?.qualifiedName;
  const registryPage = item.source === 'smithery' && qualifiedName
    ? `https://smithery.ai/servers/${qualifiedName}`
    : null;
  // Measured 2026-10-12: gh-proxy.com serves github.com repo pages (200),
  // contradicting dshmarket's 2026-09 measurement of 403 — re-measured rather
  // than inferred, per its own note. Direct GitHub is intermittent here, so
  // both are offered.
  const ghMirror = repo && item.repository ? `https://gh-proxy.com/${item.repository}` : null;
  const candidates = [
    [homepage, '官网'],
    [item.repository, repo ? 'GitHub 仓库' : '主页'],
    [ghMirror, 'GitHub 镜像'],
    [item.install?.transport === 'streamable-http' ? item.install.url : null, 'MCP 端点'],
    [registryPage, 'Smithery 页面'],
  ].filter(([url]) => typeof url === 'string' && url.length > 0);
  const seen = new Set();
  return candidates.filter(([url]) => {
    if (seen.has(url)) return false;
    seen.add(url);
    return true;
  });
}

const bySource = new Map();
for (const item of r.items) {
  const links = linksOf(item);
  const entry = bySource.get(item.source) ?? { total: 0, noLinks: 0, withRepo: 0, withHome: 0, withEndpoint: 0, withRegistry: 0, withMirror: 0 };
  entry.total += 1;
  if (links.length === 0) entry.noLinks += 1;
  if (links.some(([, label]) => label === 'GitHub 仓库')) entry.withRepo += 1;
  if (links.some(([, label]) => label === '官网')) entry.withHome += 1;
  if (links.some(([, label]) => label === 'MCP 端点')) entry.withEndpoint += 1;
  if (links.some(([, label]) => label === 'Smithery 页面')) entry.withRegistry += 1;
  if (links.some(([, label]) => label === 'GitHub 镜像')) entry.withMirror += 1;
  bySource.set(item.source, entry);
}

console.log('per-source link coverage (what the detail panel can offer):');
for (const [source, e] of [...bySource.entries()].sort()) {
  console.log(`  ${source.padEnd(20)} ${String(e.total).padStart(4)} entries · 官网 ${e.withHome} · 仓库 ${e.withRepo} · 镜像 ${e.withMirror} · 端点 ${e.withEndpoint} · 目录页 ${e.withRegistry} · 无任何链接 ${e.noLinks}`);
}

// No entry may be a dead end: every card must reach its upstream somehow.
const dead = r.items.filter((i) => linksOf(i).length === 0);
console.log(`\nentries with no reachable upstream at all: ${dead.length}`);
for (const d of dead.slice(0, 10)) console.log(`  - [${d.source}] ${d.title} (${d.id})`);
if (dead.length > 0) process.exitCode = 1;

// The panel must never show the same URL twice.
const dup = r.items.filter((i) => {
  const urls = linksOf(i).map(([url]) => url);
  return new Set(urls).size !== urls.length;
});
console.log(`entries whose panel would show the same URL twice: ${dup.length}`);
for (const d of dup.slice(0, 5)) console.log(`  - [${d.source}] ${d.title}: ${linksOf(d).map(([url, label]) => `${label}=${url}`).join(' | ')}`);
if (dup.length > 0) process.exitCode = 1;

// Spot-check one entry per source end to end.
console.log('\nexample detail links:');
const shown = new Set();
for (const item of r.items) {
  if (shown.has(item.source)) continue;
  shown.add(item.source);
  const links = linksOf(item).map(([url, label]) => `${label} ${url}`).join('  ·  ') || '（无）';
  console.log(`  [${item.source}] ${item.title}\n      ${links}`);
  if (shown.size === bySource.size) break;
}
