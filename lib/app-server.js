'use strict';

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');
const checkpoints = require('./checkpoints');
const firewall = require('./firewall');
const folderPicker = require('./folder-picker');
const manifest = require('./manifest');
const memory = require('./memoryMerge');
const privateState = require('./private-state');
const relay = require('./relay');
const sync = require('./sync');
const syncEngine = require('./sync-engine');
const tunnel = require('./tunnel');
const { startWebRelay } = require('../relay/server');

const APP_DIR = path.join(__dirname, '..', 'app');
const CARRY_BIN = path.join(__dirname, '..', 'bin', 'carry.js');
const APP_SETTINGS = privateState.appFile('app-settings.json');
const MAX_BODY = 64 * 1024;
const MAX_LOG = 300;
const IDLE_CLOSE_MS = 2 * 60 * 1000;
const CONTROL_RECONNECT_MS = 1000;
const CONTROL_HEARTBEAT_MS = 20000;
const CONTROL_STALE_MS = 75000;
const SYNC_REQUEST_TIMEOUT_MS = 10000;
const MAX_CONTROL_REQUESTS = 32;
const DEFAULT_TEAM_DEVICES = 2;
const MAX_TEAM_DEVICES = 16;
const NATIVE_APP_ORIGINS = new Set([
  'http://tauri.localhost',
  'https://tauri.localhost',
]);

function timingSafeTextEqual(a, b) {
  const left = Buffer.from(String(a || ''));
  const right = Buffer.from(String(b || ''));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function requestedDirect(value) {
  if (value !== undefined && typeof value !== 'boolean') {
    throw Object.assign(new Error('Direct transfer preference must be true or false'), { statusCode: 400 });
  }
  return value === true;
}

function sendJson(res, status, value) {
  const body = Buffer.from(JSON.stringify(value));
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function securityHeaders(req, res) {
  const origin = req.headers.origin;
  const nativeAppRequest = NATIVE_APP_ORIGINS.has(origin);
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Cross-Origin-Resource-Policy', nativeAppRequest ? 'cross-origin' : 'same-origin');
  if (nativeAppRequest) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Carry-Token');
    res.setHeader('Access-Control-Max-Age', '600');
    res.setHeader('Vary', 'Origin');
  }
}

function serveStatic(urlPath, res) {
  const files = {
    '/': ['index.html', 'text/html; charset=utf-8'],
    '/index.html': ['index.html', 'text/html; charset=utf-8'],
    '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
    '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
    '/manifest.webmanifest': ['manifest.webmanifest', 'application/manifest+json; charset=utf-8'],
    '/favicon.ico': ['assets/carry-icon-44.png', 'image/png'],
    '/assets/carry-icon.svg': ['assets/carry-icon.svg', 'image/svg+xml'],
    '/assets/carry-icon-44.png': ['assets/carry-icon-44.png', 'image/png'],
    '/assets/carry-icon-192.png': ['assets/carry-icon-192.png', 'image/png'],
    '/assets/carry-icon-512.png': ['assets/carry-icon-512.png', 'image/png'],
  };
  const item = files[urlPath];
  if (!item) return false;
  const body = fs.readFileSync(path.join(APP_DIR, item[0]));
  res.writeHead(200, {
    'Content-Type': item[1],
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
  });
  res.end(body);
  return true;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('request is too large'), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(Object.assign(new Error('request body must be valid JSON'), { statusCode: 400 })); }
    });
    req.on('error', reject);
  });
}

function requireRoot(appState) {
  if (!appState.root) throw Object.assign(new Error('Choose a project folder first'), { statusCode: 409 });
  return appState.root;
}

function requireProject(appState) {
  const root = requireRoot(appState);
  const project = manifest.readManifest(root);
  if (!project) throw Object.assign(new Error('Initialize this folder before pairing or syncing'), { statusCode: 409 });
  return { root, project };
}

function selectRoot(appState, target) {
  if (appState.job && appState.job.status === 'running') {
    throw Object.assign(new Error('Finish or cancel the active Carry operation before changing folders'), { statusCode: 409 });
  }
  if (appState.remoteSession && ['starting', 'ready'].includes(appState.remoteSession.status)) {
    throw Object.assign(new Error('Stop the active remote session before changing folders'), { statusCode: 409 });
  }
  if (typeof target !== 'string' || !target.trim()) {
    throw Object.assign(new Error('Enter or choose a folder path'), { statusCode: 400 });
  }
  const resolved = path.resolve(target.trim());
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    throw Object.assign(new Error('The selected path is not an existing folder'), { statusCode: 400 });
  }
  appState.root = manifest.findCarryRoot(resolved) || resolved;
  appState.selectedPeerId = null;
  appState.pendingCache = null;
  appState.fileCache = null;
  if (appState.persistSettings) {
    try {
      fs.mkdirSync(path.dirname(APP_SETTINGS), { recursive: true });
      fs.writeFileSync(APP_SETTINGS, JSON.stringify({ lastFolder: appState.root }, null, 2) + '\n');
    } catch { /* selection still works when the runtime folder is read-only */ }
  }
  return appState.root;
}

function initialRoot(value) {
  if (!value) {
    const current = manifest.findCarryRoot(process.cwd());
    if (current) return current;
    try {
      const saved = JSON.parse(fs.readFileSync(APP_SETTINGS, 'utf8')).lastFolder;
      if (saved && fs.existsSync(saved) && fs.statSync(saved).isDirectory()) return manifest.findCarryRoot(saved) || path.resolve(saved);
    } catch { /* no saved folder yet */ }
    return null;
  }
  const resolved = path.resolve(value);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) return null;
  return manifest.findCarryRoot(resolved) || resolved;
}

