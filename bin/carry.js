#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const nodeCrypto = require('crypto');
const manifest = require('../lib/manifest');
const sync = require('../lib/sync');
const syncEngine = require('../lib/sync-engine');
const folderPicker = require('../lib/folder-picker');
const transport = require('../lib/transport');
const relayClient = require('../lib/relay');
const frameCrypto = require('../lib/crypto');
const privateState = require('../lib/private-state');
const {
  IncomingTransferStore,
  MAX_EXPECTED_CHUNKS,
  MAX_EXPECTED_CHARS,
  MAX_EXPECTED_BYTES,
  MAX_TRANSFER_FILE_BYTES,
  MAX_TEXT_BYTES,
} = require('../lib/transfer-store');
const storageHealth = require('../lib/storage-health');
const p2p = require('../lib/p2p');

const DEFAULT_LINK_PORT = 48124;
const RELAY_SINGLE_FRAME_BYTES = 384 * 1024;
const RELAY_CHUNK_CHARS = 256 * 1024;
const RELAY_CHUNK_RAW_BYTES = (RELAY_CHUNK_CHARS / 4) * 3;
const RELAY_BUFFER_HIGH_WATER = 4 * 1024 * 1024;
const RELAY_IN_FLIGHT_CHUNKS = 32;
const DIRECT_IN_FLIGHT_CHUNKS = 8;
const MAX_RELAY_BUNDLE_CHARS = MAX_EXPECTED_CHARS;
const MAX_RELAY_BUNDLE_BYTES = MAX_EXPECTED_BYTES;
const MAX_RELAY_BUNDLE_CHUNKS = MAX_EXPECTED_CHUNKS;
const LEGACY_RELAY_BUNDLE_CHARS = 512 * 1024 * 1024;
const MAX_BUNDLE_METADATA_BYTES = 64 * 1024 * 1024;
const MAX_BUNDLE_METADATA_CHUNKS = 1024;
const RELAY_SYNC_IDLE_MS = 60000;
const RELAY_SYNC_APPLY_MS = 20 * 60 * 1000;
const RELAY_SYNC_APPLY_MAX_MS = 2 * 60 * 60 * 1000;
const RELAY_SYNC_ABSOLUTE_MS = 12 * 60 * 60 * 1000;
const LAN_SYNC_IDLE_MS = 5 * 60 * 1000;
const OUTGOING_SNAPSHOT_TTL_MS = 24 * 60 * 60 * 1000;
const RELAY_STATUS_INTERVAL_MS = 10000;
// Smaller SCTP messages keep libdatachannel's native send queue moving under
// sustained file traffic; its advertised one-message limit is not a safe
// sustained-throughput window on every Windows network stack.
// Keep internet-path SCTP messages conservative. bufferedAmount does not
// include transport-level queues, so the separate receiver window below also
// limits how far the sender can get ahead of durable encrypted receipts.
const DIRECT_CHUNK_RAW_BYTES = Math.min(p2p.MAX_BINARY_PAYLOAD_BYTES, 64 * 1024);
const DIRECT_CHUNK_CHARS = Math.floor(DIRECT_CHUNK_RAW_BYTES / 3) * 4;
const DIRECT_TEXT_CHUNK_CHARS = 64 * 1024;
const DIRECT_SINGLE_FRAME_BYTES = 96 * 1024;
const DIRECT_NEGOTIATION_MS = 12000;
const DIRECT_HELLO_VERSION = 1;
const SYNC_BULK_FRAME_TYPES = new Set([
  'sync-bundle',
  'sync-bundle-start',
  'sync-bundle-chunk',
  'sync-bundle-end',
  'sync-bundle-selection',
  'sync-bundle-ready',
  'sync-bundle-metadata-start',
  'sync-bundle-metadata-chunk',
  'sync-bundle-metadata-end',
]);

const log = {
  title: (s) => console.log('\n\x1b[1m' + s + '\x1b[0m'),
  step: (s) => console.log('  \x1b[32m✓\x1b[0m ' + s),
  info: (s) => console.log('  ' + s),
  warn: (s) => console.log('  \x1b[33m!\x1b[0m ' + s),
  done: () => console.log(''),
  mark: (b) => (b ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'),
};

function directHello(from, nonce) {
  return {
    type: 'sync-transport-hello',
    version: DIRECT_HELLO_VERSION,
    from,
    direct: true,
    nonce,
  };
}

function validateDirectHello(frame, peerId) {
  if (!frame || typeof frame !== 'object' || Array.isArray(frame) ||
      Object.keys(frame).sort().join(',') !== 'direct,from,nonce,type,version' ||
      frame.type !== 'sync-transport-hello' || frame.version !== DIRECT_HELLO_VERSION ||
      frame.direct !== true || frame.from !== peerId ||
      typeof frame.nonce !== 'string' || !/^[A-Za-z0-9_-]{22}$/.test(frame.nonce)) {
    throw new Error('peer sent an invalid direct-transport hello');
  }
  return frame;
}

function directAttemptId(selfId, selfNonce, peerId, peerNonce) {
  const participants = [
    `${selfId}\0${selfNonce}`,
    `${peerId}\0${peerNonce}`,
  ].sort();
  return nodeCrypto.createHash('sha256')
    .update('carry-direct-attempt-v1\0', 'utf8')
    .update(participants[0], 'utf8')
    .update('\0', 'utf8')
    .update(participants[1], 'utf8')
    .digest('hex')
    .slice(0, 24);
}

function validateDirectControl(frame, type, peerId, selfId, attemptId) {
  const transportControl = type === 'sync-transport-start' || type === 'sync-transport-ack';
  const expectedKeys = transportControl
    ? 'attemptId,from,to,transport,type,version'
    : 'attemptId,from,to,type,version';
  if (!frame || typeof frame !== 'object' || Array.isArray(frame) ||
      Object.keys(frame).sort().join(',') !== expectedKeys || frame.type !== type ||
      frame.version !== DIRECT_HELLO_VERSION || frame.from !== peerId || frame.to !== selfId ||
      frame.attemptId !== attemptId) {
    throw new Error('peer sent invalid direct-transport control data');
  }
  if (transportControl && frame.transport !== 'direct' && frame.transport !== 'relay') {
    throw new Error('peer selected an invalid sync transport');
  }
  return frame;
}

function parseArgs(argv) {
  const out = { _: [], flags: {} };
  const valueFlags = new Set(['peer', 'as', 'relay', 'link-port', 'folder', 'port', 'source-device', 'sync-run']);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--') && a.includes('=')) {
      const eq = a.indexOf('=');
      out.flags[a.slice(2, eq)] = a.slice(eq + 1);
    } else if (a.startsWith('--') && valueFlags.has(a.slice(2))) {
      if (i + 1 >= argv.length) throw new Error(`${a} requires a value`);
      out.flags[a.slice(2)] = argv[++i];
    } else if (a.startsWith('--')) {
      out.flags[a.slice(2)] = true;
    } else {
      out._.push(a);
    }
  }
  return out;
}

function getLinkPort(flags) {
  const port = Number.parseInt(flags['link-port'] || String(DEFAULT_LINK_PORT), 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('--link-port must be an integer from 1 to 65535');
  }
  return port;
}

function requireProject() {
  const root = manifest.findCarryRoot(process.cwd());
  if (!root) throw new Error('not inside a carry project — run `carry init <name>` first');
  return root;
}

function requireManifest(root) {
  const m = manifest.readManifest(root);
  if (!m) throw new Error('project manifest missing or corrupt — re-run `carry init`');
  return m;
}

function hashFileAsync(file) {
  return new Promise((resolve, reject) => {
    const hash = nodeCrypto.createHash('sha256');
    const stream = fs.createReadStream(file, { highWaterMark: 1024 * 1024 });
    stream.on('data', (chunk) => hash.update(chunk));
    stream.once('error', reject);
    stream.once('end', () => {
      try { resolve(hash.digest('hex')); }
      catch (error) { reject(error); }
    });
  });
}

function pruneStaleOutgoingSnapshots(outgoingRoot) {
  if (!fs.existsSync(outgoingRoot)) return;
  const parentStat = fs.lstatSync(outgoingRoot);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) {
    throw new Error('Carry outgoing storage is unsafe');
  }
  const realOutgoing = fs.realpathSync(outgoingRoot);
  const cutoff = Date.now() - OUTGOING_SNAPSHOT_TTL_MS;
  for (const entry of fs.readdirSync(outgoingRoot, { withFileTypes: true })) {
    if (!/^[a-f0-9]{24}$/.test(entry.name) || !entry.isDirectory() || entry.isSymbolicLink()) continue;
    const directory = path.join(outgoingRoot, entry.name);
    const stat = fs.lstatSync(directory);
    if (stat.mtimeMs >= cutoff || stat.isSymbolicLink()) continue;
    const realDirectory = fs.realpathSync(directory);
    if (path.dirname(realDirectory) !== realOutgoing || path.basename(realDirectory) !== entry.name) {
      throw new Error('refusing to clean an uncontained outgoing snapshot');
    }
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}

