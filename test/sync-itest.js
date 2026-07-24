'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const checkpoints = require('../lib/checkpoints');
const engine = require('../lib/sync-engine');
const manifest = require('../lib/manifest');
const privateState = require('../lib/private-state');
const sync = require('../lib/sync');

function write(root, rel, value) {
  const file = path.join(root, ...rel.split('/'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, value);
}

function read(root, rel) {
  const file = rel.startsWith('.carry/')
    ? privateState.projectFile(root, ...rel.slice('.carry/'.length).split('/'))
    : path.join(root, ...rel.split('/'));
  return fs.readFileSync(file, 'utf8');
}

function round(a, b, aId = 'device-a', bId = 'device-b', syncSourceDeviceId = null) {
  // Capture both snapshots before either side applies changes, matching the
  // real two-process protocol.
  const bundleA = engine.buildBundle(a, aId, bId, syncSourceDeviceId);
  const bundleB = engine.buildBundle(b, bId, aId, syncSourceDeviceId);
  const resultA = engine.prepareIncoming(a, bId, bundleB, aId, { syncSourceDeviceId });
  const resultB = engine.prepareIncoming(b, aId, bundleA, bId, { syncSourceDeviceId });
  engine.commit(a, resultA);
  engine.commit(b, resultB);
  return { resultA, resultB };
}

function allFiles(root) {
  const out = [];
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push(full);
    }
  }
  if (fs.existsSync(root)) walk(root);
  return out;
}

