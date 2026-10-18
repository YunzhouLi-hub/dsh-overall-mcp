#!/usr/bin/env node
// tools/survey-install-paths.mjs — 每个目录到底声明了「怎么连」，我们装成了什么。
//
// 这个问题不能靠读代码回答：同一个词在不同上游不是同一件事。官方注册表的
// `packages[].registryType` 与 `remotes[]` 是发布方写的部署事实；Smithery 的
// `remote` 旗标指的是「他们托管」，但真正的连接方式在详情端点的
// `connections[].type` 里；Docker 只有镜像；awesome 系只有一条链接。
// 于是这个探针把每个来源各取一批，按「上游声明的形态 → 我们写下的 install」
// 成对统计，并把不一致的样例点名。

import { CATALOG_SOURCES, browseCatalog } from '../lib/catalog.js';

const pretty = (item) => {
  const install = item.install;
  if (!install) return 'none';
  if (install.transport === 'streamable-http') return `http:${install.url ? 'url' : '—'}`;
  return `${install.transport}:${[install.command, ...(install.args ?? [])].filter(Boolean).join(' ')}`;
};

/** What the upstream itself says about reaching this server. */
function declaredOf(item) {
  const raw = item.raw ?? {};
  switch (item.source) {
    case 'official-registry': {
      const packages = Array.isArray(raw.packages) ? raw.packages : [];
      const remotes = Array.isArray(raw.remotes) ? raw.remotes : [];
      const kinds = packages.map((p) => p?.registryType ?? p?.registry_type).filter(Boolean);
      const transports = packages.map((p) => p?.transport?.type ?? p?.transport).filter(Boolean);
      const envs = packages.flatMap((p) => p?.environmentVariables ?? p?.environment_variables ?? []);
      const required = envs.filter((v) => (v?.isRequired ?? v?.is_required) === true).length;
      if (remotes.length > 0 && packages.length > 0) return `packages[${kinds.join('/')}]+remotes[${remotes[0]?.type ?? '?'}]`;
      if (remotes.length > 0) return `remotes[${remotes[0]?.type ?? '?'}]`;
      if (packages.length > 0) return `packages[${kinds.join('/')}${transports.length ? `,${[...new Set(transports)].join('/')}` : ''}${required ? `,${required}必填` : ''}]`;
      return 'nothing';
    }
    case 'smithery':
      return raw.remote === true ? 'remote=托管' : 'remote=false';
    case 'docker-catalog':
      return 'image';
    case 'awesome-remote':
      return 'listing=url';
    case 'github-mcp':
      return 'listing=repo';
    case 'awesome-list':
      return 'listing=url';
    default:
      return 'other';
  }
}

const buckets = new Map();
const examples = new Map();
for (const source of CATALOG_SOURCES) {
  let out;
  try {
    out = await browseCatalog({ source, perSource: 100, limit: 400 });
  } catch (err) {
    buckets.set(source, { error: String(err?.message ?? err) });
    continue;
  }
  const items = (out.items ?? []).filter((i) => i.source === source);
  const byPair = new Map();
  for (const item of items) {
    const key = `${declaredOf(item)} → ${pretty(item)}`;
    byPair.set(key, (byPair.get(key) ?? 0) + 1);
    if (!examples.has(key)) examples.set(key, `${item.title}`);
  }
  buckets.set(source, { count: items.length, pairs: [...byPair.entries()].sort((a, b) => b[1] - a[1]) });
}

console.log('== 上游声明 → 本插件 install ==');
for (const [source, info] of buckets) {
  if (info.error) {
    console.log(`\n${source}: 读取失败（${info.error}）`);
    continue;
  }
  console.log(`\n${source}  (${info.count} 条)`);
  for (const [pair, count] of info.pairs.slice(0, 8)) {
    console.log(`  ${String(count).padStart(4)}  ${pair}`);
    if (count <= 3) console.log(`        e.g. ${examples.get(pair)}`);
  }
}

// Smithery 的 `remote` 只是「他们托管」。真正的连接方式在详情里：如果
// connections 只给了 http，那 `npx @smithery/cli run` 就是在给一个远程服务
// 强行套 stdio 代理（它会退化成 mcp-remote + OAuth）。
const smithery = (await browseCatalog({ source: 'smithery', perSource: 100, limit: 400 }).catch(() => ({ items: [] }))).items ?? [];
const hosted = smithery.filter((i) => i.raw?.remote === true).slice(0, 8);
if (hosted.length > 0) {
  console.log('\n== Smithery 详情：这些「托管」服务器的连接方式 ==');
  for (const item of hosted) {
    const qualified = item.raw?.qualifiedName ?? item.raw?.name;
    try {
      const res = await fetch(`https://registry.smithery.ai/servers/${encodeURIComponent(qualified)}`);
      const data = await res.json();
      const connections = Array.isArray(data?.connections) ? data.connections : [];
      const types = connections.map((c) => c?.type ?? '?').join(',') || '无';
      const url = connections.map((c) => c?.deploymentUrl).find((u) => typeof u === 'string') ?? '—';
      const required = connections.flatMap((c) => c?.configSchema?.required ?? []);
      console.log(`  ${qualified}  connections[${types}]  deployment=${url}  必填[${[...new Set(required)].join(',') || '—'}]`);
    } catch (err) {
      console.log(`  ${qualified}  详情读取失败：${String(err?.message ?? err)}`);
    }
  }
}
