// tools/probe-sources.mjs — one-off probe for candidate MCP marketplace APIs.
const targets = [
  ['glama', 'https://glama.ai/api/mcp/v1/servers?first=3'],
  ['glama-v1-servers', 'https://glama.ai/api/mcp/v1/servers'],
  ['official', 'https://registry.modelcontextprotocol.io/v0/servers?limit=2'],
  ['smithery', 'https://registry.smithery.ai/servers?page=1'],
];

for (const [name, url] of targets) {
  const started = Date.now();
  try {
    const res = await fetch(url, { headers: { accept: 'application/json' } });
    const text = await res.text();
    console.log(`== ${name}: ${res.status} in ${Date.now() - started}ms`);
    console.log(`   ${text.slice(0, 400).replace(/\s+/g, ' ')}\n`);
  } catch (err) {
    console.log(`== ${name}: ERR after ${Date.now() - started}ms — ${err.message}\n`);
  }
}
