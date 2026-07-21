'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const carry = require('../bin/carry');
const frameCrypto = require('../lib/crypto');
const manifest = require('../lib/manifest');
const sync = require('../lib/sync');
const syncEngine = require('../lib/sync-engine');

const FILE_COUNT = 4800;
const SOURCE_ID = 'large-project-source';
const TARGET_ID = 'large-project-target';
const EXCHANGE_ID = 'aabbccddeeff001122334455';
const RELAY_FRAME_LIMIT = 2 * 1024 * 1024;
const SECRET = 'x'.repeat(43);
const EMPTY_HASH = crypto.createHash('sha256').update(Buffer.alloc(0)).digest('hex');

function syntheticBundle() {
  const parentParts = [
    'Beta Testing App',
    'venv',
    'Lib',
    'site-packages',
    'complex_dependency',
    'generated_modules',
  ];
  const directories = [];
  for (let count = 1; count <= parentParts.length; count++) {
    directories.push(parentParts.slice(0, count).join('/'));
  }
  const parent = parentParts.join('/');
  const files = [];
  const hashes = Object.create(null);
  const data = Object.create(null);
  for (let index = 0; index < FILE_COUNT; index++) {
    const rel = `${parent}/generated_module_${String(index).padStart(5, '0')}.py`;
    files.push(rel);
    hashes[rel] = EMPTY_HASH;
    data[rel] = '';
  }
  return {
    protocol: 4,
    capabilities: [
      'sync-ack-received',
      'encrypted-binary-v2',
      'directory-manifest-v1',
      'incremental-data-selection-v1',
      'five-gib-transfer-v1',
    ],
    files,
    directories,
    hashes,
    data,
    metadataOnly: false,
    paused: [],
    resolutions: [],
    activeDevice: null,
    syncSourceDeviceId: SOURCE_ID,
    memoryFile: syncEngine.MEMORY_PATH,
  };
}

