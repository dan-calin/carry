'use strict';

const nativeConfig = globalThis.__CARRY_NATIVE__ || null;
const token = nativeConfig?.token || location.hash.slice(1);
const apiOrigin = nativeConfig?.apiOrigin || '';
if (nativeConfig?.nativeWindow) document.documentElement.classList.add('native-shell');
const shell = document.getElementById('app-shell');
const main = document.getElementById('main-content');
const inspector = document.getElementById('inspector');
const actions = document.getElementById('workspace-actions');
const jobTray = document.getElementById('job-tray');
const toastRegion = document.getElementById('toast-region');

let model = null;
let activeView = 'overview';
let selectedSessionId = null;
let selectedCheckpointId = null;
let checkpointPreview = null;
let checkpointPreviewRequestId = 0;
let memoryModel = null;
let memoryRequestId = 0;
let selectedMemoryName = null;
let selectedMemorySnapshot = null;
let memoryHighlightSessionId = null;
let memoryQuery = '';
let currentDiff = null;
const selectedConflictKeys = new Set();
let pollTimer = null;
let refreshInFlight = false;
let remoteAction = 'pair';
let pendingSyncPeerId = null;
let pendingSyncDirection = 'smart';
let pendingSyncDirect = false;
let renderedJobId = null;
let renderedJobMarkup = '';
let minimizedJobId = null;
let successfulJobDismissTimer = null;
let successfulJobDismissId = null;
let folderSelectionInFlight = false;
let renderedStateFingerprint = null;

const SUCCESSFUL_JOB_DISMISS_DELAY_MS = 10000;

function modelFingerprint(value) {
  return JSON.stringify(value, (key, item) => key === 'lastActivityAt' ? undefined : item);
}

function focusedElementDescriptor() {
  const element = document.activeElement;
  if (!element || element === document.body) return null;
  if (element.id) return { selector: `#${element.id}` };
  const names = [
    'data-view', 'data-action', 'data-peer-id', 'data-session', 'data-checkpoint',
    'data-memory-item', 'data-memory-link', 'data-memory-session',
    'data-conflict-session', 'data-conflict-path', 'data-file-path',
  ];
  const attributes = names
    .filter((name) => element.hasAttribute && element.hasAttribute(name))
    .map((name) => `[${name}="${String(element.getAttribute(name)).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"]`);
  if (!attributes.length) return null;
  return { selector: `${element.tagName.toLowerCase()}${attributes.join('')}` };
}

function restoreFocusedElement(descriptor) {
  if (!descriptor || typeof document.querySelector !== 'function') return;
  const element = document.querySelector(descriptor.selector);
  if (!element || typeof element.focus !== 'function') return;
  try { element.focus({ preventScroll: true }); }
  catch { element.focus(); }
}

const viewCopy = {
  overview: ['Overview', 'Your folder, devices, and recent sync activity.'],
  activity: ['Activity', 'A local record of completed sync sessions and file actions.'],
  memory: ['Memory', 'Inspect and manage the durable context shared with your coding agents.'],
  checkpoints: ['Checkpoints', 'Named restore points and automatic safety snapshots stored on this device.'],
  conflicts: ['Conflicts', 'Compare independent edits and choose the version Carry should keep.'],
  devices: ['Devices', 'Trusted devices paired with this folder.'],
};

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function encoded(value) {
  return encodeURIComponent(String(value || ''));
}

