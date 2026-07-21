'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const board = require('./board');
const checkpoints = require('./checkpoints');
const { writeFileAtomic, copyFileAtomic, linkOrCopyFileAtomic } = require('./fsx');
const manifest = require('./manifest');
const memory = require('./memoryMerge');
const sync = require('./sync');

const STATE_VERSION = 1;
const MAX_BATCH_CONFLICTS = 500;
const MEMORY_PATH = path.posix.join(board.SHARED_MEM_DIR, memory.MEMORY_FILE);

function own(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function safePeerId(peerId) {
  const safe = String(peerId || '').replace(/[^a-zA-Z0-9_-]/g, '_');
  if (!safe) throw new Error('sync peer id is missing');
  return safe;
}

function safeRelativePath(value) {
  if (typeof value !== 'string' || !value || value.includes('\0') || value.includes('\\')) {
    throw new Error('peer sent an invalid file path');
  }
  if (path.posix.isAbsolute(value) || /^[a-zA-Z]:/.test(value)) {
    throw new Error('peer sent an absolute file path');
  }
  const normalized = path.posix.normalize(value);
  if (normalized !== value || normalized === '.' || normalized.startsWith('../') || normalized.includes('/../')) {
    throw new Error('peer file path escapes the project folder');
  }
  const lowerParts = value.toLowerCase().split('/');
  if (lowerParts.includes('.git') || lowerParts.includes('.carry')) {
    throw new Error('peer file path targets Carry or git metadata');
  }
  const lower = value.toLowerCase();
  if (lower === '.shared-memory/activity.jsonl' || lower === '.shared-memory/memory.json.bak') {
    throw new Error('peer file path targets local-only agent metadata');
  }
  sync.validatePortablePath(value, 'peer file');
  return value;
}

function projectFile(root, rel) {
  safeRelativePath(rel);
  let current = path.resolve(root);
  for (const segment of rel.split('/')) {
    current = path.join(current, segment);
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) {
      throw new Error('peer file path crosses a symbolic link: ' + rel);
    }
  }
  return current;
}

function projectDirectory(root, rel, replacedFiles) {
  safeRelativePath(rel);
  const target = path.resolve(root, ...rel.split('/'));
  let current = path.resolve(root);
  const segments = rel.split('/');
  for (let index = 0; index < segments.length; index++) {
    current = path.join(current, segments[index]);
    if (!fs.existsSync(current)) continue;
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) throw new Error('peer folder path crosses a symbolic link: ' + rel);
    if (stat.isDirectory()) continue;
    const currentRelative = segments.slice(0, index + 1).join('/');
    if (stat.isFile() && replacedFiles && replacedFiles.has(currentRelative)) return target;
    throw new Error('cannot create a folder through a protected local file: ' + currentRelative);
  }
  return target;
}

function stateFile(root, peerId) {
  return path.join(root, '.carry', 'state', safePeerId(peerId) + '.json');
}

function resolutionFile(root, peerId) {
  return path.join(root, '.carry', 'resolutions', safePeerId(peerId) + '.json');
}

function sessionFile(root, sessionId) {
  const safe = String(sessionId || '');
  if (!/^[a-zA-Z0-9_-]{1,120}$/.test(safe)) throw new Error('invalid sync session id');
  return path.join(root, '.carry', 'sessions', safe + '.json');
}

function readBaseline(root, peerId) {
  const file = stateFile(root, peerId);
  if (!fs.existsSync(file)) return { version: STATE_VERSION, peerId: String(peerId), files: {} };
  try {
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (doc.version !== STATE_VERSION || !doc.files || typeof doc.files !== 'object') throw new Error('bad state');
    return doc;
  } catch {
    throw new Error('sync baseline is corrupt for peer ' + String(peerId).slice(0, 8));
  }
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeFileAtomic(file, JSON.stringify(value, null, 2) + '\n');
}

function validHashOrNull(value) {
  return value === null || (typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value));
}

function readPendingResolutions(root, peerId) {
  const file = resolutionFile(root, peerId);
  if (!fs.existsSync(file)) return Object.create(null);
  try {
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!doc || doc.version !== STATE_VERSION || !doc.entries || typeof doc.entries !== 'object' || Array.isArray(doc.entries)) {
      throw new Error('bad state');
    }
    const entries = Object.create(null);
    for (const [rel, entry] of Object.entries(doc.entries)) {
      safeRelativePath(rel);
      if (!entry || typeof entry !== 'object' || !validHashOrNull(entry.loser) ||
          !validHashOrNull(entry.chosenHash) || !['local', 'remote'].includes(entry.choice) ||
          typeof entry.sessionId !== 'string' || typeof entry.resolvedAt !== 'string') {
        throw new Error('bad entry');
      }
      entries[rel] = entry;
    }
    return entries;
  } catch {
    throw new Error('conflict resolution state is corrupt for peer ' + String(peerId).slice(0, 8));
  }
}

function writePendingResolutions(root, peerId, entries) {
  const file = resolutionFile(root, peerId);
  if (!Object.keys(entries).length) {
    if (fs.existsSync(file)) fs.unlinkSync(file);
    return;
  }
  writeJsonAtomic(file, {
    version: STATE_VERSION,
    peerId: String(peerId),
    updatedAt: new Date().toISOString(),
    entries,
  });
}

