'use strict';

// Carry relay: a small in-memory router for encrypted Carry frames.
//
// Two listeners are available:
//   * startRelay()    — legacy raw TCP for a directly reachable host:port.
//   * startWebRelay() — WebSocket over HTTP/HTTPS, suitable for HTTP tunnels.
//
// Both use the same room, allowlist, expiry, and resource-limit logic. The
// relay only accepts encrypted application envelopes after the clear join
// frame and forwards those envelopes verbatim.

const fs = require('fs');
const http = require('http');
const net = require('net');
const path = require('path');
const { acceptWebSocket, DEFAULT_MAX_MESSAGE_BYTES } = require('../lib/websocket');
const frameCrypto = require('../lib/crypto');

const ROOM_TTL_MS = 10 * 60 * 1000;
const PREAUTH_TIMEOUT_MS = 15 * 1000;
const MAX_BAD_ATTEMPTS = 8;
const ROOM_LOCK_MS = 5 * 60 * 1000;
const MAX_CONNECTIONS = 64;
const MAX_CONNECTIONS_PER_IP = 8;
const MAX_CONNECTIONS_PER_WINDOW = 30;
const CONNECTION_WINDOW_MS = 60 * 1000;
const MAX_FRAME_BYTES = DEFAULT_MAX_MESSAGE_BYTES;
const BINARY_RELAY_FEATURE = 'encrypted-binary-v2';
const SYNC_RUN_PATTERN = /^[a-f0-9]{24}$/i;

function relayFeatures(value, channel) {
  if (!channel.supportsBinary || !Array.isArray(value)) return [];
  return value.slice(0, 16).some((feature) => feature === BINARY_RELAY_FEATURE)
    ? [BINARY_RELAY_FEATURE]
    : [];
}

function loadAllowlist(manifestPath) {
  if (!fs.existsSync(manifestPath)) return null;
  let doc;
  try { doc = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); }
  catch { throw new Error('relay manifest is corrupt; refusing to start in open mode'); }
  if (!doc || typeof doc !== 'object' || !Array.isArray(doc.allowlist) ||
      doc.allowlist.some((id) => !/^[A-Za-z0-9_-]{6,128}$/.test(String(id || '')))) {
    throw new Error('relay manifest allowlist is invalid; refusing to start in open mode');
  }
  return new Set(doc.allowlist.map(String));
}

function persistAuthorized(manifestPath, deviceId) {
  let doc = {};
  if (fs.existsSync(manifestPath)) {
    try { doc = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); }
    catch { throw new Error('relay manifest is corrupt; authorization was not changed'); }
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc) ||
      (doc.allowlist !== undefined && !Array.isArray(doc.allowlist))) {
    throw new Error('relay manifest allowlist is invalid; authorization was not changed');
  }
  if (!Array.isArray(doc.allowlist)) doc.allowlist = [];
  if (!doc.allowlist.includes(deviceId)) doc.allowlist.push(deviceId);
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.writeFileSync(manifestPath, JSON.stringify(doc, null, 2) + '\n');
  return new Set(doc.allowlist.map(String));
}

