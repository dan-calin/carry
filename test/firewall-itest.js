'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const appServer = require('../lib/app-server');
const firewall = require('../lib/firewall');

(async () => {
  const originalSkip = process.env.CARRY_SKIP_FIREWALL;
  delete process.env.CARRY_SKIP_FIREWALL;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'carry-firewall-api-'));
  let app;
  try {
    let checks = 0;
    let pauses = 0;
    let launcherScript = '';
    const delayed = firewall.installLanRules({
      platform: 'win32',
      runner: (script) => {
        launcherScript = script;
        return { status: 0, error: null, stderr: '' };
      },
      ruleCheck: () => ++checks >= 3,
      sleep: () => { pauses += 1; },
    });
    assert.strictEqual(delayed.ok, true, 'successful elevated helper is accepted');
    assert.strictEqual(delayed.verified, true, 'non-elevated verification catches up');
    assert.strictEqual(checks, 3, 'verification retries while Windows publishes the rules');
    assert.strictEqual(pauses, 2, 'verification waits only between failed checks');
    const encodedMatch = launcherScript.match(/'-EncodedCommand','([^']+)'/);
    assert.ok(encodedMatch, 'UAC launcher contains the encoded elevated helper');
    const elevatedScript = Buffer.from(encodedMatch[1], 'base64').toString('utf16le');
    assert.ok(elevatedScript.includes('-PolicyStore PersistentStore'));
    assert.ok(elevatedScript.includes('-PolicyStore ActiveStore'));
    const parserScript = [
      `$source = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${encodedMatch[1]}'))`,
      '$tokens = $null',
      '$errors = $null',
      '[Management.Automation.Language.Parser]::ParseInput($source, [ref]$tokens, [ref]$errors) | Out-Null',
      'if ($errors.Count) { $errors | ForEach-Object { Write-Error $_.Message }; exit 1 }',
    ].join('; ');
    const parsed = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', parserScript], {
      encoding: 'utf8', windowsHide: true,
    });
    assert.strictEqual(parsed.status, 0, `elevated firewall helper parses: ${parsed.stderr}`);

    checks = 0;
    pauses = 0;
    const lagging = firewall.installLanRules({
      platform: 'win32',
      runner: () => ({ status: 0, error: null, stderr: '' }),
      ruleCheck: () => { checks += 1; return false; },
      sleep: () => { pauses += 1; },
    });
    assert.strictEqual(lagging.ok, true,
      'a successful elevated ActiveStore verification is not reversed by a lagging caller view');
    assert.strictEqual(lagging.verified, false);
    assert.strictEqual(checks, 5);
    assert.strictEqual(pauses, 4);

    const statusPath = path.join(os.tmpdir(), `carry-firewall-test-${process.pid}.json`);
    const denied = firewall.installLanRules({
      platform: 'win32',
      statusPath,
      runner: () => {
        fs.writeFileSync(statusPath, JSON.stringify({ ok: false, error: 'Access is denied.' }));
        return { status: 1, error: null, stderr: '' };
      },
      ruleCheck: () => false,
      sleep: () => {},
    });
    assert.strictEqual(denied.ok, false);
    assert.match(denied.message, /administrator or device policy/i,
      'real Windows failures produce actionable guidance');
    assert.strictEqual(fs.existsSync(statusPath), false, 'private elevated status is cleaned up');

    const cancelled = firewall.installLanRules({
      platform: 'win32',
      runner: () => ({ status: 1, error: null, stderr: 'The operation was canceled by the user.' }),
      ruleCheck: () => false,
      sleep: () => {},
    });
    assert.match(cancelled.message, /administrator prompt was cancelled/i);

    let installs = 0;
    const firewallProvider = {
      rulesInstalled: () => false,
      installLanRules: () => ++installs === 1 ?
        { ok: false, message: 'Windows device policy blocks local firewall rules.' } :
        { ok: true, verified: false },
    };
    app = await appServer.start({
      root,
      port: 0,
      persistSettings: false,
      firewall: firewallProvider,
    });
    const request = () => fetch(`http://127.0.0.1:${app.port}/api/firewall`, {
      method: 'POST',
      headers: { 'X-Carry-Token': app.token },
    });
    const failure = await request();
    assert.strictEqual(failure.status, 409);
    assert.match((await failure.json()).error, /device policy blocks/i,
      'the GUI receives the elevated Windows diagnostic');
    const success = await request();
    assert.strictEqual(success.status, 200,
      'the API accepts elevated success even while the caller view is catching up');

    console.log('FIREWALL INTEGRATION PASS: elevation success, delayed verification, and policy diagnostics.');
  } finally {
    if (app) await app.close();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    if (originalSkip === undefined) delete process.env.CARRY_SKIP_FIREWALL;
    else process.env.CARRY_SKIP_FIREWALL = originalSkip;
  }
})().catch((error) => {
  console.error('FIREWALL INTEGRATION FAIL:', error);
  process.exitCode = 1;
});