async function api(path, options) {
  const opts = options || {};
  const response = await fetch(`${apiOrigin}${path}`, {
    method: opts.method || 'GET',
    headers: {
      'X-Carry-Token': token,
      ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    cache: 'no-store',
  });
  let result;
  try { result = await response.json(); } catch { result = {}; }
  if (!response.ok) throw new Error(result.error || `Carry request failed (${response.status})`);
  return result;
}

function showToast(message, kind) {
  const toast = document.createElement('div');
  toast.className = `toast ${kind || ''}`;
  const glyph = kind === 'error' ? '\uE783' : '\uE73E';
  toast.innerHTML = `<span class="fluent-icon" aria-hidden="true">${glyph}</span><span>${escapeHtml(message)}</span>`;
  toastRegion.appendChild(toast);
  setTimeout(() => toast.remove(), kind === 'error' ? 8000 : 4200);
}

const confirmationDialog = document.getElementById('confirmation-dialog');
let confirmationResolver = null;

function askForConfirmation({ title, message, confirmLabel = 'Confirm', tone = 'default' }) {
  document.getElementById('confirmation-title').textContent = title;
  document.getElementById('confirmation-message').textContent = message;
  document.getElementById('confirmation-confirm').textContent = confirmLabel;
  document.getElementById('confirmation-icon').textContent = tone === 'danger' ? '\uE7BA' : '\uE946';
  confirmationDialog.dataset.tone = tone;
  confirmationDialog.returnValue = 'cancel';
  confirmationDialog.showModal();

  return new Promise((resolve) => {
    confirmationResolver = resolve;
  });
}

confirmationDialog.addEventListener('cancel', () => {
  confirmationDialog.returnValue = 'cancel';
});

confirmationDialog.addEventListener('close', () => {
  const resolve = confirmationResolver;
  confirmationResolver = null;
  if (resolve) resolve(confirmationDialog.returnValue === 'confirm');
});

function scheduleSuccessfulJobDismiss(job) {
  if (!job || job.status !== 'success') {
    clearTimeout(successfulJobDismissTimer);
    successfulJobDismissTimer = null;
    successfulJobDismissId = null;
    return;
  }
  if (successfulJobDismissTimer && successfulJobDismissId === job.id) return;

  clearTimeout(successfulJobDismissTimer);
  successfulJobDismissId = job.id;
  const endedAt = new Date(job.endedAt).getTime();
  const delay = Number.isFinite(endedAt)
    ? Math.max(0, endedAt + SUCCESSFUL_JOB_DISMISS_DELAY_MS - Date.now())
    : SUCCESSFUL_JOB_DISMISS_DELAY_MS;
  successfulJobDismissTimer = setTimeout(async () => {
    successfulJobDismissTimer = null;
    successfulJobDismissId = null;
    if (!model || !model.job || model.job.id !== job.id || model.job.status !== 'success') return;
    try {
      const result = await api('/api/clear-job', { method: 'POST', body: { jobId: job.id } });
      if (result.cleared && model.job && model.job.id === job.id) {
        model.job = null;
        renderJob();
      }
    } catch {
      // Keep the completed card if dismissal fails. A later state poll will
      // render it again and retry without hiding useful operation details.
    }
  }, delay);
}

function formatDate(value, includeTime) {
  if (!value) return 'Never';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Unknown';
  return new Intl.DateTimeFormat(undefined, includeTime
    ? { dateStyle: 'medium', timeStyle: 'short' }
    : { dateStyle: 'medium' }).format(date);
}

function relativeTime(value) {
  if (!value) return 'Never synced';
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return 'Unknown time';
  const seconds = Math.round((timestamp - Date.now()) / 1000);
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  if (Math.abs(seconds) < 60) return formatter.format(seconds, 'second');
  const minutes = Math.round(seconds / 60);
  if (Math.abs(minutes) < 60) return formatter.format(minutes, 'minute');
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return formatter.format(hours, 'hour');
  const days = Math.round(hours / 24);
  if (Math.abs(days) < 30) return formatter.format(days, 'day');
  return formatDate(value, false);
}

function formatBytes(value) {
  const bytes = Number(value) || 0;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10240 ? 1 : 0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function peerById(id) {
  return model && model.peers ? model.peers.find((peer) => peer.deviceId === id) : null;
}

function selectedPeer() {
  return peerById(model && model.selectedPeerId);
}

function conflictKey(sessionId, pathValue) {
  return `${sessionId}\0${pathValue}`;
}

function activeDeviceName(deviceId) {
  if (!deviceId || !model || !model.project) return 'Not selected';
  if (deviceId === model.project.deviceId) return 'This device';
  return peerById(deviceId)?.name || `Device ${String(deviceId).slice(0, 8)}`;
}

function conflictsFromSessions() {
  if (!model) return [];
  const seen = new Set();
  const out = [];
  for (const session of model.sessions || []) {
    const actionByPath = new Map((session.actions || []).map((item) => [item.path, item]));
    const paths = new Set([...(session.conflicts || []), ...actionByPath.keys()]);
    for (const file of paths) {
      const key = `${session.peerId || ''}\0${file}`;
      if (seen.has(key)) continue;
      const action = actionByPath.get(file);
      const isConflict = (session.conflicts || []).includes(file) || action?.action === 'conflict';
      if (session.status === 'completed' && action?.action !== 'skipped') {
        // A newer successful action establishes that this path is no longer
        // waiting on an older conflict session. This is especially important
        // when Active Device authority resolved it without a manual click.
        seen.add(key);
      } else if (isConflict) {
        seen.add(key);
      }
      if (!isConflict || (session.resolutions && session.resolutions[file])) continue;
      out.push({ path: file, session, key: conflictKey(session.sessionId, file) });
    }
  }
  return out;
}

function sessionChangeCount(session) {
  const summary = session.summary || {};
  return (summary.pulled || 0) + (summary.pushed || 0) +
    (summary.deletedLocal || 0) + (summary.deletedRemote || 0) +
    (summary.createdDirectories || 0) + (summary.deletedDirectories || 0) +
    (summary.conflicts || 0) + (summary.skipped || 0);
}

function sessionSummary(session) {
  const summary = session.summary || {};
  const parts = [];
  const updates = (summary.pulled || 0) + (summary.pushed || 0);
  const deleted = (summary.deletedLocal || 0) + (summary.deletedRemote || 0);
  const foldersCreated = summary.createdDirectories || 0;
  const foldersDeleted = summary.deletedDirectories || 0;
  if (updates) parts.push(`${updates} update${updates === 1 ? '' : 's'}`);
  if (deleted) parts.push(`${deleted} deletion${deleted === 1 ? '' : 's'}`);
  if (foldersCreated) parts.push(`${foldersCreated} folder${foldersCreated === 1 ? '' : 's'} created`);
  if (foldersDeleted) parts.push(`${foldersDeleted} folder${foldersDeleted === 1 ? '' : 's'} deleted`);
  if (summary.conflicts) parts.push(`${summary.conflicts} conflict${summary.conflicts === 1 ? '' : 's'}`);
  if (summary.skipped) parts.push(`${summary.skipped} paused`);
  const memoryAdditions = sessionMemoryAdditionCount(session);
  if (memoryAdditions) parts.push(`${memoryAdditions} memory addition${memoryAdditions === 1 ? '' : 's'}`);
  return parts.length ? parts.join(' · ') : 'No project changes';
}

function actionLabel(action) {
  const labels = {
    added: 'Added', modified: 'Modified', deleted: 'Deleted', pull: 'Received', push: 'Sent',
    'delete-local': 'Deleted here', 'delete-remote': 'Deleted there', conflict: 'Conflict',
    'create-directory': 'Folder created', 'delete-directory': 'Folder deleted',
    skipped: 'Paused', same: 'Unchanged',
  };
  return labels[action] || action;
}

function actionLetter(action) {
  const letters = {
    added: 'A', modified: 'M', deleted: 'D', pull: '↓', push: '↑',
    'delete-local': 'D', 'delete-remote': 'D', conflict: '!', skipped: 'P', same: '·',
    'create-directory': '+', 'delete-directory': '−',
  };
  return letters[action] || '·';
}

function emptyPanel(icon, title, copy, button) {
  return `<div class="empty-panel">
    <span class="fluent-icon" aria-hidden="true">${icon}</span>
    <h3>${escapeHtml(title)}</h3>
    <p>${escapeHtml(copy)}</p>
    ${button || ''}
  </div>`;
}

function renderTopChrome() {
  const folderName = document.getElementById('folder-name');
  const folderPath = document.getElementById('folder-path');
  if (model && model.folder) {
    folderName.textContent = model.project ? model.project.name : model.folder.name;
    folderPath.textContent = model.folder.root;
  } else {
    folderName.textContent = 'No folder selected';
    folderPath.textContent = 'Choose a folder to begin';
  }

  const identity = document.getElementById('device-identity');
  identity.querySelector('.device-label').textContent = model && model.project ? 'This device' : 'Not initialized';
  identity.querySelector('.device-id').textContent = model && model.project ? model.project.deviceId : 'No device identity';

  const conflictCount = conflictsFromSessions().length;
  setNavCount('activity-count', model ? model.sessions.length : 0);
  setNavCount('memory-count', model ? model.memory.entities : 0);
  setNavCount('checkpoint-count', model ? model.checkpoints.length : 0);
  setNavCount('conflict-count', conflictCount);
  setNavCount('device-count', model ? model.peers.length : 0);
}

function setNavCount(id, count) {
  const element = document.getElementById(id);
  element.textContent = String(count);
  element.hidden = count === 0;
}

function renderHeader() {
  const copy = viewCopy[activeView] || viewCopy.overview;
  document.getElementById('view-title').textContent = copy[0];
  document.getElementById('view-subtitle').textContent = copy[1];

  if (!model || !model.folder) {
    actions.innerHTML = `<button class="button button-primary" type="button" data-action="choose-folder"${folderSelectionAttributes()}><span class="fluent-icon" aria-hidden="true">&#xE8B7;</span>Choose folder</button>`;
    return;
  }
  if (!model.project) {
    actions.innerHTML = '<button class="button button-secondary" type="button" data-action="open-folder"><span class="fluent-icon" aria-hidden="true">&#xE838;</span>Open in Explorer</button><button class="button button-primary" type="button" data-action="show-init">Initialize folder</button>';
    return;
  }

  const running = model.job && model.job.status === 'running';
  if (activeView === 'checkpoints') {
    actions.innerHTML = `<button class="button button-secondary" type="button" data-action="open-folder"><span class="fluent-icon" aria-hidden="true">&#xE838;</span>Open folder</button>
      <button class="button button-primary" type="button" data-action="create-checkpoint" ${running ? 'disabled' : ''}><span class="fluent-icon" aria-hidden="true">&#xE823;</span>Create checkpoint</button>`;
    return;
  }
  const canSync = model.peers.length > 0 && !running;
  const pairButton = activeView === 'devices' || model.peers.length === 0
    ? '<button class="button button-secondary" type="button" data-action="show-pair"><span class="fluent-icon" aria-hidden="true">&#xE710;</span>Pair device</button>'
    : '';
  actions.innerHTML = `${pairButton}<button class="button button-secondary" type="button" data-action="open-folder"><span class="fluent-icon" aria-hidden="true">&#xE838;</span>Open folder</button>
    <button class="button button-primary" type="button" data-action="show-sync" ${canSync ? '' : 'disabled'}><span class="fluent-icon" aria-hidden="true">&#xE895;</span>${running ? 'Carry is busy' : 'Sync now'}</button>`;
}

function renderFolderOnboarding() {
  document.getElementById('view-title').textContent = 'Choose a folder';
  document.getElementById('view-subtitle').textContent = 'Carry works with folders already on this PC.';
  main.innerHTML = `<div class="onboarding"><section class="onboarding-panel">
    <div class="onboarding-symbol fluent-icon" aria-hidden="true">&#xE8B7;</div>
    <h2>Which folder should Carry keep in sync?</h2>
    <p>Select an existing project folder. Carry does not move it or upload it anywhere.</p>
    <div class="onboarding-actions">
      <button class="button button-primary" type="button" data-action="choose-folder"${folderSelectionAttributes()}><span class="fluent-icon" aria-hidden="true">&#xE8B7;</span>Browse folders</button>
      <button class="button button-secondary" type="button" data-action="type-path">Enter a path</button>
    </div>
    <div class="assurance-list">
      <div class="assurance-item"><span class="fluent-icon" aria-hidden="true">&#xE73E;</span><span>Nothing changes until you start a sync.</span></div>
      <div class="assurance-item"><span class="fluent-icon" aria-hidden="true">&#xE72E;</span><span>Connections are encrypted directly between paired devices.</span></div>
      <div class="assurance-item"><span class="fluent-icon" aria-hidden="true">&#xE7BA;</span><span>Independent edits are kept as conflicts, never silently overwritten.</span></div>
    </div>
  </section></div>`;
  renderInspectorEmpty('Choose a folder to see its details.');
}

function renderUninitialized() {
  main.innerHTML = `<div class="onboarding"><section class="onboarding-panel">
    <div class="onboarding-symbol fluent-icon" aria-hidden="true">&#xE7C3;</div>
    <h2>${escapeHtml(model.folder.name)} is ready to be added</h2>
    <p>Carry keeps this device’s identity, trusted peers, and recovery history in private local app data, outside the selected folder.</p>
    <div class="onboarding-actions">
      <button class="button button-primary" type="button" data-action="show-init">Initialize folder</button>
      <button class="button button-secondary" type="button" data-action="choose-folder"${folderSelectionAttributes()}>Choose another</button>
    </div>
    <div class="assurance-list">
      <div class="assurance-item"><span class="fluent-icon" aria-hidden="true">&#xE73E;</span><span>${model.files} existing file${model.files === 1 ? '' : 's'} will stay in place.</span></div>
      <div class="assurance-item"><span class="fluent-icon" aria-hidden="true">&#xE8B7;</span><span>Git metadata is excluded automatically.</span></div>
    </div>
  </section></div>`;
  renderInspectorEmpty('Initialize this folder to pair a device.');
}

function renderOverview() {
  const peer = selectedPeer();
  const latest = model.sessions[0];
  const conflicts = conflictsFromSessions();
  const jobRunning = model.job && model.job.status === 'running';
  const remoteFailure = model.remote && model.remote.status === 'error' && model.remote.error
    ? model.remote.error : null;
  const temporaryRemoteFailure = Boolean(remoteFailure && /localhost\.run|temporary|address expired/i.test(remoteFailure));
  const remote = model.remote && model.remote.status === 'ready' ? model.remote : null;
  const remoteMembers = remote && Array.isArray(remote.members) ? remote.members : [];
  const onlineRemoteMembers = remoteMembers.filter((member) => member.peerOnline);
  const selectedRemoteMember = peer && remoteMembers.find((member) => member.peerId === peer.deviceId);
  const teamRemoteSession = Boolean(remote && Number(remote.maxDevices) > 2);
  const remoteConnected = Boolean(remote && peer && (selectedRemoteMember || remote.peerId === peer.deviceId));
  const remoteOnline = Boolean(remoteConnected && (selectedRemoteMember ? selectedRemoteMember.peerOnline : remote.peerOnline));
  const remoteMemberNames = remoteMembers.map((member) => peerById(member.peerId)?.name || `Device ${String(member.peerId).slice(0, 8)}`);
  const otherDeviceCount = remoteMembers.length;
  const onlineDeviceCount = onlineRemoteMembers.length;
  const otherDeviceLabel = `${otherDeviceCount} other device${otherDeviceCount === 1 ? '' : 's'}`;
  const remoteTargetTitle = teamRemoteSession
    ? otherDeviceCount ? otherDeviceLabel : 'Waiting for devices'
    : peer ? peer.name : 'No peer selected';
  const remoteTargetDetail = teamRemoteSession
    ? otherDeviceCount
      ? `${onlineDeviceCount} online · ${remoteMemberNames.join(', ')}`
      : `${remote.availableSlots || 0} invitation slot${remote.availableSlots === 1 ? '' : 's'} available`
    : peer ? peer.deviceId.slice(0, 8) : 'Pair a device';
  const activeName = activeDeviceName(model.activeDeviceId);
  let stateLabel = 'Ready to sync';
  let stateClass = 'ready';
  if (jobRunning) { stateLabel = model.job.type.includes('sync') ? 'Sync in progress' : 'Pairing in progress'; stateClass = 'running'; }
  else if (conflicts.length) { stateLabel = 'Needs attention'; stateClass = 'danger'; }
  else if (!model.peers.length) { stateLabel = 'No paired device'; stateClass = 'warning'; }
  else if (remoteFailure) {
    stateLabel = temporaryRemoteFailure ? 'Remote address expired' : 'Remote connection unavailable';
    stateClass = 'danger';
  }
  else if (teamRemoteSession && onlineDeviceCount) { stateLabel = otherDeviceCount === 1 ? 'Remote device online' : `${onlineDeviceCount} of ${otherDeviceCount} remote devices online`; stateClass = 'ready'; }
  else if (teamRemoteSession && otherDeviceCount) { stateLabel = `${otherDeviceCount} remote device${otherDeviceCount === 1 ? '' : 's'} offline`; stateClass = 'warning'; }
  else if (teamRemoteSession) { stateLabel = 'Waiting for team devices'; stateClass = 'warning'; }
  else if (remoteOnline) { stateLabel = 'Remote device online'; stateClass = 'ready'; }
  else if (remoteConnected) { stateLabel = 'Remote device offline'; stateClass = 'warning'; }
  else if (model.pending.length) { stateLabel = `${model.pending.length} local change${model.pending.length === 1 ? '' : 's'} ready`; stateClass = 'warning'; }

  const firewallNotice = model.firewallReady ? '' : `<div class="notice notice-warning">
    <span class="fluent-icon" aria-hidden="true">&#xE7BA;</span>
    <div><strong>Local network access is not ready</strong><span>Install Carry’s restricted Windows Firewall rules before pairing.</span></div>
    <button class="button button-secondary" type="button" data-action="firewall">Install rules</button>
  </div>`;

  let remoteNotice = '';
  if (remoteFailure) {
    const recoveryAction = model.remote.action === 'sync' && peer
      ? `data-action="show-sync" data-sync-peer="${encoded(peer.deviceId)}"`
      : 'data-action="show-remote-pair"';
    remoteNotice = `<div class="notice notice-warning">
      <span class="fluent-icon" aria-hidden="true">&#xE7BA;</span>
      <div><strong>${temporaryRemoteFailure ? 'The temporary remote address expired' : 'The hosted relay is unavailable'}</strong><span>${escapeHtml(remoteFailure)}</span></div>
      <button class="button button-secondary" type="button" ${recoveryAction}>${temporaryRemoteFailure ? 'Create new invitation' : 'Try again'}</button>
    </div>`;
  } else if (teamRemoteSession) {
    const teamNoticeTitle = !otherDeviceCount
      ? 'Team session is ready for other devices'
      : otherDeviceCount === 1
        ? (onlineDeviceCount ? `${remoteMemberNames[0]} is online` : `${remoteMemberNames[0]} is currently offline`)
        : onlineDeviceCount
          ? `${onlineDeviceCount} of ${otherDeviceLabel} online`
          : `${otherDeviceLabel} currently offline`;
    const teamNoticeCopy = !otherDeviceCount
      ? 'Keep Carry open while the other devices join with the private invitation.'
      : onlineDeviceCount
        ? 'Choose any paired device when you start a sync; each encrypted transfer remains device-to-device.'
        : 'Those devices must be powered on with Carry running before they can answer a sync.';
    remoteNotice = `<div class="notice ${onlineDeviceCount ? 'notice-success' : 'notice-warning'}">
      <span class="fluent-icon" aria-hidden="true">&#xE72E;</span>
      <div><strong>${escapeHtml(teamNoticeTitle)}</strong><span>${escapeHtml(teamNoticeCopy)}</span></div>
      <button class="button button-secondary" type="button" data-action="stop-remote">Stop session</button>
    </div>`;
  } else if (remoteConnected) {
    remoteNotice = `<div class="notice ${remoteOnline ? 'notice-success' : 'notice-warning'}">
      <span class="fluent-icon" aria-hidden="true">&#xE72E;</span>
      <div><strong>${remoteOnline ? `${escapeHtml(peer.name)} is online for one-click sync` : `${escapeHtml(peer.name)} is currently offline`}</strong><span>${remoteOnline ? 'Press Sync now on either device; Carry starts the other side automatically, even when its window is closed.' : 'That device must be powered on with Carry running in the background before it can answer a sync.'}</span></div>
      <button class="button button-secondary" type="button" data-action="stop-remote">Stop session</button>
    </div>`;
  }

  const laneLabel = jobRunning && model.job.type.includes('sync')
    ? 'Encrypted transfer'
    : teamRemoteSession
      ? otherDeviceCount ? `${otherDeviceCount + 1}-device encrypted session` : 'Encrypted team session'
      : remoteOnline ? 'Remote device ready' : remoteConnected ? 'Waiting for remote device' : 'AES-256 encrypted link';
  const remoteIconCount = teamRemoteSession && otherDeviceCount
    ? `<small class="node-icon-count">${otherDeviceCount}</small>`
    : '';

  main.innerHTML = `${firewallNotice}${remoteNotice}
    <section class="status-strip" aria-label="Project status">
      <div class="status-cell"><span class="status-label">Status</span><span class="status-value"><i class="state-dot ${stateClass}"></i><strong>${escapeHtml(stateLabel)}</strong></span></div>
      <div class="status-cell"><span class="status-label">Tracked files</span><span class="status-value"><strong>${model.files}</strong></span></div>
      <div class="status-cell"><span class="status-label">Local changes</span><span class="status-value"><strong>${model.pending.length}</strong></span></div>
      <div class="status-cell"><span class="status-label">Active device</span><span class="status-value"><strong>${escapeHtml(activeName)}</strong></span></div>
      <div class="status-cell"><span class="status-label">Last sync</span><span class="status-value"><strong>${latest ? escapeHtml(relativeTime(latest.completedAt || latest.startedAt)) : 'Not yet'}</strong></span></div>
    </section>

    <section class="transfer-lane ${jobRunning && model.job.type.includes('sync') ? 'is-running' : ''}" aria-label="Device connection overview">
      <div class="device-node">
        <span class="node-icon fluent-icon" aria-hidden="true">&#xE7F4;</span>
        <span class="node-copy"><strong>This device</strong><span>${escapeHtml(model.project.deviceId.slice(0, 8))}</span></span>
      </div>
      <div class="lane-track"><span class="lane-label">${escapeHtml(laneLabel)}</span><i class="lane-packet"></i></div>
      <div class="device-node">
        <span class="node-copy"><strong>${escapeHtml(remoteTargetTitle)}</strong><span>${escapeHtml(remoteTargetDetail)}</span></span>
        <span class="node-icon fluent-icon" aria-hidden="true">&#xE8CE;${remoteIconCount}</span>
      </div>
    </section>

    <div class="overview-columns">
      <section class="content-section">
        <div class="section-heading"><h2>Changes ready</h2><span>Compared with the last successful sync</span></div>
        <div class="list-panel">${renderPendingRows()}</div>
      </section>
      <section class="content-section">
        <div class="section-heading"><h2>Recent activity</h2><button class="button button-quiet section-action" type="button" data-view-jump="activity">View all</button></div>
        <div class="list-panel">${renderSessionRows(model.sessions.slice(0, 6))}</div>
      </section>
    </div>`;

  if (latest && !selectedSessionId) selectedSessionId = latest.sessionId;
  renderInspector();
}

function renderPendingRows() {
  if (!model.peers.length) {
    return emptyPanel('\uE772', 'Pair a device first', 'Carry needs one trusted peer before it can calculate and exchange updates.', '<button class="button button-secondary" type="button" data-action="show-pair">Pair device</button>');
  }
  if (!model.pending.length) {
    return emptyPanel('\uE73E', 'No local changes waiting', 'Run a sync to check the selected device for remote changes.', '');
  }
  const rows = model.pending.slice(0, 9).map((change) => `<div class="change-row">
    <span class="file-action ${escapeHtml(change.action)}">${escapeHtml(actionLetter(change.action))}</span>
    <span class="file-path" title="${escapeHtml(change.path)}">${escapeHtml(change.path)}</span>
    <span class="row-meta">${escapeHtml(actionLabel(change.action))}</span>
  </div>`).join('');
  const remainder = model.pending.length - 9;
  return rows + (remainder > 0 ? `<div class="change-row"><span></span><span class="row-meta">${remainder} more change${remainder === 1 ? '' : 's'}</span><span></span></div>` : '');
}

function renderSessionRows(sessions) {
  if (!sessions.length) return emptyPanel('\uE81C', 'No sync activity yet', 'Your completed sessions will appear here.', '');
  return sessions.map((session) => {
    const peer = peerById(session.peerId);
    const hasConflict = (session.conflicts || []).length > 0;
    return `<button class="session-row" type="button" data-session="${encoded(session.sessionId)}">
      <span class="session-symbol fluent-icon" aria-hidden="true">${hasConflict ? '\uE7BA' : '\uE895'}</span>
      <span class="session-primary"><strong>${peer ? escapeHtml(peer.name) : 'Paired device'}</strong><span>${escapeHtml(relativeTime(session.completedAt || session.startedAt))}</span></span>
      <span class="session-summary">${escapeHtml(sessionSummary(session))}</span>
      <span class="row-chevron fluent-icon" aria-hidden="true">&#xE76C;</span>
    </button>`;
  }).join('');
}

function renderActivity() {
  currentDiff = null;
  main.innerHTML = `<div class="activity-toolbar"><span class="toolbar-summary">${model.sessions.length} recorded session${model.sessions.length === 1 ? '' : 's'}</span><span class="toolbar-spacer"></span><span class="badge">Stored only on this PC</span></div>
    <div class="list-panel">${renderSessionRows(model.sessions)}</div>`;
  renderInspector();
}

function sessionById(sessionId) {
  return (model?.sessions || []).find((session) => session.sessionId === sessionId) || null;
}

function sessionMemoryAdditionCount(session) {
  const memory = session?.memory;
  return memory
    ? (memory.addedEntities || 0) + (memory.addedObservations || 0) + (memory.addedRelations || 0)
    : 0;
}

function latestMemorySession() {
  return (model?.sessions || []).find((session) =>
    session.status === 'completed' && session.memory?.status === 'changed' &&
    sessionMemoryAdditionCount(session) > 0) || null;
}

function memoryChangesForItem(session, name) {
  const memory = session?.memory || {};
  return {
    entity: (memory.entities || []).find((item) => item.name === name) || null,
    observations: (memory.observations || []).filter((item) => item.name === name),
    relations: (memory.relations || []).filter((item) => item.from === name || item.to === name),
  };
}

function memoryItemByName(name) {
  return memoryModel && Array.isArray(memoryModel.items)
    ? memoryModel.items.find((item) => item.name === name)
    : null;
}

function memorySourceLabel(observation) {
  if (!observation) return 'Source not recorded';
  if (observation.provenance?.peerId) {
    const peer = peerById(observation.provenance.peerId);
    const when = observation.provenance.receivedAt ? ` · ${relativeTime(observation.provenance.receivedAt)}` : '';
    return `Synced from ${peer ? peer.name : 'a paired device'}${when}`;
  }
  const attribution = !observation.author && observation.text
    ? String(observation.text).match(/\(([^,()]{1,80}),\s*(\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2})?)\)\s*$/)
    : null;
  const author = observation.author || attribution?.[1];
  const recordedAt = observation.recordedAt || attribution?.[2];
  if (author) {
    const when = recordedAt ? ` · ${formatDate(recordedAt, false)}` : '';
    return `Recorded by ${author}${when}`;
  }
  return 'Source not recorded';
}

