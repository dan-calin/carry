'use strict';

// Minimal RFC 6455 server-side connection used by Carry's HTTPS relay.
// The packaged client uses Node's built-in WebSocket implementation; this file
// only handles HTTP upgrade + framing on the relay, keeping the project free of
// runtime packages. It intentionally supports text messages, fragmentation,
// ping/pong, and close frames — nothing browser-specific.

const crypto = require('crypto');
const { EventEmitter } = require('events');

const WEBSOCKET_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const DEFAULT_MAX_MESSAGE_BYTES = 128 * 1024 * 1024;

class ServerWebSocket extends EventEmitter {
  constructor(socket, head, maxMessageBytes) {
    super();
    this.socket = socket;
    this.buffer = head && head.length ? Buffer.from(head) : Buffer.alloc(0);
    this.maxMessageBytes = maxMessageBytes || DEFAULT_MAX_MESSAGE_BYTES;
    this.fragments = [];
    this.fragmentBytes = 0;
    this.fragmentOpcode = null;
    this.closed = false;

    socket.on('data', (chunk) => {
      if (this.closed) return;
      this.buffer = this.buffer.length
        ? Buffer.concat([this.buffer, chunk])
        : Buffer.from(chunk);
      try {
        this.parse();
      } catch (error) {
        this.fail(1002, error.message || 'invalid WebSocket frame');
      }
    });
    socket.on('error', (error) => this.finish(error));
    socket.on('close', () => this.finish());

    if (this.buffer.length) {
      process.nextTick(() => {
        try { this.parse(); } catch (error) { this.fail(1002, error.message); }
      });
    }
  }

  get destroyed() {
    return this.closed || this.socket.destroyed;
  }

  parse() {
    while (this.buffer.length >= 2 && !this.closed) {
      const first = this.buffer[0];
      const second = this.buffer[1];
      const final = (first & 0x80) !== 0;
      const opcode = first & 0x0f;
      const masked = (second & 0x80) !== 0;
      if ((first & 0x70) !== 0) throw new Error('reserved WebSocket bits are not supported');
      if (!masked) throw new Error('client WebSocket frames must be masked');

      let payloadLength = second & 0x7f;
      let offset = 2;
      if (payloadLength === 126) {
        if (this.buffer.length < 4) return;
        payloadLength = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (payloadLength === 127) {
        if (this.buffer.length < 10) return;
        const high = this.buffer.readUInt32BE(2);
        const low = this.buffer.readUInt32BE(6);
        if (high > 0x1fffff) throw new Error('WebSocket frame is too large');
        payloadLength = high * 0x100000000 + low;
        offset = 10;
      }
      if (payloadLength > this.maxMessageBytes) throw new Error('WebSocket frame exceeds Carry limit');
      if (opcode >= 8 && (!final || payloadLength > 125)) throw new Error('invalid WebSocket control frame');
      if (this.buffer.length < offset + 4 + payloadLength) return;

      const mask = this.buffer.subarray(offset, offset + 4);
      const payload = Buffer.from(this.buffer.subarray(offset + 4, offset + 4 + payloadLength));
      this.buffer = this.buffer.subarray(offset + 4 + payloadLength);
      for (let index = 0; index < payload.length; index++) {
        payload[index] ^= mask[index & 3];
      }
      this.handleFrame(opcode, final, payload);
    }
  }

  handleFrame(opcode, final, payload) {
    if (opcode === 8) {
      if (!this.closed) this.socket.write(encodeFrame(8, payload.subarray(0, 125)));
      this.closed = true;
      this.socket.end();
      return;
    }
    if (opcode === 9) {
      this.socket.write(encodeFrame(10, payload));
      return;
    }
    if (opcode === 10) return;

    if (opcode === 1 || opcode === 2) {
      if (this.fragmentOpcode !== null) throw new Error('new message before fragmented message completed');
      if (final) {
        this.emit('message', opcode === 1 ? payload.toString('utf8') : payload);
        return;
      }
      this.fragmentOpcode = opcode;
      this.fragments = [payload];
      this.fragmentBytes = payload.length;
      return;
    }
    if (opcode === 0) {
      if (this.fragmentOpcode === null) throw new Error('unexpected continuation frame');
      this.fragmentBytes += payload.length;
      if (this.fragmentBytes > this.maxMessageBytes) throw new Error('WebSocket message exceeds Carry limit');
      this.fragments.push(payload);
      if (final) {
        const opcodeForMessage = this.fragmentOpcode;
        const bytes = Buffer.concat(this.fragments, this.fragmentBytes);
        this.fragments = [];
        this.fragmentBytes = 0;
        this.fragmentOpcode = null;
        this.emit('message', opcodeForMessage === 1 ? bytes.toString('utf8') : bytes);
      }
      return;
    }
    throw new Error('unsupported WebSocket opcode');
  }

  send(value) {
    if (this.destroyed) return false;
    const binary = Buffer.isBuffer(value) || ArrayBuffer.isView(value);
    const payload = binary
      ? Buffer.from(value.buffer, value.byteOffset, value.byteLength)
      : Buffer.from(String(value), 'utf8');
    if (payload.length > this.maxMessageBytes) throw new Error('WebSocket message exceeds Carry limit');
    return this.socket.write(encodeFrame(binary ? 2 : 1, payload));
  }

  close(code, reason) {
    if (this.closed) return;
    const reasonBytes = Buffer.from(String(reason || ''), 'utf8').subarray(0, 123);
    const payload = Buffer.alloc(2 + reasonBytes.length);
    payload.writeUInt16BE(code || 1000, 0);
    reasonBytes.copy(payload, 2);
    this.socket.write(encodeFrame(8, payload));
    this.closed = true;
    this.socket.end();
    this._closeTimer = setTimeout(() => {
      if (!this.socket.destroyed) this.socket.destroy();
    }, 1000);
    this._closeTimer.unref?.();
  }

  fail(code, reason) {
    try { this.close(code || 1002, reason); } catch { this.socket.destroy(); }
    this.finish(new Error(reason || 'WebSocket protocol error'));
  }

  finish(error) {
    if (this._finished) return;
    this._finished = true;
    if (this._closeTimer) clearTimeout(this._closeTimer);
    this.closed = true;
    this.emit('close', error);
  }
}

function acceptWebSocket(req, socket, head, options) {
  options = options || {};
  const upgrade = String(req.headers.upgrade || '').toLowerCase();
  const connection = String(req.headers.connection || '').toLowerCase();
  const key = String(req.headers['sec-websocket-key'] || '');
  const version = String(req.headers['sec-websocket-version'] || '');
  if (req.method !== 'GET' || upgrade !== 'websocket' || !connection.includes('upgrade') ||
      version !== '13' || !/^[A-Za-z0-9+/]{22}==$/.test(key)) {
    socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    return null;
  }

  const accept = crypto.createHash('sha1').update(key + WEBSOCKET_GUID).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    'Sec-WebSocket-Accept: ' + accept + '\r\n\r\n');
  return new ServerWebSocket(socket, head, options.maxMessageBytes);
}

function encodeFrame(opcode, payload) {
  const length = payload.length;
  let header;
  if (length < 126) {
    header = Buffer.from([0x80 | opcode, length]);
  } else if (length <= 0xffff) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    const high = Math.floor(length / 0x100000000);
    const low = length >>> 0;
    header.writeUInt32BE(high, 2);
    header.writeUInt32BE(low, 6);
  }
  return Buffer.concat([header, payload]);
}

module.exports = {
  DEFAULT_MAX_MESSAGE_BYTES,
  ServerWebSocket,
  acceptWebSocket,
  encodeFrame,
};
