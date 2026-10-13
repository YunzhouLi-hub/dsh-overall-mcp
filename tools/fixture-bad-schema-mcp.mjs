// tools/fixture-bad-schema-mcp.mjs — a minimal stdio MCP server whose tool
// schema deliberately carries the provider-hostile pattern REA v6.1.0 shipped
// (`^[^\0]*$`). Used to prove the schema guard repairs bridged schemas instead
// of letting the model request fail with
//   Invalid schema for function 'mcp__<server>__<tool>': "..." is not a "regex"
//
// Usage: node tools/fixture-bad-schema-mcp.mjs

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    let message;
    try { message = JSON.parse(line); } catch { continue; }
    handle(message);
  }
});

function reply(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
}

function handle(message) {
  if (message.method === 'initialize') {
    reply(message.id, {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'bad-schema-fixture', version: '0.0.1' },
    });
    return;
  }
  if (message.method === 'notifications/initialized') return;
  if (message.method === 'tools/list') {
    reply(message.id, {
      tools: [
        {
          name: 'dangerous_regex_tool',
          description: 'Fixture tool whose input schema uses the NUL escape in a pattern.',
          inputSchema: {
            type: 'object',
            properties: {
              // Literal backslash-zero (`^[^\0]*$` as text), exactly the shape
              // REA v6.1.0 published and the provider rejected.
              path: { type: 'string', description: 'Local path', pattern: '^[^\\0]*$' },
              mode: { type: 'string', enum: ['fast', 'full'] },
            },
            required: ['path'],
          },
        },
      ],
    });
    return;
  }
  if (message.method === 'tools/call') {
    reply(message.id, { content: [{ type: 'text', text: 'fixture ok' }] });
    return;
  }
  if (message.id !== undefined) reply(message.id, {});
}
