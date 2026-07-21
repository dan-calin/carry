'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(process.argv[2] || path.join(__dirname, '..', '.build', 'windows', 'stage'));

function required(rel) {
  const target = path.join(root, ...rel.split('/'));
  assert.ok(fs.existsSync(target), `package contains ${rel}`);
  return target;
}

function assertWindowsExecutable(file) {
  const handle = fs.openSync(file, 'r');
  try {
    const signature = Buffer.alloc(2);
    assert.strictEqual(fs.readSync(handle, signature, 0, 2, 0), 2);
    assert.strictEqual(signature.toString('ascii'), 'MZ', `${path.basename(file)} has a Windows executable header`);
  } finally {
    fs.closeSync(handle);
  }
}

try {
  const launcher = required('Carry.exe');
  const uninstaller = required('Uninstall.exe');
  const runtime = required('runtime/node.exe');
  required('runtime/LICENSE-node.txt');
  required('runtime/README.txt');
  const webviewBootstrapper = required('runtime/MicrosoftEdgeWebview2Setup.exe');
  required('bin/carry.js');
  required('app/index.html');
  required('app/assets/carry.ico');
  required('lib/app-server.js');
  required('relay/server.js');
  required('LICENSE');
  required('SECURITY.md');
  required('PRIVACY.md');
  required('THIRD_PARTY_NOTICES.md');
  required('node_modules/node-datachannel/LICENSE');
  const dataChannelBinary = required('node_modules/node-datachannel/build/Release/node_datachannel.node');

  assertWindowsExecutable(launcher);
  assertWindowsExecutable(uninstaller);
  assertWindowsExecutable(runtime);
  assertWindowsExecutable(webviewBootstrapper);
  assertWindowsExecutable(dataChannelBinary);
  assert.ok(!fs.existsSync(path.join(root, '.carry')), 'device identity is not packaged');
  assert.ok(!fs.existsSync(path.join(root, '.shared-memory')), 'developer memory is not packaged');
  assert.ok(!fs.existsSync(path.join(root, 'test')), 'test sources are not packaged');

  const help = spawnSync(runtime, [path.join(root, 'bin', 'carry.js'), 'help'], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 15000,
  });
  assert.strictEqual(help.status, 0, help.stderr || 'packaged Carry help exits successfully');
  assert.ok(help.stdout.includes('Carry'), 'packaged runtime executes Carry');

  const native = spawnSync(runtime, ['-e', `
    const rtc = require(${JSON.stringify(path.join(root, 'node_modules', 'node-datachannel'))});
    const peer = new rtc.PeerConnection('package-check', { iceServers: [] });
    if (peer.state() !== 'new') process.exit(3);
    peer.close();
    rtc.cleanup();
  `], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 15000,
  });
  assert.strictEqual(native.status, 0, native.stderr || 'packaged DataChannel module loads successfully');

  console.log(`PACKAGE INTEGRATION PASS: ${root}`);
} catch (error) {
  console.error('PACKAGE INTEGRATION FAIL:', error);
  process.exitCode = 1;
}
