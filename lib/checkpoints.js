'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { writeFileAtomic, copyFileAtomic } = require('./fsx');
const storageHealth = require('./storage-health');
const sync = require('./sync');

const CHECKPOINT_VERSION = 1;
const CHECKPOINT_ID = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[a-f0-9]{8}$/i;
const HASH = /^[a-f0-9]{64}$/i;

function checkpointRoot(root) {
  return path.join(root, '.carry', 'checkpoints');
}

function snapshotsDir(root) {
  return path.join(checkpointRoot(root), 'snapshots');
}

function blobsDir(root) {
  return path.join(checkpointRoot(root), 'blobs');
}

function checkpointFile(root, checkpointId) {
  if (!CHECKPOINT_ID.test(String(checkpointId || ''))) throw new Error('checkpoint id is invalid');
  return path.join(snapshotsDir(root), checkpointId + '.json');
}

function safeRelativePath(value) {
  if (typeof value !== 'string' || !value || value.includes('\0') || value.includes('\\')) {
    throw new Error('checkpoint contains an invalid file path');
  }
  if (path.posix.isAbsolute(value) || /^[a-zA-Z]:/.test(value)) throw new Error('checkpoint contains an absolute file path');
  const normalized = path.posix.normalize(value);
  if (normalized !== value || normalized === '.' || normalized.startsWith('../') || normalized.includes('/../')) {
    throw new Error('checkpoint file path escapes the project folder');
  }
  const parts = value.toLowerCase().split('/');
  if (parts.includes('.carry') || parts.includes('.git')) throw new Error('checkpoint targets private project metadata');
  sync.validatePortablePath(value, 'checkpoint file');
  return value;
}

function projectFile(root, rel) {
  safeRelativePath(rel);
  let current = path.resolve(root);
  const parts = rel.split('/');
  for (let index = 0; index < parts.length; index++) {
    current = path.join(current, parts[index]);
    if (!fs.existsSync(current)) continue;
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) throw new Error('checkpoint path crosses a symbolic link: ' + rel);
    if (index < parts.length - 1 && !stat.isDirectory()) throw new Error('checkpoint path crosses a non-directory: ' + rel);
    if (index === parts.length - 1 && !stat.isFile()) throw new Error('checkpoint cannot replace a non-file path: ' + rel);
  }
  return current;
}

function normalizeName(value, fallback) {
  const name = String(value || fallback || '').trim().replace(/\s+/g, ' ');
  if (!name || name.length > 80 || /[\r\n\0]/.test(name)) throw new Error('checkpoint name must be between 1 and 80 characters');
  return name;
}

function checkpointId() {
  return new Date().toISOString().replace(/[:.]/g, '-') + '-' + crypto.randomBytes(4).toString('hex');
}

