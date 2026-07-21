'use strict';
const assert = require('assert');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const frameCrypto = require('../lib/crypto');
const remoteRelay = require('../lib/relay');

const CARRY = path.join(__dirname, '..', 'bin', 'carry.js');
const RELAY_PORT = 48200 + Math.floor(Math.random() * 100);
let relay;

function run(args, cwd) {
  return new Promise((res) => {
    const p = spawn('node', [CARRY, ...args], { cwd, stdio: ['ignore','pipe','pipe'] });
    let out = '', err = '';
    p.stdout.on('data', d => out += d);
    p.stderr.on('data', d => err += d);
    p.on('close', code => res({ code, out, err }));
  });
}
function cleanup(A,B){ try{ if (relay) relay.close(); }catch(e){} try{fs.rmSync(A,{recursive:true,force:true});}catch(e){} try{fs.rmSync(B,{recursive:true,force:true});}catch(e){} }

function waitFor(predicate, message, timeoutMs) {
  const deadline = Date.now() + (timeoutMs || 5000);
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (predicate()) { resolve(); return; }
      if (Date.now() >= deadline) { reject(new Error(message)); return; }
      setTimeout(poll, 20);
    };
    poll();
  });
}

async function testBinaryWebSocketRelay() {
  console.log('testing negotiated encrypted binary WebSocket relay');
  const webRelay = require('../relay/server').startWebRelay(0, {
    host: '127.0.0.1', ignoreAllowlist: true, quiet: true,
  });
  await new Promise((resolve) => webRelay.once('listening', resolve));
  const endpoint = `http://127.0.0.1:${webRelay.address().port}/carry`;
  const secret = remoteRelay.newRemoteSecret();
  const invite = remoteRelay.createRemoteInvite(endpoint, secret);
  const clientA = new remoteRelay.RelayClient();
  const clientB = new remoteRelay.RelayClient();
  const framesA = [];
  const framesB = [];
  clientA.setRelay(invite);
  clientB.setRelay(invite);

  try {
    await clientA.join('', 'BINARY_DEVICE_A', (frame) => framesA.push(frame), 'A');
    await clientB.join('', 'BINARY_DEVICE_B', (frame) => framesB.push(frame), 'B');
    await waitFor(() => clientA.peerSupportsBinary && clientB.peerSupportsBinary,
      'binary capability was not negotiated');

    clientA.webSocket.send(Buffer.from('not-a-carry-binary-envelope'));
    await waitFor(() => framesA.some((frame) => frame.type === 'relay-error' &&
      /recognized encrypted binary/.test(frame.message)),
    'relay did not reject an unrecognized binary envelope');
    assert.ok(!framesB.some((frame) => frame.type === 'binary-itest'),
      'relay forwarded malformed binary traffic');

    const payload = Buffer.from([0, 1, 2, 3, 250, 251, 252, 253]);
    clientA.sendBinary({ type: 'binary-itest', index: 3, total: 9 }, payload);
    await waitFor(() => framesB.some((frame) => frame.type === 'binary-itest'),
      'peer did not receive encrypted binary frame');
    const received = framesB.find((frame) => frame.type === 'binary-itest');
    assert.strictEqual(received.index, 3);
    assert.ok(Buffer.isBuffer(received.data) && received.data.equals(payload),
      'binary relay payload changed in transit');
    console.log('RESULT negotiated binary frame stayed encrypted and arrived as raw bytes: true');

    // A client that does not advertise the v2 feature must keep both sides on
    // the v1 encrypted-text path. This also models a pre-upgrade Carry build.
    const legacySecret = remoteRelay.newRemoteSecret();
    const legacyInvite = remoteRelay.createRemoteInvite(endpoint, legacySecret);
    const legacyAddress = remoteRelay.parseRelayAddress(legacyInvite);
    const legacySocket = new WebSocket(legacyAddress.endpoint);
    const legacyMessages = [];
    legacySocket.addEventListener('message', (event) => {
      if (typeof event.data !== 'string') return;
      try { legacyMessages.push(JSON.parse(event.data)); } catch { /* malformed */ }
    });
    await new Promise((resolve, reject) => {
      legacySocket.addEventListener('open', resolve, { once: true });
      legacySocket.addEventListener('error', () => reject(new Error('legacy WebSocket did not open')), { once: true });
    });
    legacySocket.send(JSON.stringify({
      type: 'join',
      room: remoteRelay.roomForSecret(legacySecret),
      deviceId: remoteRelay.memberForSecret(legacySecret, 'LEGACY_DEVICE_A'),
      name: '',
    }));
    await waitFor(() => legacyMessages.some((message) => message.type === 'relay-wait'),
      'legacy client did not join relay');

    const modernClient = new remoteRelay.RelayClient();
    modernClient.setRelay(legacyInvite);
    await modernClient.join('', 'MODERN_DEVICE_B', () => {}, 'modern');
    assert.strictEqual(modernClient.peerSupportsBinary, false,
      'binary feature was enabled for a peer that did not advertise it');
    assert.throws(() => modernClient.sendBinary({ type: 'must-fallback' }, Buffer.from('x')),
      /does not support/);
    modernClient.send({ type: 'legacy-text-fallback', marker: 'still encrypted' });
    await waitFor(() => legacyMessages.some((message) => message.v === 1 && message.c),
      'legacy peer did not receive encrypted text fallback');
    const legacyEnvelope = legacyMessages.find((message) => message.v === 1 && message.c);
    const legacyFrame = frameCrypto.decryptFrame(legacyEnvelope, legacySecret);
    assert.strictEqual(legacyFrame.type, 'legacy-text-fallback');
    assert.strictEqual(legacyFrame.marker, 'still encrypted');
    console.log('RESULT old client safely falls back to encrypted text: true');
    modernClient.close();
    legacySocket.close();

    // A delayed socket from sync N must never pair with either side of sync
    // N+1 even though all of them use the same long-lived pairing secret.
    const repeatedSecret = remoteRelay.newRemoteSecret();
    const repeatedInvite = remoteRelay.createRemoteInvite(endpoint, repeatedSecret);
    const staleA = new remoteRelay.RelayClient();
    const currentA = new remoteRelay.RelayClient();
    const currentB = new remoteRelay.RelayClient();
    const staleFrames = [];
    const currentAFrames = [];
    const currentBFrames = [];
    staleA.setRelay(repeatedInvite);
    currentA.setRelay(repeatedInvite);
    currentB.setRelay(repeatedInvite);
    try {
      await staleA.join('', 'REPEATED_DEVICE_A', (frame) => staleFrames.push(frame), 'stale',
        repeatedSecret, undefined, '111111111111111111111111');
      await currentA.join('', 'REPEATED_DEVICE_A', (frame) => currentAFrames.push(frame), 'current-a',
        repeatedSecret, undefined, '222222222222222222222222');
      await currentB.join('', 'REPEATED_DEVICE_B', (frame) => currentBFrames.push(frame), 'current-b',
        repeatedSecret, undefined, '222222222222222222222222');
      await waitFor(() => currentAFrames.some((frame) => frame.type === 'relay-ready') &&
        currentBFrames.some((frame) => frame.type === 'relay-ready'),
      'current sync run did not pair within its isolated relay room');
      assert.ok(!staleFrames.some((frame) => frame.type === 'relay-ready'),
        'a stale sync run was incorrectly paired with a later run');
      currentA.send({ type: 'current-run-proof', marker: 'only-n-plus-one' });
      await waitFor(() => currentBFrames.some((frame) => frame.type === 'current-run-proof'),
        'current sync run did not exchange its encrypted frame');
      assert.ok(!staleFrames.some((frame) => frame.type === 'current-run-proof'),
        'a current encrypted frame leaked into the stale relay run');
      console.log('RESULT repeated sync runs stay isolated from stale relay sockets: true');
    } finally {
      staleA.close();
      currentA.close();
      currentB.close();
    }
  } finally {
    clientA.close();
    clientB.close();
    await new Promise((resolve) => webRelay.close(resolve));
  }
}

