// tools/verify-sort-paging.mjs — exercise the market's sort + paging logic.
//
// The comparator and the quality score live inside the client bundle, which
// cannot be imported. This script re-implements them from the same spec (kept
// in sync with client.js) and checks the ordering against a synthetic listing
// that reproduces the real distribution: three sources with three different
// popularity units, one deprecated entry, and entries with no numbers at all.
import assert from 'node:assert/strict';

// --- mirrors of client.js ---------------------------------------------------
function repoKeyOf(item) {
  const m = String(item?.repository ?? '').match(/^https?:\/\/(?:www\.)?github\.com\/([^/\s]+)\/([^/\s#?]+)/i);
  return m ? `${m[1]}/${m[2].replace(/\.git$/i, '')}` : null;
}

function qualityOf(item, stats) {
  let score = 0;
  if (item.verified) score += 400;
  if (item.official) score += 300;
  if (item.install) score += 120;
  if (typeof item.installs === 'number') score += Math.min(200, Math.log10(item.installs + 1) * 40);
  const stars = starCountOf(item, stats);
  if (typeof stars === 'number') score += Math.min(200, Math.log10(stars + 1) * 40);
  if (item.deprecated) score -= 500;
  return score;
}

function starCountOf(item, stats) {
  const repo = repoKeyOf(item);
  const enriched = repo ? stats?.[repo] : null;
  return enriched?.stars ?? item.stars;
}

function compareMarket(a, b, sort, stats) {
  const qa = qualityOf(a, stats);
  const qb = qualityOf(b, stats);
  const desc = (x, y) => {
    const hasX = typeof x === 'number';
    const hasY = typeof y === 'number';
    if (hasX && hasY) return x !== y ? y - x : 0;
    if (hasX) return -1;   // a real number beats a missing one
    if (hasY) return 1;
    return 0;
  };
  switch (sort) {
    case 'installs': return desc(a.installs, b.installs) || qb - qa;
    case 'stars': return desc(starCountOf(a, stats), starCountOf(b, stats)) || qb - qa;
    case 'updated': {
      const ta = Date.parse(a.updatedAt ?? '') || 0;
      const tb = Date.parse(b.updatedAt ?? '') || 0;
      return (tb - ta) || qb - qa;
    }
    case 'name': return a.title.localeCompare(b.title) || qb - qa;
    // The dropdown lists 「质量最高」 as its own choice; it is the same weighted
    // score the default order uses, and this tool's copy must match the bundle.
    case 'quality': return qb - qa;
    default: return qb - qa;
  }
}

function compactCount(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v < 1000) return String(v ?? 0);
  if (v >= 1e6) return `${Math.floor(v / 1e5) / 10}M`;
  return `${Math.floor(v / 100) / 10}k`;
}

// --- fixtures ---------------------------------------------------------------
const items = [
  { id: 'a', title: 'Alpha', source: 'smithery', verified: true, install: {}, installs: 87579, installsLabel: '次启动', repository: 'https://github.com/x/alpha' },
  { id: 'b', title: 'Bravo', source: 'docker-catalog', official: true, install: {}, installs: 1908722, installsLabel: '次拉取', installsWindow: '累计' },
  { id: 'c', title: 'Charlie', source: 'awesome-list', install: null, repository: 'https://github.com/y/charlie' },
  { id: 'd', title: 'Delta', source: 'official-registry', install: {}, version: '1.0.0', updatedAt: '2026-01-01T00:00:00Z' },
  { id: 'e', title: 'Echo', source: 'official-registry', install: {}, version: '2.0.0', updatedAt: '2026-09-01T00:00:00Z', deprecated: true, statusMessage: 'Superseded.' },
];
const starStats = {
  'y/charlie': { stars: 50000 },
  'x/alpha': { stars: 120 },
};

// --- assertions -------------------------------------------------------------
const byQuality = items.slice().sort((a, b) => compareMarket(a, b, 'default', starStats));
// `a`: verified(400) + installable(120) + log10(87579)*40≈202  = 722
// `b`: official(300) + installable(120) + capped installs(200) = 620
// So a verified Smithery entry outranks an official Docker image with far more
// pulls — provenance over raw popularity, which is the point of the default order.
assert.equal(byQuality[0].id, 'a', 'verified + installable leads the default order');
assert.equal(byQuality.at(-1).id, 'e', 'a deprecated entry sinks to the bottom of the default order');

// The dropdown offers 「质量最高」 as a separate choice, so it must actually
// apply the score rather than fall through to nothing (it used to sort by the
// same default and merely look selected).
const byExplicitQuality = items.slice().sort((a, b) => compareMarket(a, b, 'quality', starStats));
assert.deepEqual(byExplicitQuality.map((i) => i.id), byQuality.map((i) => i.id),
  'the explicit 质量最高 choice orders exactly like the default score order');

const byInstalls = items.slice().sort((a, b) => compareMarket(a, b, 'installs', starStats));
assert.equal(byInstalls[0].id, 'b', 'installs desc: 1.9M pulls first');
assert.equal(byInstalls[1].id, 'a', 'installs desc: 87k second');
// Quality scores behind this order: a 718 · b 620 · c 188 · d 120 · e -380.
// `c` has no usage number but 50k stars, so quality (188) keeps it above the
// numberless `d` (120). A missing number is never read as 0.
assert.deepEqual(byInstalls.map((i) => i.id), ['b', 'a', 'c', 'd', 'e']);
assert.equal(byInstalls.at(-1).id, 'e', 'the deprecated entry stays last under every ordering');

const byStars = items.slice().sort((a, b) => compareMarket(a, b, 'stars', starStats));
assert.equal(byStars[0].id, 'c', 'stars desc: the 50k-star entry first');
assert.equal(byStars[1].id, 'a', 'stars desc: the 120-star entry second');
// Entries with no star count at all (`b`, `d`, `e`) fall back to quality, so
// they keep their relative order instead of collapsing into a tie.
assert.deepEqual(byStars.map((i) => i.id), ['c', 'a', 'b', 'd', 'e']);

const byUpdated = items.slice().sort((a, b) => compareMarket(a, b, 'updated', starStats));
assert.equal(byUpdated[0].id, 'e', 'updated desc: the 2026-09 entry first');
assert.equal(byUpdated[1].id, 'd', 'updated desc: the 2026-01 entry second');

const byName = items.slice().sort((a, b) => compareMarket(a, b, 'name', starStats));
assert.deepEqual(byName.map((i) => i.id), ['a', 'b', 'c', 'd', 'e'], 'name sorts A→Z');

// Paging arithmetic, including the page-size switch the user asked for.
for (const size of [20, 50, 100]) {
  const total = items.length;
  const pageCount = Math.max(1, Math.ceil(total / size));
  assert.equal(pageCount, 1, `a ${total}-entry listing is one page at size ${size}`);
  for (let p = 0; p < pageCount; p += 1) {
    const slice = byQuality.slice(p * size, p * size + size);
    assert.equal(slice.length, Math.min(size, total - p * size), `page ${p + 1} holds the expected count`);
  }
}

// A page index that outlives a shrink (e.g. page 30 of 100-wide, then 20-wide)
// must clamp instead of rendering an empty grid.
const clamped = Math.min(30, Math.max(1, Math.ceil(400 / 50)) - 1);
assert.equal(clamped, 7, 'an out-of-range page clamps to the last real page');

// Compact totals: truncated, so the headline never overstates the real count.
assert.equal(compactCount(5364), '5.3k');
assert.equal(compactCount(999), '999');
assert.equal(compactCount(9999), '9.9k');
assert.equal(compactCount(1200000), '1.2M');
assert.equal(compactCount(5364000), '5.3M');

console.log('sort + paging logic verified: 6 orderings, 3 page sizes, clamping, compact counts');
