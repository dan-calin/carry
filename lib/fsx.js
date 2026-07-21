'use strict';

const fs = require('fs');

const WINDOWS_RENAME_RETRY_MS = [5, 10, 25, 50, 100, 200];

function waitSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function isTransientRenameError(err) {
  return process.platform === 'win32' && err && ['EPERM', 'EACCES', 'EBUSY'].includes(err.code);
}

function replaceWithTemporary(tmp, file) {
  try {
    for (let attempt = 0; ; attempt++) {
      try {
        fs.renameSync(tmp, file);
        break;
      } catch (err) {
        if (!isTransientRenameError(err) || attempt >= WINDOWS_RENAME_RETRY_MS.length) throw err;
        waitSync(WINDOWS_RENAME_RETRY_MS[attempt]);
      }
    }
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* best effort */ }
    throw err;
  }
}

// Write via a temp file + rename so a crash mid-write can never leave a
// truncated file behind. rename() on the same volume is atomic on all
// platforms we support (on Windows it maps to MoveFileEx with replace).
// Mirrors the pattern in shared-agent-memory/lib/fsx.js.
function writeFileAtomic(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data);
  replaceWithTemporary(tmp, file);
}

// Copy an already-verified staged file without first loading it into memory.
// The destination changes only after the complete copy exists beside it.
function copyFileAtomic(source, file) {
  const tmp = `${file}.${process.pid}.tmp`;
  try { fs.unlinkSync(tmp); } catch (err) { if (err.code !== 'ENOENT') throw err; }
  try {
    fs.copyFileSync(source, tmp, fs.constants.COPYFILE_EXCL);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* best effort */ }
    throw err;
  }
  replaceWithTemporary(tmp, file);
}

// Staged sync files live below the project root, so they normally share a
// volume with their destination. A hard link lets the verified spool become
// the working file without writing the bytes to the SSD a second time. Keep a
// copy fallback for filesystems or policies that do not permit hard links.
function linkOrCopyFileAtomic(source, file) {
  const tmp = `${file}.${process.pid}.tmp`;
  try { fs.unlinkSync(tmp); } catch (err) { if (err.code !== 'ENOENT') throw err; }
  try {
    try { fs.linkSync(source, tmp); }
    catch (linkError) {
      try { fs.copyFileSync(source, tmp, fs.constants.COPYFILE_EXCL); }
      catch (copyError) {
        copyError.cause = linkError;
        throw copyError;
      }
    }
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* best effort */ }
    throw err;
  }
  replaceWithTemporary(tmp, file);
}

module.exports = { writeFileAtomic, copyFileAtomic, linkOrCopyFileAtomic };
