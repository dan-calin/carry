'use strict';

const assert = require('assert');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const appServer = require('../lib/app-server');
const frameCrypto = require('../lib/crypto');
const manifest = require('../lib/manifest');
const relay = require('../lib/relay');

const ROOT = path.join(__dirname, '..');
const WRANGLER = path.join(path.dirname(require.resolve('wrangler/package.json')), 'bin', 'wrangler.js');
const CONFIG = path.join(ROOT, 'cloudflare-relay', 'wrangler.jsonc');
const LARGE_PROJECT_FILES = process.env.CARRY_CLOUDFLARE_LARGE_PROJECT === '1' ? 4800 : 0;

function reservePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function waitForRelay(url, child, output) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`wrangler exited early (${child.exitCode})\n${output()}`);
    try {
      const response = await fetch(url);
      if (response.ok) return response.json();
    } catch { /* local Worker is still starting */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for local Cloudflare relay\n${output()}`);
}

function nextFrame(client, predicate, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const previous = client.onFrame;
    const timer = setTimeout(() => {
      client.onFrame = previous;
      reject(new Error('timed out waiting for relay frame'));
    }, timeoutMs);
    client.onFrame = (frame, respond) => {
      if (previous) previous(frame, respond);
      if (!predicate(frame)) return;
      clearTimeout(timer);
      client.onFrame = previous;
      resolve(frame);
    };
  });
}

function socketEvent(socket, event, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for WebSocket ${event}`)), timeoutMs);
    socket.addEventListener(event, (value) => {
      clearTimeout(timer);
      resolve(value);
    }, { once: true });
  });
}