function hashBuffer(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function normalizeSyncSourceDeviceId(value) {
  if (value === undefined || value === null || value === '') return null;
  const deviceId = String(value);
  if (!/^[A-Za-z0-9_-]{6,128}$/.test(deviceId)) throw new Error('sync source device is invalid');
  return deviceId;
}

function buildBundle(root, selfAgent, peerId, syncSourceDeviceId, options) {
  options = options || {};
  const streamFiles = options.streamFiles === true;
  const { files, directories } = sync.listProjectEntries(root);
  const hashes = Object.create(null);
  const data = Object.create(null);
  const fileSources = new Map();
  const paused = [];
  const normalizedSource = normalizeSyncSourceDeviceId(syncSourceDeviceId);
  // Push/Pull has one explicitly authoritative device. The destination still
  // returns its hashes so the source can build the same deletion/update plan,
  // but sending every destination byte back wastes roughly half the transfer.
  // Agent memory remains a safe union and is therefore included both ways.
  const metadataOnly = Boolean(normalizedSource && normalizedSource !== String(selfAgent));
  const portablePaths = new Set();

  for (const rel of files) {
    safeRelativePath(rel);
    const portableKey = sync.portablePathKey(rel);
    if (portablePaths.has(portableKey)) throw new Error('project contains paths that alias on another device: ' + rel);
    portablePaths.add(portableKey);
    const full = path.join(root, rel);
    let bytes = null;
    if (streamFiles && rel !== MEMORY_PATH) {
      const before = fs.lstatSync(full);
      if (!before.isFile() || before.isSymbolicLink()) throw new Error('project file changed into an unsafe path: ' + rel);
      hashes[rel] = sync.hashFile(full);
      const after = fs.lstatSync(full);
      if (!after.isFile() || after.isSymbolicLink() || before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
        throw new Error('project file changed while Carry prepared it for sync: ' + rel);
      }
      fileSources.set(rel, {
        file: full,
        size: after.size,
        mtimeMs: after.mtimeMs,
        dev: after.dev,
        ino: after.ino,
        hash: hashes[rel],
      });
    } else {
      bytes = fs.readFileSync(full);
      hashes[rel] = hashBuffer(bytes);
    }
    if (sync.isPaused(root, rel, selfAgent)) {
      paused.push(rel);
      fileSources.delete(rel);
      continue;
    }
    if (rel === MEMORY_PATH) data[rel] = JSON.stringify(memory.readStore(root));
    else if (metadataOnly) fileSources.delete(rel);
    else if (!streamFiles) data[rel] = bytes.toString('base64');
  }

  for (const rel of directories) {
    safeRelativePath(rel);
    const portableKey = sync.portablePathKey(rel);
    if (portablePaths.has(portableKey)) throw new Error('project contains paths that alias on another device: ' + rel);
    portablePaths.add(portableKey);
  }

  const resolutions = [];
  if (peerId) {
    for (const [rel, entry] of Object.entries(readPendingResolutions(root, peerId))) {
      const winner = own(hashes, rel) ? hashes[rel] : null;
      if (winner === entry.loser) continue;
      resolutions.push({ path: rel, winner, loser: entry.loser, resolvedAt: entry.resolvedAt });
    }
  }

  const bundle = {
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
    metadataOnly,
    paused,
    resolutions,
    activeDevice: manifest.readActiveDevice(root),
    syncSourceDeviceId: normalizedSource,
    memoryFile: MEMORY_PATH,
  };
  return streamFiles ? { bundle, fileSources } : bundle;
}

function buildStreamingBundle(root, selfAgent, peerId, syncSourceDeviceId) {
  return buildBundle(root, selfAgent, peerId, syncSourceDeviceId, { streamFiles: true });
}

function validateBundle(bundle) {
  if (!bundle || typeof bundle !== 'object' || !Array.isArray(bundle.files)) {
    throw new Error('peer sent an invalid sync bundle');
  }
  if (!bundle.hashes || typeof bundle.hashes !== 'object' || Array.isArray(bundle.hashes) ||
      !bundle.data || typeof bundle.data !== 'object' || Array.isArray(bundle.data)) {
    throw new Error('peer sync bundle is incomplete');
  }

  const files = [];
  const seen = new Set();
  const portableSeen = new Set();
  for (const value of bundle.files) {
    const rel = safeRelativePath(value);
    const portableKey = sync.portablePathKey(rel);
    if (seen.has(rel) || portableSeen.has(portableKey)) {
      throw new Error('peer sync bundle contains duplicate or aliased paths');
    }
    seen.add(rel);
    portableSeen.add(portableKey);
    const hash = own(bundle.hashes, rel) ? bundle.hashes[rel] : null;
    if (typeof hash !== 'string' || !/^[a-f0-9]{64}$/i.test(hash)) {
      throw new Error('peer sent an invalid hash for ' + rel);
    }
    files.push(rel);
  }

  const hasDirectoryManifest = own(bundle, 'directories');
  if (hasDirectoryManifest && !Array.isArray(bundle.directories)) {
    throw new Error('peer sent an invalid directory manifest');
  }
  const directories = [];
  const directoryKeys = new Set();
  for (const value of hasDirectoryManifest ? bundle.directories : []) {
    const rel = safeRelativePath(value);
    const portableKey = sync.portablePathKey(rel);
    if (portableSeen.has(portableKey)) {
      throw new Error('peer sync bundle contains duplicate or aliased file and folder paths');
    }
    portableSeen.add(portableKey);
    directoryKeys.add(portableKey);
    directories.push(rel);
  }
  if (hasDirectoryManifest) {
    for (const rel of [...directories, ...files]) {
      const segments = rel.split('/');
      for (let count = 1; count < segments.length; count++) {
        const parentKey = sync.portablePathKey(segments.slice(0, count).join('/'));
        if (!directoryKeys.has(parentKey)) {
          throw new Error('peer directory manifest is missing a parent folder for ' + rel);
        }
      }
    }
  }

  const paused = new Set();
  for (const value of Array.isArray(bundle.paused) ? bundle.paused : []) {
    const rel = safeRelativePath(value);
    if (!seen.has(rel)) throw new Error('peer paused an unknown file: ' + rel);
    paused.add(rel);
  }

  const resolutions = Object.create(null);
  for (const entry of Array.isArray(bundle.resolutions) ? bundle.resolutions : []) {
    if (!entry || typeof entry !== 'object') throw new Error('peer sent an invalid conflict resolution');
    const rel = safeRelativePath(entry.path);
    if (rel === MEMORY_PATH || own(resolutions, rel) || !validHashOrNull(entry.winner) ||
        !validHashOrNull(entry.loser) || entry.winner === entry.loser) {
      throw new Error('peer sent an invalid conflict resolution for ' + rel);
    }
    const bundleHash = seen.has(rel) ? String(bundle.hashes[rel]).toLowerCase() : null;
    const winner = typeof entry.winner === 'string' ? entry.winner.toLowerCase() : null;
    const loser = typeof entry.loser === 'string' ? entry.loser.toLowerCase() : null;
    if (winner !== bundleHash) throw new Error('peer conflict resolution does not match its file data for ' + rel);
    const resolvedAt = typeof entry.resolvedAt === 'string' && Number.isFinite(Date.parse(entry.resolvedAt))
      ? new Date(entry.resolvedAt).toISOString()
      : null;
    resolutions[rel] = { winner, loser, resolvedAt };
  }

  let activeDevice = null;
  try { activeDevice = manifest.normalizeActiveDevice(bundle.activeDevice); }
  catch { throw new Error('peer sent invalid active device metadata'); }

  let syncSourceDeviceId = null;
  try { syncSourceDeviceId = normalizeSyncSourceDeviceId(bundle.syncSourceDeviceId); }
  catch { throw new Error('peer sent an invalid sync direction'); }

  const metadataOnly = bundle.metadataOnly === true;
  if (bundle.metadataOnly !== undefined && typeof bundle.metadataOnly !== 'boolean') {
    throw new Error('peer sent invalid bundle content metadata');
  }
  if (metadataOnly && !syncSourceDeviceId) {
    throw new Error('peer omitted file data without selecting a sync source');
  }
  const capabilities = Array.isArray(bundle.capabilities)
    ? bundle.capabilities.filter((value) => typeof value === 'string' && /^[a-z0-9-]{1,64}$/i.test(value)).slice(0, 16)
    : [];

  return {
    files,
    directories,
    hasDirectoryManifest,
    paused,
    resolutions,
    activeDevice,
    syncSourceDeviceId,
    metadataOnly,
    capabilities,
  };
}

function currentHashes(root) {
  const hashes = Object.create(null);
  for (const rel of sync.listFiles(root)) {
    if (rel !== MEMORY_PATH) hashes[rel] = sync.hashFile(path.join(root, rel));
  }
  return hashes;
}

function makePlan(localHashes, remoteHashes, baselineFiles, skippedPaths, resolutionOptions) {
  resolutionOptions = resolutionOptions || {};
  const incomingResolutions = resolutionOptions.incoming || Object.create(null);
  const outgoingResolutions = resolutionOptions.outgoing || Object.create(null);
  const activeDeviceId = resolutionOptions.activeDeviceId || null;
  const activeDeviceUpdatedAt = resolutionOptions.activeDeviceUpdatedAt || null;
  const selfDeviceId = resolutionOptions.selfDeviceId || null;
  const peerDeviceId = resolutionOptions.peerDeviceId || null;
  const syncSourceDeviceId = resolutionOptions.syncSourceDeviceId || null;
  const activeDeviceTime = Number.isFinite(Date.parse(activeDeviceUpdatedAt)) ? Date.parse(activeDeviceUpdatedAt) : null;
  const activeParticipant = activeDeviceId === selfDeviceId || activeDeviceId === peerDeviceId;
  const activeSelectionIsNewer = (entry) => Boolean(activeParticipant && activeDeviceTime !== null && entry &&
    typeof entry.resolvedAt === 'string' && Number.isFinite(Date.parse(entry.resolvedAt)) &&
    activeDeviceTime > Date.parse(entry.resolvedAt));
  const paths = new Set([
    ...Object.keys(localHashes),
    ...Object.keys(remoteHashes),
    ...Object.keys(baselineFiles),
    ...Object.keys(incomingResolutions),
    ...Object.keys(outgoingResolutions),
  ]);
  const actions = [];

  for (const rel of [...paths].sort()) {
    const local = own(localHashes, rel) ? localHashes[rel] : null;
    const remote = own(remoteHashes, rel) ? remoteHashes[rel] : null;
    const hasBaseline = own(baselineFiles, rel);
    const baseline = hasBaseline ? baselineFiles[rel] : undefined;
    let action;

    if (skippedPaths.has(rel)) action = 'skipped';
    else if (local === remote) action = 'same';
    else if (syncSourceDeviceId === selfDeviceId) {
      action = local === null ? 'delete-remote' : 'push';
    } else if (syncSourceDeviceId === peerDeviceId) {
      action = remote === null ? 'delete-local' : 'pull';
    }
    else if (!hasBaseline) {
      if (local === null) action = 'pull';
      else if (remote === null) action = 'push';
      else action = 'conflict';
    } else if (local === baseline && remote !== baseline) {
      action = remote === null ? 'delete-local' : 'pull';
    } else if (remote === baseline && local !== baseline) {
      action = local === null ? 'delete-remote' : 'push';
    } else {
      action = 'conflict';
    }

    let resolution = syncSourceDeviceId && action !== 'same' && action !== 'skipped'
      ? 'sync-direction'
      : null;
    const incomingCandidate = incomingResolutions[rel];
    const pendingCandidate = outgoingResolutions[rel];
    // A newer project-wide handoff is a deliberate replacement for an older
    // conflict choice that never completed. A choice made after the handoff
    // remains a per-file exception and keeps priority.
    const incoming = activeSelectionIsNewer(incomingCandidate) ? null : incomingCandidate;
    const pending = activeSelectionIsNewer(pendingCandidate) ? null : pendingCandidate;
    const outgoing = pending && local !== pending.loser
      ? { winner: local, loser: pending.loser }
      : null;

    if (resolution === 'sync-direction') {
      // Push/Pull is an explicit whole-exchange decision. It supersedes Active
      // Device and older per-file choices, while claimed files remain paused.
    } else if (action !== 'skipped' && incoming && outgoing && incoming.winner !== outgoing.winner) {
      action = 'conflict';
    } else if (action !== 'skipped' && incoming && (!outgoing || incoming.winner === outgoing.winner)) {
      if (remote === incoming.winner && (local === incoming.loser || local === incoming.winner)) {
        action = local === remote ? 'same' : remote === null ? 'delete-local' : 'pull';
        resolution = incoming.winner === outgoing?.winner ? 'agreed' : 'incoming';
      }
    } else if (action !== 'skipped' && outgoing) {
      if (local === outgoing.winner && (remote === outgoing.loser || remote === outgoing.winner)) {
        action = local === remote ? 'same' : local === null ? 'delete-remote' : 'push';
        resolution = 'outgoing';
      }
    } else if (action !== 'skipped' && pending && local === pending.loser && local === remote) {
      resolution = 'cancelled';
    }

    if (action === 'conflict' && !incoming && !pending) {
      if (activeDeviceId === selfDeviceId) {
        action = local === null ? 'delete-remote' : 'push';
        resolution = 'active-device';
      } else if (activeDeviceId === peerDeviceId) {
        action = remote === null ? 'delete-local' : 'pull';
        resolution = 'active-device';
      }
    }

    actions.push({
      path: rel,
      action,
      local,
      remote,
      baseline: hasBaseline ? baseline : undefined,
      ...(resolution ? { resolution } : {}),
    });
  }
  return actions;
}

function nextBaseline(actions, previous) {
  const files = Object.assign(Object.create(null), previous);
  for (const item of actions) {
    if (item.action === 'conflict' || item.action === 'skipped') continue;
    if (item.action === 'pull') files[item.path] = item.remote;
    else if (item.action === 'push') files[item.path] = item.local;
    else if (item.action === 'delete-local' || item.action === 'delete-remote') files[item.path] = null;
    else if (item.action === 'same') files[item.path] = item.local;
  }
  return files;
}

function createSessionId() {
  return new Date().toISOString().replace(/[:.]/g, '-') + '-' + crypto.randomBytes(4).toString('hex');
}

function backupFile(root, sessionId, rel, source, checkpointHash) {
  source = source || projectFile(root, rel);
  if (!fs.existsSync(source)) return null;
  const target = path.join(root, '.carry', 'backups', sessionId, ...rel.split('/'));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const checkpointBlob = checkpointHash ? checkpoints.blobFile(root, checkpointHash) : null;
  if (checkpointBlob && fs.existsSync(checkpointBlob)) linkOrCopyFileAtomic(checkpointBlob, target);
  else copyFileAtomic(source, target);
  return path.relative(root, target).replace(/\\/g, '/');
}

function rollbackPreparedChanges(root, checkpointId, initialFiles, initialDirectories, mutatedPaths) {
  if (!checkpointId) throw new Error('automatic checkpoint is missing');
  const checkpoint = checkpoints.read(root, checkpointId);
  const checkpointFiles = new Map(checkpoint.files.map((item) => [item.path, item]));
  const initialFileSet = new Set(initialFiles);
  const initialDirectorySet = new Set(initialDirectories);
  const touched = [...mutatedPaths];

  // Verify every byte needed for recovery before modifying the partial result.
  for (const rel of touched) {
    if (!initialFileSet.has(rel)) continue;
    const item = checkpointFiles.get(rel);
    if (!item) throw new Error('automatic checkpoint omitted ' + rel);
    checkpoints.verifiedBlobFile(root, item.hash, item.bytes);
  }

  // Remove files created or replaced by the failed apply. Shallow paths go
  // first so a temporary file cannot block recovery of its former children.
  for (const rel of touched.sort((left, right) =>
    left.split('/').length - right.split('/').length || left.localeCompare(right))) {
    const target = projectFile(root, rel);
    if (!fs.existsSync(target)) continue;
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink()) throw new Error('rollback path became a symbolic link: ' + rel);
    if (stat.isFile()) fs.unlinkSync(target);
    else if (!stat.isDirectory()) throw new Error('rollback path became unsafe: ' + rel);
  }

  const createdDirectories = new Set();
  for (const rel of touched) {
    const segments = rel.split('/');
    for (let count = 1; count < segments.length; count++) {
      const parent = segments.slice(0, count).join('/');
      if (!initialDirectorySet.has(parent)) createdDirectories.add(parent);
    }
  }
  for (const rel of sync.listDirectories(root)) {
    if (!initialDirectorySet.has(rel) && touched.some((item) => item === rel || item.startsWith(rel + '/'))) {
      createdDirectories.add(rel);
    }
  }
  for (const rel of [...createdDirectories].sort((left, right) =>
    right.split('/').length - left.split('/').length || right.localeCompare(left))) {
    const directory = projectDirectory(root, rel);
    if (fs.existsSync(directory) && fs.lstatSync(directory).isDirectory() && fs.readdirSync(directory).length === 0) {
      fs.rmdirSync(directory);
    }
  }

  for (const rel of [...initialDirectorySet].sort((left, right) =>
    left.split('/').length - right.split('/').length || left.localeCompare(right))) {
    const directory = projectDirectory(root, rel);
    if (!fs.existsSync(directory)) fs.mkdirSync(directory);
  }
  for (const rel of touched.filter((item) => initialFileSet.has(item)).sort()) {
    const item = checkpointFiles.get(rel);
    const destination = projectFile(root, rel);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    linkOrCopyFileAtomic(checkpoints.verifiedBlobFile(root, item.hash, item.bytes), destination);
  }
}