function stripAnsi(value) {
  return String(value || '').replace(/\x1b\[[0-9;]*m/g, '');
}

function updateJobPhase(job, text) {
  if (/Direct encrypted connection ready/i.test(text)) job.transport = 'direct';
  else if (/Using the secure relay connection for this transfer/i.test(text)) job.transport = 'relay';
  const operation = text.match(/^Carry (push to|pull from|smart sync with|sync with) (.+?)(?: \(via relay\))?$/i);
  if (operation) {
    job.operation = {
      direction: operation[1].toLowerCase().startsWith('push') ? 'push'
        : operation[1].toLowerCase().startsWith('pull') ? 'pull' : 'smart',
      peerName: operation[2],
    };
    job.phase = 'connecting';
  } else if (/Connecting to relay|Connecting directly|Waiting for the other machine/i.test(text)) {
    job.phase = 'connecting';
  } else if (/Receiving (?:the encrypted update|.* encrypted part)|Encrypted update received:/i.test(text)) {
    job.phase = 'receiving';
    // Incoming data is still staged, but the final part can transition into a
    // synchronous checkpoint/apply immediately. Conservatively disable hard
    // process cancellation from the first authenticated incoming part onward.
    job.cancelSafe = false;
  } else if (/Sending the encrypted update|Peer received encrypted update:|Encrypted .*update sent:/i.test(text)) {
    job.phase = 'sending';
  } else if (/safely verifying and applying|Verifying, checkpointing, and applying|^\s*Applying the peer/i.test(text)) {
    job.phase = 'applying';
    job.cancelSafe = false;
  } else if (/^\s*(?:.* )?Applied \d+ update|Backed up replaced\/deleted files/i.test(text)) {
    job.phase = 'applying';
    job.cancelSafe = false;
  } else if (/Peer applied our bundle|final acknowledgement|waiting for both devices/i.test(text)) {
    job.phase = 'confirming';
    job.cancelSafe = false;
  } else if (/Both devices confirmed|Saved the last successful sync baseline/i.test(text)) {
    job.phase = 'committing';
  } else if (/Sync complete on both devices/i.test(text)) {
    job.phase = 'completed';
  }

  for (const match of text.matchAll(/\b(\d{1,3})%/g)) {
    const value = Number(match[1]);
    if (value < 1 || value > 99) continue;
    if (/Peer received encrypted update|Encrypted .*update sent:/i.test(text)) {
      job.transferProgress.sending = Math.max(job.transferProgress.sending || 0, value);
    } else if (/Encrypted update received:/i.test(text)) {
      job.transferProgress.receiving = Math.max(job.transferProgress.receiving || 0, value);
    }
  }
}

function appendJobLine(job, text, stream) {
  if (!job || !text.trim()) return;
  job.logs.push({ stream, text, at: new Date().toISOString() });
  if (job.logs.length > MAX_LOG) job.logs.splice(0, job.logs.length - MAX_LOG);
  updateJobPhase(job, text);
  const recent = job.logs.slice(-4).map((line) => line.text).join(' ');
  const code = recent.match(/Your pairing code:\s*([A-Za-z0-9_-]{6,128})/);
  if (code) job.pairingCode = code[1];
}

function appendJobOutput(job, chunk, stream, flush) {
  if (!job) return;
  const key = stream === 'error' ? 'stderrBuffer' : 'stdoutBuffer';
  const clean = (job[key] || '') + stripAnsi(chunk).replace(/\r/g, '');
  const lines = clean.split('\n');
  job[key] = flush ? '' : lines.pop();
  if (flush && lines.length && lines.at(-1) === '') lines.pop();
  for (const text of lines) appendJobLine(job, text, stream);
  if (flush && job[key]) {
    appendJobLine(job, job[key], stream);
    job[key] = '';
  }
}

function startJob(appState, type, args) {
  const { root } = requireProject(appState);
  if (appState.job && appState.job.status === 'running') {
    throw Object.assign(new Error('Another Carry operation is already running'), { statusCode: 409 });
  }
  const child = spawn(process.execPath, [CARRY_BIN, ...args], {
    cwd: root,
    env: { ...process.env, FORCE_COLOR: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const job = {
    id: crypto.randomBytes(6).toString('hex'),
    type,
    status: 'running',
    startedAt: new Date().toISOString(),
    endedAt: null,
    pairingCode: null,
    logs: [],
    error: null,
    phase: 'starting',
    transferProgress: { sending: 0, receiving: 0 },
    operation: null,
    transport: null,
    cancelSafe: true,
    stdoutBuffer: '',
    stderrBuffer: '',
    child,
  };
  appState.job = job;
  child.stdout.on('data', (chunk) => appendJobOutput(job, chunk, 'out'));
  child.stderr.on('data', (chunk) => appendJobOutput(job, chunk, 'error'));
  child.on('error', (err) => {
    job.status = 'error';
    job.phase = 'error';
    job.error = err.message;
    job.endedAt = new Date().toISOString();
  });
  child.on('close', (code) => {
    appendJobOutput(job, '', 'out', true);
    appendJobOutput(job, '', 'error', true);
    if (job.status !== 'cancelled') {
      job.status = code === 0 ? 'success' : 'error';
      job.phase = code === 0 ? 'completed' : 'error';
      job.error = code === 0 ? null : (job.controlError || job.logs.filter((line) => line.stream === 'error').at(-1)?.text || `Carry exited with code ${code}`);
      job.endedAt = new Date().toISOString();
    }
    delete job.child;
    appState.pendingCache = null;
    appState.fileCache = null;
    finishRemoteJob(appState, job);
  });
  return publicJob(job);
}

function publicJob(job) {
  if (!job) return null;
  return {
    id: job.id,
    type: job.type,
    status: job.status,
    startedAt: job.startedAt,
    endedAt: job.endedAt,
    pairingCode: job.pairingCode,
    logs: job.logs,
    error: job.error,
    phase: job.phase,
    transferProgress: job.transferProgress,
    operation: job.operation,
    transport: job.transport,
    cancelSafe: job.cancelSafe !== false,
  };
}

function remoteEndpointActive(appState, endpoint) {
  const session = appState.remoteSession;
  return Boolean(session && (session === endpoint ||
    (session.members instanceof Map && session.members.get(endpoint.peerId) === endpoint)));
}

function remoteEndpointForJob(appState, jobId) {
  const session = appState.remoteSession;
  if (!session) return null;
  if (session.jobId === jobId) return session;
  if (session.members instanceof Map) {
    for (const member of session.members.values()) {
      if (member.jobId === jobId) return member;
    }
  }
  return null;
}

function resolveRemoteSessionPeer(appState) {
  const session = appState.remoteSession;
  if (!session || session.peerId || !appState.root || session.role !== 'joiner') return null;
  const known = session.knownPeerIds instanceof Set ? session.knownPeerIds : new Set();
  const candidates = manifest.listPeers(appState.root).filter((item) =>
    item.transport === 'relay' && item.connectionEnabled !== false);
  // A renewed invitation may intentionally pair the same trusted team host
  // again. Prefer a newly added device, but recover the sole matching existing
  // host so background control is restored after reinstall/re-pair.
  const pairedSinceStart = candidates
    .filter((item) => Date.parse(item.pairedAt || '') >= Date.parse(session.startedAt || ''))
    .sort((a, b) => Date.parse(b.pairedAt || '') - Date.parse(a.pairedAt || ''));
  const peer = candidates.find((item) => !known.has(item.deviceId)) ||
    pairedSinceStart[0] || (candidates.length === 1 ? candidates[0] : null);
  if (!peer) return null;
  session.peerId = peer.deviceId;
  session.secret = peer.pairCode;
  session.connectionInvite = relay.createRemoteInvite(session.relayAddress, peer.pairCode);
  session.action = 'sync';
  startRemoteControl(appState, session);
  return peer;
}

function settlePendingSyncRequest(session, requestId, error, result) {
  const pending = session && session.pendingSyncRequest;
  if (!pending || pending.requestId !== requestId) return false;
  clearTimeout(pending.timer);
  session.pendingSyncRequest = null;
  session.outgoingRequestId = null;
  if (error) pending.reject(error);
  else pending.resolve(result || {});
  return true;
}

function rejectPendingSyncRequest(session, message) {
  const pending = session && session.pendingSyncRequest;
  if (!pending) return;
  const error = Object.assign(new Error(message), { statusCode: 409 });
  settlePendingSyncRequest(session, pending.requestId, error);
}

function finishRemoteJob(appState, job) {
  const endpoint = remoteEndpointForJob(appState, job.id);
  if (!endpoint) return;
  endpoint.jobId = null;
  endpoint.awaitingSyncRequest = false;
  endpoint.lastActivityAt = new Date().toISOString();
  if (job.status === 'success') {
    endpoint.error = null;
    resolveRemoteSessionPeer(appState);
  } else {
    // A failed or cancelled operation does not revoke the invitation. The
    // user can retry through the same encrypted relay.
    endpoint.error = job.status === 'cancelled' ? null : job.error;
  }
}

function publicRemoteSession(appState) {
  const session = appState.remoteSession;
  if (!session) return null;
  resolveRemoteSessionPeer(appState);
  if (session.members instanceof Map) {
    const members = [...session.members.values()].map((member) => ({
      peerId: member.peerId,
      peerOnline: Boolean(member.peerOnline),
      controlStatus: member.controlStatus || 'offline',
      connectionEnabled: member.status !== 'disconnected',
    }));
    const selected = session.members.get(appState.selectedPeerId) ||
      (members.length ? session.members.get(members[0].peerId) : null);
    return {
      status: session.status,
      role: session.role,
      action: session.action,
      peerId: selected ? selected.peerId : null,
      invite: session.status === 'ready' ? session.invite : null,
      startedAt: session.startedAt,
      lastActivityAt: session.lastActivityAt || session.startedAt,
      error: selected && selected.error || session.error || session.pairingError || null,
      peerOnline: Boolean(selected && selected.peerOnline),
      controlStatus: selected ? selected.controlStatus || 'offline' : 'waiting',
      maxDevices: session.maxDevices,
      deviceCount: 1 + members.length,
      availableSlots: Math.max(0, session.maxDevices - 1 - members.length),
      members,
    };
  }
  return {
    status: session.status,
    role: session.role,
    action: session.action,
    peerId: session.peerId || null,
    invite: session.status === 'ready' ? session.invite : null,
    startedAt: session.startedAt,
    lastActivityAt: session.lastActivityAt || session.startedAt,
    error: session.error || null,
    peerOnline: Boolean(session.peerOnline),
    controlStatus: session.controlStatus || 'offline',
    maxDevices: 2,
    deviceCount: session.peerId ? 2 : 1,
    availableSlots: session.peerId ? 0 : 1,
    members: session.peerId ? [{
      peerId: session.peerId,
      peerOnline: Boolean(session.peerOnline),
      controlStatus: session.controlStatus || 'offline',
    }] : [],
  };
}

function closeRemoteControl(session) {
  if (!session) return;
  rejectPendingSyncRequest(session, 'The remote control connection closed before the sync was confirmed. Try again.');
  session.controlGeneration = (session.controlGeneration || 0) + 1;
  if (session.controlReconnectTimer) clearTimeout(session.controlReconnectTimer);
  session.controlReconnectTimer = null;
  if (session.controlHeartbeatTimer) clearInterval(session.controlHeartbeatTimer);
  session.controlHeartbeatTimer = null;
  if (session.controlClient) {
    try { session.controlClient.close(); } catch { /* already closed */ }
  }
  session.controlClient = null;
  session.peerOnline = false;
  session.controlStatus = 'offline';
}

function checkJoinerRelayHealth(appState, session) {
  if (!session || session.role !== 'joiner' || !session.relayAddress || session.controlHealthCheck) return;
  const generation = session.controlGeneration;
  const check = Promise.resolve(tunnel.probeTunnelHealth(session.relayAddress))
    .then((health) => {
      if (!remoteEndpointActive(appState, session) || session.status !== 'ready' ||
          session.controlGeneration !== generation || !health || Number(health.status) < 500 ||
          !tunnel.isTemporaryTunnelAddress(session.relayAddress)) return;
      closeRemoteControl(session);
      session.status = 'error';
      session.error = tunnel.TUNNEL_EXPIRED_MESSAGE;
      session.lastActivityAt = new Date().toISOString();
    })
    .catch(() => {})
    .finally(() => {
      if (session.controlHealthCheck === check) session.controlHealthCheck = null;
    });
  session.controlHealthCheck = check;
}

function scheduleRemoteControlReconnect(appState, session) {
  if (!session || !remoteEndpointActive(appState, session) || session.status !== 'ready' || session.controlReconnectTimer) return;
  rejectPendingSyncRequest(session, 'The remote device went offline before confirming the sync. Try again when it reconnects.');
  if (session.controlHeartbeatTimer) clearInterval(session.controlHeartbeatTimer);
  session.controlHeartbeatTimer = null;
  if (session.controlClient) {
    try { session.controlClient.close(); } catch { /* already closed */ }
    session.controlClient = null;
  }
  session.peerOnline = false;
  session.controlStatus = 'reconnecting';
  checkJoinerRelayHealth(appState, session);
  session.controlReconnectAttempts = Math.min(5, (session.controlReconnectAttempts || 0) + 1);
  const reconnectDelay = Math.min(15000,
    CONTROL_RECONNECT_MS * (2 ** Math.max(0, session.controlReconnectAttempts - 1)));
  session.controlReconnectTimer = setTimeout(() => {
    session.controlReconnectTimer = null;
    startRemoteControlForEndpoint(appState, session);
  }, reconnectDelay);
  session.controlReconnectTimer.unref?.();
}

function rememberControlRequest(session, requestId) {
  if (!session.controlRequests) session.controlRequests = new Set();
  session.controlRequests.add(requestId);
  while (session.controlRequests.size > MAX_CONTROL_REQUESTS) {
    session.controlRequests.delete(session.controlRequests.values().next().value);
  }
}

function handleRemoteControlFrame(appState, session, frame, respond) {
  if (!remoteEndpointActive(appState, session) || session.status !== 'ready' || !frame || typeof frame !== 'object') return;
  if (frame.type === 'relay-ready') {
    session.controlReconnectAttempts = 0;
    session.peerOnline = true;
    session.controlStatus = 'ready';
    session.error = null;
    session.lastActivityAt = new Date().toISOString();
    session.lastPeerControlAt = Date.now();
    return;
  }
  if (frame.type === 'peer-gone' || frame.type === 'relay-error') {
    scheduleRemoteControlReconnect(appState, session);
    return;
  }

  resolveRemoteSessionPeer(appState);
  const peerId = session.peerId;
  if (!peerId || frame.from !== peerId) return;
  session.lastActivityAt = new Date().toISOString();
  session.lastPeerControlAt = Date.now();
  session.peerOnline = true;
  session.controlStatus = 'ready';

  if (frame.type === 'control-ping') {
    respond({ type: 'control-pong', from: manifest.readManifest(appState.root).deviceId });
    return;
  }
  if (frame.type === 'control-pong') return;

  if (frame.type === 'sync-request') {
    const requestId = String(frame.requestId || '');
    if (!/^[a-f0-9]{24}$/i.test(requestId)) return;
    if (session.controlRequests && session.controlRequests.has(requestId)) {
      respond({ type: 'sync-request-ack', from: manifest.readManifest(appState.root).deviceId, requestId, duplicate: true });
      return;
    }
    rememberControlRequest(session, requestId);
    const requestedSyncRunId = frame.syncRunId === undefined ? null : String(frame.syncRunId).toLowerCase();
    if (requestedSyncRunId !== null &&
        (!relay.SYNC_RUN_PATTERN.test(requestedSyncRunId) || requestedSyncRunId !== requestId.toLowerCase())) {
      respond({
        type: 'sync-request-reject', from: manifest.readManifest(appState.root).deviceId, requestId,
        message: 'The requested relay sync run is invalid',
      });
      return;
    }
    const running = appState.job && appState.job.status === 'running';
    if (running && String(appState.job.type).startsWith('remote-sync-')) {
      const runningEndpoint = remoteEndpointForJob(appState, appState.job.id);
      if (runningEndpoint === session) {
        if (session.awaitingSyncRequest) {
          // Joining a freshly pasted sync invitation starts the data child
          // before its control channel is ready. The first host request binds to
          // that deliberately prestarted child instead of launching a second.
          session.awaitingSyncRequest = false;
          respond({
            type: 'sync-request-ack', from: manifest.readManifest(appState.root).deviceId, requestId,
            alreadyRunning: true, prestartedSync: true,
          });
        } else {
          // Every ordinary user-initiated sync has a fresh request id. A
          // repeated frame for the same request was handled by controlRequests
          // above, so this belongs to the next sync, not the running one.
          // Acknowledging it would open a new data-room child on only one side;
          // one device then waits forever and the other reports peer-gone.
          respond({
            type: 'sync-request-reject',
            from: manifest.readManifest(appState.root).deviceId,
            requestId,
            message: 'The remote device is still finishing the previous sync. Try again in a moment.',
          });
        }
      } else {
        respond({ type: 'sync-request-reject', from: manifest.readManifest(appState.root).deviceId, requestId, message: 'This device is already syncing with another team member' });
      }
      return;
    }
    if (running) {
      respond({ type: 'sync-request-reject', from: manifest.readManifest(appState.root).deviceId, requestId, message: 'The remote device is busy with another Carry operation' });
      return;
    }
    try {
      const peer = remotePeer(appState, peerId);
      const project = manifest.readManifest(appState.root);
      const syncSourceDeviceId = syncEngine.normalizeSyncSourceDeviceId(frame.syncSourceDeviceId);
      if (syncSourceDeviceId && syncSourceDeviceId !== project.deviceId && syncSourceDeviceId !== peerId) {
        throw new Error('The requested sync source is not one of the paired devices');
      }
      if (frame.experimentalDirect !== undefined && typeof frame.experimentalDirect !== 'boolean') {
        throw new Error('The requested direct-transfer option is invalid');
      }
      startRemoteSyncJob(appState, peer, {
        notifyPeer: false,
        syncSourceDeviceId,
        experimentalDirect: frame.experimentalDirect === true,
        syncRunId: requestedSyncRunId,
      });
      respond({
        type: 'sync-request-ack', from: manifest.readManifest(appState.root).deviceId, requestId,
        ...(requestedSyncRunId ? { syncRunId: requestedSyncRunId } : {}),
      });
    } catch (error) {
      respond({ type: 'sync-request-reject', from: manifest.readManifest(appState.root).deviceId, requestId, message: error.message });
    }
    return;
  }

  if (frame.type === 'sync-request-ack' && frame.requestId === session.outgoingRequestId) {
    const syncRunId = frame.syncRunId === undefined ? null : String(frame.syncRunId).toLowerCase();
    if (frame.alreadyRunning !== undefined && typeof frame.alreadyRunning !== 'boolean') {
      settlePendingSyncRequest(session, frame.requestId,
        Object.assign(new Error('The remote device sent an invalid sync acknowledgement'), { statusCode: 409 }));
      return;
    }
    if (frame.prestartedSync !== undefined && typeof frame.prestartedSync !== 'boolean') {
      settlePendingSyncRequest(session, frame.requestId,
        Object.assign(new Error('The remote device sent an invalid sync acknowledgement'), { statusCode: 409 }));
      return;
    }
    if (frame.prestartedSync === true && frame.alreadyRunning !== true) {
      settlePendingSyncRequest(session, frame.requestId,
        Object.assign(new Error('The remote device sent a contradictory sync acknowledgement'), { statusCode: 409 }));
      return;
    }
    if (frame.alreadyRunning === true && frame.prestartedSync !== true) {
      // Some older peers acknowledged every request received while their last
      // data child was still closing. Starting our child from that ACK creates
      // a one-sided relay room: one UI stays on Connecting while the other
      // reports peer-gone. New peers explicitly identify the one legitimate
      // case: a child prestarted by a freshly pasted sync invitation.
      settlePendingSyncRequest(session, frame.requestId,
        Object.assign(new Error('The remote device is still finishing the previous sync. Try again in a moment.'), { statusCode: 409 }));
      return;
    }
    if (syncRunId !== null &&
        (!relay.SYNC_RUN_PATTERN.test(syncRunId) || syncRunId !== String(frame.requestId).toLowerCase() ||
         frame.alreadyRunning === true)) {
      settlePendingSyncRequest(session, frame.requestId,
        Object.assign(new Error('The remote device acknowledged an invalid relay sync run'), { statusCode: 409 }));
      return;
    }
    settlePendingSyncRequest(session, frame.requestId, null, {
      alreadyRunning: frame.alreadyRunning === true,
      syncRunId,
    });
    return;
  }
  if (frame.type === 'sync-request-reject' && frame.requestId === session.outgoingRequestId) {
    const message = String(frame.message || 'The remote device could not start the sync');
    session.error = message;
    settlePendingSyncRequest(session, frame.requestId,
      Object.assign(new Error(message), { statusCode: 409 }));
  }
}

function startRemoteControl(appState) {
  return startRemoteControlForEndpoint(appState, appState.remoteSession);
}

function startRemoteControlForEndpoint(appState, session) {
  if (!session || session.status !== 'ready' || !session.connectionInvite || !session.secret || !appState.root) return;
  if (session.controlReconnectTimer) clearTimeout(session.controlReconnectTimer);
  session.controlReconnectTimer = null;
  if (session.controlHeartbeatTimer) clearInterval(session.controlHeartbeatTimer);
  session.controlHeartbeatTimer = null;
  if (session.controlClient) {
    try { session.controlClient.close(); } catch { /* old control socket already closed */ }
  }
  const project = manifest.readManifest(appState.root);
  if (!project) return;
  const client = new relay.RelayClient();
  client.setRelay(session.connectionInvite);
  const generation = (session.controlGeneration || 0) + 1;
  session.controlGeneration = generation;
  session.controlClient = client;
  session.peerOnline = false;
  session.controlStatus = 'connecting';
  session.lastPeerControlAt = 0;
  client.join(session.secret, project.deviceId, (frame, respond) => {
    if (!remoteEndpointActive(appState, session) || session.controlGeneration !== generation || session.controlClient !== client) return;
    handleRemoteControlFrame(appState, session, frame, respond);
  }, project.name, session.secret, relay.controlRoomForSecret(session.secret)).then(() => {
    if (!remoteEndpointActive(appState, session) || session.controlGeneration !== generation || session.controlClient !== client) return;
    if (!session.peerOnline) session.controlStatus = 'waiting';
  }).catch((error) => {
    if (!remoteEndpointActive(appState, session) || session.controlGeneration !== generation || session.controlClient !== client) return;
    session.error = error.message;
    scheduleRemoteControlReconnect(appState, session);
  });
  session.controlHeartbeatTimer = setInterval(() => {
    if (!remoteEndpointActive(appState, session) || session.controlGeneration !== generation || session.controlClient !== client) return;
    if (session.peerOnline && session.lastPeerControlAt && Date.now() - session.lastPeerControlAt > CONTROL_STALE_MS) {
      scheduleRemoteControlReconnect(appState, session);
      return;
    }
    try {
      client.send({ type: 'control-ping', from: project.deviceId });
    } catch {
      scheduleRemoteControlReconnect(appState, session);
    }
  }, CONTROL_HEARTBEAT_MS);
  session.controlHeartbeatTimer.unref?.();
}

function closeTeamLobby(session) {
  if (!session) return;
  session.lobbyGeneration = (session.lobbyGeneration || 0) + 1;
  if (session.lobbyRestartTimer) clearTimeout(session.lobbyRestartTimer);
  session.lobbyRestartTimer = null;
  if (session.lobbyClient) {
    try { session.lobbyClient.close(); } catch { /* lobby already closed */ }
  }
  session.lobbyClient = null;
}

function teamHasSpace(session) {
  return session.members instanceof Map && 1 + session.members.size < session.maxDevices;
}

function scheduleTeamLobby(appState, session) {
  if (!remoteEndpointActive(appState, session) || session.status !== 'ready' ||
      !teamHasSpace(session) || session.lobbyRestartTimer || session.lobbyClient) return;
  session.lobbyRestartTimer = setTimeout(() => {
    session.lobbyRestartTimer = null;
    startTeamLobby(appState, session);
  }, 250);
  session.lobbyRestartTimer.unref?.();
}

function updateTeamLobbyAvailability(appState, session) {
  if (!(session.allowedRooms instanceof Set) || !session.lobbyRoom) return;
  if (teamHasSpace(session)) {
    session.allowedRooms.add(session.lobbyRoom);
    session.deniedRoomMessages?.delete(session.lobbyRoom);
    scheduleTeamLobby(appState, session);
  } else {
    session.allowedRooms.delete(session.lobbyRoom);
    session.deniedRoomMessages?.set(
      session.lobbyRoom,
      `This Carry team has reached its ${session.maxDevices}-device limit`,
    );
    closeTeamLobby(session);
  }
}

function addTeamMember(appState, session, deviceId, peerName) {
  const { root, project } = requireProject(appState);
  const id = String(deviceId || '');
  const name = String(peerName || '').trim().slice(0, 80);
  if (!/^[A-Za-z0-9_-]{6,128}$/.test(id) || id === project.deviceId || !name || /[\r\n\0]/.test(name)) {
    throw new Error('Team member sent an invalid encrypted identity');
  }
  const existing = session.members.get(id);
  if (!existing && !teamHasSpace(session)) throw new Error(`This Carry team has reached its ${session.maxDevices}-device limit`);
  const pairCode = relay.newRemoteSecret();
  manifest.addPeer(root, id, name, 'relay', {
    address: session.publicAddress,
    pairCode,
    teamCode: session.teamSecret,
  });

  if (existing) {
    closeRemoteControl(existing);
    session.allowedRooms.delete(relay.roomForSecret(existing.secret));
    session.allowedRooms.delete(relay.controlRoomForSecret(existing.secret));
  }
  session.allowedRooms.add(relay.roomForSecret(pairCode));
  session.allowedRooms.add(relay.controlRoomForSecret(pairCode));
  const endpoint = {
    status: 'ready',
    role: 'host',
    action: 'sync',
    peerId: id,
    secret: pairCode,
    connectionInvite: relay.createRemoteInvite(session.localAddress, pairCode),
    startedAt: existing ? existing.startedAt : new Date().toISOString(),
    lastActivityAt: new Date().toISOString(),
    error: null,
    jobId: null,
    controlClient: null,
    controlReconnectTimer: null,
    controlHeartbeatTimer: null,
    controlGeneration: 0,
    controlReconnectAttempts: 0,
    controlStatus: 'offline',
    controlRequests: new Set(),
    peerOnline: false,
    outgoingRequestId: null,
    lastPeerControlAt: 0,
  };
  session.members.set(id, endpoint);
  session.pairingError = null;
  session.lastActivityAt = new Date().toISOString();
  if (!appState.selectedPeerId) appState.selectedPeerId = id;
  startRemoteControlForEndpoint(appState, endpoint);
  return endpoint;
}

function startTeamLobby(appState, session) {
  if (!remoteEndpointActive(appState, session) || session.status !== 'ready' ||
      !teamHasSpace(session) || session.lobbyClient) return;
  const { project } = requireProject(appState);
  const client = new relay.RelayClient();
  client.setRelay(session.lobbyConnectionInvite);
  const generation = (session.lobbyGeneration || 0) + 1;
  session.lobbyGeneration = generation;
  session.lobbyClient = client;
  let paired = false;
  const restart = (message) => {
    if (!remoteEndpointActive(appState, session) || session.lobbyGeneration !== generation || session.lobbyClient !== client) return;
    if (message) session.pairingError = message;
    try { client.close(); } catch { /* lobby already closed */ }
    session.lobbyClient = null;
    scheduleTeamLobby(appState, session);
  };
  client.join(session.teamSecret, project.deviceId, (frame, respond) => {
    if (!remoteEndpointActive(appState, session) || session.lobbyGeneration !== generation || session.lobbyClient !== client) return;
    if (frame.type === 'pair-intro' && !paired) {
      paired = true;
      try {
        if (frame.teamJoiner !== true) throw new Error('Update Carry before joining this team invitation');
        const endpoint = addTeamMember(appState, session, frame.deviceId, frame.name);
        respond({
          type: 'pair-team-accept',
          deviceId: project.deviceId,
          name: project.name,
          pairCode: endpoint.secret,
        });
        const finish = setTimeout(() => {
          restart(null);
          updateTeamLobbyAvailability(appState, session);
        }, 100);
        finish.unref?.();
      } catch (error) {
        respond({ type: 'pair-team-reject', message: error.message });
        const finish = setTimeout(() => restart(null), 100);
        finish.unref?.();
      }
      return;
    }
    if (frame.type === 'peer-gone') restart(null);
    else if (frame.type === 'relay-error') restart(frame.message || 'Team pairing relay error');
  }, project.name, session.teamSecret).catch((error) => restart(error.message));
}

function removeTeamMember(appState, session, peerId) {
  if (!(session.members instanceof Map)) return false;
  const endpoint = session.members.get(peerId);
  if (!endpoint) return false;
  closeRemoteControl(endpoint);
  session.members.delete(peerId);
  session.allowedRooms?.delete(relay.roomForSecret(endpoint.secret));
  session.allowedRooms?.delete(relay.controlRoomForSecret(endpoint.secret));
  // Every joiner knew the old team invitation. Rotate the shared lobby
  // capability so a disconnected member (or a copied old invite) cannot
  // immediately rejoin under another device id. Existing pairwise rooms keep
  // their independent secrets and remain online.
  const oldLobbyRoom = session.lobbyRoom;
  closeTeamLobby(session);
  if (oldLobbyRoom) {
    session.allowedRooms?.delete(oldLobbyRoom);
    session.deniedRoomMessages?.set(oldLobbyRoom, 'This Carry team invitation was rotated after a device was disconnected');
  }
  session.teamSecret = relay.newRemoteSecret();
  session.lobbyRoom = relay.roomForSecret(session.teamSecret);
  session.lobbyConnectionInvite = relay.createRemoteInvite(session.localAddress, session.teamSecret);
  session.invite = relay.createRemoteInvite(session.publicAddress, session.teamSecret);
  session.allowedRooms?.add(session.lobbyRoom);
  updateTeamLobbyAvailability(appState, session);
  return true;
}

function setTeamMemberConnected(appState, session, peer, enabled) {
  if (!(session.members instanceof Map)) return false;
  const endpoint = session.members.get(peer.deviceId);
  if (!endpoint) return false;
  closeRemoteControl(endpoint);
  endpoint.status = enabled ? 'ready' : 'disconnected';
  endpoint.error = null;
  endpoint.lastActivityAt = new Date().toISOString();
  const dataRoom = relay.roomForSecret(endpoint.secret);
  const controlRoom = relay.controlRoomForSecret(endpoint.secret);
  if (enabled) {
    session.allowedRooms?.add(dataRoom);
    session.allowedRooms?.add(controlRoom);
    startRemoteControlForEndpoint(appState, endpoint);
  } else {
    session.allowedRooms?.delete(dataRoom);
    session.allowedRooms?.delete(controlRoom);
  }
  return true;
}

function storedJoinerSession(appState, peer) {
  if (!relay.REMOTE_SECRET_PATTERN.test(String(peer.pairCode || '')) || !peer.address) {
    throw Object.assign(new Error('This device has no saved private remote connection. Pair it again using Different network.'), { statusCode: 409 });
  }
  if (peer.teamCode && timingSafeTextEqual(
    peer.pairCode,
    relay.legacyPairSecretForTeam(peer.teamCode, requireProject(appState).project.deviceId, peer.deviceId),
  )) {
    throw Object.assign(new Error('This pairing used an older derivable team key. Forget it and pair again with a fresh invitation.'), { statusCode: 409 });
  }
  const connectionInvite = relay.createRemoteInvite(peer.address, peer.pairCode);
  const remote = relay.parseRelayAddress(connectionInvite);
  if (remote.transport !== 'websocket') {
    throw Object.assign(new Error('This device does not have a reconnectable private relay address'), { statusCode: 409 });
  }
  const session = {
    status: 'ready',
    role: 'joiner',
    action: 'sync',
    peerId: peer.deviceId,
    syncSourceDeviceId: null,
    secret: peer.pairCode,
    teamSecret: null,
    relayAddress: remote.address,
    knownPeerIds: new Set(manifest.listPeers(appState.root).map((item) => item.deviceId)),
    invite: null,
    connectionInvite,
    startedAt: new Date().toISOString(),
    lastActivityAt: new Date().toISOString(),
    error: null,
    server: null,
    tunnel: null,
    jobId: null,
    controlClient: null,
    controlReconnectTimer: null,
    controlHeartbeatTimer: null,
    controlGeneration: 0,
    controlStatus: 'offline',
    controlRequests: new Set(),
    peerOnline: false,
    outgoingRequestId: null,
    lastPeerControlAt: 0,
  };
  appState.remoteSession = session;
  startRemoteControlForEndpoint(appState, session);
  return session;
}

function disconnectSavedPeer(appState, peer) {
  const session = appState.remoteSession;
  if (!session) return;
  if (session.members instanceof Map) {
    setTeamMemberConnected(appState, session, peer, false);
    return;
  }
  if (session.peerId !== peer.deviceId) return;
  closeRemoteControl(session);
  session.status = 'disconnected';
  session.error = null;
  if (session.allowedRooms instanceof Set) {
    session.allowedRooms.delete(relay.roomForSecret(peer.pairCode));
    session.allowedRooms.delete(relay.controlRoomForSecret(peer.pairCode));
  }
}

function connectSavedPeer(appState, peer) {
  const session = appState.remoteSession;
  if (session && session.members instanceof Map) {
    if (!setTeamMemberConnected(appState, session, peer, true)) {
      throw Object.assign(new Error('This trusted device is not part of the currently open team session'), { statusCode: 409 });
    }
    return;
  }
  if (session && session.peerId === peer.deviceId && session.connectionInvite && session.secret) {
    session.status = 'ready';
    session.error = null;
    if (session.allowedRooms instanceof Set) {
      session.allowedRooms.add(relay.roomForSecret(peer.pairCode));
      session.allowedRooms.add(relay.controlRoomForSecret(peer.pairCode));
    }
    startRemoteControlForEndpoint(appState, session);
    return;
  }
  if (session && ['starting', 'ready'].includes(session.status)) {
    throw Object.assign(new Error('Another private remote session is already active'), { statusCode: 409 });
  }
  if (session) closeRemoteSessionResources(session, 'stopped');
  storedJoinerSession(appState, peer);
}

function closeRemoteSessionResources(session, status) {
  if (!session) return;
  closeRemoteControl(session);
  closeTeamLobby(session);
  if (session.members instanceof Map) {
    for (const member of session.members.values()) closeRemoteControl(member);
    session.members.clear();
  }
  if (session.tunnel) {
    try { session.tunnel.stop(); } catch { /* tunnel already stopped */ }
    session.tunnel = null;
  }
  if (session.server) {
    try { session.server.close(); } catch { /* relay already stopped */ }
    session.server = null;
  }
  session.invite = null;
  session.connectionInvite = null;
  session.secret = null;
  session.jobId = null;
  session.status = status || 'stopped';
}

function stopRemoteSession(appState, status) {
  closeRemoteSessionResources(appState.remoteSession, status);
}

function waitForListening(server) {
  if (server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const onListening = () => { cleanup(); resolve(); };
    const onError = (error) => { cleanup(); reject(error); };
    const cleanup = () => {
      server.off('listening', onListening);
      server.off('error', onError);
    };
    server.once('listening', onListening);
    server.once('error', onError);
  });
}

function remotePeer(appState, peerId) {
  const { root } = requireProject(appState);
  const id = String(peerId || appState.selectedPeerId || '');
  const peer = manifest.listPeers(root).find((item) => item.deviceId === id);
  if (!peer) throw Object.assign(new Error('Choose the paired device for this remote sync'), { statusCode: 409 });
  if (peer.connectionEnabled === false) {
    throw Object.assign(new Error('This device is disconnected. Reconnect it from Devices before syncing.'), { statusCode: 409 });
  }
  if (!relay.REMOTE_SECRET_PATTERN.test(String(peer.pairCode || ''))) {
    throw Object.assign(new Error('This device was paired with a short LAN code. Pair it once using Different network to create a strong remote key.'), { statusCode: 409 });
  }
  return peer;
}

function activeRemoteSessionForPeer(appState, peer) {
  const session = appState.remoteSession;
  if (!session || session.status !== 'ready') return null;
  if (session.members instanceof Map) return session.members.get(peer.deviceId) || null;
  if (!session.connectionInvite) return null;
  if (!timingSafeTextEqual(session.secret, peer.pairCode)) return null;
  if (session.peerId && session.peerId !== peer.deviceId) return null;
  session.peerId = peer.deviceId;
  return session;
}

function syncSourceForDirection(project, peer, value) {
  const direction = String(value || 'smart').toLowerCase();
  if (!['smart', 'push', 'pull'].includes(direction)) {
    throw Object.assign(new Error('Sync direction must be Smart, Push, or Pull'), { statusCode: 400 });
  }
  if (direction === 'push') return project.deviceId;
  if (direction === 'pull') return peer.deviceId;
  return null;
}

function syncArgs(peer, relayInvite, syncSourceDeviceId, experimentalDirect, syncRunId) {
  return [
    'sync', '--peer', peer.deviceId,
    ...(relayInvite ? ['--relay', relayInvite] : []),
    ...(syncSourceDeviceId ? ['--source-device', syncSourceDeviceId] : []),
    ...(experimentalDirect ? ['--direct'] : []),
    ...(syncRunId ? ['--sync-run', syncRunId] : []),
  ];
}

function startRemoteSyncJob(appState, peer, options) {
  const endpoint = activeRemoteSessionForPeer(appState, peer);
  if (!endpoint) {
    throw Object.assign(new Error('Open a Different network invitation for this device before syncing'), { statusCode: 409 });
  }
  endpoint.error = null;
  endpoint.awaitingSyncRequest = false;
  endpoint.lastActivityAt = new Date().toISOString();
  const project = manifest.readManifest(appState.root);
  const syncSourceDeviceId = syncEngine.normalizeSyncSourceDeviceId(options && options.syncSourceDeviceId);
  const experimentalDirect = Boolean(options && options.experimentalDirect === true);
  const syncRunId = options && options.syncRunId ? String(options.syncRunId).toLowerCase() : null;
  if (syncRunId && !relay.SYNC_RUN_PATTERN.test(syncRunId)) {
    throw Object.assign(new Error('Sync run id is invalid'), { statusCode: 400 });
  }
  if (syncSourceDeviceId && syncSourceDeviceId !== project.deviceId && syncSourceDeviceId !== peer.deviceId) {
    throw Object.assign(new Error('Sync source must be this device or the selected peer'), { statusCode: 400 });
  }
  const jobRole = endpoint.role === 'joiner' ? 'join' : 'host';
  const job = startJob(appState, `remote-sync-${jobRole}`,
    syncArgs(peer, endpoint.connectionInvite, syncSourceDeviceId, experimentalDirect, syncRunId));
  endpoint.jobId = job.id;
  return job;
}

async function requestRemoteSyncJob(appState, peer, options) {
  const endpoint = activeRemoteSessionForPeer(appState, peer);
  if (!endpoint) {
    throw Object.assign(new Error('Open a Different network invitation for this device before syncing'), { statusCode: 409 });
  }
  if (!endpoint.controlClient || !endpoint.peerOnline || endpoint.controlStatus !== 'ready') {
    throw Object.assign(new Error('The remote device is offline. Leave Carry running in the background on that device, then try again.'), { statusCode: 409 });
  }
  if (endpoint.pendingSyncRequest) {
    throw Object.assign(new Error('Carry is already waiting for this device to confirm a sync'), { statusCode: 409 });
  }
  const project = manifest.readManifest(appState.root);
  const syncSourceDeviceId = syncEngine.normalizeSyncSourceDeviceId(options && options.syncSourceDeviceId);
  const experimentalDirect = Boolean(options && options.experimentalDirect === true);
  const requestId = crypto.randomBytes(12).toString('hex');
  endpoint.outgoingRequestId = requestId;
  const approval = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      settlePendingSyncRequest(endpoint, requestId,
        Object.assign(new Error('The remote device did not confirm the sync in time. Try again.'), { statusCode: 409 }));
    }, SYNC_REQUEST_TIMEOUT_MS);
    endpoint.pendingSyncRequest = { requestId, resolve, reject, timer };
  });
  try {
    endpoint.controlClient.send({
      type: 'sync-request', from: project.deviceId, requestId, syncRunId: requestId,
      ...(syncSourceDeviceId ? { syncSourceDeviceId } : {}),
      experimentalDirect,
    });
  } catch (error) {
    settlePendingSyncRequest(endpoint, requestId,
      Object.assign(error, { statusCode: error.statusCode || 409 }));
  }
  const approved = await approval;
  return startRemoteSyncJob(appState, peer, {
    notifyPeer: false,
    syncSourceDeviceId,
    experimentalDirect,
    // Older peers omit syncRunId and continue using the legacy shared room.
    // A prestarted invitation child likewise acknowledges without a run id.
    syncRunId: approved.syncRunId || null,
  });
}

