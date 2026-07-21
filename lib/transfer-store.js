'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { writeFileAtomic } = require('./fsx');
const storageHealth = require('./storage-health');

const STATE_VERSION = 2;
const STATE_FILE = 'state.json';
const EXCHANGE_ID_PATTERN = /^[a-f0-9]{24}$/i;
const HASH_PATTERN = /^[a-f0-9]{64}$/i;
const MAX_DATA_PATHS = 64 * 1024;
const MAX_EXPECTED_CHUNKS = 256 * 1024;
const MAX_TRANSFER_FILE_BYTES = 5 * storageHealth.GIB;
const MAX_TEXT_BYTES = 16 * 1024 * 1024;
const MAX_EXPECTED_BYTES = MAX_TRANSFER_FILE_BYTES + MAX_TEXT_BYTES;
const MAX_EXPECTED_CHARS = Math.ceil(MAX_TRANSFER_FILE_BYTES / 3) * 4 + (MAX_TEXT_BYTES / 2);
const DEFAULT_MAX_BYTES = MAX_EXPECTED_BYTES;
const DEFAULT_AGGREGATE_RESERVATION_BYTES = 12 * storageHealth.GIB;
const MAX_RECENT_TRANSFERS = 8;
const TRANSFER_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_CHUNK_BYTES = 2 * 1024 * 1024;
const DEFAULT_PERSIST_EVERY = 1;
const MAX_PERSIST_EVERY = 8192;
const MAX_STATE_BYTES = 64 * 1024 * 1024;
const HASH_READ_BYTES = 64 * 1024;
const SPACE_RECHECK_BYTES = 64 * 1024 * 1024;
const QUOTA_LOCK_FILE = '.quota.lock';
const QUOTA_LOCK_TIMEOUT_MS = 5000;
const QUOTA_LOCK_STALE_MS = 2 * 60 * 1000;
const LOCK_RETRY_MS = 20;

function integer(value, label, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

function safeLogicalPath(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 4096 || value.includes('\0')) {
    throw new Error('transfer data path is invalid');
  }
  if (value.includes('\\') || path.posix.isAbsolute(value) || path.win32.isAbsolute(value)) {
    throw new Error('transfer data path must be a safe relative path');
  }
  const parts = value.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..' || part.length > 255)) {
    throw new Error('transfer data path must be a safe relative path');
  }
  for (const part of parts) {
    if (/[<>:"|?*\u0000-\u001f]/.test(part) || /[ .]$/.test(part)) {
      throw new Error('transfer data path is not portable across devices');
    }
    const stem = part.split('.')[0].toUpperCase();
    if (/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/.test(stem)) {
      throw new Error('transfer data path is not portable across devices');
    }
  }
  return value;
}

function validatePathList(value, label) {
  if (!Array.isArray(value) || value.length > MAX_DATA_PATHS) {
    throw new Error(`${label} must be an array of no more than ${MAX_DATA_PATHS} paths`);
  }
  const result = [];
  const seen = new Set();
  for (const item of value) {
    const rel = safeLogicalPath(item);
    if (seen.has(rel)) throw new Error(`${label} contains a duplicate path: ${rel}`);
    seen.add(rel);
    result.push(rel);
  }
  return result;
}

function assertDirectoryNotLink(directory, label) {
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`${label} must be a real directory`);
  }
}

function restrictDirectory(directory) {
  if (process.platform !== 'win32') fs.chmodSync(directory, 0o700);
}

function restrictFile(file) {
  if (process.platform !== 'win32') fs.chmodSync(file, 0o600);
}

function ensureStoreParents(root, incomingRoot) {
  const carryRoot = path.join(root, '.carry');
  fs.mkdirSync(carryRoot, { recursive: true, mode: 0o700 });
  assertDirectoryNotLink(carryRoot, '.carry');
  restrictDirectory(carryRoot);
  fs.mkdirSync(incomingRoot, { recursive: true, mode: 0o700 });
  assertDirectoryNotLink(incomingRoot, '.carry/incoming');
  restrictDirectory(incomingRoot);
}

