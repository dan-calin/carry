'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const engine = require('../lib/sync-engine');

const LOCAL_ID = 'device-local';
const PEER_ID = 'device-peer';

function makeRoot(parent, name) {
  const root = path.join(parent, name);
  fs.mkdirSync(root, { recursive: true });
  return root;
}

function write(root, rel, value) {
  const file = path.join(root, ...rel.split('/'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, value);
  return file;
}

function stagedFile(root, exchangeId, name, value) {
  return write(root, `.carry/incoming/${exchangeId}/${name}`, value);
}

function userFiles(root) {
  const found = [];
  function walk(directory, relative) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (!relative && entry.name === '.carry') continue;
      const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
      const child = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(child, childRelative);
      else if (entry.isFile()) found.push(childRelative);
    }
  }
  walk(root, '');
  return found.sort();
}

(function main() {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'carry-staged-sync-'));
  try {
    // Production bundle preparation hashes regular files without retaining a
    // base64 copy. The sender receives only a validated disk descriptor.
    const streamPeer = makeRoot(sandbox, 'stream-peer');
    const streamPayload = Buffer.alloc((3 * 1024 * 1024) + 17, 0x5a);
    const streamFile = write(streamPeer, 'large.bin', streamPayload);
    const streaming = engine.buildStreamingBundle(streamPeer, PEER_ID, LOCAL_ID);
    assert.strictEqual(streaming.bundle.data['large.bin'], undefined);
    assert.strictEqual(streaming.fileSources.get('large.bin').file, streamFile);
    assert.strictEqual(streaming.fileSources.get('large.bin').size, streamPayload.length);
    assert.match(streaming.fileSources.get('large.bin').hash, /^[a-f0-9]{64}$/);

    // A completed disk-spooled transfer can apply a regular file and agent
    // memory without retaining either value in bundle.data.
    const local = makeRoot(sandbox, 'valid-local');
    const peer = makeRoot(sandbox, 'valid-peer');
    const payload = Buffer.concat([
      Buffer.from('staged payload\0with binary bytes\n', 'utf8'),
      Buffer.from(Array.from({ length: 256 }, (_, index) => index)),
    ]);
    write(peer, 'nested/payload.bin', payload);
    write(peer, engine.MEMORY_PATH,
      '{"type":"entity","name":"carry/staged-test","entityType":"test","observations":["spooled memory"]}\n');

    const bundle = engine.buildBundle(peer, PEER_ID, LOCAL_ID);
    const stagedPayload = stagedFile(local, 'exchange-valid', 'payload.bin', payload);
    const stagedMemory = bundle.data[engine.MEMORY_PATH];
    delete bundle.data['nested/payload.bin'];
    delete bundle.data[engine.MEMORY_PATH];

    const prepared = engine.prepareIncoming(local, PEER_ID, bundle, LOCAL_ID, {
      stagedFiles: new Map([['nested/payload.bin', stagedPayload]]),
      stagedText: new Map([[engine.MEMORY_PATH, stagedMemory]]),
    });
    assert.strictEqual(prepared.summary.pulled, 1, 'staged regular file is planned as a pull');
    assert.strictEqual(prepared.memoryChanged, true, 'staged agent-memory text is merged');
    assert.deepStrictEqual(fs.readFileSync(path.join(local, 'nested', 'payload.bin')), payload,
      'staged bytes are copied exactly into the project');
    assert.match(fs.readFileSync(path.join(local, ...engine.MEMORY_PATH.split('/')), 'utf8'),
      /carry\/staged-test/, 'staged agent-memory content reaches the local store');
    engine.commit(local, prepared);
    assert.strictEqual(engine.readBaseline(local, PEER_ID).files['nested/payload.bin'],
      bundle.hashes['nested/payload.bin'], 'commit records the staged file in the peer baseline');

    // Integrity validation must finish before any project mutation. This
    // bundle would also add incoming.txt, but its tampered spool is rejected.
    const corruptLocal = makeRoot(sandbox, 'corrupt-local');
    const corruptPeer = makeRoot(sandbox, 'corrupt-peer');
    write(corruptLocal, 'keep.txt', 'must remain untouched');
    write(corruptPeer, 'incoming.txt', 'trusted peer bytes');
    const corruptBundle = engine.buildBundle(corruptPeer, PEER_ID, LOCAL_ID);
    delete corruptBundle.data['incoming.txt'];
    const corruptStage = stagedFile(corruptLocal, 'exchange-corrupt', 'incoming.bin', 'tampered spool bytes');
    assert.throws(() => engine.prepareIncoming(corruptLocal, PEER_ID, corruptBundle, LOCAL_ID, {
      stagedFiles: new Map([['incoming.txt', corruptStage]]),
    }), /integrity check for incoming\.txt/, 'a staged file with the wrong hash fails closed');
    assert.deepStrictEqual(userFiles(corruptLocal), ['keep.txt'],
      'wrong staged bytes do not partially mutate project files');
    assert.strictEqual(fs.readFileSync(path.join(corruptLocal, 'keep.txt'), 'utf8'), 'must remain untouched');

    // Callers cannot point staged metadata at arbitrary files, even when the
    // bytes and advertised hash are otherwise correct.
    const outsideLocal = makeRoot(sandbox, 'outside-local');
    const outsidePeer = makeRoot(sandbox, 'outside-peer');
    const outsideBytes = Buffer.from('correct bytes in the wrong location');
    write(outsidePeer, 'outside.txt', outsideBytes);
    const outsideBundle = engine.buildBundle(outsidePeer, PEER_ID, LOCAL_ID);
    delete outsideBundle.data['outside.txt'];
    const outsideStage = write(outsideLocal, 'not-in-incoming.bin', outsideBytes);
    assert.throws(() => engine.prepareIncoming(outsideLocal, PEER_ID, outsideBundle, LOCAL_ID, {
      stagedFiles: new Map([['outside.txt', outsideStage]]),
    }), /escaped Carry incoming storage/, 'staged paths outside .carry/incoming are rejected');
    assert.deepStrictEqual(userFiles(outsideLocal), ['not-in-incoming.bin'],
      'an escaped staged path is rejected before applying the peer file');

    // The legacy base64 route remains compatible while peers upgrade to the
    // disk-backed transfer protocol at different times.
    const legacyLocal = makeRoot(sandbox, 'legacy-local');
    const legacyPeer = makeRoot(sandbox, 'legacy-peer');
    write(legacyPeer, 'legacy.txt', 'legacy base64 payload');
    const legacyBundle = engine.buildBundle(legacyPeer, PEER_ID, LOCAL_ID);
    const legacyPrepared = engine.prepareIncoming(legacyLocal, PEER_ID, legacyBundle, LOCAL_ID);
    engine.commit(legacyLocal, legacyPrepared);
    assert.strictEqual(fs.readFileSync(path.join(legacyLocal, 'legacy.txt'), 'utf8'), 'legacy base64 payload',
      'legacy in-memory bundles still apply');

    console.log('STAGED SYNC INTEGRATION PASS: disk files, memory text, integrity, containment, and legacy compatibility.');
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
})();