(async () => {
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'carry-large-project-'));
  try {
    manifest.init(target, 'Large project target');
    const bundle = syntheticBundle();
    const sentTypes = [];
    let metadataChunks = 0;
    let maxWireBytes = 0;
    let appliedResult = null;
    let snapshotKeepalives = 0;
    let settleSelection;
    const selection = new Promise((resolve) => { settleSelection = resolve; });
    let settleResume;
    const resume = new Promise((resolve) => { settleResume = resolve; });
    let settleReadyAck;
    const readyAck = new Promise((resolve) => { settleReadyAck = resolve; });
    let settleApplied;
    let rejectApplied;
    const applied = new Promise((resolve, reject) => {
      settleApplied = resolve;
      rejectApplied = reject;
    });
    const receiver = carry.makeSyncReceiver(
      target,
      { deviceId: TARGET_ID, name: 'Large project target' },
      SOURCE_ID,
      SOURCE_ID,
      (result) => {
        appliedResult = result;
        syncEngine.commit(target, result);
        if (result.incomingTransferStore) result.incomingTransferStore.cleanup();
      },
      rejectApplied,
    );
    const salt = frameCrypto.newSalt();
    const respond = (frame) => {
      if (frame && frame.type === 'sync-bundle-request') settleSelection(frame);
      if (frame && frame.type === 'sync-bundle-resume') settleResume(frame);
      if (frame && frame.type === 'sync-bundle-ready-ack') settleReadyAck(frame);
    };
    const onComplete = (error) => {
      if (error) rejectApplied(error);
      else settleApplied();
    };
    const channel = {
      peerSupportsBinary: true,
      pendingBytes() { return 0; },
      send(frame) {
        sentTypes.push(frame.type);
        if (frame.type === 'sync-status') snapshotKeepalives++;
        const envelope = frameCrypto.encryptFrame(frame, SECRET, salt);
        maxWireBytes = Math.max(maxWireBytes, Buffer.byteLength(JSON.stringify(envelope), 'utf8'));
        receiver(frame, respond, onComplete);
      },
      sendBinary(frame, payload) {
        sentTypes.push(frame.type);
        if (frame.type === 'sync-bundle-metadata-chunk') metadataChunks++;
        const envelope = frameCrypto.encryptBinaryFrame(frame, payload, SECRET, salt);
        maxWireBytes = Math.max(maxWireBytes, envelope.length);
        receiver({ ...frame, data: Buffer.from(payload) }, respond, onComplete);
      },
    };

    await carry.sendBundleOverChannel(channel, SOURCE_ID, bundle, EXCHANGE_ID, null, {
      fileSources: new Map(),
      supportsBinary: true,
      waitForSelection: () => selection,
      waitForResume: () => resume,
      waitForReadyAck: () => readyAck,
      waitForPeerSelectionReady: () => Promise.resolve(),
      snapshotSelected: async () => {
        // Model a slow stable-snapshot preparation without waiting for the
        // production 10-second heartbeat interval.
        await new Promise((resolve) => setTimeout(resolve, 40));
        return new Map();
      },
      snapshotKeepaliveMs: 5,
    });
    await applied;

    assert.ok(metadataChunks > 1, 'the oversized project manifest is sent in bounded chunks');
    assert.ok(sentTypes.includes('sync-bundle-metadata-start') && sentTypes.includes('sync-bundle-metadata-end'));
    assert.ok(sentTypes.includes('sync-bundle-selection'), 'the receiver selects only required data after the manifest');
    assert.ok(snapshotKeepalives > 0, 'slow snapshot preparation keeps the relay peer alive');
    assert.ok(!sentTypes.includes('sync-bundle-start'),
      'an oversized start manifest is never emitted as one relay frame');
    assert.ok(maxWireBytes < RELAY_FRAME_LIMIT,
      `every encrypted frame stays below the relay limit (largest ${maxWireBytes})`);
    assert.strictEqual(appliedResult.summary.pulled, FILE_COUNT);
    assert.strictEqual(sync.listFiles(target).filter((rel) => rel.endsWith('.py')).length, FILE_COUNT);
    assert.ok(fs.existsSync(path.join(target, 'Beta Testing App', 'venv', 'Lib', 'site-packages',
      'complex_dependency', 'generated_modules', 'generated_module_04799.py')));

    let integrityError = null;
    const guardedReceiver = carry.makeSyncReceiver(
      target,
      { deviceId: TARGET_ID, name: 'Large project target' },
      SOURCE_ID,
      SOURCE_ID,
      () => { throw new Error('tampered metadata must not be applied'); },
      (error) => { integrityError = error; },
    );
    const guardedExchange = 'ffeeddccbbaa998877665544';
    const guardedBytes = Buffer.from(JSON.stringify({
      type: 'sync-bundle-start', from: SOURCE_ID, exchangeId: guardedExchange,
      bundle: {}, dataPaths: [], chunkCount: 0, chars: 0,
    }));
    guardedReceiver({
      type: 'sync-bundle-metadata-start', from: SOURCE_ID, exchangeId: guardedExchange,
      metadataBytes: guardedBytes.length, metadataChunks: 1, metadataHash: '0'.repeat(64),
    }, () => {});
    guardedReceiver({
      type: 'sync-bundle-metadata-chunk', from: SOURCE_ID, exchangeId: guardedExchange,
      index: 0, data: guardedBytes,
    }, () => {});
    guardedReceiver({
      type: 'sync-bundle-metadata-end', from: SOURCE_ID, exchangeId: guardedExchange,
    }, () => {});
    assert.match(integrityError && integrityError.message || '', /metadata failed integrity verification/,
      'tampered manifest chunks are rejected before parsing or applying');

    console.log(`LARGE PROJECT INTEGRATION PASS: ${FILE_COUNT} files, ${metadataChunks} manifest chunks, largest encrypted frame ${maxWireBytes} bytes.`);
  } finally {
    fs.rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
})().catch((error) => {
  console.error('LARGE PROJECT INTEGRATION FAIL:', error.stack || error.message);
  process.exitCode = 1;
});