function summarize(actions) {
  const counts = { pulled: 0, pushed: 0, deletedLocal: 0, deletedRemote: 0, conflicts: 0, skipped: 0, unchanged: 0 };
  for (const item of actions) {
    if (item.action === 'pull') counts.pulled++;
    else if (item.action === 'push') counts.pushed++;
    else if (item.action === 'delete-local') counts.deletedLocal++;
    else if (item.action === 'delete-remote') counts.deletedRemote++;
    else if (item.action === 'conflict') counts.conflicts++;
    else if (item.action === 'skipped') counts.skipped++;
    else counts.unchanged++;
  }
  return counts;
}

function planIncoming(root, peerId, bundle, selfAgent, options) {
  options = options || {};
  const validated = validateBundle(bundle);
  const expectedSyncSource = normalizeSyncSourceDeviceId(options.syncSourceDeviceId);
  if (expectedSyncSource && validated.syncSourceDeviceId && expectedSyncSource !== validated.syncSourceDeviceId) {
    throw new Error('the two devices selected contradictory sync directions');
  }
  const syncSourceDeviceId = expectedSyncSource || validated.syncSourceDeviceId;
  if (syncSourceDeviceId && syncSourceDeviceId !== String(selfAgent) && syncSourceDeviceId !== String(peerId)) {
    throw new Error('sync source must be one of the two paired devices');
  }
  if (validated.metadataOnly && syncSourceDeviceId !== String(selfAgent)) {
    throw new Error('the selected source device omitted file content');
  }
  const activeDevice = manifest.latestActiveDevice(manifest.readActiveDevice(root), validated.activeDevice);
  const baseline = readBaseline(root, peerId);
  const localHashes = options.localHashes || currentHashes(root);
  const localDirectories = options.localDirectories || sync.listDirectories(root);
  const remoteHashes = Object.create(null);
  for (const rel of validated.files) {
    if (rel !== MEMORY_PATH) remoteHashes[rel] = bundle.hashes[rel].toLowerCase();
  }

  const skippedPaths = new Set(validated.paused);
  const candidatePaths = new Set([
    ...Object.keys(localHashes),
    ...Object.keys(remoteHashes),
    ...Object.keys(baseline.files),
  ]);
  for (const rel of candidatePaths) {
    if (sync.isPaused(root, rel, selfAgent)) skippedPaths.add(rel);
  }
  const pendingResolutions = readPendingResolutions(root, peerId);
  const actions = makePlan(localHashes, remoteHashes, baseline.files, skippedPaths, {
    incoming: validated.resolutions,
    outgoing: pendingResolutions,
    activeDeviceId: activeDevice && activeDevice.deviceId,
    activeDeviceUpdatedAt: activeDevice && activeDevice.updatedAt,
    selfDeviceId: String(selfAgent),
    peerDeviceId: String(peerId),
    syncSourceDeviceId,
  });
  return {
    validated,
    syncSourceDeviceId,
    activeDevice,
    baseline,
    localHashes,
    localDirectories,
    remoteHashes,
    skippedPaths,
    actions,
  };
}

