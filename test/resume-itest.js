'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const carry = require('../bin/carry');
const manifest = require('../lib/manifest');
const syncEngine = require('../lib/sync-engine');

const SOURCE_ID = 'resume-source-device';
const TARGET_ID = 'resume-target-device';
const EXCHANGE_ID = '1234567890abcdef12345678';
const rel = 'large-change.bin';
const bytes = Buffer.from('Carry resumable transfer data '.repeat(8));

function bundle() {
  return {
    protocol: 4,
    capabilities: [
      'sync-ack-received',
      'encrypted-binary-v2',
      'directory-manifest-v1',
      'incremental-data-selection-v1',
      'five-gib-transfer-v1',
    ],
    files: [rel],
    directories: [],
    hashes: { [rel]: crypto.createHash('sha256').update(bytes).digest('hex') },
    data: { [rel]: bytes.toString('base64') },
    metadataOnly: false,
    paused: [],
    resolutions: [],
    activeDevice: null,
    syncSourceDeviceId: SOURCE_ID,
    memoryFile: syncEngine.MEMORY_PATH,
  };
}

function transferHarness(root, failAfterFirstChunk, appliedResolve, sentChunkIndexes) {
  let resolveSelection;
  let resolveResume;
  let resolveReadyAck;
  const selection = new Promise((resolve) => { resolveSelection = resolve; });
  const resume = new Promise((resolve) => { resolveResume = resolve; });
  const readyAck = new Promise((resolve) => { resolveReadyAck = resolve; });
  const receiver = carry.makeSyncReceiver(
    root,
    { deviceId: TARGET_ID, name: 'Resume target' },
    SOURCE_ID,
    SOURCE_ID,
    (result) => {
      syncEngine.commit(root, result);
      if (result.incomingTransferStore) result.incomingTransferStore.cleanup();
    },
    (error) => { throw error; },
  );
  const respond = (frame) => {
    if (frame.type === 'sync-bundle-request') resolveSelection(frame);
    else if (frame.type === 'sync-bundle-resume') resolveResume(frame);
    else if (frame.type === 'sync-bundle-ready-ack') resolveReadyAck(frame);
  };
  const onComplete = (error) => {
    if (error) throw error;
    if (appliedResolve) appliedResolve();
  };
  let failed = false;
  const deliver = (frame, payload) => {
    const incoming = payload ? { ...frame, data: Buffer.from(payload) } : frame;
    receiver(incoming, respond, onComplete);
    if (frame.type === 'sync-bundle-chunk') {
      sentChunkIndexes.push(frame.index);
      if (failAfterFirstChunk && !failed) {
        failed = true;
        throw new Error('simulated relay disconnect');
      }
    }
  };
  const channel = {
    peerSupportsBinary: true,
    pendingBytes() { return 0; },
    send(frame) { deliver(frame); },
    sendBinary(frame, payload) { deliver(frame, payload); },
  };
  return {
    receiver,
    send: () => carry.sendBundleOverChannel(channel, SOURCE_ID, bundle(), EXCHANGE_ID, null, {
      fileSources: new Map(),
      supportsBinary: true,
      singleFrameBytes: 128,
      chunkChars: 12,
      textChunkChars: 12,
      waitForSelection: () => selection,
      waitForResume: () => resume,
      waitForReadyAck: () => readyAck,
      waitForPeerSelectionReady: () => Promise.resolve(),
    }),
  };
}

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'carry-resume-'));
  try {
    manifest.init(root, 'Resume target');
    const firstIndexes = [];
    const first = transferHarness(root, true, null, firstIndexes);
    await assert.rejects(first.send(), /simulated relay disconnect/);
    first.receiver.preservePartialTransfers();
    assert.deepStrictEqual(firstIndexes, [0], 'the first attempt durably receives one chunk');

    let resolveApplied;
    const applied = new Promise((resolve) => { resolveApplied = resolve; });
    const resumedIndexes = [];
    const second = transferHarness(root, false, resolveApplied, resumedIndexes);
    await second.send();
    await applied;
    assert.ok(resumedIndexes.length > 0);
    assert.strictEqual(resumedIndexes[0], 1, 'retry resumes after the durable chunk instead of rewriting it');
    assert.ok(!resumedIndexes.includes(0), 'durable chunks are not retransmitted');
    assert.deepStrictEqual(fs.readFileSync(path.join(root, rel)), bytes);

    console.log(`RESUME INTEGRATION PASS: retained 1 chunk and sent only ${resumedIndexes.length} remaining chunk(s).`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
})().catch((error) => {
  console.error('RESUME INTEGRATION FAIL:', error.stack || error.message);
  process.exitCode = 1;
});
