'use strict';

const nodeCrypto = require('crypto');
const net = require('net');
const transport = require('./transport');
const frameCrypto = require('./crypto');

const REMOTE_SECRET_BYTES = 32;
const REMOTE_SECRET_PATTERN = /^[A-Za-z0-9_-]{43,128}$/;
const SYNC_RUN_PATTERN = /^[a-f0-9]{24}$/i;
const BINARY_RELAY_FEATURE = 'encrypted-binary-v2';
const HANDSHAKE_INFO = 'carry-relay-handshake-v1';
const SESSION_NONCE_PATTERN = /^[A-Za-z0-9_-]{32}$/;
const SESSION_HANDSHAKE_MS = 15 * 1000;

function relaySessionBinding(room, syncRunId, first, second) {
  const participants = [first, second].sort((a, b) => a.deviceId.localeCompare(b.deviceId));
  const hash = nodeCrypto.createHash('sha256')
    .update('carry-relay-session-v1\0', 'utf8')
    .update(String(room), 'utf8')
    .update('\0', 'utf8')
    .update(String(syncRunId || ''), 'utf8');
  for (const participant of participants) {
    hash.update('\0', 'utf8').update(participant.deviceId, 'utf8')
      .update('\0', 'utf8').update(participant.nonce, 'utf8');
  }
  return hash.digest('hex');
}

function roomForSecret(secret) {
  return nodeCrypto.createHash('sha256')
    .update('carry-relay-room-v2\0', 'utf8')
    .update(String(secret), 'utf8')
    .digest('hex')
    .toUpperCase();
}

function controlRoomForSecret(secret) {
  return nodeCrypto.createHash('sha256')
    .update('carry-relay-control-room-v1\0', 'utf8')
    .update(String(secret), 'utf8')
    .digest('hex')
    .toUpperCase();
}

function memberForSecret(secret, deviceId) {
  return nodeCrypto.createHmac('sha256', String(secret))
    .update('carry-relay-member-v1\0', 'utf8')
    .update(String(deviceId), 'utf8')
    .digest('hex')
    .toUpperCase();
}

// Retained only so upgraded clients can identify and reject keys created by the
// preview's old deterministic team-key scheme. Never use this to create a key.
function legacyPairSecretForTeam(teamSecret, firstDeviceId, secondDeviceId) {
  const members = [String(firstDeviceId || ''), String(secondDeviceId || '')].sort();
  if (members.some((id) => !/^[A-Za-z0-9_-]{6,128}$/.test(id)) || members[0] === members[1]) {
    throw new Error('team pairing device identity is invalid');
  }
  if (!REMOTE_SECRET_PATTERN.test(String(teamSecret || ''))) {
    throw new Error('team invitation secret is invalid');
  }
  return nodeCrypto.createHmac('sha256', String(teamSecret))
    .update('carry-team-pair-secret-v1\0', 'utf8')
    .update(members[0], 'utf8')
    .update('\0', 'utf8')
    .update(members[1], 'utf8')
    .digest('base64url');
}

function newRemoteSecret() {
  return nodeCrypto.randomBytes(REMOTE_SECRET_BYTES).toString('base64url');
}

function isLoopbackHostname(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  return host === 'localhost' || host.endsWith('.localhost') || host === '::1' ||
    /^127(?:\.\d{1,3}){3}$/.test(host);
}

