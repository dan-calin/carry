'use strict';

// Smoke test for carry's core, single-machine logic. Run:
//   node test/smoke.js
// It does NOT need a second machine — it exercises the memory merge and the
// file-listing/exclusion rules, which are the parts most likely to regress.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const memory = require('../lib/memoryMerge');
const sync = require('../lib/sync');
const fsx = require('../lib/fsx');
const manifest = require('../lib/manifest');

let passed = 0;
function ok(name, cond) {
  assert.ok(cond, name);
  console.log('  \x1b[32m✓\x1b[0m ' + name);
  passed++;
}

// 1. Memory union-merge keeps both sides' observations.
(function testMerge() {
  const local = {
    entities: [
      { type: 'entity', name: 'proj/a.py', entityType: 'file', observations: ['did X (claude, 2026-07-01)'] },
    ],
    relations: [],
  };
  const incoming = {
    entities: [
      { type: 'entity', name: 'proj/a.py', entityType: 'file', observations: ['did Y (codex, 2026-07-02)'] },
      { type: 'entity', name: 'proj/b.py', entityType: 'file', observations: ['new file (codex)'] },
    ],
    relations: [{ type: 'relation', from: 'proj/a.py', to: 'proj/b.py', relationType: 'depends-on' }],
  };
  const r = memory.mergeStores(local, incoming);
  ok('merge keeps entity a.py', r.store.entities.some((e) => e.name === 'proj/a.py'));
  ok('merge adds entity b.py', r.store.entities.some((e) => e.name === 'proj/b.py'));
  const a = r.store.entities.find((e) => e.name === 'proj/a.py');
  ok('merge unions observations on a.py', a.observations.length === 2);
  ok('merge adds relation', r.store.relations.length === 1);
  ok('merge counts addedObs=2 (b.py new + a.py merged)', r.addedObs === 2);
})();

// 2. Memory merge dedupes identical observations.
(function testDedup() {
  const local = { entities: [{ type: 'entity', name: 'e', entityType: 'f', observations: ['same'] }], relations: [] };
  const incoming = { entities: [{ type: 'entity', name: 'e', entityType: 'f', observations: ['same', 'other'] }], relations: [] };
  const r = memory.mergeStores(local, incoming);
  const e = r.store.entities.find((x) => x.name === 'e');
  ok('dedupe keeps one copy of identical obs', e.observations.length === 2 && r.addedObs === 1);
})();

// 3. listFiles excludes .git and .carry.
(function testListExcludes() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'carry-smoke-'));
  fs.mkdirSync(path.join(tmp, '.git'), { recursive: true });
  fs.mkdirSync(path.join(tmp, '.carry'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'src'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'src', 'x.js'), '1');
  fs.writeFileSync(path.join(tmp, '.git', 'config'), 'x');
  fs.writeFileSync(path.join(tmp, '.carry', 'manifest.json'), '{}');
  const files = sync.listFiles(tmp);
  ok('listFiles excludes .git', !files.some((f) => f.startsWith('.git')));
  ok('listFiles excludes .carry', !files.some((f) => f.startsWith('.carry')));
  ok('listFiles includes src/x.js', files.includes('src/x.js'));
  fs.rmSync(tmp, { recursive: true, force: true });
})();

