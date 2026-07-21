'use strict';

// Experimental direct transport checks. No public network service is used:
// the real integration creates two WebRTC peers on this machine and passes
// signalling through an in-memory AES-GCM-authenticated relay substitute.

const assert = require('assert');
const childProcess = require('child_process');
const path = require('path');
const frameCrypto = require('../lib/crypto');
const p2p = require('../lib/p2p');

let passed = 0;
let skipped = 0;

function check(name, condition) {
  assert.ok(condition, 'FAILED: ' + name);
  console.log('  \x1b[32m\u2713\x1b[0m ' + name);
  passed += 1;
}

function skip(name, reason) {
  console.log('  \x1b[33m-\x1b[0m ' + name + ' (skipped: ' + reason + ')');
  skipped += 1;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withTimeout(promise, ms, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(label + ' timed out')), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function waitFor(predicate, ms, label) {
  const started = Date.now();
  while (Date.now() - started < ms) {
    if (predicate()) return;
    await delay(10);
  }
  throw new Error(label + ' timed out');
}

function incomingDescription(binding, overrides) {
  return {
    type: p2p.SIGNAL_TYPE,
    version: p2p.PROTOCOL_VERSION,
    attemptId: binding.attemptId,
    from: binding.peerId,
    to: binding.selfId,
    kind: 'description',
    descriptionType: 'offer',
    sdp: 'v=0\r\n',
    ...(overrides || {}),
  };
}

function incomingCandidate(binding, overrides) {
  return {
    type: p2p.SIGNAL_TYPE,
    version: p2p.PROTOCOL_VERSION,
    attemptId: binding.attemptId,
    from: binding.peerId,
    to: binding.selfId,
    kind: 'candidate',
    candidate: 'candidate:1 1 UDP 1 127.0.0.1 5000 typ host',
    mid: '0',
    ...(overrides || {}),
  };
}

function validationTests() {
  const binding = {
    selfId: 'DEVICE_BRAVO_0002',
    peerId: 'DEVICE_ALPHA_0001',
    attemptId: 'attempt_validation_0001',
  };
  check('lower device ID is the deterministic offerer',
    p2p.isOfferer('DEVICE_ALPHA_0001', 'DEVICE_BRAVO_0002') &&
    !p2p.isOfferer('DEVICE_BRAVO_0002', 'DEVICE_ALPHA_0001'));
  check('a correctly bound signalling description is accepted',
    p2p.validateSignal(incomingDescription(binding), binding).kind === 'description');

  assert.throws(
    () => p2p.validateSignal(incomingDescription(binding, { version: 2 }), binding),
    /version/,
  );
  assert.throws(
    () => p2p.validateSignal(incomingDescription(binding, { attemptId: 'attempt_wrong_0001' }), binding),
    /does not match/,
  );
  assert.throws(
    () => p2p.validateSignal(incomingDescription(binding, { from: 'DEVICE_WRONG_0003' }), binding),
    /does not match/,
  );
  assert.throws(
    () => p2p.validateSignal({ ...incomingDescription(binding), extra: true }, binding),
    /fields/,
  );
  assert.throws(() => p2p.validateSignal(null, binding), /object/);
  assert.throws(
    () => p2p.validateSignal(incomingCandidate(binding, { mid: '0\nforged' }), binding),
    /mid/,
  );
  check('version, attempt, peer, and malformed signalling mismatches are rejected', true);

  assert.throws(
    () => p2p.validateSignal(incomingDescription(binding, { sdp: 'x'.repeat(p2p.MAX_SDP_BYTES + 1) }), binding),
    /SDP.*limit/,
  );
  assert.throws(
    () => p2p.validateSignal(incomingCandidate(binding, {
      candidate: 'x'.repeat(p2p.MAX_CANDIDATE_BYTES + 1),
    }), binding),
    /candidate.*limit/,
  );
  check('oversized SDP and ICE candidate strings are rejected before native parsing', true);

  const validator = p2p.createSignalValidator(binding);
  for (let index = 0; index < p2p.MAX_CANDIDATES; index += 1) {
    validator(incomingCandidate(binding, { candidate: `candidate:${index} 1 UDP 1 127.0.0.1 5000 typ host` }));
  }
  assert.throws(
    () => validator(incomingCandidate(binding, { candidate: 'candidate:overflow' })),
    /candidate count/,
  );
  check('each attempt accepts at most 64 remote ICE candidates', true);

  const lazyProbe = childProcess.execFileSync(process.execPath, ['-e', [
    "const Module = require('module');",
    'const original = Module._load;',
    "Module._load = function(request) { if (request === 'node-datachannel') throw new Error('simulated missing native'); return original.apply(this, arguments); };",
    "const direct = require('./lib/p2p');",
    "const status = direct.nativeAvailability();",
    "if (status.available || !/simulated missing native/.test(status.reason)) process.exit(2);",
  ].join(' ')], {
    cwd: path.resolve(__dirname, '..'),
    encoding: 'utf8',
  });
  check('the module loads and reports fallback cleanly when the native binary is unavailable', lazyProbe === '');
}

function createAuthenticatedPair(secretA, secretB, suffix) {
  const alphaFrames = [];
  const bravoFrames = [];
  const alphaErrors = [];
  const bravoErrors = [];
  const encryptedSignals = [];
  const signalSecret = 'authenticated-signalling-secret-' + suffix;
  const alphaSignalSalt = frameCrypto.newSalt();
  const bravoSignalSalt = frameCrypto.newSalt();
  const attemptId = 'attempt_local_' + suffix;
  let alpha;
  let bravo;

  function route(getDestination, frame, salt) {
    const envelope = frameCrypto.encryptFrame(frame, signalSecret, salt, 'carry-p2p-signal-test-v1');
    encryptedSignals.push({ envelope, plaintext: frame });
    return new Promise((resolve, reject) => {
      setImmediate(() => {
        try {
          const destination = getDestination();
          if (!destination || destination.stats().state === 'closed') {
            resolve();
            return;
          }
          destination.handleSignal(frameCrypto.decryptFrame(envelope, signalSecret));
          resolve();
        } catch (error) {
          reject(error);
        }
      });
    });
  }

  alpha = p2p.createP2PTransport({
    selfId: 'DEVICE_ALPHA_0001',
    peerId: 'DEVICE_BRAVO_0002',
    attemptId,
    secret: secretA,
    sendSignal: (frame) => route(() => bravo, frame, alphaSignalSalt),
    onFrame: (frame) => alphaFrames.push(frame),
    onError: (error) => alphaErrors.push(error),
    connectTimeoutMs: 8_000,
  });
  bravo = p2p.createP2PTransport({
    selfId: 'DEVICE_BRAVO_0002',
    peerId: 'DEVICE_ALPHA_0001',
    attemptId,
    secret: secretB,
    sendSignal: (frame) => route(() => alpha, frame, bravoSignalSalt),
    onFrame: (frame) => bravoFrames.push(frame),
    onError: (error) => bravoErrors.push(error),
    connectTimeoutMs: 8_000,
  });

  return {
    alpha,
    bravo,
    alphaFrames,
    bravoFrames,
    alphaErrors,
    bravoErrors,
    encryptedSignals,
  };
}

async function connectPair(pair) {
  // Start the answerer before the deterministic offerer so the in-memory
  // signalling callback can deliver immediately without an artificial queue.
  const bravoReady = pair.bravo.start();
  const alphaReady = pair.alpha.start();
  await withTimeout(Promise.all([alphaReady, bravoReady]), 10_000, 'local direct connection');
}

async function realNativeTests() {
  const pair = createAuthenticatedPair('PAIR_SECRET_CORRECT_123', 'PAIR_SECRET_CORRECT_123', 'roundtrip_0001');
  try {
    await connectPair(pair);
    check('two local native peers open a reliable ordered DataChannel',
      pair.alpha.stats().state === 'open' && pair.bravo.stats().state === 'open' &&
      pair.alpha.stats().role === 'offerer' && pair.bravo.stats().role === 'answerer');
    check('SDP and candidates are opaque on the authenticated signalling wire',
      pair.encryptedSignals.length > 0 && pair.encryptedSignals.every(({ envelope, plaintext }) => {
        const wire = JSON.stringify(envelope);
        const sensitive = plaintext.kind === 'description' ? plaintext.sdp : plaintext.candidate;
        return !wire.includes(sensitive) && !wire.includes('fingerprint');
      }));

    const text = { type: 'test-text', value: 'encrypted hello from alpha' };
    const binary = Buffer.alloc(96 * 1024);
    for (let index = 0; index < binary.length; index += 1) binary[index] = index % 251;
    await pair.alpha.send(text);
    await pair.bravo.sendBinary({ type: 'test-binary', index: 7 }, binary);
    await waitFor(
      () => pair.bravoFrames.length === 1 && pair.alphaFrames.length === 1,
      5_000,
      'encrypted direct messages',
    );
    check('Carry AES-GCM text framing roundtrips over DTLS',
      pair.bravoFrames[0].type === text.type && pair.bravoFrames[0].value === text.value);
    check('Carry AES-GCM binary framing preserves authenticated metadata and bytes',
      pair.alphaFrames[0].type === 'test-binary' && pair.alphaFrames[0].index === 7 &&
      Buffer.isBuffer(pair.alphaFrames[0].data) && pair.alphaFrames[0].data.equals(binary));

    const sustainedChunk = Buffer.alloc(64 * 1024, 0x5a);
    const sustainedCount = 128;
    for (let index = 0; index < sustainedCount; index += 1) {
      await pair.alpha.sendBinary({ type: 'sustained-binary', index }, sustainedChunk);
    }
    try {
      await waitFor(
        () => pair.bravoFrames.filter((frame) => frame.type === 'sustained-binary').length === sustainedCount,
        30_000,
        'sustained encrypted direct transfer',
      );
    } catch (error) {
      const received = pair.bravoFrames.filter((frame) => frame.type === 'sustained-binary').length;
      throw new Error(`${error.message} (received ${received}/${sustainedCount}; sender ${JSON.stringify(pair.alpha.stats())})`);
    }
    const sustained = pair.bravoFrames.filter((frame) => frame.type === 'sustained-binary');
    check('sustained 8 MiB direct traffic drains with bounded backpressure',
      sustained.every((frame, index) => frame.index === index && frame.data.equals(sustainedChunk)));

    assert.throws(
      () => pair.alpha.send({ type: 'oversized-text', value: 'x'.repeat(p2p.MAX_APPLICATION_MESSAGE_BYTES) }),
      /128 KiB/,
    );
    assert.throws(
      () => pair.alpha.sendBinary({ type: 'oversized-binary' }, Buffer.alloc(p2p.MAX_APPLICATION_MESSAGE_BYTES)),
      /128 KiB/,
    );
    check('text and binary application messages above 128 KiB are rejected', true);
  } finally {
    pair.alpha.close();
    pair.bravo.close();
  }

  const wrongKey = createAuthenticatedPair('PAIR_SECRET_CORRECT_456', 'PAIR_SECRET_WRONG___456', 'wrongkey_0001');
  try {
    await connectPair(wrongKey);
    await wrongKey.alpha.send({ type: 'wrong-key-test', value: 'must never be delivered' });
    await waitFor(() => wrongKey.bravoErrors.length > 0, 5_000, 'wrong-key rejection');
    check('a peer using the wrong Carry key receives no application frame', wrongKey.bravoFrames.length === 0);
    check('a wrong-key AES-GCM authentication failure closes the direct attempt',
      wrongKey.bravo.stats().state === 'closed' &&
      /authentication|wrong code|rejected/i.test(wrongKey.bravoErrors[0].message));
  } finally {
    wrongKey.alpha.close();
    wrongKey.bravo.close();
  }
}

function fakeNativeModule() {
  const state = {
    peer: null,
    channel: null,
    peerConfig: null,
    channelConfig: null,
    sendResults: [],
    sendAttempts: 0,
  };

  class FakeChannel {
    constructor(label, config) {
      this.label = label;
      this.protocol = config.protocol;
      this.open = false;
      this.amount = 0;
      this.handlers = {};
    }
    getLabel() { return this.label; }
    getProtocol() { return this.protocol; }
    isOpen() { return this.open; }
    maxMessageSize() { return p2p.MAX_WIRE_MESSAGE_BYTES; }
    bufferedAmount() { return this.amount; }
    setBufferedAmountLowThreshold(value) { this.low = value; }
    onBufferedAmountLow(callback) { this.handlers.low = callback; }
    onMessage(callback) { this.handlers.message = callback; }
    onError(callback) { this.handlers.error = callback; }
    onClosed(callback) { this.handlers.closed = callback; }
    onOpen(callback) { this.handlers.open = callback; }
    send(value, bytes) {
      state.sendAttempts += 1;
      const accepted = state.sendResults.length ? state.sendResults.shift() : true;
      this.amount += bytes;
      return accepted;
    }
    sendMessage(value) { return this.send(value, Buffer.byteLength(value, 'utf8')); }
    sendMessageBinary(value) { return this.send(value, value.length); }
    triggerOpen() { this.open = true; this.handlers.open(); }
    close() {
      if (!this.open) return;
      this.open = false;
      if (this.handlers.closed) this.handlers.closed();
    }
  }

  class FakePeerConnection {
    constructor(_name, config) {
      state.peer = this;
      state.peerConfig = config;
      this.handlers = {};
    }
    onLocalDescription(callback) { this.handlers.description = callback; }
    onLocalCandidate(callback) { this.handlers.candidate = callback; }
    onDataChannel(callback) { this.handlers.channel = callback; }
    onStateChange(callback) { this.handlers.state = callback; }
    createDataChannel(label, config) {
      state.channelConfig = config;
      state.channel = new FakeChannel(label, config);
      return state.channel;
    }
    addRemoteCandidate() {}
    setRemoteDescription() {}
    getSelectedCandidatePair() { return null; }
    rtt() { return 0; }
    close() { this.closed = true; }
  }

  return { module: { PeerConnection: FakePeerConnection }, state };
}

async function backpressureAndCleanupTests() {
  const fake = fakeNativeModule();
  const transport = p2p.createP2PTransport({
    selfId: 'DEVICE_ALPHA_0001',
    peerId: 'DEVICE_BRAVO_0002',
    attemptId: 'attempt_fake_queue_0001',
    secret: 'PAIR_SECRET_FAKE_123',
    sendSignal: () => {},
    iceServers: ['stun:stun.cloudflare.com:3478'],
    _native: fake.module,
    maxBufferedBytes: 1,
    maxQueuedBytes: 2 * 1024,
    maxQueuedMessages: 2,
  });
  const ready = transport.start();
  fake.state.channel.triggerOpen();
  await ready;
  check('native peer configuration never disables DTLS fingerprint verification',
    !Object.prototype.hasOwnProperty.call(fake.state.peerConfig, 'disableFingerprintVerification'));
  check('STUN configuration is caller-supplied and forwarded without embedded TURN credentials',
    fake.state.peerConfig.iceServers.length === 1 &&
    fake.state.peerConfig.iceServers[0] === 'stun:stun.cloudflare.com:3478');
  check('the raw DataChannel is explicitly reliable and ordered',
    fake.state.channelConfig.unordered === false &&
    !Object.prototype.hasOwnProperty.call(fake.state.channelConfig, 'maxRetransmits') &&
    !Object.prototype.hasOwnProperty.call(fake.state.channelConfig, 'maxPacketLifeTime'));

  await transport.send({ type: 'first', value: 'fills the fake native buffer' });
  const queuedOne = transport.send({ type: 'queued-one', value: 'a'.repeat(80) });
  const queuedTwo = transport.send({ type: 'queued-two', value: 'b'.repeat(80) });
  await assert.rejects(
    transport.send({ type: 'queue-overflow', value: 'c'.repeat(80) }),
    /queue is full/,
  );
  check('backpressure keeps a fixed message-count and byte-bounded send queue',
    transport.pendingBytes() <= fake.state.channel.amount + 2 * 1024);
  transport.close();
  await assert.rejects(queuedOne, /closed/);
  await assert.rejects(queuedTwo, /closed/);
  check('closing a direct attempt rejects queued sends and releases pending state',
    transport.pendingBytes() === 0 && fake.state.peer.closed === true);

  const bufferedFake = fakeNativeModule();
  bufferedFake.state.sendResults.push(false);
  const buffered = p2p.createP2PTransport({
    selfId: 'DEVICE_ALPHA_0001',
    peerId: 'DEVICE_BRAVO_0002',
    attemptId: 'attempt_fake_retry_0001',
    secret: 'PAIR_SECRET_FAKE_RETRY_123',
    sendSignal: () => {},
    _native: bufferedFake.module,
  });
  const bufferedReady = buffered.start();
  bufferedFake.state.channel.triggerOpen();
  await bufferedReady;
  await withTimeout(buffered.send({ type: 'buffered-natively' }), 1000, 'native buffered send');
  await delay(30);
  check('a native false backpressure signal does not duplicate the buffered frame',
    bufferedFake.state.sendAttempts === 1 && bufferedFake.state.channel.amount > 0);
  buffered.close();

  const timeoutFake = fakeNativeModule();
  const timed = p2p.createP2PTransport({
    selfId: 'DEVICE_ALPHA_0001',
    peerId: 'DEVICE_BRAVO_0002',
    attemptId: 'attempt_fake_timeout_0001',
    secret: 'PAIR_SECRET_FAKE_456',
    sendSignal: () => {},
    _native: timeoutFake.module,
    connectTimeoutMs: 100,
  });
  await assert.rejects(timed.start(), /timed out/);
  check('a direct connection timeout closes its native peer and clears its timer',
    timed.stats().state === 'closed' && timeoutFake.state.peer.closed === true);

  const bindingFake = fakeNativeModule();
  const bindingErrors = [];
  const bound = p2p.createP2PTransport({
    selfId: 'DEVICE_ALPHA_0001',
    peerId: 'DEVICE_BRAVO_0002',
    attemptId: 'attempt_fake_binding_0001',
    secret: 'PAIR_SECRET_FAKE_789',
    sendSignal: () => {},
    onError: (error) => bindingErrors.push(error),
    _native: bindingFake.module,
  });
  const boundReady = bound.start();
  bindingFake.state.channel.triggerOpen();
  await boundReady;
  const wrongAttempt = frameCrypto.encryptFrame({
    type: 'p2p-data',
    version: p2p.PROTOCOL_VERSION,
    attemptId: 'attempt_wrong_binding_0001',
    from: 'DEVICE_BRAVO_0002',
    to: 'DEVICE_ALPHA_0001',
    frame: { type: 'must-not-arrive' },
  }, 'PAIR_SECRET_FAKE_789', frameCrypto.newSalt(), 'carry-p2p-data-v1');
  bindingFake.state.channel.handlers.message(JSON.stringify(wrongAttempt));
  check('an authenticated application frame bound to another attempt is rejected',
    bound.stats().state === 'closed' && bindingErrors.length === 1);
}

(async () => {
  validationTests();
  await backpressureAndCleanupTests();

  const availability = p2p.nativeAvailability();
  if (!availability.available) {
    skip('native local peer encryption roundtrip', availability.reason);
    skip('native wrong-key rejection', availability.reason);
  } else {
    console.log('  Native libdatachannel version: ' + availability.version);
    await realNativeTests();
  }

  console.log(`\n${passed} P2P checks passed${skipped ? `, ${skipped} skipped` : ''}.`);
})().catch((error) => {
  console.error('\nP2P TEST FAILED:', error && error.stack ? error.stack : error);
  process.exitCode = 1;
}).finally(async () => {
  // Give close callbacks a turn before allowing the native library to tear
  // down its worker threads naturally at process exit.
  await delay(100);
});
