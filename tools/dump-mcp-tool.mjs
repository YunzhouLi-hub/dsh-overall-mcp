// tools/dump-mcp-tool.mjs — print one MCP tool's raw input schema.
// Usage: node tools/dump-mcp-tool.mjs -- <toolName> -- <command> [args...]
import { spawn } from 'node:child_process';

const argv = process.argv.slice(2);
const toolName = argv[0];
const sep = argv.indexOf('--', 1);
const [command, ...args] = argv.slice(sep + 1);

const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
let buffer = '';
const pending = new Map();
child.stdout.setEncoding('utf8');
child.stdout.on('data', (chunk) => {
  buffer += chunk;
  let i;
  while ((i = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, i).trim();
    buffer = buffer.slice(i + 1);
    if (!line) continue;
    try {
      const msg = JSON.parse(line);
      const r = pending.get(msg.id);
      if (r) { pending.delete(msg.id); r(msg); }
    } catch { /* ignore */ }
  }
});
function send(id, method, params) {
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  return new Promise((resolve, reject) => {
    pending.set(id, resolve);
    setTimeout(() => reject(new Error(`timeout ${method}`)), 120000);
  });
}

try {
  await send(1, 'initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'dump', version: '0' } });
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  const listed = await send(2, 'tools/list', {});
  const tool = (listed.result?.tools ?? []).find((t) => t.name === toolName);
  console.log(tool ? JSON.stringify(tool.inputSchema, null, 2) : `tool not found: ${toolName}`);
} catch (err) {
  console.error(err.message);
  process.exitCode = 1;
} finally {
  child.kill();
}