function requiredIncomingDataPaths(plan) {
  if (!plan || !plan.validated || !Array.isArray(plan.actions)) {
    throw new Error('incoming sync plan is invalid');
  }
  const required = new Set();
  for (const item of plan.actions) {
    if (item.action === 'pull' || (item.action === 'conflict' && item.remote !== null)) required.add(item.path);
  }
  if (plan.validated.files.includes(MEMORY_PATH) && !plan.skippedPaths.has(MEMORY_PATH)) {
    required.add(MEMORY_PATH);
  }
  return required;
}

function prepareIncoming(root, peerId, bundle, selfAgent, options) {
  options = options || {};
  const preparedPlan = options.preparedPlan || planIncoming(root, peerId, bundle, selfAgent, options);
  const {
    validated,
    syncSourceDeviceId,
    activeDevice,
    baseline,
    localHashes,
    localDirectories,
    actions,
  } = preparedPlan;
  if (options.stagedFiles !== undefined && !(options.stagedFiles instanceof Map)) {
    throw new Error('staged peer files are invalid');
  }
  if (options.stagedText !== undefined && !(options.stagedText instanceof Map)) {
    throw new Error('staged peer text is invalid');
  }
  const stagedFiles = options.stagedFiles || new Map();
  const stagedText = options.stagedText || new Map();
  const incomingRoot = path.resolve(root, '.carry', 'incoming');
  const incomingPrefix = incomingRoot + path.sep;
  const knownRemotePaths = new Set(validated.files);
  for (const [rel, source] of stagedFiles) {
    safeRelativePath(rel);
    if (!knownRemotePaths.has(rel) || rel === MEMORY_PATH || typeof source !== 'string') {
      throw new Error('staged peer file metadata is invalid');
    }
    const resolved = path.resolve(source);
    if (!resolved.startsWith(incomingPrefix) || !fs.existsSync(resolved)) {
      throw new Error('staged peer file escaped Carry incoming storage');
    }
    const stat = fs.lstatSync(resolved);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('staged peer file is not a regular file');
  }
  for (const [rel, value] of stagedText) {
    safeRelativePath(rel);
    if (!knownRemotePaths.has(rel) || typeof value !== 'string') {
      throw new Error('staged peer text metadata is invalid');
    }
  }
  const decoded = new Map();
  const destinations = new Map();
  const actionsByPath = new Map(actions.map((item) => [item.path, item]));
  const replacementDirectories = new Set();
  const directoryCreations = new Map();
  const directoryDeletions = new Map();

  if (validated.hasDirectoryManifest) {
    const localDirectorySet = new Set(localDirectories);
    const remoteDirectorySet = new Set(validated.directories);
    const replacedLocalFiles = new Set(actions
      .filter((item) => item.action === 'delete-local')
      .map((item) => item.path));

    // Smart sync safely unions empty directory structure. If an empty peer
    // directory collides with a preserved local file, the file wins just as
    // it did before directory manifests existed. Explicit Pull/Push receiver
    // mode instead mirrors the selected source exactly.
    if (syncSourceDeviceId !== String(selfAgent)) {
      for (const rel of validated.directories) {
        if (localDirectorySet.has(rel)) continue;
        try {
          directoryCreations.set(rel, projectDirectory(root, rel, replacedLocalFiles));
        } catch (error) {
          if (!syncSourceDeviceId && /protected local file/.test(error.message)) continue;
          throw error;
        }
      }
    }
    if (syncSourceDeviceId === String(peerId)) {
      for (const rel of localDirectories) {
        if (!remoteDirectorySet.has(rel)) directoryDeletions.set(rel, projectDirectory(root, rel));
      }
    }
  }

  const inspectReplacementDirectory = (directory, relative) => {
    let entries;
    try { entries = fs.readdirSync(directory, { withFileTypes: true }); }
    catch (error) { throw new Error(`cannot inspect folder being replaced at ${relative}: ${error.message}`); }
    replacementDirectories.add(directory);
    for (const entry of entries) {
      const childRelative = relative + '/' + entry.name;
      const child = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error('cannot replace a folder containing a symbolic link: ' + childRelative);
      if (entry.isDirectory()) {
        inspectReplacementDirectory(child, childRelative);
        continue;
      }
      if (!entry.isFile() || actionsByPath.get(childRelative)?.action !== 'delete-local') {
        throw new Error('cannot replace a folder containing an unsynced or protected item: ' + childRelative);
      }
    }
  };

  // Resolve every path, including symlink/reparse-point checks, before the
  // first mutation so one bad path cannot cause a partially applied bundle.
  for (const item of actions) {
    if (item.action !== 'pull' && item.action !== 'delete-local') continue;
    const destination = projectFile(root, item.path);
    if (item.action === 'pull' && fs.existsSync(destination) && !fs.statSync(destination).isFile()) {
      if (!fs.statSync(destination).isDirectory()) throw new Error('cannot replace non-file path: ' + item.path);
      inspectReplacementDirectory(destination, item.path);
    }
    if (item.action === 'pull') {
      const segments = item.path.split('/');
      for (let count = 1; count < segments.length; count++) {
        const parentRelative = segments.slice(0, count).join('/');
        const parent = projectFile(root, parentRelative);
        if (fs.existsSync(parent) && !fs.statSync(parent).isDirectory() &&
            actionsByPath.get(parentRelative)?.action !== 'delete-local') {
          throw new Error('cannot create a folder through a protected local file: ' + parentRelative);
        }
      }
    }
    destinations.set(item.path, destination);
  }

  // Validate every incoming byte stream before changing any local file. We
  // also validate conflicting peer bytes because the GUI keeps a read-only
  // snapshot for an exact side-by-side diff.
  for (const item of actions) {
    if (item.action !== 'pull' && !(item.action === 'conflict' && item.remote !== null)) continue;
    if (stagedFiles.has(item.path)) {
      const staged = path.resolve(stagedFiles.get(item.path));
      if (sync.hashFile(staged) !== item.remote) throw new Error('peer data failed integrity check for ' + item.path);
      decoded.set(item.path, { file: staged });
      continue;
    }
    if (!own(bundle.data, item.path) || typeof bundle.data[item.path] !== 'string') {
      throw new Error('peer omitted file data for ' + item.path);
    }
    const bytes = Buffer.from(bundle.data[item.path], 'base64');
    if (hashBuffer(bytes) !== item.remote) throw new Error('peer data failed integrity check for ' + item.path);
    decoded.set(item.path, { bytes });
  }

  const memoryPaused = validated.paused.has(MEMORY_PATH) || sync.isPaused(root, MEMORY_PATH, selfAgent);
  let incomingMemory = null;
  let memoryWillChange = false;
  const incomingMemoryText = stagedText.has(MEMORY_PATH)
    ? stagedText.get(MEMORY_PATH)
    : (own(bundle.data, MEMORY_PATH) ? bundle.data[MEMORY_PATH] : null);
  if (validated.files.includes(MEMORY_PATH) && !memoryPaused && incomingMemoryText !== null) {
    try { incomingMemory = JSON.parse(incomingMemoryText); } catch { throw new Error('peer sent invalid agent memory'); }
    if (!incomingMemory || !Array.isArray(incomingMemory.entities) || !Array.isArray(incomingMemory.relations)) {
      throw new Error('peer sent malformed agent memory');
    }
    const localMemory = memory.readStore(root);
    const preview = memory.mergeStores(localMemory, incomingMemory);
    memoryWillChange = Boolean(incomingMemory.entities.length || incomingMemory.relations.length) &&
      (preview.addedEntities > 0 || preview.addedObs > 0 || preview.addedRels > 0 ||
       (!localMemory.entities.length && !localMemory.relations.length));
  }

  const sessionId = createSessionId();
  const changesLocalProject = actions.some((item) => item.action === 'pull' || item.action === 'delete-local') ||
    directoryCreations.size > 0 || directoryDeletions.size > 0;
  const automaticCheckpoint = changesLocalProject || memoryWillChange
    ? checkpoints.create(root, `Before sync from ${String(peerId).slice(0, 8)}`, {
      kind: 'automatic', sourcePeerId: String(peerId),
    })
    : null;
  const backups = [];
  const conflictCopies = Object.create(null);

  // Checkpoint creation can take noticeable time on a large folder. If an
  // editor changed the working tree after the plan was hashed, stop before
  // applying that now-stale plan; the next sync will calculate a fresh one.
  // Re-hash only when this exchange will mutate project files. This extra
  // read protects a same-sized human edit made during checkpoint creation,
  // while a metadata-only/no-change sync avoids rereading a multi-GiB tree.
  const latestHashes = changesLocalProject ? currentHashes(root) : localHashes;
  const latestDirectories = changesLocalProject ? sync.listDirectories(root).sort() : [...localDirectories].sort();
  const plannedPaths = Object.keys(localHashes).sort();
  const latestPaths = Object.keys(latestHashes).sort();
  if (plannedPaths.length !== latestPaths.length ||
      plannedPaths.some((rel, index) => rel !== latestPaths[index] || localHashes[rel] !== latestHashes[rel])) {
    throw new Error('local files changed while Carry prepared the sync; no peer files were applied, so run Sync again');
  }
  const plannedDirectories = [...localDirectories].sort();
  if (plannedDirectories.length !== latestDirectories.length ||
      plannedDirectories.some((rel, index) => rel !== latestDirectories[index])) {
    throw new Error('local folders changed while Carry prepared the sync; no peer files were applied, so run Sync again');
  }
  const newlyClaimed = actions.find((item) =>
    (item.action === 'pull' || item.action === 'delete-local') && sync.isPaused(root, item.path, selfAgent));
  if (newlyClaimed) {
    throw new Error(`file ${newlyClaimed.path} became active while Carry prepared the sync; no peer files were applied`);
  }

  const directoryActions = [];
  const mutatedPaths = new Set(actions
    .filter((item) => item.action === 'pull' || item.action === 'delete-local')
    .map((item) => item.path));
  for (const rel of directoryCreations.keys()) mutatedPaths.add(rel);
  for (const rel of directoryDeletions.keys()) mutatedPaths.add(rel);
  if (incomingMemory) mutatedPaths.add(MEMORY_PATH);
  const summary = summarize(actions);
  summary.createdDirectories = 0;
  summary.deletedDirectories = 0;
  const result = {
    sessionId,
    peerId: String(peerId),
    actions,
    directoryActions,
    conflicts: actions.filter((item) => item.action === 'conflict').map((item) => item.path),
    skipped: actions.filter((item) => item.action === 'skipped').map((item) => item.path),
    backups,
    conflictCopies,
    memoryChanged: false,
    activeDeviceId: activeDevice ? activeDevice.deviceId : null,
    activeResolved: actions.filter((item) => item.resolution === 'active-device').map((item) => item.path),
    syncSourceDeviceId,
    checkpointId: automaticCheckpoint ? automaticCheckpoint.checkpointId : null,
    summary,
    nextFiles: nextBaseline(actions, baseline.files),
    completedResolutionPaths: actions
      .filter((item) => ['outgoing', 'agreed', 'cancelled', 'active-device', 'sync-direction'].includes(item.resolution))
      .map((item) => item.path),
  };
  const startedAt = new Date().toISOString();
  const sessionPath = sessionFile(root, sessionId);
  const originalManifest = activeDevice
    ? fs.readFileSync(path.join(root, '.carry', 'manifest.json'))
    : null;
  let activeDeviceMerged = false;
  writeJsonAtomic(sessionPath, {
    version: STATE_VERSION,
    sessionId,
    peerId: result.peerId,
    status: 'applying',
    startedAt,
    summary,
    conflicts: result.conflicts,
    skipped: result.skipped,
    backups,
    conflictCopies,
    checkpointId: result.checkpointId,
    activeDeviceId: result.activeDeviceId,
    activeResolved: result.activeResolved,
    syncSourceDeviceId: result.syncSourceDeviceId,
    completedResolutionPaths: result.completedResolutionPaths,
    actions,
    directoryActions,
  });

  try {

  // Do not accept a peer's Active Device handoff until the complete plan has
  // survived checkpointing, working-tree revalidation, and a final claim
  // check. A failed preparation must leave authority metadata unchanged.
  if (activeDevice) {
    manifest.mergeActiveDevice(root, activeDevice);
    activeDeviceMerged = true;
  }

  for (const item of actions) {
    if (item.action !== 'conflict') continue;
    const copies = Object.create(null);
    const copyBase = path.join(root, '.carry', 'conflicts', sessionId, ...item.path.split('/'));
    if (item.local !== null) {
      const localSource = projectFile(root, item.path);
      const localCopy = copyBase + '.local';
      fs.mkdirSync(path.dirname(localCopy), { recursive: true });
      fs.copyFileSync(localSource, localCopy);
      copies.local = path.relative(root, localCopy).replace(/\\/g, '/');
    }
    if (item.remote !== null) {
      const remoteCopy = copyBase + '.remote';
      fs.mkdirSync(path.dirname(remoteCopy), { recursive: true });
      const source = decoded.get(item.path);
      if (source.file) linkOrCopyFileAtomic(source.file, remoteCopy);
      else writeFileAtomic(remoteCopy, source.bytes);
      copies.remote = path.relative(root, remoteCopy).replace(/\\/g, '/');
    }
    conflictCopies[item.path] = copies;
  }

  // Shape changes (folder -> file or file -> folder) require deletions first.
  // Every byte and path above was validated before this mutation phase.
  for (const item of actions) {
    if (item.action === 'delete-local') {
      const destination = destinations.get(item.path);
      const backedUp = backupFile(
        root, sessionId, item.path, destination,
        automaticCheckpoint && automaticCheckpoint.hashes.get(item.path),
      );
      if (backedUp) backups.push(backedUp);
      if (fs.existsSync(destination)) fs.unlinkSync(destination);
    }
  }
  for (const directory of [...replacementDirectories].sort((left, right) => right.length - left.length)) {
    if (fs.existsSync(directory)) fs.rmdirSync(directory);
  }
  for (const item of actions) {
    if (item.action !== 'pull') continue;
    const destination = destinations.get(item.path);
    const backedUp = backupFile(
      root, sessionId, item.path, destination,
      automaticCheckpoint && automaticCheckpoint.hashes.get(item.path),
    );
    if (backedUp) backups.push(backedUp);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    const source = decoded.get(item.path);
    if (source.file) linkOrCopyFileAtomic(source.file, destination);
    else writeFileAtomic(destination, source.bytes);
  }

  let deletedDirectories = 0;
  for (const [rel, directory] of [...directoryDeletions]
    .sort((left, right) => right[0].split('/').length - left[0].split('/').length || right[0].localeCompare(left[0]))) {
    if (!fs.existsSync(directory)) continue;
    const stat = fs.lstatSync(directory);
    if (stat.isFile() && actionsByPath.get(rel)?.action === 'pull') continue;
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error('folder changed into an unsafe path while Carry applied the sync: ' + rel);
    }
    // A claimed file or an unsupported filesystem entry can intentionally
    // keep a destination-only folder non-empty. Never delete through it.
    if (fs.readdirSync(directory).length) continue;
    fs.rmdirSync(directory);
    deletedDirectories++;
    directoryActions.push({ path: rel, action: 'delete-directory' });
  }

  let createdDirectories = 0;
  for (const [rel, directory] of [...directoryCreations]
    .sort((left, right) => left[0].split('/').length - right[0].split('/').length || left[0].localeCompare(right[0]))) {
    if (fs.existsSync(directory)) {
      if (!fs.lstatSync(directory).isDirectory()) {
        throw new Error('folder destination changed into a non-directory while Carry applied the sync: ' + rel);
      }
      continue;
    }
    fs.mkdirSync(directory);
    createdDirectories++;
    directoryActions.push({ path: rel, action: 'create-directory' });
  }

  let memoryResult = null;
  if (incomingMemory) {
    memoryResult = memory.mergeMemoryInto(root, incomingMemory);
  }

  summary.createdDirectories = createdDirectories;
  summary.deletedDirectories = deletedDirectories;
  result.memoryChanged = Boolean(memoryResult && memoryResult.changed);

  writeJsonAtomic(sessionPath, {
    version: STATE_VERSION,
    sessionId,
    peerId: result.peerId,
    status: 'prepared',
    startedAt,
    summary: result.summary,
    conflicts: result.conflicts,
    skipped: result.skipped,
    backups,
    conflictCopies,
    checkpointId: result.checkpointId,
    activeDeviceId: result.activeDeviceId,
    activeResolved: result.activeResolved,
    syncSourceDeviceId: result.syncSourceDeviceId,
    completedResolutionPaths: result.completedResolutionPaths,
    actions,
    directoryActions,
  });
  return result;
  } catch (error) {
    let rollbackError = null;
    try {
      if (automaticCheckpoint) {
        rollbackPreparedChanges(
          root,
          automaticCheckpoint.checkpointId,
          Object.keys(localHashes),
          localDirectories,
          mutatedPaths,
        );
      }
      if (activeDeviceMerged && originalManifest) {
        writeFileAtomic(path.join(root, '.carry', 'manifest.json'), originalManifest);
      }
    } catch (caught) {
      rollbackError = caught;
    }
    const failedAt = new Date().toISOString();
    const failureMessage = rollbackError
      ? `${error.message}; automatic rollback also failed: ${rollbackError.message}`
      : error.message;
    try {
      let session = {};
      try { session = JSON.parse(fs.readFileSync(sessionPath, 'utf8')); } catch { /* rebuild below */ }
      writeJsonAtomic(sessionPath, {
        ...session,
        version: STATE_VERSION,
        sessionId,
        peerId: String(peerId),
        status: 'failed',
        startedAt,
        failedAt,
        error: String(failureMessage || 'sync apply failed').slice(0, 1000),
        rollbackSucceeded: !rollbackError,
        checkpointId: automaticCheckpoint ? automaticCheckpoint.checkpointId : null,
        actions,
        directoryActions,
        backups,
        conflictCopies,
      });
    } catch (sessionError) {
      if (!rollbackError) rollbackError = sessionError;
    }
    if (rollbackError) {
      throw new Error(`sync apply failed (${error.message}); recovery needs attention (${rollbackError.message})`);
    }
    throw error;
  }
}

