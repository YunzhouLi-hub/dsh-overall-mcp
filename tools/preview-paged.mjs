// tools/preview-paged.mjs — render the market the way the settings page now does:
// sorted, paged, category-filtered, with the compact headline count and the
// per-unit usage labels.
//
// Talks to a running DSH instance over its real Connection-authenticated routes.
//   node tools/preview-paged.mjs "<base-url-with-?token=…>" [pageSize] [page] [sort] [category]
//   category: a heading name, "__none__" for the uncategorized bucket, "" for all
import { browseCatalog, fetchRepoStats } from '../lib/catalog.js';

const target = process.argv[2];
const pageSize = Number(process.argv[3] ?? 20);
const page = Number(process.argv[4] ?? 1);
const sort = process.argv[5] ?? 'default';
const category = process.argv[6] ?? '';

function repoKeyOf(item) {
  const m = String(item?.repository ?? '').match(/^https?:\/\/(?:www\.)?github\.com\/([^/\s]+)\/([^/\s#?]+)/i);
  return m ? `${m[1]}/${m[2].replace(/\.git$/i, '')}` : null;
}
function starCountOf(item, stats) {
  const repo = repoKeyOf(item);
  return (repo ? stats?.[repo] : null)?.stars ?? item.stars;
}
function compact(n) {
  const v = Number(n) || 0;
  if (v >= 1e6) return `${Math.floor(v / 1e5) / 10}M`;
  if (v >= 1e3) return `${Math.floor(v / 100) / 10}k`;
  return String(v);
}
function compactCount(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v < 1000) return String(v ?? 0);
  if (v >= 1e6) return `${Math.floor(v / 1e5) / 10}M`;
  return `${Math.floor(v / 100) / 10}k`;
}
function qualityOf(item, stats) {
  let s = 0;
  if (item.verified) s += 400;
  if (item.official) s += 300;
  if (item.install) s += 120;
  if (typeof item.installs === 'number') s += Math.min(200, Math.log10(item.installs + 1) * 40);
  const stars = starCountOf(item, stats);
  if (typeof stars === 'number') s += Math.min(200, Math.log10(stars + 1) * 40);
  if (item.deprecated) s -= 500;
  return s;
}
function compareMarket(a, b, sortKey, stats) {
  const qa = qualityOf(a, stats);
  const qb = qualityOf(b, stats);
  const desc = (x, y) => {
    const hasX = typeof x === 'number';
    const hasY = typeof y === 'number';
    if (hasX && hasY) return x !== y ? y - x : 0;
    if (hasX) return -1;
    if (hasY) return 1;
    return 0;
  };
  switch (sortKey) {
    case 'installs': return desc(a.installs, b.installs) || qb - qa;
    case 'stars': return desc(starCountOf(a, stats), starCountOf(b, stats)) || qb - qa;
    case 'updated': return (Date.parse(b.updatedAt ?? '') || 0) - (Date.parse(a.updatedAt ?? '') || 0) || qb - qa;
    case 'name': return a.title.localeCompare(b.title) || qb - qa;
    default: return qb - qa;
  }
}

async function viaHttp(url) {
  const base = new URL(url);
  const origin = base.origin;
  const boot = await fetch(`${origin}/?token=${base.searchParams.get('token')}`, { redirect: 'manual' });
  const raw = boot.headers.get('set-cookie');
  if (!raw) throw new Error(`no session cookie (HTTP ${boot.status})`);
  const cookie = raw.split(';')[0];
  const post = async (path, body) => {
    const res = await fetch(origin + path, {
      method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify(body ?? {}),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${path} -> HTTP ${res.status} ${text.slice(0, 200)}`);
    return JSON.parse(text);
  };
  const market = await post('/api/overall-mcp/catalog', { limit: 400 });
  const repos = [];
  const seen = new Set();
  for (const item of market.items ?? []) {
    const key = repoKeyOf(item);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    repos.push(key);
    if (repos.length >= 30) break;
  }
  const { stats } = repos.length ? await post('/api/overall-mcp/repo-stats', { repos }) : { stats: {} };
  return { market, stats };
}

const { market, stats } = target ? await viaHttp(target) : { market: await browseCatalog({ limit: 400 }), stats: {} };

// Mirror the settings page: the group chip row is built from the listing
// (`group` is the host-side functional consolidation of upstream headings),
// then the filter runs before the sort.
const counts = new Map();
let uncategorized = 0;
for (const item of market.items ?? []) {
  if (item.group) counts.set(item.group, (counts.get(item.group) ?? 0) + 1);
  else uncategorized += 1;
}
const groupOptions = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
if (uncategorized > 0) groupOptions.push(['__none__', uncategorized]);

const filtered = (market.items ?? []).filter((i) => !category
  || (category === '__none__' ? !i.group : i.group === category));
const all = filtered.slice().sort((a, b) => compareMarket(a, b, sort, stats));
const pageCount = Math.max(1, Math.ceil(all.length / pageSize));
const safe = Math.min(page, pageCount);
const slice = all.slice((safe - 1) * pageSize, safe * pageSize);

const catLabel = category ? ` · 分类 ${category === '__none__' ? '未分类' : category}（筛选后 ${filtered.length} 条）` : '';
console.log(`${compactCount(market.total ?? (market.items ?? []).length)} 个可用 MCP（${market.total ?? (market.items ?? []).length}）· 排序 ${sort}${catLabel} · 第 ${safe}/${pageCount} 页 · 每页 ${pageSize} 条`);
console.log(`per-source ${JSON.stringify(market.counts)} · errors: ${market.errors.length ? JSON.stringify(market.errors.map((e) => e.source)) : 'none'}`);
console.log(`stars enriched for ${Object.keys(stats).length} repositories`);
if (!category) {
  console.log(`chip row: 全部(${(market.items ?? []).length}) ${groupOptions.slice(0, 20).map(([c, n]) => `${c === '__none__' ? '未分类' : c}(${n})`).join(' ')}`);
}
console.log('');

for (const [i, item] of slice.entries()) {
  const repo = repoKeyOf(item);
  const enriched = repo ? stats[repo] : null;
  const stars = starCountOf(item, stats);
  const author = enriched?.author ?? item.author;
  const meta = [
    item.version ? `v${item.version}` : null,
    item.transport !== 'unknown' ? item.transport : null,
    typeof item.installs === 'number'
      ? `${compact(item.installs)} ${item.installsLabel ?? '次使用'}${item.installsWindow ? `（${item.installsWindow}）` : ''}`
      : null,
    typeof stars === 'number' ? `★ ${compact(stars)}` : null,
  ].filter(Boolean).join(' · ');
  // Offline browseCatalog items carry no `installable` (the host's
  // annotateItem adds it); derive it so the state column is not wrong.
  const state = item.installed ? '已安装'
    : (item.installable ?? Boolean(item.install)) ? '可安装' : '需手动配置';
  console.log(`${String((safe - 1) * pageSize + i + 1).padStart(4)}. ${item.title}${item.verified ? ' ✓' : ''}${item.deprecated ? ' [已废弃]' : ''} — ${state}`);
  console.log(`      ${[item.source, author ? `@${author}` : null, meta].filter(Boolean).join(' · ')}`);
  console.log(`      ${String(item.description ?? '(no description)').slice(0, 100)}`);
}
