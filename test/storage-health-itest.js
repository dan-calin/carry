'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const checkpoints = require('../lib/checkpoints');
const manifest = require('../lib/manifest');
const storageHealth = require('../lib/storage-health');

const GIB = BigInt(storageHealth.GIB);
const fakeDisk = (totalGiB, freeGiB) => () => ({
  bsize: 4096n,
  blocks: BigInt(totalGiB) * GIB / 4096n,
  bavail: BigInt(freeGiB) * GIB / 4096n,
});

assert.strictEqual(storageHealth.safetyReserveBytes(40n * GIB), 5n * GIB,
  'small disks retain the 5 GiB minimum reserve');
assert.strictEqual(storageHealth.safetyReserveBytes(100n * GIB), 10n * GIB,
  'ordinary disks retain ten percent');
assert.strictEqual(storageHealth.safetyReserveBytes(1000n * GIB), 20n * GIB,
  'large disks cap the reserve at 20 GiB');
assert.doesNotThrow(() => storageHealth.requireHealthyFreeSpace('.', 5 * storageHealth.GIB, 'Test transfer', {
  statfs: fakeDisk(100, 16),
}));
assert.throws(() => storageHealth.requireHealthyFreeSpace('.', 5 * storageHealth.GIB, 'Test transfer', {
  statfs: fakeDisk(100, 14),
}), /keeping 10\.0 GiB free for SSD and system health/);

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'carry-storage-health-'));
try {
  manifest.init(root, 'Storage health');
  const large = path.join(root, 'bounded-memory.bin');
  const handle = fs.openSync(large, 'w');
  try { fs.ftruncateSync(handle, 20 * 1024 * 1024); }
  finally { fs.closeSync(handle); }

  // A checkpoint must stream/hash a large file instead of reading the whole
  // payload into a JavaScript Buffer. Metadata reads remain permitted.
  const originalRead = fs.readFileSync;
  fs.readFileSync = function guardedRead(file, ...args) {
    if (path.resolve(String(file)) === path.resolve(large)) {
      throw new Error('checkpoint attempted an unbounded whole-file read');
    }
    return originalRead.call(this, file, ...args);
  };
  let first;
  try { first = checkpoints.create(root, 'Bounded checkpoint'); }
  finally { fs.readFileSync = originalRead; }
  assert.strictEqual(first.totalBytes, 20 * 1024 * 1024);

  const blob = checkpoints.blobFile(root, first.hashes.get('bounded-memory.bin'));
  const before = fs.statSync(blob);
  const second = checkpoints.create(root, 'Deduplicated checkpoint');
  const after = fs.statSync(blob);
  assert.strictEqual(second.hashes.get('bounded-memory.bin'), first.hashes.get('bounded-memory.bin'));
  assert.strictEqual(after.size, before.size);
  assert.strictEqual(after.mtimeMs, before.mtimeMs, 'an unchanged checkpoint does not rewrite blob data');

  const tampered = fs.openSync(blob, 'r+');
  try { fs.writeSync(tampered, Buffer.from([0x7f]), 0, 1, 0); }
  finally { fs.closeSync(tampered); }
  assert.strictEqual(fs.statSync(blob).size, before.size, 'the integrity fixture keeps the blob size unchanged');
  assert.throws(() => checkpoints.create(root, 'Reject corrupt deduplicated blob'), /blob storage is corrupt/,
    'a same-size corrupt content-addressed blob is rehashed before reuse');

  console.log('STORAGE HEALTH INTEGRATION PASS: free-space reserve, bounded memory, checkpoint deduplication, and blob integrity.');
} finally {
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
