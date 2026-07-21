'use strict';

const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const VARIANT_VARIABLES = [
  'CARRY_EXPERIMENTAL_P2P',
  'CARRY_P2P_MIXED_TEST',
  'CARRY_P2P_ERROR_TEST',
  'CARRY_P2P_SELECTION_RACE_TEST',
];

const TESTS = [
  'test/smoke.js',
  'test/ui-itest.js',
  'test/sync-itest.js',
  'test/app-itest.js',
  'test/setup-itest.js',
  'test/lan-itest.js',
  'test/relay-itest.js',
  'test/cloudflare-relay-itest.js',
  'test/remote-itest.js',
  'test/tunnel-itest.js',
  'test/launcher-itest.js',
  'test/security-itest.js',
  'test/firewall-itest.js',
  'test/transfer-store-itest.js',
  'test/large-project-itest.js',
  'test/storage-health-itest.js',
  'test/resume-itest.js',
  'test/staged-sync-itest.js',
  'test/p2p-itest.js',
];

const REMOTE_VARIANTS = [
  ['experimental direct', { CARRY_EXPERIMENTAL_P2P: '1' }],
  ['mixed-version relay fallback', { CARRY_P2P_MIXED_TEST: '1' }],
  ['direct peer-error propagation', { CARRY_P2P_ERROR_TEST: '1' }],
  ['direct/relay selection race', { CARRY_P2P_SELECTION_RACE_TEST: '1' }],
];

function cleanEnvironment(extra) {
  const env = { ...process.env };
  for (const name of VARIANT_VARIABLES) delete env[name];
  return { ...env, ...(extra || {}) };
}

function run(label, file, extraEnvironment) {
  process.stdout.write(`\n=== ${label} ===\n`);
  const result = spawnSync(process.execPath, [path.join(ROOT, file)], {
    cwd: ROOT,
    env: cleanEnvironment(extraEnvironment),
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = result.signal ? `signal ${result.signal}` : `exit code ${result.status}`;
    throw new Error(`${label} failed with ${detail}`);
  }
}

try {
  for (const file of TESTS) run(file, file);
  for (const [label, env] of REMOTE_VARIANTS) run(label, 'test/remote-itest.js', env);
  process.stdout.write('\nALL JAVASCRIPT TESTS PASSED\n');
} catch (error) {
  console.error('\nTEST SUITE FAILED:', error.message);
  process.exitCode = 1;
}
