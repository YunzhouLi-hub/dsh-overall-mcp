// test/schema-guard.test.mjs — pure-logic tests for lib/schema-guard.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { repairRegexSource, sanitizeSchema, sanitizeToolDefinition } from '../lib/schema-guard.js';

test('repairRegexSource rewrites the NUL escape', () => {
  const r = repairRegexSource('^[^\\0]*$');
  assert.equal(r.action, 'rewrite');
  assert.equal(r.value, '^[^\\x00]*$');
});

test('repairRegexSource keeps portable patterns and drops unportable ones', () => {
  assert.equal(repairRegexSource('^[A-Za-z0-9_-]{1,32}$').action, 'keep');
  assert.equal(repairRegexSource('(?<=a)b').action, 'drop');
  assert.equal(repairRegexSource('\\1').action, 'drop');
  // a NUL escape next to another unportable construct is dropped, not rewritten
  assert.equal(repairRegexSource('(?<=a)\\0').action, 'drop');
});

test('sanitizeSchema repairs nested patterns and reports every change', () => {
  const schema = {
    type: 'object',
    properties: {
      path: { type: 'string', pattern: '^[^\\0]*$' },
      nested: {
        type: 'array',
        items: { type: 'string', pattern: '(?<=x)y' },
      },
      fine: { type: 'string', pattern: '^ok$' },
    },
    required: ['path'],
  };
  const { schema: out, changes } = sanitizeSchema(schema);
  assert.equal(out.properties.path.pattern, '^[^\\x00]*$');
  assert.equal(out.properties.nested.items.pattern, undefined);
  assert.equal(out.properties.fine.pattern, '^ok$');
  assert.deepEqual(out.required, ['path']);
  assert.equal(changes.length, 2);
  assert.equal(changes[0].action, 'rewritten');
  assert.equal(changes[1].action, 'dropped');
  // the input object is not mutated
  assert.equal(schema.properties.path.pattern, '^[^\\0]*$');
});

test('sanitizeSchema handles patternProperties keys', () => {
  const { schema: out, changes } = sanitizeSchema({
    type: 'object',
    patternProperties: { '^[^\\0]*$': { type: 'string' } },
  });
  assert.deepEqual(Object.keys(out.patternProperties), ['^[^\\x00]*$']);
  assert.equal(changes[0].action, 'rewritten');
});

test('sanitizeToolDefinition only touches mcp__ tools with parameters', () => {
  const dirty = { type: 'object', properties: { a: { type: 'string', pattern: '^[^\\0]*$' } } };
  const changes = [];
  const patched = sanitizeToolDefinition(
    { name: 'mcp__rea-om__analyze', parameters: dirty, execute: () => {} },
    { onChange: (c) => changes.push(c) },
  );
  assert.equal(patched.parameters.properties.a.pattern, '^[^\\x00]*$');
  assert.equal(changes.length, 1);
  assert.equal(changes[0].name, 'mcp__rea-om__analyze');

  const own = { name: 'overall_mcp_scan', parameters: dirty };
  assert.equal(sanitizeToolDefinition(own), own);
  const noParams = { name: 'mcp__x__y' };
  assert.equal(sanitizeToolDefinition(noParams), noParams);
  // clean schema returns the same object (no needless copies)
  const clean = { name: 'mcp__x__y', parameters: { type: 'object', properties: { a: { type: 'string' } } } };
  assert.equal(sanitizeToolDefinition(clean), clean);
});