function createRelayHub(opts) {
  opts = opts || {};
  const manifestPath = opts.manifestPath || path.join(process.cwd(), '.carry', 'manifest.json');
  let allowlist = opts.ignoreAllowlist ? null : loadAllowlist(manifestPath);
  const allowedRooms = opts.allowedRooms
    ? opts.dynamicAllowedRooms && opts.allowedRooms instanceof Set
      ? opts.allowedRooms
      : new Set(Array.from(opts.allowedRooms, (room) => String(room).toUpperCase()))
    : null;
  const deniedRoomMessages = opts.deniedRoomMessages instanceof Map ? opts.deniedRoomMessages : null;
  const autoAuthorizeFirst = !!opts.autoAuthorizeFirst && !opts.ignoreAllowlist;
  const maxConnections = opts.maxConnections || MAX_CONNECTIONS;
  const maxConnectionsPerIp = opts.maxConnectionsPerIp || MAX_CONNECTIONS_PER_IP;
  const maxConnectionsPerWindow = opts.maxConnectionsPerWindow || MAX_CONNECTIONS_PER_WINDOW;
  const connectionWindowMs = opts.connectionWindowMs || CONNECTION_WINDOW_MS;
  const roomTtlMs = opts.roomTtlMs || ROOM_TTL_MS;

  const rooms = new Map();
  const failures = new Map();
  const connections = new Set();
  const sources = new Map();

  if (opts.quiet) {
    // The desktop launcher owns redirected stdout. App-hosted relays stay
    // silent so an unexpectedly closed launcher pipe cannot terminate Node.
  } else if (allowedRooms) {
    console.log(`carry relay: secure-invite mode (${allowedRooms.size} allowed room(s)).`);
  } else if (allowlist) {
    console.log(`carry relay: device allowlist ENABLED (${allowlist.size} trusted device(s)).`);
  } else if (autoAuthorizeFirst) {
    console.log('carry relay: no allowlist yet — first joining device will be authorized automatically.');
  } else {
    console.log('carry relay: NO allowlist found — relay is in OPEN mode (room secret required).');
  }

  function send(channel, frame) {
    try { channel.send(frame); } catch { /* peer disappeared */ }
  }

  function roomFailure(key) {
    const now = Date.now();
    let failure = failures.get(key);
    if (!failure || (failure.lockedUntil && now >= failure.lockedUntil)) {
      failure = { attempts: 0, lockedUntil: 0, lastAttempt: now };
    }
    failure.attempts += 1;
    failure.lastAttempt = now;
    if (failure.attempts >= MAX_BAD_ATTEMPTS) {
      failure.attempts = 0;
      failure.lockedUntil = now + ROOM_LOCK_MS;
    }
    failures.set(key, failure);
  }

  function locked(key) {
    const failure = failures.get(key);
    return !!(failure && failure.lockedUntil && Date.now() < failure.lockedUntil);
  }

  function attach(channel, rawSourceIp) {
    const sourceIp = String(rawSourceIp || 'unknown').replace(/^::ffff:/, '');
    const now = Date.now();
    let source = sources.get(sourceIp);
    if (!source) {
      source = { active: 0, attempts: 0, windowStart: now };
      sources.set(sourceIp, source);
    } else if (now - source.windowStart >= connectionWindowMs) {
      // Keep the same object: existing channels' close callbacks retain this
      // reference. Replacing it would make those callbacks decrement an old
      // object and leave a permanent ghost active-count in the Map.
      source.attempts = 0;
      source.windowStart = now;
    }
    source.attempts += 1;

    if (connections.size >= maxConnections ||
        source.active >= maxConnectionsPerIp ||
        source.attempts > maxConnectionsPerWindow) {
      send(channel, { type: 'relay-error', message: 'relay connection limit reached — try again later' });
      channel.close();
      return false;
    }

    connections.add(channel);
    source.active += 1;
    let joined = null;
    let released = false;
    const preauthTimer = setTimeout(() => {
      if (!joined && !released) channel.close();
    }, opts.preauthTimeoutMs || PREAUTH_TIMEOUT_MS);
    preauthTimer.unref?.();

    const markJoined = (value) => {
      joined = value;
      clearTimeout(preauthTimer);
    };

    const release = () => {
      if (released) return;
      released = true;
      clearTimeout(preauthTimer);
      connections.delete(channel);
      source.active = Math.max(0, source.active - 1);

      if (joined) {
        const room = rooms.get(joined.roomKey);
        // A room key can be reused as soon as one side of the previous sync
        // leaves. The other old socket may finish closing later; it must not
        // tear down a newer room that happens to use the same invitation.
        if (room && (room.a === channel || room.b === channel)) {
          clearTimeout(room.timer);
          const other = room.a === channel ? room.b : room.a;
          if (other && !other.destroyed) send(other, { type: 'relay-peer-gone' });
          rooms.delete(joined.roomKey);
        }
      }
      if (source.active === 0 && Date.now() - source.windowStart >= connectionWindowMs) {
        sources.delete(sourceIp);
      }
    };
    channel.onClose(release);

    channel.onMessage((frame) => {
      if (Buffer.isBuffer(frame)) {
        if (!joined) {
          send(channel, { type: 'relay-error', message: 'join the relay before sending frames' });
          return;
        }
        const room = rooms.get(joined.roomKey);
        if (!room || (room.a !== channel && room.b !== channel)) {
          send(channel, { type: 'relay-error', message: 'relay room is no longer active' });
          channel.close();
          return;
        }
        const binaryNegotiated = room.aInfo.features.includes(BINARY_RELAY_FEATURE) &&
          room.bInfo && room.bInfo.features.includes(BINARY_RELAY_FEATURE);
        if (!binaryNegotiated) {
          send(channel, { type: 'relay-error', message: 'encrypted binary transport was not negotiated' });
          return;
        }
        if (!frameCrypto.isBinaryEnvelope(frame)) {
          send(channel, { type: 'relay-error', message: 'relay accepts recognized encrypted binary frames only' });
          return;
        }
        const other = room.a === channel ? room.b : room.a;
        if (other && !other.destroyed && other.supportsBinary) send(other, frame);
        return;
      }
      if (!frame || typeof frame !== 'object' || Array.isArray(frame)) return;

      if (frame.type === 'join') {
        if (joined) {
          send(channel, { type: 'relay-error', message: 'connection already joined a room' });
          return;
        }
        const key = String(frame.room || '').toUpperCase();
        const syncRunId = frame.syncRunId === undefined ? null : String(frame.syncRunId).toLowerCase();
        const roomKey = syncRunId ? `${key}:${syncRunId}` : key;
        const deviceId = String(frame.deviceId || '');
        const name = String(frame.name || '').trim().slice(0, 80);
        if (!/^[A-Z0-9]{6,64}$/.test(key) || !/^[A-Za-z0-9_-]{6,128}$/.test(deviceId) || /[\r\n\0]/.test(name)) {
          send(channel, { type: 'relay-error', message: 'invalid relay join' });
          return;
        }
        if (syncRunId !== null && !SYNC_RUN_PATTERN.test(syncRunId)) {
          send(channel, { type: 'relay-error', message: 'invalid relay sync run' });
          return;
        }
        if (allowedRooms && !allowedRooms.has(key)) {
          const deniedMessage = deniedRoomMessages && deniedRoomMessages.get(key);
          if (!deniedMessage) roomFailure(key);
          send(channel, {
            type: 'relay-error',
            message: deniedMessage || 'remote invite is not valid for this relay',
          });
          return;
        }
        if (locked(key)) {
          send(channel, { type: 'relay-error', message: 'room temporarily locked — try again later' });
          return;
        }
        if (allowlist && !allowlist.has(deviceId)) {
          if (autoAuthorizeFirst && allowlist.size === 0) {
            try { allowlist = persistAuthorized(manifestPath, deviceId); }
            catch (error) {
              send(channel, { type: 'relay-error', message: error.message });
              return;
            }
            console.log(`carry relay: authorized first device ${deviceId.slice(0, 6)}.`);
          } else {
            roomFailure(key);
            send(channel, { type: 'relay-error', message: 'device not authorized for this relay' });
            return;
          }
        } else if (!allowlist && autoAuthorizeFirst) {
          try { allowlist = persistAuthorized(manifestPath, deviceId); }
          catch (error) {
            send(channel, { type: 'relay-error', message: error.message });
            return;
          }
          console.log(`carry relay: authorized first device ${deviceId.slice(0, 6)}.`);
        }

        const member = { deviceId, name, features: relayFeatures(frame.features, channel) };
        let room = rooms.get(roomKey);
        if (!room) {
          markJoined({ roomKey, member });
          room = {
            a: channel,
            b: null,
            aInfo: member,
            bInfo: null,
            timer: setTimeout(() => {
              const current = rooms.get(roomKey);
              if (current !== room) return;
              if (room.a && !room.a.destroyed) {
                send(room.a, { type: 'relay-error', message: 'relay room expired waiting for peer' });
              }
              rooms.delete(roomKey);
            }, roomTtlMs),
          };
          room.timer.unref?.();
          rooms.set(roomKey, room);
          send(channel, { type: 'relay-wait', room: key, message: 'waiting for peer to join' });
          return;
        }
        if (!room.b && room.a !== channel && room.aInfo.deviceId !== deviceId) {
          markJoined({ roomKey, member });
          room.b = channel;
          room.bInfo = member;
          clearTimeout(room.timer);
          const features = room.aInfo.features.includes(BINARY_RELAY_FEATURE) &&
            room.bInfo.features.includes(BINARY_RELAY_FEATURE)
            ? [BINARY_RELAY_FEATURE]
            : [];
          send(room.a, {
            type: 'relay-ready', room: key,
            peer: { deviceId: room.bInfo.deviceId, name: room.bInfo.name },
            features,
          });
          send(room.b, {
            type: 'relay-ready', room: key,
            peer: { deviceId: room.aInfo.deviceId, name: room.aInfo.name },
            features,
          });
          return;
        }
        send(channel, { type: 'relay-error', message: 'room full or duplicate device' });
        return;
      }

      if (!joined) {
        send(channel, { type: 'relay-error', message: 'join the relay before sending frames' });
        return;
      }
      if (frame.v !== 1 || typeof frame.c !== 'string' || typeof frame.n !== 'string' ||
          typeof frame.s !== 'string') {
        send(channel, { type: 'relay-error', message: 'relay accepts encrypted frames only' });
        return;
      }
      const room = rooms.get(joined.roomKey);
      if (!room || (room.a !== channel && room.b !== channel)) {
        send(channel, { type: 'relay-error', message: 'relay room is no longer active' });
        channel.close();
        return;
      }
      const other = room.a === channel ? room.b : room.a;
      if (other && !other.destroyed) send(other, frame);
    });
    return true;
  }

  const cleanup = setInterval(() => {
    const now = Date.now();
    for (const [ip, source] of sources) {
      if (source.active === 0 && now - source.windowStart >= connectionWindowMs) sources.delete(ip);
    }
    for (const [key, failure] of failures) {
      if ((!failure.lockedUntil || now >= failure.lockedUntil) &&
          now - failure.lastAttempt >= ROOM_LOCK_MS) failures.delete(key);
    }
  }, connectionWindowMs);
  cleanup.unref();

  function close() {
    clearInterval(cleanup);
    for (const room of rooms.values()) clearTimeout(room.timer);
    rooms.clear();
    for (const channel of connections) {
      try { channel.close(); } catch { /* ignore */ }
    }
    connections.clear();
  }

  return { attach, close };
}