function waitSync(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function isContainedExchangeDirectory(incomingRoot, exchangeId, directory) {
  return directory === path.join(incomingRoot, exchangeId) &&
    path.dirname(directory) === incomingRoot && path.basename(directory) === exchangeId;
}

function removeContainedExchangeDirectory(incomingRoot, exchangeId, directory) {
  if (!EXCHANGE_ID_PATTERN.test(exchangeId) || !isContainedExchangeDirectory(incomingRoot, exchangeId, directory)) {
    throw new Error('refusing to remove an uncontained transfer directory');
  }
  assertDirectoryNotLink(incomingRoot, '.carry/incoming');
  assertDirectoryNotLink(directory, 'transfer exchange directory');
  const realIncoming = fs.realpathSync(incomingRoot);
  const realDirectory = fs.realpathSync(directory);
  if (path.dirname(realDirectory) !== realIncoming || path.basename(realDirectory) !== exchangeId) {
    throw new Error('refusing to remove an uncontained transfer directory');
  }
  fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}

function readSmallJsonFile(file, maximumBytes, errorMessage) {
  let stat;
  try { stat = fs.lstatSync(file); } catch { throw new Error(errorMessage); }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maximumBytes) throw new Error(errorMessage);
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(errorMessage);
    return { value, stat };
  } catch {
    throw new Error(errorMessage);
  }
}

function lockMetadata(lockFile) {
  let stat;
  try { stat = fs.lstatSync(lockFile); } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('incoming transfer quota lock is unsafe');
  if (stat.size > 4096) throw new Error('incoming transfer quota lock is corrupt');
  let value;
  try { value = JSON.parse(fs.readFileSync(lockFile, 'utf8')); }
  catch { throw new Error('incoming transfer quota lock is corrupt'); }
  if (!value || typeof value !== 'object' || typeof value.token !== 'string' ||
      !/^[a-f0-9]{32}$/i.test(value.token) || !Number.isSafeInteger(value.pid) ||
      !Number.isFinite(value.createdAt)) {
    throw new Error('incoming transfer quota lock is corrupt');
  }
  return { stat, value };
}

function acquireQuotaLock(incomingRoot) {
  const lockFile = path.join(incomingRoot, QUOTA_LOCK_FILE);
  const token = crypto.randomBytes(16).toString('hex');
  const startedAt = Date.now();
  for (;;) {
    let handle;
    try {
      handle = fs.openSync(lockFile, 'wx', 0o600);
      fs.writeFileSync(handle, JSON.stringify({ token, pid: process.pid, createdAt: Date.now() }) + '\n');
      fs.closeSync(handle);
      handle = undefined;
      restrictFile(lockFile);
      return { lockFile, token };
    } catch (error) {
      if (handle !== undefined) {
        try { fs.closeSync(handle); } catch { /* preserve original failure */ }
        try { fs.unlinkSync(lockFile); } catch { /* preserve original failure */ }
      }
      if (error.code !== 'EEXIST') throw error;
      let metadata;
      try {
        metadata = lockMetadata(lockFile);
      } catch (metadataError) {
        let staleStat = null;
        try { staleStat = fs.lstatSync(lockFile); } catch { /* preserve the metadata error */ }
        if (staleStat && staleStat.isFile() && !staleStat.isSymbolicLink() &&
            Date.now() - staleStat.mtimeMs > QUOTA_LOCK_STALE_MS) {
          fs.unlinkSync(lockFile);
          continue;
        }
        throw metadataError;
      }
      if (!metadata) continue;
      if (Date.now() - metadata.stat.mtimeMs > QUOTA_LOCK_STALE_MS) {
        fs.unlinkSync(lockFile);
        continue;
      }
      if (Date.now() - startedAt >= QUOTA_LOCK_TIMEOUT_MS) {
        throw new Error('timed out waiting for the incoming transfer quota lock');
      }
      waitSync(LOCK_RETRY_MS);
    }
  }
}

function releaseQuotaLock(lock) {
  let metadata;
  try { metadata = lockMetadata(lock.lockFile); }
  catch { return; }
  if (!metadata || metadata.value.token !== lock.token) return;
  try { fs.unlinkSync(lock.lockFile); } catch (error) { if (error.code !== 'ENOENT') throw error; }
}