function commit(root, result) {
  if (!result || !result.sessionId || !result.peerId || !result.nextFiles) {
    throw new Error('cannot commit an invalid sync result');
  }
  const completedAt = new Date().toISOString();
  writeJsonAtomic(stateFile(root, result.peerId), {
    version: STATE_VERSION,
    peerId: result.peerId,
    updatedAt: completedAt,
    files: result.nextFiles,
  });

  if (Array.isArray(result.completedResolutionPaths) && result.completedResolutionPaths.length) {
    const pending = readPendingResolutions(root, result.peerId);
    for (const rel of result.completedResolutionPaths) delete pending[rel];
    writePendingResolutions(root, result.peerId, pending);
  }

  const file = sessionFile(root, result.sessionId);
  let session = {};
  try { session = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* rebuild below */ }
  writeJsonAtomic(file, { ...session, status: 'completed', completedAt });
}

function fail(root, result, error) {
  if (!result || !result.sessionId) return;
  const file = sessionFile(root, result.sessionId);
  let session = {};
  try { session = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return; }
  if (session.status === 'completed') return;
  const failedAt = new Date().toISOString();
  writeJsonAtomic(file, {
    ...session,
    status: 'failed',
    failedAt,
    error: String(error && error.message ? error.message : error || 'sync did not complete').slice(0, 1000),
  });
}