async function startRemoteSession(appState, action, peerId, requestedMaxDevices, direction, experimentalDirect) {
  const { project } = requireProject(appState);
  if (appState.job && appState.job.status === 'running') {
    throw Object.assign(new Error('Another Carry operation is already running'), { statusCode: 409 });
  }
  if (appState.remoteSession && ['starting', 'ready'].includes(appState.remoteSession.status)) {
    throw Object.assign(new Error('A remote invitation is already active'), { statusCode: 409 });
  }
  if (!['pair', 'sync'].includes(action)) {
    throw Object.assign(new Error('Remote action must be pair or sync'), { statusCode: 400 });
  }

  const peer = action === 'sync' ? remotePeer(appState, peerId) : null;
  const syncSourceDeviceId = peer ? syncSourceForDirection(project, peer, direction) : null;
  experimentalDirect = experimentalDirect === true;
  const secret = peer ? peer.pairCode : relay.newRemoteSecret();
  const room = relay.roomForSecret(secret);
  const maxDevices = action === 'pair' ? Number.parseInt(requestedMaxDevices || DEFAULT_TEAM_DEVICES, 10) : 2;
  if (!Number.isInteger(maxDevices) || maxDevices < 2 || maxDevices > MAX_TEAM_DEVICES) {
    throw Object.assign(new Error(`Team size must be between 2 and ${MAX_TEAM_DEVICES} devices`), { statusCode: 400 });
  }
  const allowedRooms = new Set(action === 'pair'
    ? [room]
    : [room, relay.controlRoomForSecret(secret)]);
  const deniedRoomMessages = new Map();
  const session = {
    status: 'starting',
    role: 'host',
    action,
    peerId: peer ? peer.deviceId : null,
    syncSourceDeviceId,
    secret,
    invite: null,
    connectionInvite: null,
    startedAt: new Date().toISOString(),
    lastActivityAt: new Date().toISOString(),
    error: null,
    server: null,
    tunnel: null,
    jobId: null,
    controlClient: null,
    controlReconnectTimer: null,
    controlHeartbeatTimer: null,
    controlGeneration: 0,
    controlStatus: 'offline',
    controlRequests: new Set(),
    peerOnline: false,
    outgoingRequestId: null,
    lastPeerControlAt: 0,
    maxDevices,
    teamSecret: action === 'pair' ? secret : null,
    lobbyRoom: action === 'pair' ? room : null,
    lobbyConnectionInvite: null,
    lobbyClient: null,
    lobbyGeneration: 0,
    lobbyRestartTimer: null,
    pairingError: null,
    members: action === 'pair' ? new Map() : null,
    allowedRooms,
    deniedRoomMessages,
    publicAddress: null,
    localAddress: null,
  };
  appState.remoteSession = session;

  try {
    session.server = startWebRelay(0, {
      host: '127.0.0.1',
      quiet: true,
      ignoreAllowlist: true,
      allowedRooms,
      dynamicAllowedRooms: action === 'pair',
      deniedRoomMessages,
      // localhost.run terminates every public connection onto this loopback
      // listener, so all team members share one apparent source IP. The global
      // cap and opaque allowed-room set remain the meaningful protections.
      maxConnectionsPerIp: 64,
      maxConnectionsPerWindow: Math.max(30, maxDevices * 8),
    });
    await waitForListening(session.server);
    session.tunnel = await appState.remoteTunnelFactory({ relayPort: session.server.address().port });
    if (appState.remoteSession !== session || session.status !== 'starting') {
      throw new Error('Remote invitation creation was stopped before it finished');
    }
    const tunnelHandle = session.tunnel;
    if (tunnelHandle.closed && typeof tunnelHandle.closed.then === 'function') {
      tunnelHandle.closed.then((outcome) => {
        if (outcome && outcome.expected) return;
        if (appState.remoteSession !== session || session.tunnel !== tunnelHandle) return;
        session.error = outcome && outcome.error || 'The private remote tunnel disconnected. Create a new invitation and try again.';
        const runningJob = appState.job && appState.job.status === 'running' ? appState.job : null;
        const runningEndpoint = runningJob && remoteEndpointForJob(appState, runningJob.id);
        if (runningEndpoint && (runningEndpoint === session ||
            (session.members instanceof Map && session.members.get(runningEndpoint.peerId) === runningEndpoint))) {
          runningJob.controlError = session.error;
          // Before file application starts it is safe to stop immediately.
          // Once applying begins, closing the local relay wakes the child as
          // soon as its synchronous atomic apply finishes, avoiding a partial
          // working tree while still surfacing the tunnel error promptly.
          if (runningJob.cancelSafe !== false) {
            try { runningJob.child.kill(); } catch { /* child already ended */ }
          }
        }
        stopRemoteSession(appState, 'error');
      }).catch(() => {});
    }
    session.publicAddress = relay.parseRelayAddress(session.tunnel.url).address;
    if (session.tunnel.sharedRelay === true) {
      // Both peers connect directly to the same permanent provider. The local
      // server exists only long enough to preserve the injectable legacy
      // tunnel factory contract, then is closed before any child uses it.
      await new Promise((resolve) => session.server.close(resolve));
      session.server = null;
      session.localAddress = session.publicAddress;
    } else {
      session.localAddress = relay.parseRelayAddress(`http://127.0.0.1:${session.server.address().port}`).address;
    }
    session.invite = relay.createRemoteInvite(session.publicAddress, secret);
    session.connectionInvite = relay.createRemoteInvite(session.localAddress, secret);
    session.status = 'ready';
    if (action === 'pair') {
      session.lobbyConnectionInvite = session.connectionInvite;
      startTeamLobby(appState, session);
    } else {
      startRemoteControl(appState);
      const job = startJob(appState, 'remote-sync-host',
        syncArgs(peer, session.connectionInvite, syncSourceDeviceId, experimentalDirect));
      session.jobId = job.id;
    }
    return getAppState(appState);
  } catch (error) {
    session.error = error.message;
    if (appState.remoteSession === session) stopRemoteSession(appState, 'error');
    else closeRemoteSessionResources(session, 'error');
    throw error;
  }
}

