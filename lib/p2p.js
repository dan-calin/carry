'use strict';

// Experimental encrypted WebRTC DataChannel transport.
//
// This module deliberately has no production call sites yet. It is shaped so
// syncOverRelay can later use the existing encrypted relay as an authenticated
// signalling path, then move only bulk frames onto this direct channel. The
// native dependency is loaded only by start(), so a missing/incompatible
// binary can never prevent Carry's established relay transport from loading.

const frameCrypto = require('./crypto');

const PROTOCOL_VERSION = 1;
const SIGNAL_TYPE = 'sync-direct-signal';
const CHANNEL_LABEL = 'carry-direct-v1';
const CHANNEL_PROTOCOL = 'carry-encrypted-v1';

const MAX_SDP_BYTES = 64 * 1024;
const MAX_CANDIDATE_BYTES = 2 * 1024;
const MAX_CANDIDATES = 64;
const MAX_APPLICATION_MESSAGE_BYTES = 128 * 1024;
const MAX_BINARY_METADATA_BYTES = 8 * 1024;
const MAX_BINARY_PAYLOAD_BYTES = 120 * 1024;
const MAX_WIRE_MESSAGE_BYTES = 256 * 1024;
const DEFAULT_MAX_BUFFERED_BYTES = 1024 * 1024;
const DEFAULT_BUFFERED_LOW_BYTES = 256 * 1024;
const DEFAULT_MAX_QUEUED_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_QUEUED_MESSAGES = 64;
const DEFAULT_CONNECT_TIMEOUT_MS = 12_000;

const DEVICE_ID_PATTERN = /^[A-Za-z0-9_-]{6,128}$/;
const ATTEMPT_ID_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;
const DESCRIPTION_KEYS = [
  'attemptId', 'descriptionType', 'from', 'kind', 'sdp', 'to', 'type', 'version',
];
const CANDIDATE_KEYS = [
  'attemptId', 'candidate', 'from', 'kind', 'mid', 'to', 'type', 'version',
];

let cachedNative = null;

function byteLength(value) {
  return Buffer.byteLength(value, 'utf8');
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function exactKeys(value, expected) {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index]);
}

function validateBinding(binding) {
  if (!isPlainObject(binding)) throw new Error('direct transport binding must be an object');
  const selfId = String(binding.selfId || '');
  const peerId = String(binding.peerId || '');
  const attemptId = String(binding.attemptId || '');
  if (!DEVICE_ID_PATTERN.test(selfId) || !DEVICE_ID_PATTERN.test(peerId) || selfId === peerId) {
    throw new Error('direct transport device binding is invalid');
  }
  if (!ATTEMPT_ID_PATTERN.test(attemptId)) {
    throw new Error('direct transport attempt binding is invalid');
  }
  return { selfId, peerId, attemptId };
}

function isOfferer(selfId, peerId) {
  const binding = validateBinding({ selfId, peerId, attemptId: 'rolecheck' });
  return binding.selfId < binding.peerId;
}

function validateSignal(frame, binding) {
  const expected = validateBinding(binding);
  if (!isPlainObject(frame)) throw new Error('direct signal must be an object');
  if (frame.kind !== 'description' && frame.kind !== 'candidate') {
    throw new Error('direct signal kind is invalid');
  }
  const keys = frame.kind === 'description' ? DESCRIPTION_KEYS : CANDIDATE_KEYS;
  if (!exactKeys(frame, keys)) throw new Error('direct signal fields are invalid');
  if (frame.type !== SIGNAL_TYPE || frame.version !== PROTOCOL_VERSION) {
    throw new Error('direct signal protocol version is invalid');
  }
  if (frame.attemptId !== expected.attemptId || frame.from !== expected.peerId || frame.to !== expected.selfId) {
    throw new Error('direct signal does not match this peer attempt');
  }

  if (frame.kind === 'description') {
    if (frame.descriptionType !== 'offer' && frame.descriptionType !== 'answer') {
      throw new Error('direct signal description type is invalid');
    }
    if (typeof frame.sdp !== 'string' || frame.sdp.length === 0 || frame.sdp.includes('\0') ||
        byteLength(frame.sdp) > MAX_SDP_BYTES) {
      throw new Error('direct signal SDP exceeds the Carry limit');
    }
  } else {
    if (typeof frame.candidate !== 'string' || frame.candidate.length === 0 ||
        /[\r\n\0]/.test(frame.candidate) || byteLength(frame.candidate) > MAX_CANDIDATE_BYTES) {
      throw new Error('direct ICE candidate exceeds the Carry limit');
    }
    if (typeof frame.mid !== 'string' || byteLength(frame.mid) > 256 || /[\r\n\0]/.test(frame.mid)) {
      throw new Error('direct ICE candidate mid is invalid');
    }
  }
  return frame;
}

