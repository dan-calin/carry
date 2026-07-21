'use strict';

// Remote relay providers. Production Carry uses a stable Cloudflare Worker;
// localhost.run remains an explicit development/self-hosting fallback.

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const DEFAULT_RELAY_PORT = 48125;
const LOCALHOST_RUN_HOST = 'nokey@localhost.run';
const TUNNEL_HEALTH_INTERVAL_MS = 15 * 1000;
const TUNNEL_HEALTH_FAILURE_LIMIT = 3;
const TUNNEL_HEALTH_TIMEOUT_MS = 8 * 1000;
const TUNNEL_EXPIRED_MESSAGE = 'The free localhost.run address expired or stopped routing. Create a new Different network invitation and paste it on the other device; your saved pairing does not need to be removed.';
const DEFAULT_HOSTED_RELAY_URL = 'https://carry-relay.dancalin09.workers.dev';
const HOSTED_RELAY_UNAVAILABLE_MESSAGE = 'Carry could not reach its hosted relay. Check this PC\'s internet connection and try again; your saved pairing is safe.';

function findSsh(explicitPath) {
  if (explicitPath) return explicitPath;
  if (process.platform === 'win32') {
    const windowsRoot = process.env.WINDIR || process.env.SystemRoot || 'C:\\Windows';
    const candidates = [
      path.join(windowsRoot, 'System32', 'OpenSSH', 'ssh.exe'),
      path.join(windowsRoot, 'Sysnative', 'OpenSSH', 'ssh.exe'),
    ];
    const installed = candidates.find((candidate) => fs.existsSync(candidate));
    if (installed) return installed;
  }
  return 'ssh';
}

function explainTunnelFailure(lines, exitCode) {
  const detail = lines.join(' ').replace(/\s+/g, ' ').trim();
  if (/ENOENT|not recognized|not found/i.test(detail)) {
    return 'Windows OpenSSH Client is not installed. Open Settings → System → Optional features, install OpenSSH Client, then restart Carry.';
  }
  if (/could not resolve hostname|name or service not known|temporary failure in name resolution|no such host/i.test(detail)) {
    return 'Carry could not resolve localhost.run. Check this PC’s internet or DNS connection, then try again.';
  }
  if (/connection timed out|connection refused|network is unreachable|no route to host|connection reset/i.test(detail)) {
    return 'Carry could not reach localhost.run over SSH (port 22). This network may block outbound SSH; try another network or a phone hotspot.';
  }
  if (/permission denied|authentication failed/i.test(detail)) {
    return 'localhost.run rejected the free tunnel connection. Wait a moment and try again; no Carry account or SSH key should be required.';
  }
  if (detail) return 'The remote tunnel could not start: ' + detail.slice(0, 280);
  return `The remote tunnel closed before creating an invitation${Number.isInteger(exitCode) ? ` (SSH exit ${exitCode})` : ''}. Check the internet connection and try again.`;
}

async function probeTunnelHealth(publicUrl, opts) {
  opts = opts || {};
  const fetchImpl = opts.fetch || globalThis.fetch;
  if (typeof fetchImpl !== 'function') return { healthy: false, status: null };
  let url;
  try {
    url = new URL('/carry', String(publicUrl || '')).href;
  } catch {
    return { healthy: false, status: null };
  }
  const timeoutMs = opts.timeoutMs || TUNNEL_HEALTH_TIMEOUT_MS;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  timeout.unref?.();
  try {
    // A healthy Carry relay deliberately returns 404 to a plain HTTP request;
    // the WebSocket upgrade is the only accepted /carry operation. A 5xx from
    // localhost.run means its public route no longer reaches the local relay.
    const response = await fetchImpl(url, {
      method: 'GET', redirect: 'manual', cache: 'no-store', signal: controller.signal,
    });
    const status = response.status;
    if (response.body && typeof response.body.cancel === 'function') {
      try { await response.body.cancel(); } catch { /* status is still authoritative */ }
    }
    return { healthy: status < 500, status };
  } catch (error) {
    return { healthy: false, status: null, error: error && error.message || String(error) };
  } finally {
    clearTimeout(timeout);
  }
}

function isTemporaryTunnelAddress(value) {
  try {
    const hostname = new URL(String(value || '')).hostname.toLowerCase();
    return hostname === 'localhost.run' || hostname.endsWith('.localhost.run') || hostname.endsWith('.lhr.life');
  } catch {
    return false;
  }
}

