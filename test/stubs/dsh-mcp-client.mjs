/**
 * Stand-in for the host-provided `@deepseek-ai/dsh-mcp-client` peer dependency
 * (see test/stubs/dsh-tools.mjs). The contract test's fake `ctx.plugin` always
 * throws, so this module is never actually mounted — it only has to exist so
 * the import resolves.
 */
export default function mcpClient() {
  throw new Error('dsh-mcp-client is stubbed in tests');
}
