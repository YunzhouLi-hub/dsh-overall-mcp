// lib/schema-guard.js — make third-party MCP tool schemas safe for the model API.
//
// Why this exists: some MCP servers ship `pattern` values that a strict regex
// engine rejects. REA v6.1.0 for example publishes `"^[^\\0]*$"`; the DeepSeek
// function-calling validator then rejects the ENTIRE request with
//   Invalid schema for function 'mcp__<server>__<tool>': "^[^\\0]*$" is not a "regex"
// even though every other tool in the request is fine. One bad pattern therefore
// takes down the whole session.
//
// Policy (conservative, intent-preserving where possible):
//   1. `\0`            -> `\x00`  (semantically identical, engine-portable)
//   2. anything else the portable engine would choke on -> drop that `pattern`
//      keyword entirely (the schema becomes looser, never wrong).
//
// Pure functions only; no I/O.

/**
 * Constructs a strict (Rust-regex-style) engine rejects. `\0` is handled first
 * as a rewrite; the rest force the keyword to be dropped.
 */
const UNPORTABLE = /\\[1-9]|\\k<|\(\?<=|\(\?<!|\(\?<[A-Za-z]|\(\?\(|\\p\{|\\(?![0abfnrtvxu.]|$)/;

/** Rewrite the NUL escape to its portable form (not an octal reference). */
function rewriteNulEscape(source) {
  return source.replace(/\\0(?![0-9])/g, '\\x00');
}

/**
 * Repair one regex source string.
 * @returns {{ action: 'keep'|'rewrite'|'drop', value?: string, from: string }}
 */
export function repairRegexSource(source) {
  if (typeof source !== 'string') return { action: 'drop', from: String(source) };
  const rewritten = rewriteNulEscape(source);
  if (rewritten !== source) {
    if (UNPORTABLE.test(rewritten)) return { action: 'drop', from: source };
    return { action: 'rewrite', value: rewritten, from: source };
  }
  if (UNPORTABLE.test(source)) return { action: 'drop', from: source };
  return { action: 'keep', value: source, from: source };
}

/**
 * Deep-clone a JSON schema, repairing every regex keyword it contains.
 * @returns {{ schema: unknown, changes: {path: string, action: string, from: string, to?: string}[] }}
 */
export function sanitizeSchema(schema) {
  const changes = [];
  const walk = (node, path) => {
    if (node === null || typeof node !== 'object') return node;
    if (Array.isArray(node)) return node.map((item, i) => walk(item, `${path}[${i}]`));
    const out = {};
    for (const [key, value] of Object.entries(node)) {
      const here = path ? `${path}.${key}` : key;
      if (key === 'pattern' && typeof value === 'string') {
        const repair = repairRegexSource(value);
        if (repair.action === 'drop') {
          changes.push({ path: here, action: 'dropped', from: repair.from });
          continue; // omit the keyword
        }
        if (repair.action === 'rewrite') {
          changes.push({ path: here, action: 'rewritten', from: repair.from, to: repair.value });
          out[key] = repair.value;
          continue;
        }
        out[key] = value;
        continue;
      }
      if (key === 'patternProperties' && value && typeof value === 'object') {
        const kept = {};
        for (const [source, sub] of Object.entries(value)) {
          const repair = repairRegexSource(source);
          if (repair.action === 'drop') {
            changes.push({ path: `${here}.${source}`, action: 'dropped', from: repair.from });
            continue;
          }
          const finalKey = repair.action === 'rewrite' ? repair.value : source;
          if (repair.action === 'rewrite') {
            changes.push({ path: `${here}.${source}`, action: 'rewritten', from: repair.from, to: repair.value });
          }
          kept[finalKey] = walk(sub, `${here}.${finalKey}`);
        }
        out[key] = kept;
        continue;
      }
      out[key] = walk(value, here);
    }
    return out;
  };
  return { schema: walk(schema, ''), changes };
}

/**
 * Sanitize one tool definition's parameter schema in place (new object).
 * Non-MCP tools and definitions without parameters are returned untouched.
 *
 * @param definition - ToolDefinition about to be registered.
 * @param options.onlyPrefixed - restrict to tool names starting with this (default 'mcp__').
 * @param options.onChange - callback receiving { name, changes } for logging.
 * @returns the original definition, or a copy with repaired parameters.
 */
export function sanitizeToolDefinition(definition, { onlyPrefixed = 'mcp__', onChange } = {}) {
  if (!definition || typeof definition !== 'object') return definition;
  const name = definition.name;
  if (typeof name !== 'string' || !name.startsWith(onlyPrefixed)) return definition;
  if (!definition.parameters || typeof definition.parameters !== 'object') return definition;

  const { schema, changes } = sanitizeSchema(definition.parameters);
  if (changes.length === 0) return definition;
  onChange?.({ name, changes });
  return { ...definition, parameters: schema };
}
