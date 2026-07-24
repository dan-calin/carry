'use strict';

const dgram = require('dgram');
const net = require('net');
const crypto = require('crypto');
const manifest = require('./manifest');
const frameCrypto = require('./crypto');

// Peer-to-peer transport for Carry.
//
// Two layers, both dependency-free (Node built-ins only):
//   1. Discovery: UDP multicast advertises a one-way lookup plus a device
//      label. The high-entropy pairing secret itself is never broadcast.
//   2. Link: a plain TCP JSON-line (NDJSON) channel carries sync bundles. We use
//      NDJSON frames so it matches the rest of the project's file conventions.
//
// Relay fallback: `RelayTransport` is the common client interface. Carry stays
// offline until a user explicitly creates or joins a remote invitation. That
// action exposes a local encrypted WebSocket forwarder through a temporary
// HTTPS tunnel; closing the session removes the endpoint.

const DISCOVERY_PORT = 48123;
const MULTICAST_ADDR = '239.255.42.13';
const MAX_LINE_BYTES = 2 * 1024 * 1024;
const MAX_INBOUND_CONNECTIONS = 16;
const PREAUTH_TIMEOUT_MS = 15 * 1000;
const HANDSHAKE_INFO = 'carry-lan-handshake-v1';
const SESSION_NONCE_PATTERN = /^[A-Za-z0-9_-]{32}$/;
const SESSION_STATE = Symbol('carryAuthenticatedSession');

function newSessionNonce() {
  return crypto.randomBytes(24).toString('base64url');
}

function lanSessionBinding(clientNonce, serverNonce) {
  return crypto.createHash('sha256')
    .update('carry-lan-session-v1\0', 'utf8')
    .update(clientNonce, 'utf8')
    .update('\0', 'utf8')
    .update(serverNonce, 'utf8')
    .digest('hex');
}

function handshakeEnvelope(frame, code, salt) {
  return frameCrypto.encryptFrame(frame, code, salt, HANDSHAKE_INFO);
}

function decodeSessionEnvelope(socket, env, code) {
  const state = socket[SESSION_STATE];
  if (!state) throw new Error('encrypted Carry session is not established');
  const wrapped = frameCrypto.decryptFrame(env, code, frameCrypto.sessionInfo(state.binding));
  return frameCrypto.openSessionFrame(state, wrapped);
}

function deviceLabel(manifestDoc) {
  return manifestDoc.name + '@' + manifestDoc.deviceId.slice(0, 6);
}

function newLanSecret() {
  return crypto.randomBytes(16).toString('hex').toUpperCase();
}

function discoveryLookup(secret) {
  return crypto.createHash('sha256')
    .update('carry-lan-discovery-v2\0')
    .update(String(secret))
    .digest('hex')
    .toUpperCase();
}

function discoveryPacket(secret, manifestDoc, linkPort) {
  return Buffer.from(JSON.stringify({
    v: 2,
    lookup: discoveryLookup(secret),
    deviceId: manifestDoc.deviceId,
    name: manifestDoc.name,
    port: linkPort,
  }));
}

function parseDiscoveryPacket(buffer) {
  const text = Buffer.from(buffer).toString('utf8');
  let value;
  try {
    const parsed = JSON.parse(text);
    if (parsed && parsed.v === 2) value = parsed;
  } catch { /* accept the v1 space-delimited packet below */ }
  if (!value) {
    const parts = text.split(' ');
    if (parts.length < 3) return null;
    const possiblePort = Number.parseInt(parts.at(-1), 10);
    const hasPort = Number.isInteger(possiblePort) && possiblePort >= 1 && possiblePort <= 65535;
    value = {
      code: parts[0],
      deviceId: parts[1],
      name: parts.slice(2, hasPort ? -1 : undefined).join(' '),
      port: hasPort ? possiblePort : 48124,
    };
  }
  const port = Number.parseInt(value.port, 10);
  const lookup = value.lookup || (value.code ? discoveryLookup(value.code) : '');
  if (!/^[A-F0-9]{64}$/i.test(String(lookup)) ||
      !/^[A-Za-z0-9_-]{6,128}$/.test(String(value.deviceId || '')) ||
      typeof value.name !== 'string' || !value.name.trim() || value.name.length > 80 || value.name.includes('\0') ||
      !Number.isInteger(port) || port < 1 || port > 65535) {
    return null;
  }
  return { lookup: String(lookup).toUpperCase(), deviceId: String(value.deviceId), name: value.name, port };
}

