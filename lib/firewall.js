'use strict';

// Windows Firewall integration for the first-run LAN wizard. Carry opens only
// its discovery UDP port and encrypted TCP link port, restricted to the local
// subnet and to the exact node.exe running Carry.

const { spawnSync } = require('child_process');

const DISCOVERY_PORT = 48123;
const DEFAULT_LINK_PORT = 48124;

function ruleNames(linkPort) {
  return [
    `Carry LAN discovery UDP ${DISCOVERY_PORT}`,
    `Carry LAN sync TCP ${linkPort}`,
  ];
}

function psQuote(value) {
  return String(value).replace(/'/g, "''");
}

function runPowerShell(script, opts) {
  return spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    windowsHide: true,
    stdio: opts && opts.inherit ? 'inherit' : 'pipe',
  });
}

function sleepSync(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function conciseFailure(result) {
  const raw = result && result.error && result.error.message ||
    result && result.stderr || '';
  const detail = String(raw).replace(/\s+/g, ' ').trim();
  if (/cancel(l)?ed by the user|operation was canceled/i.test(detail)) {
    return 'The Windows administrator prompt was cancelled.';
  }
  if (/access (is )?denied|unauthorized/i.test(detail)) {
    return 'Windows denied the firewall change. An administrator or device policy may be required.';
  }
  if (/New-NetFirewallRule|Get-NetFirewallRule/.test(detail) && /not recognized|not found/i.test(detail)) {
    return 'Windows Firewall management tools are unavailable on this device.';
  }
  return detail ? `Windows reported: ${detail.slice(0, 360)}` :
    'Windows did not confirm the firewall change. Try again or ask the device administrator to allow local rules.';
}

function rulesInstalled(opts) {
  opts = opts || {};
  if (process.env.CARRY_SKIP_FIREWALL === '1') return true;
  if ((opts.platform || process.platform) !== 'win32') return false;
  const linkPort = opts.linkPort || DEFAULT_LINK_PORT;
  const names = ruleNames(linkPort).map((name) => `'${psQuote(name)}'`).join(',');
  const script = [
    `$names = @(${names})`,
    'foreach ($name in $names) {',
    "  $rule = Get-NetFirewallRule -DisplayName $name -ErrorAction SilentlyContinue | Where-Object { $_.Enabled -eq 'True' -and $_.Direction -eq 'Inbound' -and $_.Action -eq 'Allow' } | Select-Object -First 1",
    '  if (-not $rule) { exit 1 }',
    '}',
    'exit 0',
  ].join('; ');
  const result = (opts.runner || runPowerShell)(script);
  return !result.error && result.status === 0;
}

// Opens one UAC prompt and installs both narrow rules. The elevated helper is
// hidden; only the Windows approval dialog is shown. Existing Carry rules with
// the same names are replaced so upgrades remain deterministic.
function installLanRules(opts) {
  opts = opts || {};
  if (process.env.CARRY_SKIP_FIREWALL === '1') return { ok: true, skipped: true };
  if ((opts.platform || process.platform) !== 'win32') {
    return { ok: false, unsupported: true, message: 'Automatic firewall setup is available only on Windows.' };
  }

  const linkPort = opts.linkPort || DEFAULT_LINK_PORT;
  const nodePath = opts.nodePath || process.execPath;
  const [udpRule, tcpRule] = ruleNames(linkPort);
  const elevatedScript = [
    "$ErrorActionPreference = 'Stop'",
    'try {',
    `  $names = @('${psQuote(udpRule)}','${psQuote(tcpRule)}')`,
    '  foreach ($name in $names) { Get-NetFirewallRule -PolicyStore PersistentStore -DisplayName $name -ErrorAction SilentlyContinue | Remove-NetFirewallRule }',
    `  New-NetFirewallRule -PolicyStore PersistentStore -DisplayName '${psQuote(udpRule)}' -Direction Inbound -Action Allow -Protocol UDP -LocalPort ${DISCOVERY_PORT} -Program '${psQuote(nodePath)}' -RemoteAddress LocalSubnet -Profile Any -EdgeTraversalPolicy Block | Out-Null`,
    `  New-NetFirewallRule -PolicyStore PersistentStore -DisplayName '${psQuote(tcpRule)}' -Direction Inbound -Action Allow -Protocol TCP -LocalPort ${linkPort} -Program '${psQuote(nodePath)}' -RemoteAddress LocalSubnet -Profile Any -EdgeTraversalPolicy Block | Out-Null`,
    '  $verified = $false',
    '  for ($attempt = 0; $attempt -lt 10; $attempt++) {',
    '    $verified = $true',
    '    foreach ($name in $names) {',
    "      $rule = Get-NetFirewallRule -PolicyStore ActiveStore -DisplayName $name -ErrorAction SilentlyContinue | Where-Object { $_.Enabled -eq 'True' -and $_.Direction -eq 'Inbound' -and $_.Action -eq 'Allow' } | Select-Object -First 1",
    '      if (-not $rule) { $verified = $false; break }',
    '    }',
    '    if ($verified) { break }',
    '    Start-Sleep -Milliseconds 200',
    '  }',
    "  if (-not $verified) { throw 'Windows created the rules but did not activate them. Device policy may block local firewall rules.' }",
    '  exit 0',
    '} catch {',
    '  exit 1',
    '}',
  ].join('\r\n');
  const encoded = Buffer.from(elevatedScript, 'utf16le').toString('base64');
  const launcher = [
    "$ErrorActionPreference = 'Stop'",
    'try {',
    `  $p = Start-Process -FilePath 'powershell.exe' -Verb RunAs -WindowStyle Hidden -Wait -PassThru -ArgumentList @('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-EncodedCommand','${encoded}')`,
    '  $p.Refresh()',
    '  exit $p.ExitCode',
    '} catch {',
    '  Write-Error $_',
    '  exit 1',
    '}',
  ].join('\r\n');
  const result = (opts.runner || runPowerShell)(launcher);
  const commandSucceeded = !result.error && result.status === 0;
  const ruleCheck = opts.ruleCheck || rulesInstalled;
  const pause = opts.sleep || sleepSync;
  let verified = false;
  if (commandSucceeded) {
    for (let attempt = 0; attempt < 5; attempt++) {
      verified = Boolean(ruleCheck({ linkPort }));
      if (verified) break;
      if (attempt < 4) pause(250);
    }
  }

  // The elevated helper verifies the ActiveStore before exiting successfully.
  // A lagging non-elevated policy view must not turn that success into an error.
  const ok = commandSucceeded;
  return {
    ok,
    verified,
    error: result.error || null,
    status: result.status,
    message: ok ? null : conciseFailure(result),
  };
}

module.exports = {
  DISCOVERY_PORT,
  DEFAULT_LINK_PORT,
  ruleNames,
  rulesInstalled,
  installLanRules,
};
