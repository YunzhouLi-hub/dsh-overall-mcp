import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { register } from 'node:module';
import { fileURLToPath } from 'node:url';

register('../test/hooks.mjs', import.meta.url);
const { apply } = await import('../index.js');
assert.equal(typeof apply, 'function', 'The published host must load and export apply');

const cwd = fileURLToPath(new URL('..', import.meta.url));
for (const args of [
  ['--test', 'test/skill-index.test.mjs', 'test/skill-market.test.mjs', 'test/self-update.test.mjs', 'test/updates.test.mjs'],
  ['tools/render-detail.mjs'],
  ['tools/render-market-tab.mjs'],
]) {
  execFileSync(process.execPath, args, { cwd, stdio: 'inherit' });
}
