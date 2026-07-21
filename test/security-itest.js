'use strict';

// Security-focused tests: AES-256-GCM frame encryption + device allowlist
// enforcement on the relay. Run: node test/security-itest.js

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const crypto = require('../lib/crypto');
const manifest = require('../lib/manifest');
const remoteRelay = require('../lib/relay');
const relay = require('../relay/server');

let passed = 0;
function check(name, cond) {
  assert.ok(cond, 'FAILED: ' + name);
  console.log('  \x1b[32m✓\x1b[0m ' + name);
  passed++;
}

// --- 1. Crypto roundtrip + wrong-code rejection ---
(function cryptoTests() {
  const code = 'ABCD12';
  const salt = crypto.newSalt();
  const obj = { type: 'sync-bundle', from: 'dev1', bundle: { files: ['a.txt'], data: 'secret' } };
  const env = crypto.encryptFrame(obj, code, salt);
  check('encrypted envelope has v/ c/ n/ s fields', env.v === 1 && env.c && env.n && env.s);
  const back = crypto.decryptFrame(env, code);
  check('decrypt roundtrip preserves object', JSON.stringify(back) === JSON.stringify(obj));
  let rejected = false;
  try { crypto.decryptFrame(env, 'ZZZZ99'); } catch { rejected = true; }
  check('wrong code is rejected (auth tag fails)', rejected);
  check('encrypted blob is not plaintext', !JSON.stringify(env).includes('secret'));

  const binaryMetadata = { type: 'file-chunk-v2', path: 'private/video.bin', index: 7, total: 12 };
  const binaryPayload = Buffer.concat([
    Buffer.from('PRIVATE RAW BYTES ', 'utf8'),
    Buffer.from([0, 1, 2]),
  ]);
  const binary = crypto.encryptBinaryFrame(binaryMetadata, binaryPayload, code, salt);
  check('binary v2 produces a recognized opaque Buffer envelope',
    Buffer.isBuffer(binary) && crypto.isBinaryEnvelope(binary));
  check('binary metadata, payload, and invitation code are not visible to the relay',
    !binary.includes(Buffer.from('private/video.bin')) &&
    !binary.includes(Buffer.from('PRIVATE RAW BYTES')) &&
    !binary.includes(Buffer.from(code)));
  const binaryBack = crypto.decryptBinaryFrame(binary, code);
  check('binary v2 roundtrip preserves authenticated metadata and raw bytes',
    binaryBack.type === binaryMetadata.type && binaryBack.path === binaryMetadata.path &&
    binaryBack.index === 7 && Buffer.isBuffer(binaryBack.data) &&
    binaryBack.data.equals(binaryPayload));

  rejected = false;
  try { crypto.decryptBinaryFrame(binary, 'ZZZZ99'); } catch { rejected = true; }
  check('binary v2 rejects the wrong invitation key', rejected);

  const tamperedHeader = Buffer.from(binary);
  tamperedHeader[crypto.BINARY_HEADER_BYTES - 1] ^= 1;
  rejected = false;
  try { crypto.decryptBinaryFrame(tamperedHeader, code); } catch { rejected = true; }
  check('binary v2 authenticates its public header', rejected);

  const tamperedCiphertext = Buffer.from(binary);
  tamperedCiphertext[crypto.BINARY_HEADER_BYTES + 5] ^= 1;
  rejected = false;
  try { crypto.decryptBinaryFrame(tamperedCiphertext, code); } catch { rejected = true; }
  check('binary v2 rejects tampered ciphertext', rejected);

  const truncated = binary.subarray(0, binary.length - 20);
  rejected = false;
  try { crypto.decryptBinaryFrame(truncated, code); } catch { rejected = true; }
  check('binary v2 rejects truncated envelopes', rejected);
  check('relay recognizer rejects an envelope shorter than the fixed minimum',
    !crypto.isBinaryEnvelope(binary.subarray(0, crypto.BINARY_HEADER_BYTES + 8)));

  const unsupportedFlags = Buffer.from(binary);
  unsupportedFlags[4] = 1;
  rejected = false;
  try { crypto.decryptBinaryFrame(unsupportedFlags, code); } catch { rejected = true; }
  check('binary v2 rejects reserved header flags', rejected && !crypto.isBinaryEnvelope(unsupportedFlags));

  rejected = false;
  try {
    crypto.encryptBinaryFrame({ type: 'ambiguous-data', data: 'must not be metadata' },
      Buffer.alloc(0), code, salt);
  } catch { rejected = true; }
  check('binary v2 keeps raw data out of its bounded metadata object', rejected);

  rejected = false;
  try {
    crypto.encryptBinaryFrame({
      type: 'oversized-metadata',
      note: 'x'.repeat(crypto.MAX_BINARY_METADATA_BYTES),
    }, Buffer.alloc(0), code, salt);
  } catch { rejected = true; }
  check('binary v2 enforces its metadata size limit before encryption', rejected);
})();

