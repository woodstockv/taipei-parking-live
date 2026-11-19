import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const workflow = readFileSync(new URL('../.github/workflows/live-parking-status.yml', import.meta.url), 'utf8');

test('publish workflow gets all required R2 settings from Actions secrets', () => {
  for (const key of ['R2_ACCOUNT_ID', 'R2_BUCKET', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY']) {
    assert.match(workflow, new RegExp(`^          ${key}: \\$\\{\\{ secrets\\.${key} \\}\\}$`, 'm'));
  }
  assert.doesNotMatch(workflow, /\bvars\.R2_/);
});
