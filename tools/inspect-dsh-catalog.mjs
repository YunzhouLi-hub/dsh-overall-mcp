// tools/inspect-dsh-catalog.mjs — analyse the official dsh plugin catalog package.
//
// dshmarket does not crawl anything: it reads `plugins.json` out of the
// published npm package `dsh-plugin-catalog` (see lib/catalog-npm.js in
// dshmarket). This script downloads that package the same way and reports what
// it actually contains, so the shape can be reused.
import { gunzipSync } from 'node:zlib';

const PKG = process.argv[2] ?? 'dsh-plugin-catalog';

const meta = await (await fetch(`https://registry.npmjs.org/${PKG}/latest`)).json();
console.log(`package ${PKG}@${meta.version} — ${meta.description}`);
console.log(`tarball ${meta.dist.tarball} (${meta.dist.unpackedSize} bytes unpacked)\n`);

const gz = Buffer.from(await (await fetch(meta.dist.tarball)).arrayBuffer());
const tar = gunzipSync(gz);
let offset = 0;
let catalog = null;
while (offset + 512 <= tar.length) {
  const name = tar.toString('utf8', offset, offset + 100).replace(/\0.*$/s, '');
  if (name === '') break;
  const size = parseInt(tar.toString('ascii', offset + 124, offset + 136).replace(/\0.*$/s, '').trim(), 8);
  const type = String.fromCharCode(tar[offset + 156] ?? 0);
  if ((type === '0' || type === '\0') && name.trim() === 'package/plugins.json') {
    catalog = JSON.parse(tar.subarray(offset + 512, offset + 512 + size).toString('utf8'));
  }
  offset += 512 + Math.ceil(size / 512) * 512;
}
if (!catalog) throw new Error('no plugins.json in the tarball');

const { plugins, categories } = catalog;
console.log(`top-level: name=${catalog.name} url=${catalog.url} updated=${catalog.updated} count=${catalog.count}`);
console.log(`plugins: ${plugins.length} · categories: ${Object.keys(categories).length}\n`);

console.log('--- one plugin record ---');
console.log(JSON.stringify(plugins[0], null, 2));

console.log('\n--- field coverage ---');
const coverage = {};
for (const p of plugins) for (const k of Object.keys(p)) coverage[k] = (coverage[k] ?? 0) + 1;
console.log(JSON.stringify(coverage, null, 1));

console.log('\n--- install kinds ---');
const kinds = {};
for (const p of plugins) {
  const k = p.install?.kind ?? p.kind ?? '(none)';
  kinds[k] = (kinds[k] ?? 0) + 1;
}
console.log(JSON.stringify(kinds, null, 1));

console.log('\n--- category distribution ---');
const used = {};
for (const p of plugins) used[p.category] = (used[p.category] ?? 0) + 1;
console.log(Object.entries(used).sort((a, b) => b[1] - a[1])
  .map(([k, n]) => `${String(k).padEnd(12)} ${categories[k]?.zh ?? '?'}  ${n}`).join('\n'));

console.log('\n--- capability flags (security review surface) ---');
const caps = {};
for (const p of plugins) for (const c of p.capabilities ?? []) caps[c] = (caps[c] ?? 0) + 1;
console.log(Object.entries(caps).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k}  ${n}`).join('\n'));

console.log('\n--- star / download distribution ---');
const stars = plugins.map((p) => p.stars ?? 0).sort((a, b) => a - b);
const dls = plugins.map((p) => p.downloads ?? 0).sort((a, b) => a - b);
const pct = (arr, q) => arr[Math.floor((arr.length - 1) * q)];
console.log(`stars    min ${stars[0]} · p25 ${pct(stars, 0.25)} · median ${pct(stars, 0.5)} · p75 ${pct(stars, 0.75)} · p95 ${pct(stars, 0.95)} · max ${stars.at(-1)}`);
console.log(`downloads min ${dls[0]} · p25 ${pct(dls, 0.25)} · median ${pct(dls, 0.5)} · p75 ${pct(dls, 0.75)} · p95 ${pct(dls, 0.95)} · max ${dls.at(-1)}`);
console.log(`zero-star plugins: ${stars.filter((s) => s === 0).length} (${((stars.filter((s) => s === 0).length / stars.length) * 100).toFixed(1)}%)`);
