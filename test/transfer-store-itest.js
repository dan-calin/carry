'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  IncomingTransferStore,
  MAX_EXPECTED_CHUNKS,
  MAX_EXPECTED_CHARS,
  MAX_EXPECTED_BYTES,
  MAX_TRANSFER_FILE_BYTES,
  MAX_CHUNK_BYTES,
  MAX_TEXT_BYTES,
  DEFAULT_MAX_BYTES,
  DEFAULT_AGGREGATE_RESERVATION_BYTES,
  TRANSFER_TTL_MS,
  QUOTA_LOCK_STALE_MS,
} = require('../lib/transfer-store');
const privateState = require('../lib/private-state');

function digest(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function encodedChars(value) {
  return Buffer.isBuffer(value) ? value.toString('base64').length : value.length;
}

function makeRoot(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `carry-transfer-${label}-`));
}

function options(exchangeId, overrides) {
  return {
    exchangeId,
    peerId: 'peer-device-a',
    dataPaths: ['files/payload.bin'],
    textPaths: [],
    expectedChunkCount: 1,
    expectedChars: 4,
    ...overrides,
  };
}

function exchangeDirectory(root, exchangeId) {
  return privateState.projectFile(root, 'incoming', exchangeId.toLowerCase());
}

const roots = [];
try {
  // Fresh binary + exact UTF-16 text spooling/finalization.
  const freshRoot = makeRoot('fresh');
  roots.push(freshRoot);
  const binaryA = Buffer.from([0, 1, 2, 3]);
  const binaryB = Buffer.from('second binary chunk');
  // Split a surrogate pair across chunk boundaries. UTF-8-per-chunk storage
  // would replace both halves, while the UTF-16 spool must round-trip exactly.
  const textA = 'prefix-\ud83d';
  const textB = '\ude00-\u03a9-\0-tail';
  const exactText = textA + textB;
  const freshOptions = options('00112233445566778899aabb', {
    dataPaths: ['files/payload.bin', '.shared-memory/memory.json'],
    textPaths: ['.shared-memory/memory.json'],
    expectedChunkCount: 4,
    expectedChars: encodedChars(binaryA) + encodedChars(binaryB) + textA.length + textB.length,
  });
  const fresh = new IncomingTransferStore(freshRoot, freshOptions);
  fresh.append('files/payload.bin', 0, binaryA);
  fresh.append('files/payload.bin', 1, binaryB.toString('base64'));
  fresh.append('.shared-memory/memory.json', 0, textA);
  fresh.append('.shared-memory/memory.json', 1, textB);
  const freshStatus = fresh.status();
  assert.strictEqual(freshStatus.receivedChunks, 4);
  assert.strictEqual(freshStatus.totalChunks, 4);
  assert.strictEqual(freshStatus.nextIndexes['files/payload.bin'], 2);
  assert.strictEqual(freshStatus.nextIndexes['.shared-memory/memory.json'], 2);
  const completeBinary = Buffer.concat([binaryA, binaryB]);
  const finalized = fresh.finalize(new Map([['files/payload.bin', digest(completeBinary)]]));
  assert.ok(finalized.files.get('files/payload.bin').startsWith(exchangeDirectory(freshRoot, freshOptions.exchangeId)));
  assert.deepStrictEqual(fs.readFileSync(finalized.files.get('files/payload.bin')), completeBinary);
  assert.strictEqual(finalized.text.get('.shared-memory/memory.json'), exactText);
  assert.ok(fs.existsSync(exchangeDirectory(freshRoot, freshOptions.exchangeId)), 'finalize leaves the verified spool for commit/ACK');
  assert.throws(() => fresh.finalize({ 'files/payload.bin': '0'.repeat(64) }), /hash mismatch/);

  // Per-path sequencing and idempotent duplicate semantics.
  const duplicateRoot = makeRoot('duplicate');
  roots.push(duplicateRoot);
  const duplicateOptions = options('111122223333444455556666');
  const duplicate = new IncomingTransferStore(duplicateRoot, duplicateOptions);
  const first = duplicate.append('files/payload.bin', 0, Buffer.from('abc'));
  assert.strictEqual(first.duplicate, false);
  const beforeDuplicateSize = fs.statSync(path.join(exchangeDirectory(duplicateRoot, duplicateOptions.exchangeId), '000000.part')).size;
  const repeated = duplicate.append('files/payload.bin', 0, 'YWJj');
  assert.strictEqual(repeated.duplicate, true, 'same bytes via Buffer/base64 are an idempotent duplicate');
  assert.strictEqual(repeated.receivedChunks, 1);
  assert.strictEqual(fs.statSync(path.join(exchangeDirectory(duplicateRoot, duplicateOptions.exchangeId), '000000.part')).size,
    beforeDuplicateSize, 'duplicate does not append bytes twice');
  assert.throws(() => duplicate.append('files/payload.bin', 0, Buffer.from('abd')), /duplicate conflicts/);
  assert.throws(() => duplicate.append('files/payload.bin', 2, Buffer.from('later')), /out of order/);
  assert.throws(() => duplicate.append('other.bin', 0, Buffer.alloc(0)), /was not declared/);

  // Validate all limits before creating a transfer directory, and before an
  // over-cap append changes either disk or status.
  const capsRoot = makeRoot('caps');
  roots.push(capsRoot);
  const invalidId = '../not-contained-transfer';
  assert.throws(() => new IncomingTransferStore(capsRoot, options(invalidId)), /exchange id/);
  assert.throws(() => new IncomingTransferStore(capsRoot, options('222233334444555566667777', {
    dataPaths: ['safe.bin', 'safe.bin'], expectedChunkCount: 2,
  })), /duplicate path/);
  assert.throws(() => new IncomingTransferStore(capsRoot, options('222233334444555566667778', {
    dataPaths: ['../escape.bin'],
  })), /safe relative path/);
  assert.throws(() => new IncomingTransferStore(capsRoot, options('222233334444555566667779', {
    textPaths: ['not-data.txt'],
  })), /must also be data paths/);
  assert.throws(() => new IncomingTransferStore(capsRoot, options('22223333444455556666777a', {
    expectedChunkCount: MAX_EXPECTED_CHUNKS + 1,
  })), /chunk count/);
  assert.throws(() => new IncomingTransferStore(capsRoot, options('22223333444455556666777b', {
    expectedChars: MAX_EXPECTED_CHARS + 1,
  })), /character count/);
  assert.strictEqual(MAX_TRANSFER_FILE_BYTES, 5 * 1024 * 1024 * 1024,
    'the guarded raw file-data ceiling is exactly 5 GiB');
  assert.throws(() => new IncomingTransferStore(capsRoot, options('22223333444455556666777d', {
    expectedBytes: MAX_EXPECTED_BYTES + 1,
  })), /byte count/);
  const capId = '22223333444455556666777c';
  const capped = new IncomingTransferStore(capsRoot, options(capId, { expectedChars: 8, maxBytes: 2 }));
  const cappedFile = path.join(exchangeDirectory(capsRoot, capId), '000000.part');
  assert.throws(() => capped.append('files/payload.bin', 0, Buffer.from('abc')), /disk byte cap/);
  assert.strictEqual(fs.statSync(cappedFile).size, 0);
  assert.strictEqual(capped.status().receivedChunks, 0);
  assert.throws(() => capped.append('files/payload.bin', 0, Buffer.alloc(MAX_CHUNK_BYTES + 1)), /chunk exceeds/);
  assert.strictEqual(fs.statSync(cappedFile).size, 0);
  assert.ok(!fs.existsSync(exchangeDirectory(capsRoot, invalidId)), 'invalid exchange never allocates outside the store');

  const exactBytesId = '22223333444455556666777e';
  const exactBytes = new IncomingTransferStore(capsRoot, options(exactBytesId, {
    expectedBytes: 2,
    maxBytes: 3,
  }));
  exactBytes.append('files/payload.bin', 0, Buffer.from('abc'));
  assert.throws(() => exactBytes.finalize({ 'files/payload.bin': digest(Buffer.from('abc')) }),
    /byte count does not match/);

  // Text memory is bounded independently before finalization can load it.
  const textCapRoot = makeRoot('text-cap');
  roots.push(textCapRoot);
  const textPiece = 'x'.repeat(1024 * 1024);
  const textCapOptions = options('2a2a33334444555566667777', {
    dataPaths: ['.shared-memory/memory.json'],
    textPaths: ['.shared-memory/memory.json'],
    expectedChunkCount: 9,
    expectedChars: textPiece.length * 9,
    maxBytes: MAX_TEXT_BYTES + (2 * 1024 * 1024),
  });
  const textCapped = new IncomingTransferStore(textCapRoot, textCapOptions);
  for (let index = 0; index < 8; index++) {
    textCapped.append('.shared-memory/memory.json', index, textPiece);
  }
  assert.strictEqual(textCapped.status().receivedChunks, 8);
  assert.throws(
    () => textCapped.append('.shared-memory/memory.json', 8, textPiece),
    /16 MiB safety limit/,
  );
  assert.strictEqual(textCapped.status().receivedChunks, 8, 'over-limit text never reaches the spool');

  // Reservations are aggregate and released by contained cleanup.
  const quotaRoot = makeRoot('quota');
  roots.push(quotaRoot);
  const halfQuota = DEFAULT_AGGREGATE_RESERVATION_BYTES / 2;
  const quotaA = new IncomingTransferStore(quotaRoot, options('2b2b33334444555566667777', { maxBytes: halfQuota }));
  const quotaB = new IncomingTransferStore(quotaRoot, options('2c2c33334444555566667777', { maxBytes: halfQuota }));
  assert.throws(
    () => new IncomingTransferStore(quotaRoot, options('2d2d33334444555566667777', { maxBytes: 1 })),
    /aggregate disk reservation limit/,
  );
  quotaA.cleanup();
  const quotaC = new IncomingTransferStore(quotaRoot, options('2d2d33334444555566667777', { maxBytes: 1 }));
  quotaB.cleanup();
  quotaC.cleanup();

  // An old abandoned reservation is pruned under the same quota lock.
  const staleRoot = makeRoot('stale');
  roots.push(staleRoot);
  const staleId = '2e2e33334444555566667777';
  new IncomingTransferStore(staleRoot, options(staleId, { maxBytes: DEFAULT_MAX_BYTES }));
  const staleDirectory = exchangeDirectory(staleRoot, staleId);
  const staleTime = new Date(Date.now() - TRANSFER_TTL_MS - 60_000);
  fs.utimesSync(path.join(staleDirectory, 'state.json'), staleTime, staleTime);
  fs.utimesSync(staleDirectory, staleTime, staleTime);
  const freshAfterStale = new IncomingTransferStore(
    staleRoot,
    options('2f2f33334444555566667777', { maxBytes: DEFAULT_MAX_BYTES }),
  );
  assert.ok(!fs.existsSync(staleDirectory), 'expired transfer reservation is removed safely');
  freshAfterStale.cleanup();

  // A crash can leave a partly written lock file. Once it is safely stale,
  // it must not permanently block all future transfers.
  const staleLockRoot = makeRoot('stale-lock');
  roots.push(staleLockRoot);
  const staleIncoming = privateState.projectFile(staleLockRoot, 'incoming');
  fs.mkdirSync(staleIncoming, { recursive: true });
  const staleLock = path.join(staleIncoming, '.quota.lock');
  fs.writeFileSync(staleLock, '{incomplete');
  const staleLockTime = new Date(Date.now() - QUOTA_LOCK_STALE_MS - 60_000);
  fs.utimesSync(staleLock, staleLockTime, staleLockTime);
  const recoveredAfterStaleLock = new IncomingTransferStore(
    staleLockRoot,
    options('303033334444555566667777'),
  );
  assert.ok(fs.existsSync(exchangeDirectory(staleLockRoot, '303033334444555566667777')),
    'stale malformed quota lock is recovered safely');
  recoveredAfterStaleLock.cleanup();

  // Restart/resume: state can intentionally lag append writes. A recreated
  // store truncates only the uncheckpointed tail, then resumes sequentially.
  const resumeRoot = makeRoot('resume');
  roots.push(resumeRoot);
  const pieces = [Buffer.from('one'), Buffer.from('two'), Buffer.from('three')];
  const resumeOptions = options('333344445555666677778888', {
    expectedChunkCount: 3,
    expectedChars: pieces.reduce((total, item) => total + encodedChars(item), 0),
    persistEvery: 2,
  });
  let resume = new IncomingTransferStore(resumeRoot, resumeOptions);
  resume.append('files/payload.bin', 0, pieces[0]);
  const resumeFile = path.join(exchangeDirectory(resumeRoot, resumeOptions.exchangeId), '000000.part');
  assert.strictEqual(fs.statSync(resumeFile).size, pieces[0].length, 'first uncheckpointed tail reached disk');
  resume = new IncomingTransferStore(resumeRoot, resumeOptions);
  assert.strictEqual(resume.status().receivedChunks, 0, 'restart rolls back an uncheckpointed chunk');
  assert.strictEqual(fs.statSync(resumeFile).size, 0, 'restart truncates the uncheckpointed tail');
  resume.append('files/payload.bin', 0, pieces[0]);
  resume.append('files/payload.bin', 1, pieces[1]);
  resume.append('files/payload.bin', 2, pieces[2]);
  assert.strictEqual(resume.status().receivedChunks, 3);
  resume = new IncomingTransferStore(resumeRoot, resumeOptions);
  assert.strictEqual(resume.status().receivedChunks, 2, 'only the last uncheckpointed chunk is retried');
  assert.deepStrictEqual(fs.readFileSync(resumeFile), Buffer.concat(pieces.slice(0, 2)));
  resume.append('files/payload.bin', 2, pieces[2]);
  const resumedResult = resume.finalize({ 'files/payload.bin': digest(Buffer.concat(pieces)) });
  assert.deepStrictEqual(fs.readFileSync(resumedResult.files.get('files/payload.bin')), Buffer.concat(pieces));
  const restoredComplete = new IncomingTransferStore(resumeRoot, resumeOptions);
  assert.strictEqual(restoredComplete.status().receivedChunks, 3, 'finalize checkpoints the completed state');

  // Truncated, byte-corrupt, and JSON-corrupt restore all fail closed.
  const truncatedRoot = makeRoot('truncated');
  roots.push(truncatedRoot);
  const truncatedOptions = options('444455556666777788889999');
  const truncated = new IncomingTransferStore(truncatedRoot, truncatedOptions);
  truncated.append('files/payload.bin', 0, Buffer.from('abc'));
  fs.truncateSync(path.join(exchangeDirectory(truncatedRoot, truncatedOptions.exchangeId), '000000.part'), 2);
  assert.throws(() => new IncomingTransferStore(truncatedRoot, truncatedOptions), /truncated/);

  const corruptRoot = makeRoot('corrupt');
  roots.push(corruptRoot);
  const corruptOptions = options('55556666777788889999aaaa');
  const corrupt = new IncomingTransferStore(corruptRoot, corruptOptions);
  corrupt.append('files/payload.bin', 0, Buffer.from('abc'));
  const corruptFile = path.join(exchangeDirectory(corruptRoot, corruptOptions.exchangeId), '000000.part');
  const handle = fs.openSync(corruptFile, 'r+');
  fs.writeSync(handle, Buffer.from('z'), 0, 1, 1);
  fs.closeSync(handle);
  assert.throws(() => new IncomingTransferStore(corruptRoot, corruptOptions), /integrity/);

  const jsonRoot = makeRoot('json');
  roots.push(jsonRoot);
  const jsonOptions = options('6666777788889999aaaabbbb');
  new IncomingTransferStore(jsonRoot, jsonOptions);
  fs.writeFileSync(path.join(exchangeDirectory(jsonRoot, jsonOptions.exchangeId), 'state.json'), '{broken');
  assert.throws(() => new IncomingTransferStore(jsonRoot, jsonOptions), /state is corrupt/);

  // Cleanup removes exactly one validated exchange and leaves its sibling and
  // the incoming parent untouched.
  const cleanupRoot = makeRoot('cleanup');
  roots.push(cleanupRoot);
  const cleanupAOptions = options('777788889999aaaabbbbcccc');
  const cleanupBOptions = options('88889999aaaabbbbccccdddd');
  const cleanupA = new IncomingTransferStore(cleanupRoot, cleanupAOptions);
  const cleanupB = new IncomingTransferStore(cleanupRoot, cleanupBOptions);
  const sentinel = privateState.projectFile(cleanupRoot, 'incoming', 'keep.txt');
  fs.writeFileSync(sentinel, 'keep');
  cleanupA.cleanup();
  assert.ok(!fs.existsSync(exchangeDirectory(cleanupRoot, cleanupAOptions.exchangeId)));
  assert.ok(fs.existsSync(exchangeDirectory(cleanupRoot, cleanupBOptions.exchangeId)));
  assert.strictEqual(fs.readFileSync(sentinel, 'utf8'), 'keep');
  cleanupA.cleanup();
  cleanupB.cleanup();

  console.log('TRANSFER STORE INTEGRATION PASS: disk spooling, restart resume, integrity, caps, Unicode, and contained cleanup.');
} catch (error) {
  console.error('TRANSFER STORE INTEGRATION FAIL:', error.stack || error.message);
  process.exitCode = 1;
} finally {
  for (const root of roots) {
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch { /* test cleanup */ }
  }
}
