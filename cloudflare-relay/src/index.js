import { DurableObject } from 'cloudflare:workers';

// Carry's hosted relay is deliberately blind: the only cleartext message is
// the room join. Every application frame forwarded afterwards is already
// authenticated and encrypted by the two desktop clients.

const ROOM_PATTERN = /^[A-Z0-9]{6,64}$/;
const DEVICE_PATTERN = /^[A-Za-z0-9_-]{6,128}$/;
const SYNC_RUN_PATTERN = /^[a-f0-9]{24}$/;
const BINARY_RELAY_FEATURE = 'encrypted-binary-v2';
const BINARY_MAGIC = new Uint8Array([0x43, 0x52, 0x42, 0x32]); // CRB2
const BINARY_FLAGS_OFFSET = 4;
const MIN_BINARY_ENVELOPE_BYTES = 49;
const MAX_MESSAGE_BYTES = 2 * 1024 * 1024;
const ROOM_WAIT_MS = 10 * 60 * 1000;
const CONNECTIONS_PER_SOURCE_PER_MINUTE = 120;

function json(value, status = 200, headers = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...headers,
    },
  });
}

function roomRequest(request) {
  const url = new URL(request.url);
  const room = String(url.searchParams.get('room') || '').toUpperCase();
  const syncRunId = String(url.searchParams.get('syncRunId') || '').toLowerCase();
  if (!ROOM_PATTERN.test(room) || (syncRunId && !SYNC_RUN_PATTERN.test(syncRunId))) return null;
  return { room, syncRunId, key: syncRunId ? `${room}:${syncRunId}` : room };
}

function byteLength(message) {
  if (typeof message === 'string') return new TextEncoder().encode(message).byteLength;
  if (message instanceof ArrayBuffer) return message.byteLength;
  if (ArrayBuffer.isView(message)) return message.byteLength;
  return Number.POSITIVE_INFINITY;
}

function binaryEnvelope(message) {
  const bytes = message instanceof ArrayBuffer
    ? new Uint8Array(message)
    : ArrayBuffer.isView(message)
      ? new Uint8Array(message.buffer, message.byteOffset, message.byteLength)
      : null;
  if (!bytes || bytes.byteLength < MIN_BINARY_ENVELOPE_BYTES || bytes.byteLength > MAX_MESSAGE_BYTES) return false;
  for (let index = 0; index < BINARY_MAGIC.length; index += 1) {
    if (bytes[index] !== BINARY_MAGIC[index]) return false;
  }
  return bytes[BINARY_FLAGS_OFFSET] === 0;
}

function parseJoin(message) {
  if (typeof message !== 'string') return null;
  let frame;
  try { frame = JSON.parse(message); } catch { return null; }
  if (!frame || frame.type !== 'join' || typeof frame !== 'object' || Array.isArray(frame)) return null;
  const room = String(frame.room || '').toUpperCase();
  const syncRunId = frame.syncRunId === undefined ? '' : String(frame.syncRunId).toLowerCase();
  const deviceId = String(frame.deviceId || '');
  const name = String(frame.name || '').trim().slice(0, 80);
  if (!ROOM_PATTERN.test(room) || !DEVICE_PATTERN.test(deviceId) ||
      (syncRunId && !SYNC_RUN_PATTERN.test(syncRunId)) || /[\r\n\0]/.test(name)) return null;
  const features = Array.isArray(frame.features) && frame.features.slice(0, 16).includes(BINARY_RELAY_FEATURE)
    ? [BINARY_RELAY_FEATURE]
    : [];
  return { room, syncRunId, deviceId, name, features };
}

function encryptedTextEnvelope(message) {
  if (typeof message !== 'string') return false;
  let frame;
  try { frame = JSON.parse(message); } catch { return false; }
  return Boolean(frame && !Array.isArray(frame) && frame.v === 1 &&
    typeof frame.c === 'string' && typeof frame.n === 'string' && typeof frame.s === 'string');
}

function open(socket) {
  return socket && socket.readyState === WebSocket.OPEN;
}

function safeSend(socket, value) {
  if (!open(socket)) return false;
  try {
    socket.send(value);
    return true;
  } catch {
    return false;
  }
}

function sendControl(socket, value) {
  return safeSend(socket, JSON.stringify(value));
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.pathname === '/') {
      return json({
        service: 'carry-relay',
        transport: 'websocket',
        provider: 'cloudflare-durable-objects',
        version: 2,
      });
    }
    if (url.pathname !== '/carry') return json({ error: 'not found' }, 404);
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return json({ error: 'websocket upgrade required' }, 426, { Upgrade: 'websocket' });
    }
    const room = roomRequest(request);
    if (!room) return json({ error: 'valid Carry room routing is required' }, 400);
    const source = String(request.headers.get('CF-Connecting-IP') || 'local-development').slice(0, 128);
    const limiter = env.CARRY_LIMITERS.getByName(source);
    const limit = await limiter.fetch(new Request('https://carry-rate-limit.local/check', { method: 'POST' }));
    if (!limit.ok) return json({ error: 'relay connection rate limit reached; try again shortly' }, 429);
    return env.CARRY_ROOMS.getByName(room.key).fetch(request);
  },
};

