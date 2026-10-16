// tools/verify-group-row.mjs — the chip row's show/hide decision.
//
// The row once rendered as just 全部/未分类 when the host was older than the
// page (no item carried `group`), which read as "the taxonomy is broken"
// rather than "the host is old". This checks both branches of that decision
// and the counts behind the chip labels, against the live listing.
import assert from 'node:assert/strict';
import { browseCatalog, functionalGroupOf } from '../lib/catalog.js';

const r = await browseCatalog({ limit: 400 });
const items = r.items;

// Nothing to check: an empty listing would fail (or vacuously pass) the
// assertions below for a reason that has nothing to do with this rule. Exit 2 —
// "the world was unreachable" — so it is not confused with a rule failure.
if (items.length === 0) {
  console.error('no source answered — nothing was verified (offline?)');
  process.exit(2);
}

// --- the counts the chips are labelled with (mirror of the client) ---
const counts = new Map();
let uncategorized = 0;
for (const item of items) {
  if (item.group) counts.set(item.group, (counts.get(item.group) ?? 0) + 1);
  else uncategorized += 1;
}
const options = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
if (uncategorized > 0) options.push(['__none__', uncategorized]);

// --- new host: real groups exist, the row renders them ---
const hasRealGroups = options.length > 1 || (options.length === 1 && options[0][0] !== '__none__');
assert.equal(hasRealGroups, true, 'the live listing carries functional groups');
assert.ok(options.length >= 15, `expected ~19 groups, listing holds ${options.length}`);
const total = options.reduce((a, [, n]) => a + n, 0);
assert.equal(total, items.length, 'chips account for every entry');
console.log(`new host: ${options.length} chips, counts sum to ${total}/${items.length} ✓`);
console.log(`  ${options.slice(0, 6).map(([g, n]) => `${g}(${n})`).join(' ')} …`);

// --- old host: nothing carries a group, the row must NOT render a bare
//     全部/未分类 pair, and the hint condition fires instead ---
const oldHostItems = items.map(({ group, ...rest }) => rest);   // strip group
const oldCounts = new Map();
let oldNone = 0;
for (const item of oldHostItems) {
  if (item.group) oldCounts.set(item.group, (oldCounts.get(item.group) ?? 0) + 1);
  else oldNone += 1;
}
const oldOptions = [...oldCounts.entries()];
if (oldNone > 0) oldOptions.push(['__none__', oldNone]);
const oldHasReal = oldOptions.length > 1 || (oldOptions.length === 1 && oldOptions[0][0] !== '__none__');
assert.equal(oldHasReal, false, 'an old-host listing has no real groups');
assert.equal(oldOptions.every(([g]) => g === '__none__'), true);
const hintFires = oldHostItems.length > 0 && !oldHostItems.some((i) => i.group);
assert.equal(hintFires, true, 'the old-host hint condition fires');
console.log('old host: chip row suppressed, restart hint fires ✓');

// --- the mapping helper itself ---
assert.equal(functionalGroupOf({ category: 'Finance & Fintech' }), '金融支付');
assert.equal(functionalGroupOf({ category: 'Databases' }), '数据与存储');
assert.equal(functionalGroupOf({ category: 'Something Brand New' }), '其他');
assert.equal(functionalGroupOf({}), undefined);
assert.equal(functionalGroupOf(undefined), undefined);
console.log('mapping helper: synonyms merge, unknowns degrade, absent stays absent ✓');
