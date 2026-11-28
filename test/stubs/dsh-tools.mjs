/**
 * Stand-in for the host-provided `@deepseek-ai/dsh-tools` peer dependency.
 *
 * It is not installed in this repository (the harness supplies it at runtime),
 * so the plugin-contract test cannot import `index.js` without it. `defineTool`
 * is deliberately the identity here: the test asserts the declarations this
 * plugin writes — its tool parameters and descriptions — not whatever the host
 * builder does with them afterwards.
 */
export function defineTool(definition) {
  return definition;
}