// Build a sync bundle: file list + sha256 hashes + the raw bytes of each file
// we would push, plus the memory store to be merged (not overwritten).
function buildBundle(root, selfAgent, peerId, syncSourceDeviceId) {
  const outgoing = syncEngine.buildStreamingBundle(root, selfAgent, peerId, syncSourceDeviceId);
  let prepared = false;
  outgoing.snapshotSelected = async (selectedPaths, onProgress) => {
    if (prepared) throw new Error('outgoing sync snapshot was already prepared');
    prepared = true;
    const selected = selectedPaths instanceof Set ? selectedPaths : new Set(selectedPaths || []);
    const sources = [...outgoing.fileSources].filter(([rel]) => selected.has(rel));
    if (!sources.length) return new Map();

    // Snapshot only the files the peer actually needs. This avoids rewriting
    // an entire multi-gigabyte project for a small incremental update while
    // preserving a stable source if either working tree changes during sync.
    const selectedBytes = sources.reduce((sum, [, source]) => sum + source.size, 0);
    if (!Number.isSafeInteger(selectedBytes) || selectedBytes > MAX_TRANSFER_FILE_BYTES) {
      throw new Error('selected file changes exceed Carry\'s 5 GiB one-exchange limit');
    }
    const carryRoot = privateState.projectDir(root);
    const outgoingRoot = path.join(carryRoot, 'outgoing');
    fs.mkdirSync(outgoingRoot, { recursive: true, mode: 0o700 });
    for (const directory of [carryRoot, outgoingRoot]) {
      const stat = fs.lstatSync(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Carry outgoing storage is unsafe');
      if (process.platform !== 'win32') fs.chmodSync(directory, 0o700);
    }
    pruneStaleOutgoingSnapshots(outgoingRoot);
    storageHealth.requireHealthyFreeSpace(
      outgoingRoot,
      selectedBytes,
      'Preparing the stable outgoing update',
    );
    log.info(`Preparing a stable ${storageHealth.formatBytes(selectedBytes)} snapshot of ${sources.length} changed file(s)...`);
    const snapshotId = nodeCrypto.randomBytes(12).toString('hex');
    const snapshotDirectory = path.join(outgoingRoot, snapshotId);
    fs.mkdirSync(snapshotDirectory, { mode: 0o700 });
    if (process.platform !== 'win32') fs.chmodSync(snapshotDirectory, 0o700);
    const cleanup = () => {
      if (path.dirname(snapshotDirectory) !== outgoingRoot || path.basename(snapshotDirectory) !== snapshotId) {
        throw new Error('refusing to clean an uncontained outgoing snapshot');
      }
      if (!fs.existsSync(snapshotDirectory)) return;
      const parentStat = fs.lstatSync(outgoingRoot);
      const snapshotStat = fs.lstatSync(snapshotDirectory);
      if (!parentStat.isDirectory() || parentStat.isSymbolicLink() ||
          !snapshotStat.isDirectory() || snapshotStat.isSymbolicLink() ||
          path.dirname(fs.realpathSync(snapshotDirectory)) !== fs.realpathSync(outgoingRoot)) {
        throw new Error('refusing to clean an unsafe outgoing snapshot');
      }
      fs.rmSync(snapshotDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    };
    outgoing.cleanup = cleanup;
    const snapshots = new Map();
    try {
      let index = 0;
      for (const [rel, source] of sources) {
        const snapshot = path.join(snapshotDirectory, String(index++).padStart(6, '0') + '.part');
        // Use asynchronous filesystem operations here so a many-file snapshot
        // cannot starve relay heartbeats while the peer waits for file data.
        await fs.promises.copyFile(source.file, snapshot, fs.constants.COPYFILE_EXCL);
        if (process.platform !== 'win32') await fs.promises.chmod(snapshot, 0o600);
        const hash = await hashFileAsync(snapshot);
        if (hash !== source.hash) throw new Error('local file changed while Carry prepared it for sync: ' + rel);
        const stat = fs.lstatSync(snapshot);
        if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Carry outgoing snapshot is unsafe');
        snapshots.set(rel, {
          file: snapshot,
          size: stat.size,
          mtimeMs: stat.mtimeMs,
          dev: stat.dev,
          ino: stat.ino,
          hash,
        });
        if (onProgress) await Promise.resolve(onProgress());
      }
      return snapshots;
    } catch (error) {
      try { cleanup(); } catch { /* preserve snapshot preparation failure */ }
      throw error;
    }
  };
  return outgoing;
}

function cmdInit(args, flags) {
  const root = flags && flags.folder ? folderPicker.resolveFolder(flags.folder) : process.cwd();
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    throw new Error('the selected path is not an existing folder');
  }
  const containingProject = manifest.findCarryRoot(root);
  if (containingProject && path.resolve(containingProject) !== path.resolve(root)) {
    throw new Error('the selected folder is inside another Carry project; select its root: ' + containingProject);
  }
  const name = args[1];
  const r = manifest.init(root, name);
  log.title('Carry init' + (r.created ? '' : ' (already initialized)'));
  log.step(`Project: ${r.manifest.name}  (${r.root})`);
  log.step(`Device id: ${r.manifest.deviceId}`);
  log.info('Private metadata stored in your local Carry app data — the selected folder is untouched.');
  log.info('Next: run `carry pair` on this machine and `carry pair <code>` on the other.');
  log.done();
}

async function cmdPair(args, flags) {
  const root = requireProject();
  const m = requireManifest(root);

  // Cross-network pairing: a relay brokers the connection. The peer is reached
  // via the relay URL + room code instead of a LAN IP.
  if (flags.relay) {
    const relayInput = flags.relay;
    const client = new relayClient.RelayClient();
    const relayInfo = client.setRelay(relayInput);
    const code = relayInfo.secret || args[1] || relayClient.newRemoteSecret();
    if (!relayClient.REMOTE_SECRET_PATTERN.test(String(code))) {
      throw new Error('remote pairing requires a 256-bit invitation secret; use the complete invitation or generate a new one');
    }
    const relayUrl = relayInfo.address;
    log.title('Carry pair via relay ' + relayUrl);
    if (relayInfo.secret) {
      log.step('Secure remote invite accepted.');
      log.info('Use the same invite on the other device; its secret is never sent to the relay.');
    } else {
      log.step('Your pairing code: ' + code);
      log.info('On the other machine run:  carry pair ' + code + ' --relay ' + relayUrl);
    }
    return new Promise((resolve, reject) => {
      let introSent = false;
      let settled = false;
      const timeout = setTimeout(() => finish(new Error('remote pairing timed out before the other device completed the handshake')), 120000);
      timeout.unref?.();
      const finish = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        client.close();
        if (error) reject(error);
        else resolve();
      };
      client.join(code, m.deviceId, (frame, respond) => {
        if (frame.type === 'relay-ready' && !introSent) {
          // Identity and project name travel only inside the encrypted channel.
          // The public tunnel sees an opaque member token instead.
          introSent = true;
          respond({ type: 'pair-intro', deviceId: m.deviceId, name: m.name, ...(flags.team ? { teamJoiner: true } : {}) });
        } else if (frame.type === 'pair-intro' && !flags.team) {
          if (!/^[A-Za-z0-9_-]{6,128}$/.test(String(frame.deviceId || '')) ||
              !String(frame.name || '').trim() || /[\r\n\0]/.test(String(frame.name))) {
            finish(new Error('relay peer sent an invalid encrypted identity'));
            return;
          }
          const peerName = String(frame.name).trim().slice(0, 80);
          manifest.addPeer(root, frame.deviceId, peerName, 'relay', {
            address: relayUrl,
            pairCode: code,
            teamCode: null,
          });
          log.step(`Paired with ${peerName} (${frame.deviceId.slice(0, 6)}) via relay.`);
          log.info('Run `carry sync` to exchange files.');
          log.done();
          finish();
        } else if (frame.type === 'pair-team-accept' && flags.team) {
          if (!/^[A-Za-z0-9_-]{6,128}$/.test(String(frame.deviceId || '')) ||
              !String(frame.name || '').trim() || /[\r\n\0]/.test(String(frame.name))) {
            finish(new Error('team host sent an invalid encrypted identity'));
            return;
          }
          const peerName = String(frame.name).trim().slice(0, 80);
          const pairCode = String(frame.pairCode || '');
          if (!relayClient.REMOTE_SECRET_PATTERN.test(pairCode) || pairCode === code) {
            finish(new Error('team host did not issue a valid independent pair key'));
            return;
          }
          manifest.addPeer(root, frame.deviceId, peerName, 'relay', {
            address: relayUrl,
            pairCode,
            teamCode: null,
          });
          log.step(`Paired with team host ${peerName} (${frame.deviceId.slice(0, 6)}) via relay.`);
          log.info('Run `carry sync` to exchange files.');
          log.done();
          finish();
        } else if (frame.type === 'pair-team-reject' && flags.team) {
          finish(new Error(String(frame.message || 'the team host rejected this device')));
        } else if (frame.type === 'relay-error') {
          finish(new Error('relay error: ' + (frame.message || 'connection failed')));
        } else if (frame.type === 'peer-gone') {
          finish(new Error('the other device disconnected before remote pairing completed'));
        }
      }, m.name, code).catch(finish);
    });
  }

  const localLinkPort = getLinkPort(flags);

  if (args[1]) {
    // We are the second machine: discover the code on the LAN, then connect.
    const code = String(args[1]).trim();
    if (!/^[A-F0-9]{32}$/i.test(code)) {
      throw new Error('secure LAN pairing codes contain 32 hexadecimal characters; generate a new code on the other device');
    }
    log.title('Carry pair — looking for ' + code + ' on the LAN');
    const peer = await transport.discover(code);
    if (!peer) throw new Error('no peer found advertising that code');
    log.step(`Found ${peer.name} @ ${peer.address} (${peer.deviceId.slice(0, 6)})`);
    // Open the link and complete a handshake; the advertiser acts as server.
    // Frames are AES-256-GCM encrypted with the pairing code as the key.
    return new Promise((resolve, reject) => {
      let socket = null;
      let finished = false;
      const timeout = setTimeout(() => finish(new Error('the device answered discovery but did not complete the encrypted pairing handshake')), 20000);
      timeout.unref?.();
      const finish = (error, deviceId) => {
        if (finished) return;
        finished = true;
        clearTimeout(timeout);
        if (socket) { try { socket.end(); } catch { /* ignore */ } }
        if (error) reject(error);
        else resolve(deviceId);
      };
      transport.connectEncrypted(peer.address, peer.port || DEFAULT_LINK_PORT, code, (frame, respond) => {
        if (frame.type !== 'hello-ack' || finished) return;
        if (!/^[A-Za-z0-9_-]{6,128}$/.test(String(frame.deviceId || '')) ||
            !String(frame.name || '').trim() || /[\r\n\0]/.test(String(frame.name)) ||
            !Number.isInteger(frame.linkPort) || frame.linkPort < 1 || frame.linkPort > 65535) {
          finish(new Error('the LAN peer sent an invalid encrypted identity'));
          return;
        }
        // Trust the identity inside the authenticated response, not the
        // spoofable UDP label used only to locate the machine.
        const peerName = String(frame.name).trim().slice(0, 80);
        manifest.addPeer(root, frame.deviceId, peerName, 'lan', {
          address: peer.address, port: frame.linkPort, pairCode: code,
        });
        log.step(`Paired with ${peerName}.`);
        if (!flags.wizard) log.info('Run `carry sync` to exchange files.');
        log.done();
        finish(null, frame.deviceId);
      }).then((connected) => {
        socket = connected;
        socket.on('error', (err) => finish(err));
        socket.on('close', () => {
          if (!finished) finish(new Error('LAN peer disconnected before pairing completed'));
        });
        // Initiator sends the first handshake frame; the advertiser answers.
        transport.sendEncrypted(socket, { type: 'hello', deviceId: m.deviceId, name: m.name, linkPort: localLinkPort }, code, frameCrypto.newSalt());
      }).catch((error) => finish(error));
    });
  } else {
    // We are the first machine: advertise a code and act as the TCP server.
    const code = transport.newLanSecret();
    log.title('Carry pair');
    log.step('Your pairing code: ' + code);
    if (flags.wizard) log.info('On the other machine choose Receive in `carry setup`, then enter this code.');
    else log.info('On the other machine run:  carry pair ' + code);
    log.info('Listening on the LAN for 2 minutes…');
    return new Promise((resolve, reject) => {
      let finished = false;
      const adv = transport.advertise(code, m, undefined, localLinkPort);
      let server = null;
      let timeout = null;
      const fail = (err) => {
        if (finished) return;
        finished = true;
        if (timeout) clearTimeout(timeout);
        adv.stop();
        if (server) { try { server.close(); } catch { /* ignore */ } }
        reject(err);
      };
      timeout = setTimeout(() => fail(new Error('pairing timed out — no peer joined within 2 minutes')), 120000);
      server = transport.serveEncrypted(localLinkPort, code, (frame, respond, remoteAddr) => {
        if (frame.type !== 'hello' || finished) return;
        if (!/^[A-Za-z0-9_-]{6,128}$/.test(String(frame.deviceId || '')) ||
            !String(frame.name || '').trim() || /[\r\n\0]/.test(String(frame.name)) ||
            !Number.isInteger(frame.linkPort) || frame.linkPort < 1 || frame.linkPort > 65535) {
          fail(new Error('LAN peer sent an invalid encrypted identity'));
          return;
        }
        // The discoverer initiates with 'hello'; we answer with 'hello-ack' and
        // capture its real LAN IP so this advertiser can later initiate sync.
        const addr = (remoteAddr || '').replace(/^::ffff:/, '');
        const peerName = String(frame.name).trim().slice(0, 80);
        manifest.addPeer(root, frame.deviceId, peerName, 'lan', { address: addr || null, port: frame.linkPort, pairCode: code });
        respond({ type: 'hello-ack', deviceId: m.deviceId, name: m.name, linkPort: localLinkPort });
        log.step(`Paired with ${peerName} (${frame.deviceId.slice(0, 6)})${addr ? ' @ ' + addr : ''}.`);
        if (!flags.wizard) log.info('Run `carry sync` to exchange files.');
        log.done();
        adv.stop();
        clearTimeout(timeout);
        server.close((err) => {
          if (finished) return;
          if (err) return fail(err);
          finished = true;
          resolve(frame.deviceId);
        });
      });
      server.on('error', fail);
    });
  }
}

// Mutual sync: both machines run a server (to receive the peer's bundle) and
// connect to the peer (to send their own). Each side applies the other's
// incoming bundle — pulling files and union-merging memory. Because both sides
// merge, the result is convergent: after one `carry sync` on each machine (or a
// single run if one side initiates and the other answers), both stores match.
//
// Transport: try a direct LAN TCP connect first; if that fails (different
// networks / NAT), fall back to the relay if one was configured via `carry pair
// --relay host:port` or `carry sync --relay host:port`.