(function main() {
  const a = fs.mkdtempSync(path.join(os.tmpdir(), 'carry-safe-a-'));
  const b = fs.mkdtempSync(path.join(os.tmpdir(), 'carry-safe-b-'));
  try {
    write(a, 'src/app.txt', 'version one');
    let result = round(a, b);
    assert.strictEqual(read(b, 'src/app.txt'), 'version one', 'initial file reaches empty receiver');
    assert.strictEqual(result.resultB.summary.pulled, 1);

    write(b, 'src/app.txt', 'laptop update');
    assert.deepStrictEqual(engine.previewLocalChanges(b, 'device-a'), [{ path: 'src/app.txt', action: 'modified' }]);
    result = round(a, b);
    assert.strictEqual(read(a, 'src/app.txt'), 'laptop update', 'one-device update reaches old copy');
    assert.strictEqual(read(b, 'src/app.txt'), 'laptop update', 'newer source is not overwritten');
    assert.strictEqual(result.resultA.summary.pulled, 1);

    write(a, 'src/app.txt', 'pc edit');
    write(b, 'src/app.txt', 'laptop edit');
    result = round(a, b);
    assert.strictEqual(read(a, 'src/app.txt'), 'pc edit', 'conflict keeps PC file unchanged');
    assert.strictEqual(read(b, 'src/app.txt'), 'laptop edit', 'conflict keeps laptop file unchanged');
    assert.deepStrictEqual(result.resultA.conflicts, ['src/app.txt']);
    assert.deepStrictEqual(result.resultB.conflicts, ['src/app.txt']);
    const copiesA = result.resultA.conflictCopies['src/app.txt'];
    assert.strictEqual(read(a, copiesA.local), 'pc edit', 'conflict stores exact local snapshot for GUI diff');
    assert.strictEqual(read(a, copiesA.remote), 'laptop edit', 'conflict stores exact peer snapshot for GUI diff');

    const resolution = engine.resolveConflict(a, result.resultA.sessionId, 'src/app.txt', 'local');
    assert.strictEqual(resolution.choice, 'local', 'user can explicitly keep this device version');
    assert.strictEqual(read(a, 'src/app.txt'), 'pc edit', 'keeping local leaves the selected bytes in place');
    result = round(a, b);
    assert.strictEqual(result.resultA.conflicts.length, 0);
    assert.strictEqual(result.resultB.conflicts.length, 0);
    assert.strictEqual(read(b, 'src/app.txt'), 'pc edit', 'chosen local version replaces the peer conflict on next sync');

    const bulkPaths = ['bulk/one.txt', 'bulk/remove.txt', 'bulk/two.txt'];
    for (const rel of bulkPaths) write(a, rel, 'shared base');
    round(a, b);
    for (const rel of bulkPaths) write(a, rel, `older PC branch: ${rel}`);
    write(b, 'bulk/one.txt', 'new laptop one');
    write(b, 'bulk/two.txt', 'new laptop two');
    fs.unlinkSync(path.join(b, 'bulk', 'remove.txt'));
    result = round(a, b);
    assert.deepStrictEqual(result.resultA.conflicts, bulkPaths, 'independent project-wide changes remain protected as conflicts');
    const checkpointsBeforeBulk = checkpoints.list(a, 1000).length;
    const bulk = engine.resolveConflicts(
      a,
      bulkPaths.map((rel) => ({ sessionId: result.resultA.sessionId, path: rel })),
      'remote',
    );
    assert.strictEqual(bulk.count, 3, 'multiple conflicts can be resolved in one decision');
    assert.ok(bulk.checkpointId, 'bulk replacement creates a recovery checkpoint');
    assert.ok(bulk.results.every((item) => item.checkpointId === bulk.checkpointId),
      'all bulk choices share one recovery checkpoint');
    assert.strictEqual(checkpoints.list(a, 1000).length, checkpointsBeforeBulk + 1,
      'bulk resolution creates one checkpoint rather than one per file');
    assert.strictEqual(read(a, 'bulk/one.txt'), 'new laptop one');
    assert.strictEqual(read(a, 'bulk/two.txt'), 'new laptop two');
    assert.ok(!fs.existsSync(path.join(a, 'bulk', 'remove.txt')), 'bulk peer choice can safely accept a deletion');
    result = round(a, b);
    assert.strictEqual(result.resultA.conflicts.length, 0);
    assert.strictEqual(result.resultB.conflicts.length, 0);
    assert.strictEqual(read(b, 'bulk/one.txt'), 'new laptop one', 'bulk decision becomes the shared baseline');

    const activeA = fs.mkdtempSync(path.join(os.tmpdir(), 'carry-active-a-'));
    const activeB = fs.mkdtempSync(path.join(os.tmpdir(), 'carry-active-b-'));
    try {
      const activeManifestA = manifest.init(activeA, 'Home PC').manifest;
      const activeManifestB = manifest.init(activeB, 'Work Laptop').manifest;
      manifest.addPeer(activeA, activeManifestB.deviceId, 'Work Laptop', 'relay');
      manifest.addPeer(activeB, activeManifestA.deviceId, 'Home PC', 'relay');
      write(activeA, 'src/authority.txt', 'shared starting point');
      round(activeA, activeB, activeManifestA.deviceId, activeManifestB.deviceId);
      write(activeA, 'src/authority.txt', 'outdated PC branch');
      write(activeB, 'src/authority.txt', 'current laptop work');
      manifest.setActiveDevice(activeB, activeManifestB.deviceId);
      const activeResult = round(activeA, activeB, activeManifestA.deviceId, activeManifestB.deviceId);
      assert.strictEqual(activeResult.resultA.conflicts.length, 0, 'active peer resolves an otherwise ambiguous PC conflict');
      assert.deepStrictEqual(activeResult.resultA.activeResolved, ['src/authority.txt']);
      assert.strictEqual(read(activeA, 'src/authority.txt'), 'current laptop work', 'active laptop is treated as the source of truth');
      assert.strictEqual(read(activeB, 'src/authority.txt'), 'current laptop work');
      assert.strictEqual(manifest.readActiveDevice(activeA).deviceId, activeManifestB.deviceId,
        'active device selection is propagated inside the encrypted sync bundle');
      assert.ok(activeResult.resultA.checkpointId, 'passive device creates a checkpoint before active-device replacement');
      const laptopSelection = manifest.readActiveDevice(activeA);
      const pcSelection = manifest.setActiveDevice(activeA, activeManifestA.deviceId);
      assert.ok(pcSelection.updatedAt > laptopSelection.updatedAt, 'an immediate handoff is recorded as a newer Active Device choice');
      write(activeA, 'src/authority.txt', 'current PC work after handoff');
      write(activeB, 'src/authority.txt', 'stale laptop branch after handoff');
      const returnResult = round(activeA, activeB, activeManifestA.deviceId, activeManifestB.deviceId);
      assert.strictEqual(returnResult.resultB.conflicts.length, 0);
      assert.strictEqual(read(activeB, 'src/authority.txt'), 'current PC work after handoff',
        'Active Device authority can be handed back from laptop to PC');
      assert.strictEqual(manifest.readActiveDevice(activeB).deviceId, activeManifestA.deviceId);
    } finally {
      fs.rmSync(activeA, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      fs.rmSync(activeB, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }

    const directionA = fs.mkdtempSync(path.join(os.tmpdir(), 'carry-direction-a-'));
    const directionB = fs.mkdtempSync(path.join(os.tmpdir(), 'carry-direction-b-'));
    try {
      const directionManifestA = manifest.init(directionA, 'Direction PC').manifest;
      const directionManifestB = manifest.init(directionB, 'Direction Laptop').manifest;
      const directionAId = directionManifestA.deviceId;
      const directionBId = directionManifestB.deviceId;
      manifest.addPeer(directionA, directionBId, 'Direction Laptop', 'lan');
      manifest.addPeer(directionB, directionAId, 'Direction PC', 'lan');
      write(directionA, 'direction.txt', 'shared base');
      round(directionA, directionB, directionAId, directionBId);

      write(directionA, 'direction.txt', 'PC version selected for push');
      write(directionB, 'direction.txt', 'different laptop version');
      write(directionB, 'laptop-only.txt', 'delete me when PC is pushed');
      write(directionA, 'project-tree/src/features/auth/index.js', 'nested source file');
      fs.mkdirSync(path.join(directionA, 'project-tree', 'assets', 'empty', 'deep'), { recursive: true });
      fs.mkdirSync(path.join(directionB, 'obsolete-empty', 'child'), { recursive: true });
      const sourceBundle = engine.buildBundle(directionA, directionAId, directionBId, directionAId);
      const destinationBundle = engine.buildBundle(directionB, directionBId, directionAId, directionAId);
      assert.strictEqual(sourceBundle.metadataOnly, false);
      assert.ok(sourceBundle.data['direction.txt'], 'the selected Push source includes file content');
      assert.strictEqual(destinationBundle.metadataOnly, true);
      assert.ok(!destinationBundle.data['direction.txt'] && !destinationBundle.data['laptop-only.txt'],
        'the Push destination returns hashes without retransmitting its regular-file bytes');
      const pushed = round(directionA, directionB, directionAId, directionBId, directionAId);
      assert.strictEqual(read(directionB, 'direction.txt'), 'PC version selected for push',
        'Push makes the target match this device even after two-sided edits');
      assert.ok(!fs.existsSync(path.join(directionB, 'laptop-only.txt')),
        'Push mirrors source deletions by removing destination-only files');
      assert.strictEqual(read(directionB, 'project-tree/src/features/auth/index.js'), 'nested source file',
        'Push preserves files at arbitrary project-folder depth');
      assert.ok(fs.statSync(path.join(directionB, 'project-tree', 'assets', 'empty', 'deep')).isDirectory(),
        'Push preserves empty nested project folders');
      assert.ok(!fs.existsSync(path.join(directionB, 'obsolete-empty')),
        'Push removes destination-only empty folder trees');
      assert.ok(pushed.resultB.summary.createdDirectories >= 1 && pushed.resultB.summary.deletedDirectories >= 2,
        'Push reports directory-tree changes separately from file updates');
      assert.strictEqual(pushed.resultB.conflicts.length, 0, 'explicit direction needs no per-file conflict prompts');
      assert.ok(pushed.resultB.checkpointId, 'Push receiver gets an automatic safety checkpoint');
      assert.ok(pushed.resultB.actions.some((item) => item.resolution === 'sync-direction'));

      write(directionA, 'direction.txt', 'outdated PC after push');
      write(directionB, 'direction.txt', 'laptop version selected for pull');
      write(directionB, 'from-laptop.txt', 'new laptop file');
      fs.mkdirSync(path.join(directionB, 'pulled-empty', 'nested'), { recursive: true });
      fs.mkdirSync(path.join(directionA, 'local-only-empty', 'nested'), { recursive: true });
      const pulled = round(directionA, directionB, directionAId, directionBId, directionBId);
      assert.strictEqual(read(directionA, 'direction.txt'), 'laptop version selected for pull',
        'Pull makes this device match the selected peer');
      assert.strictEqual(read(directionA, 'from-laptop.txt'), 'new laptop file');
      assert.ok(fs.statSync(path.join(directionA, 'pulled-empty', 'nested')).isDirectory(),
        'Pull preserves empty folders from the selected peer');
      assert.ok(!fs.existsSync(path.join(directionA, 'local-only-empty')),
        'Pull removes empty folders absent from the selected peer');
      assert.ok(pulled.resultA.checkpointId, 'Pull receiver gets an automatic safety checkpoint');

      write(directionA, 'shape', 'source file replaces a folder');
      write(directionB, 'shape/old.txt', 'old nested file');
      round(directionA, directionB, directionAId, directionBId, directionAId);
      assert.strictEqual(read(directionB, 'shape'), 'source file replaces a folder',
        'explicit Push safely replaces a destination folder with a source file');
      fs.unlinkSync(path.join(directionA, 'shape'));
      write(directionA, 'shape/new.txt', 'source folder replaces a file');
      round(directionA, directionB, directionAId, directionBId, directionAId);
      assert.strictEqual(read(directionB, 'shape/new.txt'), 'source folder replaces a file',
        'explicit Push safely replaces a destination file with a source folder');

      const contradictory = engine.buildBundle(directionB, directionBId, directionAId, directionBId);
      assert.throws(() => engine.prepareIncoming(directionA, directionBId, contradictory, directionAId, {
        syncSourceDeviceId: directionAId,
      }), /contradictory sync directions/, 'opposite explicit choices fail closed');
      const invalidSource = engine.buildBundle(directionB, directionBId, directionAId, 'third-device');
      assert.throws(() => engine.prepareIncoming(directionA, directionBId, invalidSource, directionAId),
        /one of the two paired devices/, 'a third device cannot claim authority over the exchange');
    } finally {
      fs.rmSync(directionA, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      fs.rmSync(directionB, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }

    const staleA = fs.mkdtempSync(path.join(os.tmpdir(), 'carry-stale-choice-a-'));
    const staleB = fs.mkdtempSync(path.join(os.tmpdir(), 'carry-stale-choice-b-'));
    try {
      const staleManifestA = manifest.init(staleA, 'Active PC').manifest;
      const staleManifestB = manifest.init(staleB, 'Laptop').manifest;
      manifest.addPeer(staleA, staleManifestB.deviceId, 'Laptop', 'lan');
      manifest.addPeer(staleB, staleManifestA.deviceId, 'Active PC', 'lan');
      write(staleA, 'handoff.txt', 'shared handoff base');
      round(staleA, staleB, staleManifestA.deviceId, staleManifestB.deviceId);
      write(staleA, 'handoff.txt', 'old PC conflict side');
      write(staleB, 'handoff.txt', 'old laptop conflict side');
      const staleConflict = round(staleA, staleB, staleManifestA.deviceId, staleManifestB.deviceId).resultA;
      engine.resolveConflict(staleA, staleConflict.sessionId, 'handoff.txt', 'remote');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);
      manifest.setActiveDevice(staleA, staleManifestA.deviceId);
      write(staleA, 'handoff.txt', 'new work from the newly active PC');
      const staleResult = round(staleA, staleB, staleManifestA.deviceId, staleManifestB.deviceId);
      assert.strictEqual(staleResult.resultA.conflicts.length, 0);
      assert.strictEqual(staleResult.resultB.conflicts.length, 0);
      assert.strictEqual(read(staleB, 'handoff.txt'), 'new work from the newly active PC',
        'a newer Active Device handoff overrides an older unfinished per-file choice');
      assert.ok(!fs.existsSync(privateState.projectFile(staleA, 'resolutions', staleManifestB.deviceId + '.json')),
        'successful active-device sync clears the stale pending choice');
    } finally {
      fs.rmSync(staleA, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      fs.rmSync(staleB, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }

    const guardA = fs.mkdtempSync(path.join(os.tmpdir(), 'carry-bulk-guard-a-'));
    const guardB = fs.mkdtempSync(path.join(os.tmpdir(), 'carry-bulk-guard-b-'));
    try {
      write(guardA, 'one.txt', 'base one');
      write(guardA, 'two.txt', 'base two');
      round(guardA, guardB, 'guard-a', 'guard-b');
      write(guardA, 'one.txt', 'local one');
      write(guardA, 'two.txt', 'local two');
      write(guardB, 'one.txt', 'remote one');
      write(guardB, 'two.txt', 'remote two');
      const guardedConflict = round(guardA, guardB, 'guard-a', 'guard-b').resultA;
      write(guardA, 'two.txt', 'new work after conflict');
      assert.throws(() => engine.resolveConflicts(guardA, guardedConflict.conflicts.map((rel) => ({
        sessionId: guardedConflict.sessionId, path: rel,
      })), 'remote'), /changed after the conflict/);
      assert.strictEqual(read(guardA, 'one.txt'), 'local one',
        'a stale item rejects the complete bulk choice before any selected file is changed');
    } finally {
      fs.rmSync(guardA, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      fs.rmSync(guardB, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }

    fs.unlinkSync(path.join(a, 'src', 'app.txt'));
    result = round(a, b);
    assert.ok(!fs.existsSync(path.join(b, 'src', 'app.txt')), 'intentional deletion reaches peer');
    assert.strictEqual(result.resultB.summary.deletedLocal, 1);
    const backups = allFiles(privateState.projectFile(b, 'backups')).filter((file) => file.endsWith(path.join('src', 'app.txt')));
    assert.ok(backups.length >= 1, 'deleted peer file has a recovery backup');
    assert.strictEqual(fs.readFileSync(backups.at(-1), 'utf8'), 'pc edit');
    const deletionCheckpoint = checkpoints.read(b, result.resultB.checkpointId);
    const deletedEntry = deletionCheckpoint.files.find((item) => item.path === 'src/app.txt');
    const checkpointBlob = checkpoints.blobFile(b, deletedEntry.hash);
    assert.strictEqual(fs.statSync(backups.at(-1)).ino, fs.statSync(checkpointBlob).ino,
      'recovery backup reuses the immutable checkpoint bytes instead of rewriting them');

    write(b, 'notes/new.txt', 'created on laptop');
    round(a, b);
    assert.strictEqual(read(a, 'notes/new.txt'), 'created on laptop', 'new laptop file reaches PC');

    write(a, '.shared-memory/memory.json',
      '{"type":"entity","name":"carry/a","entityType":"note","observations":["from A"]}\n');
    write(b, '.shared-memory/memory.json',
      '{"type":"entity","name":"carry/b","entityType":"note","observations":["from B"]}\n');
    round(a, b);
    const memoryA = read(a, '.shared-memory/memory.json');
    const memoryB = read(b, '.shared-memory/memory.json');
    assert.ok(memoryA.includes('carry/a') && memoryA.includes('carry/b'), 'PC memory is union-merged');
    assert.ok(memoryB.includes('carry/a') && memoryB.includes('carry/b'), 'laptop memory is union-merged');
    const latestMemorySession = engine.listSessions(a, 1)[0];
    assert.deepStrictEqual(latestMemorySession.memory.entities,
      [{ name: 'carry/b', entityType: 'note' }],
      'sync activity records the exact memory item added by the peer');
    assert.deepStrictEqual(latestMemorySession.memory.observations,
      [{ name: 'carry/b', text: 'from B' }],
      'sync activity records the exact observation added by the peer');
    assert.deepStrictEqual(latestMemorySession.memory.relations, [],
      'sync activity records an empty exact relation list when none arrived');

    write(a, '.shared-memory/activity.jsonl', '{"agent":"local-only"}\n');
    write(a, '.shared-memory/memory.json.bak', 'local recovery copy');
    const localOnly = engine.buildBundle(a, 'device-a');
    assert.ok(!localOnly.files.includes('.shared-memory/activity.jsonl'), 'device-local claims are never synced');
    assert.ok(!localOnly.files.includes('.shared-memory/memory.json.bak'), 'device-local memory backup is never synced');

    const traversal = engine.buildBundle(a, 'device-a');
    traversal.files.push('../escape.txt');
    traversal.hashes['../escape.txt'] = '0'.repeat(64);
    assert.throws(() => engine.prepareIncoming(b, 'device-a', traversal, 'device-b'), /escapes the project folder/);

    const directoryTraversal = engine.buildBundle(a, 'device-a');
    directoryTraversal.directories.push('../escape-folder');
    assert.throws(() => engine.validateBundle(directoryTraversal), /escapes the project folder/,
      'directory manifests cannot escape the project root');

    const missingDirectoryParent = engine.buildBundle(a, 'device-a');
    missingDirectoryParent.directories.push('missing-parent/child');
    assert.throws(() => engine.validateBundle(missingDirectoryParent), /missing a parent folder/,
      'directory manifests must describe a complete tree');

    const reserved = engine.buildBundle(a, 'device-a');
    reserved.files.push('.carry/manifest.json');
    reserved.hashes['.carry/manifest.json'] = '0'.repeat(64);
    assert.throws(() => engine.prepareIncoming(b, 'device-a', reserved, 'device-b'), /targets Carry or git metadata/);

    const aliased = engine.buildBundle(a, 'device-a');
    aliased.files.push('Alias.txt', 'alias.txt');
    aliased.hashes['Alias.txt'] = '1'.repeat(64);
    aliased.hashes['alias.txt'] = '2'.repeat(64);
    aliased.data['Alias.txt'] = Buffer.from('one').toString('base64');
    aliased.data['alias.txt'] = Buffer.from('two').toString('base64');
    assert.throws(() => engine.prepareIncoming(b, 'device-a', aliased, 'device-b'), /aliased paths/,
      'case-folded path aliases are rejected before they can overwrite one NTFS file');

    const alternateStream = engine.buildBundle(a, 'device-a');
    alternateStream.files.push('safe.txt::$DATA');
    alternateStream.hashes['safe.txt::$DATA'] = '3'.repeat(64);
    alternateStream.data['safe.txt::$DATA'] = Buffer.from('stream').toString('base64');
    assert.throws(() => engine.prepareIncoming(b, 'device-a', alternateStream, 'device-b'), /Windows-incompatible/,
      'NTFS alternate-data-stream paths are rejected');

    const invalidAuthority = engine.buildBundle(a, 'device-a');
    invalidAuthority.activeDevice = { deviceId: '../attacker', updatedAt: new Date().toISOString(), changeId: '0'.repeat(24) };
    assert.throws(() => engine.prepareIncoming(b, 'device-a', invalidAuthority, 'device-b'), /invalid active device metadata/);

    write(a, 'integrity.txt', 'trusted bytes');
    const fileFolderAlias = engine.buildBundle(a, 'device-a');
    fileFolderAlias.directories.push('integrity.txt');
    assert.throws(() => engine.validateBundle(fileFolderAlias), /aliased file and folder paths/,
      'one portable path cannot be both a file and a folder');
    const legacyBundle = engine.buildBundle(a, 'device-a');
    delete legacyBundle.directories;
    legacyBundle.capabilities = legacyBundle.capabilities.filter((item) => item !== 'directory-manifest-v1');
    assert.strictEqual(engine.validateBundle(legacyBundle).hasDirectoryManifest, false,
      'new clients remain compatible with peers that predate directory manifests');
    const corrupt = engine.buildBundle(a, 'device-a');
    corrupt.data['integrity.txt'] = Buffer.from('tampered bytes').toString('base64');
    assert.throws(() => engine.prepareIncoming(b, 'device-a', corrupt, 'device-b'), /integrity check/);
    assert.ok(!fs.existsSync(path.join(b, 'integrity.txt')), 'corrupt bytes are rejected before writing');

    const driftLocal = fs.mkdtempSync(path.join(os.tmpdir(), 'carry-drift-local-'));
    const driftPeer = fs.mkdtempSync(path.join(os.tmpdir(), 'carry-drift-peer-'));
    try {
      const driftLocalManifest = manifest.init(driftLocal, 'Drift local').manifest;
      const driftPeerManifest = manifest.init(driftPeer, 'Drift peer').manifest;
      manifest.addPeer(driftLocal, driftPeerManifest.deviceId, 'Drift peer', 'relay', {
        address: 'http://127.0.0.1:1/carry', pairCode: 'x'.repeat(43),
      });
      manifest.addPeer(driftPeer, driftLocalManifest.deviceId, 'Drift local', 'relay', {
        address: 'http://127.0.0.1:1/carry', pairCode: 'x'.repeat(43),
      });
      manifest.setActiveDevice(driftLocal, driftLocalManifest.deviceId);
      manifest.setActiveDevice(driftPeer, driftPeerManifest.deviceId);
      write(driftLocal, 'drift.txt', 'old local bytes');
      write(driftPeer, 'drift.txt', 'incoming peer bytes');
      const driftBundle = engine.buildBundle(driftPeer, driftPeerManifest.deviceId,
        driftLocalManifest.deviceId, driftPeerManifest.deviceId);
      const originalCreate = checkpoints.create;
      checkpoints.create = (...args) => {
        const created = originalCreate(...args);
        write(driftLocal, 'drift.txt', 'human edit during preparation');
        return created;
      };
      try {
        assert.throws(() => engine.prepareIncoming(driftLocal, driftPeerManifest.deviceId,
          driftBundle, driftLocalManifest.deviceId, {
          syncSourceDeviceId: driftPeerManifest.deviceId,
        }), /local files changed while Carry prepared/);
      } finally {
        checkpoints.create = originalCreate;
      }
      assert.strictEqual(read(driftLocal, 'drift.txt'), 'human edit during preparation',
        'a file edited during checkpoint preparation is not silently overwritten');
      assert.strictEqual(manifest.readActiveDevice(driftLocal).deviceId, driftLocalManifest.deviceId,
        'a failed preparation does not apply the peer Active Device handoff');
    } finally {
      fs.rmSync(driftLocal, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      fs.rmSync(driftPeer, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }

    const transactionLocal = fs.mkdtempSync(path.join(os.tmpdir(), 'carry-transaction-local-'));
    const transactionPeer = fs.mkdtempSync(path.join(os.tmpdir(), 'carry-transaction-peer-'));
    try {
      write(transactionLocal, 'first/a.txt', 'local first');
      write(transactionLocal, 'second/b.txt', 'local second');
      write(transactionPeer, 'first/a.txt', 'peer first');
      write(transactionPeer, 'second/b.txt', 'peer second');
      const transactionBundle = engine.buildBundle(
        transactionPeer,
        'transaction-peer',
        'transaction-local',
        'transaction-peer',
      );
      const originalMkdir = fs.mkdirSync;
      const injectedDirectory = path.resolve(transactionLocal, 'second');
      let injected = false;
      fs.mkdirSync = function failSecondApply(target, options) {
        if (!injected && path.resolve(target) === injectedDirectory) {
          injected = true;
          const error = new Error('injected second-file apply failure');
          error.code = 'EIO';
          throw error;
        }
        return originalMkdir.call(fs, target, options);
      };
      try {
        assert.throws(
          () => engine.prepareIncoming(
            transactionLocal,
            'transaction-peer',
            transactionBundle,
            'transaction-local',
            { syncSourceDeviceId: 'transaction-peer' },
          ),
          /injected second-file apply failure/,
        );
      } finally {
        fs.mkdirSync = originalMkdir;
      }
      assert.strictEqual(read(transactionLocal, 'first/a.txt'), 'local first',
        'a later apply failure rolls back an earlier replacement');
      assert.strictEqual(read(transactionLocal, 'second/b.txt'), 'local second',
        'the failing destination retains its original bytes');
      const failedTransaction = engine.listSessions(transactionLocal, 1)[0];
      assert.strictEqual(failedTransaction.status, 'failed',
        'an apply failure is recorded as a failed sync session');
      assert.strictEqual(failedTransaction.rollbackSucceeded, true,
        'the failed session records successful automatic rollback');
    } finally {
      fs.rmSync(transactionLocal, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      fs.rmSync(transactionPeer, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }

    const unreadableRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'carry-unreadable-'));
    try {
      fs.mkdirSync(path.join(unreadableRoot, 'locked'));
      const originalReadDir = fs.readdirSync;
      fs.readdirSync = function guardedReadDir(target, options) {
        if (path.resolve(target) === path.resolve(unreadableRoot, 'locked')) {
          const error = new Error('simulated access denied');
          error.code = 'EACCES';
          throw error;
        }
        return originalReadDir.call(fs, target, options);
      };
      try {
        assert.throws(() => sync.listFiles(unreadableRoot), /sync stopped to prevent false deletions/,
          'an unreadable directory fails closed instead of appearing empty');
      } finally {
        fs.readdirSync = originalReadDir;
      }
    } finally {
      fs.rmSync(unreadableRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }

    const automatic = checkpoints.list(b).find((checkpoint) => checkpoint.kind === 'automatic');
    assert.ok(automatic, 'incoming sync changes create an automatic pre-sync checkpoint');

    write(a, 'checkpoint-preview/restore.txt', 'restore this file');
    const stable = checkpoints.create(a, 'Stable local version');
    const blobDir = privateState.projectFile(a, 'checkpoints', 'blobs');
    const blobsBeforeDuplicate = fs.readdirSync(blobDir).length;
    checkpoints.create(a, 'Stable local version copy');
    assert.strictEqual(fs.readdirSync(blobDir).length, blobsBeforeDuplicate, 'unchanged checkpoint file data is deduplicated');
    const stableNote = read(a, 'notes/new.txt');
    write(a, 'notes/new.txt', 'temporary broken edit');
    write(a, 'temporary-only.txt', 'remove me on restore');
    fs.unlinkSync(path.join(a, 'checkpoint-preview', 'restore.txt'));
    const preview = checkpoints.preview(a, stable.checkpointId);
    assert.deepStrictEqual(preview.counts, { restore: 1, replace: 1, delete: 1, total: 3 },
      'checkpoint preview summarizes every file the restore will affect');
    assert.deepStrictEqual(preview.changes.map(({ path: filePath, action }) => ({ path: filePath, action })), [
      { path: 'checkpoint-preview/restore.txt', action: 'restore' },
      { path: 'notes/new.txt', action: 'replace' },
      { path: 'temporary-only.txt', action: 'delete' },
    ], 'checkpoint preview names restored, replaced, and deleted files without listing unchanged files');
    const restored = checkpoints.restore(a, stable.checkpointId);
    assert.strictEqual(read(a, 'notes/new.txt'), stableNote, 'checkpoint restore replaces modified files');
    assert.strictEqual(read(a, 'checkpoint-preview/restore.txt'), 'restore this file', 'checkpoint restore recreates missing files');
    assert.ok(!fs.existsSync(path.join(a, 'temporary-only.txt')), 'checkpoint restore removes files absent from the snapshot');
    assert.ok(restored.safetyCheckpoint && restored.safetyCheckpoint.kind === 'restore-safety', 'restore creates a safety checkpoint first');
    write(a, 'checkpoint-integrity.txt', 'trusted checkpoint data');
    const integrityCheckpoint = checkpoints.create(a, 'Integrity test');
    const integrityMetadata = checkpoints.read(a, integrityCheckpoint.checkpointId);
    const integrityItem = integrityMetadata.files.find((item) => item.path === 'checkpoint-integrity.txt');
    fs.writeFileSync(path.join(blobDir, integrityItem.hash), 'tampered checkpoint data');
    write(a, 'checkpoint-integrity.txt', 'working file remains safe');
    assert.throws(() => checkpoints.restore(a, integrityCheckpoint.checkpointId), /integrity verification/);
    assert.strictEqual(read(a, 'checkpoint-integrity.txt'), 'working file remains safe', 'corrupt checkpoint is rejected before project mutation');

    const sessions = allFiles(privateState.projectFile(a, 'sessions')).filter((file) => file.endsWith('.json'));
    assert.ok(sessions.length >= 5, 'sync sessions are recorded for status/history UI');
    assert.ok(engine.listSessions(a, 2).length === 2, 'session history API is available to the UI');
    const lastCompleted = JSON.parse(fs.readFileSync(sessions.find((file) => JSON.parse(fs.readFileSync(file, 'utf8')).status === 'completed'), 'utf8'));
    assert.strictEqual(lastCompleted.status, 'completed');

    console.log('SAFE SYNC INTEGRATION PASS: updates, conflicts, deletions, backups, memory, and integrity checks.');
  } finally {
    fs.rmSync(a, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    fs.rmSync(b, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
})();
