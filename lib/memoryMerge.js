'use strict';

const fs = require('fs');
const { writeFileAtomic } = require('./fsx');

// Smart union-merge of two shared-agent-memory stores (the NDJSON graph file).
// This is Carry's differentiating feature: git would just hand you a merge
// conflict on memory.json. We instead union entities by name and relations by
// (from,to,relationType), and for observations on the same entity we keep BOTH
// sets (deduped by exact string). Last-write-wins is NOT used for memory — two
// agents on two machines may both have written notes we want to keep.

const SHARED_MEM_DIR = '.shared-memory';
const MEMORY_FILE = 'memory.json';

function parseStore(raw) {
  const text = (raw || '').trim();
  if (!text) return { entities: [], relations: [] };
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  const entities = [];
  const relations = [];
  for (const l of lines) {
    let o;
    try { o = JSON.parse(l); } catch { continue; }
    if (!o || typeof o !== 'object' || typeof o.type !== 'string') continue;
    if (o.type === 'entity') entities.push(o);
    else if (o.type === 'relation') relations.push(o);
  }
  return { entities, relations };
}

function readStore(projectRoot) {
  const f = require('path').join(projectRoot, SHARED_MEM_DIR, MEMORY_FILE);
  if (!fs.existsSync(f)) return { entities: [], relations: [] };
  return parseStore(fs.readFileSync(f, 'utf8'));
}

function toNdjson(store) {
  const out = [];
  for (const e of store.entities) {
    out.push(JSON.stringify({
      type: 'entity',
      name: e.name,
      entityType: e.entityType || 'entity',
      observations: e.observations || [],
    }));
  }
  for (const r of store.relations) {
    out.push(JSON.stringify({
      type: 'relation',
      from: r.from,
      to: r.to,
      relationType: r.relationType,
    }));
  }
  return out.length ? out.join('\n') + '\n' : '';
}

// Merge the local store with an incoming store (the peer's). Returns the merged
// store plus counts so the CLI can report what changed. `incoming` wins ties on
// observation order but both sides' distinct observations are preserved.
function mergeStores(local, incoming) {
  const entitiesByName = new Map();
  for (const e of local.entities) {
    entitiesByName.set(e.name, {
      name: e.name,
      entityType: e.entityType || 'entity',
      observations: [...(e.observations || [])],
    });
  }
  let addedEntities = 0;
  let addedObs = 0;
  for (const e of incoming.entities) {
    const cur = entitiesByName.get(e.name);
    if (!cur) {
      entitiesByName.set(e.name, {
        name: e.name,
        entityType: e.entityType || 'entity',
        observations: [...(e.observations || [])],
      });
      addedEntities++;
      addedObs += (e.observations || []).length;
      continue;
    }
    for (const obs of e.observations || []) {
      if (!cur.observations.includes(obs)) {
        cur.observations.push(obs);
        addedObs++;
      }
    }
  }

  const relKey = (r) => `${r.from}\u0000${r.to}\u0000${r.relationType}`;
  const relations = new Map();
  for (const r of local.relations) relations.set(relKey(r), r);
  let addedRels = 0;
  for (const r of incoming.relations) {
    if (!relations.has(relKey(r))) {
      relations.set(relKey(r), r);
      addedRels++;
    }
  }

  return {
    store: {
      entities: [...entitiesByName.values()],
      relations: [...relations.values()],
    },
    addedEntities,
    addedObs,
    addedRels,
  };
}

// Merge the peer's memory into the local project's memory file, writing the
// result with an atomic rename. Returns a summary or null if there is no memory
// to merge on either side.
function mergeMemoryInto(localRoot, incomingStore) {
  const hasIncoming = incomingStore.entities.length || incomingStore.relations.length;
  if (!hasIncoming) return null;

  const localStore = readStore(localRoot);
  const hasLocal = localStore.entities.length || localStore.relations.length;
  const result = mergeStores(localStore, incomingStore);

  // No change needed (e.g. incoming is a subset of local) → skip the write.
  if (result.addedEntities === 0 && result.addedObs === 0 && result.addedRels === 0 && hasLocal) {
    return { changed: false, ...result };
  }

  const memDir = require('path').join(localRoot, SHARED_MEM_DIR);
  fs.mkdirSync(memDir, { recursive: true });
  const target = require('path').join(memDir, MEMORY_FILE);
  // Back up the previous memory file before overwriting, so a bad merge is
  // reversible without git.
  if (fs.existsSync(target)) {
    fs.writeFileSync(target + '.bak', fs.readFileSync(target, 'utf8'));
  }
  writeFileAtomic(target, toNdjson(result.store));
  return { changed: true, ...result };
}

module.exports = {
  SHARED_MEM_DIR,
  MEMORY_FILE,
  parseStore,
  readStore,
  toNdjson,
  mergeStores,
  mergeMemoryInto,
};
