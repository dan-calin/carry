'use strict';

// Carry crypto layer — authenticated encryption for all sync frames.
//
// SECURITY MODEL
// --------------
// Every frame that leaves a device (over LAN TCP, or through the relay/tunnel)
// is encrypted with AES-256-GCM using a key derived via HKDF-SHA256. LAN mode
// uses a random 128-bit per-pair secret; remote mode uses a random 256-bit
// invitation secret. The shared secret is NEVER transmitted in cleartext.
// Consequences:
//
//   * The hosted relay (or optional self-hosted tunnel) sees ONLY ciphertext.
//     It cannot read frame types, device ids, or byte contents.
//   * An attacker who discovers the relay URL reaches a service that speaks
//     ciphertext it cannot decrypt, and any forged frame fails the GCM tag.
//   * Public remote invitations use a high-entropy secret kept after the URL
//     fragment. Browsers/WebSocket requests do not send that fragment to the
//     relay; only a one-way room hash and ciphertext reach the service.
//
// This is symmetric (both peers share a secret). No long-term server secret is
// needed; the relay remains stateless w.r.t. plaintext. Forward secrecy is out
// of scope for v1. Re-pair devices to rotate a remote secret.

const crypto = require('crypto');

const KEY_BYTES = 32;   // AES-256
const NONCE_BYTES = 12; // GCM standard nonce
const TAG_BYTES = 16;   // GCM auth tag
const SALT_BYTES = 16;

// Binary v2 removes the nested base64 layer used by JSON sync chunks. The
// relay can recognize the fixed outer envelope, but metadata and file bytes
// are encrypted together and remain opaque. The fixed header is included as
// AES-GCM additional authenticated data, so it cannot be changed without
// invalidating the frame.
const BINARY_MAGIC = Buffer.from('CRB2', 'ascii');
const BINARY_FLAGS_OFFSET = BINARY_MAGIC.length;
const BINARY_SALT_OFFSET = BINARY_FLAGS_OFFSET + 1;
const BINARY_NONCE_OFFSET = BINARY_SALT_OFFSET + SALT_BYTES;
const BINARY_HEADER_BYTES = BINARY_NONCE_OFFSET + NONCE_BYTES;
const BINARY_INFO = 'carry-encrypted-binary-v2';
const BINARY_AAD_DOMAIN = Buffer.from('carry-binary-envelope-v2\0', 'utf8');
const MAX_BINARY_METADATA_BYTES = 16 * 1024;
const MAX_BINARY_PAYLOAD_BYTES = 64 * 1024 * 1024;
const MIN_BINARY_PLAINTEXT_BYTES = 4 + 2; // metadata length + at least `{}`
const MIN_BINARY_ENVELOPE_BYTES = BINARY_HEADER_BYTES + MIN_BINARY_PLAINTEXT_BYTES + TAG_BYTES;
const MAX_BINARY_ENVELOPE_BYTES = BINARY_HEADER_BYTES + 4 +
  MAX_BINARY_METADATA_BYTES + MAX_BINARY_PAYLOAD_BYTES + TAG_BYTES;
const SESSION_BINDING_PATTERN = /^[a-f0-9]{64}$/;
const SESSION_WRAPPER_TYPE = 'carry-authenticated-session-v1';

// HKDF-SHA256 (RFC 5869), single expansion step. Used to turn the pairing secret
// into a fixed-length symmetric key with a domain-separated salt + info.
function deriveKey(code, salt, info) {
  const prk = crypto.createHmac('sha256', salt).update(Buffer.from(code, 'utf8')).digest();
  const infoBuf = Buffer.from(info, 'utf8');
  const okm = crypto.createHmac('sha256', prk)
    .update(infoBuf)
    .update(Buffer.from([0x01]))
    .digest();
  return okm.slice(0, KEY_BYTES);
}

