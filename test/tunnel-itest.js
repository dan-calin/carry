'use strict';

const assert = require('assert');
const { EventEmitter } = require('events');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { PassThrough } = require('stream');
const tunnel = require('../lib/tunnel');

(async () => {
  const sshPath = tunnel.findSsh();
  if (process.platform === 'win32') {
    assert.ok(path.isAbsolute(sshPath) && fs.existsSync(sshPath), 'Windows OpenSSH is found by its standard absolute path');
  }

  assert.match(
    tunnel.explainTunnelFailure(['ssh: connect to host localhost.run port 22: Connection timed out']),
    /port 22.*another network|network may block outbound SSH/i,
    'blocked outbound SSH gets an actionable explanation',
  );
  assert.match(
    tunnel.explainTunnelFailure(['ssh: Could not resolve hostname localhost.run: No such host is known']),
    /DNS|resolve localhost\.run/i,
    'DNS failure gets an actionable explanation',
  );

  const missing = path.join(__dirname, '..', '.build', 'definitely-missing-ssh.exe');
  await assert.rejects(
    tunnel.startTunnel({ relayPort: 48125, sshPath: missing }),
    /OpenSSH Client is not installed/i,
    'missing OpenSSH fails immediately with Windows installation guidance',
  );

  let probeStatus = 404;
  const probeServer = http.createServer((_req, res) => {
    res.writeHead(probeStatus, { 'Content-Type': 'text/plain' });
    res.end(probeStatus === 404 ? 'healthy Carry relay route' : 'stale public route');
  });
  await new Promise((resolve, reject) => {
    probeServer.once('listening', resolve);
    probeServer.once('error', reject);
    probeServer.listen(0, '127.0.0.1');
  });
  try {
    const probeUrl = `http://127.0.0.1:${probeServer.address().port}`;
    assert.deepStrictEqual(await tunnel.probeTunnelHealth(probeUrl), { healthy: true, status: 404 },
      'a healthy relay route accepts the expected non-WebSocket 404 response');
    probeStatus = 503;
    assert.deepStrictEqual(await tunnel.probeTunnelHealth(probeUrl), { healthy: false, status: 503 },
      'a provider 503 is recognized as a dead public tunnel route');
  } finally {
    await new Promise((resolve) => probeServer.close(resolve));
  }

  const hostedServer = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      service: 'carry-relay', transport: 'websocket', provider: 'cloudflare-durable-objects',
    }));
  });
  await new Promise((resolve, reject) => {
    hostedServer.once('listening', resolve);
    hostedServer.once('error', reject);
    hostedServer.listen(0, '127.0.0.1');
  });
  try {
    const hostedUrl = `http://127.0.0.1:${hostedServer.address().port}`;
    const health = await tunnel.probeHostedRelay(hostedUrl);
    assert.strictEqual(health.healthy, true, 'the stable provider identifies a Carry WebSocket relay');
    const handle = await tunnel.startHostedRelay({ url: hostedUrl });
    assert.strictEqual(handle.sharedRelay, true, 'hosted provider sends both devices to one shared relay');
    assert.strictEqual(handle.stableAddress, true, 'hosted provider address is reconnectable');
    handle.stop();
  } finally {
    await new Promise((resolve) => hostedServer.close(resolve));
  }
  assert.strictEqual(tunnel.isTemporaryTunnelAddress('https://temporary.lhr.life/carry'), true);
  assert.strictEqual(tunnel.isTemporaryTunnelAddress(tunnel.DEFAULT_HOSTED_RELAY_URL), false);

  let spawnedArgs = null;
  let healthChecks = 0;
  const fakeSpawn = (_executable, args) => {
    spawnedArgs = args;
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => setImmediate(() => child.emit('close', 1));
    setImmediate(() => child.stdout.write('Forwarding HTTP traffic from https://health-test.lhr.life\n'));
    return child;
  };
  const monitored = await tunnel.startTunnel({
    relayPort: 48125,
    sshPath: 'fake-ssh',
    spawn: fakeSpawn,
    healthIntervalMs: 5,
    healthFailureLimit: 2,
    healthProbe: async () => {
      healthChecks += 1;
      return { healthy: false, status: 503 };
    },
  });
  const monitorTestKeepAlive = setInterval(() => {}, 50);
  let outcome;
  try { outcome = await monitored.closed; }
  finally { clearInterval(monitorTestKeepAlive); }
  assert.strictEqual(outcome.expected, false, 'health monitor termination is reported as unexpected');
  assert.match(outcome.error, /free localhost\.run address expired/i,
    'a dead route produces actionable renewal guidance');
  assert.ok(healthChecks >= 2, 'one transient health failure does not terminate the tunnel');
  assert.ok(spawnedArgs.includes('ServerAliveCountMax=2'),
    'SSH exits promptly after two unanswered keepalives instead of remaining falsely alive');

  console.log('TUNNEL DIAGNOSTICS PASS: SSH discovery, actionable errors, and stale public-route detection.');
})().catch((error) => {
  console.error('TUNNEL DIAGNOSTICS FAIL:', error);
  process.exitCode = 1;
});