// Shared frame handler for the receive side — applied identically over direct
// TCP or over the relay.
function makeSyncReceiver(root, m, peerId, syncSourceDeviceId, onApplied, onError, planningSnapshot) {
  const partialTransfers = new Map();
  const partialMetadataTransfers = new Map();
  const applyingTransfers = new Map();
  const completedTransfers = new Map();
  const ignoredTransfers = new Set();

  const rememberCompleted = (transferId, response) => {
    if (!transferId) return;
    completedTransfers.set(transferId, response);
    while (completedTransfers.size > 4) completedTransfers.delete(completedTransfers.keys().next().value);
  };

  const progressResponse = (transferId, transfer) => {
    const status = transfer.store ? transfer.store.status() : {
      receivedChunks: 0,
      totalChunks: transfer.expectedChunkCount || 0,
    };
    return {
      type: 'sync-progress',
      from: m.deviceId,
      exchangeId: transferId,
      receivedChunks: status.receivedChunks,
      totalChunks: status.totalChunks,
    };
  };

  const applyingResponse = (transferId) => ({
    type: 'sync-applying',
    from: m.deviceId,
    ...(transferId ? { exchangeId: transferId } : {}),
  });

  const rejectBundleFrame = (frame, respond, err, onComplete) => {
    const transferId = typeof frame.exchangeId === 'string' ? frame.exchangeId : null;
    if (transferId) {
      const partial = partialTransfers.get(transferId);
      if (partial && partial.store) {
        try { partial.store.cleanup(); } catch { /* retain the original transfer error */ }
      }
      partialTransfers.delete(transferId);
      partialMetadataTransfers.delete(transferId);
      applyingTransfers.delete(transferId);
      ignoredTransfers.delete(transferId);
    }
    const response = {
      type: 'sync-error',
      from: m.deviceId,
      ...(transferId ? { exchangeId: transferId } : {}),
      message: err.message,
    };
    rememberCompleted(transferId, response);
    let responseError = null;
    try { respond(response); }
    catch (error) { responseError = error; }
    const finalError = responseError || err;
    if (onError) onError(finalError);
    if (typeof onComplete === 'function') onComplete(finalError);
    return false;
  };

  const applyBundleFrame = (frame, respond, onComplete) => {
    if (typeof onComplete !== 'function') onComplete = null;
    const transferId = typeof frame.exchangeId === 'string' ? frame.exchangeId : null;
    if (transferId && completedTransfers.has(transferId)) {
      respond(completedTransfers.get(transferId));
      return true;
    }
    if (transferId && applyingTransfers.has(transferId)) {
      respond(applyingTransfers.get(transferId));
      return false;
    }
    const apply = () => {
      try {
        const result = applyIncoming(
          root, m, peerId, frame.bundle, syncSourceDeviceId, frame.staged, frame.preparedPlan,
        );
        if (frame.transferStore) Object.defineProperty(result, 'incomingTransferStore', {
          value: frame.transferStore,
          enumerable: false,
        });
        const response = {
          type: 'sync-ack',
          from: m.deviceId,
          ...(transferId ? { exchangeId: transferId } : {}),
          summary: result.summary,
          conflicts: result.conflicts,
        };
        if (transferId) applyingTransfers.delete(transferId);
        rememberCompleted(transferId, response);
        if (onApplied) onApplied(result);
        try { respond(response); }
        catch (error) {
          if (onComplete) onComplete(error, result);
          return false;
        }
        if (onComplete) onComplete(null, result);
        return true;
      } catch (err) {
        return rejectBundleFrame(frame, respond, err, onComplete);
      }
    };
    if (planningSnapshot && typeof planningSnapshot.onApplying === 'function') {
      planningSnapshot.onApplying(frame.transferStore ? frame.transferStore.expectedBytes : 0);
    }
    if (!onComplete) return apply();

    // Let the encrypted "applying" phase leave this process before the
    // checkpoint/hash/file work temporarily occupies the Node event loop.
    // The sender can then use a finalization timeout instead of mistaking a
    // slow but healthy apply for a disconnected peer.
    const response = applyingResponse(transferId);
    if (transferId) applyingTransfers.set(transferId, response);
    respond(response);
    log.info('Verifying, checkpointing, and applying the peer update...');
    setImmediate(apply);
    return false;
  };

  const handleFrame = (frame, respond, onComplete) => {
    try {
      if (planningSnapshot && typeof planningSnapshot.onActivity === 'function') {
        planningSnapshot.onActivity();
      }
      if (frame.type === 'sync-bundle') {
        if (frame.from !== peerId) throw new Error('sync bundle came from an unpaired device');
        if (planningSnapshot && typeof planningSnapshot.onSelectionReady === 'function') {
          planningSnapshot.onSelectionReady();
        }
        return applyBundleFrame(frame, respond, onComplete);
      }
      if (frame.type === 'sync-bundle-metadata-start') {
        if (frame.from !== peerId) throw new Error('sync metadata came from an unpaired device');
        const transferId = String(frame.exchangeId || '');
        if (!/^[a-f0-9]{24}$/i.test(transferId)) throw new Error('peer sent an invalid transfer id');
        if (completedTransfers.has(transferId)) {
          respond(completedTransfers.get(transferId));
          ignoredTransfers.add(transferId);
          return false;
        }
        if (applyingTransfers.has(transferId)) {
          respond(applyingTransfers.get(transferId));
          ignoredTransfers.add(transferId);
          return false;
        }
        const metadataBytes = Number(frame.metadataBytes);
        const metadataChunks = Number(frame.metadataChunks);
        const metadataHash = String(frame.metadataHash || '').toLowerCase();
        if (!Number.isInteger(metadataBytes) || metadataBytes < 1 || metadataBytes > MAX_BUNDLE_METADATA_BYTES ||
            !Number.isInteger(metadataChunks) || metadataChunks < 1 || metadataChunks > MAX_BUNDLE_METADATA_CHUNKS ||
            !/^[a-f0-9]{64}$/.test(metadataHash)) {
          throw new Error('peer sent invalid bundle metadata limits');
        }
        if (partialMetadataTransfers.size || partialTransfers.size || partialMetadataTransfers.has(transferId)) {
          throw new Error('peer started overlapping bundle metadata transfers');
        }
        partialMetadataTransfers.set(transferId, {
          from: frame.from,
          expectedBytes: metadataBytes,
          expectedChunks: metadataChunks,
          expectedHash: metadataHash,
          bytes: 0,
          chunks: [],
        });
        return false;
      }
      if (frame.type === 'sync-bundle-metadata-chunk') {
        const transferId = String(frame.exchangeId || '');
        if (ignoredTransfers.has(transferId)) return false;
        const transfer = partialMetadataTransfers.get(transferId);
        if (!transfer || frame.from !== peerId) throw new Error('peer sent metadata for an unknown transfer');
        const index = Number(frame.index);
        if (!Number.isInteger(index) || index !== transfer.chunks.length || index >= transfer.expectedChunks) {
          throw new Error('peer sent an invalid or out-of-order bundle metadata chunk');
        }
        const bytes = canonicalMetadataChunk(frame.data);
        if (bytes.length > RELAY_CHUNK_RAW_BYTES || transfer.bytes + bytes.length > transfer.expectedBytes) {
          throw new Error('peer bundle metadata exceeded its declared size');
        }
        transfer.chunks.push(Buffer.from(bytes));
        transfer.bytes += bytes.length;
        return false;
      }
      if (frame.type === 'sync-bundle-metadata-end') {
        const transferId = String(frame.exchangeId || '');
        if (ignoredTransfers.delete(transferId)) return false;
        const transfer = partialMetadataTransfers.get(transferId);
        if (!transfer || frame.from !== peerId) throw new Error('peer ended an unknown bundle metadata transfer');
        if (transfer.chunks.length !== transfer.expectedChunks || transfer.bytes !== transfer.expectedBytes) {
          throw new Error('peer bundle metadata transfer was incomplete');
        }
        const bytes = Buffer.concat(transfer.chunks, transfer.bytes);
        if (bundleMetadataHash(bytes) !== transfer.expectedHash) {
          throw new Error('peer bundle metadata failed integrity verification');
        }
        partialMetadataTransfers.delete(transferId);
        let startFrame;
        try { startFrame = JSON.parse(bytes.toString('utf8')); }
        catch { throw new Error('peer bundle metadata is not valid JSON'); }
        if (!startFrame || typeof startFrame !== 'object' || Array.isArray(startFrame) ||
            startFrame.type !== 'sync-bundle-start' || startFrame.from !== peerId ||
            startFrame.exchangeId !== transferId) {
          throw new Error('peer bundle metadata identity is invalid');
        }
        return handleFrame(startFrame, respond, onComplete);
      }
      if (frame.type === 'sync-bundle-start') {
        if (frame.from !== peerId) throw new Error('sync bundle came from an unpaired device');
        const transferId = String(frame.exchangeId || '');
        if (!/^[a-f0-9]{24}$/i.test(transferId)) throw new Error('peer sent an invalid transfer id');
        if (completedTransfers.has(transferId)) {
          respond(completedTransfers.get(transferId));
          ignoredTransfers.add(transferId);
          return true;
        }
        if (applyingTransfers.has(transferId)) {
          respond(applyingTransfers.get(transferId));
          ignoredTransfers.add(transferId);
          return false;
        }
        if (!frame.bundle || typeof frame.bundle !== 'object' || Array.isArray(frame.bundle)) {
          throw new Error('peer sent invalid bundle metadata');
        }
        const dataPaths = Array.isArray(frame.dataPaths) ? frame.dataPaths.map(String) : [];
        const metadata = { ...frame.bundle, data: Object.create(null) };
        const validated = syncEngine.validateBundle(metadata);
        const known = new Set(validated.files);
        const effectiveSource = syncSourceDeviceId || validated.syncSourceDeviceId;
        if (validated.metadataOnly && effectiveSource !== m.deviceId) {
          throw new Error('the selected source device omitted file content');
        }
        const expectedDataPaths = validated.files.filter((rel) =>
          !validated.paused.has(rel) && (!validated.metadataOnly || rel === syncEngine.MEMORY_PATH));
        const uniqueDataPaths = new Set();
        for (const rel of dataPaths) {
          syncEngine.safeRelativePath(rel);
          if (!known.has(rel) || uniqueDataPaths.has(rel)) throw new Error('peer sent invalid bundle data paths');
          uniqueDataPaths.add(rel);
        }
        if (uniqueDataPaths.size !== expectedDataPaths.length ||
            expectedDataPaths.some((rel) => !uniqueDataPaths.has(rel))) {
          throw new Error('peer bundle metadata omitted file data');
        }
        if (partialTransfers.size && !partialTransfers.has(transferId)) {
          throw new Error('peer started overlapping bundle transfers');
        }
        if (validated.capabilities.includes('incremental-data-selection-v1')) {
          const preparedPlan = syncEngine.planIncoming(root, peerId, metadata, m.deviceId, planningSnapshot);
          const required = syncEngine.requiredIncomingDataPaths(preparedPlan);
          for (const rel of required) {
            if (!uniqueDataPaths.has(rel)) throw new Error('peer did not offer required file data');
          }
          const requestedPaths = dataPaths.filter((rel) => required.has(rel));
          partialTransfers.set(transferId, {
            from: frame.from,
            bundle: metadata,
            offeredPaths: dataPaths,
            requestedPaths,
            requestedPathSet: new Set(requestedPaths),
            preparedPlan,
            store: null,
            expectedChars: 0,
            expectedBytes: 0,
            expectedChunkCount: 0,
            lastProgress: 0,
          });
          respond({
            type: 'sync-bundle-request',
            from: m.deviceId,
            exchangeId: transferId,
            ranges: selectionRanges(dataPaths, required),
          });
          return false;
        }
        const expectedChunkCount = Number(frame.chunkCount);
        const expectedChars = Number(frame.chars);
        if (!Number.isInteger(expectedChunkCount) || expectedChunkCount < dataPaths.length ||
            expectedChunkCount > MAX_RELAY_BUNDLE_CHUNKS || !Number.isInteger(expectedChars) ||
            expectedChars < 0 || expectedChars > LEGACY_RELAY_BUNDLE_CHARS) {
          throw new Error('peer sent invalid bundle transfer limits');
        }
        const store = new IncomingTransferStore(root, {
          exchangeId: transferId,
          peerId,
          dataPaths,
          textPaths: dataPaths.includes(syncEngine.MEMORY_PATH) ? [syncEngine.MEMORY_PATH] : [],
          expectedChunkCount,
          expectedChars,
          // Binary chunks decode to at most 3/4 of their wire characters. Add
          // the separate 16 MiB text-memory allowance, then cap the whole
          // reservation so abandoned transfers cannot reserve disk forever.
          maxBytes: Math.min(
            LEGACY_RELAY_BUNDLE_CHARS,
            Math.ceil(expectedChars * 3 / 4) + (16 * 1024 * 1024),
          ),
          // Keep restart metadata bounded to roughly 64 writes per transfer.
          // Large projects can have tens of thousands of spool entries, so
          // rewriting that growing index every few chunks is counterproductive.
          persistEvery: Math.min(1024, Math.max(16, Math.ceil(expectedChunkCount / 64))),
        });
        partialTransfers.clear();
        partialTransfers.set(transferId, {
          from: frame.from,
          bundle: metadata,
          dataPaths,
          dataPathSet: uniqueDataPaths,
          store,
          expectedChars,
          expectedChunkCount,
          lastProgress: 0,
        });
        const transfer = partialTransfers.get(transferId);
        if (planningSnapshot && typeof planningSnapshot.onSelectionReady === 'function') {
          planningSnapshot.onSelectionReady();
        }
        log.info(`Receiving the encrypted update in ${transfer.expectedChunkCount} smaller part(s)...`);
        respond(progressResponse(transferId, transfer));
        return false;
      }
      if (frame.type === 'sync-bundle-selection') {
        const transferId = String(frame.exchangeId || '');
        const transfer = partialTransfers.get(transferId);
        if (!transfer || transfer.from !== peerId || transfer.store || !Array.isArray(transfer.requestedPaths)) {
          throw new Error('peer selected data for an unknown bundle transfer');
        }
        if (String(frame.selectionHash || '').toLowerCase() !== dataPathSelectionHash(transfer.requestedPaths)) {
          throw new Error('peer selected different file data than Carry requested');
        }
        const expectedChunkCount = Number(frame.chunkCount);
        const expectedChars = Number(frame.chars);
        const expectedBytes = Number(frame.bytes);
        const fileBytes = Number(frame.fileBytes);
        if (!Number.isInteger(expectedChunkCount) || expectedChunkCount < transfer.requestedPaths.length ||
            expectedChunkCount > MAX_RELAY_BUNDLE_CHUNKS || !Number.isSafeInteger(expectedChars) ||
            expectedChars < 0 || expectedChars > MAX_RELAY_BUNDLE_CHARS ||
            !Number.isSafeInteger(expectedBytes) || expectedBytes < 0 || expectedBytes > MAX_RELAY_BUNDLE_BYTES ||
            !Number.isSafeInteger(fileBytes) || fileBytes < 0 || fileBytes > MAX_TRANSFER_FILE_BYTES ||
            fileBytes > expectedBytes || expectedBytes - fileBytes > MAX_TEXT_BYTES) {
          throw new Error('peer sent invalid selected transfer limits');
        }
        const store = new IncomingTransferStore(root, {
          exchangeId: transferId,
          peerId,
          dataPaths: transfer.requestedPaths,
          textPaths: transfer.requestedPathSet.has(syncEngine.MEMORY_PATH) ? [syncEngine.MEMORY_PATH] : [],
          expectedChunkCount,
          expectedChars,
          expectedBytes,
          maxBytes: expectedBytes,
          // Persist about 32 bounded recovery points. Rewriting a multi-MiB
          // state index for every few chunks causes needless SSD wear.
          persistEvery: Math.min(8192, Math.max(32, Math.ceil(Math.max(1, expectedChunkCount) / 32))),
        });
        transfer.dataPaths = transfer.requestedPaths;
        transfer.dataPathSet = transfer.requestedPathSet;
        transfer.store = store;
        transfer.expectedChars = expectedChars;
        transfer.expectedBytes = expectedBytes;
        transfer.expectedChunkCount = expectedChunkCount;
        log.info(
          `Receiving ${storageHealth.formatBytes(expectedBytes)} in ${expectedChunkCount} encrypted part(s) ` +
          `(${transfer.requestedPaths.length} changed file(s))...`,
        );
        const status = store.status();
        respond({
          type: 'sync-bundle-resume',
          from: m.deviceId,
          exchangeId: transferId,
          receivedChunks: status.receivedChunks,
          nextChunks: transfer.requestedPaths.map((rel) => status.nextIndexes[rel]),
        });
        return false;
      }
      if (frame.type === 'sync-bundle-ready') {
        const transferId = String(frame.exchangeId || '');
        const transfer = partialTransfers.get(transferId);
        if (!transfer || !transfer.store || frame.from !== peerId) {
          throw new Error('peer readied an unknown bundle transfer');
        }
        if (planningSnapshot && typeof planningSnapshot.onSelectionReady === 'function') {
          planningSnapshot.onSelectionReady();
        }
        respond({ type: 'sync-bundle-ready-ack', from: m.deviceId, exchangeId: transferId });
        return false;
      }
      if (frame.type === 'sync-bundle-chunk') {
        const transferId = String(frame.exchangeId || '');
        if (ignoredTransfers.has(transferId)) return false;
        const transfer = partialTransfers.get(transferId);
        if (!transfer || !transfer.store || frame.from !== peerId) throw new Error('peer sent a chunk for an unknown transfer');
        const rel = syncEngine.safeRelativePath(String(frame.path || ''));
        if (!transfer.dataPathSet.has(rel)) throw new Error('peer sent data for an unknown bundle path');
        const index = Number(frame.index);
        const binaryData = Buffer.isBuffer(frame.data);
        if (!Number.isInteger(index) || (!binaryData && typeof frame.data !== 'string') ||
            (binaryData ? frame.data.length > RELAY_CHUNK_RAW_BYTES : frame.data.length > RELAY_CHUNK_CHARS)) {
          throw new Error('peer sent an invalid or out-of-order bundle chunk');
        }
        const status = transfer.store.append(rel, index, frame.data);
        const milestone = Math.min(99, Math.floor((status.receivedChunks / transfer.expectedChunkCount) * 100));
        if (milestone > transfer.lastProgress) {
          transfer.lastProgress = milestone;
          log.info(`Encrypted update received: ${milestone}%`);
        }
        // A WebSocket/TCP connection already guarantees ordered delivery. This
        // tiny encrypted progress response proves that the far end is still
        // consuming the original transfer, without re-queueing the whole file.
        respond(progressResponse(transferId, transfer));
        return false;
      }
      if (frame.type === 'sync-status') {
        if (frame.from !== peerId) throw new Error('sync status came from an unpaired device');
        const transferId = String(frame.exchangeId || '');
        if (!/^[a-f0-9]{24}$/i.test(transferId)) throw new Error('peer sent an invalid transfer id');
        if (completedTransfers.has(transferId)) {
          respond(completedTransfers.get(transferId));
          return false;
        }
        if (applyingTransfers.has(transferId)) {
          respond(applyingTransfers.get(transferId));
          return false;
        }
        const transfer = partialTransfers.get(transferId);
        if (transfer) {
          respond(progressResponse(transferId, transfer));
          return false;
        }
        respond({
          type: 'sync-progress',
          from: m.deviceId,
          exchangeId: transferId,
          receivedChunks: 0,
          totalChunks: 0,
        });
        return false;
      }
      if (frame.type === 'sync-bundle-end') {
        const transferId = String(frame.exchangeId || '');
        if (ignoredTransfers.delete(transferId)) return false;
        const transfer = partialTransfers.get(transferId);
        if (!transfer || frame.from !== peerId) throw new Error('peer ended an unknown bundle transfer');
        const status = transfer.store.status();
        if (frame.chunkCount !== status.receivedChunks || frame.chars !== status.encodedChars ||
            transfer.expectedChunkCount !== status.receivedChunks || transfer.expectedChars !== status.encodedChars) {
          throw new Error('peer bundle transfer was incomplete');
        }
        const staged = transfer.store.finalize(transfer.bundle.hashes);
        partialTransfers.delete(transferId);
        return applyBundleFrame({
          type: 'sync-bundle',
          from: frame.from,
          exchangeId: transferId,
          bundle: transfer.bundle,
          staged: { stagedFiles: staged.files, stagedText: staged.text },
          transferStore: transfer.store,
          preparedPlan: transfer.preparedPlan,
        }, respond, onComplete);
      }
      return false;
    } catch (err) {
      return rejectBundleFrame(frame, respond, err, onComplete);
    }
  };
  handleFrame.cleanupPartialTransfers = () => {
    for (const transfer of partialTransfers.values()) {
      if (transfer && transfer.store) {
        try { transfer.store.cleanup(); } catch { /* best-effort failed-transfer cleanup */ }
      }
    }
    partialTransfers.clear();
    partialMetadataTransfers.clear();
  };
  handleFrame.preservePartialTransfers = () => {
    for (const transfer of partialTransfers.values()) {
      if (transfer && transfer.store) {
        try { transfer.store.checkpoint(); } catch { /* a corrupt partial will be rejected on retry */ }
      }
    }
    partialTransfers.clear();
    partialMetadataTransfers.clear();
  };
  return handleFrame;
}

