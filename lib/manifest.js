'use strict';

const fs = require('fs');
const net = require('net');
const path = require('path');
const crypto = require('crypto');
const { writeFileAtomic } = require('./fsx');

const CARRY_DIR = '.carry';
const MANIFEST = 'manifest.json';
const PRIVATE_GITIGNORE = '.gitignore';
const VERSION = 1;
const DEVICE_ID = /^[a-zA-Z0-9_-]{6,128}$/;
const ACTIVE_CHANGE_ID = /^[a-f0-9]{16,64}$/i;
const SPECIAL_OBJECT_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const TRANSPORT_SECRET = /^[A-Za-z0-9_-]{6,128}$/;
const LAN_SECRET = /^[A-F0-9]{32}$/i;
const REMOTE_SECRET = /^[A-Za-z0-9_-]{43,128}$/;

// A "carry project" is any folder containing a .carry/manifest.json. We never
// touch .git — git stays git's job. .carry holds only our own metadata.
function carryDir(root) {
  return path.join(root, CARRY_DIR);
}

function manifestFile(root) {
  return path.join(carryDir(root), MANIFEST);
}

function findCarryRoot(start) {
  let dir = path.resolve(start || process.cwd());
  for (;;) {
    if (fs.existsSync(manifestFile(dir)) && fs.statSync(manifestFile(dir)).isFile()) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function newDeviceId() {
  return crypto.randomBytes(8).toString('hex');
}

function makePairCode() {
  // 6 chars, easy to read aloud: omit ambiguous 0/O/1/I/L.
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let out = '';
  const bytes = crypto.randomBytes(6);
  for (let i = 0; i < 6; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

function validateManifest(doc) {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc) || doc.version !== VERSION ||
      !DEVICE_ID.test(String(doc.deviceId || '')) || typeof doc.name !== 'string' ||
      !doc.name.trim() || doc.name.length > 80 || /[\r\n\0]/.test(doc.name) ||
      !doc.peers || typeof doc.peers !== 'object' || Array.isArray(doc.peers)) {
    throw new Error('required project identity fields are invalid');
  }
  const peers = Object.create(null);
  for (const [id, info] of Object.entries(doc.peers)) {
    if (!DEVICE_ID.test(id) || SPECIAL_OBJECT_KEYS.has(id) || id === doc.deviceId ||
        !info || typeof info !== 'object' || Array.isArray(info) ||
        typeof info.name !== 'string' || !info.name.trim() || info.name.length > 80 || /[\r\n\0]/.test(info.name) ||
        !['lan', 'relay'].includes(info.transport) ||
        (info.address !== null && info.address !== undefined &&
          (typeof info.address !== 'string' || info.address.length > 2048 || /[\r\n\0]/.test(info.address))) ||
        (info.port !== null && info.port !== undefined &&
          (!Number.isInteger(info.port) || info.port < 1 || info.port > 65535)) ||
        (info.pairCode !== null && info.pairCode !== undefined && !TRANSPORT_SECRET.test(String(info.pairCode))) ||
        (info.teamCode !== null && info.teamCode !== undefined && !TRANSPORT_SECRET.test(String(info.teamCode))) ||
        (info.connectionEnabled !== undefined && typeof info.connectionEnabled !== 'boolean')) {
      throw new Error('trusted peer metadata is invalid');
    }
    if (info.connectionEnabled === undefined) info.connectionEnabled = true;
    peers[id] = info;
  }
  doc.peers = peers;
  if (doc.allowlist === undefined) doc.allowlist = [];
  if (!Array.isArray(doc.allowlist) || doc.allowlist.some((id) =>
    !DEVICE_ID.test(String(id || '')) || SPECIAL_OBJECT_KEYS.has(String(id)))) {
    throw new Error('device allowlist is invalid');
  }
  doc.allowlist = [...new Set(doc.allowlist.map(String))];
  if (doc.activeDevice !== undefined && doc.activeDevice !== null) normalizeActiveDevice(doc.activeDevice);
  return doc;
}

function readManifest(root) {
  const f = manifestFile(root);
  if (!fs.existsSync(f)) return null;
  try {
    const doc = JSON.parse(fs.readFileSync(f, 'utf8'));
    return validateManifest(doc);
  } catch (error) {
    throw new Error(`Carry project metadata is corrupt; the existing manifest was left unchanged (${error.message})`);
  }
}

function writeManifest(root, doc) {
  fs.mkdirSync(carryDir(root), { recursive: true });
  const privateIgnore = path.join(carryDir(root), PRIVATE_GITIGNORE);
  if (!fs.existsSync(privateIgnore)) {
    writeFileAtomic(privateIgnore, '*\n!.gitignore\n');
  }
  writeFileAtomic(manifestFile(root), JSON.stringify(doc, null, 2) + '\n');
}

// Initialize a folder as a carry project. Idempotent: an existing manifest is
// preserved (device id + peers survive a re-init).
function init(root, name) {
  const existing = readManifest(root);
  if (existing) return { root, manifest: existing, created: false };
  const manifest = {
    version: VERSION,
    name: name || path.basename(path.resolve(root)),
    deviceId: newDeviceId(),
    peers: {},
    // allowlist: device ids permitted to join OUR relay rooms. Empty = open
    // (legacy). During setup we pre-authorize the trusted peer so a stranger
    // with the code still cannot connect.
    allowlist: [],
    createdAt: new Date().toISOString(),
  };
  writeManifest(root, manifest);
  return { root, manifest, created: true };
}

// Register a peer by its device id + display name. `opts.address` (peer's LAN IP)
// is stored so `carry sync` can reach it later. The pairing code itself is NOT
// stored — it rotates each pairing. (Full allowlist-aware definition below.)
function touchPeer(root, deviceId) {
  const manifest = readManifest(root);
  if (!manifest || !manifest.peers[deviceId]) return;
  manifest.peers[deviceId].lastSeen = new Date().toISOString();
  writeManifest(root, manifest);
}

function updateLanEndpoint(root, deviceId, address, port) {
  const doc = readManifest(root);
  const id = String(deviceId || '');
  const normalizedAddress = String(address || '').trim();
  if (!doc || !doc.peers || !Object.prototype.hasOwnProperty.call(doc.peers, id)) {
    throw new Error('paired LAN device was not found');
  }
  if (doc.peers[id].transport !== 'lan' || net.isIP(normalizedAddress) === 0 ||
      !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('discovered LAN endpoint is invalid');
  }
  doc.peers[id].address = normalizedAddress;
  doc.peers[id].port = port;
  doc.peers[id].lastSeen = new Date().toISOString();
  writeManifest(root, doc);
  return { address: normalizedAddress, port };
}

function listPeers(root) {
  const manifest = readManifest(root);
  if (!manifest) return [];
  return Object.entries(manifest.peers).map(([id, info]) => ({ deviceId: id, ...info }));
}

function normalizeActiveDevice(value) {
  if (value === null || value === undefined) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      !DEVICE_ID.test(String(value.deviceId || '')) ||
      typeof value.updatedAt !== 'string' || value.updatedAt.length > 40 ||
      !Number.isFinite(Date.parse(value.updatedAt)) ||
      !ACTIVE_CHANGE_ID.test(String(value.changeId || ''))) {
    throw new Error('active device metadata is invalid');
  }
  return {
    deviceId: String(value.deviceId),
    updatedAt: new Date(value.updatedAt).toISOString(),
    changeId: String(value.changeId).toLowerCase(),
  };
}

function readActiveDevice(root) {
  const doc = readManifest(root);
  if (!doc) return null;
  try { return normalizeActiveDevice(doc.activeDevice); }
  catch { return null; }
}

function latestActiveDevice(first, second) {
  const left = normalizeActiveDevice(first);
  const right = normalizeActiveDevice(second);
  if (!left) return right;
  if (!right) return left;
  const timeOrder = left.updatedAt.localeCompare(right.updatedAt);
  if (timeOrder !== 0) return timeOrder > 0 ? left : right;
  return left.changeId.localeCompare(right.changeId) >= 0 ? left : right;
}

function setActiveDevice(root, deviceId) {
  const doc = readManifest(root);
  if (!doc) throw new Error('not a carry project — run `carry init` first');
  const id = String(deviceId || '');
  if (!DEVICE_ID.test(id) || (id !== doc.deviceId && !Object.prototype.hasOwnProperty.call(doc.peers || {}, id))) {
    throw new Error('choose this device or a paired device as the active device');
  }
  let current = null;
  try { current = normalizeActiveDevice(doc.activeDevice); } catch { /* replace corrupt optional metadata */ }
  const updatedAt = new Date(Math.max(Date.now(), current ? Date.parse(current.updatedAt) + 1 : 0)).toISOString();
  doc.activeDevice = {
    deviceId: id,
    updatedAt,
    changeId: crypto.randomBytes(12).toString('hex'),
  };
  writeManifest(root, doc);
  return normalizeActiveDevice(doc.activeDevice);
}

function mergeActiveDevice(root, incoming) {
  const doc = readManifest(root);
  if (!doc) return null;
  const current = readActiveDevice(root);
  const winner = latestActiveDevice(current, incoming);
  if (winner && (!current || winner.updatedAt !== current.updatedAt || winner.changeId !== current.changeId)) {
    doc.activeDevice = winner;
    writeManifest(root, doc);
  }
  return winner;
}

// --- Device allowlist (trusted-device enforcement) ---
// The allowlist holds device ids that may join relay rooms we host. A peer we
// successfully pair with is added automatically; `authorizeDevice` lets the
// setup wizard pre-authorize a known id before pairing.

function readAllowlist(root) {
  const m = readManifest(root);
  return m && Array.isArray(m.allowlist) ? m.allowlist.slice() : [];
}

function isAuthorized(root, deviceId) {
  const list = readAllowlist(root);
  return list.some((id) => cryptoSafeEqual(id, deviceId));
}

function authorizeDevice(root, deviceId, name) {
  const doc = readManifest(root);
  const id = String(deviceId || '');
  if (!DEVICE_ID.test(id) || SPECIAL_OBJECT_KEYS.has(id) || (doc && id === doc.deviceId)) {
    throw new Error('authorized device identity is invalid');
  }
  if (!doc) throw new Error('not a carry project — run `carry init` first');
  if (!Array.isArray(doc.allowlist)) doc.allowlist = [];
  if (!doc.allowlist.some((allowedId) => cryptoSafeEqual(allowedId, id))) {
    doc.allowlist.push(id);
    writeManifest(root, doc);
  }
  return doc.allowlist.slice();
}

// When we pair with a peer, authorize it so future relay sessions from that
// device are accepted without re-approval.
function addPeer(root, deviceId, peerName, transport, opts) {
  opts = opts || {};
  const doc = readManifest(root);
  if (!doc) throw new Error('not a carry project — run `carry init` first');
  const id = String(deviceId || '');
  const name = String(peerName || '').trim();
  const peerTransport = transport || 'lan';
  if (!DEVICE_ID.test(id) || SPECIAL_OBJECT_KEYS.has(id) || id === doc.deviceId) throw new Error('peer device identity is invalid');
  if (!name || name.length > 80 || /[\r\n\0]/.test(name)) throw new Error('peer device name is invalid');
  if (!['lan', 'relay'].includes(peerTransport)) throw new Error('peer transport is invalid');
  if (opts.port !== undefined && opts.port !== null &&
      (!Number.isInteger(opts.port) || opts.port < 1 || opts.port > 65535)) throw new Error('peer port is invalid');
  if (opts.pairCode && peerTransport === 'lan' && !LAN_SECRET.test(String(opts.pairCode))) {
    throw new Error('LAN peer transport secret is invalid');
  }
  if (opts.pairCode && peerTransport === 'relay' && !REMOTE_SECRET.test(String(opts.pairCode))) {
    throw new Error('remote peer transport secret is invalid');
  }
  if (opts.teamCode && !REMOTE_SECRET.test(String(opts.teamCode))) throw new Error('peer team secret is invalid');
  doc.peers[id] = {
    name,
    transport: peerTransport,
    address: opts.address || null,
    port: Number.isInteger(opts.port) ? opts.port : null,
    pairCode: opts.pairCode || null,
    teamCode: opts.teamCode || null,
    connectionEnabled: true,
    pairedAt: new Date().toISOString(),
    lastSeen: new Date().toISOString(),
  };
  if (!Array.isArray(doc.allowlist)) doc.allowlist = [];
  if (!doc.allowlist.some((allowedId) => cryptoSafeEqual(allowedId, id))) {
    doc.allowlist.push(id);
  }
  writeManifest(root, doc);
  return doc;
}

// Pause or resume a paired device without discarding its identity, transport
// keys, sync baseline, or activity history. A paused device is removed from
// the runtime allowlist until the user explicitly reconnects it.
function setPeerConnection(root, deviceId, enabled) {
  const doc = readManifest(root);
  if (!doc) throw new Error('not a carry project — run `carry init` first');
  const id = String(deviceId || '');
  if (!doc.peers || !Object.prototype.hasOwnProperty.call(doc.peers, id)) return false;
  doc.peers[id].connectionEnabled = enabled === true;
  if (!Array.isArray(doc.allowlist)) doc.allowlist = [];
  if (enabled === true) {
    if (!doc.allowlist.some((allowedId) => cryptoSafeEqual(allowedId, id))) doc.allowlist.push(id);
  } else {
    doc.allowlist = doc.allowlist.filter((allowedId) => !cryptoSafeEqual(allowedId, id));
  }
  writeManifest(root, doc);
  return true;
}

// Forget a paired device and revoke its permission to reconnect. Sync history
// is deliberately left intact so the activity view remains useful.
function removePeer(root, deviceId) {
  const doc = readManifest(root);
  if (!doc) throw new Error('not a carry project — run `carry init` first');
  const id = String(deviceId || '');
  if (!doc.peers || !Object.prototype.hasOwnProperty.call(doc.peers, id)) return false;
  delete doc.peers[id];
  if (Array.isArray(doc.allowlist)) {
    doc.allowlist = doc.allowlist.filter((allowedId) => !cryptoSafeEqual(allowedId, id));
  }
  if (doc.activeDevice && cryptoSafeEqual(doc.activeDevice.deviceId, id)) {
    doc.activeDevice = {
      deviceId: doc.deviceId,
      updatedAt: new Date().toISOString(),
      changeId: crypto.randomBytes(12).toString('hex'),
    };
  }
  writeManifest(root, doc);
  return true;
}

function cryptoSafeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  try { return crypto.timingSafeEqual(ab, bb); } catch { return false; }
}

module.exports = {
  CARRY_DIR,
  MANIFEST,
  VERSION,
  carryDir,
  manifestFile,
  findCarryRoot,
  readManifest,
  init,
  addPeer,
  setPeerConnection,
  removePeer,
  touchPeer,
  updateLanEndpoint,
  listPeers,
  normalizeActiveDevice,
  readActiveDevice,
  latestActiveDevice,
  setActiveDevice,
  mergeActiveDevice,
  readAllowlist,
  isAuthorized,
  authorizeDevice,
  newDeviceId,
  makePairCode,
};
