'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const relay = require('../relay/server');
const relayClient = require('../lib/relay');
const manifest = require('../lib/manifest');
const tunnelHelper = require('../lib/tunnel');
const {
  IncomingTransferStore,
  DEFAULT_AGGREGATE_RESERVATION_BYTES,
} = require('../lib/transfer-store');

const CARRY = path.join(__dirname, '..', 'bin', 'carry.js');
const requestedLargeMiB = Number(process.env.CARRY_REMOTE_LARGE_MIB || 24);
if (!Number.isSafeInteger(requestedLargeMiB) || requestedLargeMiB < 1 || requestedLargeMiB > 384) {
  throw new Error('CARRY_REMOTE_LARGE_MIB must be an integer from 1 to 384');
}
const LARGE_BYTES = requestedLargeMiB * 1024 * 1024;

function writeSizedFile(file, bytes) {
  const handle = fs.openSync(file, 'w');
  try { fs.ftruncateSync(handle, bytes); }
  finally { fs.closeSync(handle); }
}

function run(args, cwd, timeoutMs = 180000, extraEnv) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CARRY, ...args], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: { ...process.env, ...(extraEnv || {}) },
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`command timed out: carry ${args.join(' ')}\n${stdout}\n${stderr}`));
    }, timeoutMs);
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