async function cmdSync(flags) {
  const root = requireProject();
  const m = requireManifest(root);
  const peers = manifest.listPeers(root);
  if (peers.length === 0) throw new Error('no paired peers — run `carry pair` first');
  const peer = flags.peer
    ? peers.find((p) => p.deviceId === flags.peer || p.deviceId.startsWith(flags.peer) || p.name === flags.peer)
    : peers[0];
  if (!peer) throw new Error('paired peer not found: ' + flags.peer);
  if (peer.connectionEnabled === false) {
    throw new Error(`device ${peer.name} is disconnected — reconnect it from Carry's Devices view before syncing`);
  }
  const syncSourceDeviceId = syncEngine.normalizeSyncSourceDeviceId(flags['source-device']);
  if (syncSourceDeviceId && syncSourceDeviceId !== m.deviceId && syncSourceDeviceId !== peer.deviceId) {
    throw new Error('--source-device must identify this device or the selected peer');
  }
  let relayUrl = flags.relay || (peer.transport === 'relay' ? peer.address : null);
  if (relayUrl) {
    if (!relayClient.REMOTE_SECRET_PATTERN.test(String(peer.pairCode || ''))) {
      throw new Error('this remote pairing uses an older weak key; forget it and pair again with a complete invitation');
    }
    if (peer.teamCode && peer.pairCode === relayClient.legacyPairSecretForTeam(peer.teamCode, m.deviceId, peer.deviceId)) {
      throw new Error('this pairing uses an older derivable team key; forget it and pair again with a fresh invitation');
    }
    const configuredRelay = relayClient.parseRelayAddress(relayUrl);
    if (configuredRelay.secret && configuredRelay.secret !== peer.pairCode) {
      throw new Error('the --relay invitation secret does not match this device\'s saved pairing key');
    }
    relayUrl = configuredRelay.address;
  }
  const syncRunId = flags['sync-run'] === undefined ? null : String(flags['sync-run']);
  if (syncRunId && !relayClient.SYNC_RUN_PATTERN.test(syncRunId)) {
    throw new Error('--sync-run must contain exactly 24 hexadecimal characters');
  }
  if (syncRunId && !relayUrl) throw new Error('--sync-run can only be used with a relay sync');
  const directionLabel = syncSourceDeviceId === m.deviceId
    ? 'push to '
    : syncSourceDeviceId === peer.deviceId
      ? 'pull from '
      : 'smart sync with ';
  log.title('Carry ' + directionLabel + peer.name + (relayUrl ? ' (via relay)' : ''));

  const outgoing = buildBundle(root, m.deviceId, peer.deviceId, syncSourceDeviceId);
  const bundle = outgoing.bundle;
  let markPeerSelectionReady;
  const peerSelectionReady = new Promise((resolve) => { markPeerSelectionReady = resolve; });
  let markIncomingApplied;
  let rejectIncoming;
  let preparedIncomingResult = null;
  let incomingTimer = null;
  const clearIncomingTimer = () => {
    if (incomingTimer) clearTimeout(incomingTimer);
    incomingTimer = null;
  };
  const armIncomingTimer = (delay) => {
    if (relayUrl) return;
    clearIncomingTimer();
    incomingTimer = setTimeout(() => {
      rejectIncoming(new Error('LAN sync timed out waiting for the peer to return its encrypted state'));
    }, delay || LAN_SYNC_IDLE_MS);
    incomingTimer.unref?.();
  };
  const incomingApplied = new Promise((resolve, reject) => {
    markIncomingApplied = (result) => {
      clearIncomingTimer();
      preparedIncomingResult = result;
      resolve(result);
    };
    rejectIncoming = (error) => {
      clearIncomingTimer();
      reject(error);
    };
  });
  const receiver = makeSyncReceiver(
    root,
    m,
    peer.deviceId,
    syncSourceDeviceId,
    markIncomingApplied,
    relayUrl ? null : rejectIncoming,
    {
      localHashes: Object.fromEntries(
        Object.entries(bundle.hashes || {}).filter(([rel]) => rel !== syncEngine.MEMORY_PATH),
      ),
      localDirectories: Array.isArray(bundle.directories) ? [...bundle.directories] : [],
      onSelectionReady: markPeerSelectionReady,
      onActivity: () => armIncomingTimer(LAN_SYNC_IDLE_MS),
      onApplying: (bytes) => armIncomingTimer(applyTimeoutForBytes(bytes)),
    },
  );

  // Receive side: in LAN mode a local server handles the peer's bundle when they
  // connect to us directly. In relay mode the relay delivers frames straight to
  // the RelayClient socket, so no local server is opened — opening one would
  // crash (EADDRINUSE) when two `carry sync` processes share a host, and is
  // simply unnecessary across the network.
  let server = null;
  let lanAdvertisement = null;
  const closeServer = () => { if (server) { try { server.close(); } catch { /* ignore */ } } };
  const code = peer.pairCode;
  if (!relayUrl && !/^[A-F0-9]{32}$/i.test(String(code))) {
    throw new Error('this LAN pairing uses an older short key; disconnect and pair the devices again before syncing securely');
  }
  const localLinkPort = getLinkPort(flags);

  if (!relayUrl) {
    armIncomingTimer(LAN_SYNC_IDLE_MS);
    server = transport.serveEncrypted(localLinkPort, code, (frame, respond, _remoteAddress, onComplete) =>
      receiver(frame, respond, onComplete));
    lanAdvertisement = transport.advertise(code, m, 120000, localLinkPort);
  }

  try {
    let incomingResult;
    if (relayUrl) {
      const experimentalDirect = flags.direct === true || process.env.CARRY_EXPERIMENTAL_P2P === '1';
      [, incomingResult] = await Promise.all([
        syncOverRelay(relayUrl, peer, m, bundle, outgoing.fileSources, receiver, {
          experimentalDirect,
          syncRunId,
          snapshotSelected: outgoing.snapshotSelected,
          peerSelectionReady,
        }),
        incomingApplied,
      ]);
    } else {
      // A LAN sync is complete only after our bundle is acknowledged and the
      // peer's bundle has arrived. Keeping the receive server alive until both
      // happen prevents the faster process from exiting under its peer.
      [, incomingResult] = await Promise.all([
        syncOverLan(
          root, peer, m, bundle, outgoing.fileSources, receiver, code,
          outgoing.snapshotSelected, peerSelectionReady,
        ),
        incomingApplied,
      ]);
    }
    // Advance the common baseline only after both sides acknowledge the whole
    // exchange. A dropped connection cannot bless a partial sync as complete.
    syncEngine.commit(root, incomingResult);
    if (incomingResult.incomingTransferStore) {
      try { incomingResult.incomingTransferStore.cleanup(); }
      catch (cleanupError) {
        log.warn('Sync completed, but Carry could not remove its temporary transfer files: ' + cleanupError.message);
      }
    }
    manifest.touchPeer(root, peer.deviceId);
    log.step('Saved the last successful sync baseline.');
    log.step('Sync complete on both devices.');
    log.done();
  } catch (error) {
    if (preparedIncomingResult) {
      syncEngine.fail(root, preparedIncomingResult, error);
      if (preparedIncomingResult.incomingTransferStore) {
        try { preparedIncomingResult.incomingTransferStore.cleanup(); } catch { /* preserve original sync failure */ }
      }
    } else {
      // Keep authenticated partial bytes for a retry of the same unchanged
      // manifest. A content-derived exchange id prevents unrelated updates
      // from reusing them, and stale stores still expire after 24 hours.
      receiver.preservePartialTransfers?.();
    }
    throw error;
  } finally {
    clearIncomingTimer();
    if (lanAdvertisement) lanAdvertisement.stop();
    closeServer();
    if (outgoing.cleanup) {
      try { outgoing.cleanup(); }
      catch (cleanupError) { log.warn('Carry could not remove its temporary outgoing snapshot: ' + cleanupError.message); }
    }
  }
}

async function syncOverLan(root, peer, m, bundle, fileSources, receiver, code, snapshotSelected, peerSelectionReady) {
  let address = peer.address || '127.0.0.1';
  let peerPort = peer.port || DEFAULT_LINK_PORT;
  return new Promise((resolve, reject) => {
    let socket = null;
    let settled = false;
    let waitingLogged = false;
    let idleTimer = null;
    let outgoingExchangeId = null;
    let endpointRefreshStarted = false;
    let resolveSelection;
    let rejectSelection;
    const selection = new Promise((resolve, reject) => { resolveSelection = resolve; rejectSelection = reject; });
    let resolveResume;
    let rejectResume;
    const resume = new Promise((resolve, reject) => { resolveResume = resolve; rejectResume = reject; });
    let resolveReadyAck;
    let rejectReadyAck;
    const readyAck = new Promise((resolve, reject) => { resolveReadyAck = resolve; rejectReadyAck = reject; });
    selection.catch(() => {});
    resume.catch(() => {});
    readyAck.catch(() => {});
    const deadline = Date.now() + 20000;

    const clearIdle = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = null;
    };
    const failTransfer = (err) => {
      if (settled) return;
      settled = true;
      clearIdle();
      rejectSelection(err);
      rejectResume(err);
      rejectReadyAck(err);
      if (socket) { try { socket.destroy(); } catch { /* ignore */ } }
      reject(err);
    };
    const resetIdle = () => {
      if (settled) return;
      clearIdle();
      idleTimer = setTimeout(() => failTransfer(new Error('LAN sync timed out after five minutes without transfer progress')), LAN_SYNC_IDLE_MS);
      idleTimer.unref?.();
    };

    const retryOrFail = (err) => {
      if (settled) return;
      if (socket) { try { socket.destroy(); } catch { /* ignore */ } }
      socket = null;
      if (!endpointRefreshStarted && Date.now() < deadline) {
        endpointRefreshStarted = true;
        transport.discover(code, Math.min(5000, Math.max(1000, deadline - Date.now())), peer.deviceId)
          .then((discovered) => {
            if (settled) return;
            address = discovered.address;
            peerPort = discovered.port || DEFAULT_LINK_PORT;
            manifest.updateLanEndpoint(root, peer.deviceId, address, peerPort);
            log.info(`Found ${peer.name} at its new LAN address ${address}:${peerPort}.`);
            connect();
          })
          .catch(() => {
            if (settled) return;
            if (Date.now() < deadline) setTimeout(connect, 500);
            else {
              settled = true;
              clearIdle();
              reject(err);
            }
          });
        return;
      }
      if (Date.now() < deadline) {
        if (!waitingLogged) {
          waitingLogged = true;
          log.info('Waiting for the other machine to start Carry…');
        }
        setTimeout(connect, 500);
        return;
      }
      settled = true;
      clearIdle();
      log.warn('Direct LAN connect to ' + address + ':' + peerPort + ' failed — ' + err.message);
      reject(err);
    };

    const connect = () => {
      transport.connectEncrypted(address, peerPort, code, (frame, respond) => {
        resetIdle();
        if (frame.type === 'sync-bundle-request') {
          if (frame.from !== peer.deviceId || !outgoingExchangeId || frame.exchangeId !== outgoingExchangeId) {
            failTransfer(new Error('peer sent an invalid incremental data request'));
            return;
          }
          resolveSelection(frame);
          return;
        }
        if (frame.type === 'sync-bundle-resume') {
          if (frame.from !== peer.deviceId || !outgoingExchangeId || frame.exchangeId !== outgoingExchangeId) {
            failTransfer(new Error('peer sent invalid resumable transfer state'));
            return;
          }
          resolveResume(frame);
          return;
        }
        if (frame.type === 'sync-bundle-ready-ack') {
          if (frame.from !== peer.deviceId || !outgoingExchangeId || frame.exchangeId !== outgoingExchangeId) {
            failTransfer(new Error('peer acknowledged an invalid resumable transfer'));
            return;
          }
          resolveReadyAck(frame);
          return;
        }
        if (frame.type === 'sync-ack') {
          if (settled) return;
          if (frame.from !== peer.deviceId) {
            settled = true;
            clearIdle();
            if (socket) { try { socket.end(); } catch { /* ignore */ } }
            reject(new Error('sync acknowledgement came from an unpaired device'));
            return;
          }
          settled = true;
          clearIdle();
          log.step('Peer applied our bundle.');
          log.done();
          if (socket) { try { socket.end(); } catch { /* ignore */ } }
          resolve();
          return;
        }
        if (frame.type === 'sync-error') {
          if (settled) return;
          if (frame.from !== peer.deviceId) return;
          settled = true;
          clearIdle();
          if (socket) { try { socket.end(); } catch { /* ignore */ } }
          reject(new Error('peer rejected sync: ' + (frame.message || 'unknown error')));
          return;
        }
        if (frame.type === 'sync-progress' && frame.from === peer.deviceId) return;
        receiver(frame, respond);
      }, 2500).then((connected) => {
        if (settled) { connected.destroy(); return; }
        socket = connected;
        socket.once('error', failTransfer);
        socket.once('close', () => {
          if (!settled) failTransfer(new Error('peer disconnected during LAN sync'));
        });
        resetIdle();
        sendBundleOverLan(socket, code, m.deviceId, bundle, fileSources, resetIdle, {
          waitForSelection: (exchangeId) => {
            outgoingExchangeId = exchangeId;
            return selection;
          },
          waitForPeerSelectionReady: () => peerSelectionReady,
          waitForResume: () => resume,
          waitForReadyAck: () => readyAck,
          snapshotSelected,
        }).catch(failTransfer);
      }).catch(retryOrFail);
    };

    connect();
  });
}

function relayBundleMetadata(bundle) {
  const metadata = { ...bundle };
  delete metadata.data;
  return metadata;
}