function joinRemoteSession(appState, action, invite, peerId, direction, experimentalDirect) {
  const { project } = requireProject(appState);
  if (appState.job && appState.job.status === 'running') {
    throw Object.assign(new Error('Another Carry operation is already running'), { statusCode: 409 });
  }
  if (appState.remoteSession && ['starting', 'ready'].includes(appState.remoteSession.status)) {
    throw Object.assign(new Error('A remote session is already active. Stop it before joining another.'), { statusCode: 409 });
  }
  if (!['pair', 'sync'].includes(action)) {
    throw Object.assign(new Error('Remote action must be pair or sync'), { statusCode: 400 });
  }
  let remote;
  try { remote = relay.parseRelayAddress(invite); }
  catch (error) { throw Object.assign(error, { statusCode: 400 }); }
  if (remote.transport !== 'websocket' || !remote.secret) {
    throw Object.assign(new Error('Paste the complete Carry invitation, including the part after #'), { statusCode: 400 });
  }
  const peer = action === 'sync' ? remotePeer(appState, peerId) : null;
  const syncSourceDeviceId = peer ? syncSourceForDirection(project, peer, direction) : null;
  experimentalDirect = experimentalDirect === true;
  if (peer && !timingSafeTextEqual(remote.secret, peer.pairCode) &&
      !timingSafeTextEqual(remote.secret, peer.teamCode)) {
    throw Object.assign(new Error('This invitation belongs to a different paired device'), { statusCode: 403 });
  }
  const connectionInvite = peer
    ? relay.createRemoteInvite(remote.address, peer.pairCode)
    : String(invite).trim();
  const session = {
    status: 'ready',
    role: 'joiner',
    action,
    peerId: peer ? peer.deviceId : null,
    syncSourceDeviceId,
    secret: peer ? peer.pairCode : remote.secret,
    teamSecret: action === 'pair' ? remote.secret : peer && peer.teamCode || null,
    relayAddress: remote.address,
    knownPeerIds: new Set(manifest.listPeers(appState.root).map((item) => item.deviceId)),
    invite: null,
    connectionInvite,
    startedAt: new Date().toISOString(),
    lastActivityAt: new Date().toISOString(),
    error: null,
    server: null,
    tunnel: null,
    jobId: null,
    controlClient: null,
    controlReconnectTimer: null,
    controlHeartbeatTimer: null,
    controlGeneration: 0,
    controlReconnectAttempts: 0,
    controlStatus: 'offline',
    controlRequests: new Set(),
    peerOnline: false,
    outgoingRequestId: null,
    lastPeerControlAt: 0,
  };
  appState.remoteSession = session;
  try {
    if (action === 'sync') startRemoteControl(appState);
    const job = action === 'pair'
      ? startJob(appState, 'remote-pair-join', ['pair', '--relay', connectionInvite, '--team'])
      : startJob(appState, 'remote-sync-join',
        syncArgs(peer, connectionInvite, syncSourceDeviceId, experimentalDirect));
    session.jobId = job.id;
    session.awaitingSyncRequest = action === 'sync';
    return getAppState(appState);
  } catch (error) {
    session.error = error.message;
    stopRemoteSession(appState, 'error');
    throw error;
  }
}

