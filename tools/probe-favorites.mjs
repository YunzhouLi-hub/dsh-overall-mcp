// tools/_live-fav.mjs — round-trip the host favourites route against a live
// web-profile DSH: session cookie, one catalog read, toggle a favourite, read
// the listing back and confirm the flag stuck.
const base = process.argv[2];
const token = process.argv[3];
const root = `${base}/api/overall-mcp`;

const boot = await fetch(`${base}/?token=${token}`, { redirect: 'manual' });
const cookie = (boot.headers.getSetCookie?.() ?? [])[0]?.split(';')[0];
if (!cookie) throw new Error(`no session cookie (status ${boot.status})`);

async function call(path, body) {
  const res = await fetch(root + path, {
    method: body ? 'POST' : 'GET',
    headers: { cookie, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text.slice(0, 200); }
  return { status: res.status, json };
}

const cat = await call('/catalog?source=official-registry&limit=5');
console.log('catalog status', cat.status, 'total', cat.json?.total, 'items', cat.json?.items?.length);
const target = cat.json?.items?.[0];
if (!target) throw new Error('no catalog items');
console.log('target:', target.source, target.id, target.title, 'favorite =', target.favorite);

const on = await call('/favorite', { key: `${target.source}:${target.id}`, on: true });
console.log('favorite on ->', on.status, JSON.stringify(on.json).slice(0, 160));
const after = await call(`/catalog?source=official-registry&limit=5`);
const again = after.json?.items?.find((i) => i.id === target.id && i.source === target.source);
console.log('after toggle, favorite =', again?.favorite);

const off = await call('/favorite', { key: `${target.source}:${target.id}`, on: false });
console.log('favorite off ->', off.status, JSON.stringify(off.json).slice(0, 160));

const servers = await call('/servers');
console.log('servers status', servers.status, 'count', servers.json?.servers?.length);
const favs = await call('/favorites');
console.log('favorites ->', favs.status, JSON.stringify(favs.json).slice(0, 200));