function appRequest(instance, route, options) {
  options = options || {};
  return fetch(`http://127.0.0.1:${instance.port}${route}`, {
    method: options.method || 'GET',
    headers: {
      'X-Carry-Token': instance.token,
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
}

async function waitForState(instance, label, predicate, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let state;
  while (Date.now() < deadline) {
    state = await (await appRequest(instance, '/api/state')).json();
    if (predicate(state)) return state;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for ${label}: ${JSON.stringify(state)}`);
}

async function requireStatus(response, expected, label) {
  if (response.status === expected) return;
  throw new Error(`${label} returned HTTP ${response.status}: ${await response.text()}`);
}

(async () => {
  const liveUrl = String(process.env.CARRY_CLOUDFLARE_RELAY_URL || '').trim().replace(/\/$/, '');
  const port = liveUrl ? null : await reservePort();
  const baseUrl = liveUrl || `http://127.0.0.1:${port}`;
  let child = null;
  let logs = '';
  if (!liveUrl) {
    const args = [WRANGLER, 'dev', '--config', CONFIG, '--ip', '127.0.0.1', '--port', String(port)];
    child = spawn(process.execPath, args, {
      cwd: ROOT,
      windowsHide: true,
      env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (chunk) => { logs += chunk; });
    child.stderr.on('data', (chunk) => { logs += chunk; });
  }
  const clients = [];
  const appInstances = [];
  const temporaryRoots = [];
  try {
    const health = liveUrl
      ? await (await fetch(baseUrl)).json()
      : await waitForRelay(baseUrl, child, () => logs);
    assert.strictEqual(health.service, 'carry-relay');
    assert.strictEqual(health.provider, 'cloudflare-durable-objects');

    const secret = relay.newRemoteSecret();
    const invite = relay.createRemoteInvite(baseUrl, secret);
    const receivedA = [];
    const receivedB = [];
    const a = new relay.RelayClient();
    const b = new relay.RelayClient();
    clients.push(a, b);
    a.setRelay(invite);
    b.setRelay(invite);
    await a.join(secret, 'cloudflare-a', (frame) => receivedA.push(frame), 'A', secret);
    const unjoinedUrl = new URL('/carry', baseUrl);
    unjoinedUrl.searchParams.set('room', relay.roomForSecret(secret));
    const unjoined = new WebSocket(unjoinedUrl);
    await socketEvent(unjoined, 'open');
    const unjoinedClosed = socketEvent(unjoined, 'close');
    unjoined.send(JSON.stringify({ type: 'join', proof: 'invalid' }));
    await unjoinedClosed;
    await b.join(secret, 'cloudflare-b', (frame) => receivedB.push(frame), 'B', secret);
    assert.ok(!receivedA.some((frame) => frame.type === 'peer-gone'),
      'an unjoined socket cannot evict the waiting Carry peer');
    const readyDeadline = Date.now() + 3000;
    while ((!a.peerSupportsBinary || !b.peerSupportsBinary) && Date.now() < readyDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(a.peerSupportsBinary && b.peerSupportsBinary, 'hosted relay negotiates encrypted binary transport');

    const textFrame = nextFrame(b, (frame) => frame.type === 'cloudflare-text');
    a.send({ type: 'cloudflare-text', value: 'encrypted through Durable Object' });
    assert.strictEqual((await textFrame).value, 'encrypted through Durable Object');

    const binaryFrame = nextFrame(a, (frame) => frame.type === 'cloudflare-binary');
    b.sendBinary({ type: 'cloudflare-binary', index: 7 }, Buffer.from('hosted bytes'));
    const binary = await binaryFrame;
    assert.strictEqual(binary.index, 7);
    assert.strictEqual(binary.data.toString(), 'hosted bytes');

    const peerGone = nextFrame(a, (frame) => frame.type === 'peer-gone');
    b.close();
    await peerGone;
    a.close();

    // The room is reusable after both sides leave, which is required for the
    // long-lived encrypted control channel to reconnect after an edge reset.
    const c = new relay.RelayClient();
    const d = new relay.RelayClient();
    clients.push(c, d);
    c.setRelay(invite);
    d.setRelay(invite);
    await Promise.all([
      c.join(secret, 'cloudflare-a', () => {}, 'A', secret),
      d.join(secret, 'cloudflare-b', () => {}, 'B', secret),
    ]);
    c.close();
    d.close();

    const malformed = frameCrypto.encryptBinaryFrame(
      { type: 'cloudflare-binary-check' }, Buffer.from('payload'), secret, frameCrypto.newSalt());
    assert.ok(malformed.length < 2 * 1024 * 1024, 'Carry binary frames fit the hosted relay limit');

    // Exercise the actual desktop orchestration in hosted mode. Unlike a
    // tunnel, the host must close its unused loopback relay and connect its
    // own pairing, control, and data clients to the same provider as the guest.
    const hostRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'carry-cloudflare-host-'));
    const guestRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'carry-cloudflare-guest-'));
    temporaryRoots.push(hostRoot, guestRoot);
    const hostManifest = manifest.init(hostRoot, 'Hosted Relay Host').manifest;
    const guestManifest = manifest.init(guestRoot, 'Hosted Relay Guest').manifest;
    const sharedFactory = async () => ({
      url: baseUrl,
      provider: 'cloudflare-durable-objects',
      sharedRelay: true,
      stableAddress: true,
      stop() {},
    });
    const hostApp = await appServer.start({
      root: hostRoot, port: 0, skipFirewallCheck: true, persistSettings: false,
      remoteTunnelFactory: sharedFactory,
    });
    const guestApp = await appServer.start({
      root: guestRoot, port: 0, skipFirewallCheck: true, persistSettings: false,
      remoteTunnelFactory: sharedFactory,
    });
    appInstances.push(hostApp, guestApp);

    const startPair = await appRequest(hostApp, '/api/remote/start', {
      method: 'POST', body: { action: 'pair', maxDevices: 2 },
    });
    await requireStatus(startPair, 202, 'hosted pair start');
    const pairState = await startPair.json();
    assert.match(pairState.remote.invite, new RegExp(`^${baseUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/carry#`));
    assert.strictEqual(hostApp.appState.remoteSession.server, null,
      'hosted mode closes the unused loopback relay');
    assert.strictEqual(hostApp.appState.remoteSession.localAddress,
      hostApp.appState.remoteSession.publicAddress,
      'hosted mode sends the host and guest to one provider');

    const joinPair = await appRequest(guestApp, '/api/remote/join', {
      method: 'POST', body: { action: 'pair', invite: pairState.remote.invite },
    });
    await requireStatus(joinPair, 202, 'hosted pair join');
    await Promise.all([
      waitForState(hostApp, 'hosted host pairing', (state) =>
        state.peers.some((peer) => peer.deviceId === guestManifest.deviceId)),
      waitForState(guestApp, 'hosted guest pairing', (state) =>
        state.job && state.job.type === 'remote-pair-join' && state.job.status === 'success' &&
        state.peers.some((peer) => peer.deviceId === hostManifest.deviceId)),
    ]);
    await Promise.all([
      waitForState(hostApp, 'hosted host control channel', (state) => state.remote && state.remote.peerOnline),
      waitForState(guestApp, 'hosted guest control channel', (state) => state.remote && state.remote.peerOnline),
    ]);

    fs.writeFileSync(path.join(hostRoot, 'cloudflare-proof.txt'), 'synced through the permanent hosted relay\n');
    fs.mkdirSync(path.join(hostRoot, 'full-project', 'empty', 'nested'), { recursive: true });
    fs.mkdirSync(path.join(hostRoot, 'full-project', 'src', 'feature'), { recursive: true });
    fs.writeFileSync(path.join(hostRoot, 'full-project', 'src', 'feature', 'index.js'), 'export const hosted = true;\n');
    if (LARGE_PROJECT_FILES) {
      const generated = path.join(hostRoot, 'Beta Testing App', 'venv', 'Lib', 'site-packages',
        'complex_dependency', 'generated_modules');
      fs.mkdirSync(generated, { recursive: true });
      for (let index = 0; index < LARGE_PROJECT_FILES; index++) {
        fs.writeFileSync(path.join(generated, `generated_module_${String(index).padStart(5, '0')}.py`), '');
      }
    }
    fs.mkdirSync(path.join(guestRoot, 'destination-only-empty', 'nested'), { recursive: true });
    const startSync = await appRequest(hostApp, '/api/sync', {
      method: 'POST', body: { peerId: guestManifest.deviceId, direction: 'push' },
    });
    await requireStatus(startSync, 202, 'hosted sync start');
    const syncStates = await Promise.all([
      waitForState(hostApp, 'hosted host sync', (state) =>
        state.job && state.job.type === 'remote-sync-host' && state.job.status === 'success',
      LARGE_PROJECT_FILES ? 180000 : 30000),
      waitForState(guestApp, 'hosted guest sync', (state) =>
        state.job && state.job.type === 'remote-sync-join' && state.job.status === 'success',
      LARGE_PROJECT_FILES ? 180000 : 30000),
    ]);
    assert.strictEqual(fs.readFileSync(path.join(guestRoot, 'cloudflare-proof.txt'), 'utf8'),
      'synced through the permanent hosted relay\n');
    assert.strictEqual(fs.readFileSync(path.join(guestRoot, 'full-project', 'src', 'feature', 'index.js'), 'utf8'),
      'export const hosted = true;\n');
    assert.ok(fs.statSync(path.join(guestRoot, 'full-project', 'empty', 'nested')).isDirectory(),
      'hosted Push preserves empty nested project folders');
    assert.ok(!fs.existsSync(path.join(guestRoot, 'destination-only-empty')),
      'hosted Push removes destination-only empty folders');
    if (LARGE_PROJECT_FILES) {
      const guestGenerated = path.join(guestRoot, 'Beta Testing App', 'venv', 'Lib', 'site-packages',
        'complex_dependency', 'generated_modules');
      assert.strictEqual(fs.readdirSync(guestGenerated).length, LARGE_PROJECT_FILES,
        'the live hosted relay carries a project beyond the old 4096-file limit');
      assert.ok(syncStates.flatMap((state) => state.job.logs || []).some((entry) =>
        /project manifest in \d+ bounded part/.test(entry.text)),
      'the live hosted sync reports bounded manifest streaming');
    }

    console.log(`CLOUDFLARE RELAY INTEGRATION PASS (${liveUrl ? 'live edge' : 'local runtime'}): health, encrypted text/binary forwarding, reconnect, desktop pair, and full-project sync.`);
  } finally {
    for (const client of clients) client.close();
    for (const instance of appInstances) await instance.close();
    for (const root of temporaryRoots) {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
    if (child) {
      if (child.exitCode === null) child.kill();
      await new Promise((resolve) => {
        if (child.exitCode !== null) return resolve();
        const timer = setTimeout(resolve, 3000);
        child.once('exit', () => { clearTimeout(timer); resolve(); });
      });
    }
  }
})().catch((error) => {
  console.error('CLOUDFLARE RELAY INTEGRATION FAIL:', error);
  process.exitCode = 1;
});