function rawChannel(socket) {
  let messageHandler = () => {};
  let closeHandler = () => {};
  let buffer = '';
  socket.setEncoding('utf8');
  socket.on('error', () => {});
  socket.on('data', (chunk) => {
    buffer += chunk;
    if (Buffer.byteLength(buffer, 'utf8') > MAX_FRAME_BYTES) {
      socket.destroy();
      return;
    }
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (!line.trim()) continue;
      try { messageHandler(JSON.parse(line)); } catch { /* malformed frame */ }
    }
  });
  socket.once('close', () => closeHandler());
  return {
    get destroyed() { return socket.destroyed; },
    supportsBinary: false,
    send(frame) { socket.write(JSON.stringify(frame) + '\n'); },
    close() { socket.end(); },
    onMessage(handler) { messageHandler = handler; },
    onClose(handler) { closeHandler = handler; },
  };
}

function webSocketChannel(connection) {
  let messageHandler = () => {};
  let closeHandler = () => {};
  connection.on('message', (message) => {
    if (Buffer.isBuffer(message)) {
      messageHandler(message);
      return;
    }
    try { messageHandler(JSON.parse(message)); } catch { /* malformed frame */ }
  });
  connection.once('close', () => closeHandler());
  return {
    get destroyed() { return connection.destroyed; },
    supportsBinary: true,
    send(frame) { connection.send(Buffer.isBuffer(frame) ? frame : JSON.stringify(frame)); },
    close() { connection.close(); },
    onMessage(handler) { messageHandler = handler; },
    onClose(handler) { closeHandler = handler; },
  };
}