function cachedFiles(appState, root) {
  const now = Date.now();
  if (appState.fileCache && appState.fileCache.root === root && now - appState.fileCache.at < 10000) {
    return appState.fileCache.files;
  }
  const files = sync.listFiles(root);
  appState.fileCache = { root, files, at: now };
  return files;
}

function cachedPending(appState, root, peerId) {
  if (!peerId) return [];
  const now = Date.now();
  if (appState.pendingCache && appState.pendingCache.root === root &&
      appState.pendingCache.peerId === peerId && now - appState.pendingCache.at < 10000) {
    return appState.pendingCache.changes;
  }
  const changes = syncEngine.previewLocalChanges(root, peerId);
  appState.pendingCache = { root, peerId, changes, at: now };
  return changes;
}

function getAppState(appState) {
  const root = appState.root;
  if (!root) {
    return {
      folder: null,
      project: null,
      peers: [],
      activeDeviceId: null,
      selectedPeerId: null,
      files: 0,
      pending: [],
      sessions: [],
      checkpoints: [],
      memory: { entities: 0, observations: 0, relations: 0, pinned: 0 },
      firewallReady: appState.firewallReady,
      job: publicJob(appState.job),
      remote: publicRemoteSession(appState),
    };
  }

  const project = manifest.readManifest(root);
  if (!project) {
    return {
      folder: { root, name: path.basename(root) },
      project: null,
      peers: [],
      activeDeviceId: null,
      selectedPeerId: null,
      files: cachedFiles(appState, root).length,
      pending: [],
      sessions: [],
      checkpoints: [],
      memory: { entities: 0, observations: 0, relations: 0, pinned: 0 },
      firewallReady: appState.firewallReady,
      job: publicJob(appState.job),
      remote: publicRemoteSession(appState),
    };
  }

  const peers = manifest.listPeers(root).map(({ pairCode: _secret, teamCode: _teamSecret, ...peer }) => peer);
  if (!peers.some((peer) => peer.deviceId === appState.selectedPeerId)) {
    appState.selectedPeerId = peers[0] ? peers[0].deviceId : null;
  }
  const sessions = syncEngine.listSessions(root, 40);
  const projectCheckpoints = checkpoints.list(root, 100);
  const activeDevice = manifest.readActiveDevice(root);
  return {
    folder: { root, name: path.basename(root) },
    project: {
      name: project.name,
      deviceId: project.deviceId,
      createdAt: project.createdAt,
    },
    peers,
    activeDeviceId: activeDevice ? activeDevice.deviceId : null,
    selectedPeerId: appState.selectedPeerId,
    files: cachedFiles(appState, root).length,
    pending: cachedPending(appState, root, appState.selectedPeerId),
    sessions,
    checkpoints: projectCheckpoints,
    memory: memory.summary(root),
    firewallReady: appState.firewallReady,
    job: publicJob(appState.job),
    remote: publicRemoteSession(appState),
  };
}