// One limiter object is created per Cloudflare-supplied source IP. This avoids
// turning a global singleton into a bottleneck while preventing scanners from
// cheaply opening an unbounded number of room objects from one source.
export class ConnectionLimiter extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx;
    this.ctx.storage.sql.exec(
      'CREATE TABLE IF NOT EXISTS rate_window (id INTEGER PRIMARY KEY CHECK (id = 1), minute INTEGER NOT NULL, attempts INTEGER NOT NULL)',
    );
  }

  fetch(request) {
    if (request.method !== 'POST') return json({ error: 'not found' }, 404);
    const minute = Math.floor(Date.now() / 60000);
    const current = this.ctx.storage.sql
      .exec('SELECT minute, attempts FROM rate_window WHERE id = 1')
      .toArray()[0];
    if (current && current.minute === minute && current.attempts >= CONNECTIONS_PER_SOURCE_PER_MINUTE) {
      return json({ error: 'rate limited' }, 429);
    }
    const attempts = current && current.minute === minute ? current.attempts + 1 : 1;
    this.ctx.storage.sql.exec(
      'INSERT INTO rate_window (id, minute, attempts) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET minute = excluded.minute, attempts = excluded.attempts',
      minute,
      attempts,
    );
    return new Response(null, { status: 204 });
  }
}

export class CarryRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx;
  }

  sockets(except) {
    return this.ctx.getWebSockets().filter((socket) => socket !== except && open(socket));
  }

  joinedSockets(except) {
    return this.sockets(except).filter((socket) => {
      const attachment = socket.deserializeAttachment();
      return Boolean(attachment && attachment.joined);
    });
  }

  fail(socket, message, closeCode = 1008) {
    sendControl(socket, { type: 'relay-error', message });
    try { socket.close(closeCode, String(message).slice(0, 120)); } catch { /* already closed */ }
  }

  async fetch(request) {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return json({ error: 'websocket upgrade required' }, 426, { Upgrade: 'websocket' });
    }
    const room = roomRequest(request);
    if (!room) return json({ error: 'valid Carry room routing is required' }, 400);
    if (this.sockets().length >= 2) return json({ error: 'relay room is full' }, 409);

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({
      joined: false,
      room: room.room,
      syncRunId: room.syncRunId,
      connectedAt: Date.now(),
    });
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(socket, message) {
    if (byteLength(message) > MAX_MESSAGE_BYTES) {
      this.fail(socket, 'relay frame exceeds Carry limit', 1009);
      return;
    }
    const attachment = socket.deserializeAttachment();
    if (!attachment || !attachment.joined) {
      const member = parseJoin(message);
      if (!member || !attachment || member.room !== attachment.room ||
          member.syncRunId !== attachment.syncRunId) {
        this.fail(socket, 'invalid relay join');
        return;
      }
      const peers = this.joinedSockets(socket);
      if (peers.length > 1) {
        this.fail(socket, 'relay room is full');
        return;
      }
      if (peers.some((peer) => peer.deserializeAttachment()?.deviceId === member.deviceId)) {
        this.fail(socket, 'room full or duplicate device');
        return;
      }
      socket.serializeAttachment({ ...attachment, ...member, joined: true });
      if (!peers.length) {
        await this.ctx.storage.setAlarm(Date.now() + ROOM_WAIT_MS);
        sendControl(socket, { type: 'relay-wait', room: member.room, message: 'waiting for peer to join' });
        return;
      }

      await this.ctx.storage.deleteAlarm();
      const peer = peers[0];
      const peerMember = peer.deserializeAttachment();
      const features = member.features.includes(BINARY_RELAY_FEATURE) &&
        peerMember.features.includes(BINARY_RELAY_FEATURE)
        ? [BINARY_RELAY_FEATURE]
        : [];
      sendControl(peer, {
        type: 'relay-ready', room: member.room,
        peer: { deviceId: member.deviceId, name: member.name },
        features,
      });
      sendControl(socket, {
        type: 'relay-ready', room: member.room,
        peer: { deviceId: peerMember.deviceId, name: peerMember.name },
        features,
      });
      return;
    }

    const peers = this.joinedSockets(socket);
    if (peers.length !== 1) {
      this.fail(socket, 'relay room is no longer active', 1012);
      return;
    }
    const peer = peers[0];
    if (typeof message === 'string') {
      if (!encryptedTextEnvelope(message)) {
        this.fail(socket, 'relay accepts encrypted frames only');
        return;
      }
    } else {
      const peerAttachment = peer.deserializeAttachment();
      if (!attachment.features.includes(BINARY_RELAY_FEATURE) ||
          !peerAttachment.features.includes(BINARY_RELAY_FEATURE)) {
        this.fail(socket, 'encrypted binary transport was not negotiated');
        return;
      }
      if (!binaryEnvelope(message)) {
        this.fail(socket, 'relay accepts recognized encrypted binary frames only');
        return;
      }
    }
    if (!safeSend(peer, message)) this.fail(socket, 'relay peer disconnected', 1012);
  }

  async release(socket) {
    const attachment = socket.deserializeAttachment();
    // A socket that disconnects before a valid join never owned the room and
    // must not be allowed to evict an already joined peer.
    if (!attachment || !attachment.joined) return;
    const peers = this.sockets(socket);
    await this.ctx.storage.deleteAlarm();
    for (const peer of peers) {
      if (peer.deserializeAttachment()?.joined) {
        sendControl(peer, { type: 'relay-peer-gone' });
      } else {
        sendControl(peer, { type: 'relay-error', message: 'relay room is no longer active' });
      }
      try { peer.close(1012, 'relay peer disconnected'); } catch { /* already closed */ }
    }
  }

  async webSocketClose(socket) {
    await this.release(socket);
  }

  async webSocketError(socket) {
    await this.release(socket);
  }

  async alarm() {
    const sockets = this.sockets();
    const joined = sockets.filter((socket) => socket.deserializeAttachment()?.joined);
    if (joined.length >= 2) return;
    for (const socket of sockets) {
      this.fail(socket, 'relay room expired waiting for peer', 1008);
    }
  }
}