// Build a session key from a pairing secret. `salt` + `info` are sent in the
// clear alongside ciphertext but domain-separate the key so that even the same
// code yields different keys for different rooms/versions.
function sessionKey(code, salt, info) {
  return deriveKey(code, salt, info || 'carry-sync-v1');
}

// Encrypt a JSON-serialisable object. Returns a compact plaintext envelope the
// relay can forward verbatim without understanding it:
//   { v, s, i, n, c }  where c = base64 ciphertext+tag, n = base64 nonce
function encryptFrame(obj, code, salt, info) {
  const key = sessionKey(code, salt, info);
  const nonce = crypto.randomBytes(NONCE_BYTES);
  const plaintext = Buffer.from(JSON.stringify(obj), 'utf8');
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
  const enc = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  const payload = Buffer.concat([enc, tag]); // GCM: ciphertext || tag
  return {
    v: 1,
    s: salt.toString('base64'),
    i: info || 'carry-sync-v1',
    n: nonce.toString('base64'),
    c: payload.toString('base64'),
  };
}

// Decrypt a frame envelope produced by encryptFrame. Throws if the auth tag
// does not verify (tampered frame, wrong code, or relay injection).
function decryptFrame(env, code, expectedInfo) {
  if (!env || env.v !== 1 || !env.c || !env.n || !env.s) {
    throw new Error('malformed encrypted frame');
  }
  if (typeof env.i !== 'string' || env.i.length < 1 || env.i.length > 256 ||
      (expectedInfo !== undefined && env.i !== expectedInfo)) {
    throw new Error('encrypted frame context does not match this session');
  }
  const key = sessionKey(code, Buffer.from(env.s, 'base64'), env.i);
  const nonce = Buffer.from(env.n, 'base64');
  const payload = Buffer.from(env.c, 'base64');
  if (payload.length < TAG_BYTES) throw new Error('ciphertext too short');
  const enc = payload.slice(0, payload.length - TAG_BYTES);
  const tag = payload.slice(payload.length - TAG_BYTES);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAuthTag(tag);
  let plaintext;
  try {
    plaintext = Buffer.concat([decipher.update(enc), decipher.final()]);
  } catch (e) {
    throw new Error('frame authentication failed — wrong code or tampered relay frame');
  }
  return JSON.parse(plaintext.toString('utf8'));
}

function binaryPayloadBuffer(payload) {
  if (Buffer.isBuffer(payload)) return payload;
  if (payload instanceof ArrayBuffer) return Buffer.from(payload);
  if (ArrayBuffer.isView(payload)) {
    return Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength);
  }
  throw new Error('binary frame payload must be bytes');
}

function validateBinaryMetadata(frame) {
  if (!frame || typeof frame !== 'object' || Array.isArray(frame)) {
    throw new Error('binary frame metadata must be an object');
  }
  if (typeof frame.type !== 'string' || frame.type.length < 1 || frame.type.length > 128 ||
      /[\r\n\0]/.test(frame.type)) {
    throw new Error('binary frame metadata has an invalid type');
  }
  if (Object.prototype.hasOwnProperty.call(frame, 'data')) {
    throw new Error('binary frame metadata must not contain data');
  }
}

function binaryHeader(salt, nonce) {
  if (!Buffer.isBuffer(salt) || salt.length !== SALT_BYTES) {
    throw new Error('binary frame salt must be 16 bytes');
  }
  if (!Buffer.isBuffer(nonce) || nonce.length !== NONCE_BYTES) {
    throw new Error('binary frame nonce must be 12 bytes');
  }
  const header = Buffer.alloc(BINARY_HEADER_BYTES);
  BINARY_MAGIC.copy(header, 0);
  header[BINARY_FLAGS_OFFSET] = 0;
  salt.copy(header, BINARY_SALT_OFFSET);
  nonce.copy(header, BINARY_NONCE_OFFSET);
  return header;
}

