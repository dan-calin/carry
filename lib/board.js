'use strict';

const fs = require('fs');
const path = require('path');

// Thin, read-only view over a synced project's shared-agent-memory coordination
// board. Carry uses it to decide whether a file is "hot" (an agent on some
// machine has claimed it) so we can pause syncing that file instead of
// clobbering an in-progress edit. We only READ activity.jsonl — never write to
// the shared-agent-memory tree (that stays read-only from Carry's perspective).

const SHARED_MEM_DIR = '.shared-memory';
const ACTIVITY = 'activity.jsonl';
const TTL_MS = 2 * 60 * 60 * 1000; // match shared-agent-memory/lib/board.js

function norm(p) {
  return String(p).replace(/\\/g, '/').toLowerCase();
}

function isAbsolute(np) {
  return np.startsWith('/') || /^[a-z]:\//.test(np);
}

// Resolve a claimed (possibly relative) path against the project so claims from
// different projects cannot collide. Mirrors board.expand.
function expand(file, project) {
  const nf = norm(file);
  if (project && !isAbsolute(nf)) return norm(path.posix.join(norm(project), nf));
  return nf;
}

function readClaims(projectRoot) {
  const f = path.join(projectRoot, SHARED_MEM_DIR, ACTIVITY);
  if (!fs.existsSync(f)) return [];
  const now = Date.now();
  return fs
    .readFileSync(f, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    })
    .filter((c) => c && now - (c.ts || 0) < TTL_MS);
}

// True if any active claim (by an agent/device other than `selfAgent`) touches
// `file`. `selfAgent` lets a machine skip pausing on its OWN claim but still
// pause on the peer's. We treat peer device ids as foreign agents.
function isFileClaimed(projectRoot, file, selfAgent) {
  const claims = readClaims(projectRoot);
  const target = expand(file, '');
  for (const c of claims) {
    if (selfAgent && c.agent === selfAgent) continue;
    for (const cf of c.files || []) {
      const ec = expand(cf, c.project || '');
      if (ec === target || ec.endsWith('/' + target) || target.endsWith('/' + ec)) return true;
    }
  }
  return false;
}

module.exports = { SHARED_MEM_DIR, ACTIVITY, TTL_MS, readClaims, isFileClaimed };