function memoryUpdatedAt(item) {
  const times = (item?.observations || []).flatMap((observation) => {
    const fallback = String(observation.text || '').match(/\([^,()]{1,80},\s*(\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2})?)\)\s*$/)?.[1];
    return [
      Date.parse(observation.recordedAt || fallback || ''),
      Date.parse(observation.provenance?.receivedAt || ''),
    ];
  }).filter(Number.isFinite);
  return times.length ? new Date(Math.max(...times)).toISOString() : null;
}

function memoryRelationLabel(relation, itemName) {
  if (relation.from === itemName && relation.to === itemName) {
    return `${relation.relationType} itself`;
  }
  if (relation.direction === 'outgoing') {
    return `${relation.relationType} ${relation.to}`;
  }
  return `${relation.from} ${relation.relationType} this item`;
}

function memoryRows(items) {
  if (!items.length) {
    const emptyTitle = memoryQuery ? 'No memory matches this search' : 'No shared memory yet';
    const emptyCopy = memoryQuery
      ? 'Try a name, type, observation, or related item.'
      : 'Your coding agents will add project facts and handoffs here as they work.';
    return emptyPanel('\uE8F1', emptyTitle, emptyCopy, '');
  }
  const highlightedSession = sessionById(memoryHighlightSessionId);
  return items.map((item) => {
    const preview = item.observations[0]?.text || 'No observations recorded';
    const updatedAt = memoryUpdatedAt(item);
    const changes = memoryChangesForItem(highlightedSession, item.name);
    const highlighted = Boolean(changes.entity || changes.observations.length || changes.relations.length);
    return `<button class="memory-row ${item.pinned ? 'is-pinned' : ''} ${highlighted ? 'is-sync-highlight' : ''}" type="button" data-memory-item="${encoded(item.name)}">
      <span class="memory-symbol fluent-icon" aria-hidden="true">${item.pinned ? '\uE718' : '\uE8F1'}</span>
      <span class="memory-primary"><span><strong>${escapeHtml(item.name)}</strong><em>${escapeHtml(item.entityType)}</em>${highlighted ? '<b>Added in this sync</b>' : ''}</span><small>${escapeHtml(preview)}</small></span>
      <span class="memory-summary">${item.observations.length} note${item.observations.length === 1 ? '' : 's'} · ${item.relations.length} link${item.relations.length === 1 ? '' : 's'}${updatedAt ? ` · ${escapeHtml(relativeTime(updatedAt))}` : ''}</span>
      <span class="row-chevron fluent-icon" aria-hidden="true">&#xE76C;</span>
    </button>`;
  }).join('');
}

function filteredMemoryItems() {
  const items = memoryModel?.items || [];
  const query = memoryQuery.trim().toLocaleLowerCase();
  if (!query) return items;
  return items.filter((item) => [
    item.name,
    item.entityType,
    ...item.observations.map((observation) => observation.text),
    ...item.relations.flatMap((relation) => [relation.from, relation.to, relation.relationType]),
  ].some((value) => String(value || '').toLocaleLowerCase().includes(query)));
}

function renderMemory() {
  currentDiff = null;
  if (!memoryModel) {
    main.innerHTML = '<div class="memory-loading"><span class="checkpoint-impact-spinner" aria-hidden="true"></span>Loading the shared graph…</div>';
    renderInspectorEmpty('Select a memory item to inspect it.');
    return;
  }
  if (memoryModel.error) {
    main.innerHTML = emptyPanel('\uE783', 'Shared memory could not be read', memoryModel.error,
      '<button class="button button-secondary" type="button" data-action="reload-memory">Try again</button>');
    renderInspectorEmpty('Shared memory is unavailable.');
    return;
  }
  const summary = memoryModel.summary;
  const items = filteredMemoryItems();
  const highlightedSession = sessionById(memoryHighlightSessionId);
  const highlightedPeer = highlightedSession ? peerById(highlightedSession.peerId) : null;
  const latestSession = latestMemorySession();
  if (!selectedMemorySnapshot && !memoryItemByName(selectedMemoryName)) {
    selectedMemoryName = items[0]?.name || memoryModel.items[0]?.name || null;
  }
  main.innerHTML = `<div class="memory-toolbar">
      <label class="memory-search">
        <span class="fluent-icon" aria-hidden="true">&#xE721;</span>
        <span class="visually-hidden">Search shared memory</span>
        <input id="memory-search" type="search" value="${escapeHtml(memoryQuery)}" placeholder="Search names, notes, and links" autocomplete="off">
      </label>
      <span class="toolbar-spacer"></span>
      ${!highlightedSession && latestSession
        ? '<button class="button button-quiet memory-latest-sync" type="button" data-action="review-latest-memory-sync">Review latest sync additions</button>'
        : ''}
      <span class="badge">${summary.entities} items · ${summary.relations} graph links</span>
    </div>
    ${highlightedSession ? `<div class="memory-review-bar">
      <span class="fluent-icon" aria-hidden="true">&#xE895;</span>
      <div><strong>Reviewing additions from ${escapeHtml(highlightedPeer?.name || 'a paired device')}</strong><span>${escapeHtml(formatDate(highlightedSession.completedAt || highlightedSession.startedAt, true))}. Matching items and details are highlighted.</span></div>
      <button class="button button-quiet" type="button" data-action="clear-memory-highlight">Clear review</button>
    </div>` : ''}
    <div class="memory-ledger-note">
      <span class="fluent-icon" aria-hidden="true">&#xE946;</span>
      <div><strong>This is agent context, not activity history</strong><span>Edit the facts agents can reuse here. Sync sessions and recovery checkpoints remain in their own audit views.</span></div>
    </div>
    <div class="list-panel memory-list">${memoryRows(items)}</div>`;
  renderInspector();
}

async function loadMemory(options) {
  options = options || {};
  const requestId = ++memoryRequestId;
  if (!memoryModel && activeView === 'memory') renderMemory();
  try {
    const loaded = await api('/api/memory');
    if (requestId !== memoryRequestId) return;
    memoryModel = loaded;
    if (model) model.memory = loaded.summary;
    if (options.selectName) selectedMemoryName = options.selectName;
    if (options.snapshot) selectedMemorySnapshot = options.snapshot;
    if (activeView === 'memory') renderView();
    else renderTopChrome();
  } catch (error) {
    if (requestId !== memoryRequestId) return;
    memoryModel = { error: error.message, summary: model?.memory || {}, items: [] };
    if (activeView === 'memory') renderMemory();
    if (!options.silent) showToast(error.message, 'error');
  }
}

async function openMemoryItem(name, snapshot, options) {
  options = options || {};
  activeView = 'memory';
  selectedMemoryName = name;
  selectedMemorySnapshot = snapshot || null;
  memoryHighlightSessionId = options.highlightSessionId || null;
  syncNav();
  if (!memoryModel || memoryModel.summary?.revision !== model?.memory?.revision) {
    await loadMemory({ selectName: name, snapshot });
  }
  else renderView();
}

