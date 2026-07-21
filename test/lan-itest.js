'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const manifest = require('../lib/manifest');
const transport = require('../lib/transport');

const CARRY = path.join(__dirname, '..', 'bin', 'carry.js');
const T = () => new Date().toISOString().slice(11, 23);
function run(args, cwd, timeoutMs) {
  return new Promise((res) => {
    const p = spawn('node', [CARRY, ...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    let done = false;
    let timer = null;
    const finish = (code) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      res({ code, out, err });
    };
    p.stdout.on('data', d => out += d);
    p.stderr.on('data', d => err += d);
    p.on('close', finish);
    if (timeoutMs) timer = setTimeout(() => { try { p.kill(); } catch {} finish('timeout'); }, timeoutMs);
  });
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '0.0.0.0', () => {
      const port = server.address().port;
      server.close((err) => err ? reject(err) : resolve(port));
    });
  });
}

function stopChild(child) {
  return new Promise((resolve) => {
    if (child.exitCode !== null) return resolve();
    child.once('close', resolve);
    try { child.kill(); } catch { resolve(); }
  });
}

(async () => {
  const A = fs.mkdtempSync(path.join(os.tmpdir(), 'lanA-'));
  const B = fs.mkdtempSync(path.join(os.tmpdir(), 'lanB-'));
  const aPort = await freePort();
  let bPort = await freePort();
  while (bPort === aPort) bPort = await freePort();
  await run(['init', 'lanA'], A);
  await run(['init', 'lanB'], B);
  const aId = manifest.readManifest(A).deviceId;
  const bId = manifest.readManifest(B).deviceId;

  let acode = '';
  const adv = spawn('node', [CARRY, 'pair', `--link-port=${aPort}`], { cwd: A, stdio: ['ignore', 'pipe', 'pipe'] });
  const onData = (d) => {
    const m = d.toString().match(/Your pairing code: ([A-F0-9]{32})/);
    if (m && !acode) acode = m[1];
  };
  adv.stdout.on('data', onData);
  adv.stderr.on('data', onData);
  await new Promise(r => setTimeout(r, 1500));
  if (!acode) { console.error('LAN FAIL: no code captured'); process.exit(1); }
  console.log(T(), 'A code:', acode);
  const discoveryBytes = transport.discoveryPacket(acode, {
    deviceId: aId,
    name: 'LAN project with spaces',
  }, aPort);
  const parsedDiscovery = transport.parseDiscoveryPacket(discoveryBytes);
  if (discoveryBytes.toString('utf8').includes(acode) || parsedDiscovery.name !== 'LAN project with spaces' || parsedDiscovery.port !== aPort) {
    throw new Error('secure discovery exposed the transport key or lost the project name/custom port');
  }

  const pb = await run(['pair', acode, `--link-port=${bPort}`], B, 15000);
  console.log(T(), 'B pair out:', pb.out.trim(), '| err:', pb.err.trim());
  if (pb.out.includes('Paired') === false) { console.error('LAN FAIL: B did not pair'); process.exit(1); }
  await new Promise(r => setTimeout(r, 300));

  // Simulate both machines receiving new DHCP endpoints after pairing. Sync
  // advertisements must rediscover the expected device (not the local one)
  // and persist its current port before transferring data.
  let staleAPort = await freePort();
  while (staleAPort === aPort || staleAPort === bPort) staleAPort = await freePort();
  let staleBPort = await freePort();
  while (staleBPort === aPort || staleBPort === bPort || staleBPort === staleAPort) staleBPort = await freePort();
  const peerFromA = manifest.listPeers(A).find((item) => item.deviceId === bId);
  const peerFromB = manifest.listPeers(B).find((item) => item.deviceId === aId);
  manifest.updateLanEndpoint(A, bId, peerFromA.address, staleBPort);
  manifest.updateLanEndpoint(B, aId, peerFromB.address, staleAPort);

  // Model a hard-killed previous sender. A safely contained snapshot older
  // than the transfer TTL should be pruned before the next outgoing copy.
  const staleSnapshot = path.join(A, '.carry', 'outgoing', 'f'.repeat(24));
  fs.mkdirSync(staleSnapshot, { recursive: true });
  fs.writeFileSync(path.join(staleSnapshot, '000000.part'), 'abandoned');
  const oldSnapshotTime = new Date(Date.now() - 25 * 60 * 60 * 1000);
  fs.utimesSync(staleSnapshot, oldSnapshotTime, oldSnapshotTime);

  fs.writeFileSync(path.join(A, 'doc.txt'), 'lan hello');
  fs.mkdirSync(path.join(A, '.shared-memory'), { recursive: true });
  fs.writeFileSync(path.join(A, '.shared-memory', 'memory.json'),
    '{"type":"entity","name":"lan/x","entityType":"file","observations":["A wrote this over LAN"]}\n');

  const [ra, rb] = await Promise.all([
    run(['sync', `--link-port=${aPort}`], A, 30000),
    run(['sync', `--link-port=${bPort}`], B, 30000),
  ]);
  console.log(T(), 'A sync:', ra.out.trim(), '| err:', ra.err.trim());
  console.log(T(), 'B sync:', rb.out.trim(), '| err:', rb.err.trim());
  if (ra.code !== 0 || rb.code !== 0) {
    throw new Error(`sync processes failed (A=${ra.code}, B=${rb.code})`);
  }

  const gotFile = fs.existsSync(path.join(B, 'doc.txt')) && fs.readFileSync(path.join(B, 'doc.txt'), 'utf8') === 'lan hello';
  const mem = fs.readFileSync(path.join(B, '.shared-memory', 'memory.json'), 'utf8');
  const refreshedFromA = manifest.listPeers(A).find((item) => item.deviceId === bId);
  const refreshedFromB = manifest.listPeers(B).find((item) => item.deviceId === aId);
  const endpointRefreshPass = refreshedFromA.port === bPort && refreshedFromB.port === aPort &&
    !fs.existsSync(staleSnapshot);
  console.log('RESULT B got A doc:', gotFile);
  console.log('RESULT B memory has A obs:', mem.includes('A wrote this over LAN'));
  console.log('RESULT stale LAN endpoints and abandoned snapshots recovered:', endpointRefreshPass);

  // Round 2 proves the baseline-aware engine sends a laptop-only change back
  // to the PC instead of the old PC copy overwriting it.
  fs.writeFileSync(path.join(B, 'doc.txt'), 'continued on laptop');
  const [updateA, updateB] = await Promise.all([
    run(['sync', `--link-port=${aPort}`], A, 20000),
    run(['sync', `--link-port=${bPort}`], B, 20000),
  ]);
  const updatePass = updateA.code === 0 && updateB.code === 0 &&
    fs.readFileSync(path.join(A, 'doc.txt'), 'utf8') === 'continued on laptop' &&
    fs.readFileSync(path.join(B, 'doc.txt'), 'utf8') === 'continued on laptop';
  console.log('RESULT laptop-only update reached PC safely:', updatePass);
  if (!updatePass) {
    console.log(T(), 'A round-2 sync:', updateA.out.trim(), '| err:', updateA.err.trim(), '| code:', updateA.code);
    console.log(T(), 'B round-2 sync:', updateB.out.trim(), '| err:', updateB.err.trim(), '| code:', updateB.code);
  }

  // A multi-megabyte LAN exchange must be chunked with backpressure instead
  // of becoming one giant JSON frame. This is the same path used by folders
  // containing hundreds of megabytes of media and binary assets.
  fs.writeFileSync(path.join(A, 'large-lan.bin'), Buffer.alloc(8 * 1024 * 1024, 0x5a));
  const [largeA, largeB] = await Promise.all([
    run(['sync', `--link-port=${aPort}`], A, 60000),
    run(['sync', `--link-port=${bPort}`], B, 60000),
  ]);
  const largeTarget = path.join(B, 'large-lan.bin');
  const largePass = largeA.code === 0 && largeB.code === 0 &&
    fs.existsSync(largeTarget) && fs.statSync(largeTarget).size === 8 * 1024 * 1024 &&
    fs.readFileSync(largeTarget).at(-1) === 0x5a &&
    /Sending .* in \d+ encrypted part/.test(largeA.out) &&
    /Receiving .* in \d+ encrypted part/.test(largeB.out) &&
    /Encrypted LAN update sent: ([1-9]|1\d|2[0-4])%/.test(largeA.out) &&
    /Encrypted update received: ([1-9]|1\d|2[0-4])%/.test(largeB.out);
  console.log('RESULT chunked 8 MiB LAN transfer with progress:', largePass);

  // The next round proves independent edits are reported and neither copy is touched.
  fs.writeFileSync(path.join(A, 'doc.txt'), 'PC independent edit');
  fs.writeFileSync(path.join(B, 'doc.txt'), 'laptop independent edit');
  const [conflictA, conflictB] = await Promise.all([
    run(['sync', `--link-port=${aPort}`], A, 20000),
    run(['sync', `--link-port=${bPort}`], B, 20000),
  ]);
  const conflictPass = conflictA.code === 0 && conflictB.code === 0 &&
    fs.readFileSync(path.join(A, 'doc.txt'), 'utf8') === 'PC independent edit' &&
    fs.readFileSync(path.join(B, 'doc.txt'), 'utf8') === 'laptop independent edit' &&
    conflictA.out.includes('Conflict:') && conflictB.out.includes('Conflict:');
  console.log('RESULT two-device conflict preserved both copies:', conflictPass);

  // Explicit Push is a whole-exchange choice: A wins the existing conflict
  // and destination-only files are deleted after B creates a checkpoint.
  fs.writeFileSync(path.join(B, 'destination-only.txt'), 'remove during push');
  const [pushA, pushB] = await Promise.all([
    run(['sync', `--link-port=${aPort}`, `--source-device=${aId}`], A, 30000),
    run(['sync', `--link-port=${bPort}`, `--source-device=${aId}`], B, 30000),
  ]);
  const pushPass = pushA.code === 0 && pushB.code === 0 &&
    fs.readFileSync(path.join(B, 'doc.txt'), 'utf8') === 'PC independent edit' &&
    !fs.existsSync(path.join(B, 'destination-only.txt')) &&
    pushA.out.includes('Carry push to') && pushB.out.includes('Carry pull from');
  console.log('RESULT explicit LAN Push mirrors the selected source:', pushPass);

  // Pull uses the selected peer as source and safely replaces a different
  // local version without requiring per-file conflict clicks.
  fs.writeFileSync(path.join(A, 'doc.txt'), 'outdated PC before pull');
  fs.writeFileSync(path.join(B, 'doc.txt'), 'laptop selected for pull');
  const [pullA, pullB] = await Promise.all([
    run(['sync', `--link-port=${aPort}`, `--source-device=${bId}`], A, 30000),
    run(['sync', `--link-port=${bPort}`, `--source-device=${bId}`], B, 30000),
  ]);
  const pullPass = pullA.code === 0 && pullB.code === 0 &&
    fs.readFileSync(path.join(A, 'doc.txt'), 'utf8') === 'laptop selected for pull' &&
    pullA.out.includes('Carry pull from') && pullB.out.includes('Carry push to');
  console.log('RESULT explicit LAN Pull mirrors the selected peer:', pullPass);

  const outgoingEntries = (root) => {
    const directory = path.join(root, '.carry', 'outgoing');
    return fs.existsSync(directory) ? fs.readdirSync(directory) : [];
  };
  const snapshotCleanupPass = outgoingEntries(A).length === 0 && outgoingEntries(B).length === 0;
  console.log('RESULT temporary outgoing snapshots were cleaned:', snapshotCleanupPass);

  await stopChild(adv);
  fs.rmSync(A, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.rmSync(B, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  process.exit(gotFile && mem.includes('A wrote this over LAN') && endpointRefreshPass && updatePass && largePass && conflictPass && pushPass && pullPass && snapshotCleanupPass ? 0 : 1);
})().catch((e) => { console.error('LAN FAIL:', e); process.exit(1); });
