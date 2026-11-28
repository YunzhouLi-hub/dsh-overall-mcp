/**
 * Module-customization hooks for `test/index.test.mjs`.
 *
 * `index.js` imports peer dependencies the harness provides at runtime and this
 * repository does not install (`@deepseek-ai/dsh-tools`,
 * `@deepseek-ai/dsh-mcp-client`, `@deepseek-ai/dsh-llm`). Without a mapping
 * those imports fail before any assertion runs, so the plugin-contract test
 * could not exist at all. Everything else resolves normally.
 */
export async function resolve(specifier, context, next) {
  if (specifier === '@deepseek-ai/dsh-tools') {
    return { url: new URL('./stubs/dsh-tools.mjs', import.meta.url).href, shortCircuit: true };
  }
  if (specifier === '@deepseek-ai/dsh-mcp-client') {
    return { url: new URL('./stubs/dsh-mcp-client.mjs', import.meta.url).href, shortCircuit: true };
  }
  if (specifier === '@deepseek-ai/dsh-llm') {
    return { url: new URL('./stubs/dsh-llm.mjs', import.meta.url).href, shortCircuit: true };
  }
  return next(specifier, context);
}