// Advertise a pairing lookup on the LAN for `ttlMs` (default 2 min). Resolves with
// the socket so the caller can stop advertising. Discovery packets are tiny and
// contain only a one-way lookup + device id + project name — no pairing secret
// and no file contents.
function advertise(code, manifestDoc, ttlMs = 120000, linkPort = 48124) {
  const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  const msg = discoveryPacket(code, manifestDoc, linkPort);
  sock.bind(() => {
    try { sock.setBroadcast(true); } catch { /* ignore */ }
  });
  const timer = setInterval(() => {
    sock.send(msg, 0, msg.length, DISCOVERY_PORT, MULTICAST_ADDR, () => {});
  }, 1000);
  sock.send(msg, 0, msg.length, DISCOVERY_PORT, MULTICAST_ADDR, () => {});
  let ttlTimer = null;
  const stop = () => {
    clearInterval(timer);
    if (ttlTimer) clearTimeout(ttlTimer);
    try { sock.close(); } catch { /* ignore */ }
  };
  ttlTimer = setTimeout(stop, ttlMs);
  return { stop };
}

// Listen for a peer advertising `code`. On match, resolves with the peer's
// {deviceId, name, address} so the caller can open the TCP link. Times out.
function discover(code, timeoutMs = 120000, expectedDeviceId) {
  return new Promise((resolve, reject) => {
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    const timer = setTimeout(() => {
      try { sock.close(); } catch { /* ignore */ }
      reject(new Error('pairing timed out — no peer advertising that code on the LAN'));
    }, timeoutMs);
    const expectedLookup = discoveryLookup(code);
    sock.on('error', (err) => {
      clearTimeout(timer);
      try { sock.close(); } catch { /* already closed */ }
      reject(err);
    });
    sock.on('message', (buf, rinfo) => {
      const packet = parseDiscoveryPacket(buf);
      if (packet && packet.lookup === expectedLookup &&
          (!expectedDeviceId || packet.deviceId === expectedDeviceId)) {
        clearTimeout(timer);
        try { sock.close(); } catch { /* ignore */ }
        resolve({ deviceId: packet.deviceId, name: packet.name, address: rinfo.address, port: packet.port });
      }
    });
    sock.bind(DISCOVERY_PORT, () => {
      try { sock.addMembership(MULTICAST_ADDR); } catch { /* ignore */ }
    });
  });
}

// Send a single JSON frame over a TCP socket as one NDJSON line.
function sendFrame(socket, obj) {
  socket.write(JSON.stringify(obj) + '\n');
}

// Open a TCP link to a peer address and run a tiny request/response handshake.
// `handler(frame, respond)` is called for each incoming frame.
function connect(address, port, onFrame) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, address, () => resolve(socket));
    socket.setEncoding('utf8');
    socket.on('error', reject);
    let buf = '';
    socket.on('data', (chunk) => {
      buf += chunk;
      if (Buffer.byteLength(buf, 'utf8') > MAX_LINE_BYTES) {
        socket.destroy(new Error('Carry frame exceeds the connection limit'));
        return;
      }
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (!line.trim()) continue;
        try { onFrame(JSON.parse(line), (r) => sendFrame(socket, r)); } catch { /* skip bad frame */ }
      }
    });
  });
}