// --- 2. Strong remote invitation secrecy ---
(function remoteInviteTests() {
  const secret = remoteRelay.newRemoteSecret();
  check('remote invitation secret contains 256 random bits', Buffer.from(secret, 'base64url').length === 32);
  const invite = remoteRelay.createRemoteInvite('https://example.lhr.life', secret);
  const parsed = remoteRelay.parseRelayAddress(invite);
  check('remote invitation fragment is removed from the relay address', !parsed.address.includes('#') && !parsed.endpoint.includes('#'));
  check('remote invitation uses encrypted WebSocket transport', parsed.transport === 'websocket' && parsed.endpoint.startsWith('wss://'));
  const room = remoteRelay.roomForSecret(secret);
  check('relay room is a one-way identifier, not the invitation secret', room !== secret && /^[A-F0-9]{64}$/.test(room));
  const controlRoom = remoteRelay.controlRoomForSecret(secret);
  check('background control uses a separate one-way room identifier', controlRoom !== room && controlRoom !== secret && /^[A-F0-9]{64}$/.test(controlRoom));
  const member = remoteRelay.memberForSecret(secret, 'DEVICE-PRIVATE-123');
  check('public relay receives an opaque member token instead of device identity', member !== 'DEVICE-PRIVATE-123' && /^[A-F0-9]{64}$/.test(member));
  const pairSecret = remoteRelay.newRemoteSecret();
  const oldDerivedSecret = remoteRelay.legacyPairSecretForTeam(secret, 'DEVICE-HOST-123', 'DEVICE-MEMBER-456');
  check('team members receive a strong independent pair-specific secret',
    pairSecret !== secret && pairSecret !== oldDerivedSecret && Buffer.from(pairSecret, 'base64url').length === 32);
  let rejected = false;
  try { remoteRelay.parseRelayAddress('https://example.lhr.life/carry#SHORT1'); } catch { rejected = true; }
  check('short public invitation secrets are rejected', rejected);
  rejected = false;
  try { remoteRelay.parseRelayAddress('http://relay.example/carry#' + secret); } catch { rejected = true; }
  check('unencrypted public relay URLs are rejected', rejected);
  const mismatchedClient = new remoteRelay.RelayClient();
  mismatchedClient.setRelay(remoteRelay.createRemoteInvite('https://example.lhr.life', remoteRelay.newRemoteSecret()));
  assert.throws(
    () => mismatchedClient.join('ignored', 'DEVICE-PRIVATE-123', () => {}, 'Device', secret),
    /does not match the saved pairing key/,
  );
  check('relay URL fragments cannot override an explicit saved key', true);
})();