function createSignalValidator(binding) {
  const expected = validateBinding(binding);
  let candidates = 0;
  return (frame) => {
    const valid = validateSignal(frame, expected);
    if (valid.kind === 'candidate') {
      candidates += 1;
      if (candidates > MAX_CANDIDATES) {
        throw new Error('direct ICE candidate count exceeds the Carry limit');
      }
    }
    return valid;
  };
}

function loadNative() {
  if (cachedNative) return cachedNative;
  try {
    // Intentionally lazy: do not move this require to module scope.
    const native = require('node-datachannel');
    if (!native || typeof native.PeerConnection !== 'function') {
      throw new Error('node-datachannel does not expose PeerConnection');
    }
    cachedNative = {
      available: true,
      native,
      version: typeof native.getLibraryVersion === 'function'
        ? String(native.getLibraryVersion())
        : 'unknown',
      reason: null,
    };
  } catch (error) {
    cachedNative = {
      available: false,
      native: null,
      version: null,
      reason: error && error.message ? error.message : 'native DataChannel module could not be loaded',
    };
  }
  return cachedNative;
}

function nativeAvailability() {
  const result = loadNative();
  return { available: result.available, version: result.version, reason: result.reason };
}

function boundedInteger(value, fallback, min, max, label) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(label + ' is outside the supported range');
  }
  return value;
}

function normalizeIceServers(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 8) {
    throw new Error('direct transport STUN server list is invalid');
  }
  return value.map((server) => {
    if (typeof server !== 'string' || byteLength(server) > 512 ||
        !/^stun:[A-Za-z0-9.-]+(?::\d{1,5})?$/.test(server)) {
      throw new Error('direct transport accepts only bounded STUN server URLs');
    }
    const portMatch = server.match(/:(\d{1,5})$/);
    if (portMatch) {
      const port = Number.parseInt(portMatch[1], 10);
      if (port < 1 || port > 65535) throw new Error('direct transport STUN port is invalid');
    }
    return server;
  });
}

function applicationFrameBytes(frame) {
  if (!isPlainObject(frame) || typeof frame.type !== 'string' || frame.type.length < 1 ||
      frame.type.length > 128 || /[\r\n\0]/.test(frame.type)) {
    throw new Error('direct application frame is invalid');
  }
  let json;
  try { json = JSON.stringify(frame); } catch { throw new Error('direct application frame is not serializable'); }
  if (typeof json !== 'string') throw new Error('direct application frame is not serializable');
  const bytes = byteLength(json);
  if (bytes > MAX_APPLICATION_MESSAGE_BYTES) {
    throw new Error('direct application message exceeds the 128 KiB Carry limit');
  }
  return bytes;
}

function binaryPayload(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  throw new Error('direct binary payload must be bytes');
}

function signalFrame(binding, fields) {
  return {
    type: SIGNAL_TYPE,
    version: PROTOCOL_VERSION,
    attemptId: binding.attemptId,
    from: binding.selfId,
    to: binding.peerId,
    ...fields,
  };
}