// Listen for an incoming TCP link on `port`; for each connection, call
// `onFrame(frame, respond)`. Returns the server.
function serve(port, onFrame) {
  let activeConnections = 0;
  const server = net.createServer((socket) => {
    if (activeConnections >= MAX_INBOUND_CONNECTIONS) {
      socket.destroy();
      return;
    }
    activeConnections += 1;
    socket.once('close', () => { activeConnections = Math.max(0, activeConnections - 1); });
    socket.on('error', () => { /* a peer may disconnect between response frames */ });
    socket.setEncoding('utf8');
    let buf = '';
    socket.on('data', (chunk) => {
      buf += chunk;
      if (Buffer.byteLength(buf, 'utf8') > MAX_LINE_BYTES) {
        socket.destroy(new Error('Carry frame exceeds the connection limit'));
        return;
      }
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (!line.trim()) continue;
        try { onFrame(JSON.parse(line), (r) => sendFrame(socket, r), socket.remoteAddress); } catch { /* skip bad frame */ }
      }
    });
  });
  server.listen(port);
  return server;
}

// --- Encrypted LAN frames ---
// Same AEAD scheme as the relay path, keyed by the pairing code, so LAN sync is
// also opaque to anyone on the wire. `code` is the shared secret (never sent in
// cleartext). Each connection gets a fresh salt; the envelope carries it.

function connectEncrypted(address, port, code, onFrame, connectTimeoutMs) {
  return new Promise((resolve, reject) => {
    let connectTimer = null;
    let settled = false;
    const handshakeTimeoutMs = Number.isInteger(connectTimeoutMs) && connectTimeoutMs > 0
      ? connectTimeoutMs
      : PREAUTH_TIMEOUT_MS;
    const clientNonce = newSessionNonce();
    const socket = net.connect(port, address, () => {
      const hello = handshakeEnvelope({
        type: 'carry-session-hello', version: 1, clientNonce,
      }, code, frameCrypto.newSalt());
      socket.write(JSON.stringify(hello) + '\n');
    });
    socket.setEncoding('utf8');
    socket.on('error', (err) => {
      if (connectTimer) clearTimeout(connectTimer);
      if (!settled) { settled = true; reject(err); }
    });
    socket.on('close', () => {
      if (connectTimer) clearTimeout(connectTimer);
      if (!settled) {
        settled = true;
        reject(new Error(`encrypted Carry handshake closed before authentication (${address}:${port})`));
      }
    });
    connectTimer = setTimeout(() => {
      const err = new Error(`connect ETIMEDOUT ${address}:${port}`);
      err.code = 'ETIMEDOUT';
      socket.destroy(err);
    }, handshakeTimeoutMs);
    connectTimer.unref?.();
    const salt = frameCrypto.newSalt();
    let buf = '';
    socket.on('data', (chunk) => {
      buf += chunk;
      if (Buffer.byteLength(buf, 'utf8') > MAX_LINE_BYTES) {
        socket.destroy(new Error('encrypted Carry frame exceeds the connection limit'));
        return;
      }
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (!line.trim()) continue;
        let env;
        try { env = JSON.parse(line); } catch { continue; }
        if (!env || env.v !== 1 || !env.c) continue; // only encrypted frames accepted
        let frame;
        if (!socket[SESSION_STATE]) {
          try { frame = frameCrypto.decryptFrame(env, code, HANDSHAKE_INFO); }
          catch { socket.destroy(new Error('encrypted Carry handshake authentication failed')); return; }
          if (!frame || frame.type !== 'carry-session-ack' || frame.version !== 1 ||
              frame.clientNonce !== clientNonce || !SESSION_NONCE_PATTERN.test(String(frame.serverNonce || ''))) {
            socket.destroy(new Error('encrypted Carry handshake was invalid'));
            return;
          }
          socket[SESSION_STATE] = frameCrypto.createSessionState(
            lanSessionBinding(clientNonce, frame.serverNonce),
          );
          if (connectTimer) clearTimeout(connectTimer);
          if (!settled) { settled = true; resolve(socket); }
          continue;
        }
        try { frame = decodeSessionEnvelope(socket, env, code); }
        catch { socket.destroy(new Error('replayed or invalid encrypted Carry frame')); return; }
        try { onFrame(frame, (r) => sendEncrypted(socket, r, code, salt)); } catch { /* skip */ }
      }
    });
  });
}