function internalFile(root, relative, requiredPrefix) {
  const normalized = String(relative || '').replace(/\\/g, '/');
  if (!normalized.startsWith(requiredPrefix) || normalized.includes('\0')) throw new Error('invalid internal file path');
  const suffix = normalized.slice(requiredPrefix.length);
  const prefix = path.resolve(privateState.projectDir(root), ...requiredPrefix.replace(/^\.carry\//, '').split('/'));
  const target = path.resolve(prefix, ...suffix.split('/'));
  if (target !== prefix && !target.startsWith(prefix + path.sep)) throw new Error('internal file path escapes project');
  return target;
}

function readTextSnapshot(file) {
  if (!file || !fs.existsSync(file)) return { text: '', missing: true, binary: false, bytes: 0 };
  const data = fs.readFileSync(file);
  if (data.includes(0)) return { text: '', missing: false, binary: true, bytes: data.length };
  const clipped = data.length > 1024 * 1024 ? data.subarray(0, 1024 * 1024) : data;
  return { text: clipped.toString('utf8'), missing: false, binary: false, bytes: data.length, clipped: data.length !== clipped.length };
}

function fallbackDiff(left, right) {
  const rows = [];
  const max = Math.max(left.length, right.length);
  for (let i = 0; i < Math.min(max, 2000); i++) {
    if (left[i] === right[i]) rows.push({ type: 'context', left: i + 1, right: i + 1, text: left[i] || '' });
    else {
      if (i < left.length) rows.push({ type: 'remove', left: i + 1, right: null, text: left[i] });
      if (i < right.length) rows.push({ type: 'add', left: null, right: i + 1, text: right[i] });
    }
  }
  return rows;
}

function lineDiff(leftText, rightText) {
  const left = leftText.split(/\r?\n/);
  const right = rightText.split(/\r?\n/);
  if (left.length * right.length > 250000) return fallbackDiff(left, right);
  const width = right.length + 1;
  const table = new Uint32Array((left.length + 1) * width);
  for (let i = left.length - 1; i >= 0; i--) {
    for (let j = right.length - 1; j >= 0; j--) {
      table[i * width + j] = left[i] === right[j]
        ? table[(i + 1) * width + j + 1] + 1
        : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
    }
  }
  const rows = [];
  let i = 0;
  let j = 0;
  while (i < left.length || j < right.length) {
    if (i < left.length && j < right.length && left[i] === right[j]) {
      rows.push({ type: 'context', left: i + 1, right: j + 1, text: left[i] }); i++; j++;
    } else if (j < right.length && (i === left.length || table[i * width + j + 1] >= table[(i + 1) * width + j])) {
      rows.push({ type: 'add', left: null, right: j + 1, text: right[j++] });
    } else {
      rows.push({ type: 'remove', left: i + 1, right: null, text: left[i++] });
    }
  }
  return rows.slice(0, 4000);
}

function getConflictDiff(appState, sessionId, rel) {
  const { root } = requireProject(appState);
  syncEngine.safeRelativePath(rel);
  const session = syncEngine.listSessions(root, 200).find((item) => item.sessionId === sessionId);
  if (!session) throw Object.assign(new Error('Sync session was not found'), { statusCode: 404 });
  const copies = session.conflictCopies && session.conflictCopies[rel];
  if (!copies) throw Object.assign(new Error('No saved conflict snapshots exist for this file'), { statusCode: 404 });
  const local = readTextSnapshot(copies.local ? internalFile(root, copies.local, '.carry/conflicts/') : null);
  const remote = readTextSnapshot(copies.remote ? internalFile(root, copies.remote, '.carry/conflicts/') : null);
  return {
    sessionId,
    peerId: session.peerId,
    path: rel,
    resolved: session.resolutions && session.resolutions[rel] || null,
    local: { missing: local.missing, binary: local.binary, bytes: local.bytes, clipped: local.clipped },
    remote: { missing: remote.missing, binary: remote.binary, bytes: remote.bytes, clipped: remote.clipped },
    rows: local.binary || remote.binary ? [] : lineDiff(local.text, remote.text),
  };
}

function findEdge() {
  if (process.platform !== 'win32') return null;
  const candidates = [
    process.env['ProgramFiles(x86)'] && path.join(process.env['ProgramFiles(x86)'], 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  ].filter(Boolean);
  return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

function openWindow(url) {
  const edge = findEdge();
  if (!edge) throw new Error('Microsoft Edge is required to open the Carry desktop window');
  const child = spawn(edge, [
    '--app=' + url,
    '--new-window',
    '--no-first-run',
    '--window-size=1380,860',
  ], { stdio: 'ignore', windowsHide: false, detached: true });
  child.unref();
  return child;
}

async function handleApi(appState, req, res, url) {
  const method = req.method || 'GET';
  if (method === 'GET' && url.pathname === '/api/state') return sendJson(res, 200, getAppState(appState));
  // Operation cards must not wait behind a full folder re-hash. Large folders
  // can make /api/state expensive precisely when the terminal result matters.
  if (method === 'GET' && url.pathname === '/api/job') return sendJson(res, 200, publicJob(appState.job));
  if (method === 'GET' && url.pathname === '/api/memory') {
    const { root } = requireProject(appState);
    return sendJson(res, 200, memory.list(root));
  }
  if (method === 'GET' && url.pathname === '/api/diff') {
    return sendJson(res, 200, getConflictDiff(appState, url.searchParams.get('session'), url.searchParams.get('path')));
  }
  if (method === 'GET' && url.pathname === '/api/checkpoints/preview') {
    const { root } = requireProject(appState);
    return sendJson(res, 200, checkpoints.preview(root, String(url.searchParams.get('id') || '')));
  }
  if (method !== 'POST') throw Object.assign(new Error('API route was not found'), { statusCode: 404 });
  const body = await readBody(req);

  if (url.pathname === '/api/select-folder') {
    const selected = folderPicker.browse(appState.root || process.cwd());
    if (!selected) throw Object.assign(new Error('Folder selection was cancelled'), { statusCode: 409 });
    selectRoot(appState, selected);
    return sendJson(res, 200, getAppState(appState));
  }
  if (url.pathname === '/api/use-folder') {
    selectRoot(appState, body.path);
    return sendJson(res, 200, getAppState(appState));
  }
  if (url.pathname === '/api/init') {
    const root = requireRoot(appState);
    const name = String(body.name || path.basename(root)).trim().slice(0, 80);
    if (!name || /[\r\n\0]/.test(name)) throw Object.assign(new Error('Enter a valid project name'), { statusCode: 400 });
    manifest.init(root, name);
    appState.fileCache = null;
    return sendJson(res, 200, getAppState(appState));
  }
  if (url.pathname === '/api/select-peer') {
    const { root } = requireProject(appState);
    const peer = manifest.listPeers(root).find((item) => item.deviceId === body.peerId);
    if (!peer) throw Object.assign(new Error('Paired device was not found'), { statusCode: 404 });
    appState.selectedPeerId = peer.deviceId;
    appState.pendingCache = null;
    return sendJson(res, 200, getAppState(appState));
  }
  if (url.pathname === '/api/active-device') {
    const { root, project } = requireProject(appState);
    if (appState.job && appState.job.status === 'running') {
      throw Object.assign(new Error('Finish the active Carry operation before changing the active device'), { statusCode: 409 });
    }
    const deviceId = String(body.deviceId || '');
    if (deviceId !== project.deviceId && !manifest.listPeers(root).some((peer) => peer.deviceId === deviceId)) {
      throw Object.assign(new Error('Choose this device or a paired device as the active device'), { statusCode: 400 });
    }
    manifest.setActiveDevice(root, deviceId);
    return sendJson(res, 200, getAppState(appState));
  }
  if (url.pathname === '/api/pair') {
    if (!appState.firewallReady) throw Object.assign(new Error('Install Carry’s local-network firewall rules before pairing'), { statusCode: 409 });
    const code = String(body.code || '').trim().toUpperCase();
    if (code && !/^[A-F0-9]{32}$/.test(code)) {
      throw Object.assign(new Error('Secure LAN pairing codes contain 32 hexadecimal characters'), { statusCode: 400 });
    }
    return sendJson(res, 202, startJob(appState, code ? 'pair-receive' : 'pair-send', code ? ['pair', code] : ['pair']));
  }
  if (url.pathname === '/api/remote/start') {
    const action = String(body.action || 'pair');
    const state = await startRemoteSession(
      appState, action, body.peerId, body.maxDevices, body.direction, requestedDirect(body.direct));
    return sendJson(res, 202, state);
  }
  if (url.pathname === '/api/remote/join') {
    const action = String(body.action || 'pair');
    const state = joinRemoteSession(
      appState, action, body.invite, body.peerId, body.direction, requestedDirect(body.direct));
    return sendJson(res, 202, state);
  }
  if (url.pathname === '/api/remote/stop') {
    if (appState.job && appState.job.status === 'running' && remoteEndpointForJob(appState, appState.job.id)) {
      if (appState.job.cancelSafe === false) {
        throw Object.assign(new Error('Carry is already applying or confirming files and must finish safely before the remote session stops'), { statusCode: 409 });
      }
      appState.job.status = 'cancelled';
      appState.job.phase = 'cancelled';
      appState.job.endedAt = new Date().toISOString();
      try { appState.job.child.kill(); } catch { /* process already ended */ }
      delete appState.job.child;
    }
    stopRemoteSession(appState, 'stopped');
    return sendJson(res, 200, getAppState(appState));
  }
  if (url.pathname === '/api/sync') {
    const peerId = String(body.peerId || appState.selectedPeerId || '');
    const { root, project } = requireProject(appState);
    const syncPeer = manifest.listPeers(root).find((peer) => peer.deviceId === peerId);
    if (!syncPeer) {
      throw Object.assign(new Error('Choose a paired device before syncing'), { statusCode: 409 });
    }
    if (syncPeer.connectionEnabled === false) {
      throw Object.assign(new Error('This device is disconnected. Reconnect it from Devices before syncing.'), { statusCode: 409 });
    }
    if (syncPeer.transport === 'lan' && !appState.firewallReady) {
      throw Object.assign(new Error('Install Carry’s local-network firewall rules before syncing'), { statusCode: 409 });
    }
    const syncSourceDeviceId = syncSourceForDirection(project, syncPeer, body.direction);
    const experimentalDirect = requestedDirect(body.direct);
    appState.selectedPeerId = syncPeer.deviceId;
    appState.pendingCache = null;
    if (syncPeer.transport === 'relay') {
      return sendJson(res, 202, await requestRemoteSyncJob(appState, syncPeer, {
        syncSourceDeviceId,
        experimentalDirect,
      }));
    }
    return sendJson(res, 202, startJob(appState, 'sync', syncArgs(syncPeer, null, syncSourceDeviceId)));
  }
  if (url.pathname === '/api/memory/update') {
    const { root } = requireProject(appState);
    if (appState.job && appState.job.status === 'running') {
      throw Object.assign(new Error('Finish the active Carry operation before editing shared memory'), { statusCode: 409 });
    }
    memory.update(root, body.originalName, {
      name: body.name,
      entityType: body.entityType,
      observations: body.observations,
    });
    appState.fileCache = null;
    return sendJson(res, 200, memory.list(root));
  }
  if (url.pathname === '/api/memory/delete') {
    const { root } = requireProject(appState);
    if (appState.job && appState.job.status === 'running') {
      throw Object.assign(new Error('Finish the active Carry operation before deleting shared memory'), { statusCode: 409 });
    }
    const removed = memory.remove(root, body.name);
    appState.fileCache = null;
    return sendJson(res, 200, { memory: memory.list(root), removed });
  }
  if (url.pathname === '/api/memory/pin') {
    const { root } = requireProject(appState);
    const pinned = memory.setPinned(root, body.name, body.pinned);
    return sendJson(res, 200, { memory: memory.list(root), pinned });
  }
  if (url.pathname === '/api/checkpoints/create') {
    const { root } = requireProject(appState);
    if (appState.job && appState.job.status === 'running') {
      throw Object.assign(new Error('Finish the active Carry operation before creating a checkpoint'), { statusCode: 409 });
    }
    checkpoints.create(root, body.name, { kind: 'manual' });
    appState.fileCache = null;
    return sendJson(res, 201, getAppState(appState));
  }
  if (url.pathname === '/api/checkpoints/restore') {
    const { root } = requireProject(appState);
    if (appState.job && appState.job.status === 'running') {
      throw Object.assign(new Error('Finish the active Carry operation before restoring a checkpoint'), { statusCode: 409 });
    }
    const result = checkpoints.restore(root, String(body.checkpointId || ''));
    appState.pendingCache = null;
    appState.fileCache = null;
    return sendJson(res, 200, { state: getAppState(appState), result });
  }
  if (url.pathname === '/api/checkpoints/delete') {
    const { root } = requireProject(appState);
    if (appState.job && appState.job.status === 'running') {
      throw Object.assign(new Error('Finish the active Carry operation before deleting a checkpoint'), { statusCode: 409 });
    }
    checkpoints.remove(root, String(body.checkpointId || ''));
    return sendJson(res, 200, getAppState(appState));
  }
  if (url.pathname === '/api/conflicts/resolve') {
    const { root } = requireProject(appState);
    if (appState.job && appState.job.status === 'running') {
      throw Object.assign(new Error('Finish the active Carry operation before resolving a conflict'), { statusCode: 409 });
    }
    const choice = String(body.choice || '');
    const items = Array.isArray(body.items)
      ? body.items.map((item) => ({
        sessionId: String(item && item.sessionId || ''),
        path: String(item && item.path || ''),
      }))
      : [{ sessionId: String(body.sessionId || ''), path: String(body.path || '') }];
    const result = syncEngine.resolveConflicts(root, items, choice);
    appState.pendingCache = null;
    appState.fileCache = null;
    return sendJson(res, 200, { state: getAppState(appState), result });
  }
  if (url.pathname === '/api/disconnect-device') {
    const { root } = requireProject(appState);
    const peerId = String(body.peerId || appState.selectedPeerId || '');
    const peer = manifest.listPeers(root).find((item) => item.deviceId === peerId);
    if (!peer) throw Object.assign(new Error('Paired device was not found'), { statusCode: 404 });
    if (appState.job && appState.job.status === 'running') {
      const activeEndpoint = remoteEndpointForJob(appState, appState.job.id);
      if (!activeEndpoint || activeEndpoint.peerId === peerId) {
        throw Object.assign(new Error('Finish the active sync before disconnecting this device'), { statusCode: 409 });
      }
    }
    resolveRemoteSessionPeer(appState);
    manifest.setPeerConnection(root, peerId, false);
    disconnectSavedPeer(appState, peer);
    appState.pendingCache = null;
    appState.fileCache = null;
    return sendJson(res, 200, getAppState(appState));
  }
  if (url.pathname === '/api/connect-device') {
    const { root } = requireProject(appState);
    const peerId = String(body.peerId || appState.selectedPeerId || '');
    const peer = manifest.listPeers(root).find((item) => item.deviceId === peerId);
    if (!peer) throw Object.assign(new Error('Paired device was not found'), { statusCode: 404 });
    if (appState.job && appState.job.status === 'running') {
      throw Object.assign(new Error('Finish the active sync before reconnecting this device'), { statusCode: 409 });
    }
    manifest.setPeerConnection(root, peerId, true);
    try {
      if (peer.transport === 'relay') connectSavedPeer(appState, { ...peer, connectionEnabled: true });
    } catch (error) {
      manifest.setPeerConnection(root, peerId, false);
      throw error;
    }
    appState.selectedPeerId = peerId;
    appState.pendingCache = null;
    return sendJson(res, 200, getAppState(appState));
  }
  if (url.pathname === '/api/forget-device') {
    const { root } = requireProject(appState);
    const peerId = String(body.peerId || appState.selectedPeerId || '');
    const peer = manifest.listPeers(root).find((item) => item.deviceId === peerId);
    if (!peer) throw Object.assign(new Error('Paired device was not found'), { statusCode: 404 });
    if (appState.job && appState.job.status === 'running') {
      const activeEndpoint = remoteEndpointForJob(appState, appState.job.id);
      if (!activeEndpoint || activeEndpoint.peerId === peerId) {
        throw Object.assign(new Error('Finish the active sync before forgetting this device'), { statusCode: 409 });
      }
    }
    resolveRemoteSessionPeer(appState);
    if (appState.remoteSession && appState.remoteSession.members instanceof Map) {
      removeTeamMember(appState, appState.remoteSession, peerId);
    } else if (appState.remoteSession && appState.remoteSession.peerId === peerId) {
      stopRemoteSession(appState, 'forgotten');
    }
    manifest.removePeer(root, peerId);
    if (appState.selectedPeerId === peerId) appState.selectedPeerId = null;
    appState.pendingCache = null;
    appState.fileCache = null;
    return sendJson(res, 200, getAppState(appState));
  }
  if (url.pathname === '/api/cancel') {
    if (!appState.job || appState.job.status !== 'running' || !appState.job.child) {
      throw Object.assign(new Error('No Carry operation is running'), { statusCode: 409 });
    }
    if (appState.job.cancelSafe === false) {
      throw Object.assign(new Error('Carry is already applying or confirming files and must finish safely'), { statusCode: 409 });
    }
    appState.job.status = 'cancelled';
    appState.job.phase = 'cancelled';
    appState.job.endedAt = new Date().toISOString();
    try { appState.job.child.kill(); } catch { /* process already ended */ }
    delete appState.job.child;
    return sendJson(res, 200, publicJob(appState.job));
  }
  if (url.pathname === '/api/firewall') {
    const result = appState.firewall.installLanRules();
    appState.firewallReady = Boolean(result.ok);
    if (!result.ok) throw Object.assign(new Error(result.message || 'Windows did not install the local-network rules'), { statusCode: 409 });
    return sendJson(res, 200, { firewallReady: true });
  }
  if (url.pathname === '/api/open-folder') {
    const root = requireRoot(appState);
    if (process.platform !== 'win32') throw Object.assign(new Error('Open folder is currently available on Windows'), { statusCode: 409 });
    const child = spawn('explorer.exe', [root], { detached: true, stdio: 'ignore', windowsHide: false });
    child.unref();
    return sendJson(res, 200, { opened: true });
  }
  if (url.pathname === '/api/clear-job') {
    if (body.jobId && appState.job && body.jobId !== appState.job.id) {
      return sendJson(res, 200, { cleared: false });
    }
    if (appState.job && appState.job.status === 'running') throw Object.assign(new Error('The active operation cannot be dismissed'), { statusCode: 409 });
    appState.job = null;
    return sendJson(res, 200, { cleared: true });
  }
  throw Object.assign(new Error('API route was not found'), { statusCode: 404 });
}

function start(options) {
  options = options || {};
  const firewallProvider = options.firewall || firewall;
  const token = crypto.randomBytes(24).toString('hex');
  const appState = {
    root: initialRoot(options.root),
    selectedPeerId: null,
    job: null,
    firewall: firewallProvider,
    firewallReady: options.skipFirewallCheck ? true : firewallProvider.rulesInstalled(),
    pendingCache: null,
    fileCache: null,
    persistSettings: options.persistSettings !== false,
    remoteSession: null,
    remoteTunnelFactory: options.remoteTunnelFactory || tunnel.startRemoteRelay,
    lastRequestAt: Date.now(),
  };

  const server = http.createServer(async (req, res) => {
    appState.lastRequestAt = Date.now();
    securityHeaders(req, res);
    try {
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      if (req.method === 'OPTIONS' && url.pathname.startsWith('/api/')) {
        if (!NATIVE_APP_ORIGINS.has(req.headers.origin)) {
          return sendJson(res, 403, { error: 'Carry app origin was not authorized' });
        }
        res.writeHead(204);
        return res.end();
      }
      if (!url.pathname.startsWith('/api/')) {
        if ((req.method === 'GET' || req.method === 'HEAD') && serveStatic(url.pathname, res)) return;
        return sendJson(res, 404, { error: 'Not found' });
      }
      if (!timingSafeTextEqual(req.headers['x-carry-token'], token)) {
        return sendJson(res, 403, { error: 'Carry app authorization failed' });
      }
      await handleApi(appState, req, res, url);
    } catch (err) {
      if (res.headersSent) return;
      sendJson(res, err.statusCode || 500, { error: err.message || 'Carry app request failed' });
    }
  });
  server.on('clientError', (_err, socket) => {
    try { socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); } catch { /* ignore */ }
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port || 0, '127.0.0.1', () => {
      const port = server.address().port;
      const url = `http://127.0.0.1:${port}/#${token}`;
      const idleTimer = setInterval(() => {
        const running = appState.job && appState.job.status === 'running';
        const remoteActive = appState.remoteSession && ['starting', 'ready'].includes(appState.remoteSession.status);
        if (!running && !remoteActive && Date.now() - appState.lastRequestAt > IDLE_CLOSE_MS) server.close();
      }, 15000);
      idleTimer.unref();
      server.once('close', () => {
        clearInterval(idleTimer);
        stopRemoteSession(appState, 'stopped');
      });
      resolve({
        server,
        url,
        token,
        port,
        appState,
        close: () => new Promise((done) => {
          if (appState.job && appState.job.child) {
            try { appState.job.child.kill(); } catch { /* ignore */ }
          }
          stopRemoteSession(appState, 'stopped');
          server.close(() => done());
        }),
      });
    });
  });
}

async function launch(options) {
  const instance = await start(options);
  if (!options || options.open !== false) openWindow(instance.url);
  return instance;
}

module.exports = {
  start,
  launch,
  openWindow,
  findEdge,
  lineDiff,
};