// --- 3. A delayed socket from an old sync cannot affect a reused room ---
(function staleRelaySocketTests() {
  function fakeChannel() {
    let messageHandler = () => {};
    let closeHandler = () => {};
    let closed = false;
    return {
      messages: [],
      get destroyed() { return closed; },
      send(frame) { this.messages.push(frame); },
      close() {
        if (closed) return;
        closed = true;
        closeHandler();
      },
      onMessage(handler) { messageHandler = handler; },
      onClose(handler) { closeHandler = handler; },
      emit(frame) { messageHandler(frame); },
    };
  }

  const hub = relay.createRelayHub({ ignoreAllowlist: true, quiet: true });
  const oldA = fakeChannel();
  const oldB = fakeChannel();
  hub.attach(oldA, 'old-a');
  hub.attach(oldB, 'old-b');
  oldA.emit({ type: 'join', room: 'REUSE1', deviceId: 'DEVICE_OLD_A', name: '' });
  oldB.emit({ type: 'join', room: 'REUSE1', deviceId: 'DEVICE_OLD_B', name: '' });
  oldA.close();

  const newA = fakeChannel();
  const newB = fakeChannel();
  hub.attach(newA, 'new-a');
  hub.attach(newB, 'new-b');
  newA.emit({ type: 'join', room: 'REUSE1', deviceId: 'DEVICE_NEW_A', name: '' });
  newB.emit({ type: 'join', room: 'REUSE1', deviceId: 'DEVICE_NEW_B', name: '' });
  newA.messages.length = 0;
  newB.messages.length = 0;

  const staleFrame = { v: 1, c: 'old-ciphertext', n: 'old-nonce', s: 'old-salt' };
  oldB.emit(staleFrame);
  oldB.close();
  check('stale socket cannot disconnect a reused relay room',
    !newA.messages.some((frame) => frame.type === 'relay-peer-gone') &&
    !newB.messages.some((frame) => frame.type === 'relay-peer-gone'));
  check('stale socket cannot inject a late frame into a reused relay room',
    !newA.messages.includes(staleFrame) && !newB.messages.includes(staleFrame));

  const currentFrame = { v: 1, c: 'new-ciphertext', n: 'new-nonce', s: 'new-salt' };
  newA.emit(currentFrame);
  check('current peers still exchange frames after the old socket closes', newB.messages.includes(currentFrame));
  hub.close();

  const allowedRooms = new Set(['TEAM01']);
  const deniedMessages = new Map();
  const dynamicHub = relay.createRelayHub({
    ignoreAllowlist: true,
    quiet: true,
    allowedRooms,
    dynamicAllowedRooms: true,
    deniedRoomMessages: deniedMessages,
  });
  const host = fakeChannel();
  const extra = fakeChannel();
  dynamicHub.attach(host, 'team-host');
  dynamicHub.attach(extra, 'team-extra');
  host.emit({ type: 'join', room: 'TEAM01', deviceId: 'DEVICE_TEAM_HOST', name: '' });
  allowedRooms.delete('TEAM01');
  deniedMessages.set('TEAM01', 'This Carry team has reached its 3-device limit');
  extra.emit({ type: 'join', room: 'TEAM01', deviceId: 'DEVICE_TEAM_EXTRA', name: '' });
  check('dynamic team capacity rejects an extra lobby member with a clear limit error',
    extra.messages.some((frame) => frame.type === 'relay-error' && /3-device limit/.test(frame.message)));
  dynamicHub.close();
})();

// --- 4. A rate-window rollover cannot strand a ghost active connection ---
(async function relayRateRolloverTest() {
  function channel() {
    let closeHandler = () => {};
    let closed = false;
    return {
      messages: [],
      get destroyed() { return closed; },
      send(frame) { this.messages.push(frame); },
      close() {
        if (closed) return;
        closed = true;
        closeHandler();
      },
      onMessage() {},
      onClose(handler) { closeHandler = handler; },
    };
  }

  const preauthHub = relay.createRelayHub({
    ignoreAllowlist: true,
    quiet: true,
    preauthTimeoutMs: 20,
  });
  const idle = channel();
  preauthHub.attach(idle, 'idle-preauth');
  await new Promise((resolve) => setTimeout(resolve, 35));
  check('relay closes a connection that never submits a valid join frame', idle.destroyed);
  preauthHub.close();

  const hub = relay.createRelayHub({
    ignoreAllowlist: true,
    quiet: true,
    maxConnections: 8,
    maxConnectionsPerIp: 1,
    maxConnectionsPerWindow: 8,
    connectionWindowMs: 15,
  });
  const held = channel();
  check('first relay connection occupies its source slot', hub.attach(held, 'rate-rollover'));
  await new Promise((resolve) => setTimeout(resolve, 25));
  const rejected = channel();
  check('rolled rate window still observes the held connection',
    !hub.attach(rejected, 'rate-rollover') &&
    rejected.messages.some((frame) => frame.type === 'relay-error'));
  held.close();
  const afterClose = channel();
  check('closing a pre-rollover connection releases the current source slot',
    hub.attach(afterClose, 'rate-rollover'));
  hub.close();
})().catch((error) => {
  console.error('SECURITY TEST FAILED:', error);
  process.exitCode = 1;
});