function validateBinaryEnvelope(value) {
  if (!Buffer.isBuffer(value)) throw new Error('binary encrypted frame must be a Buffer');
  if (value.length < MIN_BINARY_ENVELOPE_BYTES) throw new Error('binary encrypted frame is truncated');
  if (value.length > MAX_BINARY_ENVELOPE_BYTES) throw new Error('binary encrypted frame exceeds Carry limit');
  if (!value.subarray(0, BINARY_MAGIC.length).equals(BINARY_MAGIC)) {
    throw new Error('unrecognized binary encrypted frame');
  }
  if (value[BINARY_FLAGS_OFFSET] !== 0) throw new Error('unsupported binary encrypted frame flags');
  return value;
}

// Encrypt bounded JSON metadata plus an opaque byte payload without base64.
// Wire format:
//   magic/flags | salt | nonce | AES-GCM(metaLength | metadata | payload) | tag
// Only the fixed header and total ciphertext size are visible to the relay.
function encryptBinaryFrame(frame, payload, code, salt, info = BINARY_INFO) {
  validateBinaryMetadata(frame);
  const bytes = binaryPayloadBuffer(payload);
  if (bytes.length > MAX_BINARY_PAYLOAD_BYTES) {
    throw new Error('binary frame payload exceeds Carry limit');
  }

  let metadataJson;
  try { metadataJson = JSON.stringify(frame); }
  catch { throw new Error('binary frame metadata is not serializable'); }
  if (typeof metadataJson !== 'string') throw new Error('binary frame metadata is not serializable');
  try { validateBinaryMetadata(JSON.parse(metadataJson)); }
  catch { throw new Error('binary frame metadata is not serializable'); }
  const metadata = Buffer.from(metadataJson, 'utf8');
  if (metadata.length < 2 || metadata.length > MAX_BINARY_METADATA_BYTES) {
    throw new Error('binary frame metadata exceeds Carry limit');
  }

  const nonce = crypto.randomBytes(NONCE_BYTES);
  const header = binaryHeader(salt, nonce);
  const metadataLength = Buffer.alloc(4);
  metadataLength.writeUInt32BE(metadata.length, 0);
  const key = sessionKey(code, salt, info);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.concat([BINARY_AAD_DOMAIN, header]));
  const encrypted = Buffer.concat([
    cipher.update(metadataLength),
    cipher.update(metadata),
    cipher.update(bytes),
    cipher.final(),
  ]);
  return Buffer.concat([header, encrypted, cipher.getAuthTag()]);
}

// Decrypt a v2 binary envelope and return the same frame shape used by text
// transport, with the raw payload exposed as `data: Buffer`.
function decryptBinaryFrame(envelope, code, info = BINARY_INFO) {
  const value = validateBinaryEnvelope(envelope);
  const header = value.subarray(0, BINARY_HEADER_BYTES);
  const salt = header.subarray(BINARY_SALT_OFFSET, BINARY_NONCE_OFFSET);
  const nonce = header.subarray(BINARY_NONCE_OFFSET, BINARY_HEADER_BYTES);
  const encrypted = value.subarray(BINARY_HEADER_BYTES, value.length - TAG_BYTES);
  const tag = value.subarray(value.length - TAG_BYTES);
  const key = sessionKey(code, salt, info);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAAD(Buffer.concat([BINARY_AAD_DOMAIN, header]));
  decipher.setAuthTag(tag);

  let plaintext;
  try { plaintext = Buffer.concat([decipher.update(encrypted), decipher.final()]); }
  catch { throw new Error('binary frame authentication failed — wrong code or tampered relay frame'); }
  if (plaintext.length < MIN_BINARY_PLAINTEXT_BYTES) throw new Error('binary frame plaintext is truncated');

  const metadataLength = plaintext.readUInt32BE(0);
  if (metadataLength < 2 || metadataLength > MAX_BINARY_METADATA_BYTES ||
      4 + metadataLength > plaintext.length) {
    throw new Error('binary frame metadata length is invalid');
  }
  const payloadLength = plaintext.length - 4 - metadataLength;
  if (payloadLength > MAX_BINARY_PAYLOAD_BYTES) throw new Error('binary frame payload exceeds Carry limit');

  let frame;
  try { frame = JSON.parse(plaintext.subarray(4, 4 + metadataLength).toString('utf8')); }
  catch { throw new Error('binary frame metadata is invalid'); }
  validateBinaryMetadata(frame);
  return { ...frame, data: Buffer.from(plaintext.subarray(4 + metadataLength)) };
}