function conflictSnapshotFile(root, relative) {
  const normalized = String(relative || '').replace(/\\/g, '/');
  if (!normalized.startsWith('.carry/conflicts/') || normalized.includes('\0') ||
      path.posix.normalize(normalized) !== normalized) {
    throw new Error('saved conflict snapshot path is invalid');
  }
  const target = path.resolve(root, ...normalized.split('/'));
  const prefix = path.resolve(root, '.carry', 'conflicts');
  if (!target.startsWith(prefix + path.sep)) throw new Error('saved conflict snapshot escapes the project');
  let current = path.resolve(root);
  for (const segment of normalized.split('/')) {
    current = path.join(current, segment);
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) {
      throw new Error('saved conflict snapshot crosses a symbolic link');
    }
  }
  return target;
}

function readConflictSession(root, sessionId) {
  const file = sessionFile(root, sessionId);
  if (!fs.existsSync(file)) throw Object.assign(new Error('Sync session was not found'), { statusCode: 404 });
  try {
    const session = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!session || session.sessionId !== sessionId || typeof session.peerId !== 'string') throw new Error('bad session');
    return session;
  } catch (err) {
    if (err && err.statusCode) throw err;
    throw new Error('saved sync session is corrupt');
  }
}

function prepareConflictResolution(root, session, rel, choice) {
  safeRelativePath(rel);
  if (session.resolutions && session.resolutions[rel]) {
    throw Object.assign(new Error('This conflict has already been resolved'), { statusCode: 409 });
  }
  const action = Array.isArray(session.actions)
    ? session.actions.find((item) => item.path === rel && item.action === 'conflict')
    : null;
  const copies = session.conflictCopies && session.conflictCopies[rel];
  if (!action || !copies) throw Object.assign(new Error('No saved conflict exists for this file'), { statusCode: 404 });

  const chosenHash = action[choice];
  const loserHash = action[choice === 'local' ? 'remote' : 'local'];
  if (!validHashOrNull(chosenHash) || !validHashOrNull(loserHash) || chosenHash === loserHash) {
    throw new Error('saved conflict metadata is invalid');
  }

  let chosenBytes = null;
  if (chosenHash !== null) {
    const savedRelative = copies[choice];
    if (!savedRelative) throw new Error(`saved ${choice} conflict version is missing`);
    const saved = conflictSnapshotFile(root, savedRelative);
    if (!fs.existsSync(saved) || !fs.statSync(saved).isFile()) {
      throw new Error(`saved ${choice} conflict version is missing`);
    }
    chosenBytes = fs.readFileSync(saved);
    if (hashBuffer(chosenBytes) !== String(chosenHash).toLowerCase()) {
      throw new Error(`saved ${choice} conflict version failed its integrity check`);
    }
  }

  const destination = projectFile(root, rel);
  let currentHash = null;
  if (fs.existsSync(destination)) {
    if (!fs.statSync(destination).isFile()) throw new Error('cannot resolve conflict over a non-file path: ' + rel);
    currentHash = sync.hashFile(destination);
  }
  if (currentHash !== action.local && currentHash !== action.remote) {
    throw Object.assign(new Error('This working file changed after the conflict. Sync or save it separately before choosing a saved version.'), { statusCode: 409 });
  }

  return { session, rel, choice, action, chosenHash, loserHash, chosenBytes, destination, currentHash };
}

