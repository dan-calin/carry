'use strict';

// Regression for the packaged launcher lifecycle: closing the parent's
// redirected output pipes must not let remote-invite startup kill the local
// backend and strand a stale UI window.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const manifest = require('../lib/manifest');

const root = path.join(__dirname, '..', '.build', `launcher-itest-${process.pid}`);
fs.mkdirSync(root, { recursive: true });
manifest.init(root, 'Launcher lifecycle');

let child;

function waitForUrl() {
  return new Promise((resolve, reject) => {
    let output = '';
    const timeout = setTimeout(() => reject(new Error('Carry did not print its loopback URL')), 10000);
    child.stdout.on('data', (chunk) => {
      output += String(chunk);
      const match = output.match(/http:\/\/127\.0\.0\.1:\d+\/#([a-f0-9]{48})/i);
      if (!match) return;
      clearTimeout(timeout);
      resolve({ url: match[0], token: match[1] });
    });
    child.once('exit', (code) => {
      clearTimeout(timeout);
      reject(new Error(`Carry exited before startup (code ${code})`));
    });
  });
}

(async () => {
  child = spawn(process.execPath, [path.join(__dirname, '..', 'bin', 'carry.js'), 'app', '--no-open', '--folder', root], {
    cwd: root,
    env: {
      ...process.env,
      // Force the production hosted-provider path to fail without depending on
      // external network state. Closing the launcher's pipes must still leave
      // the backend able to return that diagnosis cleanly.
      CARRY_REMOTE_RELAY_URL: 'http://127.0.0.1:9',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const app = await waitForUrl();
  const parsed = new URL(app.url);
  const origin = parsed.origin;
  const headers = { 'X-Carry-Token': app.token };

  let response = await fetch(origin + '/api/state', { headers });
  assert.strictEqual(response.status, 200, 'backend is initially reachable');

  // Model Carry.exe exiting or losing its redirected pipe. The app-hosted
  // relay is intentionally quiet, so this cannot create an EPIPE crash.
  await new Promise((resolve) => setTimeout(resolve, 150));
  child.stdout.destroy();
  child.stderr.destroy();

  response = await fetch(origin + '/api/remote/start', {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'pair' }),
  });
  assert.strictEqual(response.status, 500, 'simulated hosted-relay outage is reported through the API');
  const error = await response.json();
  assert.match(error.error, /hosted relay|internet connection/i);

  response = await fetch(origin + '/api/state', { headers });
  assert.strictEqual(response.status, 200, 'backend remains alive after invite startup with closed launcher pipes');

  console.log('LAUNCHER LIFECYCLE PASS: remote invite cannot strand a connection-refused UI after output pipes close.');
})().catch((error) => {
  console.error('LAUNCHER LIFECYCLE FAIL:', error);
  process.exitCode = 1;
}).finally(async () => {
  if (child && child.exitCode === null) {
    try { child.kill(); } catch { /* already exited */ }
    await new Promise((resolve) => child.once('exit', resolve));
  }
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});