function renderMemoryLinkList(names, sourceLabel) {
  const unique = [...new Set(names || [])];
  if (!unique.length) return '';
  const visible = unique.slice(0, 50);
  const remainder = unique.length - visible.length;
  return `<section class="memory-links" aria-label="Linked shared memory">
    <div class="section-heading"><h2>Shared memory</h2><p>${escapeHtml(sourceLabel)}</p></div>
    <div class="memory-link-list">${visible.map((name) =>
      `<button class="memory-link" type="button" data-memory-link="${encoded(name)}"><span class="fluent-icon" aria-hidden="true">&#xE8F1;</span><span>${escapeHtml(name)}</span><span class="fluent-icon" aria-hidden="true">&#xE76C;</span></button>`).join('')}
      ${remainder ? `<button class="memory-link" type="button" data-view-jump="memory"><span class="fluent-icon" aria-hidden="true">&#xE8F1;</span><span>${remainder} more memory item${remainder === 1 ? '' : 's'}</span><span class="fluent-icon" aria-hidden="true">&#xE76C;</span></button>` : ''}
    </div>
  </section>`;
}

function renderSessionMemoryChanges(session, peer) {
  const memory = session?.memory;
  if (!memory || memory.status !== 'changed' || sessionMemoryAdditionCount(session) === 0) return '';
  const entities = memory.entities || [];
  const observations = memory.observations || [];
  const relations = memory.relations || [];
  const hasExactRecords = entities.length || observations.length || relations.length;
  if (!hasExactRecords) {
    return renderMemoryLinkList(
      memory.entityNames,
      `${memory.addedEntities || 0} items · ${memory.addedObservations || 0} observations · from ${peer ? peer.name : 'paired device'}`,
    );
  }
  const sessionAttr = encoded(session.sessionId);
  const entityRows = entities.map((item) => `<button class="memory-sync-change entity-change" type="button" data-memory-link="${encoded(item.name)}" data-memory-session="${sessionAttr}">
    <span class="memory-change-symbol fluent-icon" aria-hidden="true">&#xE8F1;</span>
    <span class="memory-change-copy"><strong>${escapeHtml(item.name)}</strong><span>New ${escapeHtml(item.entityType || 'entity')} item</span></span>
    <span class="memory-change-kind">Item</span>
    <span class="row-chevron fluent-icon" aria-hidden="true">&#xE76C;</span>
  </button>`).join('');
  const observationRows = observations.map((item) => `<button class="memory-sync-change observation-change" type="button" data-memory-link="${encoded(item.name)}" data-memory-session="${sessionAttr}">
    <span class="memory-change-symbol" aria-hidden="true">+</span>
    <span class="memory-change-copy"><strong>${escapeHtml(item.name)}</strong><span>${escapeHtml(item.text)}</span></span>
    <span class="memory-change-kind">Observation</span>
    <span class="row-chevron fluent-icon" aria-hidden="true">&#xE76C;</span>
  </button>`).join('');
  const relationRows = relations.map((item) => `<button class="memory-sync-change relation-change" type="button" data-memory-link="${encoded(item.from)}" data-memory-session="${sessionAttr}">
    <span class="memory-change-symbol fluent-icon" aria-hidden="true">&#xE71B;</span>
    <span class="memory-change-copy"><strong>${escapeHtml(item.from)}</strong><span>${escapeHtml(item.relationType)} &rarr; ${escapeHtml(item.to)}</span></span>
    <span class="memory-change-kind">Relationship</span>
    <span class="row-chevron fluent-icon" aria-hidden="true">&#xE76C;</span>
  </button>`).join('');
  const recordedCount = entities.length + observations.length + relations.length;
  const totalCount = sessionMemoryAdditionCount(session);
  return `<section class="memory-sync-changes" aria-label="Shared memory added in this sync">
    <div class="section-heading"><h2>Memory added in this sync</h2><p>${totalCount} addition${totalCount === 1 ? '' : 's'} from ${escapeHtml(peer?.name || 'a paired device')}</p></div>
    <div class="memory-sync-change-list">${entityRows}${observationRows}${relationRows}</div>
    ${memory.recordsTruncated || recordedCount < totalCount
      ? '<p class="memory-sync-truncated">This unusually large sync has more memory additions. Open the affected items to review the complete current graph.</p>'
      : ''}
  </section>`;
}

function checkpointKind(checkpoint) {
  if (checkpoint.kind === 'automatic') return 'Before sync';
  if (checkpoint.kind === 'restore-safety') return 'Restore safety';
  return 'Named checkpoint';
}

function checkpointImpactSummary(counts) {
  if (!counts || !counts.total) return 'No files would change';
  const parts = [];
  if (counts.restore) parts.push(`${counts.restore} restored`);
  if (counts.replace) parts.push(`${counts.replace} replaced`);
  if (counts.delete) parts.push(`${counts.delete} deleted`);
  return `${counts.total} file${counts.total === 1 ? '' : 's'} will change · ${parts.join(' · ')}`;
}

function checkpointChangePresentation(action) {
  if (action === 'restore') return { className: 'added', symbol: '+', label: 'Restore' };
  if (action === 'replace') return { className: 'modified', symbol: 'M', label: 'Replace' };
  return { className: 'deleted', symbol: '−', label: 'Delete' };
}

function checkpointMemorySummary(counts) {
  if (!counts || !counts.total) return 'No shared memory would change';
  const parts = [];
  if (counts.restore) parts.push(`${counts.restore} restored`);
  if (counts.replace) parts.push(`${counts.replace} reverted`);
  if (counts.delete) parts.push(`${counts.delete} removed`);
  return `${counts.total} item${counts.total === 1 ? '' : 's'} will change · ${parts.join(' · ')}`;
}

function renderCheckpointMemoryImpact(preview) {
  if (preview.status !== 'ready' || !preview.memoryCounts?.total) return '';
  return `<section class="checkpoint-impact checkpoint-memory-impact" aria-label="Shared memory affected by restore">
    <div class="checkpoint-impact-header"><div><h3>Shared memory</h3><p>${escapeHtml(checkpointMemorySummary(preview.memoryCounts))}</p></div></div>
    <div class="checkpoint-impact-list" role="list">${preview.memoryChanges.map((change) => {
      const presentation = checkpointChangePresentation(change.action);
      const version = change.action === 'delete' ? 'current' : 'checkpoint';
      const label = change.action === 'delete' ? 'Will be removed' : change.action === 'restore' ? 'Will be restored' : 'Will revert';
      return `<button class="checkpoint-impact-row checkpoint-memory-row" type="button" role="listitem" data-memory-link="${encoded(change.name)}" data-memory-version="${version}">
        <span class="file-action ${presentation.className}">${presentation.symbol}</span>
        <span class="checkpoint-impact-path" title="${escapeHtml(change.name)}">${escapeHtml(change.name)}</span>
        <span class="checkpoint-impact-action">${label}</span>
      </button>`;
    }).join('')}</div>
  </section>`;
}

function renderCheckpointImpact(checkpointId) {
  const preview = checkpointPreview && checkpointPreview.checkpointId === checkpointId
    ? checkpointPreview
    : { status: 'loading' };
  let body;
  if (preview.status === 'error') {
    body = `<div class="checkpoint-impact-state checkpoint-impact-error"><span>${escapeHtml(preview.error)}</span><button class="button button-quiet" type="button" data-action="refresh-checkpoint-preview" data-checkpoint-id="${encoded(checkpointId)}">Try again</button></div>`;
  } else if (preview.status !== 'ready') {
    body = '<div class="checkpoint-impact-state"><span class="checkpoint-impact-spinner" aria-hidden="true"></span>Checking the current folder…</div>';
  } else if (!preview.counts.total) {
    body = '<div class="checkpoint-impact-state checkpoint-impact-clean"><span class="fluent-icon" aria-hidden="true">&#xE73E;</span>No files would be changed.</div>';
  } else {
    body = `<div class="checkpoint-impact-list" role="list">${preview.changes.map((change) => {
      const presentation = checkpointChangePresentation(change.action);
      return `<div class="checkpoint-impact-row" role="listitem">
        <span class="file-action ${presentation.className}">${presentation.symbol}</span>
        <span class="checkpoint-impact-path" title="${escapeHtml(change.path)}">${escapeHtml(change.path)}</span>
        <span class="checkpoint-impact-action">${presentation.label}</span>
      </div>`;
    }).join('')}</div>`;
  }
  const summary = preview.status === 'ready'
    ? checkpointImpactSummary(preview.counts)
    : preview.status === 'error' ? 'Preview unavailable' : 'Comparing with the current folder';
  return `<section class="checkpoint-impact" aria-label="Files affected by restore">
    <div class="checkpoint-impact-header"><div><h3>Files affected</h3><p>${escapeHtml(summary)}</p></div>
      <button class="checkpoint-impact-refresh fluent-icon" type="button" data-action="refresh-checkpoint-preview" data-checkpoint-id="${encoded(checkpointId)}" aria-label="Refresh affected files" title="Refresh affected files">&#xE72C;</button>
    </div>
    ${body}
  </section>
  ${renderCheckpointMemoryImpact(preview)}`;
}

async function loadCheckpointPreview(checkpointId) {
  if (!checkpointId) return;
  const requestId = ++checkpointPreviewRequestId;
  checkpointPreview = { checkpointId, status: 'loading' };
  if (activeView === 'checkpoints' && selectedCheckpointId === checkpointId) renderInspector();
  try {
    const preview = await api(`/api/checkpoints/preview?id=${encoded(checkpointId)}`);
    if (requestId !== checkpointPreviewRequestId || selectedCheckpointId !== checkpointId) return;
    checkpointPreview = { ...preview, checkpointId, status: 'ready' };
  } catch (err) {
    if (requestId !== checkpointPreviewRequestId || selectedCheckpointId !== checkpointId) return;
    checkpointPreview = { checkpointId, status: 'error', error: err.message };
  }
  if (activeView === 'checkpoints') renderInspector();
}

function renderCheckpointRows(items) {
  if (!items.length) return emptyPanel('\uE823', 'No checkpoints yet', 'Create a named restore point before a major change. Carry also saves one automatically before incoming sync changes.', '<button class="button button-primary" type="button" data-action="create-checkpoint">Create checkpoint</button>');
  return items.map((checkpoint) => `<button class="checkpoint-row" type="button" data-checkpoint="${encoded(checkpoint.checkpointId)}">
    <span class="checkpoint-symbol fluent-icon" aria-hidden="true">&#xE823;</span>
    <span class="checkpoint-primary"><strong>${escapeHtml(checkpoint.name)}</strong><span>${escapeHtml(relativeTime(checkpoint.createdAt))} · ${escapeHtml(checkpointKind(checkpoint))}</span></span>
    <span class="checkpoint-summary">${checkpoint.projectFileCount ?? checkpoint.fileCount} file${(checkpoint.projectFileCount ?? checkpoint.fileCount) === 1 ? '' : 's'}${checkpoint.memoryIncluded ? ' · memory' : ''}</span>
    <span class="row-chevron fluent-icon" aria-hidden="true">&#xE76C;</span>
  </button>`).join('');
}

function renderCheckpoints() {
  currentDiff = null;
  const checkpoints = model.checkpoints || [];
  main.innerHTML = `<div class="checkpoint-toolbar"><span class="toolbar-summary">${checkpoints.length} restore point${checkpoints.length === 1 ? '' : 's'}</span><span class="toolbar-spacer"></span><span class="badge">Stored only on this PC</span></div>
    <div class="notice"><span class="fluent-icon" aria-hidden="true">&#xE7BA;</span><div><strong>Restoring changes the working folder</strong><span>Carry creates a safety checkpoint first. Sync afterward only if you want the restored version sent to the other device.</span></div></div>
    <div class="list-panel">${renderCheckpointRows(checkpoints)}</div>`;
  if (!checkpoints.some((item) => item.checkpointId === selectedCheckpointId)) {
    selectedCheckpointId = checkpoints[0]?.checkpointId || null;
    checkpointPreview = null;
    checkpointPreviewRequestId++;
  }
  renderInspector();
  if (selectedCheckpointId && (!checkpointPreview || checkpointPreview.checkpointId !== selectedCheckpointId)) {
    loadCheckpointPreview(selectedCheckpointId);
  }
}

function renderConflicts() {
  const conflicts = conflictsFromSessions();
  if (currentDiff) return renderDiff();
  const availableKeys = new Set(conflicts.map((item) => item.key));
  for (const key of selectedConflictKeys) if (!availableKeys.has(key)) selectedConflictKeys.delete(key);
  const selected = conflicts.filter((item) => selectedConflictKeys.has(item.key));
  const selectedPeers = [...new Set(selected.map((item) => item.session.peerId))];
  const peerLabel = selectedPeers.length === 1
    ? peerById(selectedPeers[0])?.name || 'peer'
    : 'peer devices';
  const localIsActive = model.activeDeviceId === model.project.deviceId;
  const selectedPeerIsActive = selectedPeers.length === 1 && model.activeDeviceId === selectedPeers[0];
  const allSelected = conflicts.length > 0 && selected.length === conflicts.length;
  const selectionTools = conflicts.length ? `<label class="conflict-select-all"><input type="checkbox" data-action="select-all-conflicts" ${allSelected ? 'checked' : ''}><span>Select all</span></label>
    <span class="selection-count">${selected.length} selected</span>
    <span class="toolbar-spacer"></span>
    <div class="bulk-conflict-actions">
      <button class="button ${localIsActive ? 'button-primary' : 'button-secondary'}" type="button" data-action="bulk-resolve-conflicts" data-choice="local" ${selected.length ? '' : 'disabled'}>Keep this device${localIsActive ? ' · Active' : ''}</button>
      <button class="button ${selectedPeerIsActive ? 'button-primary' : 'button-secondary'}" type="button" data-action="bulk-resolve-conflicts" data-choice="remote" ${selected.length ? '' : 'disabled'}>Keep ${escapeHtml(peerLabel)}${selectedPeerIsActive ? ' · Active' : ''}</button>
    </div>` : '<span class="toolbar-spacer"></span><span class="badge badge-warning">Working files are untouched</span>';
  main.innerHTML = `<div class="conflict-toolbar"><span class="toolbar-summary">${conflicts.length ? `${conflicts.length} file${conflicts.length === 1 ? '' : 's'} need review` : 'No conflicts need review'}</span>${selectionTools}</div>
    ${conflicts.length ? '<div class="bulk-resolution-note"><span class="fluent-icon" aria-hidden="true">&#xE946;</span><span>Select related files and choose one side once. Carry validates the whole selection first and creates one recovery checkpoint before replacing anything.</span></div>' : ''}
    <div class="list-panel">${conflicts.length ? conflicts.map(({ path, session, key }) => `<div class="conflict-row ${selectedConflictKeys.has(key) ? 'is-selected' : ''}">
      <label class="conflict-checkbox" title="Select ${escapeHtml(path)}"><input type="checkbox" data-action="toggle-conflict" data-session-id="${encoded(session.sessionId)}" data-file-path="${encoded(path)}" ${selectedConflictKeys.has(key) ? 'checked' : ''}><span aria-hidden="true"></span></label>
      <button class="conflict-open" type="button" data-conflict-session="${encoded(session.sessionId)}" data-conflict-path="${encoded(path)}">
        <span class="file-action conflict">!</span>
        <span><span class="conflict-path">${escapeHtml(path)}</span><span class="conflict-meta">${escapeHtml(relativeTime(session.completedAt || session.startedAt))} · ${escapeHtml(peerById(session.peerId)?.name || 'Paired device')}</span></span>
        <span class="badge badge-warning">Compare</span><span class="row-chevron fluent-icon" aria-hidden="true">&#xE76C;</span>
      </button>
    </div>`).join('') : emptyPanel('\uE73E', 'No conflicting edits', 'When both devices change the same file, Carry will preserve both and show the comparison here.', '')}</div>`;
  renderInspectorEmpty(conflicts.length ? 'Choose a file to compare both saved versions.' : 'No conflict details to show.');
}

function renderDevices() {
  const activeOptions = [
    { deviceId: model.project.deviceId, name: `${model.project.name} — this device` },
    ...model.peers.map((peer) => ({ deviceId: peer.deviceId, name: peer.name })),
  ];
  if (model.activeDeviceId && !activeOptions.some((item) => item.deviceId === model.activeDeviceId)) {
    activeOptions.push({ deviceId: model.activeDeviceId, name: activeDeviceName(model.activeDeviceId) });
  }
  const activePicker = `<label class="active-device-picker"><span>Active device</span><select id="active-device-select" class="select-input" aria-label="Choose the active device">
    <option value="" ${model.activeDeviceId ? '' : 'selected'} disabled>Choose source of truth</option>
    ${activeOptions.map((item) => `<option value="${encoded(item.deviceId)}" ${item.deviceId === model.activeDeviceId ? 'selected' : ''}>${escapeHtml(item.name)}</option>`).join('')}
  </select></label>`;
  const rows = model.peers.map((peer) => {
    const remoteMember = (model.remote?.members || []).find((item) => item.peerId === peer.deviceId);
    const connected = peer.connectionEnabled !== false;
    const remoteFailed = connected && peer.transport === 'relay' && model.remote?.status === 'error' &&
      (!model.remote.peerId || model.remote.peerId === peer.deviceId);
    const state = !connected ? 'Disconnected' : remoteMember ? remoteMember.peerOnline ? 'Online' : 'Offline' : remoteFailed ? 'Offline' : 'Paired';
    const active = model.activeDeviceId === peer.deviceId;
    return `<button class="device-row" type="button" data-peer="${encoded(peer.deviceId)}">
    <span class="device-avatar fluent-icon" aria-hidden="true">&#xE8CE;</span>
    <span class="device-main"><strong>${escapeHtml(peer.name)}</strong><span>${escapeHtml(peer.deviceId)}</span></span>
    <span class="device-state"><strong>${active ? 'Active · ' : ''}${state}</strong><br>${escapeHtml(relativeTime(peer.lastSeen))}</span>
    <span class="row-chevron fluent-icon" aria-hidden="true">&#xE76C;</span>
  </button>`;
  }).join('');
  main.innerHTML = `<div class="device-toolbar"><span class="toolbar-summary">${model.peers.length} trusted peer${model.peers.length === 1 ? '' : 's'}</span><span class="toolbar-spacer"></span>${activePicker}</div>
    <div class="active-device-note"><span class="fluent-icon" aria-hidden="true">&#xE73E;</span><span>The active device is the current source of truth. When it participates in a sync, its versions safely win otherwise-ambiguous conflicts. This choice is shared during the next sync.</span></div>
    <div class="list-panel">${rows || emptyPanel('\uE772', 'No paired devices', 'Pair your laptop or another trusted PC to start exchanging this folder.', '<button class="button button-primary" type="button" data-action="show-pair">Pair device</button>')}</div>`;
  if (selectedPeer()) renderPeerInspector(selectedPeer());
  else renderInspectorEmpty('Pair a device to see its connection details.');
}

function renderDiff() {
  const diff = currentDiff;
  const binary = diff.local.binary || diff.remote.binary;
  const missing = diff.local.missing || diff.remote.missing;
  const peer = peerById(diff.peerId);
  const peerName = peer?.name || 'Peer';
  main.innerHTML = `<div class="conflict-toolbar"><button class="button button-secondary" type="button" data-action="back-conflicts"><span class="fluent-icon" aria-hidden="true">&#xE72B;</span>Back to conflicts</button><span class="toolbar-spacer"></span>${missing ? '<span class="badge badge-warning">One side deleted this file</span>' : ''}</div>
    <section class="diff-shell">
      <header class="diff-header"><span class="file-action conflict">!</span><span class="diff-title">${escapeHtml(diff.path)}</span>
        <span class="diff-legend"><span class="legend-item"><i class="legend-swatch local"></i>This device</span><span class="legend-item"><i class="legend-swatch remote"></i>${escapeHtml(peerName)}</span></span>
      </header>
      ${binary ? emptyPanel('\uE7BA', 'Binary files cannot be previewed', `Local: ${diff.local.bytes} bytes · Peer: ${diff.remote.bytes} bytes`, '') : `<div class="diff-table" role="table" aria-label="File comparison">${diff.rows.map((row) => `<div class="diff-line ${row.type}" role="row"><span class="diff-number">${row.left || ''}</span><span class="diff-number">${row.right || ''}</span><span class="diff-sign">${row.type === 'add' ? '+' : row.type === 'remove' ? '−' : ''}</span><span class="diff-code">${escapeHtml(row.text)}</span></div>`).join('')}</div>`}
    </section>`;
  const localLabel = diff.local.missing ? 'Keep this device\'s deletion' : 'Keep this device\'s version';
  const remoteLabel = diff.remote.missing ? `Keep ${peerName}'s deletion` : `Keep ${peerName}'s version`;
  inspector.innerHTML = `<div class="inspector-content conflict-inspector">
    <p class="inspector-kicker">Resolve conflict</p>
    <h2>Which version should Carry keep?</h2>
    <p>Your selection is applied here safely. The next sync sends the decision to the other device.</p>
    <div class="resolution-options">
      <button class="resolution-choice" type="button" data-action="resolve-conflict" data-choice="local" data-session-id="${encoded(diff.sessionId)}" data-file-path="${encoded(diff.path)}">
        <span class="resolution-icon local fluent-icon" aria-hidden="true">&#xE7C3;</span><span><strong>${escapeHtml(localLabel)}</strong><small>${diff.local.missing ? 'The file will remain deleted.' : `${formatBytes(diff.local.bytes)} saved at conflict time.`}</small></span>
      </button>
      <button class="resolution-choice" type="button" data-action="resolve-conflict" data-choice="remote" data-session-id="${encoded(diff.sessionId)}" data-file-path="${encoded(diff.path)}">
        <span class="resolution-icon remote fluent-icon" aria-hidden="true">&#xE968;</span><span><strong>${escapeHtml(remoteLabel)}</strong><small>${diff.remote.missing ? 'The local file will be deleted.' : `${formatBytes(diff.remote.bytes)} received at conflict time.`}</small></span>
      </button>
    </div>
    <div class="resolution-note"><span class="fluent-icon" aria-hidden="true">&#xE946;</span><span>If Carry replaces or deletes the working file, it creates a safety checkpoint first.</span></div>
  </div>`;
}

function renderInspectorEmpty(copy) {
  inspector.innerHTML = `<div class="inspector-empty"><span class="fluent-icon" aria-hidden="true">&#xE946;</span><p>${escapeHtml(copy)}</p></div>`;
}

