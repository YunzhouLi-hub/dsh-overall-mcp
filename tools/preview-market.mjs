// tools/preview-market.mjs — render the market exactly as the settings page does.
//
// Talks to a running DSH instance over its real Connection-authenticated HTTP
// surface: exchanges the boot token for the session cookie, then drives
// /api/overall-mcp/catalog + /api/overall-mcp/repo-stats the way client.js does.
//
//   node tools/preview-market.mjs <base-url-with-?token=...> [limit]
import { browseCatalog, fetchRepoStats } from '../lib/catalog.js';

const target = process.argv[2];
const limit = Number(process.argv[3] ?? 12);

/** Mirror of the client's repoKeyOf(). */
function repoKeyOf(item) {
  const m = String(item?.repository ?? '').match(/^https?:\/\/(?:www\.)?github\.com\/([^/\s]+)\/([^/\s#?]+)/i);
  return m ? `${m[1]}/${m[2].replace(/\.git$/i, '')}` : null;
}

const compact = (n) => {
  const v = Number(n) || 0;
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)}k`;
  return String(v);
};

async function viaHttp(url) {
  const base = new URL(url);
  const token = base.searchParams.get('token');
  const origin = base.origin;
  // The boot URL answers 303 with the session cookie; following the redirect
  // would drop it (fetch keeps no cookie jar), so read it off the 303 itself.
  const boot = await fetch(`${origin}/?token=${token}`, { redirect: 'manual' });
  const raw = boot.headers.get('set-cookie');
  if (!raw) throw new Error(`no session cookie from ${origin}/?token=… (HTTP ${boot.status})`);
  const cookie = raw.split(';')[0];
  const post = async (path, body) => {
    const res = await fetch(origin + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify(body ?? {}),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${path} -> HTTP ${res.status} ${text.slice(0, 200)}`);
    return JSON.parse(text);
  };
  const market = await post('/api/overall-mcp/catalog', { limit: 180, refresh: true });
  const repos = [];
  const seen = new Set();
  for (const item of market.items ?? []) {
    const key = repoKeyOf(item);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    repos.push(key);
    if (repos.length >= 30) break;
  }
  const { stats } = repos.length
    ? await post('/api/overall-mcp/repo-stats', { repos })
    : { stats: {} };
  return { market, stats, repos };
}

async function offline() {
  const market = await browseCatalog({ limit: 180 });
  const repos = [];
  const seen = new Set();
  for (const item of market.items) {
    const key = repoKeyOf(item);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    repos.push({ key, owner: key.split('/')[0], repo: key.split('/')[1] });
    if (repos.length >= 30) break;
  }
  const stats = await fetchRepoStats(repos);
  return { market: { ...market, items: market.items.map((i) => ({ ...i, installable: Boolean(i.install), installed: false })) }, stats, repos: repos.map((r) => r.key) };
}

const { market, stats, repos } = target ? await viaHttp(target) : await offline();

console.log(`total ${market.total} · shown ${market.items.length} · per-source ${JSON.stringify(market.counts)}`);
console.log(`errors: ${market.errors.length ? JSON.stringify(market.errors) : 'none'}`);
console.log(`stars enriched for ${Object.keys(stats).length}/${repos.length} repositories\n`);

for (const [i, item] of market.items.slice(0, limit).entries()) {
  const key = repoKeyOf(item);
  const enriched = key ? stats[key] : null;
  const author = enriched?.author ?? item.author;
  const stars = enriched?.stars ?? item.stars;
  const state = item.installed ? '已安装' : item.installable ? '可安装' : '需手动配置';
  const meta = [
    item.version ? `v${item.version}` : null,
    item.transport !== 'unknown' ? item.transport : null,
    typeof item.installs === 'number'
      ? `${compact(item.installs)} ${item.installsLabel ?? '次使用'}${item.installsWindow ? `（${item.installsWindow}）` : ''}`
      : null,
    typeof stars === 'number' ? `★ ${compact(stars)}` : null,
  ].filter(Boolean).join(' · ');
  const tags = [...(item.tags ?? []), ...((enriched?.topics ?? []).slice(0, 3))]
    .filter((t, idx, arr) => t && arr.indexOf(t) === idx).slice(0, 5);

  console.log(`${String(i + 1).padStart(3)}. ${item.title}${item.verified ? ' ✓' : ''}${item.deprecated ? ' [已废弃]' : ''} — ${state}`);
  console.log(`     ${[item.source, author ? `@${author}` : null, meta].filter(Boolean).join(' · ')}`);
  console.log(`     ${String(item.description ?? '(no description)').slice(0, 105)}`);
  if (item.deprecated && item.statusMessage) console.log(`     ⚠ 上游说明：${item.statusMessage}`);
  if (tags.length) console.log(`     [${tags.join('] [')}]`);
  console.log(`     ${item.install ? `install: ${JSON.stringify(item.install).slice(0, 95)}` : `manual: ${item.repository ?? '—'}`}`);
}
