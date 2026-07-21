'use strict';

// Carry deliberately installs node-datachannel with lifecycle scripts disabled.
// prebuild-install otherwise downloads an unsigned release asset that is not
// covered by package-lock.json. This helper fetches the one Windows artifact we
// ship, verifies both the archive and extracted native module, and refuses every
// other platform/architecture instead of silently building or running unknown
// code.

const crypto = require('crypto');
const fs = require('fs');
const https = require('https');
const path = require('path');
const { spawnSync } = require('child_process');

const VERSION = '0.32.3';
const ARCHIVE = `node-datachannel-v${VERSION}-napi-v8-win32-x64.tar.gz`;
const ARCHIVE_SHA256 = '3bfacc4125b296197fe9e22ebd9a52f05321c50aca9d80b92897507f898c12c3';
const BINARY_SHA256 = '9c994ed1262f12313694d34f18a4b8e291b21790360d603a78cd23a4f5539b25';
const DOWNLOAD = `https://github.com/murat-dogan/node-datachannel/releases/download/v${VERSION}/${ARCHIVE}`;
const MAX_ARCHIVE_BYTES = 16 * 1024 * 1024;

const root = path.resolve(__dirname, '..');
const moduleRoot = path.join(root, 'node_modules', 'node-datachannel');
const binary = path.join(moduleRoot, 'build', 'Release', 'node_datachannel.node');
const cacheDir = path.join(root, '.build-cache', 'node-datachannel');
const archive = path.join(cacheDir, ARCHIVE);

function hashFile(file) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    for (;;) {
      const read = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (!read) break;
      hash.update(buffer.subarray(0, read));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

function safeUnlink(file) {
  try { fs.unlinkSync(file); } catch { /* best effort */ }
}

function download(url, destination, redirects = 0) {
  if (redirects > 5) return Promise.reject(new Error('native dependency download redirected too many times'));
  return new Promise((resolve, reject) => {
    const request = https.get(url, {
      headers: { 'User-Agent': `Carry/${require('../package.json').version}` },
      timeout: 30000,
    }, (response) => {
      if ([301, 302, 303, 307, 308].includes(response.statusCode) && response.headers.location) {
        response.resume();
        let next;
        try { next = new URL(response.headers.location, url); } catch (error) { reject(error); return; }
        if (next.protocol !== 'https:') {
          reject(new Error('native dependency download refused a non-HTTPS redirect'));
          return;
        }
        download(next.href, destination, redirects + 1).then(resolve, reject);
        return;
      }
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`native dependency download returned HTTP ${response.statusCode}`));
        return;
      }
      const temporary = destination + '.download';
      safeUnlink(temporary);
      const output = fs.createWriteStream(temporary, { flags: 'wx' });
      let bytes = 0;
      let settled = false;
      const finish = (error) => {
        if (settled) return;
        settled = true;
        if (error) {
          output.destroy();
          safeUnlink(temporary);
          reject(error);
        } else {
          fs.renameSync(temporary, destination);
          resolve();
        }
      };
      response.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > MAX_ARCHIVE_BYTES) {
          response.destroy(new Error('native dependency archive exceeds the safety limit'));
        }
      });
      response.on('error', finish);
      output.on('error', finish);
      output.on('finish', () => finish());
      response.pipe(output);
    });
    request.on('timeout', () => request.destroy(new Error('native dependency download timed out')));
    request.on('error', reject);
  });
}

async function main() {
  if (process.platform !== 'win32' || process.arch !== 'x64') {
    throw new Error(`Carry's pinned DataChannel build supports Windows x64 only (got ${process.platform}-${process.arch})`);
  }
  const pkg = require('../package.json');
  if (!pkg.dependencies || pkg.dependencies['node-datachannel'] !== VERSION) {
    throw new Error(`package.json must pin node-datachannel exactly to ${VERSION}`);
  }
  const installedPackage = path.join(moduleRoot, 'package.json');
  if (!fs.existsSync(installedPackage) || require(installedPackage).version !== VERSION) {
    throw new Error('node-datachannel JavaScript files are missing; run npm ci --ignore-scripts first');
  }
  if (fs.existsSync(binary) && hashFile(binary) === BINARY_SHA256) {
    console.log(`Pinned node-datachannel ${VERSION} native module is ready.`);
    return;
  }

  fs.mkdirSync(cacheDir, { recursive: true });
  if (!fs.existsSync(archive) || hashFile(archive) !== ARCHIVE_SHA256) {
    safeUnlink(archive);
    await download(DOWNLOAD, archive);
  }
  if (hashFile(archive) !== ARCHIVE_SHA256) {
    safeUnlink(archive);
    throw new Error('downloaded node-datachannel archive failed SHA-256 verification');
  }

  fs.mkdirSync(path.dirname(binary), { recursive: true });
  safeUnlink(binary);
  const extracted = spawnSync('tar', ['-xf', archive, '-C', moduleRoot], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
  });
  if (extracted.status !== 0) {
    throw new Error('could not extract the pinned native dependency: ' + (extracted.stderr || extracted.error || 'tar failed'));
  }
  if (!fs.existsSync(binary) || hashFile(binary) !== BINARY_SHA256) {
    safeUnlink(binary);
    throw new Error('extracted node-datachannel module failed SHA-256 verification');
  }
  console.log(`Prepared pinned node-datachannel ${VERSION} for Windows x64.`);
}

main().catch((error) => {
  console.error('Carry native dependency preparation failed:', error.message);
  process.exitCode = 1;
});
