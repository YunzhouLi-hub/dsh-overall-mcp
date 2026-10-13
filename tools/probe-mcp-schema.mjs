// tools/probe-mcp-schema.mjs — connect to one stdio MCP server, list its tools,
// and report JSON-Schema constructs the DeepSeek function-calling validator
// rejects (notably `\0` inside `pattern`, which is invalid in Rust-regex-based
// providers and aborts the whole model request as
//   Invalid schema for function 'mcp__<server>__<tool>': "..." is not a "regex").
//
// Usage:
//   node tools/probe-mcp-schema.mjs -- <command> [args...]
// Example (the REA bridge mounted by the global harness patch):
//   node tools/probe-mcp-schema.mjs -- "C:/Program Files/nodejs/node.exe" \
//     "C:/Users/Administrator/AppData/Roaming/npm/node_modules/rea-agents/scripts/rea.mjs" mcp

import { spawn } from 'node:child_process';

const sep = process.argv.indexOf('--');
const [command, ...args] = process.argv.slice(sep + 1);
if (!command) {
  console.error('usage: node tools/probe-mcp-schema.mjs -- <command> [args...]');
  process.exit(2);
}

/** Keywords the provider validates as real regexes. */
const REGEX_KEYWORDS = ['pattern', 'patternProperties'];
/** Escapes a strict (Rust-style) engine rejects but JS tolerates. */
const BAD_ESCAPES = /\\0|\\[1-9]|\\k<|\(\?<|\(\?<=|\(\?!|\(\?\(/;

function scanSchemas(schema, path = '', findings = []) {
  if (schema === null || typeof schema !== 'object') return findings;
  for (const [key, value] of Object.entries(schema)) {
    const here = path ? `${path}.${key}` : key;
    if (REGEX_KEYWORDS.includes(key)) {
      const patterns = key === 'pattern' ? [value] : Object.keys(value ?? {});
      for (const p of patterns) {
        if (typeof p === 'string' && BAD_ESCAPES.test(p)) findings.push({ path: here, pattern: p });
      }
    }
    scanSchemas(value, here, findings);
  }
  return findings;
}

const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
child.stderr.setEncoding('utf8');
let stderr = '';
child.stderr.on('data', (chunk) => { stderr += chunk; });

let buffer = '';
const pending = new Map();
child.stdout.setEncoding('utf8');
child.stdout.on('data', (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    let message;
    try { message = JSON.parse(line); } catch { continue; }
    const resolve = pending.get(message.id);
    if (resolve) { pending.delete(message.id); resolve(message); }
  }
});

function send(id, method, params) {
  const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params });
  child.stdin.write(`${payload}\n`);
  return new Promise((resolve, reject) => {
    pending.set(id, resolve);
    setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 45000);
  });
}

try {
  await send(1, 'initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'schema-probe', version: '0.0.0' },
  });
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  const listed = await send(2, 'tools/list', {});
  const tools = listed.result?.tools ?? [];
  console.log(`tools: ${tools.length}`);

  const offenders = [];
  for (const tool of tools) {
    const findings = scanSchemas(tool.inputSchema);
    if (findings.length) offenders.push({ tool: tool.name, findings });
  }

  if (offenders.length === 0) {
    console.log('no provider-hostile schema constructs found');
  } else {
    console.log(`tools with provider-hostile patterns: ${offenders.length}`);
    for (const entry of offenders) {
      console.log(`  - ${entry.tool}`);
      for (const f of entry.findings) console.log(`      ${f.path} = ${JSON.stringify(f.pattern)}`);
    }
  }
} catch (error) {
  console.error(`probe failed: ${error.message}`);
  if (stderr.trim()) console.error(stderr.trim().split('\n').slice(-5).join('\n'));
  process.exitCode = 1;
} finally {
  child.kill();
}