function resolveConflicts(root, items, choice) {
  if (!['local', 'remote'].includes(choice)) throw new Error('choose either this device or the peer version');
  if (!Array.isArray(items) || !items.length) {
    throw Object.assign(new Error('Select at least one conflict to resolve'), { statusCode: 400 });
  }
  if (items.length > MAX_BATCH_CONFLICTS) {
    throw Object.assign(new Error(`Resolve no more than ${MAX_BATCH_CONFLICTS} conflicts at once`), { statusCode: 400 });
  }

  // Validate every requested snapshot and current working file before making
  // the first mutation. One working path cannot safely choose two peer
  // versions from separate team sessions in the same batch.
  const sessions = new Map();
  const paths = new Set();
  const plans = [];
  for (const item of items) {
    const sessionId = String(item && item.sessionId || '');
    const rel = String(item && item.path || '');
    safeRelativePath(rel);
    if (paths.has(rel)) {
      throw Object.assign(new Error(`Select only one saved conflict for ${rel} in each bulk decision`), { statusCode: 409 });
    }
    paths.add(rel);
    let session = sessions.get(sessionId);
    if (!session) {
      session = readConflictSession(root, sessionId);
      sessions.set(sessionId, session);
    }
    plans.push(prepareConflictResolution(root, session, rel, choice));
  }

  const changedPlans = plans.filter((plan) => plan.currentHash !== plan.chosenHash);
  const safetyCheckpoint = changedPlans.length
    ? checkpoints.create(root, `Before resolving ${plans.length} conflict${plans.length === 1 ? '' : 's'}`, { kind: 'restore-safety' })
    : null;

  for (const plan of changedPlans) {
    if (plan.chosenHash === null) {
      if (fs.existsSync(plan.destination)) fs.unlinkSync(plan.destination);
    } else {
      fs.mkdirSync(path.dirname(plan.destination), { recursive: true });
      writeFileAtomic(plan.destination, plan.chosenBytes);
    }
  }

  const resolvedAt = new Date().toISOString();
  const pendingByPeer = new Map();
  const results = [];
  for (const plan of plans) {
    let pending = pendingByPeer.get(plan.session.peerId);
    if (!pending) {
      pending = readPendingResolutions(root, plan.session.peerId);
      pendingByPeer.set(plan.session.peerId, pending);
    }
    pending[plan.rel] = {
      sessionId: plan.session.sessionId,
      choice,
      chosenHash: plan.chosenHash === null ? null : String(plan.chosenHash).toLowerCase(),
      loser: plan.loserHash === null ? null : String(plan.loserHash).toLowerCase(),
      resolvedAt,
    };

    const resolutions = plan.session.resolutions || (plan.session.resolutions = {});
    resolutions[plan.rel] = {
      choice,
      chosenHash: pending[plan.rel].chosenHash,
      resolvedAt,
      checkpointId: safetyCheckpoint ? safetyCheckpoint.checkpointId : null,
    };
    results.push({
      sessionId: plan.session.sessionId,
      peerId: plan.session.peerId,
      path: plan.rel,
      choice,
      chosenHash: pending[plan.rel].chosenHash,
      checkpointId: safetyCheckpoint ? safetyCheckpoint.checkpointId : null,
    });
  }

  for (const [peerId, pending] of pendingByPeer) writePendingResolutions(root, peerId, pending);
  for (const session of sessions.values()) writeJsonAtomic(sessionFile(root, session.sessionId), session);

  return {
    choice,
    count: results.length,
    checkpointId: safetyCheckpoint ? safetyCheckpoint.checkpointId : null,
    results,
  };
}