// --- 5. Allowlist enforcement on the relay ---
(function allowlistTests() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'carry-sec-'));
  const mpath = path.join(dir, '.carry', 'manifest.json');
  fs.mkdirSync(path.dirname(mpath), { recursive: true });
  // Authorize only DEVGOOD; DEVBAD must be rejected.
  fs.writeFileSync(mpath, JSON.stringify({
    version: 1, name: 'sec', deviceId: 'host000000000000',
    peers: {}, allowlist: ['DEVGOOD0000000000'], createdAt: new Date().toISOString(),
  }));

  const PORT = 48300 + Math.floor(Math.random() * 100);
  const server = relay.startRelay(PORT, { manifestPath: mpath });
  const wait = (ms) => new Promise(r => setTimeout(r, ms));

  function joinAt(relayPort, deviceId, room, keepOpen) {
    return new Promise((resolve) => {
      const sock = net.connect(relayPort, '127.0.0.1', () => {
        sock.write(JSON.stringify({ type: 'join', room: room || 'ROOM11', deviceId, name: 'x' }) + '\n');
      });
      let result = 'wait';
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        if (!keepOpen) try { sock.destroy(); } catch {}
        resolve({ result, sock });
      };
      sock.setEncoding('utf8');
      sock.on('data', (d) => {
        d.split('\n').filter(Boolean).forEach((line) => {
          const f = JSON.parse(line);
          if (f.type === 'relay-error') result = 'error:' + f.message;
          if (f.type === 'relay-wait') result = 'wait';
        });
        finish();
      });
      setTimeout(finish, 600);
    });
  }

(async () => {
  const corruptRelayDir = fs.mkdtempSync(path.join(os.tmpdir(), 'carry-corrupt-relay-'));
  const corruptRelayManifest = path.join(corruptRelayDir, 'manifest.json');
  const corruptRelayBytes = '{not valid json\n';
  fs.writeFileSync(corruptRelayManifest, corruptRelayBytes);
  assert.throws(() => relay.createRelayHub({ manifestPath: corruptRelayManifest, quiet: true }),
    /corrupt.*refusing to start/i, 'a corrupt allowlist must never downgrade the relay to open mode');
  check('corrupt relay metadata is rejected without being overwritten',
    fs.readFileSync(corruptRelayManifest, 'utf8') === corruptRelayBytes);
  fs.rmSync(corruptRelayDir, { recursive: true, force: true });
    const dropServer = net.createServer((socket) => socket.destroy());
    dropServer.listen(0, '127.0.0.1');
    await new Promise((resolve) => dropServer.once('listening', resolve));
    const earlyCloseClient = new remoteRelay.RelayClient();
    earlyCloseClient.setRelay(`127.0.0.1:${dropServer.address().port}`);
    await assert.rejects(
      earlyCloseClient.join('ROOM00', 'DEVICE_EARLY_CLOSE', () => {}, 'Early close', 'ROOM00'),
      /closed before joining|ECONNRESET|connection reset/i,
      'relay join must reject if the socket closes before wait/ready',
    );
    check('relay join rejects an early socket close instead of hanging', true);
    earlyCloseClient.close();
    await new Promise((resolve) => dropServer.close(resolve));
    await wait(200);
    const good = await joinAt(PORT, 'DEVGOOD0000000000');
    check('authorized device is allowed to join', good.result === 'wait');
    const bad = await joinAt(PORT, 'DEVBAD00000000000');
    check('unauthorized device is rejected by relay', bad.result.startsWith('error'));
    server.close();

    const capServer = relay.startRelay(0, {
      manifestPath: mpath,
      maxConnections: 1,
      maxConnectionsPerIp: 4,
      maxConnectionsPerWindow: 20,
    });
    await new Promise((resolve) => capServer.once('listening', resolve));
    const capPort = capServer.address().port;
    const held = await joinAt(capPort, 'DEVGOOD0000000000', 'CAP001', true);
    const capped = await joinAt(capPort, 'DEVGOOD0000000000', 'CAP002');
    check('global relay connection cap rejects excess sockets', capped.result.startsWith('error:relay connection limit'));
    held.sock.destroy();
    capServer.close();

    const rateServer = relay.startRelay(0, {
      manifestPath: mpath,
      maxConnections: 8,
      maxConnectionsPerIp: 8,
      maxConnectionsPerWindow: 2,
      connectionWindowMs: 10000,
    });
    await new Promise((resolve) => rateServer.once('listening', resolve));
    const ratePort = rateServer.address().port;
    await joinAt(ratePort, 'DEVGOOD0000000000', 'RATE01');
    await wait(50);
    await joinAt(ratePort, 'DEVGOOD0000000000', 'RATE02');
    await wait(50);
    const limited = await joinAt(ratePort, 'DEVGOOD0000000000', 'RATE03');
    check('per-IP relay connection rate limit rejects excess attempts', limited.result.startsWith('error:relay connection limit'));
    rateServer.close();
    fs.rmSync(dir, { recursive: true, force: true });
  })();
})();

setTimeout(() => {
  console.log('\n' + passed + ' security checks passed.');
  process.exit(0);
}, 4000);