function hashFile(file) {
  const hash = crypto.createHash('sha256');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  const fd = fs.openSync(file, 'r');
  try {
    let offset = 0;
    let read;
    do {
      read = fs.readSync(fd, buffer, 0, buffer.length, offset);
      if (read) hash.update(buffer.subarray(0, read));
      offset += read;
    } while (read);
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

function verifiedBlobFile(root, hashValue, expectedBytes) {
  const hash = String(hashValue || '').toLowerCase();
  if (!HASH.test(hash) || !Number.isSafeInteger(expectedBytes) || expectedBytes < 0) {
    throw new Error('checkpoint blob metadata is invalid');
  }
  const blob = path.join(blobsDir(root), hash);
  if (!fs.existsSync(blob)) throw new Error('checkpoint blob storage is corrupt');
  const stat = fs.lstatSync(blob);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== expectedBytes || hashFile(blob) !== hash) {
    throw new Error('checkpoint blob storage is corrupt');
  }
  return blob;
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeFileAtomic(file, JSON.stringify(value, null, 2) + '\n');
}

function publicCheckpoint(checkpoint) {
  return {
    checkpointId: checkpoint.checkpointId,
    name: checkpoint.name,
    kind: checkpoint.kind,
    createdAt: checkpoint.createdAt,
    fileCount: checkpoint.files.length,
    totalBytes: checkpoint.totalBytes,
    sourcePeerId: checkpoint.sourcePeerId || null,
    sourceCheckpointId: checkpoint.sourceCheckpointId || null,
  };
}

function validateCheckpoint(value) {
  if (!value || value.version !== CHECKPOINT_VERSION || !CHECKPOINT_ID.test(String(value.checkpointId || '')) ||
      !Array.isArray(value.files) || typeof value.name !== 'string') {
    throw new Error('checkpoint metadata is corrupt');
  }
  const seen = new Set();
  let totalBytes = 0;
  const files = value.files.map((item) => {
    const rel = safeRelativePath(item && item.path);
    const portableKey = sync.portablePathKey(rel);
    const hash = String(item && item.hash || '').toLowerCase();
    const bytes = Number(item && item.bytes);
    if (seen.has(portableKey) || !HASH.test(hash) || !Number.isSafeInteger(bytes) || bytes < 0) {
      throw new Error('checkpoint file metadata is corrupt');
    }
    seen.add(portableKey);
    totalBytes += bytes;
    if (!Number.isSafeInteger(totalBytes)) throw new Error('checkpoint size is invalid');
    return { path: rel, hash, bytes };
  });
  return { ...value, files, totalBytes };
}

function read(root, checkpointIdValue) {
  const file = checkpointFile(root, checkpointIdValue);
  if (!fs.existsSync(file)) throw new Error('checkpoint was not found');
  let value;
  try { value = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { throw new Error('checkpoint metadata is corrupt'); }
  const checkpoint = validateCheckpoint(value);
  if (checkpoint.checkpointId !== checkpointIdValue) throw new Error('checkpoint identity does not match its file');
  return checkpoint;
}

function list(root, limit) {
  const dir = snapshotsDir(root);
  if (!fs.existsSync(dir)) return [];
  const checkpoints = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    try {
      const checkpoint = validateCheckpoint(JSON.parse(fs.readFileSync(path.join(dir, entry.name), 'utf8')));
      checkpoints.push(publicCheckpoint(checkpoint));
    } catch { /* ignore an incomplete local checkpoint record */ }
  }
  checkpoints.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  const count = Number.isInteger(limit) && limit >= 0 ? limit : 100;
  return checkpoints.slice(0, count);
}

function create(root, name, options) {
  options = options || {};
  const createdAt = new Date().toISOString();
  const id = checkpointId();
  const files = [];
  const hashes = new Map();
  const missingBlobs = new Map();
  const verifiedExistingBlobs = new Set();
  let totalBytes = 0;
  fs.mkdirSync(blobsDir(root), { recursive: true });

  for (const relValue of sync.listFiles(root).sort()) {
    const rel = safeRelativePath(relValue);
    const source = projectFile(root, rel);
    const before = fs.lstatSync(source);
    if (!before.isFile() || before.isSymbolicLink()) throw new Error('checkpoint source is not a regular file: ' + rel);
    const hash = hashFile(source);
    const after = fs.lstatSync(source);
    if (!after.isFile() || after.isSymbolicLink() || before.size !== after.size || before.mtimeMs !== after.mtimeMs ||
        before.dev !== after.dev || before.ino !== after.ino) {
      throw new Error('project file changed while Carry prepared the checkpoint: ' + rel);
    }
    const blob = path.join(blobsDir(root), hash);
    if (fs.existsSync(blob)) {
      if (!verifiedExistingBlobs.has(hash)) {
        verifiedBlobFile(root, hash, after.size);
        verifiedExistingBlobs.add(hash);
      }
    } else {
      if (!missingBlobs.has(hash)) {
        missingBlobs.set(hash, { rel, source, blob, hash, bytes: after.size, stat: after });
      }
    }
    files.push({ path: rel, hash, bytes: after.size });
    hashes.set(rel, hash);
    totalBytes += after.size;
    if (!Number.isSafeInteger(totalBytes)) throw new Error('checkpoint size is invalid');
  }

  const missingBytes = [...missingBlobs.values()].reduce((sum, item) => sum + item.bytes, 0);
  if (missingBytes) {
    storageHealth.requireHealthyFreeSpace(
      blobsDir(root),
      missingBytes,
      'Creating the safety checkpoint',
      options.storageHealth,
    );
  }
  for (const item of missingBlobs.values()) {
    const current = fs.lstatSync(item.source);
    if (!current.isFile() || current.isSymbolicLink() || current.size !== item.stat.size ||
        current.mtimeMs !== item.stat.mtimeMs || current.dev !== item.stat.dev || current.ino !== item.stat.ino) {
      throw new Error('project file changed while Carry prepared the checkpoint: ' + item.rel);
    }
    copyFileAtomic(item.source, item.blob);
    const copied = fs.lstatSync(item.blob);
    if (!copied.isFile() || copied.isSymbolicLink() || copied.size !== item.bytes || hashFile(item.blob) !== item.hash) {
      try { fs.unlinkSync(item.blob); } catch { /* preserve integrity failure */ }
      throw new Error('checkpoint data failed integrity verification for ' + item.rel);
    }
  }

  const checkpoint = {
    version: CHECKPOINT_VERSION,
    checkpointId: id,
    name: normalizeName(name, `Checkpoint ${createdAt}`),
    kind: ['manual', 'automatic', 'restore-safety'].includes(options.kind) ? options.kind : 'manual',
    createdAt,
    sourcePeerId: options.sourcePeerId ? String(options.sourcePeerId) : null,
    sourceCheckpointId: options.sourceCheckpointId || null,
    totalBytes,
    files,
  };
  writeJsonAtomic(checkpointFile(root, id), checkpoint);
  const result = publicCheckpoint(checkpoint);
  Object.defineProperty(result, 'hashes', { value: hashes, enumerable: false });
  return result;
}

function blobFile(root, hashValue) {
  const hash = String(hashValue || '').toLowerCase();
  if (!HASH.test(hash)) throw new Error('checkpoint blob hash is invalid');
  return path.join(blobsDir(root), hash);
}

function preview(root, checkpointIdValue) {
  const checkpoint = read(root, checkpointIdValue);
  const checkpointFiles = new Map(checkpoint.files.map((item) => [item.path, item]));
  const currentPaths = sync.listFiles(root);
  const currentPathSet = new Set(currentPaths);
  const changes = [];

  for (const item of checkpoint.files) {
    if (!currentPathSet.has(item.path)) {
      changes.push({ path: item.path, action: 'restore', bytes: item.bytes });
      continue;
    }
    const current = projectFile(root, item.path);
    const stat = fs.statSync(current);
    if (stat.size !== item.bytes || hashFile(current) !== item.hash) {
      changes.push({ path: item.path, action: 'replace', bytes: item.bytes });
    }
  }

  for (const rel of currentPaths) {
    if (checkpointFiles.has(rel)) continue;
    const current = projectFile(root, rel);
    changes.push({ path: rel, action: 'delete', bytes: fs.statSync(current).size });
  }

  changes.sort((a, b) => a.path.localeCompare(b.path));
  const counts = { restore: 0, replace: 0, delete: 0, total: changes.length };
  for (const change of changes) counts[change.action]++;
  return { checkpoint: publicCheckpoint(checkpoint), counts, changes };
}

function restore(root, checkpointIdValue) {
  const checkpoint = read(root, checkpointIdValue);
  const destinations = new Map();
  const targetPaths = new Set();

  // Verify every blob and destination before the first project mutation.
  for (const item of checkpoint.files) {
    let blob;
    try { blob = verifiedBlobFile(root, item.hash, item.bytes); }
    catch {
      throw new Error('checkpoint data failed integrity verification for ' + item.path);
    }
    destinations.set(item.path, projectFile(root, item.path));
    targetPaths.add(item.path);
  }
  const currentPaths = sync.listFiles(root);
  const currentHashes = new Map();
  for (const rel of currentPaths) projectFile(root, rel);
  for (const rel of currentPaths) currentHashes.set(rel, hashFile(path.join(root, ...rel.split('/'))));
  for (const rel of new Set([...currentPaths, ...targetPaths])) {
    if (sync.isPaused(root, rel, null)) throw new Error('checkpoint restore paused because a file is actively claimed: ' + rel);
  }

  const safety = create(root, `Before restoring ${checkpoint.name}`, {
    kind: 'restore-safety',
    sourceCheckpointId: checkpoint.checkpointId,
  });
  const latestPaths = sync.listFiles(root);
  if (latestPaths.length !== currentPaths.length || latestPaths.some((rel, index) =>
    rel !== currentPaths[index] || currentHashes.get(rel) !== hashFile(path.join(root, ...rel.split('/'))))) {
    throw new Error('project files changed while Carry prepared the safety checkpoint; restore was not applied');
  }
  for (const rel of new Set([...latestPaths, ...targetPaths])) {
    if (sync.isPaused(root, rel, null)) throw new Error('checkpoint restore paused because a file became actively claimed: ' + rel);
  }
  let restored = 0;
  let deleted = 0;
  for (const item of checkpoint.files) {
    const destination = destinations.get(item.path);
    if (fs.existsSync(destination) && fs.statSync(destination).size === item.bytes && hashFile(destination) === item.hash) continue;
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    copyFileAtomic(verifiedBlobFile(root, item.hash, item.bytes), destination);
    restored++;
  }
  for (const rel of currentPaths) {
    if (targetPaths.has(rel)) continue;
    const target = projectFile(root, rel);
    if (fs.existsSync(target)) {
      fs.unlinkSync(target);
      deleted++;
    }
  }
  return { checkpoint: publicCheckpoint(checkpoint), safetyCheckpoint: safety, restored, deleted };
}

function garbageCollect(root) {
  const referenced = new Set();
  const dir = snapshotsDir(root);
  if (fs.existsSync(dir)) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      try {
        for (const item of validateCheckpoint(JSON.parse(fs.readFileSync(path.join(dir, entry.name), 'utf8'))).files) referenced.add(item.hash);
      } catch { /* corrupt metadata never authorizes blob deletion */ return; }
    }
  }
  const blobDir = blobsDir(root);
  if (!fs.existsSync(blobDir)) return;
  for (const entry of fs.readdirSync(blobDir, { withFileTypes: true })) {
    if (entry.isFile() && HASH.test(entry.name) && !referenced.has(entry.name.toLowerCase())) fs.unlinkSync(path.join(blobDir, entry.name));
  }
}

function remove(root, checkpointIdValue) {
  const checkpoint = read(root, checkpointIdValue);
  fs.unlinkSync(checkpointFile(root, checkpointIdValue));
  garbageCollect(root);
  return publicCheckpoint(checkpoint);
}

module.exports = {
  CHECKPOINT_VERSION,
  create,
  list,
  preview,
  read,
  remove,
  restore,
  blobFile,
  verifiedBlobFile,
};