function selectionRanges(dataPaths, selectedPaths) {
  const selected = selectedPaths instanceof Set ? selectedPaths : new Set(selectedPaths || []);
  const ranges = [];
  let start = -1;
  let count = 0;
  for (let index = 0; index < dataPaths.length; index++) {
    if (selected.has(dataPaths[index])) {
      if (start < 0) start = index;
      count += 1;
    } else if (start >= 0) {
      ranges.push(start, count);
      start = -1;
      count = 0;
    }
  }
  if (start >= 0) ranges.push(start, count);
  return ranges;
}

function selectedPathsFromRanges(dataPaths, ranges) {
  if (!Array.isArray(ranges) || ranges.length % 2 !== 0 || ranges.length > dataPaths.length * 2) {
    throw new Error('peer sent an invalid incremental file selection');
  }
  const selected = [];
  let previousEnd = 0;
  for (let index = 0; index < ranges.length; index += 2) {
    const start = Number(ranges[index]);
    const count = Number(ranges[index + 1]);
    if (!Number.isInteger(start) || !Number.isInteger(count) || start < previousEnd || count < 1 ||
        start + count > dataPaths.length) {
      throw new Error('peer sent an invalid incremental file selection');
    }
    for (let item = start; item < start + count; item++) selected.push(dataPaths[item]);
    previousEnd = start + count;
  }
  return selected;
}

function dataPathSelectionHash(dataPaths) {
  const hash = nodeCrypto.createHash('sha256');
  for (const rel of dataPaths) hash.update(rel, 'utf8').update('\0');
  return hash.digest('hex');
}

function transferExchangeId(from, bundle) {
  return nodeCrypto.createHash('sha256')
    .update('carry-resumable-transfer-v1\0', 'utf8')
    .update(String(from), 'utf8')
    .update('\0', 'utf8')
    .update(JSON.stringify(relayBundleMetadata(bundle)), 'utf8')
    .digest('hex')
    .slice(0, 24);
}

function applyTimeoutForBytes(bytes) {
  const extra = Math.ceil(Math.max(0, Number(bytes) || 0) / (5 * 1024 * 1024)) * 1000;
  return Math.min(RELAY_SYNC_APPLY_MAX_MS, RELAY_SYNC_APPLY_MS + extra);
}

function bundleMetadataHash(bytes) {
  return nodeCrypto.createHash('sha256').update(bytes).digest('hex');
}

function canonicalMetadataChunk(value) {
  if (Buffer.isBuffer(value)) return value;
  if (typeof value !== 'string' || value.length % 4 !== 0 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error('peer sent an invalid bundle metadata chunk');
  }
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value) throw new Error('peer sent an invalid bundle metadata chunk');
  return bytes;
}

async function sendBundleStartMetadata(startFrame, options) {
  const bytes = Buffer.from(JSON.stringify(startFrame), 'utf8');
  if (bytes.length <= options.singleFrameBytes) {
    await options.write(startFrame, null);
    return 0;
  }
  if (bytes.length > MAX_BUNDLE_METADATA_BYTES) {
    throw new Error('project manifest is too large for one Carry sync');
  }
  const chunkBytes = options.chunkBytes;
  const chunkCount = Math.ceil(bytes.length / chunkBytes);
  if (!Number.isInteger(chunkCount) || chunkCount < 1 || chunkCount > MAX_BUNDLE_METADATA_CHUNKS) {
    throw new Error('project manifest needs too many transfer chunks');
  }
  const common = { from: startFrame.from, exchangeId: startFrame.exchangeId };
  await options.write({
    type: 'sync-bundle-metadata-start',
    ...common,
    capabilities: Array.isArray(startFrame.bundle && startFrame.bundle.capabilities)
      ? startFrame.bundle.capabilities
      : [],
    metadataBytes: bytes.length,
    metadataChunks: chunkCount,
    metadataHash: bundleMetadataHash(bytes),
  }, null);
  for (let index = 0; index < chunkCount; index++) {
    const payload = bytes.subarray(index * chunkBytes, Math.min(bytes.length, (index + 1) * chunkBytes));
    await options.write({ type: 'sync-bundle-metadata-chunk', ...common, index }, payload);
  }
  await options.write({ type: 'sync-bundle-metadata-end', ...common }, null);
  return chunkCount;
}

function waitForLanDrain(socket, onProgress) {
  if (!socket || socket.destroyed || !socket.writable) return Promise.reject(new Error('LAN connection closed during transfer'));
  return new Promise((resolve, reject) => {
    let timer = null;
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      socket.off('drain', onDrain);
      socket.off('error', onError);
      socket.off('close', onClose);
    };
    const finish = (err) => {
      cleanup();
      if (err) reject(err);
      else {
        if (onProgress) onProgress();
        resolve();
      }
    };
    const onDrain = () => finish();
    const onError = (err) => finish(err);
    const onClose = () => finish(new Error('peer disconnected during LAN transfer'));
    socket.once('drain', onDrain);
    socket.once('error', onError);
    socket.once('close', onClose);
    timer = setTimeout(() => finish(new Error('LAN connection stopped accepting encrypted data')), 60000);
    timer.unref?.();
  });
}

function encodedBase64Chars(bytes) {
  return Math.ceil(bytes / 3) * 4;
}

function validateOutgoingSource(rel, source, expectedHash) {
  syncEngine.safeRelativePath(rel);
  if (!source || typeof source !== 'object' || typeof source.file !== 'string' ||
      !Number.isSafeInteger(source.size) || source.size < 0 || !Number.isFinite(source.mtimeMs) ||
      typeof source.hash !== 'string' || source.hash !== expectedHash) {
    throw new Error('outgoing file source is invalid for ' + rel);
  }
  const stat = fs.lstatSync(source.file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== source.size || stat.mtimeMs !== source.mtimeMs ||
      stat.dev !== source.dev || stat.ino !== source.ino) {
    throw new Error('local file changed before Carry could send it: ' + rel);
  }
  return stat;
}

function bundleTransferPlan(bundle, fileSources, chunkChars, textChunkChars, selectedPaths) {
  fileSources = fileSources instanceof Map ? fileSources : new Map();
  const selected = selectedPaths instanceof Set ? selectedPaths : selectedPaths ? new Set(selectedPaths) : null;
  const data = bundle.data || {};
  const items = [];
  let chars = 0;
  let chunkCount = 0;
  let storedBytes = 0;
  let fileBytes = 0;
  for (const rel of bundle.files || []) {
    if (selected && !selected.has(rel)) continue;
    if (fileSources.has(rel)) {
      const source = fileSources.get(rel);
      validateOutgoingSource(rel, source, bundle.hashes && bundle.hashes[rel]);
      const encodedChars = encodedBase64Chars(source.size);
      const rawChunkBytes = (chunkChars / 4) * 3;
      const chunks = Math.max(1, Math.ceil(source.size / rawChunkBytes));
      items.push({ kind: 'file', rel, source, chunks, encodedChars, rawChunkBytes });
      chars += encodedChars;
      chunkCount += chunks;
      storedBytes += source.size;
      fileBytes += source.size;
      continue;
    }
    if (!Object.prototype.hasOwnProperty.call(data, rel) || typeof data[rel] !== 'string') continue;
    const value = data[rel];
    const size = rel === syncEngine.MEMORY_PATH ? textChunkChars : chunkChars;
    const chunks = Math.max(1, Math.ceil(value.length / size));
    items.push({ kind: rel === syncEngine.MEMORY_PATH ? 'text' : 'base64', rel, value, chunks, chunkChars: size });
    chars += value.length;
    chunkCount += chunks;
    if (rel === syncEngine.MEMORY_PATH) storedBytes += Buffer.byteLength(value, 'utf16le');
    else {
      const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
      storedBytes += (value.length / 4) * 3 - padding;
      fileBytes += (value.length / 4) * 3 - padding;
    }
  }
  return { items, dataPaths: items.map((item) => item.rel), chars, chunkCount, storedBytes, fileBytes };
}

async function streamOutgoingFile(item, writeChunk, startIndex) {
  startIndex = Number.isInteger(startIndex) && startIndex >= 0 ? startIndex : 0;
  validateOutgoingSource(item.rel, item.source, item.source.hash);
  const handle = fs.openSync(item.source.file, 'r');
  const hash = nodeCrypto.createHash('sha256');
  let offset = 0;
  let index = 0;
  try {
    do {
      const wanted = Math.min(item.rawChunkBytes, item.source.size - offset);
      const bytes = wanted > 0 ? Buffer.allocUnsafe(wanted) : Buffer.alloc(0);
      if (wanted > 0) {
        const read = fs.readSync(handle, bytes, 0, wanted, offset);
        if (read !== wanted) throw new Error('local file changed while Carry was sending it: ' + item.rel);
        hash.update(bytes);
      }
      if (index >= startIndex) await writeChunk(index, bytes);
      offset += wanted;
      index += 1;
    } while (offset < item.source.size);
    const afterHandle = fs.fstatSync(handle);
    const afterPath = fs.lstatSync(item.source.file);
    if (!afterPath.isFile() || afterPath.isSymbolicLink() || afterHandle.size !== item.source.size ||
        afterHandle.mtimeMs !== item.source.mtimeMs || afterPath.size !== item.source.size ||
        afterPath.mtimeMs !== item.source.mtimeMs || afterPath.dev !== item.source.dev || afterPath.ino !== item.source.ino ||
        hash.digest('hex') !== item.source.hash) {
      throw new Error('local file changed while Carry was sending it: ' + item.rel);
    }
  } finally {
    fs.closeSync(handle);
  }
}

async function sendBundleOverLan(socket, code, from, bundle, fileSources, onProgress, options) {
  options = options || {};
  const exchangeId = transferExchangeId(from, bundle);
  const salt = frameCrypto.newSalt();
  const channel = {
    peerSupportsBinary: false,
    pendingBytes() { return socket && socket.writableLength || 0; },
    async send(frame) {
      if (!transport.sendEncrypted(socket, frame, code, salt)) await waitForLanDrain(socket, onProgress);
    },
  };
  await sendBundleOverChannel(channel, from, bundle, exchangeId, onProgress, {
    fileSources,
    supportsBinary: false,
    announceChunks: true,
    waitForSelection: options.waitForSelection,
    waitForPeerSelectionReady: options.waitForPeerSelectionReady,
    snapshotSelected: options.snapshotSelected,
    sentProgressLabel: 'Encrypted LAN update sent',
  });
}