function incomingEnvelopeBinding(value, binding, expectedType) {
  const keys = expectedType === 'p2p-binary'
    ? ['attemptId', 'data', 'frame', 'from', 'to', 'type', 'version']
    : ['attemptId', 'frame', 'from', 'to', 'type', 'version'];
  if (!isPlainObject(value) || value.type !== expectedType || value.version !== PROTOCOL_VERSION ||
      value.attemptId !== binding.attemptId || value.from !== binding.peerId || value.to !== binding.selfId ||
      !isPlainObject(value.frame) || !exactKeys(value, keys)) {
    throw new Error('direct encrypted frame does not match this peer attempt');
  }
}

function safeSelectedPair(pair) {
  if (!pair || !isPlainObject(pair)) return null;
  function side(value) {
    if (!value || typeof value !== 'object') return null;
    return {
      address: typeof value.address === 'string' ? value.address : '',
      port: Number.isInteger(value.port) ? value.port : 0,
      type: typeof value.type === 'string' ? value.type : '',
      transportType: typeof value.transportType === 'string' ? value.transportType : '',
    };
  }
  const local = side(pair.local);
  const remote = side(pair.remote);
  return local && remote ? { local, remote } : null;
}

class P2PTransport {
  constructor(options) {
    if (!isPlainObject(options)) throw new Error('direct transport options must be an object');
    this.binding = validateBinding(options);
    if (typeof options.secret !== 'string' || options.secret.length < 6 || options.secret.length > 512 ||
        options.secret.includes('\0')) {
      throw new Error('direct transport shared secret is invalid');
    }
    if (typeof options.sendSignal !== 'function') throw new Error('direct transport needs a signalling callback');
    if (options.onFrame !== undefined && typeof options.onFrame !== 'function') {
      throw new Error('direct transport frame callback is invalid');
    }
    if (options.onError !== undefined && typeof options.onError !== 'function') {
      throw new Error('direct transport error callback is invalid');
    }
    if (options.onClose !== undefined && typeof options.onClose !== 'function') {
      throw new Error('direct transport close callback is invalid');
    }

    this.secret = options.secret;
    this.sendSignalCallback = options.sendSignal;
    this.onFrame = options.onFrame || (() => {});
    this.onError = options.onError || (() => {});
    this.onClose = options.onClose || (() => {});
    this.iceServers = normalizeIceServers(options.iceServers);
    this.offerer = isOfferer(this.binding.selfId, this.binding.peerId);
    this.connectTimeoutMs = boundedInteger(
      options.connectTimeoutMs, DEFAULT_CONNECT_TIMEOUT_MS, 100, 120_000,
      'direct transport connection timeout',
    );
    this.maxBufferedBytes = boundedInteger(
      options.maxBufferedBytes, DEFAULT_MAX_BUFFERED_BYTES, 1, 16 * 1024 * 1024,
      'direct transport buffer limit',
    );
    this.bufferedLowBytes = boundedInteger(
      options.bufferedLowBytes,
      Math.min(DEFAULT_BUFFERED_LOW_BYTES, this.maxBufferedBytes),
      0,
      this.maxBufferedBytes,
      'direct transport low-water mark',
    );
    this.maxQueuedBytes = boundedInteger(
      options.maxQueuedBytes, DEFAULT_MAX_QUEUED_BYTES, 1, 32 * 1024 * 1024,
      'direct transport queue byte limit',
    );
    this.maxQueuedMessages = boundedInteger(
      options.maxQueuedMessages, DEFAULT_MAX_QUEUED_MESSAGES, 1, 1024,
      'direct transport queue message limit',
    );

    // Undocumented injection seam used only by deterministic transport tests.
    this._nativeOverride = options._native || null;
    this._validateIncomingSignal = createSignalValidator(this.binding);
    this._incomingDescriptionSeen = false;
    this._outgoingCandidateCount = 0;
    this._started = false;
    this._closed = false;
    this._opened = false;
    this._closeNotified = false;
    this._readySettled = false;
    this._flushing = false;
    this._queue = [];
    this._queuedBytes = 0;
    this._salt = frameCrypto.newSalt();
    this._pc = null;
    this._channel = null;
    this._timer = null;
    this._retryTimer = null;
    this._readyPromise = null;
    this._readyResolve = null;
    this._readyReject = null;
  }