function parseRelayAddress(value) {
  const input = String(value || '').trim();
  if (!input) throw new Error('relay address is empty');

  if (/^(?:https?|wss?):\/\//i.test(input)) {
    let parsed;
    try { parsed = new URL(input); } catch { throw new Error('remote invite URL is invalid'); }
    const scheme = parsed.protocol.toLowerCase();
    if (!['http:', 'https:', 'ws:', 'wss:'].includes(scheme)) {
      throw new Error('remote relay must use HTTPS or WebSocket');
    }
    if (['http:', 'ws:'].includes(scheme) && !isLoopbackHostname(parsed.hostname)) {
      throw new Error('remote relay must use HTTPS/WSS unless it is running on this device');
    }
    if (parsed.username || parsed.password) throw new Error('remote relay URL must not include credentials');
    const secret = parsed.hash ? parsed.hash.slice(1) : null;
    if (secret && !REMOTE_SECRET_PATTERN.test(secret)) {
      throw new Error('remote invite secret is invalid');
    }
    parsed.hash = '';
    if (!parsed.pathname || parsed.pathname === '/') parsed.pathname = '/carry';
    if (parsed.pathname !== '/carry') throw new Error('remote relay URL must use the /carry endpoint');
    parsed.search = '';

    const endpoint = new URL(parsed.href);
    endpoint.protocol = scheme === 'https:' ? 'wss:' : scheme === 'http:' ? 'ws:' : scheme;
    return {
      transport: 'websocket',
      endpoint: endpoint.href,
      address: parsed.href,
      secret,
    };
  }

  const match = input.match(/^([^:\s]+):(\d{1,5})$/);
  if (!match) throw new Error('relay must be host:port or a secure remote invite URL');
  const port = Number.parseInt(match[2], 10);
  if (port < 1 || port > 65535) throw new Error('relay port is out of range');
  return {
    transport: 'tcp',
    host: match[1],
    port,
    address: match[1] + ':' + port,
    secret: null,
  };
}

function createRemoteInvite(publicUrl, secret) {
  const parsed = parseRelayAddress(publicUrl);
  if (parsed.transport !== 'websocket') throw new Error('public tunnel did not return an HTTPS URL');
  const inviteSecret = secret || newRemoteSecret();
  if (!REMOTE_SECRET_PATTERN.test(inviteSecret)) throw new Error('remote invite secret is invalid');
  return parsed.address + '#' + inviteSecret;
}

class RelayClient extends transport.RelayTransport {
  constructor(options = {}) {
    super();
    this.socket = null;
    this.webSocket = null;
    this.onFrame = null;
    this.room = null;
    this.deviceId = null;
    this.code = null;
    this.salt = null;
    this.relay = null;
    this._closed = false;
    this.peerSupportsBinary = false;
    this.sessionNonce = null;
    this.sessionState = null;
    this.sessionReady = false;
    this.peerRelayDeviceId = null;
    this.pendingRelayReady = null;
    this.handshakeTimer = null;
    this.sessionHandshakeMs = Number.isInteger(options.sessionHandshakeMs) && options.sessionHandshakeMs >= 10
      ? options.sessionHandshakeMs
      : SESSION_HANDSHAKE_MS;
  }

  setRelay(url) {
    this.relay = parseRelayAddress(url);
    this.url = this.relay.address;
    this.host = this.relay.host;
    this.port = this.relay.port;
    return this.relay;
  }

  join(_room, deviceId, onFrame, name, code, explicitRoom, syncRunId) {
    if (!this.relay) throw new Error('relay address was not configured');
    this.deviceId = String(deviceId);
    this.onFrame = onFrame;
    const requestedCode = code || _room;
    if (this.relay.secret && requestedCode && this.relay.secret !== requestedCode) {
      throw new Error('relay invitation secret does not match the saved pairing key');
    }
    this.code = requestedCode || this.relay.secret;
    this.room = explicitRoom || roomForSecret(this.code);
    if (syncRunId !== undefined && syncRunId !== null && !SYNC_RUN_PATTERN.test(String(syncRunId))) {
      throw new Error('relay sync run id is invalid');
    }
    this.syncRunId = syncRunId === undefined || syncRunId === null
      ? null
      : String(syncRunId).toLowerCase();
    this.relayDeviceId = this.relay.transport === 'websocket'
      ? memberForSecret(this.code, this.deviceId)
      : this.deviceId;
    this.salt = frameCrypto.newSalt();
    this._closed = false;
    this.peerSupportsBinary = false;
    this.sessionNonce = nodeCrypto.randomBytes(24).toString('base64url');
    this.sessionState = null;
    this.sessionReady = false;
    this.peerRelayDeviceId = null;
    this.pendingRelayReady = null;
    if (this.handshakeTimer) clearTimeout(this.handshakeTimer);
    this.handshakeTimer = null;
    if (this.relay.transport === 'websocket') {
      return this.joinWebSocket(name);
    }
    return this.joinTcp(name);
  }