async function probeHostedRelay(publicUrl, opts) {
  opts = opts || {};
  const fetchImpl = opts.fetch || globalThis.fetch;
  if (typeof fetchImpl !== 'function') return { healthy: false, status: null };
  let url;
  try { url = new URL('/', String(publicUrl || '')).href; }
  catch { return { healthy: false, status: null }; }
  const timeoutMs = opts.timeoutMs || TUNNEL_HEALTH_TIMEOUT_MS;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  timeout.unref?.();
  try {
    const response = await fetchImpl(url, {
      method: 'GET', redirect: 'manual', cache: 'no-store', signal: controller.signal,
    });
    let payload = null;
    try { payload = await response.json(); } catch { /* a provider error page is not a Carry relay */ }
    const healthy = response.ok && payload && payload.service === 'carry-relay' &&
      payload.transport === 'websocket';
    return { healthy: Boolean(healthy), status: response.status, provider: payload && payload.provider || null };
  } catch (error) {
    return { healthy: false, status: null, error: error && error.message || String(error) };
  } finally {
    clearTimeout(timeout);
  }
}

async function startHostedRelay(opts) {
  opts = opts || {};
  const url = String(opts.url || process.env.CARRY_REMOTE_RELAY_URL || DEFAULT_HOSTED_RELAY_URL).trim();
  let parsed;
  try { parsed = new URL(url); }
  catch { throw new Error('Carry hosted relay URL is invalid'); }
  if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.hash) {
    throw new Error('Carry hosted relay must use a plain HTTPS URL');
  }
  parsed.pathname = '/';
  parsed.search = '';
  const healthProbe = opts.healthProbe || probeHostedRelay;
  const health = await healthProbe(parsed.href, opts);
  if (!health || health.healthy !== true) {
    throw new Error(HOSTED_RELAY_UNAVAILABLE_MESSAGE);
  }
  return {
    url: parsed.href,
    provider: health.provider || 'hosted',
    sharedRelay: true,
    stableAddress: true,
    stop() {},
  };
}

function startRemoteRelay(opts) {
  opts = opts || {};
  const provider = String(opts.provider || process.env.CARRY_REMOTE_PROVIDER || 'cloudflare').toLowerCase();
  return provider === 'localhost-run' ? startTunnel(opts) : startHostedRelay(opts);
}

