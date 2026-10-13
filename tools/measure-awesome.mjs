// tools/measure-awesome.mjs — how deep does the community index really go?
//
// The punkpeye/awesome-mcp-servers README carries far more rows than the 200
// the market currently reads; this measures the true depth so the catalog can
// be sized against reality rather than against an arbitrary cap.
import { fetchAwesomeList, fetchAwesomeRemote } from '../lib/catalog.js';

const local = await fetchAwesomeList({ limit: 100000 });
const remote = await fetchAwesomeRemote({ limit: 100000 });

const cats = {};
for (const i of local.items) for (const t of i.tags.slice(0, 1)) cats[t] = (cats[t] ?? 0) + 1;

console.log(`awesome-mcp-servers (local):      ${local.items.length} entries`);
console.log(`awesome-remote-mcp-servers (hosted): ${remote.items.length} entries`);
console.log(`combined community index:         ${local.items.length + remote.items.length}`);
console.log(`\ndistinct local categories: ${Object.keys(cats).length}`);
console.log(Object.entries(cats).sort((a, b) => b[1] - a[1]).slice(0, 30)
  .map(([k, n]) => `  ${String(k).padEnd(26)} ${n}`).join('\n'));

// How many of the local entries also appear in the official registry?
const { browseCatalog } = await import('../lib/catalog.js');
const official = await browseCatalog({ source: 'official-registry', limit: 300 });
const officialRepos = new Set(official.items.map((i) => i.repository).filter(Boolean));
const overlap = local.items.filter((i) => i.repository && officialRepos.has(i.repository));
console.log(`\nofficial registry repos: ${officialRepos.size} · overlapping with the community index: ${overlap.length}`);
