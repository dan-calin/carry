'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const STATE_VERSION = 1;
const SECRET_AAD = Buffer.from('carry-private-secret-v1\0', 'utf8');
let cachedMasterKey = null;

function stateRoot() {
  const override = String(process.env.CARRY_PRIVATE_STATE_DIR || '').trim();
  if (override) return path.resolve(override);
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA;
    if (!local) throw new Error('Windows did not provide a private local application-data folder');
    return path.join(local, 'Carry');
  }
  const base = process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state');
  return path.join(base, 'Carry');
}

function canonicalRoot(root) {
  const resolved = fs.realpathSync.native(path.resolve(root));
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function projectKey(root) {
  return crypto.createHash('sha256')
    .update('carry-private-project-v1\0', 'utf8')
    .update(canonicalRoot(root), 'utf8')
    .digest('hex');
}

function rawProjectDir(root) {
  return path.join(stateRoot(), 'projects', projectKey(root));
}

function assertRealDirectory(directory, label) {
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${label} must be a real private directory`);
}

function ensureDirectory(directory, label) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  assertRealDirectory(directory, label);
  if (process.platform !== 'win32') fs.chmodSync(directory, 0o700);
}

function listVerifiedTree(directory, relative = '') {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const rel = relative ? path.join(relative, entry.name) : entry.name;
    const full = path.join(directory, entry.name);
    const stat = fs.lstatSync(full);
    if (stat.isSymbolicLink()) throw new Error(`legacy Carry state contains an unsafe link: ${rel}`);
    if (stat.isDirectory()) files.push(...listVerifiedTree(full, rel));
    else if (stat.isFile()) files.push({ rel, full, size: stat.size });
    else throw new Error(`legacy Carry state contains an unsupported entry: ${rel}`);
  }
  return files;
}

function hashFile(file) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    for (;;) {
      const bytes = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (!bytes) break;
      hash.update(buffer.subarray(0, bytes));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

function migrateLegacyState(root) {
  const legacy = path.join(path.resolve(root), '.carry');
  if (!fs.existsSync(path.join(legacy, 'manifest.json'))) return;
  const legacyStat = fs.lstatSync(legacy);
  if (!legacyStat.isDirectory() || legacyStat.isSymbolicLink()) {
    throw new Error('The project contains an unsafe .carry link. Remove it before opening this folder.');
  }
  const target = rawProjectDir(root);
  if (fs.existsSync(target)) {
    if (fs.existsSync(path.join(target, 'manifest.json'))) {
      throw new Error('Carry found both legacy and private project state; remove the obsolete .carry folder after verifying the private copy');
    }
    throw new Error('Carry cannot safely merge legacy state into an existing private state directory');
  }

  const sourceFiles = listVerifiedTree(legacy);
  const projects = path.dirname(target);
  ensureDirectory(stateRoot(), 'Carry application state');
  ensureDirectory(projects, 'Carry project state');
  const staging = `${target}.migrate-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
  fs.mkdirSync(staging, { mode: 0o700 });
  try {
    for (const item of sourceFiles) {
      const destination = path.join(staging, item.rel);
      fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
      fs.copyFileSync(item.full, destination, fs.constants.COPYFILE_EXCL);
      const copied = fs.lstatSync(destination);
      if (!copied.isFile() || copied.isSymbolicLink() || copied.size !== item.size ||
          hashFile(destination) !== hashFile(item.full)) {
        throw new Error(`Carry could not verify migrated private state: ${item.rel}`);
      }
      if (process.platform !== 'win32') fs.chmodSync(destination, 0o600);
    }
    fs.renameSync(staging, target);
  } catch (error) {
    try { fs.rmSync(staging, { recursive: true, force: true }); } catch { /* preserve migration error */ }
    throw error;
  }

  try {
    const finalLegacyStat = fs.lstatSync(legacy);
    if (!finalLegacyStat.isDirectory() || finalLegacyStat.isSymbolicLink()) {
      throw new Error('legacy Carry state changed during its secure migration');
    }
    const finalFiles = listVerifiedTree(legacy);
    if (finalFiles.length !== sourceFiles.length) throw new Error('legacy Carry state changed during its secure migration');
    for (const item of finalFiles) {
      const migrated = path.join(target, item.rel);
      if (!fs.existsSync(migrated) || hashFile(migrated) !== hashFile(item.full)) {
        throw new Error(`legacy Carry state changed during its secure migration: ${item.rel}`);
      }
    }
  } catch (error) {
    try { fs.rmSync(target, { recursive: true, force: true }); } catch { /* preserve migration error */ }
    throw error;
  }

  const resolvedLegacy = path.resolve(legacy);
  if (path.dirname(resolvedLegacy) !== path.resolve(root) || path.basename(resolvedLegacy) !== '.carry') {
    throw new Error('Carry refused to remove an uncontained legacy state directory');
  }
  fs.rmSync(resolvedLegacy, { recursive: true, force: false });
}

function existingProjectDir(root) {
  migrateLegacyState(root);
  const directory = rawProjectDir(root);
  return fs.existsSync(directory) ? directory : null;
}

function projectDir(root) {
  migrateLegacyState(root);
  const directory = rawProjectDir(root);
  ensureDirectory(stateRoot(), 'Carry application state');
  ensureDirectory(path.dirname(directory), 'Carry project state');
  ensureDirectory(directory, 'Carry private project state');
  const record = path.join(directory, 'project.json');
  const canonical = canonicalRoot(root);
  if (fs.existsSync(record)) {
    let parsed;
    try { parsed = JSON.parse(fs.readFileSync(record, 'utf8')); }
    catch { throw new Error('Carry private project identity is corrupt'); }
    if (parsed.version !== STATE_VERSION || parsed.root !== canonical) {
      throw new Error('Carry private project identity does not match the selected folder');
    }
  } else {
    fs.writeFileSync(record, JSON.stringify({ version: STATE_VERSION, root: canonical }, null, 2) + '\n', {
      flag: 'wx', mode: 0o600,
    });
  }
  return directory;
}

function projectFile(root, ...parts) {
  return path.join(projectDir(root), ...parts);
}

function appFile(...parts) {
  const root = stateRoot();
  ensureDirectory(root, 'Carry application state');
  return path.join(root, ...parts);
}

function runDpapi(mode, bytes) {
  const script = [
    'Add-Type -AssemblyName System.Security',
    '$text = [Console]::In.ReadToEnd()',
    '$bytes = [Convert]::FromBase64String($text)',
    '$scope = [Security.Cryptography.DataProtectionScope]::CurrentUser',
    mode === 'protect'
      ? '$result = [Security.Cryptography.ProtectedData]::Protect($bytes, $null, $scope)'
      : '$result = [Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, $scope)',
    '[Console]::Out.Write([Convert]::ToBase64String($result))',
  ].join('; ');
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const result = spawnSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded,
  ], {
    input: Buffer.from(bytes).toString('base64'), encoding: 'utf8', windowsHide: true, timeout: 15000,
  });
  if (result.error || result.status !== 0 || !String(result.stdout || '').trim()) {
    throw new Error('Windows could not protect Carry credentials for the current user');
  }
  return Buffer.from(String(result.stdout).trim(), 'base64');
}

