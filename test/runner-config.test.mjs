import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { validateRunnerConfig } from '../tools/public-runner-config.ts';

// Synthetic settings only; never inherit R2 settings from the test process.
const settings = {
  R2_ACCOUNT_ID: 'syntheticaccount',
  R2_BUCKET: 'synthetic-bucket',
  R2_ACCESS_KEY_ID: 'synthetic-access-key',
  R2_SECRET_ACCESS_KEY: 'synthetic-secret-key',
};

test('publish config accepts all required R2 settings', () => {
  assert.doesNotThrow(() => validateRunnerConfig({ dryRun: false, env: settings }));
});

for (const key of Object.keys(settings)) {
  for (const value of [undefined, '', ' \t\n']) {
    test(`publish config rejects ${key} when ${value === undefined ? 'unset' : value === '' ? 'empty' : 'blank'}`, () => {
      assert.throws(() => validateRunnerConfig({ dryRun: false, env: { ...settings, [key]: value } }), {
        message: `missing-r2-env:${key}`,
      });
    });
  }
}

test('publish config names every missing setting without values', () => {
  assert.throws(() => validateRunnerConfig({ dryRun: false, env: {} }), {
    message: `missing-r2-env:${Object.keys(settings).join(',')}`,
  });
});

test('dry-run config does not read R2 settings', () => {
  const env = new Proxy({}, { get() { throw Error('unexpected-env-read'); } });
  assert.doesNotThrow(() => validateRunnerConfig({ dryRun: true, env }));
});

for (const key of Object.keys(settings)) {
  test(`publish runner fails before network when ${key} is empty`, () => {
    const denyNetwork = 'data:text/javascript,globalThis.fetch%3D()%3D%3E%7Bthrow%20Error(%22unexpected-network%22)%7D';
    const result = spawnSync(process.execPath, ['--experimental-transform-types', '--import', denyNetwork, 'tools/public-runner.ts'], {
      cwd: new URL('..', import.meta.url), encoding: 'utf8', timeout: 30000,
      env: { PATH: process.env.PATH, GITHUB_REPOSITORY: 'woodstockv/taipei-parking-live',
        LIVE_STATUS_PUBLIC_REPOSITORY: 'woodstockv/taipei-parking-live', ...settings, [key]: '' },
    });
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, new RegExp(`Error: missing-r2-env:${key}\\n`));
    assert.doesNotMatch(result.stderr, /unexpected-network/);
    for (const value of Object.values(settings)) assert.ok(!result.stderr.includes(value));
  });
}