function withQuotaLock(incomingRoot, callback) {
  const lock = acquireQuotaLock(incomingRoot);
  try { return callback(); }
  finally { releaseQuotaLock(lock); }
}

function inspectReservations(incomingRoot, now) {
  let reservedBytes = 0;
  let recentTransfers = 0;
  for (const item of fs.readdirSync(incomingRoot, { withFileTypes: true })) {
    if (item.name === QUOTA_LOCK_FILE) continue;
    if (!EXCHANGE_ID_PATTERN.test(item.name) || !item.isDirectory() || item.isSymbolicLink()) {
      throw new Error('incoming transfer directory contains an unexpected entry');
    }
    const directory = path.join(incomingRoot, item.name);
    assertDirectoryNotLink(directory, 'transfer exchange directory');
    const stateFile = path.join(directory, STATE_FILE);
    let parsed;
    try {
      parsed = readSmallJsonFile(stateFile, MAX_STATE_BYTES, 'incoming transfer reservation is corrupt');
    } catch (error) {
      const directoryStat = fs.lstatSync(directory);
      if (now - directoryStat.mtimeMs <= TRANSFER_TTL_MS) throw error;
      removeContainedExchangeDirectory(incomingRoot, item.name, directory);
      continue;
    }
    if (now - parsed.stat.mtimeMs > TRANSFER_TTL_MS) {
      removeContainedExchangeDirectory(incomingRoot, item.name, directory);
      continue;
    }
    const reservation = parsed.value.maxBytes;
    if (!Number.isSafeInteger(reservation) || reservation < 0 ||
        reservation > DEFAULT_AGGREGATE_RESERVATION_BYTES) {
      throw new Error('incoming transfer reservation is corrupt');
    }
    reservedBytes += reservation;
    recentTransfers += 1;
    if (!Number.isSafeInteger(reservedBytes) || reservedBytes > DEFAULT_AGGREGATE_RESERVATION_BYTES) {
      throw new Error('incoming transfer reservations exceed the aggregate disk limit');
    }
  }
  return { reservedBytes, recentTransfers };
}

function spoolName(index) {
  return String(index).padStart(6, '0') + '.part';
}

function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function hashFileRange(file, offset, length) {
  const hash = crypto.createHash('sha256');
  const handle = fs.openSync(file, 'r');
  const buffer = Buffer.allocUnsafe(Math.min(HASH_READ_BYTES, Math.max(1, length)));
  let position = offset;
  let remaining = length;
  try {
    while (remaining > 0) {
      const wanted = Math.min(buffer.length, remaining);
      const read = fs.readSync(handle, buffer, 0, wanted, position);
      if (read !== wanted) throw new Error('transfer spool file is truncated');
      hash.update(buffer.subarray(0, read));
      position += read;
      remaining -= read;
    }
  } finally {
    fs.closeSync(handle);
  }
  return hash.digest('hex');
}

function hashWholeFile(file, length) {
  return hashFileRange(file, 0, length);
}

function canonicalBase64(value, maximumBytes) {
  if (typeof value !== 'string' || value.length % 4 !== 0 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error('binary transfer chunk must be a canonical base64 string or Buffer');
  }
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  const decodedBytes = (value.length / 4) * 3 - padding;
  if (decodedBytes > MAX_CHUNK_BYTES) throw new Error('transfer chunk exceeds the byte limit');
  if (decodedBytes > maximumBytes) throw new Error('transfer exceeded its disk byte cap');
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value) {
    throw new Error('binary transfer chunk must be canonical base64');
  }
  return bytes;
}