  start() {
    if (this._started) return this._readyPromise;
    this._started = true;
    this._readyPromise = new Promise((resolve, reject) => {
      this._readyResolve = resolve;
      this._readyReject = reject;
    });
    // Avoid process-level unhandled rejection warnings when a caller closes a
    // speculative attempt without awaiting it; the returned promise still
    // rejects normally for callers that do await it.
    this._readyPromise.catch(() => {});

    const loaded = this._nativeOverride
      ? { available: true, native: this._nativeOverride }
      : loadNative();
    if (!loaded.available) {
      this._fail(new Error('direct transport unavailable: ' + loaded.reason));
      return this._readyPromise;
    }

    try {
      // Fingerprint verification is intentionally left enabled. Only the
      // minimal supported configuration is passed to the native library.
      this._pc = new loaded.native.PeerConnection('carry-peer', {
        iceServers: this.iceServers,
        maxMessageSize: MAX_WIRE_MESSAGE_BYTES,
      });
      this._wirePeerCallbacks();
      this._timer = setTimeout(() => {
        this._fail(new Error('direct transport connection timed out'));
      }, this.connectTimeoutMs);
      if (this.offerer) {
        this._attachDataChannel(this._pc.createDataChannel(CHANNEL_LABEL, {
          protocol: CHANNEL_PROTOCOL,
          unordered: false,
        }));
      }
    } catch (error) {
      this._fail(new Error('direct transport could not start: ' + safeErrorMessage(error)));
    }
    return this._readyPromise;
  }

  ready() {
    return this._started ? this._readyPromise : this.start();
  }

  handleSignal(frame) {
    if (!this._started || !this._pc) throw new Error('direct transport is not started');
    if (this._closed) throw new Error('direct transport is closed');
    const signal = this._validateIncomingSignal(frame);
    try {
      if (signal.kind === 'description') {
        const expectedType = this.offerer ? 'answer' : 'offer';
        if (signal.descriptionType !== expectedType) {
          throw new Error('direct signal description role is invalid');
        }
        if (this._incomingDescriptionSeen) throw new Error('duplicate direct description was rejected');
        this._incomingDescriptionSeen = true;
        this._pc.setRemoteDescription(signal.sdp, signal.descriptionType);
      } else {
        this._pc.addRemoteCandidate(signal.candidate, signal.mid);
      }
    } catch {
      // Native parser errors are deliberately not forwarded because some
      // implementations include pieces of the rejected SDP/candidate text.
      const wrapped = new Error('direct signal was rejected by the native peer');
      this._fail(wrapped);
      throw wrapped;
    }
  }

  send(frame) {
    const appBytes = applicationFrameBytes(frame);
    const envelope = frameCrypto.encryptFrame({
      type: 'p2p-data',
      version: PROTOCOL_VERSION,
      attemptId: this.binding.attemptId,
      from: this.binding.selfId,
      to: this.binding.peerId,
      frame,
    }, this.secret, this._salt, 'carry-p2p-data-v1');
    const wire = JSON.stringify(envelope);
    return this._enqueue('text', wire, byteLength(wire), appBytes);
  }

  sendBinary(frame, payload) {
    const metadataBytes = applicationFrameBytes(frame);
    if (Object.prototype.hasOwnProperty.call(frame, 'data')) {
      throw new Error('direct binary metadata must not contain data');
    }
    const bytes = binaryPayload(payload);
    if (metadataBytes + bytes.length > MAX_APPLICATION_MESSAGE_BYTES) {
      throw new Error('direct application message exceeds the 128 KiB Carry limit');
    }
    if (metadataBytes > MAX_BINARY_METADATA_BYTES) {
      throw new Error('direct binary metadata exceeds the 8 KiB Carry limit');
    }
    if (bytes.length > MAX_BINARY_PAYLOAD_BYTES) {
      throw new Error('direct binary payload exceeds the 120 KiB Carry limit');
    }
    const wire = frameCrypto.encryptBinaryFrame({
      type: 'p2p-binary',
      version: PROTOCOL_VERSION,
      attemptId: this.binding.attemptId,
      from: this.binding.selfId,
      to: this.binding.peerId,
      frame,
    }, bytes, this.secret, this._salt);
    return this._enqueue('binary', wire, wire.length, metadataBytes + bytes.length);
  }