function masterKey() {
  if (cachedMasterKey) return cachedMasterKey;
  const file = appFile(process.platform === 'win32' ? 'master-key.dpapi' : 'master-key');
  if (fs.existsSync(file)) {
    const stored = Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'base64');
    cachedMasterKey = process.platform === 'win32' ? runDpapi('unprotect', stored) : stored;
  } else {
    const created = crypto.randomBytes(32);
    const stored = process.platform === 'win32' ? runDpapi('protect', created) : created;
    try {
      fs.writeFileSync(file, stored.toString('base64') + '\n', { flag: 'wx', mode: 0o600 });
      cachedMasterKey = created;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const existing = Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'base64');
      cachedMasterKey = process.platform === 'win32' ? runDpapi('unprotect', existing) : existing;
    }
  }
  if (!Buffer.isBuffer(cachedMasterKey) || cachedMasterKey.length !== 32) {
    cachedMasterKey = null;
    throw new Error('Carry credential protection key is invalid');
  }
  return cachedMasterKey;
}

function protectSecret(value) {
  if (value === null || value === undefined) return null;
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', masterKey(), nonce);
  cipher.setAAD(SECRET_AAD);
  const encrypted = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final(), cipher.getAuthTag()]);
  return { version: 1, nonce: nonce.toString('base64'), ciphertext: encrypted.toString('base64') };
}

function unprotectSecret(value) {
  if (value === null || value === undefined) return null;
  if (!value || value.version !== 1 || typeof value.nonce !== 'string' || typeof value.ciphertext !== 'string') {
    throw new Error('protected Carry credential is invalid');
  }
  const nonce = Buffer.from(value.nonce, 'base64');
  const payload = Buffer.from(value.ciphertext, 'base64');
  if (nonce.length !== 12 || payload.length < 17) throw new Error('protected Carry credential is invalid');
  const decipher = crypto.createDecipheriv('aes-256-gcm', masterKey(), nonce);
  decipher.setAAD(SECRET_AAD);
  decipher.setAuthTag(payload.subarray(payload.length - 16));
  try {
    return Buffer.concat([
      decipher.update(payload.subarray(0, payload.length - 16)), decipher.final(),
    ]).toString('utf8');
  } catch {
    throw new Error('Carry credential could not be decrypted for the current Windows user');
  }
}

module.exports = {
  stateRoot,
  projectKey,
  projectDir,
  existingProjectDir,
  projectFile,
  appFile,
  migrateLegacyState,
  protectSecret,
  unprotectSecret,
};