function renderPeerInspector(peer) {
  const connected = peer.connectionEnabled !== false;
  const deviceActions = activeView === 'devices'
    ? `${connected
      ? `<button class="button button-secondary inspector-disconnect" type="button" data-action="disconnect-device" data-peer-id="${encoded(peer.deviceId)}"><span class="fluent-icon" aria-hidden="true">&#xE8BB;</span>Disconnect device</button>`
      : `<button class="button button-primary inspector-disconnect" type="button" data-action="connect-device" data-peer-id="${encoded(peer.deviceId)}"><span class="fluent-icon" aria-hidden="true">&#xE8CE;</span>Connect device</button>`}
      <button class="button button-danger inspector-disconnect" type="button" data-action="forget-device" data-peer-id="${encoded(peer.deviceId)}"><span class="fluent-icon" aria-hidden="true">&#xE74D;</span>Forget device</button>`
    : '';
  const remoteMember = (model.remote?.members || []).find((item) => item.peerId === peer.deviceId);
  const remoteReady = connected && peer.transport === 'relay' && model.remote && model.remote.status === 'ready' &&
    (model.remote.peerId === peer.deviceId || remoteMember);
  const peerOnline = remoteMember ? remoteMember.peerOnline : model.remote?.peerOnline;
  const remoteFailed = connected && peer.transport === 'relay' && model.remote?.status === 'error' &&
    (!model.remote.peerId || model.remote.peerId === peer.deviceId);
  const temporaryRemoteFailure = remoteFailed && /localhost\.run|temporary|address expired/i.test(model.remote?.error || '');
  const connection = !connected ? 'Disconnected · pairing saved'
    : peer.transport !== 'relay' ? 'Local network' : remoteFailed ? `Remote · ${temporaryRemoteFailure ? 'address expired' : 'unavailable'}` : remoteReady && peerOnline ? 'Remote · online' : remoteReady ? 'Remote · connecting' : 'Encrypted relay';
  const connectionCopy = remoteFailed
    ? temporaryRemoteFailure
      ? 'Paired and trusted. The temporary address expired; start a sync to create or paste a replacement invitation.'
      : 'Paired and trusted. The hosted relay is temporarily unavailable; reconnect or start a sync to retry.'
    : connected
      ? 'Paired and trusted. Carry checks reachability when you connect or start a sync.'
      : 'Pairing and sync history are saved. Reconnect this device whenever you want to use it again.';
  inspector.innerHTML = `<div class="inspector-content">
    <p class="inspector-kicker">Selected sync target</p>
    <h2>${escapeHtml(peer.name)}</h2>
    <p>${escapeHtml(connectionCopy)}</p>
    <div class="peer-inspector-icon fluent-icon" aria-hidden="true">&#xE8CE;</div>
    <dl class="details-list">
      <div class="detail-item"><dt>Trust</dt><dd><span class="badge badge-success">Paired</span></dd></div>
      <div class="detail-item"><dt>Last contact</dt><dd>${escapeHtml(relativeTime(peer.lastSeen))}</dd></div>
      <div class="detail-item"><dt>Connection</dt><dd>${escapeHtml(connection)}</dd></div>
      <div class="detail-item"><dt>Address</dt><dd class="mono">${escapeHtml(peer.address || 'Discovered during sync')}</dd></div>
      <div class="detail-item"><dt>Device ID</dt><dd class="mono">${escapeHtml(peer.deviceId)}</dd></div>
    </dl>
    <button class="button button-primary inspector-sync" type="button" data-action="show-sync" data-sync-peer="${encoded(peer.deviceId)}" ${!connected || model.job && model.job.status === 'running' ? 'disabled' : ''}><span class="fluent-icon" aria-hidden="true">&#xE895;</span>Sync with this device</button>
    ${deviceActions}
  </div>`;
}

function renderMemoryInspector() {
  const snapshot = selectedMemorySnapshot;
  const currentItem = memoryItemByName(selectedMemoryName);
  const item = snapshot?.item || currentItem;
  if (!item) return renderInspectorEmpty('Select a memory item to inspect, edit, pin, or delete it.');
  const observations = (item.observations || []).map((observation) =>
    typeof observation === 'string' ? { text: observation } : observation);
  const relations = item.relations || [];
  const lastUpdated = memoryUpdatedAt({ observations });
  const latestObservation = observations.at(-1);
  const busy = model.job && model.job.status === 'running';
  const highlightedSession = snapshot ? null : sessionById(memoryHighlightSessionId);
  const highlightedPeer = highlightedSession ? peerById(highlightedSession.peerId) : null;
  const highlightedChanges = memoryChangesForItem(highlightedSession, item.name);
  const itemHighlighted = Boolean(
    highlightedChanges.entity || highlightedChanges.observations.length || highlightedChanges.relations.length);
  const highlightedObservations = new Set(highlightedChanges.observations.map((change) => change.text));
  const highlightedRelations = new Set(highlightedChanges.relations.map((change) =>
    `${change.from}\u0000${change.to}\u0000${change.relationType}`));
  const observationRows = observations.map((observation) => {
    const highlighted = highlightedObservations.has(observation.text);
    return `<article class="memory-observation ${highlighted ? 'is-sync-highlight' : ''}">
    <p>${escapeHtml(observation.text)}</p>
    <div class="memory-observation-meta"><span>${escapeHtml(memorySourceLabel(observation))}</span>${highlighted ? '<b>Added in this sync</b>' : ''}</div>
  </article>`;
  }).join('');
  const relationRows = relations.map((relation) => {
    const targetName = relation.from === item.name ? relation.to : relation.from;
    const highlighted = highlightedRelations.has(`${relation.from}\u0000${relation.to}\u0000${relation.relationType}`);
    return `<button class="memory-relation ${highlighted ? 'is-sync-highlight' : ''}" type="button" data-memory-link="${encoded(targetName)}"${highlightedSession ? ` data-memory-session="${encoded(highlightedSession.sessionId)}"` : ''}>
      <span class="fluent-icon" aria-hidden="true">&#xE71B;</span>
      <span class="memory-relation-copy"><span>${escapeHtml(memoryRelationLabel(relation, item.name))}</span>${highlighted ? '<b>Added in this sync</b>' : ''}</span>
      <span class="fluent-icon" aria-hidden="true">&#xE76C;</span>
    </button>`;
  }).join('');
  const snapshotActions = snapshot
    ? `${currentItem
      ? `<button class="button button-secondary inspector-sync" type="button" data-memory-link="${encoded(item.name)}">Open current item</button>`
      : '<p class="memory-snapshot-note">This item exists only inside the selected checkpoint.</p>'}`
    : `<div class="memory-inspector-actions">
        <button class="button button-secondary" type="button" data-action="pin-memory" data-memory-name="${encoded(item.name)}"><span class="fluent-icon" aria-hidden="true">&#xE718;</span>${item.pinned ? 'Unpin item' : 'Pin on this device'}</button>
        <button class="button button-primary" type="button" data-action="edit-memory" data-memory-name="${encoded(item.name)}" ${busy ? 'disabled' : ''}>Edit item</button>
      </div>
      <button class="button button-danger inspector-disconnect" type="button" data-action="delete-memory" data-memory-name="${encoded(item.name)}" ${busy ? 'disabled' : ''}>Delete memory item</button>`;
  inspector.innerHTML = `<div class="inspector-content memory-inspector">
    <p class="inspector-kicker">${snapshot ? escapeHtml(snapshot.label) : item.pinned ? 'Pinned on this device' : 'Shared memory'}</p>
    <h2 class="memory-inspector-name">${escapeHtml(item.name)}</h2>
    <p>${snapshot ? 'A read-only version linked from the selected recovery checkpoint.' : 'Durable project context available to connected coding agents.'}</p>
    ${itemHighlighted ? `<div class="memory-sync-context">
      <span class="fluent-icon" aria-hidden="true">&#xE895;</span>
      <div><strong>${highlightedChanges.entity ? 'Item added' : 'Context added'} in this sync</strong><span>From ${escapeHtml(highlightedPeer?.name || 'a paired device')} ${escapeHtml(relativeTime(highlightedSession.completedAt || highlightedSession.startedAt))}</span></div>
      <button class="button button-quiet" type="button" data-action="clear-memory-highlight">Clear</button>
    </div>` : ''}
    <div class="memory-inspector-mark fluent-icon" aria-hidden="true">${item.pinned ? '\uE718' : '\uE8F1'}</div>
    <dl class="details-list">
      <div class="detail-item"><dt>Type</dt><dd>${escapeHtml(item.entityType || 'entity')}</dd></div>
      <div class="detail-item"><dt>Observations</dt><dd>${observations.length}</dd></div>
      <div class="detail-item"><dt>Graph links</dt><dd>${relations.length}</dd></div>
      <div class="detail-item"><dt>Last context</dt><dd>${lastUpdated ? escapeHtml(formatDate(lastUpdated, true)) : 'Not recorded'}</dd></div>
      <div class="detail-item"><dt>Latest source</dt><dd>${escapeHtml(memorySourceLabel(latestObservation))}</dd></div>
    </dl>
    <div class="section-heading memory-section-heading"><h2>Observations</h2><p>What agents can reuse</p></div>
    <div class="memory-observation-list">${observationRows || '<p class="memory-snapshot-note">No observations are stored on this item.</p>'}</div>
    ${relationRows ? `<div class="section-heading memory-section-heading"><h2>Relations</h2><p>Connected context</p></div><div class="memory-relation-list">${relationRows}</div>` : ''}
    ${snapshotActions}
  </div>`;
}

function renderInspector() {
  if (!model || !model.project) return renderInspectorEmpty('Choose an item to inspect it.');
  if (activeView === 'memory') return renderMemoryInspector();
  if (activeView === 'checkpoints') {
    const checkpoint = (model.checkpoints || []).find((item) => item.checkpointId === selectedCheckpointId);
    if (!checkpoint) return renderInspectorEmpty('Select a checkpoint to inspect or restore it.');
    const busy = model.job && model.job.status === 'running';
    const checkpointPeer = checkpoint.sourcePeerId ? peerById(checkpoint.sourcePeerId) : null;
    inspector.innerHTML = `<div class="inspector-content">
      <p class="inspector-kicker">${escapeHtml(checkpointKind(checkpoint))}</p>
      <h2>${escapeHtml(checkpoint.name)}</h2>
      <p>A complete local restore point for the tracked project files.</p>
      <div class="checkpoint-inspector-icon fluent-icon" aria-hidden="true">&#xE823;</div>
      <dl class="details-list">
        <div class="detail-item"><dt>Created</dt><dd>${escapeHtml(formatDate(checkpoint.createdAt, true))}</dd></div>
        <div class="detail-item"><dt>Source</dt><dd>${checkpoint.sourcePeerId ? `Before changes from ${escapeHtml(checkpointPeer?.name || 'paired device')}` : 'Created on this device'}</dd></div>
        <div class="detail-item"><dt>Project files</dt><dd>${checkpoint.projectFileCount ?? checkpoint.fileCount}</dd></div>
        <div class="detail-item"><dt>Project size</dt><dd>${escapeHtml(formatBytes(checkpoint.projectBytes ?? checkpoint.totalBytes))}</dd></div>
        <div class="detail-item"><dt>Shared memory</dt><dd>${checkpoint.memoryIncluded
          ? checkpoint.memoryItemCount
            ? `${checkpoint.memoryItemCount} linked item${checkpoint.memoryItemCount === 1 ? '' : 's'}`
            : 'Included'
          : 'Not included'}</dd></div>
        <div class="detail-item"><dt>Storage</dt><dd>Deduplicated locally</dd></div>
      </dl>
      ${renderCheckpointImpact(checkpoint.checkpointId)}
      <button class="button button-primary inspector-sync" type="button" data-action="restore-checkpoint" data-checkpoint-id="${encoded(checkpoint.checkpointId)}" ${busy ? 'disabled' : ''}><span class="fluent-icon" aria-hidden="true">&#xE777;</span>Restore this checkpoint</button>
      <button class="button button-danger inspector-disconnect" type="button" data-action="delete-checkpoint" data-checkpoint-id="${encoded(checkpoint.checkpointId)}" ${busy ? 'disabled' : ''}>Delete checkpoint</button>
    </div>`;
    return;
  }
  const session = model.sessions.find((item) => item.sessionId === selectedSessionId);
  if (!session) {
    if (activeView === 'overview' && selectedPeer()) return renderPeerInspector(selectedPeer());
    return renderInspectorEmpty('Select an activity item to inspect it.');
  }
  const peer = peerById(session.peerId);
  const sessionActions = [...(session.actions || []), ...(session.directoryActions || [])];
  const actionRows = sessionActions.filter((item) => item.action !== 'same').slice(0, 30).map((item) => {
    const isConflict = item.action === 'conflict';
    const attrs = isConflict ? `data-conflict-session="${encoded(session.sessionId)}" data-conflict-path="${encoded(item.path)}" tabindex="0" role="button"` : '';
    return `<div class="action-row" ${attrs}><span class="file-action ${escapeHtml(item.action)}">${escapeHtml(actionLetter(item.action))}</span><span><span class="file-path">${escapeHtml(item.path)}</span><span class="row-meta">${escapeHtml(actionLabel(item.action))}</span></span></div>`;
  }).join('');
  inspector.innerHTML = `<div class="inspector-content">
    <p class="inspector-kicker">Sync session</p>
    <h2>${peer ? escapeHtml(peer.name) : 'Paired device'}</h2>
    <p>${escapeHtml(sessionSummary(session))}</p>
    <dl class="details-list">
      <div class="detail-item"><dt>Status</dt><dd><span class="badge ${session.status === 'completed' ? 'badge-success' : 'badge-warning'}">${escapeHtml(session.status)}</span></dd></div>
      <div class="detail-item"><dt>Completed</dt><dd>${escapeHtml(formatDate(session.completedAt || session.startedAt, true))}</dd></div>
      <div class="detail-item"><dt>Peer ID</dt><dd class="mono">${escapeHtml(session.peerId.slice(0, 12))}</dd></div>
      <div class="detail-item"><dt>Project changes</dt><dd>${sessionChangeCount(session)}</dd></div>
      <div class="detail-item"><dt>Backups</dt><dd>${(session.backups || []).length}</dd></div>
    </dl>
    <div class="section-heading"><h2>Project actions</h2></div>
    <div class="action-list">${actionRows || emptyPanel('\uE73E', 'No project changes', 'Both devices already matched.', '')}</div>
    ${renderSessionMemoryChanges(session, peer)}
  </div>`;
}

