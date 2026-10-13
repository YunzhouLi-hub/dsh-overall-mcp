// tools/probe-media.mjs — exercise the host's /repo-media route against real
// GitHub repositories, so the card preview strip is verified with the actual
// bytes a browser would fetch rather than a fixture.

const base = 'http://127.0.0.1:3080';
const token = process.argv[2];

const home = await fetch(`${base}/?token=${token}`, { redirect: 'manual' });
const cookie = (home.headers.getSetCookie?.() ?? [])[0]?.split(';')[0];
if (!cookie) { console.error('no session cookie'); process.exit(1); }
console.log('cookie acquired');

const repos = [
  'punkpeye/awesome-mcp-servers',
  'modelcontextprotocol/servers',
  'snag-ai/snag',
  'Gatyh/3dtexel-mcp',
  'smithery-ai/mcp-server-template',
];

const started = Date.now();
const res = await fetch(`${base}/api/overall-mcp/repo-media`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', cookie },
  body: JSON.stringify({ repos }),
});
console.log(`status ${res.status} in ${Date.now() - started}ms`);
const body = await res.json();
for (const repo of repos) {
  const entry = body.media?.[repo];
  if (!entry) { console.log(`  ${repo}: MISSING`); continue; }
  const imgs = entry.images ?? [];
  console.log(`  ${repo}: ${imgs.length} images, og=${entry.og ? 'yes' : 'no'}`);
  for (const im of imgs.slice(0, 4)) console.log(`      ${im.width ?? '?'}x${im.height ?? '?'} ${im.alt || '(no alt)'} — ${im.url.slice(0, 100)}`);
}

// A second call must be served from cache and be fast.
const t2 = Date.now();
const again = await fetch(`${base}/api/overall-mcp/repo-media`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', cookie },
  body: JSON.stringify({ repos }),
});
await again.json();
console.log(`cached second call: ${Date.now() - t2}ms`);