function equalArrays(left, right) {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

function readExpectedHash(hashes, rel) {
  if (hashes instanceof Map) return hashes.get(rel);
  if (!hashes || typeof hashes !== 'object' || Array.isArray(hashes)) return undefined;
  return Object.prototype.hasOwnProperty.call(hashes, rel) ? hashes[rel] : undefined;
}

class IncomingTransferStore {
  constructor(root, options) {
    if (typeof root !== 'string' || !root) throw new Error('transfer project root is required');
    if (!options || typeof options !== 'object' || Array.isArray(options)) {
      throw new Error('transfer options are required');
    }

    const exchangeId = String(options.exchangeId || '');
    if (!EXCHANGE_ID_PATTERN.test(exchangeId)) throw new Error('transfer exchange id is invalid');
    const peerId = options.peerId;
    if (typeof peerId !== 'string' || peerId.length < 1 || peerId.length > 256 || /[\u0000-\u001f\u007f]/.test(peerId)) {
      throw new Error('transfer peer id is invalid');
    }
    const dataPaths = validatePathList(options.dataPaths, 'transfer data paths');
    const textPaths = validatePathList(options.textPaths || [], 'transfer text paths');
    const dataSet = new Set(dataPaths);
    if (textPaths.some((rel) => !dataSet.has(rel))) {
      throw new Error('transfer text paths must also be data paths');
    }
    const expectedChunkCount = integer(
      options.expectedChunkCount,
      'expected transfer chunk count',
      dataPaths.length,
      MAX_EXPECTED_CHUNKS,
    );
    const expectedChars = integer(
      options.expectedChars,
      'expected transfer character count',
      0,
      MAX_EXPECTED_CHARS,
    );
    const expectedBytes = options.expectedBytes === undefined || options.expectedBytes === null
      ? null
      : integer(options.expectedBytes, 'expected transfer byte count', 0, MAX_EXPECTED_BYTES);
    const maxBytes = options.maxBytes === undefined
      ? DEFAULT_MAX_BYTES
      : integer(options.maxBytes, 'transfer byte cap', 0, Number.MAX_SAFE_INTEGER);
    if (expectedBytes !== null && expectedBytes > maxBytes) {
      throw new Error('expected transfer bytes exceed the transfer byte cap');
    }
    const persistEvery = options.persistEvery === undefined
      ? DEFAULT_PERSIST_EVERY
      : integer(options.persistEvery, 'transfer persistence interval', 1, MAX_PERSIST_EVERY);

    this.root = path.resolve(root);
    this.exchangeId = exchangeId.toLowerCase();
    this.peerId = peerId;
    this.dataPaths = dataPaths;
    this.textPaths = textPaths;
    this.textSet = new Set(textPaths);
    this.expectedChunkCount = expectedChunkCount;
    this.expectedChars = expectedChars;
    this.expectedBytes = expectedBytes;
    this.maxBytes = maxBytes;
    this.persistEvery = persistEvery;
    this.incomingRoot = path.join(this.root, '.carry', 'incoming');
    this.directory = path.join(this.incomingRoot, this.exchangeId);
    this.stateFile = path.join(this.directory, STATE_FILE);
    this.entries = new Map();
    this.receivedChunks = 0;
    this.encodedChars = 0;
    this.storedBytes = 0;
    this.unpersisted = 0;
    this.storageHealthOptions = options.storageHealth;
    this.nextSpaceCheckAt = SPACE_RECHECK_BYTES;
    this.validated = false;

    ensureStoreParents(this.root, this.incomingRoot);
    withQuotaLock(this.incomingRoot, () => {
      if (fs.existsSync(this.directory)) {
        this._restore();
        storageHealth.requireHealthyFreeSpace(
          this.incomingRoot,
          Math.max(0, (this.expectedBytes === null ? this.maxBytes : this.expectedBytes) - this.storedBytes),
          'Resuming the incoming transfer',
          this.storageHealthOptions,
        );
        return;
      }
      if (this.maxBytes > DEFAULT_AGGREGATE_RESERVATION_BYTES) {
        throw new Error('incoming transfer reservation exceeds the aggregate disk limit');
      }
      const reservations = inspectReservations(this.incomingRoot, Date.now());
      if (reservations.recentTransfers >= MAX_RECENT_TRANSFERS) {
        throw new Error('too many unfinished incoming transfers; retry after an earlier transfer finishes');
      }
      if (reservations.reservedBytes + this.maxBytes > DEFAULT_AGGREGATE_RESERVATION_BYTES) {
        throw new Error('incoming transfers have reached Carry\'s aggregate disk reservation limit');
      }
      storageHealth.requireHealthyFreeSpace(
        this.incomingRoot,
        reservations.reservedBytes + (this.expectedBytes === null ? this.maxBytes : this.expectedBytes),
        'Receiving the encrypted update',
        this.storageHealthOptions,
      );
      this._create();
    });
    this.validated = true;
  }

  _newEntry(rel, index) {
    return {
      rel,
      text: this.textSet.has(rel),
      fileName: spoolName(index),
      file: path.join(this.directory, spoolName(index)),
      bytes: 0,
      chunks: [],
    };
  }

  _create() {
    fs.mkdirSync(this.directory, { mode: 0o700 });
    assertDirectoryNotLink(this.directory, 'transfer exchange directory');
    restrictDirectory(this.directory);
    try {
      this.dataPaths.forEach((rel, index) => {
        const entry = this._newEntry(rel, index);
        fs.writeFileSync(entry.file, Buffer.alloc(0), { flag: 'wx', mode: 0o600 });
        restrictFile(entry.file);
        this.entries.set(rel, entry);
      });
      this._persist();
    } catch (error) {
      try { fs.rmSync(this.directory, { recursive: true, force: true }); } catch { /* best effort */ }
      throw error;
    }
  }

  _parseState() {
    let stat;
    try { stat = fs.lstatSync(this.stateFile); } catch { throw new Error('transfer state is missing or corrupt'); }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_STATE_BYTES) {
      throw new Error('transfer state is missing or corrupt');
    }
    let state;
    try { state = JSON.parse(fs.readFileSync(this.stateFile, 'utf8')); }
    catch { throw new Error('transfer state is corrupt'); }
    if (!state || typeof state !== 'object' || Array.isArray(state)) throw new Error('transfer state is corrupt');
    return state;
  }

  _restore() {
    assertDirectoryNotLink(this.directory, 'transfer exchange directory');
    const state = this._parseState();
    if (state.version !== STATE_VERSION || state.exchangeId !== this.exchangeId || state.peerId !== this.peerId ||
        !equalArrays(state.dataPaths || [], this.dataPaths) || !equalArrays(state.textPaths || [], this.textPaths) ||
        state.expectedChunkCount !== this.expectedChunkCount || state.expectedChars !== this.expectedChars ||
        state.expectedBytes !== this.expectedBytes ||
        state.maxBytes !== this.maxBytes || !Array.isArray(state.entries) || state.entries.length !== this.dataPaths.length) {
      throw new Error('persisted transfer state does not match this exchange');
    }

    const expectedNames = new Set([STATE_FILE]);
    let receivedChunks = 0;
    let encodedChars = 0;
    let storedBytes = 0;
    for (let entryIndex = 0; entryIndex < state.entries.length; entryIndex++) {
      const saved = state.entries[entryIndex];
      const rel = this.dataPaths[entryIndex];
      const fileName = spoolName(entryIndex);
      if (!saved || typeof saved !== 'object' || saved.rel !== rel || saved.text !== this.textSet.has(rel) ||
          saved.file !== fileName || !Array.isArray(saved.chunks) || !Number.isSafeInteger(saved.bytes) || saved.bytes < 0) {
        throw new Error('persisted transfer state is corrupt');
      }
      expectedNames.add(fileName);
      const entry = this._newEntry(rel, entryIndex);
      let nextOffset = 0;
      for (let chunkIndex = 0; chunkIndex < saved.chunks.length; chunkIndex++) {
        const chunk = saved.chunks[chunkIndex];
        if (!chunk || typeof chunk !== 'object' || chunk.index !== chunkIndex || chunk.offset !== nextOffset ||
            !Number.isSafeInteger(chunk.bytes) || chunk.bytes < 0 || chunk.bytes > MAX_CHUNK_BYTES ||
            !Number.isSafeInteger(chunk.encodedChars) || chunk.encodedChars < 0 ||
            typeof chunk.hash !== 'string' || !HASH_PATTERN.test(chunk.hash)) {
          throw new Error('persisted transfer chunk state is corrupt');
        }
        entry.chunks.push({
          index: chunk.index,
          offset: chunk.offset,
          bytes: chunk.bytes,
          encodedChars: chunk.encodedChars,
          hash: chunk.hash.toLowerCase(),
        });
        nextOffset += chunk.bytes;
        receivedChunks += 1;
        encodedChars += chunk.encodedChars;
      }
      if (nextOffset !== saved.bytes || (entry.text && nextOffset > MAX_TEXT_BYTES)) {
        throw new Error('persisted transfer byte totals are corrupt');
      }
      const spoolStat = fs.lstatSync(entry.file);
      if (!spoolStat.isFile() || spoolStat.isSymbolicLink()) throw new Error('transfer spool path is not a regular file');
      if (spoolStat.size < nextOffset) throw new Error('transfer spool file is truncated');
      if (spoolStat.size > nextOffset) fs.truncateSync(entry.file, nextOffset);
      for (const chunk of entry.chunks) {
        if (hashFileRange(entry.file, chunk.offset, chunk.bytes) !== chunk.hash) {
          throw new Error('transfer spool file failed its integrity check');
        }
      }
      entry.bytes = nextOffset;
      storedBytes += nextOffset;
      this.entries.set(rel, entry);
    }

    if (state.receivedChunks !== receivedChunks || state.encodedChars !== encodedChars ||
        state.storedBytes !== storedBytes || receivedChunks > this.expectedChunkCount ||
        encodedChars > this.expectedChars || storedBytes > this.maxBytes) {
      throw new Error('persisted transfer totals are corrupt');
    }
    const directoryEntries = fs.readdirSync(this.directory, { withFileTypes: true });
    for (const item of directoryEntries) {
      if (expectedNames.has(item.name)) continue;
      if (/^state\.json\.\d+\.tmp$/.test(item.name) && item.isFile() && !item.isSymbolicLink()) {
        fs.unlinkSync(path.join(this.directory, item.name));
        continue;
      }
      throw new Error('transfer exchange directory contains an unexpected file');
    }
    this.receivedChunks = receivedChunks;
    this.encodedChars = encodedChars;
    this.storedBytes = storedBytes;
    this.nextSpaceCheckAt = storedBytes + SPACE_RECHECK_BYTES;
  }

  _serializedState() {
    return {
      version: STATE_VERSION,
      exchangeId: this.exchangeId,
      peerId: this.peerId,
      dataPaths: this.dataPaths,
      textPaths: this.textPaths,
      expectedChunkCount: this.expectedChunkCount,
      expectedChars: this.expectedChars,
      expectedBytes: this.expectedBytes,
      maxBytes: this.maxBytes,
      receivedChunks: this.receivedChunks,
      encodedChars: this.encodedChars,
      storedBytes: this.storedBytes,
      entries: this.dataPaths.map((rel) => {
        const entry = this.entries.get(rel);
        return {
          rel,
          text: entry.text,
          file: entry.fileName,
          bytes: entry.bytes,
          chunks: entry.chunks,
        };
      }),
    };
  }

  _persist() {
    const serialized = JSON.stringify(this._serializedState());
    if (Buffer.byteLength(serialized, 'utf8') > MAX_STATE_BYTES) {
      throw new Error('transfer state exceeds its safe metadata limit');
    }
    writeFileAtomic(this.stateFile, serialized + '\n');
    restrictFile(this.stateFile);
    this.unpersisted = 0;
  }

  _normalizeChunk(entry, data, maximumBytes, maximumChars) {
    if (entry.text) {
      if (typeof data !== 'string') throw new Error('text transfer chunks must be strings');
      if (data.length * 2 > MAX_CHUNK_BYTES) throw new Error('transfer chunk exceeds the byte limit');
      if (data.length > maximumChars) throw new Error('transfer exceeded its declared character count');
      if (data.length * 2 > maximumBytes) throw new Error('transfer exceeded its disk byte cap');
      const bytes = Buffer.from(data, 'utf16le');
      return { bytes, encodedChars: data.length };
    }
    if (Buffer.isBuffer(data)) {
      if (data.length > MAX_CHUNK_BYTES) throw new Error('transfer chunk exceeds the byte limit');
      const chars = Math.ceil(data.length / 3) * 4;
      if (chars > maximumChars) throw new Error('transfer exceeded its declared character count');
      if (data.length > maximumBytes) throw new Error('transfer exceeded its disk byte cap');
      return { bytes: data, encodedChars: chars };
    }
    if (typeof data === 'string' && data.length > maximumChars) {
      throw new Error('transfer exceeded its declared character count');
    }
    return { bytes: canonicalBase64(data, maximumBytes), encodedChars: data.length };
  }

  append(rel, index, data) {
    rel = safeLogicalPath(rel);
    const entry = this.entries.get(rel);
    if (!entry) throw new Error('transfer chunk path was not declared');
    if (!Number.isSafeInteger(index) || index < 0) throw new Error('transfer chunk index is invalid');
    const nextIndex = entry.chunks.length;
    if (index > nextIndex) throw new Error('transfer chunk arrived out of order');
    const duplicate = index < nextIndex;
    const byteAllowance = duplicate ? Number.MAX_SAFE_INTEGER : Math.max(0, this.maxBytes - this.storedBytes);
    const charAllowance = duplicate
      ? MAX_EXPECTED_CHARS
      : Math.max(0, this.expectedChars - this.encodedChars);
    const normalized = this._normalizeChunk(entry, data, byteAllowance, charAllowance);
    const contentHash = sha256(normalized.bytes);

    if (duplicate) {
      const previous = entry.chunks[index];
      if (!previous || previous.bytes !== normalized.bytes.length ||
          previous.encodedChars !== normalized.encodedChars || previous.hash !== contentHash) {
        throw new Error('transfer chunk duplicate conflicts with stored data');
      }
      return { ...this.status(), duplicate: true };
    }
    if (this.receivedChunks + 1 > this.expectedChunkCount) throw new Error('transfer received too many chunks');
    // The normalization step checks both remaining budgets before decoding or
    // allocating a new spool buffer. Keep these messages specific for callers.
    if (this.encodedChars + normalized.encodedChars > this.expectedChars) throw new Error('transfer exceeded its declared character count');
    if (this.storedBytes + normalized.bytes.length > this.maxBytes) throw new Error('transfer exceeded its disk byte cap');
    if (entry.text && entry.bytes + normalized.bytes.length > MAX_TEXT_BYTES) {
      throw new Error('agent-memory transfer exceeds its 16 MiB safety limit');
    }
    if (this.storedBytes + normalized.bytes.length >= this.nextSpaceCheckAt) {
      storageHealth.requireHealthyFreeSpace(
        this.incomingRoot,
        Math.max(
          normalized.bytes.length,
          (this.expectedBytes === null ? this.maxBytes : this.expectedBytes) - this.storedBytes,
        ),
        'Continuing the incoming transfer',
        this.storageHealthOptions,
      );
      this.nextSpaceCheckAt = this.storedBytes + SPACE_RECHECK_BYTES;
    }

    const previousBytes = entry.bytes;
    const record = {
      index,
      offset: previousBytes,
      bytes: normalized.bytes.length,
      encodedChars: normalized.encodedChars,
      hash: contentHash,
    };
    try {
      fs.appendFileSync(entry.file, normalized.bytes);
      entry.chunks.push(record);
      entry.bytes += record.bytes;
      this.receivedChunks += 1;
      this.encodedChars += record.encodedChars;
      this.storedBytes += record.bytes;
      this.unpersisted += 1;
      if (this.unpersisted >= this.persistEvery) this._persist();
    } catch (error) {
      try { fs.truncateSync(entry.file, previousBytes); } catch { /* preserve original failure */ }
      if (entry.chunks.at(-1) === record) {
        entry.chunks.pop();
        entry.bytes -= record.bytes;
        this.receivedChunks -= 1;
        this.encodedChars -= record.encodedChars;
        this.storedBytes -= record.bytes;
        this.unpersisted = Math.max(0, this.unpersisted - 1);
      }
      throw error;
    }
    return { ...this.status(), duplicate: false };
  }

  status() {
    const nextIndexes = Object.create(null);
    for (const rel of this.dataPaths) nextIndexes[rel] = this.entries.get(rel).chunks.length;
    return {
      receivedChunks: this.receivedChunks,
      totalChunks: this.expectedChunkCount,
      encodedChars: this.encodedChars,
      storedBytes: this.storedBytes,
      nextIndexes,
    };
  }

  finalize(hashes) {
    if (this.receivedChunks !== this.expectedChunkCount || this.encodedChars !== this.expectedChars) {
      throw new Error('transfer is incomplete and cannot be finalized');
    }
    if (this.expectedBytes !== null && this.storedBytes !== this.expectedBytes) {
      throw new Error('transfer byte count does not match its declaration');
    }
    for (const rel of this.dataPaths) {
      if (this.entries.get(rel).chunks.length < 1) throw new Error('transfer omitted data for ' + rel);
    }
    this._persist();

    const files = new Map();
    const text = new Map();
    for (const rel of this.dataPaths) {
      const entry = this.entries.get(rel);
      const stat = fs.lstatSync(entry.file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== entry.bytes) {
        throw new Error('transfer spool file changed before finalization');
      }
      if (entry.text) {
        if (entry.bytes % 2 !== 0) throw new Error('text transfer spool is corrupt');
        if (entry.bytes > MAX_TEXT_BYTES) throw new Error('agent-memory transfer exceeds its 16 MiB safety limit');
        text.set(rel, fs.readFileSync(entry.file).toString('utf16le'));
        continue;
      }
      const expectedHash = readExpectedHash(hashes, rel);
      if (typeof expectedHash !== 'string' || !HASH_PATTERN.test(expectedHash)) {
        throw new Error('missing or invalid transfer hash for ' + rel);
      }
      const actualHash = hashWholeFile(entry.file, entry.bytes);
      const actualBytes = Buffer.from(actualHash, 'hex');
      const expectedBytes = Buffer.from(expectedHash, 'hex');
      if (!crypto.timingSafeEqual(actualBytes, expectedBytes)) {
        throw new Error('transfer hash mismatch for ' + rel);
      }
      files.set(rel, entry.file);
    }
    return { files, text };
  }

  checkpoint() {
    if (!this.validated) throw new Error('transfer exchange directory was not validated');
    this._persist();
    return this.status();
  }

  cleanup() {
    if (!this.validated) throw new Error('transfer exchange directory was not validated');
    const expectedDirectory = path.join(this.incomingRoot, this.exchangeId);
    if (this.directory !== expectedDirectory || path.dirname(this.directory) !== this.incomingRoot ||
        path.basename(this.directory) !== this.exchangeId) {
      throw new Error('refusing to clean an uncontained transfer directory');
    }
    if (!fs.existsSync(this.directory)) return;
    assertDirectoryNotLink(path.join(this.root, '.carry'), '.carry');
    assertDirectoryNotLink(this.incomingRoot, '.carry/incoming');
    assertDirectoryNotLink(this.directory, 'transfer exchange directory');
    const realIncoming = fs.realpathSync(this.incomingRoot);
    const realDirectory = fs.realpathSync(this.directory);
    if (path.dirname(realDirectory) !== realIncoming || path.basename(realDirectory) !== this.exchangeId) {
      throw new Error('refusing to clean an uncontained transfer directory');
    }
    withQuotaLock(this.incomingRoot, () => {
      if (fs.existsSync(this.directory)) {
        removeContainedExchangeDirectory(this.incomingRoot, this.exchangeId, this.directory);
      }
    });
  }
}

module.exports = {
  IncomingTransferStore,
  STATE_VERSION,
  STATE_FILE,
  EXCHANGE_ID_PATTERN,
  MAX_DATA_PATHS,
  MAX_EXPECTED_CHUNKS,
  MAX_EXPECTED_CHARS,
  MAX_EXPECTED_BYTES,
  MAX_TRANSFER_FILE_BYTES,
  DEFAULT_MAX_BYTES,
  MAX_TEXT_BYTES,
  DEFAULT_AGGREGATE_RESERVATION_BYTES,
  MAX_RECENT_TRANSFERS,
  TRANSFER_TTL_MS,
  QUOTA_LOCK_STALE_MS,
  MAX_CHUNK_BYTES,
  DEFAULT_PERSIST_EVERY,
  MAX_PERSIST_EVERY,
  MAX_STATE_BYTES,
};