function renderJob() {
  const job = model && model.job;
  scheduleSuccessfulJobDismiss(job);
  if (!job) {
    minimizedJobId = null;
    jobTray.classList.remove('is-minimized');
    jobTray.hidden = true;
    jobTray.innerHTML = '';
    renderedJobId = null;
    renderedJobMarkup = '';
    return;
  }
  jobTray.hidden = false;
  const minimized = minimizedJobId === job.id;
  jobTray.classList.toggle('is-minimized', minimized);
  const running = job.status === 'running';
  const titleMap = {
    sync: 'Syncing folder',
    'pair-send': 'Waiting for the other device',
    'pair-receive': 'Finding the other device',
    'remote-pair-host': 'Waiting on your private invitation',
    'remote-pair-join': 'Joining the remote device',
    'remote-sync-host': 'Waiting for remote sync',
    'remote-sync-join': 'Syncing over the private connection',
  };
  let title = titleMap[job.type] || 'Carry operation';
  let operation = job.operation;
  if (!operation) {
    const operationLine = String((job.logs || [])[0]?.text || '');
    const directionalTitle = operationLine.match(/^Carry (push to|pull from|smart sync with|sync with) (.+?)(?: \(via relay\))?$/i);
    if (directionalTitle) {
      operation = {
        direction: directionalTitle[1].toLowerCase() === 'push to' ? 'push'
          : directionalTitle[1].toLowerCase() === 'pull from' ? 'pull' : 'smart',
        peerName: directionalTitle[2],
      };
    }
  }
  if (operation) {
    const present = operation.direction === 'push' ? 'Pushing to'
      : operation.direction === 'pull' ? 'Pulling from' : 'Syncing with';
    const complete = operation.direction === 'push' ? 'Push to'
      : operation.direction === 'pull' ? 'Pull from' : 'Sync with';
    title = running
      ? `${present} ${operation.peerName}`
      : job.status === 'success'
        ? `${complete} ${operation.peerName} complete`
        : `${complete} ${operation.peerName}`;
  }
  const progressValues = { sending: [], receiving: [] };
  for (const line of job.logs || []) {
    for (const match of String(line.text || '').matchAll(/\b(\d{1,3})%/g)) {
      const value = Number(match[1]);
      if (value < 1 || value > 99) continue;
      if (/Peer received encrypted update|Encrypted .*update sent:/i.test(line.text || '')) progressValues.sending.push(value);
      else if (/Encrypted update received:/i.test(line.text || '')) progressValues.receiving.push(value);
    }
  }
  const progressDirection = job.phase === 'receiving' ? 'receiving' : 'sending';
  const structuredProgress = Number(job.transferProgress && job.transferProgress[progressDirection]);
  const fallbackProgress = progressValues[progressDirection].length ? Math.max(...progressValues[progressDirection]) : 0;
  const transferProgress = structuredProgress || fallbackProgress;
  const runningCopy = job.type.startsWith('remote-sync-') ? 'Safe to close this window' : 'Keep Carry open';
  const transportCopy = job.transport === 'direct' ? 'Direct encrypted connection'
    : job.transport === 'relay' ? 'Secure relay connection' : null;
  const phaseCopy = {
    starting: `Preparing secure sync · ${runningCopy}`,
    connecting: `${transportCopy || 'Connecting securely'} · ${runningCopy}`,
    sending: transferProgress ? `${transportCopy ? `${transportCopy} · ` : ''}${transferProgress}% sent · ${runningCopy}` : `Sending encrypted files${transportCopy ? ` · ${transportCopy}` : ''} · ${runningCopy}`,
    receiving: transferProgress ? `${transportCopy ? `${transportCopy} · ` : ''}${transferProgress}% received · ${runningCopy}` : `Receiving encrypted files${transportCopy ? ` · ${transportCopy}` : ''} · ${runningCopy}`,
    applying: `Verifying, checkpointing, and applying files · ${runningCopy}`,
    confirming: `Files applied · confirming both devices · ${runningCopy}`,
    committing: 'Saving the shared sync baseline',
  };
  const statusCopy = running
    ? phaseCopy[job.phase] || (transferProgress ? `${transferProgress}% transferred · ${runningCopy}` : runningCopy)
    : job.status === 'success' ? 'Completed' : job.status === 'cancelled' ? 'Cancelled' : 'Needs attention';
  const iconClass = job.status === 'success' ? 'success' : job.status === 'error' ? 'error' : '';
  const icon = job.status === 'success' ? '\uE73E' : job.status === 'error' ? '\uE783' : '\uE895';
  const logs = (job.logs || []).map((line) => escapeHtml(line.text)).join('\n');
  const progressBar = running
    ? transferProgress && ['sending', 'receiving'].includes(job.phase)
      ? `<progress class="job-progress" max="100" value="${transferProgress}" aria-label="Encrypted transfer ${transferProgress}% complete"></progress>`
      : '<div class="job-progress job-progress-indeterminate"></div>'
    : '';
  const minimizeLabel = minimized ? 'Expand operation card' : 'Minimize operation card';
  const minimizeButton = `<button class="icon-button job-minimize" type="button" data-action="toggle-job" aria-expanded="${minimized ? 'false' : 'true'}" aria-label="${minimizeLabel}" title="${minimizeLabel}"><span class="fluent-icon" aria-hidden="true">${minimized ? '\uE70E' : '\uE70D'}</span></button>`;
  const markup = `${progressBar}<header class="job-header">
    <span class="job-status-icon fluent-icon ${iconClass}" aria-hidden="true">${icon}</span>
    <span class="job-title"><strong>${escapeHtml(title)}</strong><span>${escapeHtml(statusCopy)}</span></span>
    <span class="job-header-actions">
      ${running
        ? job.cancelSafe === false
          ? '<button class="button button-quiet" type="button" disabled title="Carry is safely committing the exchange">Finishing safely</button>'
          : '<button class="button button-quiet" type="button" data-action="cancel-job">Cancel</button>'
        : ''}
      ${minimizeButton}
      ${running ? '' : '<button class="icon-button" type="button" data-action="clear-job" aria-label="Dismiss"><span aria-hidden="true">×</span></button>'}
    </span>
  </header>
  ${minimized ? '' : `${job.pairingCode ? `<div class="job-code">${escapeHtml(job.pairingCode)}</div><p class="job-code-help">Enter this code on the other device.</p>` : ''}
  ${job.error ? `<div class="notice-inline error">${escapeHtml(job.error)}</div>` : ''}
  ${logs ? `<pre class="job-log">${logs}</pre>` : ''}`}`;

  // Progress polling used to replace this card every 750 ms. Replacing the
  // <pre> resets its scrollTop to zero, so each new log line jumped back to
  // the oldest visible line. Avoid unchanged redraws and preserve the user's
  // position. When they are already following the newest line, keep following
  // it automatically.
  if (renderedJobId === job.id && renderedJobMarkup === markup) return;
  const previousLog = jobTray.querySelector('.job-log');
  const previousLogScrollTop = previousLog ? previousLog.scrollTop : 0;
  const wasFollowingNewestLog = !previousLog ||
    previousLog.scrollHeight - previousLog.scrollTop - previousLog.clientHeight <= 8;
  const sameJob = renderedJobId === job.id;

  jobTray.innerHTML = markup;
  renderedJobId = job.id;
  renderedJobMarkup = markup;

  const nextLog = jobTray.querySelector('.job-log');
  if (nextLog) {
    if (!sameJob || wasFollowingNewestLog) nextLog.scrollTop = nextLog.scrollHeight;
    else nextLog.scrollTop = Math.min(previousLogScrollTop, nextLog.scrollHeight - nextLog.clientHeight);
  }
}

function renderView() {
  const focused = focusedElementDescriptor();
  renderTopChrome();
  renderHeader();
  renderJob();
  if (!model.folder) renderFolderOnboarding();
  else if (!model.project) renderUninitialized();
  else if (activeView === 'activity') renderActivity();
  else if (activeView === 'memory') renderMemory();
  else if (activeView === 'checkpoints') renderCheckpoints();
  else if (activeView === 'conflicts') renderConflicts();
  else if (activeView === 'devices') renderDevices();
  else renderOverview();
  renderedStateFingerprint = modelFingerprint(model);
  restoreFocusedElement(focused);
}

function setPairMode(mode) {
  for (const segment of document.querySelectorAll('[data-pair-mode]')) {
    const active = segment.dataset.pairMode === mode;
    segment.classList.toggle('is-active', active);
    segment.setAttribute('aria-selected', String(active));
  }
  document.getElementById('pair-send-panel').hidden = mode !== 'send';
  document.getElementById('pair-receive-panel').hidden = mode !== 'receive';
  document.getElementById('pair-remote-panel').hidden = mode !== 'remote';
}

function renderRemoteSession() {
  const remote = model && model.remote;
  const result = document.getElementById('remote-invite-result');
  const connectedResult = document.getElementById('remote-session-result');
  const choice = document.querySelector('.remote-choice');
  const divider = document.querySelector('.remote-divider');
  const joinForm = document.getElementById('remote-join-form');
  const errorBox = document.getElementById('remote-error');
  const active = remote && remote.status === 'ready';
  const ready = active && remote.invite;
  const connected = active && !remote.invite;
  const failed = remote && remote.status === 'error' && remote.error && remote.action === remoteAction;
  result.hidden = !ready;
  connectedResult.hidden = !connected;
  errorBox.hidden = !failed;
  choice.hidden = Boolean(active);
  divider.hidden = Boolean(active);
  joinForm.hidden = Boolean(active);
  if (ready) document.getElementById('remote-invite-value').textContent = remote.invite;
  if (ready) {
    const max = remote.maxDevices || 2;
    const count = remote.deviceCount || 1;
    const slots = remote.availableSlots || 0;
    document.getElementById('remote-ready-title').textContent = max > 2 ? 'Private team invitation ready' : 'Private invitation ready';
    document.getElementById('remote-capacity-copy').textContent = slots
      ? `${count} of ${max} devices connected. Share the same invitation privately with up to ${slots} more device${slots === 1 ? '' : 's'}.`
      : `${count} of ${max} devices connected. This team is full; forget a device to reopen a slot.`;
  }
  if (connected) {
    const peer = peerById(remote.peerId);
    document.getElementById('remote-session-copy').textContent = peer
      ? remote.peerOnline
        ? `${peer.name} is online. Press Sync now on either device; Carry starts the other side automatically.`
        : `${peer.name} is offline. Leave Carry running in the background there to enable one-click sync.`
      : 'The secure invitation is connected. Carry will keep it active in the background.';
  }
  if (failed) document.getElementById('remote-error-message').textContent = remote.error;
}

async function refresh(options) {
  if (refreshInFlight) return;
  refreshInFlight = true;
  try {
    const nextModel = await api('/api/state');
    const previousRoot = model?.folder?.root || null;
    const memoryRevisionChanged = memoryModel && nextModel.memory?.revision !== memoryModel.summary?.revision;
    const changed = !model || modelFingerprint(nextModel) !== renderedStateFingerprint;
    model = nextModel;
    if (previousRoot && previousRoot !== nextModel.folder?.root) {
      memoryModel = null;
      selectedMemoryName = null;
      selectedMemorySnapshot = null;
    }
    shell.setAttribute('aria-busy', 'false');
    if (changed) {
      renderView();
      renderRemoteSession();
    }
    if (activeView === 'memory' && (!memoryModel || memoryRevisionChanged)) {
      loadMemory({ silent: true });
    }
  } catch (err) {
    if (!options || !options.silent) showToast(err.message, 'error');
  } finally {
    refreshInFlight = false;
    schedulePoll();
  }
}

async function refreshJob() {
  if (refreshInFlight) return;
  refreshInFlight = true;
  let refreshWholeState = false;
  try {
    const job = await api('/api/job');
    if (!model) {
      refreshWholeState = true;
    } else {
      const wasRunning = Boolean(model.job && model.job.status === 'running');
      model.job = job;
      renderJob();
      refreshWholeState = wasRunning && (!job || job.status !== 'running');
    }
  } catch {
    // A transient background poll must not replace the last useful operation
    // state. The next focused/full refresh will retry it.
  } finally {
    refreshInFlight = false;
    if (refreshWholeState) {
      clearTimeout(pollTimer);
      pollTimer = setTimeout(() => refresh({ silent: true }), 0);
    } else {
      schedulePoll();
    }
  }
}

function schedulePoll() {
  clearTimeout(pollTimer);
  const running = model && model.job && model.job.status === 'running';
  pollTimer = setTimeout(() => running ? refreshJob() : refresh({ silent: true }), running ? 750 : 5000);
}

function folderSelectionAttributes() {
  return folderSelectionInFlight ? ' disabled aria-busy="true"' : '';
}

function setFolderSelectionInFlight(inFlight) {
  folderSelectionInFlight = inFlight;
  for (const button of document.querySelectorAll('#folder-switcher, [data-action="choose-folder"]')) {
    button.disabled = inFlight;
    if (inFlight) button.setAttribute('aria-busy', 'true');
    else button.removeAttribute('aria-busy');
  }
}

async function chooseFolder() {
  if (folderSelectionInFlight) return;
  setFolderSelectionInFlight(true);
  try {
    model = await api('/api/select-folder', { method: 'POST' });
    selectedSessionId = null;
    memoryModel = null;
    selectedMemoryName = null;
    selectedMemorySnapshot = null;
    currentDiff = null;
    activeView = 'overview';
    syncNav();
    renderView();
  } catch (err) { showToast(err.message, 'error'); }
  finally { setFolderSelectionInFlight(false); }
}

function showInit() {
  const dialog = document.getElementById('init-dialog');
  document.getElementById('project-name').value = model && model.folder ? model.folder.name : '';
  dialog.showModal();
  document.getElementById('project-name').select();
}

function showPair(action, useRemote) {
  remoteAction = action === 'sync' ? 'sync' : 'pair';
  const syncing = remoteAction === 'sync';
  document.getElementById('pair-title').textContent = syncing ? 'Sync across different networks' : 'Pair another device';
  document.getElementById('pair-description').textContent = syncing
    ? 'Create an invitation on one device, then paste it on the other.'
    : 'Use a secure local code nearby, or a private invitation across networks.';
  document.querySelector('#pair-dialog .segmented-control').hidden = syncing;
  document.getElementById('remote-create-title').textContent = syncing ? 'Create a private sync invitation' : 'Create a private invitation';
  document.getElementById('remote-create-copy').textContent = syncing
    ? 'Send this invitation once. Carry can keep the secure session active in the background.'
    : 'Choose the total team size, then privately share the same invitation with each device.';
  document.getElementById('remote-create-button').textContent = syncing ? 'Create sync invitation' : 'Create invitation';
  document.getElementById('remote-join-button').textContent = syncing ? 'Join and sync' : 'Join invitation';
  document.getElementById('team-size-field').hidden = syncing;
  const mode = useRemote || !model.firewallReady ? 'remote' : 'send';
  setPairMode(mode);
  renderRemoteSession();
  document.getElementById('pair-dialog').showModal();
}

function selectedSyncDirection() {
  return document.querySelector('input[name="sync-direction"]:checked')?.value || 'smart';
}

