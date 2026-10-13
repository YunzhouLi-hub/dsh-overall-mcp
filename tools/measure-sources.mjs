// tools/measure-sources.mjs — how many usable entries each live source really has.
import { fetchAwesomeList, fetchAwesomeRemote, fetchOfficialRegistry } from '../lib/catalog.js';

const [local, remote] = await Promise.all([
  fetchAwesomeList({ limit: 5000 }),
  fetchAwesomeRemote({ limit: 5000 }),
]);

for (const [label, r] of [['awesome-list (local servers)', local], ['awesome-remote (hosted endpoints)', remote]]) {
  const withDesc = r.items.filter((i) => (i.description ?? '').length > 10).length;
  const withRepo = r.items.filter((i) => i.repository).length;
  console.log(`${label}: ${r.items.length} entries · ${withDesc} with a real description · ${withRepo} with a repository`);
}

// Official registry: how many *distinct servers* are behind the version pages.
let cursor = null;
const versions = new Set();
const servers = new Map();
for (let i = 0; i < 12; i += 1) {
  const { items, nextCursor } = await fetchOfficialRegistry({ limit: 100, cursor });
  for (const item of items) {
    versions.add(item.id);
    if (!servers.has(item.title)) servers.set(item.title, item);
  }
  if (!nextCursor) break;
  cursor = nextCursor;
}
console.log(`official registry: ${versions.size} version records · ${servers.size} distinct servers (12 pages probed)`);