// Safe, non-decrypting recognition for the relay. Authentication remains
// exclusively peer-side because the relay never receives the invitation key.
function isBinaryEnvelope(value) {
  try {
    validateBinaryEnvelope(value);
    return true;
  } catch {
    return false;
  }
}

// Constant-time-ish compare for device-id / allowlist checks. Compares two
// hex strings of equal expected length without early-exit timing leaks that
// matter for secret material. (Device ids are not secret, but we use this
// uniformly so callers don't special-case.)
function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

// Generate a fresh per-session salt. The salt is public (sent with the
// envelope) but must be unpredictable so the same code never reuses a key.
function newSalt() {
  return crypto.randomBytes(SALT_BYTES);
}

function sessionInfo(binding, binary = false) {
  const value = String(binding || '').toLowerCase();
  if (!SESSION_BINDING_PATTERN.test(value)) throw new Error('authenticated session binding is invalid');
  return `${binary ? 'carry-binary' : 'carry-text'}-session-v1:${value}`;
}

function createSessionState(binding) {
  const value = String(binding || '').toLowerCase();
  if (!SESSION_BINDING_PATTERN.test(value)) throw new Error('authenticated session binding is invalid');
  return { binding: value, sendSequence: 0, receiveSequence: 0 };
}

function sealSessionFrame(state, frame) {
  if (!state || !SESSION_BINDING_PATTERN.test(String(state.binding || '')) ||
      !Number.isSafeInteger(state.sendSequence) || state.sendSequence < 0) {
    throw new Error('authenticated session state is invalid');
  }
  if (!frame || typeof frame !== 'object' || Array.isArray(frame)) {
    throw new Error('authenticated session frame must be an object');
  }
  const wrapped = {
    type: SESSION_WRAPPER_TYPE,
    binding: state.binding,
    sequence: state.sendSequence,
    frame,
  };
  state.sendSequence += 1;
  return wrapped;
}

function openSessionFrame(state, wrapped) {
  if (!state || !SESSION_BINDING_PATTERN.test(String(state.binding || '')) ||
      !Number.isSafeInteger(state.receiveSequence) || state.receiveSequence < 0) {
    throw new Error('authenticated session state is invalid');
  }
  if (!wrapped || typeof wrapped !== 'object' || Array.isArray(wrapped) ||
      Object.keys(wrapped).sort().join(',') !== 'binding,frame,sequence,type' ||
      wrapped.type !== SESSION_WRAPPER_TYPE || wrapped.binding !== state.binding ||
      wrapped.sequence !== state.receiveSequence || !wrapped.frame ||
      typeof wrapped.frame !== 'object' || Array.isArray(wrapped.frame)) {
    throw new Error('replayed or out-of-order encrypted frame was rejected');
  }
  state.receiveSequence += 1;
  return wrapped.frame;
}

module.exports = {
  KEY_BYTES,
  NONCE_BYTES,
  TAG_BYTES,
  SALT_BYTES,
  BINARY_HEADER_BYTES,
  BINARY_INFO,
  MAX_BINARY_METADATA_BYTES,
  MAX_BINARY_PAYLOAD_BYTES,
  MAX_BINARY_ENVELOPE_BYTES,
  deriveKey,
  sessionKey,
  encryptFrame,
  decryptFrame,
  encryptBinaryFrame,
  decryptBinaryFrame,
  isBinaryEnvelope,
  safeEqual,
  newSalt,
  sessionInfo,
  createSessionState,
  sealSessionFrame,
  openSessionFrame,
};