function selectedSyncDirect() {
  const choice = document.getElementById('sync-direct-choice');
  return !choice.hidden && document.getElementById('sync-direct').checked;
}

function updateSyncDialogCopy() {
  const peerId = document.getElementById('sync-device').value;
  const peer = peerById(peerId);
  const peerName = peer ? peer.name : 'selected device';
  document.getElementById('sync-pull-title').textContent = `Pull from ${peerName}`;
  document.getElementById('sync-pull-copy').textContent = `Replace this folder with ${peerName}'s version, including its deletions.`;
  document.getElementById('sync-push-title').textContent = `Push to ${peerName}`;
  document.getElementById('sync-push-copy').textContent = `Replace ${peerName}'s folder with this device's version, including deletions.`;
  const directChoice = document.getElementById('sync-direct-choice');
  directChoice.hidden = !peer || peer.transport !== 'relay';
  const direction = selectedSyncDirection();
  const note = document.getElementById('sync-direction-note');
  note.classList.toggle('is-destructive', direction !== 'smart');
  note.querySelector('span:last-child').textContent = direction === 'pull'
    ? `This folder will be changed to match ${peerName}. Carry creates a checkpoint here before replacing or deleting files.`
    : direction === 'push'
      ? `${peerName}'s folder will be changed to match this device. Carry creates a checkpoint there before replacing or deleting files.`
      : 'Smart sync exchanges one-sided changes and preserves different two-sided edits as conflicts.';
}

function showSync(peerId) {
  if (!model || !model.peers || !model.peers.length) return;
  const picker = document.getElementById('sync-device');
  picker.innerHTML = model.peers.map((peer) =>
    `<option value="${escapeHtml(peer.deviceId)}">${escapeHtml(peer.name)}</option>`).join('');
  const selectedId = peerId && peerById(peerId) ? peerId : model.selectedPeerId;
  picker.value = peerById(selectedId) ? selectedId : model.peers[0].deviceId;
  const smart = document.querySelector('input[name="sync-direction"][value="smart"]');
  if (smart) smart.checked = true;
  updateSyncDialogCopy();
  document.getElementById('sync-dialog').showModal();
  picker.focus();
}

async function startSync(peerId, direction, direct) {
  const peer = model.peers.find((item) => item.deviceId === peerId);
  if (!peer) throw new Error('Choose a paired device before syncing');
  pendingSyncPeerId = peer.deviceId;
  pendingSyncDirection = direction || 'smart';
  pendingSyncDirect = Boolean(direct && peer.transport === 'relay');
  if (model.selectedPeerId !== peer.deviceId) {
    model = await api('/api/select-peer', { method: 'POST', body: { peerId: peer.deviceId } });
  }
  const activeRemote = peer && model.remote && model.remote.status === 'ready' && model.remote.peerId === peer.deviceId;
  if (peer && peer.transport === 'relay' && !activeRemote) {
    showPair('sync', true);
    return;
  }
  try {
    await api('/api/sync', {
      method: 'POST',
      body: { peerId: peer.deviceId, direction: pendingSyncDirection, direct: pendingSyncDirect },
    });
    const label = pendingSyncDirection === 'push' ? `Push to ${peer.name}` : pendingSyncDirection === 'pull' ? `Pull from ${peer.name}` : `Smart sync with ${peer.name}`;
    showToast(`${label} started.`, 'success');
    await refresh({ silent: true });
  } catch (err) { showToast(err.message, 'error'); }
}

async function stopRemote() {
  try {
    model = await api('/api/remote/stop', { method: 'POST' });
    renderView();
    renderRemoteSession();
    showToast('Remote session stopped.', 'success');
  } catch (err) { showToast(err.message, 'error'); }
}

async function loadDiff(sessionId, pathValue) {
  try {
    const params = new URLSearchParams({ session: sessionId, path: pathValue });
    currentDiff = await api('/api/diff?' + params.toString());
    activeView = 'conflicts';
    syncNav();
    renderHeader();
    renderConflicts();
  } catch (err) { showToast(err.message, 'error'); }
}

function syncNav() {
  for (const item of document.querySelectorAll('.nav-item')) {
    const active = item.dataset.view === activeView;
    item.classList.toggle('is-active', active);
    if (active) item.setAttribute('aria-current', 'page');
    else item.removeAttribute('aria-current');
  }
}

function adoptMemory(nextMemory) {
  memoryModel = nextMemory;
  if (model) model.memory = nextMemory.summary;
  renderTopChrome();
}

function showMemoryEditor(item) {
  if (!item) return;
  document.getElementById('memory-original-name').value = item.name;
  document.getElementById('memory-item-name').value = item.name;
  document.getElementById('memory-item-type').value = item.entityType || 'entity';
  document.getElementById('memory-item-observations').value = item.observations
    .map((observation) => observation.text).join('\n');
  const dialog = document.getElementById('memory-edit-dialog');
  dialog.showModal();
  document.getElementById('memory-item-name').focus();
}

document.addEventListener('click', async (event) => {
  const nav = event.target.closest('[data-view]');
  if (nav) {
    activeView = nav.dataset.view;
    currentDiff = null;
    if (activeView === 'memory') {
      selectedMemorySnapshot = null;
      memoryHighlightSessionId = null;
    }
    syncNav();
    renderView();
    if (activeView === 'memory' && (!memoryModel || memoryModel.summary?.revision !== model.memory?.revision)) {
      await loadMemory({ silent: true });
    }
    return;
  }
  const jump = event.target.closest('[data-view-jump]');
  if (jump) {
    activeView = jump.dataset.viewJump;
    currentDiff = null;
    if (activeView === 'memory') memoryHighlightSessionId = null;
    syncNav();
    renderView();
    if (activeView === 'memory' && !memoryModel) await loadMemory({ silent: true });
    return;
  }
  const sessionButton = event.target.closest('[data-session]');
  if (sessionButton) {
    selectedSessionId = decodeURIComponent(sessionButton.dataset.session);
    renderInspector();
    return;
  }
  const checkpointButton = event.target.closest('[data-checkpoint]');
  if (checkpointButton) {
    selectedCheckpointId = decodeURIComponent(checkpointButton.dataset.checkpoint);
    checkpointPreview = null;
    await loadCheckpointPreview(selectedCheckpointId);
    return;
  }
  const memoryItemButton = event.target.closest('[data-memory-item]');
  if (memoryItemButton) {
    selectedMemoryName = decodeURIComponent(memoryItemButton.dataset.memoryItem);
    selectedMemorySnapshot = null;
    renderInspector();
    return;
  }
  const memoryLink = event.target.closest('[data-memory-link]');
  if (memoryLink) {
    const name = decodeURIComponent(memoryLink.dataset.memoryLink);
    const linkedSessionId = memoryLink.dataset.memorySession
      ? decodeURIComponent(memoryLink.dataset.memorySession)
      : (activeView === 'memory' ? memoryHighlightSessionId : null);
    let snapshot = null;
    if (memoryLink.dataset.memoryVersion && checkpointPreview?.memoryChanges) {
      const change = checkpointPreview.memoryChanges.find((item) => item.name === name);
      const item = memoryLink.dataset.memoryVersion === 'checkpoint' ? change?.checkpoint : change?.current;
      if (item) snapshot = { item, label: memoryLink.dataset.memoryVersion === 'checkpoint' ? 'Checkpoint version' : 'Current version before restore' };
    }
    await openMemoryItem(name, snapshot, { highlightSessionId: snapshot ? null : linkedSessionId });
    return;
  }
  const conflictButton = event.target.closest('[data-conflict-session]');
  if (conflictButton) {
    await loadDiff(decodeURIComponent(conflictButton.dataset.conflictSession), decodeURIComponent(conflictButton.dataset.conflictPath));
    return;
  }
  const peerButton = event.target.closest('[data-peer]');
  if (peerButton) {
    try {
      model = await api('/api/select-peer', { method: 'POST', body: { peerId: decodeURIComponent(peerButton.dataset.peer) } });
      showToast('Sync target updated.', 'success');
      renderView();
    } catch (err) { showToast(err.message, 'error'); }
    return;
  }
  const close = event.target.closest('[data-close-dialog]');
  if (close) { document.getElementById(close.dataset.closeDialog).close(); return; }
  const pairMode = event.target.closest('[data-pair-mode]');
  if (pairMode) {
    setPairMode(pairMode.dataset.pairMode);
    return;
  }

  const target = event.target.closest('[data-action]');
  if (!target) return;
  const action = target.dataset.action;
  if (action === 'choose-folder') await chooseFolder();
  else if (action === 'type-path') document.getElementById('path-dialog').showModal();
  else if (action === 'show-init') showInit();
  else if (action === 'show-pair') showPair('pair');
  else if (action === 'show-remote-pair') showPair('pair', true);
  else if (action === 'show-sync') showSync(decodeURIComponent(target.dataset.syncPeer || ''));
  else if (action === 'create-checkpoint') {
    const input = document.getElementById('checkpoint-name');
    input.value = '';
    document.getElementById('checkpoint-dialog').showModal();
    input.focus();
  }
  else if (action === 'reload-memory') {
    memoryModel = null;
    await loadMemory();
  }
  else if (action === 'review-latest-memory-sync') {
    const session = latestMemorySession();
    if (!session) return;
    memoryHighlightSessionId = session.sessionId;
    const firstChangedName = (session.memory.entityNames || []).find((name) => memoryItemByName(name));
    if (firstChangedName) selectedMemoryName = firstChangedName;
    selectedMemorySnapshot = null;
    renderMemory();
  }
  else if (action === 'clear-memory-highlight') {
    memoryHighlightSessionId = null;
    renderMemory();
  }
  else if (action === 'edit-memory') {
    showMemoryEditor(memoryItemByName(decodeURIComponent(target.dataset.memoryName || '')));
  }
  else if (action === 'pin-memory') {
    const name = decodeURIComponent(target.dataset.memoryName || '');
    const item = memoryItemByName(name);
    if (!item) return;
    target.disabled = true;
    try {
      const response = await api('/api/memory/pin', { method: 'POST', body: { name, pinned: !item.pinned } });
      adoptMemory(response.memory);
      renderMemory();
      showToast(item.pinned ? 'Memory item unpinned.' : 'Memory item pinned on this device.', 'success');
    } catch (error) {
      target.disabled = false;
      showToast(error.message, 'error');
    }
  }
  else if (action === 'delete-memory') {
    const name = decodeURIComponent(target.dataset.memoryName || '');
    const item = memoryItemByName(name);
    if (!item || !await askForConfirmation({
      title: `Delete “${item.name}”?`,
      message: `This removes the item and its ${item.relations.length} graph link${item.relations.length === 1 ? '' : 's'} from this device. If another device still has the item, union sync can add it back.`,
      confirmLabel: 'Delete memory item',
      tone: 'danger',
    })) return;
    target.disabled = true;
    try {
      const response = await api('/api/memory/delete', { method: 'POST', body: { name } });
      adoptMemory(response.memory);
      selectedMemoryName = response.memory.items[0]?.name || null;
      selectedMemorySnapshot = null;
      renderMemory();
      showToast('Memory item deleted from this device.', 'success');
    } catch (error) {
      target.disabled = false;
      showToast(error.message, 'error');
    }
  }
  else if (action === 'refresh-checkpoint-preview') {
    await loadCheckpointPreview(decodeURIComponent(target.dataset.checkpointId || ''));
  }
  else if (action === 'restore-checkpoint') {
    const checkpointId = decodeURIComponent(target.dataset.checkpointId || '');
    const checkpoint = (model.checkpoints || []).find((item) => item.checkpointId === checkpointId);
    if (!checkpoint || !await askForConfirmation({
      title: `Restore “${checkpoint.name}”?`,
      message: 'Carry will replace and delete working files to match this checkpoint. A new safety checkpoint will be created first.',
      confirmLabel: 'Restore checkpoint',
      tone: 'danger',
    })) return;
    target.disabled = true;
    try {
      const response = await api('/api/checkpoints/restore', { method: 'POST', body: { checkpointId } });
      model = response.state;
      checkpointPreview = null;
      checkpointPreviewRequestId++;
      renderView();
      showToast(`Restored ${checkpoint.name}. Sync when you want to send this version to the other device.`, 'success');
    } catch (err) { target.disabled = false; showToast(err.message, 'error'); }
  }
  else if (action === 'delete-checkpoint') {
    const checkpointId = decodeURIComponent(target.dataset.checkpointId || '');
    const checkpoint = (model.checkpoints || []).find((item) => item.checkpointId === checkpointId);
    if (!checkpoint || !await askForConfirmation({
      title: `Delete “${checkpoint.name}”?`,
      message: 'This removes this local restore point. It does not change project files.',
      confirmLabel: 'Delete checkpoint',
      tone: 'danger',
    })) return;
    target.disabled = true;
    try {
      model = await api('/api/checkpoints/delete', { method: 'POST', body: { checkpointId } });
      selectedCheckpointId = null;
      checkpointPreview = null;
      checkpointPreviewRequestId++;
      renderView();
      showToast('Checkpoint deleted.', 'success');
    } catch (err) { target.disabled = false; showToast(err.message, 'error'); }
  }
  else if (action === 'toggle-conflict') {
    const sessionId = decodeURIComponent(target.dataset.sessionId || '');
    const filePath = decodeURIComponent(target.dataset.filePath || '');
    const key = conflictKey(sessionId, filePath);
    if (target.checked) {
      // A team may have separate peer snapshots for the same working path.
      // Keep the bulk decision unambiguous by selecting only one of them.
      for (const item of conflictsFromSessions()) {
        if (item.path === filePath) selectedConflictKeys.delete(item.key);
      }
      selectedConflictKeys.add(key);
    } else {
      selectedConflictKeys.delete(key);
    }
    renderConflicts();
  }
  else if (action === 'select-all-conflicts') {
    selectedConflictKeys.clear();
    if (target.checked) {
      const selectedPaths = new Set();
      for (const item of conflictsFromSessions()) {
        if (selectedPaths.has(item.path)) continue;
        selectedPaths.add(item.path);
        selectedConflictKeys.add(item.key);
      }
    }
    renderConflicts();
  }
  else if (action === 'bulk-resolve-conflicts') {
    const selected = conflictsFromSessions().filter((item) => selectedConflictKeys.has(item.key));
    if (!selected.length) return;
    const choice = target.dataset.choice;
    const peerNames = [...new Set(selected.map((item) => peerById(item.session.peerId)?.name || 'the peer'))];
    const side = choice === 'local'
      ? "this device's saved versions"
      : peerNames.length === 1 ? `${peerNames[0]}'s saved versions` : 'the corresponding peer versions';
    if (!await askForConfirmation({
      title: `Keep ${side}?`,
      message: `Apply this decision to ${selected.length} selected file${selected.length === 1 ? '' : 's'}? Carry validates every conflict before changing files and creates one recovery checkpoint for the whole decision.`,
      confirmLabel: 'Keep selected versions',
    })) return;
    for (const button of document.querySelectorAll('[data-action="bulk-resolve-conflicts"]')) button.disabled = true;
    try {
      const response = await api('/api/conflicts/resolve', {
        method: 'POST',
        body: {
          choice,
          items: selected.map((item) => ({ sessionId: item.session.sessionId, path: item.path })),
        },
      });
      model = response.state;
      selectedConflictKeys.clear();
      currentDiff = null;
      renderView();
      showToast(`${response.result.count} conflicts resolved with one recovery checkpoint. Sync now to send the decision.`, 'success');
    } catch (err) {
      for (const button of document.querySelectorAll('[data-action="bulk-resolve-conflicts"]')) button.disabled = false;
      showToast(err.message, 'error');
    }
  }
  else if (action === 'resolve-conflict') {
    const sessionId = decodeURIComponent(target.dataset.sessionId || '');
    const filePath = decodeURIComponent(target.dataset.filePath || '');
    const choice = target.dataset.choice;
    const peer = peerById(currentDiff && currentDiff.peerId);
    const side = choice === 'local' ? "this device's version" : `${peer?.name || 'the peer'}'s version`;
    if (!await askForConfirmation({
      title: `Keep ${side}?`,
      message: `${filePath} will use the chosen version. If the working file is replaced or deleted, Carry creates a safety checkpoint first.`,
      confirmLabel: 'Keep this version',
    })) return;
    for (const button of document.querySelectorAll('[data-action="resolve-conflict"]')) button.disabled = true;
    try {
      const response = await api('/api/conflicts/resolve', {
        method: 'POST', body: { sessionId, path: filePath, choice },
      });
      model = response.state;
      currentDiff = null;
      renderView();
      showToast('Conflict resolved. Sync now to send this choice to the other device.', 'success');
    } catch (err) {
      for (const button of document.querySelectorAll('[data-action="resolve-conflict"]')) button.disabled = false;
      showToast(err.message, 'error');
    }
  }
  else if (action === 'stop-remote') await stopRemote();
  else if (action === 'disconnect-device') {
    const peerId = decodeURIComponent(target.dataset.peerId || '');
    const peer = peerById(peerId);
    if (!peer || !await askForConfirmation({
      title: `Disconnect ${peer.name}?`,
      message: 'Carry will pause the connection but keep this device paired. You can reconnect it later from this list.',
      confirmLabel: 'Disconnect',
    })) return;
    target.disabled = true;
    try {
      model = await api('/api/disconnect-device', { method: 'POST', body: { peerId } });
      renderView();
      showToast(`${peer.name} was disconnected. Its pairing is saved.`, 'success');
    } catch (err) {
      target.disabled = false;
      showToast(err.message, 'error');
    }
  }
  else if (action === 'connect-device') {
    const peerId = decodeURIComponent(target.dataset.peerId || '');
    const peer = peerById(peerId);
    if (!peer) return;
    target.disabled = true;
    try {
      model = await api('/api/connect-device', { method: 'POST', body: { peerId } });
      renderView();
      showToast(`${peer.name} is reconnecting.`, 'success');
    } catch (err) {
      target.disabled = false;
      showToast(err.message, 'error');
    }
  }
  else if (action === 'forget-device') {
    const peerId = decodeURIComponent(target.dataset.peerId || '');
    const peer = peerById(peerId);
    if (!peer || !await askForConfirmation({
      title: `Forget ${peer.name}?`,
      message: 'This permanently removes the saved pairing on this device. To revoke trust in both directions, forget the pairing on the other device too. You will need a new invitation to pair again.',
      confirmLabel: 'Forget device',
      tone: 'danger',
    })) return;
    target.disabled = true;
    try {
      model = await api('/api/forget-device', { method: 'POST', body: { peerId } });
      selectedSessionId = null;
      renderView();
      showToast(`${peer.name}'s local pairing was removed.`, 'success');
    } catch (err) {
      target.disabled = false;
      showToast(err.message, 'error');
    }
  }
  else if (action === 'open-folder') {
    try { await api('/api/open-folder', { method: 'POST' }); } catch (err) { showToast(err.message, 'error'); }
  } else if (action === 'firewall') {
    target.disabled = true;
    target.textContent = 'Waiting for Windows…';
    try { await api('/api/firewall', { method: 'POST' }); showToast('Local network access is ready.', 'success'); await refresh(); }
    catch (err) { showToast(err.message, 'error'); target.disabled = false; target.textContent = 'Install rules'; }
  } else if (action === 'toggle-job') {
    if (!model || !model.job) return;
    minimizedJobId = minimizedJobId === model.job.id ? null : model.job.id;
    renderJob();
  } else if (action === 'cancel-job') {
    try { await api('/api/cancel', { method: 'POST' }); await refresh(); } catch (err) { showToast(err.message, 'error'); }
  } else if (action === 'clear-job') {
    try { await api('/api/clear-job', { method: 'POST' }); await refresh({ silent: true }); } catch (err) { showToast(err.message, 'error'); }
  } else if (action === 'back-conflicts') {
    currentDiff = null;
    renderConflicts();
  }
});