// 4. manifest init is idempotent and creates .carry.
(function testManifest() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'carry-mani-'));
  const r1 = manifest.init(tmp, 'demo');
  ok('init creates project', r1.created === true);
  ok('init writes deviceId', typeof r1.manifest.deviceId === 'string' && r1.manifest.deviceId.length > 0);
  ok('.carry protects private metadata from ordinary git adds',
    fs.readFileSync(path.join(tmp, '.carry', '.gitignore'), 'utf8') === '*\n!.gitignore\n');
  const r2 = manifest.init(tmp, 'demo');
  ok('re-init is idempotent', r2.created === false && r2.manifest.deviceId === r1.manifest.deviceId);
  ok('findCarryRoot locates it', manifest.findCarryRoot(tmp) === tmp);
  assert.throws(() => manifest.addPeer(tmp, '__proto__', 'attacker', 'lan'), /identity is invalid/);
  ok('special object keys cannot enter peers or the allowlist',
    !manifest.readAllowlist(tmp).includes('__proto__') && manifest.listPeers(tmp).length === 0);
  manifest.addPeer(tmp, 'peer0001', 'Laptop', 'lan', { address: '192.168.1.20', port: 48124, pairCode: 'A'.repeat(32) });
  manifest.setPeerConnection(tmp, 'peer0001', false);
  ok('disconnect keeps the paired device but removes runtime authorization',
    manifest.listPeers(tmp)[0].connectionEnabled === false && !manifest.readAllowlist(tmp).includes('peer0001'));
  manifest.setPeerConnection(tmp, 'peer0001', true);
  ok('reconnect restores the saved peer and runtime authorization',
    manifest.listPeers(tmp)[0].connectionEnabled === true && manifest.readAllowlist(tmp).includes('peer0001'));
  fs.rmSync(tmp, { recursive: true, force: true });
})();

(function testCorruptManifestPreserved() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'carry-corrupt-manifest-'));
  const dir = path.join(tmp, '.carry');
  const file = path.join(dir, 'manifest.json');
  fs.mkdirSync(dir, { recursive: true });
  const corrupt = '{"version":1,"deviceId":"missing-fields"}\n';
  fs.writeFileSync(file, corrupt);
  assert.throws(() => manifest.init(tmp, 'replacement'), /metadata is corrupt/);
  ok('corrupt project metadata is never silently reinitialized', fs.readFileSync(file, 'utf8') === corrupt);
  fs.rmSync(tmp, { recursive: true, force: true });
})();

// 5. Windows scanners/indexers can briefly lock a metadata destination while
// an atomic rename is in progress. Carry retries only those transient errors.
if (process.platform === 'win32') (function testAtomicRenameRetry() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'carry-fsx-'));
  const target = path.join(tmp, 'state.json');
  const originalRename = fs.renameSync;
  let attempts = 0;
  fs.renameSync = (...args) => {
    attempts++;
    if (attempts <= 2) throw Object.assign(new Error('simulated Windows file lock'), { code: 'EPERM' });
    return originalRename(...args);
  };
  try {
    fsx.writeFileAtomic(target, '{"ok":true}\n');
    ok('atomic metadata write retries a transient Windows lock', attempts === 3 && fs.readFileSync(target, 'utf8').includes('true'));
  } finally {
    fs.renameSync = originalRename;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
})();

// 6. Keep the dependency-free native folder picker compatible with the
// Windows PowerShell/.NET Framework compiler included with the OS.
if (process.platform === 'win32') (function testModernFolderPickerCompiles() {
  const childProcess = require('child_process');
  const modulePath = require.resolve('../lib/folder-picker');
  const originalSpawnSync = childProcess.spawnSync;
  let invocation;

  childProcess.spawnSync = (command, args, options) => {
    invocation = { command, args: [...args], options };
    return { status: 0, stdout: '' };
  };
  delete require.cache[modulePath];
  try {
    require('../lib/folder-picker').browse(process.cwd());
  } finally {
    childProcess.spawnSync = originalSpawnSync;
    delete require.cache[modulePath];
  }

  const commandIndex = invocation.args.indexOf('-Command') + 1;
  invocation.args[commandIndex] = invocation.args[commandIndex].replace(
    '$selected = [Carry.NativeFolderPicker]::Pick($env:CARRY_PICKER_INITIAL)',
    '$selected = $null',
  );
  const compiled = originalSpawnSync(invocation.command, invocation.args, invocation.options);
  assert.strictEqual(compiled.status, 0, String(compiled.stderr || 'Native folder picker did not compile'));
  ok('modern Explorer-style folder picker compiles', true);
})();

console.log('\n' + passed + ' checks passed.');
