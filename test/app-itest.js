'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const appServer = require('../lib/app-server');
const manifest = require('../lib/manifest');
const relayClient = require('../lib/relay');
const syncEngine = require('../lib/sync-engine');
const tunnelHelper = require('../lib/tunnel');

const LIVE_REMOTE = process.env.CARRY_REMOTE_TUNNEL === '1';
const REMOTE_TIMEOUT = LIVE_REMOTE ? 180000 : 15000;

function write(root, rel, text) {
  const file = path.join(root, ...rel.split('/'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

function round(a, b, aId, bId) {
  const bundleA = syncEngine.buildBundle(a, aId, bId);
  const bundleB = syncEngine.buildBundle(b, bId, aId);
  const resultA = syncEngine.prepareIncoming(a, bId, bundleB, aId);
  const resultB = syncEngine.prepareIncoming(b, aId, bundleA, bId);
  syncEngine.commit(a, resultA);
  syncEngine.commit(b, resultB);
  return { resultA, resultB };
}

async function waitForJob(request, label, timeoutMs, expected) {
  const deadline = Date.now() + (timeoutMs || 10000);
  let lastState = null;
  while (Date.now() < deadline) {
    const response = await request('/api/state');
    const state = await response.json();
    lastState = state;
    const matches = state.job && (!expected ||
      ((!expected.type || state.job.type === expected.type) && (!expected.notId || state.job.id !== expected.notId)));
    if (matches && state.job.status !== 'running') {
      const recentLogs = (state.job.logs || []).slice(-8).map((line) => line.text).join(' | ');
      assert.strictEqual(state.job.status, 'success', `${label}: ${state.job.error || 'job failed'}${recentLogs ? ` | ${recentLogs}` : ''}`);
      return state;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail(`${label} did not finish before the test timeout: ${JSON.stringify({ job: lastState && lastState.job, remote: lastState && lastState.remote })}`);
}

async function waitForRemoteOnline(request, label, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await (await request('/api/state')).json();
    if (state.remote && state.remote.status === 'ready' && state.remote.peerOnline) return state;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail(`${label} did not report the remote device online`);
}

async function waitForPeerCount(request, count, label, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await (await request('/api/state')).json();
    if (state.peers.length === count && state.remote && state.remote.deviceCount === count + 1) return state;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail(`${label} did not reach ${count + 1} total devices`);
}

(async () => {
  const a = fs.mkdtempSync(path.join(os.tmpdir(), 'carry-app-a-'));
  const b = fs.mkdtempSync(path.join(os.tmpdir(), 'carry-app-b-'));
  const uninitialized = fs.mkdtempSync(path.join(os.tmpdir(), 'carry-app-new-'));
  const remoteA = fs.mkdtempSync(path.join(os.tmpdir(), 'carry-app-remote-a-'));
  const remoteB = fs.mkdtempSync(path.join(os.tmpdir(), 'carry-app-remote-b-'));
  const remoteC = fs.mkdtempSync(path.join(os.tmpdir(), 'carry-app-remote-c-'));
  let app;
  let remoteHost;
  let remoteGuest;
  let remoteGuestTwo;
  try {
    const ma = manifest.init(a, 'Studio PC').manifest;
    const mb = manifest.init(b, 'Work Laptop').manifest;
    manifest.addPeer(a, mb.deviceId, 'Work Laptop', 'lan', { address: '192.168.1.20', port: 48124, pairCode: 'A'.repeat(32) });
    manifest.addPeer(b, ma.deviceId, 'Studio PC', 'lan', { address: '192.168.1.10', port: 48124, pairCode: 'A'.repeat(32) });

    write(a, 'src/app.js', 'const version = "base";\n');
    write(b, 'src/app.js', 'const version = "base";\n');
    round(a, b, ma.deviceId, mb.deviceId);
    write(a, 'src/app.js', 'const version = "pc";\nconsole.log(version);\n');
    write(b, 'src/app.js', 'const version = "laptop";\nconsole.info(version);\n');
    const conflict = round(a, b, ma.deviceId, mb.deviceId).resultA;

    app = await appServer.start({ root: a, port: 0, skipFirewallCheck: true, persistSettings: false });
    const origin = `http://127.0.0.1:${app.port}`;
    const request = (route, opts) => fetch(origin + route, {
      method: opts && opts.method || 'GET',
      headers: {
        'X-Carry-Token': app.token,
        ...(opts && opts.body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: opts && opts.body ? JSON.stringify(opts.body) : undefined,
    });

    const html = await fetch(origin + '/');
    assert.strictEqual(html.status, 200, 'desktop HTML is served');
    const htmlText = await html.text();
    assert.ok(htmlText.includes('class="app-shell"'), 'desktop shell markup is present');
    assert.ok(htmlText.includes('id="remote-error"'), 'remote invite dialog has a persistent diagnostic area');
    assert.ok(htmlText.includes('data-view="checkpoints"'), 'desktop shell exposes checkpoint navigation');
    assert.ok(htmlText.includes('id="checkpoint-dialog"'), 'desktop shell includes named checkpoint creation');
    assert.ok(htmlText.includes('id="confirmation-dialog"') && htmlText.includes('id="confirmation-confirm"'),
      'desktop shell includes a reusable in-app confirmation dialog');
    assert.ok(htmlText.includes('id="team-size"'), 'desktop shell lets invitation creators choose a team device cap');
    assert.ok(htmlText.includes('id="sync-dialog"'), 'Sync now opens an explicit device and direction chooser');
    assert.ok(htmlText.includes('value="pull"') && htmlText.includes('value="push"') && htmlText.includes('value="smart"'),
      'sync chooser exposes Pull, Push, and Smart sync');
    assert.ok(htmlText.includes('rel="manifest"'), 'desktop shell advertises its application identity');
    assert.ok(htmlText.includes('/assets/carry-icon.svg'), 'desktop shell uses the Carry mark');
    assert.ok(htmlText.includes('id="window-controls"') && htmlText.includes('data-window-action="close"'),
      'desktop shell includes native minimize, maximize, and close controls');
    assert.ok(String(html.headers.get('content-security-policy')).includes("default-src 'self'"), 'strict CSP is present');

    const appManifestResponse = await fetch(origin + '/manifest.webmanifest');
    assert.strictEqual(appManifestResponse.status, 200, 'application manifest is served');
    assert.strictEqual(appManifestResponse.headers.get('content-type'), 'application/manifest+json; charset=utf-8');
    const appManifest = await appManifestResponse.json();
    assert.strictEqual(appManifest.name, 'Carry');
    assert.ok(appManifest.icons.some((icon) => icon.sizes === '44x44'), 'taskbar-size icon is declared');

    const icon = await fetch(origin + '/assets/carry-icon-44.png');
    assert.strictEqual(icon.status, 200, 'Carry icon is served');
    assert.strictEqual(icon.headers.get('content-type'), 'image/png');
    assert.ok((await icon.arrayBuffer()).byteLength > 500, 'Carry icon contains image data');

    const script = await fetch(origin + '/app.js');
    assert.strictEqual(script.status, 200, 'desktop JavaScript is served');
    const scriptText = await script.text();
    assert.ok(!scriptText.includes('innerHTML = model.folder.root'), 'dynamic folder paths are not directly injected');
    assert.ok(scriptText.includes('askForConfirmation') && !scriptText.includes('window.confirm'),
      'destructive and consequential actions use the in-app confirmation dialog');
    assert.ok(scriptText.includes('/api/checkpoints/preview'), 'checkpoint inspector loads an affected-file preview');
    assert.ok(scriptText.includes('bulk-resolve-conflicts'), 'desktop UI includes bulk conflict decisions');
    assert.ok(scriptText.includes('active-device-select'), 'desktop UI includes Active Device selection');
    assert.ok(scriptText.includes('remoteMembers') && scriptText.includes('other devices') &&
      scriptText.includes('Device connection overview'),
    'overview summarizes every device in an active team session instead of implying a single peer');
    assert.ok(scriptText.includes('transferProgress') && scriptText.includes('<progress class="job-progress"'),
      'desktop operation tray turns encrypted receipts into a determinate progress bar');
    assert.ok(scriptText.includes("'Pushing to'") && scriptText.includes("'Pulling from'"),
      'desktop operation title names the selected transfer direction');
    assert.ok(scriptText.includes("api('/api/job')") && scriptText.includes('Files applied · confirming both devices'),
      'desktop polls lightweight structured operation phases while a folder sync is running');
    assert.ok(scriptText.includes('wasFollowingNewestLog') &&
      scriptText.includes('nextLog.scrollTop = nextLog.scrollHeight'),
    'operation progress keeps following new log lines without jumping back to the top');
    assert.ok(scriptText.includes("const logs = (job.logs || []).map"),
      'operation cards keep their complete log history available in the scroll area');
    assert.ok(scriptText.includes('data-action="toggle-job"') &&
      scriptText.includes("jobTray.classList.toggle('is-minimized', minimized)"),
      'operation cards can be minimized without cancelling the active job');
    assert.ok(scriptText.includes('SUCCESSFUL_JOB_DISMISS_DELAY_MS = 10000') &&
      scriptText.includes("body: { jobId: job.id }"),
    'successful operation cards dismiss themselves ten seconds after completion');
    assert.ok(scriptText.includes('globalThis.__CARRY_NATIVE__') && scriptText.includes('appWindow.toggleMaximize()'),
      'bundled Tauri UI targets the authenticated backend and operates its custom window controls');

    const nativePreflight = await fetch(origin + '/api/state', {
      method: 'OPTIONS',
      headers: {
        Origin: 'http://tauri.localhost',
        'Access-Control-Request-Method': 'GET',
        'Access-Control-Request-Headers': 'X-Carry-Token',
      },
    });
    assert.strictEqual(nativePreflight.status, 204, 'Tauri asset origin passes a narrow API preflight');
    assert.strictEqual(nativePreflight.headers.get('access-control-allow-origin'), 'http://tauri.localhost');
    assert.strictEqual(nativePreflight.headers.get('cross-origin-resource-policy'), 'cross-origin',
      'Tauri asset origin may read the authenticated loopback response');
    const hostilePreflight = await fetch(origin + '/api/state', {
      method: 'OPTIONS',
      headers: { Origin: 'https://attacker.example', 'Access-Control-Request-Method': 'GET' },
    });
    assert.strictEqual(hostilePreflight.status, 403, 'untrusted origins cannot use the loopback API');

    const unauthorized = await fetch(origin + '/api/state');
    assert.strictEqual(unauthorized.status, 403, 'API rejects requests without the per-launch token');

    const stateResponse = await request('/api/state');
    assert.strictEqual(stateResponse.status, 200);
    const state = await stateResponse.json();
    assert.strictEqual(state.project.name, 'Studio PC');
    assert.strictEqual(state.peers[0].name, 'Work Laptop');
    assert.deepStrictEqual(state.pending, [{ path: 'src/app.js', action: 'modified' }]);
    assert.ok(state.sessions.some((session) => session.conflicts.includes('src/app.js')), 'conflict appears in UI state');

    app.appState.job = {
      id: 'newer-success', type: 'sync', status: 'success', startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(), logs: [], phase: 'completed', transferProgress: {},
    };
    const staleClear = await request('/api/clear-job', { method: 'POST', body: { jobId: 'older-success' } });
    assert.deepStrictEqual(await staleClear.json(), { cleared: false },
      'a stale auto-dismiss timer cannot clear a newer operation');
    assert.strictEqual(app.appState.job.id, 'newer-success');
    const matchingClear = await request('/api/clear-job', { method: 'POST', body: { jobId: 'newer-success' } });
    assert.deepStrictEqual(await matchingClear.json(), { cleared: true },
      'a completed operation can be dismissed by its id');
    assert.strictEqual(app.appState.job, null);

    const params = new URLSearchParams({ session: conflict.sessionId, path: 'src/app.js' });
    const diffResponse = await request('/api/diff?' + params.toString());
    assert.strictEqual(diffResponse.status, 200);
    const diff = await diffResponse.json();
    assert.ok(diff.rows.some((row) => row.type === 'remove' && row.text.includes('"pc"')), 'diff contains local line');
    assert.ok(diff.rows.some((row) => row.type === 'add' && row.text.includes('"laptop"')), 'diff contains peer line');

    const resolveResponse = await request('/api/conflicts/resolve', {
      method: 'POST', body: { sessionId: conflict.sessionId, path: 'src/app.js', choice: 'remote' },
    });
    assert.strictEqual(resolveResponse.status, 200);
    const resolvedPayload = await resolveResponse.json();
    assert.strictEqual(fs.readFileSync(path.join(a, 'src', 'app.js'), 'utf8'),
      'const version = "laptop";\nconsole.info(version);\n', 'GUI can keep the peer conflict snapshot');
    const resolvedSession = resolvedPayload.state.sessions.find((session) => session.sessionId === conflict.sessionId);
    assert.strictEqual(resolvedSession.resolutions['src/app.js'].choice, 'remote', 'resolved conflict is recorded in session history');
    assert.ok(resolvedPayload.state.checkpoints.some((item) => item.kind === 'restore-safety'),
      'replacing a conflict version creates a safety checkpoint');
    const resolutionRound = round(a, b, ma.deviceId, mb.deviceId);
    assert.ok(resolutionRound.resultA.conflicts.length === 0 && resolutionRound.resultB.conflicts.length === 0,
      'chosen peer version completes without another conflict');
    assert.strictEqual(fs.readFileSync(path.join(b, 'src', 'app.js'), 'utf8'),
      'const version = "laptop";\nconsole.info(version);\n', 'chosen version becomes the shared baseline');

    write(a, 'bulk-ui/one.txt', 'bulk base one');
    write(a, 'bulk-ui/two.txt', 'bulk base two');
    round(a, b, ma.deviceId, mb.deviceId);
    write(a, 'bulk-ui/one.txt', 'PC branch one');
    write(a, 'bulk-ui/two.txt', 'PC branch two');
    write(b, 'bulk-ui/one.txt', 'laptop branch one');
    write(b, 'bulk-ui/two.txt', 'laptop branch two');
    const bulkConflict = round(a, b, ma.deviceId, mb.deviceId).resultA;
    assert.deepStrictEqual(bulkConflict.conflicts, ['bulk-ui/one.txt', 'bulk-ui/two.txt']);
    const beforeBulkState = await (await request('/api/state')).json();
    const bulkResolveResponse = await request('/api/conflicts/resolve', {
      method: 'POST',
      body: {
        choice: 'remote',
        items: bulkConflict.conflicts.map((filePath) => ({ sessionId: bulkConflict.sessionId, path: filePath })),
      },
    });
    assert.strictEqual(bulkResolveResponse.status, 200, 'GUI API accepts a selected conflict batch');
    const bulkPayload = await bulkResolveResponse.json();
    assert.strictEqual(bulkPayload.result.count, 2);
    assert.ok(bulkPayload.result.checkpointId);
    assert.ok(bulkPayload.result.results.every((item) => item.checkpointId === bulkPayload.result.checkpointId),
      'GUI bulk choice uses one shared safety checkpoint');
    assert.strictEqual(bulkPayload.state.checkpoints.length, beforeBulkState.checkpoints.length + 1,
      'GUI creates one checkpoint for the entire selected batch');
    assert.strictEqual(fs.readFileSync(path.join(a, 'bulk-ui', 'one.txt'), 'utf8'), 'laptop branch one');
    assert.strictEqual(fs.readFileSync(path.join(a, 'bulk-ui', 'two.txt'), 'utf8'), 'laptop branch two');
    const bulkResolutionRound = round(a, b, ma.deviceId, mb.deviceId);
    assert.strictEqual(bulkResolutionRound.resultA.conflicts.length, 0);
    assert.strictEqual(bulkResolutionRound.resultB.conflicts.length, 0);

    const activeDeviceResponse = await request('/api/active-device', {
      method: 'POST', body: { deviceId: mb.deviceId },
    });
    assert.strictEqual(activeDeviceResponse.status, 200, 'Devices API changes the Active Device');
    const activeDeviceState = await activeDeviceResponse.json();
    assert.strictEqual(activeDeviceState.activeDeviceId, mb.deviceId);
    write(a, 'active-ui/source.txt', 'shared active base');
    round(a, b, ma.deviceId, mb.deviceId);
    write(a, 'active-ui/source.txt', 'outdated PC copy');
    write(b, 'active-ui/source.txt', 'latest laptop copy');
    const activeRound = round(a, b, ma.deviceId, mb.deviceId);
    assert.deepStrictEqual(activeRound.resultA.activeResolved, ['active-ui/source.txt']);
    assert.strictEqual(activeRound.resultA.conflicts.length, 0, 'active laptop prevents repetitive conflict prompts');
    assert.strictEqual(fs.readFileSync(path.join(a, 'active-ui', 'source.txt'), 'utf8'), 'latest laptop copy');
    assert.strictEqual(manifest.readActiveDevice(b).deviceId, mb.deviceId,
      'Active Device choice propagates to the paired device during sync');
    assert.ok(activeRound.resultA.checkpointId, 'passive PC is checkpointed before the active laptop replaces files');
    const switchActiveBackResponse = await request('/api/active-device', {
      method: 'POST', body: { deviceId: ma.deviceId },
    });
    assert.strictEqual(switchActiveBackResponse.status, 200);
    assert.strictEqual((await switchActiveBackResponse.json()).activeDeviceId, ma.deviceId,
      'user can hand Active Device authority back to this PC');

    write(a, 'checkpoint-api.txt', 'stable checkpoint bytes');
    const createCheckpointResponse = await request('/api/checkpoints/create', {
      method: 'POST', body: { name: 'UI stable version' },
    });
    assert.strictEqual(createCheckpointResponse.status, 201);
    const checkpointState = await createCheckpointResponse.json();
    const uiCheckpoint = checkpointState.checkpoints.find((item) => item.name === 'UI stable version');
    assert.ok(uiCheckpoint && uiCheckpoint.kind === 'manual', 'GUI API creates a named checkpoint');
    write(a, 'checkpoint-api.txt', 'broken checkpoint bytes');
    write(a, 'checkpoint-extra.txt', 'delete during restore');
    const checkpointPreviewResponse = await request(`/api/checkpoints/preview?id=${encodeURIComponent(uiCheckpoint.checkpointId)}`);
    assert.strictEqual(checkpointPreviewResponse.status, 200);
    const checkpointPreview = await checkpointPreviewResponse.json();
    assert.deepStrictEqual(checkpointPreview.counts, { restore: 0, replace: 1, delete: 1, total: 2 });
    assert.deepStrictEqual(checkpointPreview.changes.map(({ path: filePath, action }) => ({ path: filePath, action })), [
      { path: 'checkpoint-api.txt', action: 'replace' },
      { path: 'checkpoint-extra.txt', action: 'delete' },
    ], 'GUI checkpoint preview identifies each file the restore will replace or delete');
    const restoreCheckpointResponse = await request('/api/checkpoints/restore', {
      method: 'POST', body: { checkpointId: uiCheckpoint.checkpointId },
    });
    assert.strictEqual(restoreCheckpointResponse.status, 200);
    const restoredCheckpointState = await restoreCheckpointResponse.json();
    assert.strictEqual(fs.readFileSync(path.join(a, 'checkpoint-api.txt'), 'utf8'), 'stable checkpoint bytes');
    assert.ok(!fs.existsSync(path.join(a, 'checkpoint-extra.txt')), 'GUI checkpoint restore returns the exact file set');
    assert.ok(restoredCheckpointState.state.checkpoints.some((item) => item.kind === 'restore-safety'), 'GUI restore creates a safety checkpoint');

    const selectResponse = await request('/api/use-folder', { method: 'POST', body: { path: uninitialized } });
    const selected = await selectResponse.json();
    assert.strictEqual(selected.project, null, 'uninitialized folder has a setup state');
    const initResponse = await request('/api/init', { method: 'POST', body: { name: 'New Project' } });
    const initialized = await initResponse.json();
    assert.strictEqual(initialized.project.name, 'New Project', 'GUI can initialize the selected folder');

    const remoteManifestA = manifest.init(remoteA, 'Remote Studio').manifest;
    const remoteManifestB = manifest.init(remoteB, 'Remote Laptop').manifest;
    const remoteManifestC = manifest.init(remoteC, 'Remote Teammate').manifest;
    const localTunnel = async ({ relayPort }) => ({
      url: `http://127.0.0.1:${relayPort}`,
      stop() {},
    });
    const remoteTunnelFactory = LIVE_REMOTE ? tunnelHelper.startTunnel : localTunnel;
    remoteHost = await appServer.start({
      root: remoteA,
      port: 0,
      skipFirewallCheck: true,
      persistSettings: false,
      remoteTunnelFactory,
    });
    remoteGuest = await appServer.start({
      root: remoteB,
      port: 0,
      skipFirewallCheck: true,
      persistSettings: false,
      remoteTunnelFactory,
    });
    remoteGuestTwo = await appServer.start({
      root: remoteC,
      port: 0,
      skipFirewallCheck: true,
      persistSettings: false,
      remoteTunnelFactory,
    });
    const appRequest = (instance) => (route, opts) => fetch(`http://127.0.0.1:${instance.port}` + route, {
      method: opts && opts.method || 'GET',
      headers: {
        'X-Carry-Token': instance.token,
        ...(opts && opts.body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: opts && opts.body ? JSON.stringify(opts.body) : undefined,
    });
    const hostRequest = appRequest(remoteHost);
    const guestRequest = appRequest(remoteGuest);
    const guestTwoRequest = appRequest(remoteGuestTwo);

    const invalidTeamSizeResponse = await hostRequest('/api/remote/start', {
      method: 'POST', body: { action: 'pair', maxDevices: 17 },
    });
    assert.strictEqual(invalidTeamSizeResponse.status, 400, 'team device cap is bounded before a relay opens');

    const startPairResponse = await hostRequest('/api/remote/start', {
      method: 'POST', body: { action: 'pair', maxDevices: 3 },
    });
    assert.strictEqual(startPairResponse.status, 202, 'GUI starts a private remote pairing session');
    const startPairState = await startPairResponse.json();
    const invite = startPairState.remote.invite;
    assert.match(invite, LIVE_REMOTE
      ? /^https:\/\/[a-z0-9.-]+\/carry#[A-Za-z0-9_-]{43}$/
      : /^http:\/\/127\.0\.0\.1:\d+\/carry#[A-Za-z0-9_-]{43}$/);
    assert.strictEqual(startPairState.job, null, 'team host waits for members without occupying the operation tray');
    assert.strictEqual(startPairState.remote.maxDevices, 3, 'host-selected team device cap is applied');

    const joinPairResponse = await guestRequest('/api/remote/join', {
      method: 'POST', body: { action: 'pair', invite },
    });
    assert.strictEqual(joinPairResponse.status, 202, 'GUI joins a private remote pairing session');
    await Promise.all([
      waitForPeerCount(hostRequest, 1, 'first team member pairing', REMOTE_TIMEOUT),
      waitForJob(guestRequest, 'remote guest pairing', REMOTE_TIMEOUT),
    ]);
    assert.strictEqual(manifest.listPeers(remoteA)[0].deviceId, remoteManifestB.deviceId);
    assert.strictEqual(manifest.listPeers(remoteB)[0].deviceId, remoteManifestA.deviceId);
    assert.strictEqual(manifest.listPeers(remoteA)[0].transport, 'relay');
    const hostPeerRecord = manifest.listPeers(remoteA)[0];
    const guestPeerRecord = manifest.listPeers(remoteB)[0];
    assert.strictEqual(hostPeerRecord.pairCode, guestPeerRecord.pairCode,
      'host securely delivers the random pair key to its member');
    assert.strictEqual(guestPeerRecord.teamCode, null,
      'team members do not retain the shared invitation after pairing');
    assert.notStrictEqual(
      hostPeerRecord.pairCode,
      relayClient.legacyPairSecretForTeam(invite.split('#')[1], remoteManifestA.deviceId, remoteManifestB.deviceId),
      'pair keys are random rather than derivable from the shared team invitation',
    );

    let hostState = await (await hostRequest('/api/state')).json();
    let guestState = await (await guestRequest('/api/state')).json();
    assert.strictEqual(hostState.remote.status, 'ready', 'host invitation remains active after pairing');
    assert.strictEqual(hostState.remote.role, 'host');
    assert.strictEqual(hostState.remote.peerId, remoteManifestB.deviceId);
    assert.strictEqual(hostState.remote.invite, invite, 'host retains the same invitation');
    assert.strictEqual(hostState.remote.deviceCount, 2);
    assert.strictEqual(hostState.remote.availableSlots, 1);
    assert.strictEqual(guestState.remote.status, 'ready', 'joiner connection remains active after pairing');
    assert.strictEqual(guestState.remote.role, 'joiner');
    assert.strictEqual(guestState.remote.peerId, remoteManifestA.deviceId);
    assert.strictEqual(guestState.remote.invite, null, 'joiner secret is not exposed through app state');
    [hostState, guestState] = await Promise.all([
      waitForRemoteOnline(hostRequest, 'remote host control channel', REMOTE_TIMEOUT),
      waitForRemoteOnline(guestRequest, 'remote guest control channel', REMOTE_TIMEOUT),
    ]);

    const joinSecondMemberResponse = await guestTwoRequest('/api/remote/join', {
      method: 'POST', body: { action: 'pair', invite },
    });
    assert.strictEqual(joinSecondMemberResponse.status, 202, 'the same private invitation accepts another team member');
    await Promise.all([
      waitForPeerCount(hostRequest, 2, 'second team member pairing', REMOTE_TIMEOUT),
      waitForJob(guestTwoRequest, 'second remote guest pairing', REMOTE_TIMEOUT),
    ]);
    hostState = await (await hostRequest('/api/state')).json();
    assert.strictEqual(hostState.remote.deviceCount, 3);
    assert.strictEqual(hostState.remote.availableSlots, 0, 'selected team cap closes additional slots');
    assert.strictEqual(manifest.listPeers(remoteA).length, 2, 'team host trusts both paired devices');
    assert.ok(!JSON.stringify(hostState.peers).includes(invite.split('#')[1]), 'team invitation secret is not exposed in public peer state');
    assert.notStrictEqual(manifest.listPeers(remoteA)[0].pairCode, manifest.listPeers(remoteA)[1].pairCode,
      'each team member receives a distinct pairwise relay key');

    write(remoteA, 'remote-proof.txt', 'synced through the desktop remote flow\n');
    write(remoteB, 'remote-proof.txt', 'competing laptop version\n');
    for (let index = 1; index <= 6; index++) write(remoteA, `images/old-${index}.jpg`, `old image ${index}`);
    fs.mkdirSync(path.join(remoteA, 'project-tree', 'empty', 'nested'), { recursive: true });
    for (let index = 0; index < 600; index++) {
      write(remoteA, `project-tree/generated/deep/generated_module_${String(index).padStart(4, '0')}.js`, '');
    }
    fs.mkdirSync(path.join(remoteB, 'obsolete-empty', 'nested'), { recursive: true });
    const invalidDirectionResponse = await hostRequest('/api/sync', {
      method: 'POST', body: { peerId: remoteManifestB.deviceId, direction: 'sideways' },
    });
    assert.strictEqual(invalidDirectionResponse.status, 400, 'GUI API rejects an unknown sync direction');
    const invalidDirectResponse = await hostRequest('/api/sync', {
      method: 'POST', body: { peerId: remoteManifestB.deviceId, direction: 'push', direct: 'yes' },
    });
    assert.strictEqual(invalidDirectResponse.status, 400, 'GUI API rejects a malformed direct-transfer preference');
    const firstSyncResponse = await hostRequest('/api/sync', {
      method: 'POST', body: { peerId: remoteManifestB.deviceId, direction: 'push', direct: true },
    });
    assert.strictEqual(firstSyncResponse.status, 202, 'one GUI can request a remote sync');
    const firstSyncStates = await Promise.all([
      waitForJob(hostRequest, 'first one-click remote host sync', REMOTE_TIMEOUT, { type: 'remote-sync-host', notId: hostState.job && hostState.job.id }),
      waitForJob(guestRequest, 'automatically started remote guest sync', REMOTE_TIMEOUT, { type: 'remote-sync-join', notId: guestState.job.id }),
    ]);
    assert.strictEqual(fs.readFileSync(path.join(remoteB, 'remote-proof.txt'), 'utf8'), 'synced through the desktop remote flow\n');
    assert.strictEqual(firstSyncStates[1].job.status, 'success', 'remote background peer honors the initiator push direction');
    const lightweightJob = await (await hostRequest('/api/job')).json();
    assert.strictEqual(lightweightJob.status, 'success', 'lightweight job endpoint exposes the terminal result without hashing the folder');
    assert.strictEqual(lightweightJob.phase, 'completed');
    assert.ok(firstSyncStates.flatMap((item) => item.job.logs || []).some((line) => /source for this exchange/.test(line.text)),
      'operation log makes the selected direction visible');
    assert.ok(firstSyncStates.every((item) => (item.job.logs || []).some((line) => /Direct encrypted connection ready/.test(line.text))),
      'one GUI direct preference enables the authenticated P2P attempt on both unattended devices');
    assert.ok(firstSyncStates.every((item) => item.job.transport === 'direct'),
      'operation status records the transport selected for the transfer');
    assert.ok(firstSyncStates.flatMap((item) => item.job.logs || []).some((line) =>
      /project manifest in \d+ bounded part/.test(line.text)),
    'large direct-transfer metadata is streamed in bounded messages');
    assert.strictEqual(fs.readdirSync(path.join(remoteB, 'images')).length, 6);
    assert.strictEqual(fs.readdirSync(path.join(remoteB, 'project-tree', 'generated', 'deep')).length, 600,
      'the direct P2P path preserves a many-file project tree');
    assert.ok(fs.statSync(path.join(remoteB, 'project-tree', 'empty', 'nested')).isDirectory(),
      'remote P2P Push preserves empty nested project folders');
    assert.ok(!fs.existsSync(path.join(remoteB, 'obsolete-empty')),
      'remote P2P Push removes destination-only empty folders');

    const selectSecondMemberResponse = await hostRequest('/api/select-peer', {
      method: 'POST', body: { peerId: remoteManifestC.deviceId },
    });
    assert.strictEqual(selectSecondMemberResponse.status, 200, 'team host can select a specific member');
    const guestTwoState = await waitForRemoteOnline(guestTwoRequest, 'second member control channel', REMOTE_TIMEOUT);
    hostState = await waitForRemoteOnline(hostRequest, 'selected second member control channel', REMOTE_TIMEOUT);
    write(remoteA, 'team-member-proof.txt', 'sent only after selecting the second team member\n');
    const teamSyncResponse = await hostRequest('/api/sync', {
      method: 'POST', body: { peerId: remoteManifestC.deviceId },
    });
    assert.strictEqual(teamSyncResponse.status, 202, 'host can one-click sync a selected team member');
    const teamSyncStates = await Promise.all([
      waitForJob(hostRequest, 'selected team member host sync', REMOTE_TIMEOUT, { type: 'remote-sync-host', notId: hostState.job && hostState.job.id }),
      waitForJob(guestTwoRequest, 'selected team member automatic sync', REMOTE_TIMEOUT, { type: 'remote-sync-join', notId: guestTwoState.job && guestTwoState.job.id }),
    ]);
    assert.strictEqual(fs.readFileSync(path.join(remoteC, 'team-member-proof.txt'), 'utf8'),
      'sent only after selecting the second team member\n');

    fs.rmSync(path.join(remoteA, 'images'), { recursive: true, force: true });
    fs.writeFileSync(path.join(remoteA, 'replacement.jpg'), Buffer.alloc(2 * 1024 * 1024, 0x5a));
    const secondSyncResponse = await guestRequest('/api/sync', { method: 'POST', body: { peerId: remoteManifestA.deviceId } });
    assert.strictEqual(secondSyncResponse.status, 202, 'either device can initiate a later one-click sync');
    const secondSyncStates = await Promise.all([
      waitForJob(hostRequest, 'automatically started second remote host sync', REMOTE_TIMEOUT, { type: 'remote-sync-host', notId: teamSyncStates[0].job.id }),
      waitForJob(guestRequest, 'second one-click remote guest sync', REMOTE_TIMEOUT, { type: 'remote-sync-join', notId: firstSyncStates[1].job.id }),
    ]);
    const secondSyncLogs = secondSyncStates.flatMap((state) => state.job.logs || []).map((line) => line.text).join('\n');
    assert.match(secondSyncLogs, /Peer received encrypted update: ([1-9]|[1-9]\d)%/,
      'desktop flow reports encrypted progress for a large transfer');
    assert.ok(!secondSyncLogs.includes('retrying ('),
      'desktop flow does not duplicate an active large transfer while waiting for the final acknowledgement');
    assert.strictEqual(fs.statSync(path.join(remoteB, 'replacement.jpg')).size, 2 * 1024 * 1024);
    for (let index = 1; index <= 6; index++) {
      assert.ok(!fs.existsSync(path.join(remoteB, 'images', `old-${index}.jpg`)), `desktop remote round deletes old image ${index}`);
    }
    const thirdSyncResponse = await hostRequest('/api/sync', {
      method: 'POST', body: { peerId: remoteManifestB.deviceId },
    });
    assert.strictEqual(thirdSyncResponse.status, 202,
      'a third immediate sync starts after direct and relay transfer rounds');
    const thirdSyncStates = await Promise.all([
      waitForJob(hostRequest, 'third remote host sync', REMOTE_TIMEOUT,
        { type: 'remote-sync-host', notId: secondSyncStates[0].job.id }),
      waitForJob(guestRequest, 'third remote guest sync', REMOTE_TIMEOUT,
        { type: 'remote-sync-join', notId: secondSyncStates[1].job.id }),
    ]);
    const thirdSyncLogs = thirdSyncStates.flatMap((state) => state.job.logs || [])
      .map((line) => line.text).join('\n');
    assert.ok(!/peer disconnected|room full|timed out waiting for the peer/i.test(thirdSyncLogs),
      'the third sync is isolated from sockets left by the first two runs');

    // Older peers can acknowledge a fresh request while their previous data
    // child is still running. The initiator must not turn that ambiguous ACK
    // into a one-sided relay child of its own.
    const prestartedGuestJob = remoteGuest.appState.job;
    const prestartedGuestEndpoint = remoteGuest.appState.remoteSession;
    remoteGuest.appState.job = {
      id: 'ambiguous-prestarted-sync', type: 'remote-sync-join', status: 'running', logs: [],
    };
    prestartedGuestEndpoint.jobId = remoteGuest.appState.job.id;
    prestartedGuestEndpoint.awaitingSyncRequest = true;
    const currentGuestControlSend = prestartedGuestEndpoint.controlClient.send.bind(prestartedGuestEndpoint.controlClient);
    prestartedGuestEndpoint.controlClient.send = (frame) => {
      if (frame && frame.type === 'sync-request-ack' && frame.alreadyRunning === true) {
        const legacyFrame = { ...frame };
        delete legacyFrame.prestartedSync;
        return currentGuestControlSend(legacyFrame);
      }
      return currentGuestControlSend(frame);
    };
    const ambiguousAckResponse = await hostRequest('/api/sync', {
      method: 'POST', body: { peerId: remoteManifestB.deviceId },
    });
    assert.strictEqual(ambiguousAckResponse.status, 409,
      'an already-running acknowledgement cannot open a one-sided relay child');
    const ambiguousAckError = await ambiguousAckResponse.json();
    assert.match(ambiguousAckError.error, /still finishing the previous sync/i,
      'an ambiguous older-peer acknowledgement returns a retryable explanation');
    assert.strictEqual(remoteHost.appState.job.id, thirdSyncStates[0].job.id,
      'the initiator does not replace its completed job after an ambiguous acknowledgement');
    prestartedGuestEndpoint.controlClient.send = currentGuestControlSend;
    remoteGuest.appState.job = prestartedGuestJob;
    prestartedGuestEndpoint.jobId = null;
    prestartedGuestEndpoint.awaitingSyncRequest = false;

    // Reproduce the real-world timing window where this device has already
    // dismissed sync N but the peer's child is still finishing its relay close.
    // A fresh request must not be mistaken for a duplicate of sync N.
    const priorGuestJob = remoteGuest.appState.job;
    const busyGuestEndpoint = remoteGuest.appState.remoteSession;
    remoteGuest.appState.job = {
      id: 'previous-sync-still-finishing', type: 'remote-sync-join', status: 'running', logs: [],
    };
    busyGuestEndpoint.jobId = remoteGuest.appState.job.id;
    const overlappingResponse = await hostRequest('/api/sync', {
      method: 'POST', body: { peerId: remoteManifestB.deviceId },
    });
    assert.strictEqual(overlappingResponse.status, 409,
      'the control handshake rejects a new sync before opening a one-sided data child');
    const rejectedOverlap = await overlappingResponse.json();
    assert.match(rejectedOverlap.error, /still finishing the previous sync/i,
      'the overlap response tells the user to retry instead of hanging on Connecting to relay');
    assert.strictEqual(remoteHost.appState.job.id, thirdSyncStates[0].job.id,
      'a rejected overlap never replaces the last completed job with an orphan relay child');
    remoteGuest.appState.job = priorGuestJob;
    busyGuestEndpoint.jobId = null;
    hostState = await (await hostRequest('/api/state')).json();
    assert.strictEqual(hostState.remote.invite, invite, 'sync completion does not rotate or close the invitation');

    const completedGuestJob = remoteGuest.appState.job;
    const guestEndpoint = remoteGuest.appState.remoteSession;
    let unsafeKillCalled = false;
    remoteGuest.appState.job = {
      id: 'unsafe-remote-stop', type: 'remote-sync-join', status: 'running', phase: 'applying',
      cancelSafe: false, child: { kill() { unsafeKillCalled = true; } }, logs: [],
    };
    guestEndpoint.jobId = 'unsafe-remote-stop';
    const unsafeStopResponse = await guestRequest('/api/remote/stop', { method: 'POST' });
    assert.strictEqual(unsafeStopResponse.status, 409,
      'stopping a remote session cannot interrupt file application');
    assert.strictEqual(unsafeKillCalled, false, 'unsafe remote stop leaves the applying child alive');
    assert.strictEqual(remoteGuest.appState.remoteSession.status, 'ready');
    guestEndpoint.jobId = null;
    remoteGuest.appState.job = completedGuestJob;

    const stopGuestResponse = await guestRequest('/api/remote/stop', { method: 'POST' });
    assert.strictEqual(stopGuestResponse.status, 200, 'joiner can leave without closing the host invitation');

    const wrongInvite = relayClient.createRemoteInvite('http://127.0.0.1:9', relayClient.newRemoteSecret());
    const wrongSyncResponse = await guestRequest('/api/remote/join', {
      method: 'POST', body: { action: 'sync', peerId: remoteManifestA.deviceId, invite: wrongInvite },
    });
    assert.strictEqual(wrongSyncResponse.status, 403, 'GUI rejects a sync invitation for another pairing');

    const reconnectGuestResponse = await guestRequest('/api/remote/join', {
      method: 'POST', body: { action: 'sync', peerId: remoteManifestA.deviceId, invite },
    });
    assert.strictEqual(reconnectGuestResponse.status, 403,
      'the shared team invitation cannot replace a member\'s independent saved key');
    const reconnectSavedGuestResponse = await guestRequest('/api/connect-device', {
      method: 'POST', body: { peerId: remoteManifestA.deviceId },
    });
    assert.strictEqual(reconnectSavedGuestResponse.status, 200,
      'the independent saved pair key reconnects a joiner that left');
    await hostRequest('/api/select-peer', {
      method: 'POST', body: { peerId: remoteManifestB.deviceId },
    });
    await Promise.all([
      waitForRemoteOnline(hostRequest, 'reconnected host control channel', REMOTE_TIMEOUT),
      waitForRemoteOnline(guestRequest, 'reconnected guest control channel', REMOTE_TIMEOUT),
    ]);
    const reconnectHostResponse = await hostRequest('/api/sync', {
      method: 'POST', body: { peerId: remoteManifestB.deviceId },
    });
    assert.strictEqual(reconnectHostResponse.status, 202);
    await Promise.all([
      waitForJob(hostRequest, 'reconnected remote host sync', REMOTE_TIMEOUT),
      waitForJob(guestRequest, 'reconnected remote guest sync', REMOTE_TIMEOUT),
    ]);

    const expiringGuestEndpoint = remoteGuest.appState.remoteSession;
    const healthyGuestInvite = expiringGuestEndpoint.connectionInvite;
    const healthyGuestRelayAddress = expiringGuestEndpoint.relayAddress;
    const realTunnelProbe = tunnelHelper.probeTunnelHealth;
    try {
      expiringGuestEndpoint.connectionInvite = relayClient.createRemoteInvite(
        'http://127.0.0.1:9', expiringGuestEndpoint.secret);
      expiringGuestEndpoint.relayAddress = 'https://simulated-expired.lhr.life/carry';
      tunnelHelper.probeTunnelHealth = async () => ({ healthy: false, status: 503 });
      expiringGuestEndpoint.controlClient.dispatch({ type: 'relay-error', message: 'simulated stale public route' });
      const expiredRouteDeadline = Date.now() + 3000;
      do {
        guestState = await (await guestRequest('/api/state')).json();
        if (guestState.remote.status === 'error') break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      } while (Date.now() < expiredRouteDeadline);
      assert.strictEqual(guestState.remote.status, 'error',
        'a joiner stops retrying a public route that returns a provider 503');
      assert.match(guestState.remote.error, /free localhost\.run address expired/i,
        'the joiner explains that a new invitation is needed without deleting the pairing');
    } finally {
      tunnelHelper.probeTunnelHealth = realTunnelProbe;
      expiringGuestEndpoint.connectionInvite = healthyGuestInvite;
      expiringGuestEndpoint.relayAddress = healthyGuestRelayAddress;
    }
    const recoverExpiredGuest = await guestRequest('/api/connect-device', {
      method: 'POST', body: { peerId: remoteManifestA.deviceId },
    });
    assert.strictEqual(recoverExpiredGuest.status, 200,
      'a replacement reachable address can restart the saved pairing after expiry');
    await Promise.all([
      waitForRemoteOnline(hostRequest, 'host after simulated route expiry', REMOTE_TIMEOUT),
      waitForRemoteOnline(guestRequest, 'guest after simulated route expiry', REMOTE_TIMEOUT),
    ]);

    const disconnectGuestResponse = await guestRequest('/api/disconnect-device', {
      method: 'POST', body: { peerId: remoteManifestA.deviceId },
    });
    assert.strictEqual(disconnectGuestResponse.status, 200, 'Devices API disconnects a trusted peer');
    guestState = await disconnectGuestResponse.json();
    assert.strictEqual(guestState.peers.length, 1, 'disconnected peer remains in Devices');
    assert.strictEqual(guestState.peers[0].connectionEnabled, false, 'disconnected peer is visibly paused');
    assert.strictEqual(guestState.remote.status, 'disconnected', 'disconnect closes that peer session');
    assert.ok(!manifest.readAllowlist(remoteB).includes(remoteManifestA.deviceId), 'disconnect removes runtime authorization without deleting trust');
    const pausedGuestSync = await guestRequest('/api/sync', {
      method: 'POST', body: { peerId: remoteManifestA.deviceId },
    });
    assert.strictEqual(pausedGuestSync.status, 409, 'a disconnected peer cannot accidentally start a sync');
    const closePausedGuestSession = await guestRequest('/api/remote/stop', { method: 'POST' });
    assert.strictEqual(closePausedGuestSession.status, 200, 'a paused connection may outlive its old session resources');
    const connectGuestResponse = await guestRequest('/api/connect-device', {
      method: 'POST', body: { peerId: remoteManifestA.deviceId },
    });
    assert.strictEqual(connectGuestResponse.status, 200, 'saved joiner pairing reconnects after its old session ends without a new invitation');
    guestState = await connectGuestResponse.json();
    assert.strictEqual(guestState.peers[0].connectionEnabled, true);
    assert.ok(manifest.readAllowlist(remoteB).includes(remoteManifestA.deviceId), 'reconnect restores runtime authorization');
    await Promise.all([
      waitForRemoteOnline(hostRequest, 'host after guest reconnect toggle', REMOTE_TIMEOUT),
      waitForRemoteOnline(guestRequest, 'guest after reconnect toggle', REMOTE_TIMEOUT),
    ]);

    const disconnectHostResponse = await hostRequest('/api/disconnect-device', {
      method: 'POST', body: { peerId: remoteManifestB.deviceId },
    });
    assert.strictEqual(disconnectHostResponse.status, 200);
    hostState = await disconnectHostResponse.json();
    assert.strictEqual(hostState.peers.length, 2, 'disconnecting a team member retains every pairing');
    assert.strictEqual(hostState.peers.find((peer) => peer.deviceId === remoteManifestB.deviceId).connectionEnabled, false);
    assert.strictEqual(hostState.remote.availableSlots, 0, 'a disconnected trusted member keeps its team slot');
    assert.strictEqual(hostState.remote.invite, invite, 'temporary disconnect does not rotate the team invitation');
    const pausedHostSync = await hostRequest('/api/sync', {
      method: 'POST', body: { peerId: remoteManifestB.deviceId },
    });
    assert.strictEqual(pausedHostSync.status, 409, 'host cannot sync a paused member until reconnecting it');
    const connectHostResponse = await hostRequest('/api/connect-device', {
      method: 'POST', body: { peerId: remoteManifestB.deviceId },
    });
    assert.strictEqual(connectHostResponse.status, 200, 'team host reconnects the saved pairwise room');
    await Promise.all([
      waitForRemoteOnline(hostRequest, 'host after member reconnect toggle', REMOTE_TIMEOUT),
      waitForRemoteOnline(guestRequest, 'guest after host reconnect toggle', REMOTE_TIMEOUT),
    ]);

    const forgetHostResponse = await hostRequest('/api/forget-device', {
      method: 'POST', body: { peerId: remoteManifestB.deviceId },
    });
    assert.strictEqual(forgetHostResponse.status, 200, 'Forget device permanently revokes a saved pairing');
    hostState = await forgetHostResponse.json();
    assert.strictEqual(hostState.peers.length, 1, 'forgetting one member leaves the other paired');
    assert.strictEqual(hostState.remote.availableSlots, 1, 'forgetting a member reopens one team slot');
    assert.notStrictEqual(hostState.remote.invite, invite, 'forgetting rotates the shared team invitation');
    const staleInviteClient = new relayClient.RelayClient();
    staleInviteClient.setRelay(invite);
    await assert.rejects(
      staleInviteClient.join(invite.split('#')[1], 'stale-member-device', () => {}, 'Stale member', invite.split('#')[1]),
      /rotated|not valid/i,
      'the old team invitation cannot be reused after a member is forgotten',
    );
    staleInviteClient.close();
    await waitForRemoteOnline(hostRequest, 'remaining team member after invitation rotation', REMOTE_TIMEOUT);

    await guestTwoRequest('/api/remote/stop', { method: 'POST' });
    const disconnectSecondHostResponse = await hostRequest('/api/forget-device', {
      method: 'POST', body: { peerId: remoteManifestC.deviceId },
    });
    assert.strictEqual(disconnectSecondHostResponse.status, 200);
    assert.strictEqual((await disconnectSecondHostResponse.json()).peers.length, 0);
    await hostRequest('/api/remote/stop', { method: 'POST' });

    let resolveDelayedTunnel;
    let delayedRelayPort = null;
    remoteHost.appState.remoteTunnelFactory = ({ relayPort }) => {
      delayedRelayPort = relayPort;
      return new Promise((resolve) => { resolveDelayedTunnel = resolve; });
    };
    const staleStartRequest = hostRequest('/api/remote/start', {
      method: 'POST', body: { action: 'pair', maxDevices: 2 },
    });
    const staleStartDeadline = Date.now() + 3000;
    while (!resolveDelayedTunnel && Date.now() < staleStartDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.ok(resolveDelayedTunnel, 'first tunnel startup reached the deferred factory');
    assert.strictEqual((await hostRequest('/api/remote/stop', { method: 'POST' })).status, 200);
    remoteHost.appState.remoteTunnelFactory = localTunnel;
    const replacementStartResponse = await hostRequest('/api/remote/start', {
      method: 'POST', body: { action: 'pair', maxDevices: 2 },
    });
    assert.strictEqual(replacementStartResponse.status, 202, 'a replacement invitation can start after cancelling a slow one');
    const replacementInvite = (await replacementStartResponse.json()).remote.invite;
    resolveDelayedTunnel({
      url: `http://127.0.0.1:${delayedRelayPort}`,
      stop() {},
      closed: new Promise(() => {}),
    });
    assert.strictEqual((await staleStartRequest).status, 500, 'the cancelled tunnel request ends without becoming current');
    hostState = await (await hostRequest('/api/state')).json();
    assert.strictEqual(hostState.remote.status, 'ready', 'a stale tunnel completion cannot stop the replacement session');
    assert.strictEqual(hostState.remote.invite, replacementInvite);
    await hostRequest('/api/remote/stop', { method: 'POST' });

    let resolveTunnelClosed;
    remoteHost.appState.remoteTunnelFactory = async ({ relayPort }) => ({
      url: `http://127.0.0.1:${relayPort}`,
      stop() {},
      closed: new Promise((resolve) => { resolveTunnelClosed = resolve; }),
    });
    const closeAwareStart = await hostRequest('/api/remote/start', {
      method: 'POST', body: { action: 'pair', maxDevices: 2 },
    });
    assert.strictEqual(closeAwareStart.status, 202);
    resolveTunnelClosed({ expected: false, error: 'simulated public tunnel disconnect' });
    const tunnelCloseDeadline = Date.now() + 3000;
    do {
      hostState = await (await hostRequest('/api/state')).json();
      if (hostState.remote.status === 'error') break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    } while (Date.now() < tunnelCloseDeadline);
    assert.strictEqual(hostState.remote.status, 'error', 'unexpected tunnel death is surfaced after startup');
    assert.match(hostState.remote.error, /simulated public tunnel disconnect/);

    remoteHost.appState.remoteTunnelFactory = async () => {
      throw new Error('Windows OpenSSH Client is not installed. Install OpenSSH Client, then restart Carry.');
    };
    const failedInviteResponse = await hostRequest('/api/remote/start', {
      method: 'POST', body: { action: 'pair' },
    });
    assert.strictEqual(failedInviteResponse.status, 500, 'remote tunnel startup failure is returned to the UI');
    const failedInviteState = await (await hostRequest('/api/state')).json();
    assert.strictEqual(failedInviteState.remote.status, 'error');
    assert.match(failedInviteState.remote.error, /OpenSSH Client is not installed/);

    assert.ok(appServer.findEdge(), 'Microsoft Edge app runtime is available');
    console.log(`APP INTEGRATION PASS (${LIVE_REMOTE ? 'localhost.run HTTPS' : 'local WebSocket'}): secure shell, checkpoints, capped team rooms, and one-click background remote sync.`);
  } finally {
    if (remoteHost) await remoteHost.close();
    if (remoteGuest) await remoteGuest.close();
    if (remoteGuestTwo) await remoteGuestTwo.close();
    if (app) await app.close();
    fs.rmSync(a, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    fs.rmSync(b, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    fs.rmSync(uninitialized, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    fs.rmSync(remoteA, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    fs.rmSync(remoteB, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    fs.rmSync(remoteC, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
})().catch((err) => {
  console.error('APP INTEGRATION FAIL:', err);
  process.exitCode = 1;
});