document.addEventListener('change', async (event) => {
  if (event.target.id !== 'active-device-select') return;
  const select = event.target;
  const deviceId = decodeURIComponent(select.value || '');
  const name = activeDeviceName(deviceId);
  if (!deviceId || !await askForConfirmation({
    title: `Make ${name} the Active Device?`,
    message: 'When this device participates in a sync, Carry will treat its files as the source of truth for otherwise-ambiguous conflicts. A recovery checkpoint is still created before incoming files are replaced.',
    confirmLabel: 'Make Active Device',
  })) {
    renderDevices();
    return;
  }
  select.disabled = true;
  try {
    model = await api('/api/active-device', { method: 'POST', body: { deviceId } });
    renderView();
    showToast(`${name} is now the Active Device. Sync once to share this choice.`, 'success');
  } catch (err) {
    renderDevices();
    showToast(err.message, 'error');
  }
});

document.addEventListener('input', (event) => {
  if (event.target.id !== 'memory-search') return;
  memoryQuery = event.target.value;
  const list = document.querySelector('.memory-list');
  if (list) list.innerHTML = memoryRows(filteredMemoryItems());
});

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' && event.key !== ' ') return;
  const conflict = event.target.closest('[role="button"][data-conflict-session]');
  if (!conflict) return;
  event.preventDefault();
  loadDiff(decodeURIComponent(conflict.dataset.conflictSession), decodeURIComponent(conflict.dataset.conflictPath));
});

document.getElementById('folder-switcher').addEventListener('click', chooseFolder);
document.getElementById('refresh-button').addEventListener('click', () => refresh());

function configureNativeWindow() {
  const tauriWindow = globalThis.__TAURI__?.window;
  if (!nativeConfig?.nativeWindow || !tauriWindow?.getCurrentWindow) return;
  const appWindow = tauriWindow.getCurrentWindow();
  const maximizeButton = document.querySelector('[data-window-action="maximize"]');
  const maximizeIcon = document.getElementById('maximize-icon');
  let resizeTimer = null;

  async function updateMaximizeState() {
    try {
      const maximized = await appWindow.isMaximized();
      maximizeIcon.textContent = maximized ? '\uE923' : '\uE922';
      maximizeButton.setAttribute('aria-label', maximized ? 'Restore' : 'Maximize');
      maximizeButton.title = maximized ? 'Restore' : 'Maximize';
    } catch {
      // The controls remain usable if a platform cannot report this state.
    }
  }

  document.getElementById('window-controls').addEventListener('click', async (event) => {
    const button = event.target.closest('[data-window-action]');
    if (!button) return;
    try {
      if (button.dataset.windowAction === 'minimize') await appWindow.minimize();
      else if (button.dataset.windowAction === 'maximize') {
        await appWindow.toggleMaximize();
        await updateMaximizeState();
      } else if (button.dataset.windowAction === 'close') await appWindow.close();
    } catch (error) {
      showToast(`Window action failed: ${error}`, 'error');
    }
  });

  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(updateMaximizeState, 80);
  });
  updateMaximizeState();
}

configureNativeWindow();

document.getElementById('theme-button').addEventListener('click', () => {
  const current = document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
  const next = current === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  document.getElementById('theme-icon').textContent = next === 'dark' ? '\uE708' : '\uE706';
  document.cookie = `carryTheme=${next}; Max-Age=31536000; SameSite=Strict`;
});

document.getElementById('init-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (event.submitter && event.submitter.value === 'cancel') { document.getElementById('init-dialog').close(); return; }
  const name = document.getElementById('project-name').value.trim();
  try {
    model = await api('/api/init', { method: 'POST', body: { name } });
    document.getElementById('init-dialog').close();
    showToast('Folder initialized.', 'success');
    renderView();
  } catch (err) { showToast(err.message, 'error'); }
});

document.getElementById('sync-device').addEventListener('change', updateSyncDialogCopy);
for (const input of document.querySelectorAll('input[name="sync-direction"]')) {
  input.addEventListener('change', updateSyncDialogCopy);
}

document.getElementById('sync-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const peerId = document.getElementById('sync-device').value;
  const direction = selectedSyncDirection();
  const direct = selectedSyncDirect();
  const button = document.getElementById('sync-start-button');
  button.disabled = true;
  try {
    document.getElementById('sync-dialog').close();
    await startSync(peerId, direction, direct);
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    button.disabled = false;
  }
});

document.getElementById('memory-edit-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const originalName = document.getElementById('memory-original-name').value;
  const name = document.getElementById('memory-item-name').value.trim();
  const entityType = document.getElementById('memory-item-type').value.trim();
  const observations = document.getElementById('memory-item-observations').value
    .split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
  const button = document.getElementById('memory-save-button');
  button.disabled = true;
  try {
    const nextMemory = await api('/api/memory/update', {
      method: 'POST',
      body: { originalName, name, entityType, observations },
    });
    adoptMemory(nextMemory);
    selectedMemoryName = name;
    selectedMemorySnapshot = null;
    document.getElementById('memory-edit-dialog').close();
    renderMemory();
    showToast('Memory item updated.', 'success');
  } catch (error) {
    showToast(error.message, 'error');
  } finally {
    button.disabled = false;
  }
});

document.getElementById('checkpoint-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const name = document.getElementById('checkpoint-name').value.trim();
  const button = document.getElementById('checkpoint-create-button');
  button.disabled = true;
  try {
    model = await api('/api/checkpoints/create', { method: 'POST', body: { name } });
    document.getElementById('checkpoint-dialog').close();
    selectedCheckpointId = model.checkpoints[0]?.checkpointId || null;
    checkpointPreview = null;
    checkpointPreviewRequestId++;
    activeView = 'checkpoints';
    syncNav();
    renderView();
    showToast('Checkpoint created.', 'success');
  } catch (err) { showToast(err.message, 'error'); }
  finally { button.disabled = false; }
});

document.getElementById('pair-send-button').addEventListener('click', async () => {
  try {
    await api('/api/pair', { method: 'POST', body: {} });
    document.getElementById('pair-dialog').close();
    await refresh({ silent: true });
  } catch (err) { showToast(err.message, 'error'); }
});

document.getElementById('pair-receive-panel').addEventListener('submit', async (event) => {
  event.preventDefault();
  const code = document.getElementById('pair-code').value.trim().toUpperCase();
  try {
    await api('/api/pair', { method: 'POST', body: { code } });
    document.getElementById('pair-dialog').close();
    await refresh({ silent: true });
  } catch (err) { showToast(err.message, 'error'); }
});

document.getElementById('pair-code').addEventListener('input', (event) => {
  event.target.value = event.target.value.replace(/[^a-f0-9]/gi, '').toUpperCase();
});

document.getElementById('remote-create-button').addEventListener('click', async (event) => {
  const button = event.currentTarget;
  const original = button.textContent;
  button.disabled = true;
  button.textContent = 'Opening secure connection…';
  document.getElementById('remote-error').hidden = true;
  try {
    model = await api('/api/remote/start', {
      method: 'POST',
      body: {
        action: remoteAction,
        peerId: remoteAction === 'sync' ? pendingSyncPeerId || model.selectedPeerId : model.selectedPeerId,
        direction: remoteAction === 'sync' ? pendingSyncDirection : undefined,
        direct: remoteAction === 'sync' ? pendingSyncDirect : undefined,
        maxDevices: Number.parseInt(document.getElementById('team-size').value, 10),
      },
    });
    renderView();
    renderRemoteSession();
    showToast('Private invitation is ready.', 'success');
  } catch (err) {
    showToast(err.message, 'error');
    await refresh({ silent: true });
    renderRemoteSession();
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
});

document.getElementById('remote-join-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const invite = document.getElementById('remote-invite').value.trim();
  const button = document.getElementById('remote-join-button');
  button.disabled = true;
  try {
    await api('/api/remote/join', {
      method: 'POST',
      body: {
        action: remoteAction,
        invite,
        peerId: remoteAction === 'sync' ? pendingSyncPeerId || model.selectedPeerId : model.selectedPeerId,
        direction: remoteAction === 'sync' ? pendingSyncDirection : undefined,
        direct: remoteAction === 'sync' ? pendingSyncDirect : undefined,
      },
    });
    document.getElementById('pair-dialog').close();
    showToast(remoteAction === 'sync' ? 'Remote sync started.' : 'Joining private invitation.', 'success');
    await refresh({ silent: true });
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    button.disabled = false;
  }
});

document.getElementById('remote-copy-button').addEventListener('click', async () => {
  const invite = model && model.remote && model.remote.invite;
  if (!invite) return;
  try {
    await navigator.clipboard.writeText(invite);
    showToast('Invitation copied.', 'success');
  } catch {
    showToast('Could not access the clipboard. Select and copy the invitation manually.', 'error');
  }
});

document.getElementById('remote-stop-button').addEventListener('click', async () => {
  await stopRemote();
});

document.getElementById('path-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const folderPath = document.getElementById('folder-path-input').value.trim();
  try {
    model = await api('/api/use-folder', { method: 'POST', body: { path: folderPath } });
    document.getElementById('path-dialog').close();
    activeView = 'overview';
    selectedSessionId = null;
    memoryModel = null;
    selectedMemoryName = null;
    selectedMemorySnapshot = null;
    currentDiff = null;
    syncNav();
    renderView();
  } catch (err) { showToast(err.message, 'error'); }
});

for (const dialog of document.querySelectorAll('dialog')) {
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) dialog.close();
  });
}

const savedTheme = document.cookie.match(/(?:^|; )carryTheme=(dark|light)/)?.[1];
const initialTheme = savedTheme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
document.documentElement.dataset.theme = initialTheme;
document.getElementById('theme-icon').textContent = initialTheme === 'dark' ? '\uE708' : '\uE706';

window.addEventListener('focus', () => {
  if (!token) return;
  if (model && model.job && model.job.status === 'running') refreshJob();
  else refresh({ silent: true });
});
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && token) {
    if (model && model.job && model.job.status === 'running') refreshJob();
    else refresh({ silent: true });
  }
});

if (!token) {
  shell.setAttribute('aria-busy', 'false');
  main.innerHTML = emptyPanel('\uE783', 'Carry could not authorize this window', 'Close it and run carry app again.', '');
} else {
  refresh();
}