function serveEncrypted(port, code, onFrame) {
  let activeConnections = 0;
  const server = net.createServer((socket) => {
    if (activeConnections >= MAX_INBOUND_CONNECTIONS) {
      socket.destroy();
      return;
    }
    activeConnections += 1;
    socket.once('close', () => { activeConnections = Math.max(0, activeConnections - 1); });
    socket.on('error', () => { /* a peer may disconnect between encrypted response frames */ });
    socket.setEncoding('utf8');
    const preauthTimer = setTimeout(() => socket.destroy(), PREAUTH_TIMEOUT_MS);
    preauthTimer.unref?.();
    socket.once('close', () => clearTimeout(preauthTimer));
    let authenticated = false;
    const salt = frameCrypto.newSalt();
    let buf = '';
    socket.on('data', (chunk) => {
      buf += chunk;
      if (Buffer.byteLength(buf, 'utf8') > MAX_LINE_BYTES) {
        socket.destroy(new Error('encrypted Carry frame exceeds the connection limit'));
        return;
      }
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (!line.trim()) continue;
        let env;
        try { env = JSON.parse(line); } catch { continue; }
        if (!env || env.v !== 1 || !env.c) continue;
        let frame;
        if (!authenticated) {
          try { frame = frameCrypto.decryptFrame(env, code, HANDSHAKE_INFO); }
          catch { socket.destroy(); return; }
          if (!frame || frame.type !== 'carry-session-hello' || frame.version !== 1 ||
              !SESSION_NONCE_PATTERN.test(String(frame.clientNonce || ''))) {
            socket.destroy();
            return;
          }
          const serverNonce = newSessionNonce();
          socket[SESSION_STATE] = frameCrypto.createSessionState(
            lanSessionBinding(frame.clientNonce, serverNonce),
          );
          const ack = handshakeEnvelope({
            type: 'carry-session-ack', version: 1, clientNonce: frame.clientNonce, serverNonce,
          }, code, frameCrypto.newSalt());
          socket.write(JSON.stringify(ack) + '\n');
          authenticated = true;
          clearTimeout(preauthTimer);
          continue;
        }
        try { frame = decodeSessionEnvelope(socket, env, code); }
        catch { socket.destroy(); return; }
        try {
          onFrame(
            frame,
            (r) => sendEncrypted(socket, r, code, salt),
            socket.remoteAddress,
            () => {},
          );
        } catch { /* skip */ }
      }
    });
  });
  server.listen(port);
  return server;
}

function sendEncrypted(socket, obj, code, salt) {
  const state = socket && socket[SESSION_STATE];
  if (!state) throw new Error('encrypted Carry session is not established');
  const wrapped = frameCrypto.sealSessionFrame(state, obj);
  const env = frameCrypto.encryptFrame(wrapped, code, salt, frameCrypto.sessionInfo(state.binding));
  return socket.write(JSON.stringify(env) + '\n');
}

// --- Abstract relay (no default). ---
class RelayTransport {
  constructor() { this.url = null; }
  setRelay(url) { this.url = url; }
  // Override in a concrete subclass to forward a frame through your relay.
  async send(_frame) {
    if (!this.url) throw new Error('no relay configured — set one with setRelay(url) or pair on the same LAN');
    throw new Error('RelayTransport.send must be implemented by a concrete relay');
  }
}

module.exports = {
  DISCOVERY_PORT,
  MULTICAST_ADDR,
  advertise,
  discover,
  connect,
  serve,
  sendFrame,
  connectEncrypted,
  serveEncrypted,
  sendEncrypted,
  deviceLabel,
  RelayTransport,
  MAX_LINE_BYTES,
  MAX_INBOUND_CONNECTIONS,
  newLanSecret,
  discoveryLookup,
  discoveryPacket,
  parseDiscoveryPacket,
};