  pendingBytes() {
    let nativeBytes = 0;
    try {
      if (this._channel && typeof this._channel.bufferedAmount === 'function') {
        nativeBytes = Number(this._channel.bufferedAmount()) || 0;
      }
    } catch { /* a concurrently closing channel has no useful amount */ }
    return Math.max(0, nativeBytes) + this._queuedBytes;
  }

  stats() {
    let selectedPair = null;
    let rttMs = null;
    try { selectedPair = safeSelectedPair(this._pc && this._pc.getSelectedCandidatePair()); }
    catch { /* unavailable */ }
    try {
      const value = this._pc && this._pc.rtt();
      if (Number.isFinite(value)) rttMs = value;
    } catch { /* unavailable */ }
    return {
      state: this._closed ? 'closed' : this._opened ? 'open' : this._started ? 'connecting' : 'idle',
      role: this.offerer ? 'offerer' : 'answerer',
      pendingBytes: this.pendingBytes(),
      rttMs,
      selectedPair,
    };
  }

  close(reason) {
    if (this._closed) return;
    this._closed = true;
    if (this._timer) clearTimeout(this._timer);
    if (this._retryTimer) clearTimeout(this._retryTimer);
    this._timer = null;
    this._retryTimer = null;
    const error = reason instanceof Error ? reason : new Error(reason || 'direct transport closed');
    if (!this._readySettled && this._readyReject) {
      this._readySettled = true;
      this._readyReject(error);
    }
    const pending = this._queue.splice(0);
    this._queuedBytes = 0;
    for (const item of pending) item.reject(error);
    const channel = this._channel;
    const pc = this._pc;
    this._channel = null;
    this._pc = null;
    try { if (channel) channel.close(); } catch { /* already closed */ }
    try { if (pc) pc.close(); } catch { /* already closed */ }
    if (!this._closeNotified) {
      this._closeNotified = true;
      try { this.onClose(reason instanceof Error ? reason : null); } catch { /* callback isolation */ }
    }
  }

  _wirePeerCallbacks() {
    this._pc.onLocalDescription((sdp, descriptionType) => {
      const normalizedType = String(descriptionType || '').toLowerCase();
      const frame = signalFrame(this.binding, {
        kind: 'description',
        descriptionType: normalizedType,
        sdp,
      });
      try {
        validateSignal(frame, {
          selfId: this.binding.peerId,
          peerId: this.binding.selfId,
          attemptId: this.binding.attemptId,
        });
      } catch (error) {
        this._fail(error);
        return;
      }
      this._emitSignal(frame);
    });
    this._pc.onLocalCandidate((candidate, mid) => {
      if (!candidate) return;
      this._outgoingCandidateCount += 1;
      if (this._outgoingCandidateCount > MAX_CANDIDATES) {
        this._fail(new Error('direct ICE candidate count exceeds the Carry limit'));
        return;
      }
      const frame = signalFrame(this.binding, { kind: 'candidate', candidate, mid: mid || '' });
      try {
        validateSignal(frame, {
          selfId: this.binding.peerId,
          peerId: this.binding.selfId,
          attemptId: this.binding.attemptId,
        });
      } catch (error) {
        this._fail(error);
        return;
      }
      this._emitSignal(frame);
    });
    this._pc.onDataChannel((channel) => {
      if (this.offerer || this._channel) {
        try { channel.close(); } catch { /* ignore unexpected channel */ }
        this._fail(new Error('unexpected direct DataChannel was rejected'));
        return;
      }
      this._attachDataChannel(channel);
    });
    this._pc.onStateChange((state) => {
      if (!this._closed && (state === 'failed' || state === 'closed')) {
        this._fail(new Error('direct peer connection ' + state));
      }
    });
  }

