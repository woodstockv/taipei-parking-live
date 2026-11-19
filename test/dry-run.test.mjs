import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

test('fixture dry run computes the complete plan without network or credentials', () => {
  const denyNetwork = 'data:text/javascript,globalThis.fetch%3D()%3D%3E%7Bthrow%20Error(%22unexpected-network%22)%7D';
  const result = spawnSync(process.execPath, ['--experimental-transform-types', '--import', denyNetwork, 'tools/public-runner.ts', '--dry-run'], {
    cwd: new URL('..', import.meta.url), encoding: 'utf8', timeout: 30000, env: { PATH: process.env.PATH },
  });
  assert.equal(result.status, 0, result.stderr);
  const plan = JSON.parse(result.stdout);
  assert.equal(plan.geometryRows, 51536);
  assert.equal(plan.computedManifests, 1);
  assert.equal(plan.computedShards, 32);
  assert.equal(plan.actualClassA, 0);
  assert.equal(plan.actualClassB, 0);
  assert.equal(plan.actualPut, 0);
  assert.equal(plan.actualDelete, 0);
});