async function waitForChannelDrain(channel, onProgress, highWater) {
  highWater = highWater || RELAY_BUFFER_HIGH_WATER;
  const deadline = Date.now() + 30000;
  while (channel.pendingBytes() > highWater) {
    if (Date.now() >= deadline) throw new Error('encrypted transfer channel stalled while sending data');
    if (onProgress) onProgress();
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function sendBundleOverChannel(channel, from, bundle, exchangeId, onProgress, options) {
  options = options || {};
  const singleFrameBytes = options.singleFrameBytes || RELAY_SINGLE_FRAME_BYTES;
  const chunkChars = options.chunkChars || RELAY_CHUNK_CHARS;
  const textChunkChars = options.textChunkChars || chunkChars;
  const supportsBinary = options.supportsBinary === undefined
    ? Boolean(channel.peerSupportsBinary)
    : options.supportsBinary;
  const fileSources = options.fileSources instanceof Map ? options.fileSources : new Map();
  const waitForPeerWindow = options.waitForPeerWindow;
  const legacy = { type: 'sync-bundle', from, exchangeId, bundle };
  if (fileSources.size === 0 && Buffer.byteLength(JSON.stringify(legacy), 'utf8') <= singleFrameBytes) {
    await Promise.resolve(channel.send(legacy));
    if (onProgress) onProgress();
    return;
  }

  const writeFrame = async (frame, payload) => {
    if (payload && supportsBinary) await Promise.resolve(channel.sendBinary(frame, payload));
    else await Promise.resolve(channel.send(payload ? { ...frame, data: payload.toString('base64') } : frame));
    if (onProgress) onProgress();
    await waitForChannelDrain(channel, onProgress, options.highWaterBytes);
  };
  const incremental = Array.isArray(bundle.capabilities) &&
    bundle.capabilities.includes('incremental-data-selection-v1') &&
    typeof options.waitForSelection === 'function';
  let plan;
  let resumeIndexes = [];
  let metadataChunks;
  if (incremental) {
    const offeredPlan = bundleTransferPlan(bundle, fileSources, chunkChars, textChunkChars);
    metadataChunks = await sendBundleStartMetadata({
      type: 'sync-bundle-start',
      from,
      exchangeId,
      bundle: relayBundleMetadata(bundle),
      dataPaths: offeredPlan.dataPaths,
    }, {
      singleFrameBytes,
      chunkBytes: (chunkChars / 4) * 3,
      write: writeFrame,
    });
    if (metadataChunks && options.announceChunks) {
      log.info(`Sent the project manifest in ${metadataChunks} bounded part(s).`);
    }
    const request = await options.waitForSelection(exchangeId, offeredPlan.dataPaths);
    const selectedPaths = selectedPathsFromRanges(offeredPlan.dataPaths, request && request.ranges);
    const selected = new Set(selectedPaths);
    plan = bundleTransferPlan(bundle, fileSources, chunkChars, textChunkChars, selected);
    if (plan.dataPaths.length !== selectedPaths.length ||
        plan.dataPaths.some((rel, index) => rel !== selectedPaths[index])) {
      throw new Error('peer requested file data that is unavailable from the stable outgoing snapshot');
    }
    if (plan.fileBytes > MAX_TRANSFER_FILE_BYTES || plan.storedBytes > MAX_RELAY_BUNDLE_BYTES ||
        plan.chars > MAX_RELAY_BUNDLE_CHARS || plan.chunkCount > MAX_RELAY_BUNDLE_CHUNKS) {
      throw new Error('selected changes exceed Carry\'s 5 GiB one-exchange limit; sync fewer changes at once');
    }
    await writeFrame({
      type: 'sync-bundle-selection',
      from,
      exchangeId,
      selectionHash: dataPathSelectionHash(selectedPaths),
      chunkCount: plan.chunkCount,
      chars: plan.chars,
      bytes: plan.storedBytes,
      fileBytes: plan.fileBytes,
    }, null);
    const resume = typeof options.waitForResume === 'function'
      ? await options.waitForResume()
      : { receivedChunks: 0, nextChunks: plan.items.map(() => 0) };
    if (!resume || !Array.isArray(resume.nextChunks) || resume.nextChunks.length !== plan.items.length) {
      throw new Error('peer sent invalid resumable transfer state');
    }
    resumeIndexes = resume.nextChunks.map((value, index) => {
      const next = Number(value);
      if (!Number.isInteger(next) || next < 0 || next > plan.items[index].chunks) {
        throw new Error('peer sent invalid resumable transfer state');
      }
      return next;
    });
    const resumedChunks = resumeIndexes.reduce((sum, value) => sum + value, 0);
    if (Number(resume.receivedChunks) !== resumedChunks) {
      throw new Error('peer sent inconsistent resumable transfer state');
    }
    const remainingFiles = new Set(plan.items
      .filter((item, index) => item.kind === 'file' && resumeIndexes[index] < item.chunks)
      .map((item) => item.rel));
    let selectedSources;
    if (typeof options.snapshotSelected === 'function') {
      // Snapshotting thousands of files may legitimately take longer than the
      // relay idle window. Keep both event loops and both idle timers alive
      // until the stable snapshot is ready to stream.
      const keepaliveMs = Number.isInteger(options.snapshotKeepaliveMs) && options.snapshotKeepaliveMs > 0
        ? options.snapshotKeepaliveMs
        : RELAY_STATUS_INTERVAL_MS;
      const preparation = Promise.resolve()
        .then(() => options.snapshotSelected(remainingFiles, onProgress))
        .then(
          (value) => ({ kind: 'complete', value }),
          (error) => ({ kind: 'error', error }),
        );
      for (;;) {
        let timer = null;
        const heartbeat = new Promise((resolve) => {
          timer = setTimeout(() => resolve({ kind: 'heartbeat' }), keepaliveMs);
          timer.unref?.();
        });
        const outcome = await Promise.race([preparation, heartbeat]);
        if (timer) clearTimeout(timer);
        if (outcome.kind === 'complete') {
          selectedSources = outcome.value;
          break;
        }
        if (outcome.kind === 'error') throw outcome.error;
        const heartbeatChannel = options.heartbeatChannel || channel;
        await Promise.resolve(heartbeatChannel.send({ type: 'sync-status', from, exchangeId }));
        if (onProgress) onProgress();
      }
    } else {
      selectedSources = new Map([...fileSources].filter(([rel]) => remainingFiles.has(rel)));
    }
    for (const item of plan.items) {
      if (item.kind === 'file' && remainingFiles.has(item.rel)) {
        const snapshot = selectedSources.get(item.rel);
        if (!snapshot) throw new Error('a requested file is missing from the stable outgoing snapshot');
        item.source = snapshot;
      }
    }
    await writeFrame({ type: 'sync-bundle-ready', from, exchangeId }, null);
    if (typeof options.waitForReadyAck === 'function') await options.waitForReadyAck();
    if (typeof options.waitForPeerSelectionReady === 'function') {
      await options.waitForPeerSelectionReady();
    }
  } else {
    plan = bundleTransferPlan(bundle, fileSources, chunkChars, textChunkChars);
    resumeIndexes = plan.items.map(() => 0);
    if (plan.chars > LEGACY_RELAY_BUNDLE_CHARS || plan.chunkCount > 128 * 1024) {
      throw new Error('the other device needs Carry 0.2.3 or newer for this large incremental sync');
    }
    metadataChunks = await sendBundleStartMetadata({
      type: 'sync-bundle-start',
      from,
      exchangeId,
      bundle: relayBundleMetadata(bundle),
      dataPaths: plan.dataPaths,
      chunkCount: plan.chunkCount,
      chars: plan.chars,
    }, {
      singleFrameBytes,
      chunkBytes: (chunkChars / 4) * 3,
      write: writeFrame,
    });
    if (metadataChunks && options.announceChunks) {
      log.info(`Sent the project manifest in ${metadataChunks} bounded part(s).`);
    }
  }
  const { chars, chunkCount } = plan;
  if (typeof options.onSelectedPlan === 'function') options.onSelectedPlan(plan);
  if (options.announceChunks) {
    log.info(
      `Sending ${storageHealth.formatBytes(plan.storedBytes)} in ${chunkCount} encrypted part(s) ` +
      `for ${plan.dataPaths.length} changed file(s)...`,
    );
    if (supportsBinary) {
      log.info('Using Carry\'s faster encrypted byte transfer to avoid encoding file data twice.');
    }
  }

  let sentChunks = resumeIndexes.reduce((sum, value) => sum + value, 0);
  let lastSentProgress = 0;
  const afterChunk = async () => {
    sentChunks += 1;
    if (options.sentProgressLabel && chunkCount > 0) {
      const milestone = Math.min(99, Math.floor((sentChunks / chunkCount) * 100));
      if (milestone > lastSentProgress) {
        lastSentProgress = milestone;
        log.info(`${options.sentProgressLabel}: ${milestone}%`);
      }
    }
    if (onProgress) onProgress();
    await waitForChannelDrain(channel, onProgress, options.highWaterBytes);
    if (waitForPeerWindow) await waitForPeerWindow(sentChunks);
  };
  for (let itemIndex = 0; itemIndex < plan.items.length; itemIndex++) {
    const item = plan.items[itemIndex];
    const resumeAt = resumeIndexes[itemIndex] || 0;
    if (resumeAt >= item.chunks) continue;
    if (item.kind === 'file') {
      await streamOutgoingFile(item, async (index, bytes) => {
        const metadata = {
          type: 'sync-bundle-chunk',
          from,
          exchangeId,
          path: item.rel,
          index,
        };
        if (supportsBinary) await Promise.resolve(channel.sendBinary(metadata, bytes));
        else await Promise.resolve(channel.send({ ...metadata, data: bytes.toString('base64') }));
        await afterChunk();
      }, resumeAt);
      continue;
    }
    for (let index = resumeAt; index < item.chunks; index++) {
      const metadata = {
        type: 'sync-bundle-chunk',
        from,
        exchangeId,
        path: item.rel,
        index,
      };
      const piece = item.value.slice(index * item.chunkChars, (index + 1) * item.chunkChars);
      if (supportsBinary && item.kind !== 'text') {
        await Promise.resolve(channel.sendBinary(metadata, Buffer.from(piece, 'base64')));
      }
      else await Promise.resolve(channel.send({ ...metadata, data: piece }));
      await afterChunk();
    }
  }
  await Promise.resolve(channel.send({
    type: 'sync-bundle-end', from, exchangeId, chunkCount: sentChunks, chars,
  }));
  if (onProgress) onProgress();
}

async function syncOverRelay(relayUrl, peer, m, bundle, fileSources, receiver, options) {
  options = options || {};
  const client = new relayClient.RelayClient();
  const relayInfo = client.setRelay(relayUrl);
  // The room key is the peer's pairing code, which we stored alongside the peer.
  const relaySecret = String(peer.pairCode || '');
  if (!relayClient.REMOTE_SECRET_PATTERN.test(relaySecret)) {
    throw new Error('remote sync requires a strong saved pairing key');
  }
  if (relayInfo.secret && relayInfo.secret !== relaySecret) {
    throw new Error('relay invitation secret does not match the saved pairing key');
  }
  const exchangeId = transferExchangeId(m.deviceId, bundle);
  log.info('Connecting to relay ' + relayInfo.address + '...');
  return new Promise((resolve, reject) => {
    let settled = false;
    let acknowledged = false;
    let receivedBundle = false;
    let incomingAckConfirmed = false;
    let incomingExchangeId = null;
    let incomingAckFrame = null;
    let peerSupportsAckReceipt = false;
    let peerApplying = false;
    let timeout = null;
    let absoluteTimeout = null;
    let statusTimer = null;
    let finishTimer = null;
    let peerErrorTimer = null;
    let sendInProgress = false;
    let highestPeerProgress = 0;
    let highestPeerChunks = 0;
    let selectedOutgoingBytes = 0;
    let resolveSelection;
    let rejectSelection;
    const selection = new Promise((resolve, reject) => { resolveSelection = resolve; rejectSelection = reject; });
    let resolveResume;
    let rejectResume;
    const resume = new Promise((resolve, reject) => { resolveResume = resolve; rejectResume = reject; });
    let resolveReadyAck;
    let rejectReadyAck;
    const readyAck = new Promise((resolve, reject) => { resolveReadyAck = resolve; rejectReadyAck = reject; });
    selection.catch(() => {});
    resume.catch(() => {});
    readyAck.catch(() => {});
    const experimentalDirect = options.experimentalDirect === true;
    const localDirectNonce = experimentalDirect ? nodeCrypto.randomBytes(16).toString('base64url') : null;
    const coordinatorId = [m.deviceId, peer.deviceId].sort()[0];
    const selfCoordinates = coordinatorId === m.deviceId;
    let peerDirectNonce = null;
    let directAttempt = null;
    let directChannel = null;
    let localDirectReady = false;
    let peerDirectReady = false;
    let selectedTransport = null;
    let bulkSendEnabled = false;
    let transportLogged = false;
    let relayPeerReady = false;
    let negotiationTimer = null;
    const pendingDirectSignals = [];
    const waitForPeerWindow = async (sentChunks, maximumInFlight) => {
      while (!settled && sentChunks - highestPeerChunks > maximumInFlight) {
        await new Promise((resolveWait) => setTimeout(resolveWait, 25));
      }
      if (settled) throw new Error('relay sync ended while encrypted data was still being sent');
    };
    const timeoutError = () => {
      if (peerApplying && !acknowledged) {
        return new Error('the peer received the update but did not finish verifying and applying it before the safety timeout');
      }
      if (receivedBundle && !acknowledged) {
        return new Error('the peer connected and sent its state, but did not acknowledge your outgoing update; Carry did not commit the partial sync');
      }
      if (acknowledged && !receivedBundle) {
        return new Error('the peer applied your update, but its return state did not arrive; Carry did not commit the partial sync');
      }
      return new Error('relay sync timed out waiting for the peer');
    };
    const armTimeout = (delay) => {
      clearTimeout(timeout);
      timeout = setTimeout(() => {
        if (settled) return;
        finish(timeoutError());
      }, delay || RELAY_SYNC_IDLE_MS);
      timeout.unref?.();
    };
    const finish = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearTimeout(absoluteTimeout);
      clearInterval(statusTimer);
      clearTimeout(finishTimer);
      clearTimeout(peerErrorTimer);
      clearTimeout(negotiationTimer);
      if (directChannel) directChannel.close(err || undefined);
      client.close();
      if (err) rejectSelection(err);
      if (err) rejectResume(err);
      if (err) rejectReadyAck(err);
      if (err) reject(err);
      else resolve();
    };
    const finishAfterPeerError = (error, notifyPeer) => {
      if (settled || peerErrorTimer) return;
      if (notifyPeer) {
        try {
          client.send({
            type: 'sync-error',
            from: m.deviceId,
            exchangeId,
            message: error && error.message ? error.message : 'direct transfer failed',
          });
        } catch { /* the local error remains authoritative */ }
      }
      // Let the already-enqueued encrypted relay error reach the peer before
      // closing the relay and DataChannel. Without this linger the far end saw
      // only the generic DataChannel close and lost the actionable cause.
      peerErrorTimer = setTimeout(() => finish(error), 500);
      peerErrorTimer.unref?.();
    };
    const finishIfComplete = () => {
      const terminalReceiptReady = !peerSupportsAckReceipt || incomingAckConfirmed;
      if (acknowledged && receivedBundle && terminalReceiptReady && !finishTimer) {
        log.info('Both devices confirmed the encrypted exchange; finalizing the shared baseline...');
        // New peers explicitly confirm receipt of our final ACK. Older peers
        // retain a longer compatibility linger before the room is closed.
        finishTimer = setTimeout(() => finish(), peerSupportsAckReceipt ? 250 : 1500);
      }
    };
    const processIncomingBulk = (frame, respond) => {
      if (frame && frame.from === peer.deviceId &&
          (frame.type === 'sync-bundle' || frame.type === 'sync-bundle-start' ||
           frame.type === 'sync-bundle-metadata-start')) {
        const capabilities = frame.type === 'sync-bundle-metadata-start' && Array.isArray(frame.capabilities)
          ? frame.capabilities
          : frame.bundle && Array.isArray(frame.bundle.capabilities) ? frame.bundle.capabilities : [];
        peerSupportsAckReceipt = capabilities.includes('sync-ack-received');
      }
      const relayRespond = (response) => {
        if (response && response.type === 'sync-ack') {
          incomingExchangeId = response.exchangeId || null;
          incomingAckFrame = response;
        }
        respond(response);
      };
      const receiverComplete = (error) => {
        if (error) { finishAfterPeerError(error, false); return; }
        receivedBundle = true;
        armTimeout();
        finishIfComplete();
      };
      const handled = receiver(frame, relayRespond, receiverComplete);
      if (handled) {
        receivedBundle = true;
        armTimeout();
        finishIfComplete();
      } else if (frame && frame.from === peer.deviceId &&
          (SYNC_BULK_FRAME_TYPES.has(frame.type) || frame.type === 'sync-status')) {
        // A peer may still be preparing its stable outgoing snapshot. Its
        // encrypted status probe is transfer progress for idle-time purposes.
        armTimeout();
      }
      return handled;
    };
    const queueBundle = () => {
      if (settled || acknowledged || sendInProgress || !selectedTransport || !bulkSendEnabled) return;
      sendInProgress = true;
      const useDirect = selectedTransport === 'direct';
      const channel = useDirect ? directChannel : client;
      sendBundleOverChannel(channel, m.deviceId, bundle, exchangeId, armTimeout, {
        fileSources,
        announceChunks: true,
        waitForPeerWindow: (sentChunks) => waitForPeerWindow(
          sentChunks,
          useDirect ? DIRECT_IN_FLIGHT_CHUNKS : RELAY_IN_FLIGHT_CHUNKS,
        ),
        supportsBinary: useDirect ? true : undefined,
        singleFrameBytes: useDirect ? DIRECT_SINGLE_FRAME_BYTES : undefined,
        chunkChars: useDirect ? DIRECT_CHUNK_CHARS : undefined,
        textChunkChars: useDirect ? DIRECT_TEXT_CHUNK_CHARS : undefined,
        highWaterBytes: useDirect ? p2p.DEFAULT_MAX_BUFFERED_BYTES : undefined,
        waitForSelection: () => selection,
        waitForResume: () => resume,
        waitForReadyAck: () => readyAck,
        waitForPeerSelectionReady: () => options.peerSelectionReady,
        snapshotSelected: options.snapshotSelected,
        // Direct data channels carry bulk frames only. Keep snapshot-preparation
        // liveness on the always-authenticated relay control channel.
        heartbeatChannel: client,
        onSelectedPlan: (plan) => { selectedOutgoingBytes = plan.fileBytes; },
      })
        .catch(finish)
        .finally(() => {
          sendInProgress = false;
          if (settled || statusTimer) return;
          statusTimer = setInterval(() => {
            if (settled) return;
            try {
              if (!acknowledged) client.send({ type: 'sync-status', from: m.deviceId, exchangeId });
              if (receivedBundle && incomingAckFrame && peerSupportsAckReceipt && !incomingAckConfirmed) {
                client.send(incomingAckFrame);
              }
            } catch (error) {
              finish(error);
            }
          }, RELAY_STATUS_INTERVAL_MS);
          statusTimer.unref?.();
        });
    };
    const controlFrame = (type, extra) => ({
      type,
      version: DIRECT_HELLO_VERSION,
      attemptId: directAttempt,
      from: m.deviceId,
      to: peer.deviceId,
      ...(extra || {}),
    });
    const enableBulkTransfer = () => {
      if (settled || bulkSendEnabled || !selectedTransport) return;
      bulkSendEnabled = true;
      clearTimeout(negotiationTimer);
      negotiationTimer = null;
      if (!transportLogged) {
        transportLogged = true;
        if (selectedTransport === 'direct') log.step('Direct encrypted connection ready.');
        else log.info('Using the secure relay connection for this transfer.');
      }
      queueBundle();
    };
    const selectTransport = (transportKind, broadcast) => {
      if (settled) return;
      if (selectedTransport) {
        if (selectedTransport !== transportKind && bulkSendEnabled) {
          finish(new Error('the two devices selected contradictory transfer channels'));
          return;
        }
        if (selectedTransport === transportKind) return;
      }
      if (transportKind === 'direct' && (!directChannel || !localDirectReady || !peerDirectReady)) {
        finish(new Error('peer selected a direct channel before it was authenticated'));
        return;
      }
      selectedTransport = transportKind;
      transportLogged = false;
      if (transportKind === 'relay' && directChannel) {
        directChannel.close('using secure relay fallback');
      }
      if (directAttempt) {
        try {
          client.send(controlFrame(
            broadcast ? 'sync-transport-start' : 'sync-transport-ack',
            { transport: transportKind },
          ));
        }
        catch (error) { finish(error); return; }
      }
    };
    const maybeSelectDirect = () => {
      if (!selectedTransport && selfCoordinates && localDirectReady && peerDirectReady) {
        selectTransport('direct', true);
      }
    };
    const failDirectBeforeTransfer = (error) => {
      if (settled || bulkSendEnabled || selectedTransport === 'relay') return;
      if (directAttempt) {
        try { client.send(controlFrame('sync-direct-failed')); } catch { /* relay failure is handled elsewhere */ }
      }
      if (error && error.message && !/closed|fallback/i.test(error.message)) {
        log.info('A direct connection was not available; falling back without sending project data directly.');
      }
      if (selfCoordinates) selectTransport('relay', true);
      else selectedTransport = null;
    };
    const validateProbe = (frame, type) => {
      const keys = 'attemptId,from,to,token,type,version';
      if (!frame || typeof frame !== 'object' || Array.isArray(frame) ||
          Object.keys(frame).sort().join(',') !== keys || frame.type !== type ||
          frame.version !== DIRECT_HELLO_VERSION || frame.attemptId !== directAttempt ||
          frame.from !== peer.deviceId || frame.to !== m.deviceId ||
          typeof frame.token !== 'string' || !/^[A-Za-z0-9_-]{22}$/.test(frame.token)) {
        throw new Error('direct channel authentication probe was invalid');
      }
    };
    const startDirectAttempt = () => {
      if (!experimentalDirect || directChannel || !peerDirectNonce || selectedTransport) return;
      directAttempt = directAttemptId(m.deviceId, localDirectNonce, peer.deviceId, peerDirectNonce);
      log.info('Trying a faster direct encrypted connection...');
      directChannel = p2p.createP2PTransport({
        selfId: m.deviceId,
        peerId: peer.deviceId,
        attemptId: directAttempt,
        secret: relaySecret,
        iceServers: ['stun:stun.cloudflare.com:3478'],
        connectTimeoutMs: DIRECT_NEGOTIATION_MS,
        maxBufferedBytes: 128 * 1024,
        bufferedLowBytes: 32 * 1024,
        sendSignal: (signal) => {
          if (settled || selectedTransport === 'relay') return;
          client.send(signal);
        },
        onFrame: (frame, respondDirect) => {
          try {
            if (frame.type === 'sync-direct-probe') {
              validateProbe(frame, 'sync-direct-probe');
              respondDirect({
                type: 'sync-direct-probe-ack',
                version: DIRECT_HELLO_VERSION,
                attemptId: directAttempt,
                from: m.deviceId,
                to: peer.deviceId,
                token: frame.token,
              }).catch(failDirectBeforeTransfer);
              return;
            }
            if (frame.type === 'sync-direct-probe-ack') {
              validateProbe(frame, 'sync-direct-probe-ack');
              if (frame.token !== localDirectNonce) throw new Error('direct channel authentication probe did not match');
              if (!localDirectReady) {
                localDirectReady = true;
                client.send(controlFrame('sync-direct-ready'));
                maybeSelectDirect();
              }
              return;
            }
            if (!selectedTransport || selectedTransport !== 'direct' || !SYNC_BULK_FRAME_TYPES.has(frame.type)) {
              throw new Error('unexpected frame arrived on the direct transfer channel');
            }
            if (selfCoordinates && !bulkSendEnabled) {
              throw new Error('peer sent direct project data before acknowledging the selected transport');
            }
            enableBulkTransfer();
            processIncomingBulk(frame, (response) => client.send(response));
          } catch (error) {
            if (!bulkSendEnabled) failDirectBeforeTransfer(error);
            else finishAfterPeerError(error, true);
          }
        },
        onError: (error) => {
          if (!bulkSendEnabled) failDirectBeforeTransfer(error);
          else finishAfterPeerError(error, true);
        },
        onClose: (error) => {
          if (settled) return;
          if (!bulkSendEnabled) failDirectBeforeTransfer(error || new Error('direct channel closed'));
          else if (selectedTransport === 'direct') {
            finishAfterPeerError(error || new Error('direct channel closed during transfer'), true);
          }
        },
      });
      negotiationTimer = setTimeout(() => {
        failDirectBeforeTransfer(new Error('direct connection negotiation timed out'));
      }, DIRECT_NEGOTIATION_MS + 500);
      negotiationTimer.unref?.();
      const directReady = directChannel.start();
      try {
        for (const signal of pendingDirectSignals.splice(0)) directChannel.handleSignal(signal);
      } catch (error) {
        failDirectBeforeTransfer(error);
      }
      directReady
        .then(() => directChannel.send({
          type: 'sync-direct-probe',
          version: DIRECT_HELLO_VERSION,
          attemptId: directAttempt,
          from: m.deviceId,
          to: peer.deviceId,
          token: localDirectNonce,
        }))
        .catch(failDirectBeforeTransfer);
    };
    armTimeout();
    absoluteTimeout = setTimeout(() => {
      finish(new Error('relay sync exceeded the 12-hour safety limit without completing'));
    }, RELAY_SYNC_ABSOLUTE_MS);
    absoluteTimeout.unref?.();
    client.join(relaySecret, m.deviceId, (frame, respond) => {
      if (frame.type === 'peer-gone') {
        // Both data directions are already known to be applied. A compliant
        // peer only closes after terminal confirmation, and this compatibility
        // rule also lets a newer client finish cleanly with an older one.
        if (acknowledged && receivedBundle && (!peerSupportsAckReceipt || incomingAckConfirmed)) finish();
        else finish(new Error('peer disconnected from relay'));
        return;
      }
      if (frame.type === 'relay-error') { finish(new Error(frame.message || 'relay rejected the sync')); return; }
      if (frame.type === 'relay-ready') {
        // Peer is now in the room, so its bundle receiver is ready.
        if (!relayPeerReady) {
          relayPeerReady = true;
          armTimeout();
          if (!experimentalDirect) {
            selectedTransport = 'relay';
            bulkSendEnabled = true;
            queueBundle();
          } else {
            try { client.send(directHello(m.deviceId, localDirectNonce)); }
            catch (error) { finish(error); }
          }
        }
        return;
      }
      if (frame.type === 'sync-transport-hello') {
        if (!experimentalDirect) return;
        try {
          validateDirectHello(frame, peer.deviceId);
          if (peerDirectNonce && peerDirectNonce !== frame.nonce) {
            throw new Error('peer changed its direct-transport hello during one sync');
          }
          peerDirectNonce = frame.nonce;
          startDirectAttempt();
        } catch (error) { finish(error); }
        return;
      }
      if (frame.type === p2p.SIGNAL_TYPE) {
        if (!experimentalDirect || selectedTransport === 'relay') return;
        try {
          if (!directChannel) {
            if (pendingDirectSignals.length >= p2p.MAX_CANDIDATES + 2) {
              throw new Error('peer sent too many direct signals before negotiation began');
            }
            pendingDirectSignals.push(frame);
          } else directChannel.handleSignal(frame);
        } catch (error) { finish(error); }
        return;
      }
      if (frame.type === 'sync-direct-ready') {
        if (!experimentalDirect || !directAttempt || selectedTransport === 'relay') return;
        try {
          validateDirectControl(frame, 'sync-direct-ready', peer.deviceId, m.deviceId, directAttempt);
          peerDirectReady = true;
          maybeSelectDirect();
        } catch (error) { finish(error); }
        return;
      }
      if (frame.type === 'sync-direct-failed') {
        if (!experimentalDirect || !directAttempt || bulkSendEnabled) return;
        try {
          validateDirectControl(frame, 'sync-direct-failed', peer.deviceId, m.deviceId, directAttempt);
          if (selfCoordinates) selectTransport('relay', true);
          else selectedTransport = null;
        } catch (error) { finish(error); }
        return;
      }
      if (frame.type === 'sync-transport-start') {
        if (!experimentalDirect || !directAttempt) return;
        try {
          validateDirectControl(frame, 'sync-transport-start', peer.deviceId, m.deviceId, directAttempt);
          if (frame.from !== coordinatorId || selfCoordinates) {
            throw new Error('the wrong device tried to select the transfer channel');
          }
          if (frame.transport === 'direct' && process.env.CARRY_TEST_REJECT_DIRECT_SELECTION === '1') {
            selectedTransport = null;
            client.send(controlFrame('sync-direct-failed'));
            return;
          }
          selectTransport(frame.transport, false);
        } catch (error) { finish(error); }
        return;
      }
      if (frame.type === 'sync-transport-ack') {
        if (!experimentalDirect || !directAttempt || !selfCoordinates || bulkSendEnabled) return;
        try {
          validateDirectControl(frame, 'sync-transport-ack', peer.deviceId, m.deviceId, directAttempt);
          if (!selectedTransport || frame.transport !== selectedTransport) {
            throw new Error('peer acknowledged a different transfer channel');
          }
          enableBulkTransfer();
        } catch (error) { finish(error); }
        return;
      }
      if (frame.type === 'sync-progress') {
        if (frame.from !== peer.deviceId || frame.exchangeId !== exchangeId) return;
        const receivedChunks = Number(frame.receivedChunks);
        const totalChunks = Number(frame.totalChunks);
        if (!Number.isInteger(receivedChunks) || !Number.isInteger(totalChunks) ||
            receivedChunks < 0 || totalChunks < 0 || receivedChunks > totalChunks || totalChunks > MAX_RELAY_BUNDLE_CHUNKS) {
          finish(new Error('peer sent invalid encrypted-transfer progress'));
          return;
        }
        if (totalChunks > 0) {
          if (receivedChunks > highestPeerChunks) {
            highestPeerChunks = receivedChunks;
            armTimeout();
          }
          const milestone = Math.min(99, Math.floor((receivedChunks / totalChunks) * 100));
          if (milestone > highestPeerProgress) {
            highestPeerProgress = milestone;
            log.info(`Peer received encrypted update: ${milestone}%`);
          }
        }
        return;
      }
      if (frame.type === 'sync-applying') {
        if (frame.from !== peer.deviceId || frame.exchangeId !== exchangeId) return;
        if (!peerApplying) log.info('Peer received the update and is safely verifying and applying it...');
        peerApplying = true;
        armTimeout(applyTimeoutForBytes(selectedOutgoingBytes));
        return;
      }
      if (frame.type === 'sync-ack') {
        if (frame.from !== peer.deviceId) { finish(new Error('sync acknowledgement came from an unpaired device')); return; }
        if (frame.exchangeId && frame.exchangeId !== exchangeId) return;
        if (!acknowledged) {
          log.step('Peer applied our bundle.');
        }
        acknowledged = true;
        armTimeout();
        // Confirm that the peer's terminal ACK reached this process. The peer
        // keeps its relay socket open until this encrypted receipt arrives.
        try { respond({ type: 'sync-ack-received', from: m.deviceId, exchangeId }); }
        catch (error) { finish(error); return; }
        finishIfComplete();
        return;
      }
      if (frame.type === 'sync-ack-received') {
        if (frame.from !== peer.deviceId || !incomingExchangeId || frame.exchangeId !== incomingExchangeId) return;
        if (!incomingAckConfirmed) log.step('Peer confirmed receipt of our final acknowledgement.');
        incomingAckConfirmed = true;
        armTimeout();
        finishIfComplete();
        return;
      }
      if (frame.type === 'sync-error') {
        if (frame.from !== peer.deviceId) return;
        if (frame.exchangeId && frame.exchangeId !== exchangeId) return;
        finish(new Error('peer rejected sync: ' + (frame.message || 'unknown error')));
        return;
      }
      if (frame.type === 'sync-bundle-request') {
        if (frame.from !== peer.deviceId || frame.exchangeId !== exchangeId) {
          finish(new Error('peer sent an invalid incremental data request'));
          return;
        }
        resolveSelection(frame);
        armTimeout();
        return;
      }
      if (frame.type === 'sync-bundle-resume') {
        if (frame.from !== peer.deviceId || frame.exchangeId !== exchangeId) {
          finish(new Error('peer sent invalid resumable transfer state'));
          return;
        }
        const resumed = Number(frame.receivedChunks);
        if (Number.isInteger(resumed) && resumed >= 0) highestPeerChunks = Math.max(highestPeerChunks, resumed);
        resolveResume(frame);
        armTimeout();
        return;
      }
      if (frame.type === 'sync-bundle-ready-ack') {
        if (frame.from !== peer.deviceId || frame.exchangeId !== exchangeId) {
          finish(new Error('peer acknowledged an invalid resumable transfer'));
          return;
        }
        resolveReadyAck(frame);
        armTimeout();
        return;
      }
      const isBulk = frame && frame.from === peer.deviceId && SYNC_BULK_FRAME_TYPES.has(frame.type);
      if (isBulk && experimentalDirect && !selectedTransport) {
        // Compatibility with a peer that predates direct negotiation: its
        // first authenticated relay bundle is an implicit relay selection.
        selectedTransport = 'relay';
        enableBulkTransfer();
      } else if (isBulk && selectedTransport === 'direct') {
        finish(new Error('peer sent project data over the relay after selecting the direct channel'));
        return;
      } else if (isBulk && selectedTransport === 'relay') {
        enableBulkTransfer();
      }
      processIncomingBulk(frame, respond);
    }, m.name, relaySecret, undefined, options.syncRunId).catch(finish);
  });
}

function applyIncoming(root, m, peerId, bundle, syncSourceDeviceId, staged, preparedPlan) {
  const result = syncEngine.prepareIncoming(root, peerId, bundle, m.deviceId, {
    ...(staged || {}),
    syncSourceDeviceId,
    ...(preparedPlan ? { preparedPlan } : {}),
  });
  const s = result.summary;
  if (s.pulled || s.deletedLocal) {
    log.step(`Applied ${s.pulled} update(s) and ${s.deletedLocal} deletion(s) from the peer.`);
  }
  if (s.createdDirectories || s.deletedDirectories) {
    log.step(`Applied ${s.createdDirectories || 0} folder creation(s) and ${s.deletedDirectories || 0} folder deletion(s) from the peer.`);
  }
  if (s.pushed || s.deletedRemote) {
    log.info(`Carry plans to send ${s.pushed} update(s) and ${s.deletedRemote} deletion(s) to the peer.`);
  }
  if (result.skipped.length) {
    log.warn('Paused ' + result.skipped.length + ' claimed file(s) - they will retry later.');
  }
  if (result.conflicts.length) {
    log.warn('Conflict: kept both machines unchanged for ' + result.conflicts.join(', '));
    log.info('The conflict is recorded in Carry private recovery storage (session ' + result.sessionId + ').');
  }
  if (result.activeResolved.length) {
    const source = result.activeDeviceId === m.deviceId ? 'this device' : 'the active peer';
    log.info(`Active Device selected ${source} as the source of truth for ${result.activeResolved.length} otherwise-conflicting file(s).`);
  }
  if (result.syncSourceDeviceId) {
    const source = result.syncSourceDeviceId === m.deviceId ? 'this device' : 'the selected peer';
    log.info(`Sync direction used ${source} as the source for this exchange.`);
  }
  if (result.backups.length) log.info('Backed up replaced/deleted files in Carry private recovery storage (session ' + result.sessionId + ').');
  if (!s.pulled && !s.deletedLocal && !result.conflicts.length && !result.skipped.length) {
    log.step('No incoming file changes from the peer in this exchange.');
  }
  return result;
}

function cmdStatus() {
  const root = requireProject();
  const m = requireManifest(root);
  log.title('Carry status — ' + m.name);
  log.info(`Device: ${m.deviceId}  (created ${m.createdAt})`);
  const peers = manifest.listPeers(root);
  if (peers.length === 0) {
    log.info('No paired peers yet. Run `carry pair` to link another machine.');
  } else {
    for (const p of peers) {
      const where = p.transport === 'relay' ? (p.address || 'relay') : (p.address || 'lan');
      const state = p.connectionEnabled === false ? 'disconnected' : 'connected';
      log.info(`  Peer ${log.mark(p.connectionEnabled !== false)} ${p.name} (${p.deviceId.slice(0, 6)}) via ${p.transport} @ ${where}, ${state}, last seen ${p.lastSeen}`);
    }
  }
  const files = sync.listFiles(root);
  log.info(`Tracked files: ${files.length}  (Git and private Carry state excluded)`);
  const latest = syncEngine.listSessions(root, 1)[0];
  if (latest) {
    const conflicts = Array.isArray(latest.conflicts) ? latest.conflicts.length : 0;
    log.info(`Last sync: ${latest.status} at ${latest.completedAt || latest.startedAt}` +
      (conflicts ? `  (${conflicts} conflict${conflicts === 1 ? '' : 's'} recorded)` : ''));
  }
  log.done();
}

// Run the signaling-only relay server (for cross-network sync).
async function cmdRelay(flags) {
  const port = parseInt(flags.port || '48125', 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('--port must be an integer from 1 to 65535');
  const relayServer = require('../relay/server');
  const relayProjectRoot = manifest.findCarryRoot(process.cwd());
  const relayManifestPath = relayProjectRoot
    ? manifest.manifestFile(relayProjectRoot)
    : privateState.appFile('relay-manifest.json');
  if (flags.tunnel) {
    const secret = relayClient.newRemoteSecret();
    const room = relayClient.roomForSecret(secret);
    const server = relayServer.startWebRelay(port, {
      host: '127.0.0.1',
      ignoreAllowlist: true,
      allowedRooms: new Set([room]),
      manifestPath: relayManifestPath,
    });
    try {
      if (!server.listening) {
        await new Promise((resolve, reject) => {
          server.once('listening', resolve);
          server.once('error', reject);
        });
      }
      const tunnel = await require('../lib/tunnel').startTunnel({ relayPort: server.address().port });
      const invite = relayClient.createRemoteInvite(tunnel.url, secret);
      let stopped = false;
      const stop = () => {
        if (stopped) return;
        stopped = true;
        tunnel.stop();
        try { server.close(); } catch { /* ignore */ }
      };
      process.once('SIGINT', () => { stop(); process.exit(0); });
      process.once('SIGTERM', () => { stop(); process.exit(0); });
      log.title('Carry remote relay is ready');
      log.step('No router port-forwarding is required.');
      log.info('Keep this window open while the two devices pair or sync.');
      log.info('Share this complete invite privately with the other device:');
      console.log('\n  ' + invite + '\n');
      log.info('The part after # is the encryption secret and is never sent to localhost.run.');
      return { server, tunnel, invite };
    } catch (error) {
      try { server.close(); } catch { /* ignore */ }
      throw error;
    }
  }
  if (flags.web) return relayServer.startWebRelay(port, { host: '0.0.0.0', manifestPath: relayManifestPath });
  return relayServer.startRelay(port, { manifestPath: relayManifestPath });
}

async function cmdApp(flags) {
  const requestedRoot = flags.folder ? folderPicker.resolveFolder(flags.folder) : manifest.findCarryRoot(process.cwd());
  const port = flags.port === undefined ? 0 : Number.parseInt(flags.port, 10);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('--port must be an integer from 0 to 65535');
  const instance = await require('../lib/app-server').launch({
    root: requestedRoot,
    port,
    open: !flags['no-open'],
  });
  log.title('Carry desktop');
  log.step(flags['no-open'] ? 'Local app server is ready.' : 'Desktop window opened.');
  if (flags['no-open']) log.info(instance.url);
  log.info('The app is private to this PC and listens only on 127.0.0.1.');
  log.done();
}

// --- Interactive first-time LAN setup wizard (carry setup) ---
// The human flow is deliberately tiny: choose Send or Receive, approve one
// narrow Windows Firewall change, enter one code on the receiving machine, and
// let Carry pair + perform the first encrypted sync automatically.
const prompt = require('../lib/prompt');
const firewall = require('../lib/firewall');

async function ensureLanFirewall(linkPort) {
  if (process.env.CARRY_SKIP_FIREWALL === '1') {
    log.step('Firewall setup skipped by the automated test environment.');
    return;
  }
  if (process.platform !== 'win32') {
    const proceed = await prompt.ask('Automatic firewall setup is Windows-only. Continue anyway? [y/N]', {
      boolean: true,
      defaultValue: 'n',
    });
    if (!proceed) throw new Error('setup cancelled before changing network access');
    return;
  }
  if (firewall.rulesInstalled({ linkPort })) {
    log.step('Windows Firewall is already ready for Carry on this local network.');
    return;
  }

  log.info('Carry needs two inbound rules for encrypted LAN discovery and sync.');
  log.info('They are restricted to this node.exe and devices on your local subnet.');
  const approve = await prompt.ask('Install the Carry LAN firewall rules? Windows will ask once. [Y/n]', {
    boolean: true,
    defaultValue: 'y',
  });
  if (!approve) throw new Error('firewall permission is required for reliable LAN sync');
  const result = firewall.installLanRules({ linkPort });
  if (!result.ok) throw new Error(result.message || 'Windows Firewall setup was not approved or did not complete');
  log.step('Windows Firewall allows Carry only from this local subnet.');
}

async function selectSetupFolder(flags) {
  const cwd = process.cwd();
  const containingProject = manifest.findCarryRoot(cwd);
  const suggested = containingProject || cwd;
  let target;

  if (flags.folder) {
    target = folderPicker.resolveFolder(flags.folder, cwd);
  } else {
    const choice = await prompt.choose('Which folder do you want Carry to sync?', [
      'Use this folder: ' + suggested,
      'Browse for a folder',
      'Type or paste a folder path',
    ]);
    if (choice.startsWith('Use this folder:')) {
      target = suggested;
    } else if (choice === 'Browse for a folder') {
      target = folderPicker.browse(suggested);
      if (!target) throw new Error('folder selection was cancelled');
    } else {
      const entered = await prompt.ask('Folder to send or receive:', { defaultValue: suggested });
      target = folderPicker.resolveFolder(entered, cwd);
    }
  }

  const parentProject = manifest.findCarryRoot(target);
  if (parentProject && path.resolve(parentProject) !== path.resolve(target)) {
    throw new Error('the selected folder is inside another Carry project; select its root: ' + parentProject);
  }

  if (!fs.existsSync(target)) {
    const create = await prompt.ask('That folder does not exist. Create it? [Y/n]', { boolean: true, defaultValue: 'y' });
    if (!create) throw new Error('setup cancelled before creating the project folder');
    fs.mkdirSync(target, { recursive: true });
  }
  if (!fs.statSync(target).isDirectory()) throw new Error('the selected path is not a folder');

  return path.resolve(target);
}

async function cmdSetup(flags) {
  flags = flags || {};
  log.title('Carry first-time setup');
  log.info('Put both machines on the same Wi-Fi or phone hotspot.');
  log.info('Run this wizard on both; it handles pairing and the first sync for you.');
  log.done();

  // Always make the sync root explicit. The same selector is reusable by the
  // desktop UI; --folder gives automation an exact, non-interactive path.
  const selectedFolder = await selectSetupFolder(flags);
  process.chdir(selectedFolder);
  let root = manifest.readManifest(selectedFolder) ? selectedFolder : null;

  if (!root) {
    const name = await prompt.ask('Name this project (folder will sync as this):', { defaultValue: path.basename(process.cwd()) });
    const r = manifest.init(process.cwd(), name);
    root = r.root;
    log.step(`Project initialized: ${r.manifest.name} (device ${r.manifest.deviceId.slice(0, 6)})`);
  } else {
    const m = manifest.readManifest(root);
    log.step(`Already a carry project: ${m.name} (device ${m.deviceId.slice(0, 6)})`);
  }

  const role = await prompt.choose('What should this machine do?', ['Send', 'Receive']);
  const linkPort = getLinkPort(flags);
  await ensureLanFirewall(linkPort);

  let peerId;
  if (role === 'Send') {
    log.title('Pairing — send this code to the other person');
    peerId = await cmdPair(['pair'], { ...flags, wizard: true });
  } else {
    const code = (await prompt.ask('Paste the 32-character secure code shown on the sending machine:', {
      validate: (v) => { if (!/^[A-F0-9]{32}$/i.test(v)) throw new Error('secure code must contain 32 hexadecimal characters'); },
    })).toUpperCase();
    log.title('Pairing — finding the sending machine');
    peerId = await cmdPair(['pair', code], { ...flags, wizard: true });
  }

  log.title('First encrypted sync');
  log.info('No timing needed — Carry will wait for the other machine automatically.');
  const setupManifest = requireManifest(root);
  const sourceDeviceId = role === 'Send' ? setupManifest.deviceId : peerId;
  await cmdSync({ ...flags, peer: peerId, 'source-device': sourceDeviceId });

  log.title('Carry setup complete');
  log.step(role === 'Send' ? 'The project was sent and the peer copy was merged.' : 'The project is now on this machine.');
  log.info('For later same-network updates, run `carry sync` on both machines.');
  log.done();
}

const HELP = `
carry — take your project folders (and their agent memory) everywhere

Usage:
  carry <command> [options]

Commands:
  app           Open the Carry desktop app
  setup         Choose a folder, then run the LAN pairing + first-sync wizard
  init [name]   Mark a folder as a carry project (add --folder PATH if needed)
  pair [code]   Link another machine. On LAN, one device runs \`carry pair\`
                 and the other pastes its 32-character secure code.
                 For remote pairing, use the complete private relay invite.
  sync          Exchange files + merge agent memory with the paired peer.
                 Add \`--relay host:port\` if the peer was paired via relay.
                 Add \`--direct\` to try experimental encrypted P2P first;
                 Carry falls back to the secure relay before sending files.
  relay         Run a relay. Add --tunnel for a no-port-forward HTTPS invite.
  status        Show device, paired peers, and tracked file count
  help          Show this help

Notes:
  - .git is always excluded — git stays git's job.
  - .shared-memory/memory.json is union-merged, never overwritten.
  - One-device edits/deletions sync; two-device edits become safe conflicts.
  - Replaced/deleted files are backed up in private Carry app data.
  - Files with an active shared-agent-memory claim are paused, not clobbered.
  - Direct LAN sync needs no relay. For different networks, run
    \`carry relay --tunnel\`, then use its complete secure invite on both
    devices with \`carry pair --relay <invite>\`.
    The relay only brokers encrypted frames; it never stores your file bytes.

Examples:
  carry app
  carry app --folder "C:\\work\\my-project"
  carry setup
  carry setup --folder "C:\\Users\\you\\Desktop\\my-project"
  carry init my-project
  carry init my-project --folder "C:\\work\\my-project"
  carry pair
  carry pair <32-character-LAN-code>
  carry pair --relay "https://example.lhr.life/carry#<secret>"
  carry sync
  carry sync --peer <device> --source-device <device-id>
  carry sync --peer <remote-device-id>
  carry sync --peer <remote-device-id> --direct
  carry relay --port 48125
  carry relay --tunnel
  carry status
`;

async function main() {
  const { _, flags } = parseArgs(process.argv.slice(2));
  const cmd = _[0] || 'help';
  try {
    switch (cmd) {
      case 'setup': return await cmdSetup(flags);
      case 'app':
      case 'gui': return await cmdApp(flags);
      case 'init': return cmdInit(_, flags);
      case 'pair': return await cmdPair(_, flags);
      case 'sync': return await cmdSync(flags);
      case 'relay': return await cmdRelay(flags);
      case 'status': return cmdStatus();
      case 'help': return console.log(HELP);
      default:
        console.log('Unknown command: ' + cmd);
        console.log(HELP);
        process.exitCode = 1;
    }
  } catch (err) {
    log.warn('Error: ' + (err && err.message ? err.message : String(err)));
    process.exitCode = 1;
  }
}

if (require.main === module) main();

// Focused protocol seams for deterministic integration tests. The installed
// CLI still enters through main(); importing the module never starts a process.
module.exports = {
  makeSyncReceiver,
  sendBundleOverChannel,
  bundleTransferPlan,
  MAX_RELAY_BUNDLE_CHUNKS,
  MAX_BUNDLE_METADATA_BYTES,
};