  _attachDataChannel(channel) {
    if (!channel || this._closed) return;
    if (this._channel && this._channel !== channel) {
      try { channel.close(); } catch { /* ignore */ }
      this._fail(new Error('multiple direct DataChannels were rejected'));
      return;
    }
    try {
      if (typeof channel.getLabel === 'function' && channel.getLabel() !== CHANNEL_LABEL) {
        throw new Error('unexpected direct DataChannel label');
      }
      if (typeof channel.getProtocol === 'function' && channel.getProtocol() !== CHANNEL_PROTOCOL) {
        throw new Error('unexpected direct DataChannel protocol');
      }
    } catch (error) {
      try { channel.close(); } catch { /* ignore */ }
      this._fail(error);
      return;
    }
    this._channel = channel;
    channel.setBufferedAmountLowThreshold(this.bufferedLowBytes);
    channel.onBufferedAmountLow(() => this._flushQueue());
    channel.onMessage((message) => this._receive(message));
    channel.onError((message) => this._fail(new Error('direct DataChannel error: ' + safeErrorMessage(message))));
    channel.onClosed(() => {
      if (!this._closed) this._fail(new Error('direct DataChannel closed'));
    });
    channel.onOpen(() => this._markOpen());
    try {
      if (channel.isOpen()) this._markOpen();
    } catch { /* wait for onOpen */ }
  }

  _markOpen() {
    if (this._closed || this._opened) return;
    this._opened = true;
    if (this._timer) clearTimeout(this._timer);
    this._timer = null;
    if (!this._readySettled && this._readyResolve) {
      this._readySettled = true;
      this._readyResolve(this);
    }
    this._flushQueue();
  }

  _emitSignal(frame) {
    if (this._closed) return;
    try {
      Promise.resolve(this.sendSignalCallback(frame)).catch((error) => {
        this._fail(new Error('direct signalling failed: ' + safeErrorMessage(error)));
      });
    } catch (error) {
      this._fail(new Error('direct signalling failed: ' + safeErrorMessage(error)));
    }
  }

  _enqueue(kind, wire, wireBytes, _applicationBytes) {
    if (!this._opened || this._closed || !this._channel) {
      return Promise.reject(new Error('direct DataChannel is not open'));
    }
    let nativeMax = MAX_WIRE_MESSAGE_BYTES;
    try {
      const reported = Number(this._channel.maxMessageSize());
      if (Number.isFinite(reported) && reported > 0) nativeMax = Math.min(nativeMax, reported);
    } catch { /* retain the conservative limit */ }
    if (wireBytes > nativeMax) {
      return Promise.reject(new Error('encrypted direct message exceeds the negotiated channel limit'));
    }
    if (this._queue.length >= this.maxQueuedMessages || this._queuedBytes + wireBytes > this.maxQueuedBytes) {
      return Promise.reject(new Error('direct send queue is full'));
    }
    return new Promise((resolve, reject) => {
      this._queue.push({ kind, wire, bytes: wireBytes, resolve, reject });
      this._queuedBytes += wireBytes;
      this._flushQueue();
    });
  }