// Start a reverse tunnel. Resolves with a handle exposing the discovered public
// URL and a .stop() method. `onUrl(callback)` fires once the URL is parsed from
// ssh output. Rejects if ssh is unavailable or the tunnel fails to establish.
function startTunnel(opts) {
  opts = opts || {};
  const relayPort = opts.relayPort || DEFAULT_RELAY_PORT;
  const onUrl = opts.onUrl || (() => {});
  const service = opts.service || LOCALHOST_RUN_HOST;
  const sshPath = findSsh(opts.sshPath);
  const spawnProcess = opts.spawn || spawn;
  const healthProbe = opts.healthProbe || probeTunnelHealth;
  const healthIntervalMs = opts.healthIntervalMs || TUNNEL_HEALTH_INTERVAL_MS;
  const healthFailureLimit = opts.healthFailureLimit || TUNNEL_HEALTH_FAILURE_LIMIT;

  return new Promise((resolve, reject) => {
    let ssh;
    try {
      // -o StrictHostKeyChecking=no : first-time connect without prompts
      // -o UserKnownHostsFile=/dev/null : don't litter known_hosts
      // Use 127.0.0.1 explicitly. On Windows, OpenSSH may resolve `localhost`
      // to ::1 while Carry's HTTP relay is intentionally bound only to IPv4
      // loopback, which makes the public endpoint reset every request.
      // -R 80:127.0.0.1:RELAY_PORT : expose the local HTTP relay publicly
      ssh = spawnProcess(sshPath, [
        '-o', 'StrictHostKeyChecking=no',
        '-o', 'UserKnownHostsFile=/dev/null',
        '-o', 'ConnectTimeout=12',
        '-o', 'ConnectionAttempts=1',
        '-o', 'ExitOnForwardFailure=yes',
        '-o', 'ServerAliveInterval=30',
        '-o', 'ServerAliveCountMax=2',
        '-R', `80:127.0.0.1:${relayPort}`,
        service,
      ], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch (e) {
      return reject(new Error(explainTunnelFailure([e.message])));
    }

    const rl = readline.createInterface({ input: ssh.stdout });
    const rlErr = readline.createInterface({ input: ssh.stderr });
    let settled = false;
    let url = null;
    let deadline = null;
    const errors = [];
    let handle = null;
    let resolveClosed;
    const closed = new Promise((resolveClose) => { resolveClosed = resolveClose; });

    const stopHealthMonitor = () => {
      if (handle && handle._healthTimer) clearInterval(handle._healthTimer);
      if (handle) handle._healthTimer = null;
    };

    const startHealthMonitor = () => {
      if (!handle || !(healthIntervalMs > 0) || !(healthFailureLimit > 0)) return;
      handle._healthFailures = 0;
      handle._healthCheckRunning = false;
      const check = async () => {
        if (!handle || handle._stopping || handle._healthCheckRunning) return;
        handle._healthCheckRunning = true;
        let result;
        try { result = await healthProbe(handle.url); }
        catch (error) { result = { healthy: false, status: null, error: error.message }; }
        finally { if (handle) handle._healthCheckRunning = false; }
        if (!handle || handle._stopping) return;
        if (result === true || result && result.healthy === true) {
          handle._healthFailures = 0;
          return;
        }
        handle._healthFailures += 1;
        if (handle._healthFailures < healthFailureLimit) return;
        handle._terminalError = TUNNEL_EXPIRED_MESSAGE;
        stopHealthMonitor();
        try { ssh.kill(); } catch { /* the close listener reports the failure */ }
      };
      handle._healthTimer = setInterval(check, healthIntervalMs);
      handle._healthTimer.unref?.();
    };

    const fail = (msg) => {
      if (settled) return;
      settled = true;
      if (deadline) clearTimeout(deadline);
      try { ssh.kill(); } catch { /* ignore */ }
      reject(new Error(msg));
    };

    const extractUrl = (line) => {
      // localhost.run prints something like:
      //   "Forwarding HTTP traffic from https://abc123.localhost.run"
      const m = line.match(/https?:\/\/[a-z0-9-]+\.(?:localhost\.run|lhr\.life)/i);
      if (m) {
        url = m[0];
        if (/^https?:\/\/admin\.localhost\.run$/i.test(url)) return;
        if (!settled) {
          settled = true;
          if (deadline) clearTimeout(deadline);
          onUrl(url);
          handle = { url, _proc: ssh, closed, _stopping: false };
          handle.stop = () => stop(handle);
          startHealthMonitor();
          resolve(handle);
        }
      }
    };

    rl.on('line', extractUrl);
    rlErr.on('line', (line) => {
      // localhost.run may announce on stderr too; also catch auth/conn errors.
      extractUrl(line);
      if (line.trim()) {
        errors.push(line.trim());
        if (errors.length > 6) errors.shift();
      }
      // localhost.run can print an informational public-key denial before it
      // accepts the free `nokey` session, so only treat it as fatal if ssh
      // subsequently exits without giving us a URL.
      if (/connection (?:refused|timed out|reset)|could not resolve hostname|name or service not known|network is unreachable|no route to host/i.test(line)) {
        fail(explainTunnelFailure(errors));
      }
    });

    ssh.on('error', (e) => {
      if (settled && handle) handle._terminalError = explainTunnelFailure([...errors, e.message]);
      fail(explainTunnelFailure([...errors, e.message]));
    });
    ssh.on('close', (code) => {
      stopHealthMonitor();
      if (!settled) fail(explainTunnelFailure(errors, code));
      else if (handle) {
        resolveClosed({
          expected: Boolean(handle._stopping),
          code,
          error: handle._terminalError || (handle._stopping ? null : explainTunnelFailure(errors, code)),
        });
      }
    });
    // Give ssh a few seconds to establish; if no URL by then, report. (The ssh
    // process stays alive; we only reject on a hard error, not on slow output.)
    deadline = setTimeout(() => {
      if (!settled) fail(errors.length
        ? explainTunnelFailure(errors)
        : 'The remote tunnel did not answer within 25 seconds. Check the internet connection, or try another network or a phone hotspot.');
    }, 25000);
  });
}

function stop(handle) {
  if (handle && handle._proc) {
    handle._stopping = true;
    if (handle._healthTimer) clearInterval(handle._healthTimer);
    handle._healthTimer = null;
    try { handle._proc.kill(); } catch { /* ignore */ }
  }
}

module.exports = {
  startRemoteRelay,
  startHostedRelay,
  startTunnel,
  findSsh,
  explainTunnelFailure,
  probeTunnelHealth,
  probeHostedRelay,
  isTemporaryTunnelAddress,
  LOCALHOST_RUN_HOST,
  DEFAULT_HOSTED_RELAY_URL,
  HOSTED_RELAY_UNAVAILABLE_MESSAGE,
  DEFAULT_RELAY_PORT,
  TUNNEL_HEALTH_INTERVAL_MS,
  TUNNEL_HEALTH_FAILURE_LIMIT,
  TUNNEL_EXPIRED_MESSAGE,
};