(async () => {
  // Run the relay IN-PROCESS so the test does not depend on cross-process relay
  // scheduling (which proved flaky when the relay was a separate child). This
  // mirrors how you would run `carry relay` on an always-on box.
  // Never inherit the real project's device allowlist when this test is run
  // from the Carry source folder; the integration uses its own temporary IDs.
  const testManifest = path.join(os.tmpdir(), `carry-relay-itest-${process.pid}.json`);
  relay = require('../relay/server').startRelay(RELAY_PORT, { manifestPath: testManifest });
  await new Promise(r => setTimeout(r, 300));
  const A = fs.mkdtempSync(path.join(os.tmpdir(), 'carryA-'));
  const B = fs.mkdtempSync(path.join(os.tmpdir(), 'carryB-'));
  const RELAY = '127.0.0.1:' + RELAY_PORT;
  const T = () => new Date().toISOString().slice(11, 23);
  console.log(T(), 'init A/B');
  await run(['init', 'projA'], A);
  await run(['init', 'projB'], B);

  const code = 'T'.repeat(43);
  console.log(T(), 'pair A (relay)');
  const pa = run(['pair', code, '--relay', RELAY], A);
  await new Promise(r => setTimeout(r, 800));
  console.log(T(), 'pair B (relay)');
  await run(['pair', code, '--relay', RELAY], B);
  console.log(T(), 'await pair A');
  await pa;
  console.log(T(), 'paired');
  console.log('A manifest peers:', JSON.stringify(JSON.parse(fs.readFileSync(path.join(A,'.carry','manifest.json'),'utf8')).peers));
  await new Promise(r => setTimeout(r, 1500)); // let the pairing room fully tear down on the relay

  fs.mkdirSync(path.join(A, 'src'), { recursive: true });
  fs.writeFileSync(path.join(A, 'src', 'note.txt'), 'hello from A');
  fs.mkdirSync(path.join(A, '.shared-memory'), { recursive: true });
  fs.writeFileSync(path.join(A, '.shared-memory', 'memory.json'),
    '{"type":"entity","name":"proj/x","entityType":"file","observations":["A wrote this (claude, 2026-07-18)"]}\n');

  console.log(T(), 'sync A + B concurrently');
  // Launch both syncs in parallel — both must be in the relay room for the
  // relay-ready handshake. Awaiting one before starting the other would deadlock.
  const rsaP = run(['sync', '--relay', RELAY], A);
  const rsbP = run(['sync', '--relay', RELAY], B);
  const [rsa, rsb] = await Promise.all([rsaP, rsbP]);
  console.log('A sync out:', rsa.out.trim(), '| err:', rsa.err.trim());
  console.log('B sync out:', rsb.out.trim(), '| err:', rsb.err.trim());

  const gotFile = fs.existsSync(path.join(B, 'src', 'note.txt')) && fs.readFileSync(path.join(B, 'src', 'note.txt'),'utf8') === 'hello from A';
  console.log('RESULT B received file from A:', gotFile);
  const mem = fs.readFileSync(path.join(B, '.shared-memory', 'memory.json'), 'utf8');
  console.log('RESULT B memory has A observation:', mem.includes('A wrote this'));

  fs.mkdirSync(path.join(B, '.shared-memory'), { recursive: true });
  fs.writeFileSync(path.join(B, '.shared-memory', 'memory.json'),
    '{"type":"entity","name":"proj/x","entityType":"file","observations":["A wrote this (claude, 2026-07-18)"]}\n' +
    '{"type":"entity","name":"proj/y","entityType":"file","observations":["B wrote this (codex)"]}\n');
  console.log(T(), 'sync B + A concurrently (round 2)');
  await Promise.all([run(['sync', '--relay', RELAY], B), run(['sync', '--relay', RELAY], A)]);
  const memA = fs.readFileSync(path.join(A, '.shared-memory', 'memory.json'), 'utf8');
  console.log('RESULT A has B entity proj/y:', memA.includes('proj/y') && memA.includes('B wrote this'));
  console.log('RESULT A still has A observation:', memA.includes('A wrote this'));

  await testBinaryWebSocketRelay();

  cleanup(A,B);
  console.log('\nINTEGRATION DONE');
  process.exitCode = 0;
})().catch(e => { console.error('ITEST FAIL:', e); cleanup(); process.exitCode = 1; });