(async () => {
  const first = fs.mkdtempSync(path.join(os.tmpdir(), 'carry-remote-a-'));
  const second = fs.mkdtempSync(path.join(os.tmpdir(), 'carry-remote-b-'));
  const secret = relayClient.newRemoteSecret();
  const room = relayClient.roomForSecret(secret);
  let tunnel = null;
  const server = relay.startWebRelay(0, {
    host: '127.0.0.1',
    trustProxy: true,
    ignoreAllowlist: true,
    allowedRooms: new Set([room]),
  });
  try {
    await new Promise((resolve, reject) => {
      if (server.listening) return resolve();
      server.once('listening', resolve);
      server.once('error', reject);
    });
    let relayBase = `http://127.0.0.1:${server.address().port}/carry`;
    if (process.env.CARRY_REMOTE_TUNNEL === '1') {
      tunnel = await tunnelHelper.startTunnel({ relayPort: server.address().port });
      relayBase = relayClient.parseRelayAddress(tunnel.url).address;
    }
    const invite = `${relayBase}#${secret}`;
    const mixedDirect = process.env.CARRY_P2P_MIXED_TEST === '1';
    const directErrorTest = process.env.CARRY_P2P_ERROR_TEST === '1';
    const selectionRaceTest = process.env.CARRY_P2P_SELECTION_RACE_TEST === '1';
    assert.strictEqual((await run(['init', 'RemotePC'], first)).code, 0);
    assert.strictEqual((await run(['init', 'RemoteLaptop'], second)).code, 0);

    const firstPair = run(['pair', '--relay', invite], first);
    await new Promise((resolve) => setTimeout(resolve, 250));
    const secondPair = run(['pair', '--relay', invite], second);
    const pairResults = await Promise.all([firstPair, secondPair]);
    assert.ok(pairResults.every((result) => result.code === 0), JSON.stringify(pairResults));
    assert.ok(pairResults.every((result) => !result.stdout.includes(secret)), 'remote secret is not printed by pair logs');

    const firstManifest = manifest.readManifest(first);
    const secondManifest = manifest.readManifest(second);
    const directEnvironment = { CARRY_EXPERIMENTAL_P2P: '1' };
    const rejectingEnvironment = {
      CARRY_EXPERIMENTAL_P2P: '1',
      CARRY_TEST_REJECT_DIRECT_SELECTION: '1',
    };
    const firstCoordinates = [firstManifest.deviceId, secondManifest.deviceId].sort()[0] === firstManifest.deviceId;
    const syncEnvironments = mixedDirect
      ? [directEnvironment, { CARRY_EXPERIMENTAL_P2P: '0' }]
      : selectionRaceTest
        // Only the non-coordinator receives sync-transport-start and can reject
        // the proposed direct channel. Device ids are random, so assign the
        // rejection hook after pairing instead of hard-coding it to peer two.
        ? (firstCoordinates
          ? [directEnvironment, rejectingEnvironment]
          : [rejectingEnvironment, directEnvironment])
        : directErrorTest
          ? [directEnvironment, directEnvironment]
          : [null, null];
    const firstPeer = Object.values(firstManifest.peers)[0];
    const secondPeer = Object.values(secondManifest.peers)[0];
    assert.strictEqual(firstPeer.address, relayBase);
    assert.strictEqual(secondPeer.address, firstPeer.address);
    assert.strictEqual(firstPeer.pairCode, secret, 'strong invite secret is retained only in local peer metadata');

    fs.mkdirSync(path.join(first, 'src'), { recursive: true });
    fs.writeFileSync(path.join(first, 'src', 'remote.txt'), 'encrypted remote update');
    fs.mkdirSync(path.join(first, 'images'), { recursive: true });
    for (let index = 1; index <= 6; index++) {
      fs.writeFileSync(path.join(first, 'images', `old-${index}.jpg`), `old image ${index}`);
    }
    fs.mkdirSync(path.join(first, '.shared-memory'), { recursive: true });
    fs.writeFileSync(path.join(first, '.shared-memory', 'memory.json'),
      '{"type":"entity","name":"remote/test","entityType":"file","observations":["remote memory"]}\n');

    const syncResults = await Promise.all([
      run(['sync'], first, 180000, syncEnvironments[0]),
      run(['sync'], second, 180000, syncEnvironments[1]),
    ]);
    assert.ok(syncResults.every((result) => result.code === 0), JSON.stringify(syncResults));
    assert.strictEqual(fs.readFileSync(path.join(second, 'src', 'remote.txt'), 'utf8'), 'encrypted remote update');
    assert.strictEqual(fs.readdirSync(path.join(second, 'images')).length, 6);
    assert.ok(fs.readFileSync(path.join(second, '.shared-memory', 'memory.json'), 'utf8').includes('remote memory'));

    await new Promise((resolve) => setTimeout(resolve, 600));
    fs.rmSync(path.join(first, 'images'), { recursive: true, force: true });
    fs.writeFileSync(path.join(first, 'empty.txt'), '');
    writeSizedFile(path.join(first, 'replacement.clip'), LARGE_BYTES);
    if (directErrorTest) {
      const reservationOptions = (exchangeId) => ({
        exchangeId,
        peerId: 'quota-reservation-peer',
        dataPaths: ['reserved.bin'],
        textPaths: [],
        expectedChunkCount: 1,
        expectedChars: 0,
        maxBytes: DEFAULT_AGGREGATE_RESERVATION_BYTES / 2,
      });
      new IncomingTransferStore(second, reservationOptions('aa0011223344556677889900'));
      new IncomingTransferStore(second, reservationOptions('bb0011223344556677889900'));
    }
    const largeRoundStartedAt = Date.now();
    const laterSyncResults = await Promise.all([
      run(['sync'], first, 180000, syncEnvironments[0]),
      run(['sync'], second, 180000, syncEnvironments[1]),
    ]);
    const largeRoundSeconds = (Date.now() - largeRoundStartedAt) / 1000;
    if (directErrorTest) {
      assert.ok(laterSyncResults.every((result) => result.code === 1), JSON.stringify(laterSyncResults));
      assert.match(laterSyncResults[0].stdout, /peer rejected sync: incoming transfers have reached Carry's aggregate disk reservation limit/,
        'direct sender receives the peer rejection instead of a generic DataChannel close');
      assert.ok(!/! Error: direct DataChannel closed\s*$/m.test(laterSyncResults[0].stdout),
        'the sender does not lose the actionable peer error during direct shutdown');
      console.log('REMOTE DIRECT ERROR PROPAGATION PASS: receiver cause survives encrypted channel shutdown.');
      return;
    }
    assert.ok(laterSyncResults.every((result) => result.code === 0), JSON.stringify(laterSyncResults));
    const laterOutput = laterSyncResults.map((result) => result.stdout).join('\n');
    assert.match(laterOutput, /Carry plans to send 2 update\(s\) and 6 deletion\(s\) to the peer/);
    assert.match(laterOutput, /Sending .* in \d+ encrypted part/i, 'large replacement uses encrypted relay chunks');
    assert.match(laterOutput, /stable .* snapshot of 2 changed file\(s\)/,
      'unchanged project files are not rewritten into the outgoing snapshot');
    assert.match(laterOutput, /Peer received encrypted update: ([1-9]|[1-9]\d)%/,
      'large transfer reports encrypted progress from the receiving peer');
    assert.match(laterOutput, /faster encrypted byte transfer/,
      'new WebSocket peers avoid the second base64 expansion for file chunks');
    assert.match(laterOutput, /Peer confirmed receipt of our final acknowledgement/,
      'both peers keep the room open until the terminal acknowledgement is delivered');
    assert.ok(laterSyncResults.every((result) => /Sync complete on both devices/.test(result.stdout)),
      'both processes report committed completion rather than stopping when files merely appear');
    assert.ok(!laterOutput.includes('retrying ('), 'an active transfer is never duplicated while waiting for its final acknowledgement');
    assert.ok(!laterOutput.includes('Local files already match the safe sync plan'), 'relay log does not imply outgoing delivery before acknowledgement');
    if (process.env.CARRY_EXPERIMENTAL_P2P === '1' && !mixedDirect) {
      assert.ok(laterSyncResults.every((result) => /Direct encrypted connection ready/.test(result.stdout)),
        'both peers explicitly selected the authenticated direct channel');
      assert.ok(!laterOutput.includes('Using the secure relay connection for this transfer'),
        'the experimental direct integration did not silently fall back during the local-native test');
    }
    if (mixedDirect) {
      assert.match(laterOutput, /Using the secure relay connection for this transfer/,
        'a peer without direct support triggers the secure relay fallback before bulk transfer');
      assert.ok(!laterOutput.includes('Direct encrypted connection ready'),
        'mixed-version peers never split across different bulk channels');
    }
    if (selectionRaceTest) {
      assert.ok(laterSyncResults.every((result) => /Using the secure relay connection for this transfer/.test(result.stdout)),
        `both peers acknowledge the same relay fallback before either sends project data: ${JSON.stringify(laterSyncResults)}`);
      assert.ok(!laterOutput.includes('Direct encrypted connection ready'),
        'a rejected direct selection is never logged or used as a committed transport');
      assert.ok(!laterOutput.includes('peer sent project data over the relay after selecting the direct channel'),
        'transport selection cannot split between direct and relay');
    }
    assert.strictEqual(fs.statSync(path.join(second, 'replacement.clip')).size, LARGE_BYTES,
      'the relay room carries a chunked replacement file after both first-sync sockets disconnect');
    assert.strictEqual(fs.statSync(path.join(second, 'empty.txt')).size, 0,
      'the relay room carries an empty text file alongside a large binary file');
    for (let index = 1; index <= 6; index++) {
      assert.ok(!fs.existsSync(path.join(second, 'images', `old-${index}.jpg`)), `the second round deletes old image ${index}`);
    }

    console.log(`REMOTE LARGE ROUND: ${largeRoundSeconds.toFixed(3)} seconds.`);
    console.log(`REMOTE RELAY INTEGRATION PASS (${tunnel ? 'localhost.run HTTPS' : 'local WebSocket'}): secure invite pair + two encrypted file/memory sync rounds.`);
  } finally {
    if (tunnel) tunnel.stop();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(first, { recursive: true, force: true });
    fs.rmSync(second, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error('REMOTE RELAY INTEGRATION FAIL:', error.stack || error.message);
  process.exitCode = 1;
});
