'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const board = require('./board');
const memory = require('./memoryMerge');

const WINDOWS_RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

// Carry projects may move between operating systems. Reject paths that alias
// another file or address NTFS alternate data streams on Windows, even when
// the sender currently runs on a case-sensitive filesystem.
function portablePathKey(value) {
  return String(value).normalize('NFC').toLowerCase();
}

function validatePortablePath(value, label) {
  for (const segment of String(value).split('/')) {
    if (!segment || /[<>:"|?*\x00-\x1f]/.test(segment) || /[ .]$/.test(segment) ||
        WINDOWS_RESERVED_NAME.test(segment)) {
      throw new Error(`${label || 'file'} contains a Windows-incompatible or aliased path: ${value}`);
    }
  }
  return value;
}

// Per-machine "hot" (claimed) files are paused so we don't clobber an in-progress
// agent edit. We treat the peer's device as a foreign agent.
function isPaused(root, relPath, selfAgent) {
  if (!board.isFileClaimed(root, relPath, selfAgent)) return false;
  return true;
}

// Walk a project root and return its portable file and directory paths,
// excluding .git (git's job) and our own .carry metadata dir. Directories are
// first-class sync metadata so empty project structure is not silently lost.
function listProjectEntries(root) {
  const files = [];
  const directories = [];
  function walk(dir, rel) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      const label = rel ? rel.replace(/\\/g, '/') : '.';
      throw new Error(`could not read project folder ${label}; sync stopped to prevent false deletions: ${error.message}`);
    }
    for (const e of entries) {
      if (e.name === '.git' || e.name === '.carry') continue;
      const full = path.join(dir, e.name);
      const r = rel ? path.join(rel, e.name) : e.name;
      if (e.isDirectory()) {
        directories.push(r.replace(/\\/g, '/'));
        walk(full, r);
      }
      else if (e.isFile()) {
        const posix = r.replace(/\\/g, '/');
        // Claims and backups are per-device coordination metadata. Syncing
        // them would make a stale claim on one device pause the other.
        if (posix === path.posix.join(board.SHARED_MEM_DIR, board.ACTIVITY)) continue;
        if (posix === path.posix.join(memory.SHARED_MEM_DIR, memory.MEMORY_FILE + '.bak')) continue;
        files.push(posix);
      }
    }
  }
  walk(root, '');
  return { files, directories };
}

function listFiles(root) {
  return listProjectEntries(root).files;
}

function listDirectories(root) {
  return listProjectEntries(root).directories;
}

function hashFile(file) {
  const hash = crypto.createHash('sha256');
  const handle = fs.openSync(file, 'r');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    for (;;) {
      const read = fs.readSync(handle, buffer, 0, buffer.length, null);
      if (!read) break;
      hash.update(buffer.subarray(0, read));
    }
  } finally {
    fs.closeSync(handle);
  }
  return hash.digest('hex');
}

function mtimeMs(file) {
  try { return fs.statSync(file).mtimeMs; } catch { return 0; }
}

// Compare two roots (this machine vs peer) and produce a plan: files that the
// peer has but we don't (to pull), files we have but peer lacks (to push), and
// files differing by hash (conflict → both kept via .carry/conflict, not overwritten).
// Memory file is handled separately by the merge step, so it is excluded here.
function diff(localRoot, peerFiles, peerHashes) {
  const local = listFiles(localRoot);
  const localSet = new Set(local);
  const toPull = [];
  const toPush = [];
  const conflicts = [];

  for (const f of peerFiles) {
    if (f === path.posix.join(board.SHARED_MEM_DIR, memory.MEMORY_FILE)) continue; // merged, not copied
    if (!localSet.has(f)) toPull.push(f);
  }
  for (const f of local) {
    if (f === path.posix.join(board.SHARED_MEM_DIR, memory.MEMORY_FILE)) continue;
    const pHash = peerHashes[f];
    if (!pHash) { toPush.push(f); continue; }
    const lHash = hashFile(path.join(localRoot, f));
    if (lHash !== pHash) conflicts.push(f);
  }
  return { toPull, toPush, conflicts };
}

function copyFileFrom(srcFile, localRoot, rel) {
  const dest = path.join(localRoot, rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(srcFile, dest);
}

// Apply a one-directional pull of `files` from a peer bundle into localRoot,
// skipping paused files. Regular files are stored base64-encoded in the bundle
// (so they survive NDJSON framing); the memory store is JSON, not base64.
// Returns the list of skipped (paused) paths.
function applyPull(localRoot, bundle, selfAgent) {
  const skipped = [];
  for (const rel of bundle.files) {
    if (bundle.memoryOnly && rel.endsWith(memory.MEMORY_FILE)) continue;
    if (isPaused(localRoot, rel, selfAgent)) { skipped.push(rel); continue; }
    const dest = path.join(localRoot, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const raw = bundle.data[rel];
    if (rel.endsWith(memory.MEMORY_FILE)) {
      // Memory is a structured JSON string — merge it, don't write raw.
      const incoming = JSON.parse(raw);
      const r = memory.mergeMemoryInto(localRoot, incoming);
      if (r && r.changed) {
        // reported by caller; nothing else to do here
      }
    } else {
      const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw || ''), 'base64');
      fs.writeFileSync(dest, buf);
    }
  }
  return skipped;
}

module.exports = {
  listProjectEntries,
  listFiles,
  listDirectories,
  hashFile,
  mtimeMs,
  diff,
  isPaused,
  applyPull,
  copyFileFrom,
  portablePathKey,
  validatePortablePath,
};