function bindRelayShutdown(server, hub) {
  const closeServer = server.close.bind(server);
  let hubClosed = false;
  const closeHub = () => {
    if (hubClosed) return;
    hubClosed = true;
    hub.close();
  };
  // HTTP server.close() waits for upgraded sockets, so close relay channels
  // first. Otherwise a WebSocket relay can wait forever for its own 'close'
  // event before the hub gets the instruction to release those sockets.
  server.close = function closeRelay(callback) {
    closeHub();
    return closeServer(callback);
  };
  server.on('close', closeHub);
}

function startRelay(port, opts) {
  opts = opts || {};
  const hub = createRelayHub(opts);
  const server = net.createServer((socket) => hub.attach(rawChannel(socket), socket.remoteAddress));
  bindRelayShutdown(server, hub);
  server.listen(port, opts.host, () => {
    if (!opts.quiet) console.log(`carry relay listening on :${server.address().port} (raw TCP, encrypted-frame forwarder)`);
  });
  return server;
}

function startWebRelay(port, opts) {
  opts = opts || {};
  const hub = createRelayHub(opts);
  const server = http.createServer((req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (req.method === 'GET' && req.url === '/') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ service: 'carry-relay', transport: 'websocket', version: 1 }));
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'not found' }));
  });
  server.headersTimeout = PREAUTH_TIMEOUT_MS;
  server.requestTimeout = PREAUTH_TIMEOUT_MS;
  server.keepAliveTimeout = 5000;
  server.on('upgrade', (req, socket, head) => {
    let pathname;
    try { pathname = new URL(req.url, 'http://relay.local').pathname; } catch { pathname = ''; }
    if (pathname !== '/carry') {
      socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      return;
    }
    const connection = acceptWebSocket(req, socket, head, { maxMessageBytes: MAX_FRAME_BYTES });
    if (!connection) return;
    let sourceIp = socket.remoteAddress;
    if (opts.trustProxy) {
      const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
      if (forwarded) sourceIp = forwarded;
    }
    hub.attach(webSocketChannel(connection), sourceIp);
  });
  server.on('clientError', (_error, socket) => {
    try { socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); } catch { /* ignore */ }
  });
  bindRelayShutdown(server, hub);
  server.listen(port, opts.host || '127.0.0.1', () => {
    if (!opts.quiet) console.log(`carry web relay listening on http://${opts.host || '127.0.0.1'}:${server.address().port}/carry`);
  });
  return server;
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const port = parseInt(args.includes('--port') ? args[args.indexOf('--port') + 1] : '48125', 10);
  if (args.includes('--web')) startWebRelay(port, { host: '0.0.0.0' });
  else startRelay(port);
}

module.exports = {
  startRelay,
  startWebRelay,
  createRelayHub,
  ROOM_TTL_MS,
  MAX_BAD_ATTEMPTS,
  ROOM_LOCK_MS,
  MAX_CONNECTIONS,
  MAX_CONNECTIONS_PER_IP,
  MAX_CONNECTIONS_PER_WINDOW,
  CONNECTION_WINDOW_MS,
  MAX_FRAME_BYTES,
  BINARY_RELAY_FEATURE,
};