function resolveConflict(root, sessionId, rel, choice) {
  const batch = resolveConflicts(root, [{ sessionId, path: rel }], choice);
  return batch.results[0];
}

function listSessions(root, limit) {
  const dir = path.join(root, '.carry', 'sessions');
  if (!fs.existsSync(dir)) return [];
  const sessions = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    try {
      const session = JSON.parse(fs.readFileSync(path.join(dir, entry.name), 'utf8'));
      if (session && session.sessionId) sessions.push(session);
    } catch { /* ignore an incomplete diagnostic record */ }
  }
  sessions.sort((a, b) => String(b.completedAt || b.startedAt || '').localeCompare(String(a.completedAt || a.startedAt || '')));
  const count = Number.isInteger(limit) && limit >= 0 ? limit : 20;
  return sessions.slice(0, count);
}

function previewLocalChanges(root, peerId) {
  const baseline = readBaseline(root, peerId);
  const local = currentHashes(root);
  const paths = new Set([...Object.keys(local), ...Object.keys(baseline.files)]);
  const changes = [];
  for (const rel of [...paths].sort()) {
    const hasLocal = own(local, rel);
    const hasBaseline = own(baseline.files, rel);
    const localHash = hasLocal ? local[rel] : null;
    const baselineHash = hasBaseline ? baseline.files[rel] : undefined;
    if (!hasBaseline && hasLocal) changes.push({ path: rel, action: 'added' });
    else if (baselineHash !== null && !hasLocal) changes.push({ path: rel, action: 'deleted' });
    else if (hasLocal && localHash !== baselineHash) {
      changes.push({ path: rel, action: baselineHash === null ? 'added' : 'modified' });
    }
  }
  return changes;
}

module.exports = {
  MEMORY_PATH,
  buildBundle,
  buildStreamingBundle,
  validateBundle,
  safeRelativePath,
  readBaseline,
  makePlan,
  planIncoming,
  requiredIncomingDataPaths,
  prepareIncoming,
  commit,
  fail,
  resolveConflict,
  resolveConflicts,
  listSessions,
  previewLocalChanges,
  normalizeSyncSourceDeviceId,
};