  joinTcp(name) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const socket = net.connect(this.port, this.host, () => {
        this.socket = socket;
        sendTcp(socket, {
          type: 'join', room: this.room, deviceId: this.deviceId, name: name || '',
          ...(this.syncRunId ? { syncRunId: this.syncRunId } : {}),
        });
      });
      socket.setEncoding('utf8');
      socket.on('error', (error) => {
        if (!settled) { settled = true; reject(error); }
        else this.dispatch({ type: 'relay-error', message: error.message });
      });
      let buffer = '';
      socket.on('data', (chunk) => {
        buffer += chunk;
        let index;
        while ((index = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, index);
          buffer = buffer.slice(index + 1);
          if (!line.trim()) continue;
          let message;
          try { message = JSON.parse(line); } catch { continue; }
          this.handleRelayMessage(message, resolve, reject, () => { settled = true; }, () => settled);
        }
      });
      socket.on('close', () => {
        if (this._closed) return;
        if (!settled) {
          settled = true;
          reject(new Error('relay connection closed before joining a room'));
        } else this.dispatch({ type: 'peer-gone' });
      });
    });
  }

  joinWebSocket(name) {
    return new Promise((resolve, reject) => {
      if (typeof WebSocket !== 'function') {
        reject(new Error('HTTPS remote sync requires Node.js 22 or newer'));
        return;
      }
      let settled = false;
      let webSocket;
      try {
        const endpoint = new URL(this.relay.endpoint);
        // A Durable Object must know the room before accepting the WebSocket
        // so Cloudflare can route both peers to the same globally unique
        // object. The room is already a one-way hash and was always sent in
        // the clear join frame; the invitation secret remains in the fragment
        // and never reaches the relay.
        endpoint.searchParams.set('room', this.room);
        if (this.syncRunId) endpoint.searchParams.set('syncRunId', this.syncRunId);
        webSocket = new WebSocket(endpoint);
      }
      catch (error) { reject(error); return; }
      webSocket.binaryType = 'arraybuffer';
      this.webSocket = webSocket;
      webSocket.addEventListener('open', () => {
        webSocket.send(JSON.stringify({
          type: 'join', room: this.room, deviceId: this.relayDeviceId, name: '',
          features: [BINARY_RELAY_FEATURE],
          ...(this.syncRunId ? { syncRunId: this.syncRunId } : {}),
        }));
      });
      webSocket.addEventListener('message', (event) => {
        if (typeof event.data !== 'string') {
          this.handleRelayBinary(event.data);
          return;
        }
        let message;
        try { message = JSON.parse(event.data); } catch { return; }
        this.handleRelayMessage(message, resolve, reject, () => { settled = true; }, () => settled);
      });
      webSocket.addEventListener('error', () => {
        const error = new Error('could not connect to the secure remote relay');
        if (!settled) { settled = true; reject(error); }
        else this.dispatch({ type: 'relay-error', message: error.message });
      });
      webSocket.addEventListener('close', () => {
        if (this._closed) return;
        if (!settled) {
          settled = true;
          reject(new Error('secure remote relay closed before joining a room'));
        } else this.dispatch({ type: 'peer-gone' });
      });
    });
  }

  handleRelayMessage(message, resolve, reject, markSettled, isSettled) {
    if (message && message.v === 1 && message.c) {
      this.handleEncryptedText(message, resolve, reject, markSettled, isSettled);
      return;
    }
    if (!message || typeof message.type !== 'string') return;
    if (message.type === 'relay-error') {
      const error = new Error(message.message || 'relay rejected the connection');
      if (!isSettled()) {
        markSettled();
        reject(error);
      } else {
        this.dispatch(message);
      }
      return;
    }
    if (message.type === 'relay-wait') {
      this.peerSupportsBinary = false;
      if (!isSettled()) { markSettled(); resolve(this.socket || this.webSocket); }
      return;
    }
    if (message.type === 'relay-ready') {
      if (!message.peer || !/^[A-Za-z0-9_-]{6,128}$/.test(String(message.peer.deviceId || '')) ||
          message.peer.deviceId === this.relayDeviceId) {
        this.failSession(new Error('relay returned an invalid peer identity'), reject, markSettled, isSettled);
        return;
      }
      this.peerRelayDeviceId = String(message.peer.deviceId);
      this.pendingRelayReady = message;
      this.beginSessionHandshake(resolve, reject, markSettled, isSettled);
      return;
    }
    if (message.type === 'relay-peer-gone') {
      this.peerSupportsBinary = false;
      this.dispatch({ type: 'peer-gone' });
    }
  }

  beginSessionHandshake(resolve, reject, markSettled, isSettled) {
    if (this._closed || this.sessionReady || !this.peerRelayDeviceId) return;
    if (!this.handshakeTimer) {
      this.handshakeTimer = setTimeout(() => {
        this.failSession(
          new Error('paired device did not complete the fresh encrypted-session handshake'),
          reject, markSettled, isSettled,
        );
      }, this.sessionHandshakeMs);
      this.handshakeTimer.unref?.();
    }
    const hello = frameCrypto.encryptFrame({
      type: 'carry-session-hello',
      version: 1,
      from: this.relayDeviceId,
      nonce: this.sessionNonce,
    }, this.code, frameCrypto.newSalt(), HANDSHAKE_INFO);
    this.sendEnvelope(hello);
  }

  handleEncryptedText(message, resolve, reject, markSettled, isSettled) {
    if (message.i === HANDSHAKE_INFO) {
      let hello;
      try { hello = frameCrypto.decryptFrame(message, this.code, HANDSHAKE_INFO); }
      catch { return; }
      if (!this.pendingRelayReady || !hello || hello.type !== 'carry-session-hello' || hello.version !== 1 ||
          hello.from !== this.peerRelayDeviceId || !SESSION_NONCE_PATTERN.test(String(hello.nonce || ''))) {
        this.failSession(new Error('relay session handshake was invalid'), reject, markSettled, isSettled);
        return;
      }
      if (!this.sessionState) {
        const binding = relaySessionBinding(
          this.room,
          this.syncRunId,
          { deviceId: this.relayDeviceId, nonce: this.sessionNonce },
          { deviceId: this.peerRelayDeviceId, nonce: hello.nonce },
        );
        this.sessionState = frameCrypto.createSessionState(binding);
        const ready = frameCrypto.sealSessionFrame(this.sessionState, {
          type: 'carry-session-ready', version: 1, from: this.relayDeviceId,
        });
        this.sendEnvelope(frameCrypto.encryptFrame(
          ready, this.code, this.salt, frameCrypto.sessionInfo(binding),
        ));
      }
      return;
    }
    if (!this.sessionState) return;
    let frame;
    try {
      const wrapped = frameCrypto.decryptFrame(
        message, this.code, frameCrypto.sessionInfo(this.sessionState.binding),
      );
      frame = frameCrypto.openSessionFrame(this.sessionState, wrapped);
    } catch {
      this.failSession(new Error('replayed or invalid encrypted relay frame'), reject, markSettled, isSettled);
      return;
    }
    if (!this.sessionReady) {
      if (!frame || frame.type !== 'carry-session-ready' || frame.version !== 1 ||
          frame.from !== this.peerRelayDeviceId) {
        this.failSession(new Error('relay session confirmation was invalid'), reject, markSettled, isSettled);
        return;
      }
      this.sessionReady = true;
      if (this.handshakeTimer) clearTimeout(this.handshakeTimer);
      this.handshakeTimer = null;
      const readyMessage = this.pendingRelayReady;
      this.peerSupportsBinary = this.relay.transport === 'websocket' &&
        Array.isArray(readyMessage.features) && readyMessage.features.includes(BINARY_RELAY_FEATURE);
      if (!isSettled()) { markSettled(); resolve(this.socket || this.webSocket); }
      this.dispatch(readyMessage);
      return;
    }
    this.dispatch(frame);
  }

  failSession(error, reject, markSettled, isSettled) {
    if (this.handshakeTimer) clearTimeout(this.handshakeTimer);
    this.handshakeTimer = null;
    if (!isSettled()) {
      markSettled();
      reject(error);
    } else {
      this.dispatch({ type: 'relay-error', message: error.message });
    }
    this.close();
  }

  sendEnvelope(envelope) {
    if (this.relay.transport === 'websocket') {
      if (!this.webSocket || this.webSocket.readyState !== 1) throw new Error('remote relay is not connected');
      this.webSocket.send(JSON.stringify(envelope));
      return;
    }
    if (!this.socket || this.socket.destroyed) throw new Error('relay is not connected');
    sendTcp(this.socket, envelope);
  }

  handleRelayBinary(value) {
    if (!this.peerSupportsBinary || !this.sessionReady || !this.sessionState) return;
    if (value && typeof value.arrayBuffer === 'function' && !(value instanceof ArrayBuffer)) {
      value.arrayBuffer()
        .then((arrayBuffer) => this.handleRelayBinary(arrayBuffer))
        .catch(() => {});
      return;
    }
    let envelope;
    if (Buffer.isBuffer(value)) envelope = value;
    else if (value instanceof ArrayBuffer) envelope = Buffer.from(value);
    else if (ArrayBuffer.isView(value)) {
      envelope = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
    } else return;
    let frame;
    try {
      const wrappedWithData = frameCrypto.decryptBinaryFrame(
        envelope, this.code, frameCrypto.sessionInfo(this.sessionState.binding, true),
      );
      const data = wrappedWithData.data;
      const wrapped = { ...wrappedWithData };
      delete wrapped.data;
      frame = { ...frameCrypto.openSessionFrame(this.sessionState, wrapped), data };
    }
    catch { return; }
    this.dispatch(frame);
  }

  dispatch(frame) {
    if (this.onFrame) this.onFrame(frame, (response) => this.send(response));
  }

  send(frame) {
    if (!this.sessionReady || !this.sessionState) throw new Error('fresh encrypted relay session is not ready');
    const wrapped = frameCrypto.sealSessionFrame(this.sessionState, frame);
    const envelope = frameCrypto.encryptFrame(
      wrapped, this.code, this.salt, frameCrypto.sessionInfo(this.sessionState.binding),
    );
    this.sendEnvelope(envelope);
  }

  sendBinary(frame, payload) {
    if (!this.relay || this.relay.transport !== 'websocket') {
      throw new Error('encrypted binary transport requires a WebSocket relay');
    }
    if (!this.peerSupportsBinary) {
      throw new Error('peer does not support encrypted binary transport');
    }
    if (!this.webSocket || this.webSocket.readyState !== 1) {
      throw new Error('remote relay is not connected');
    }
    if (!this.sessionReady || !this.sessionState) throw new Error('fresh encrypted relay session is not ready');
    const wrapped = frameCrypto.sealSessionFrame(this.sessionState, frame);
    const envelope = frameCrypto.encryptBinaryFrame(
      wrapped, payload, this.code, this.salt, frameCrypto.sessionInfo(this.sessionState.binding, true),
    );
    this.webSocket.send(envelope);
  }

  pendingBytes() {
    if (this.relay && this.relay.transport === 'websocket') {
      return this.webSocket && Number.isFinite(this.webSocket.bufferedAmount)
        ? this.webSocket.bufferedAmount
        : 0;
    }
    return this.socket && Number.isFinite(this.socket.writableLength)
      ? this.socket.writableLength
      : 0;
  }

  close() {
    this._closed = true;
    this.peerSupportsBinary = false;
    this.sessionReady = false;
    this.sessionState = null;
    if (this.handshakeTimer) clearTimeout(this.handshakeTimer);
    this.handshakeTimer = null;
    try { if (this.socket && !this.socket.destroyed) this.socket.destroy(); } catch { /* ignore */ }
    try { if (this.webSocket && this.webSocket.readyState < 2) this.webSocket.close(); } catch { /* ignore */ }
  }
}

function sendTcp(socket, object) {
  try { socket.write(JSON.stringify(object) + '\n'); } catch { /* peer gone */ }
}

module.exports = {
  REMOTE_SECRET_BYTES,
  REMOTE_SECRET_PATTERN,
  SYNC_RUN_PATTERN,
  BINARY_RELAY_FEATURE,
  RelayClient,
  controlRoomForSecret,
  createRemoteInvite,
  memberForSecret,
  newRemoteSecret,
  legacyPairSecretForTeam,
  parseRelayAddress,
  roomForSecret,
};