  _flushQueue() {
    if (this._flushing || this._closed || !this._opened || !this._channel) return;
    this._flushing = true;
    try {
      while (this._queue.length && !this._closed) {
        let buffered = 0;
        try { buffered = Math.max(0, Number(this._channel.bufferedAmount()) || 0); }
        catch { break; }
        const item = this._queue[0];
        // Always permit one message into an empty native buffer. This avoids a
        // deadlock if a negotiated message is larger than the high-water mark.
        if (buffered > 0 && buffered + item.bytes > this.maxBufferedBytes) break;
        let accepted;
        try {
          accepted = item.kind === 'binary'
            ? this._channel.sendMessageBinary(item.wire)
            : this._channel.sendMessage(item.wire);
        } catch (error) {
          this._fail(new Error('direct send failed: ' + safeErrorMessage(error)));
          break;
        }
        this._queue.shift();
        this._queuedBytes -= item.bytes;
        item.resolve();
        if (!accepted) {
          // libdatachannel buffers messages that cannot be sent immediately.
          // The native binding can return false after accepting that buffered
          // message, so retrying the same item duplicates file chunks.
          if (!this._retryTimer) {
            this._retryTimer = setTimeout(() => {
              this._retryTimer = null;
              this._flushQueue();
            }, 10);
            this._retryTimer.unref?.();
          }
          break;
        }
      }
    } finally {
      this._flushing = false;
    }
  }

  _receive(message) {
    if (this._closed) return;
    try {
      let frame;
      if (typeof message === 'string') {
        if (byteLength(message) > MAX_WIRE_MESSAGE_BYTES) throw new Error('direct encrypted message exceeds limit');
        let envelope;
        try { envelope = JSON.parse(message); } catch { throw new Error('direct encrypted text frame is malformed'); }
        const outer = frameCrypto.decryptFrame(envelope, this.secret);
        incomingEnvelopeBinding(outer, this.binding, 'p2p-data');
        applicationFrameBytes(outer.frame);
        frame = outer.frame;
      } else {
        const bytes = binaryPayload(message);
        if (bytes.length > MAX_WIRE_MESSAGE_BYTES) throw new Error('direct encrypted message exceeds limit');
        const outer = frameCrypto.decryptBinaryFrame(bytes, this.secret);
        incomingEnvelopeBinding(outer, this.binding, 'p2p-binary');
        const payload = binaryPayload(outer.data);
        const metadataBytes = applicationFrameBytes(outer.frame);
        if (metadataBytes > MAX_BINARY_METADATA_BYTES || payload.length > MAX_BINARY_PAYLOAD_BYTES ||
            metadataBytes + payload.length > MAX_APPLICATION_MESSAGE_BYTES) {
          throw new Error('direct application message exceeds the 128 KiB Carry limit');
        }
        frame = { ...outer.frame, data: payload };
      }
      try {
        this.onFrame(frame, (response) => this.send(response));
      } catch (error) {
        this._fail(new Error('direct frame handler failed: ' + safeErrorMessage(error)));
      }
    } catch (error) {
      this._fail(new Error('direct encrypted frame was rejected: ' + safeErrorMessage(error)));
    }
  }

  _fail(error) {
    if (this._closed) return;
    try { this.onError(error); } catch { /* callback isolation */ }
    this.close(error);
  }
}

function safeErrorMessage(error) {
  if (typeof error === 'string') return error.slice(0, 512);
  if (error && typeof error.message === 'string') return error.message.slice(0, 512);
  return 'unknown error';
}

function createP2PTransport(options) {
  return new P2PTransport(options);
}

module.exports = {
  PROTOCOL_VERSION,
  SIGNAL_TYPE,
  CHANNEL_LABEL,
  CHANNEL_PROTOCOL,
  MAX_SDP_BYTES,
  MAX_CANDIDATE_BYTES,
  MAX_CANDIDATES,
  MAX_APPLICATION_MESSAGE_BYTES,
  MAX_BINARY_METADATA_BYTES,
  MAX_BINARY_PAYLOAD_BYTES,
  MAX_WIRE_MESSAGE_BYTES,
  DEFAULT_MAX_BUFFERED_BYTES,
  DEFAULT_MAX_QUEUED_BYTES,
  DEFAULT_MAX_QUEUED_MESSAGES,
  DEFAULT_CONNECT_TIMEOUT_MS,
  P2PTransport,
  createP2PTransport,
  createSignalValidator,
  isOfferer,
  nativeAvailability,
  validateSignal,
};
