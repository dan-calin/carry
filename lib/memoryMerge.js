'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { writeFileAtomic } = require('./fsx');
const privateState = require('./private-state');

// Smart union-merge of two shared-agent-memory stores (the NDJSON graph file).
// Carry also exposes a management UI for this official graph format. UI-only
// metadata (pins and import provenance) stays in Carry's private app-data
// directory so MCP servers never receive proprietary fields.

const SHARED_MEM_DIR = '.shared-memory';
const MEMORY_FILE = 'memory.json';
const UI_METADATA_VERSION = 1;
const MAX_NAME = 240;
const MAX_ENTITY_TYPE = 80;
const MAX_OBSERVATIONS = 1000;
const MAX_OBSERVATION = 8000;

function parseStore(raw) {
  const text = (raw || '').trim();
  if (!text) return { entities: [], relations: [] };
  const lines = text.split(/\r?\n/).filter((line) => line.trim());
  const entities = [];
  const relations = [];
  for (const line of lines) {
    let value;
    try { value = JSON.parse(line); } catch { continue; }
    if (!value || typeof value !== 'object' || typeof value.type !== 'string') continue;
    if (value.type === 'entity') entities.push(value);
    else if (value.type === 'relation') relations.push(value);
  }
  return { entities, relations };
}

function memoryFile(projectRoot) {
  return path.join(projectRoot, SHARED_MEM_DIR, MEMORY_FILE);
}

function readStore(projectRoot) {
  const file = memoryFile(projectRoot);
  if (!fs.existsSync(file)) return { entities: [], relations: [] };
  return parseStore(fs.readFileSync(file, 'utf8'));
}

function toNdjson(store) {
  const out = [];
  for (const entity of store.entities) {
    out.push(JSON.stringify({
      type: 'entity',
      name: entity.name,
      entityType: entity.entityType || 'entity',
      observations: entity.observations || [],
    }));
  }
  for (const relation of store.relations) {
    out.push(JSON.stringify({
      type: 'relation',
      from: relation.from,
      to: relation.to,
      relationType: relation.relationType,
    }));
  }
  return out.length ? out.join('\n') + '\n' : '';
}

function observationKey(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function metadataFile(projectRoot) {
  return privateState.projectFile(projectRoot, 'memory-ui.json');
}

function emptyMetadata() {
  return { version: UI_METADATA_VERSION, pins: [], provenance: Object.create(null) };
}

function readMetadata(projectRoot) {
  const file = metadataFile(projectRoot);
  if (!fs.existsSync(file)) return emptyMetadata();
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!parsed || parsed.version !== UI_METADATA_VERSION || !Array.isArray(parsed.pins) ||
        !parsed.provenance || typeof parsed.provenance !== 'object' || Array.isArray(parsed.provenance)) {
      return emptyMetadata();
    }
    const provenance = Object.create(null);
    for (const [name, records] of Object.entries(parsed.provenance)) {
      if (records && typeof records === 'object' && !Array.isArray(records)) provenance[name] = records;
    }
    return {
      version: UI_METADATA_VERSION,
      pins: [...new Set(parsed.pins.filter((value) => typeof value === 'string'))],
      provenance,
    };
  } catch {
    return emptyMetadata();
  }
}

function writeMetadata(projectRoot, metadata) {
  const normalized = {
    version: UI_METADATA_VERSION,
    pins: [...new Set(metadata.pins || [])].sort(),
    provenance: metadata.provenance || {},
  };
  writeFileAtomic(metadataFile(projectRoot), JSON.stringify(normalized, null, 2) + '\n');
}

function validateText(value, label, max) {
  const text = String(value || '').trim();
  if (!text || text.length > max || /[\r\n\0]/.test(text)) {
    throw Object.assign(new Error(`${label} must be between 1 and ${max} characters on one line`), { statusCode: 400 });
  }
  return text;
}

function normalizeEntityInput(value) {
  const input = value && typeof value === 'object' ? value : {};
  const name = validateText(input.name, 'Memory item name', MAX_NAME);
  const entityType = validateText(input.entityType || 'entity', 'Memory item type', MAX_ENTITY_TYPE);
  if (!Array.isArray(input.observations) || input.observations.length > MAX_OBSERVATIONS) {
    throw Object.assign(new Error(`Memory observations must be a list of at most ${MAX_OBSERVATIONS} items`), { statusCode: 400 });
  }
  const observations = [];
  for (const value of input.observations) {
    const observation = String(value || '').trim();
    if (!observation || observation.length > MAX_OBSERVATION || observation.includes('\0')) {
      throw Object.assign(new Error(`Each memory observation must be between 1 and ${MAX_OBSERVATION} characters`), { statusCode: 400 });
    }
    if (!observations.includes(observation)) observations.push(observation);
  }
  return { name, entityType, observations };
}

function writeStore(projectRoot, store, expectedRaw) {
  const directory = path.join(projectRoot, SHARED_MEM_DIR);
  const target = memoryFile(projectRoot);
  fs.mkdirSync(directory, { recursive: true });
  if (expectedRaw !== undefined) {
    const current = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : '';
    if (current !== expectedRaw) {
      throw Object.assign(new Error('Shared memory changed while this item was open. Refresh it and try again.'), { statusCode: 409 });
    }
  }
  if (fs.existsSync(target)) fs.writeFileSync(target + '.bak', fs.readFileSync(target));
  writeFileAtomic(target, toNdjson(store));
}

function mutateStore(projectRoot, mutate) {
  const target = memoryFile(projectRoot);
  const raw = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : '';
  const store = parseStore(raw);
  const result = mutate(store);
  writeStore(projectRoot, store, raw);
  return result;
}

function parseObservationAttribution(text) {
  const match = String(text).match(/\(([^,()]{1,80}),\s*(\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2})?)?)\)\s*$/);
  if (!match) return { author: null, recordedAt: null };
  const parsed = Date.parse(match[2].includes('T') ? match[2] : match[2].replace(' ', 'T'));
  return {
    author: match[1].trim(),
    recordedAt: Number.isFinite(parsed) ? new Date(parsed).toISOString() : match[2],
  };
}

function list(projectRoot) {
  const store = readStore(projectRoot);
  const metadata = readMetadata(projectRoot);
  const pins = new Set(metadata.pins);
  const relationsByEntity = new Map();
  for (const relation of store.relations) {
    if (!relationsByEntity.has(relation.from)) relationsByEntity.set(relation.from, []);
    if (!relationsByEntity.has(relation.to)) relationsByEntity.set(relation.to, []);
    relationsByEntity.get(relation.from).push({ ...relation, direction: 'outgoing' });
    if (relation.to !== relation.from) relationsByEntity.get(relation.to).push({ ...relation, direction: 'incoming' });
  }
  const items = store.entities.map((entity) => {
    const provenance = metadata.provenance[entity.name] || {};
    return {
      name: entity.name,
      entityType: entity.entityType || 'entity',
      pinned: pins.has(entity.name),
      observations: (entity.observations || []).map((text) => ({
        text,
        ...parseObservationAttribution(text),
        provenance: provenance[observationKey(text)] || null,
      })),
      relations: relationsByEntity.get(entity.name) || [],
    };
  });
  items.sort((left, right) =>
    Number(right.pinned) - Number(left.pinned) || left.name.localeCompare(right.name));
  return {
    summary: {
      entities: items.length,
      observations: items.reduce((count, item) => count + item.observations.length, 0),
      relations: store.relations.length,
      pinned: items.filter((item) => item.pinned).length,
      revision: crypto.createHash('sha256').update(toNdjson(store), 'utf8').digest('hex').slice(0, 16),
    },
    items,
  };
}

function summary(projectRoot) {
  return list(projectRoot).summary;
}

function update(projectRoot, originalNameValue, input) {
  const originalName = validateText(originalNameValue, 'Original memory item name', MAX_NAME);
  const next = normalizeEntityInput(input);
  const metadata = readMetadata(projectRoot);
  const result = mutateStore(projectRoot, (store) => {
    const index = store.entities.findIndex((entity) => entity.name === originalName);
    if (index < 0) throw Object.assign(new Error('Memory item was not found'), { statusCode: 404 });
    if (next.name !== originalName && store.entities.some((entity) => entity.name === next.name)) {
      throw Object.assign(new Error('Another memory item already uses that name'), { statusCode: 409 });
    }
    store.entities[index] = { type: 'entity', ...next };
    if (next.name !== originalName) {
      store.relations = store.relations.map((relation) => ({
        ...relation,
        from: relation.from === originalName ? next.name : relation.from,
        to: relation.to === originalName ? next.name : relation.to,
      }));
    }
    return next;
  });

  const wasPinned = metadata.pins.includes(originalName);
  metadata.pins = metadata.pins.filter((name) => name !== originalName && name !== next.name);
  if (wasPinned) metadata.pins.push(next.name);
  const existingProvenance = metadata.provenance[originalName] || metadata.provenance[next.name] || {};
  const retainedKeys = new Set(next.observations.map(observationKey));
  metadata.provenance[next.name] = Object.fromEntries(
    Object.entries(existingProvenance).filter(([key]) => retainedKeys.has(key)));
  if (next.name !== originalName) delete metadata.provenance[originalName];
  writeMetadata(projectRoot, metadata);
  return result;
}

function remove(projectRoot, nameValue) {
  const name = validateText(nameValue, 'Memory item name', MAX_NAME);
  let removedRelations = 0;
  const removed = mutateStore(projectRoot, (store) => {
    const index = store.entities.findIndex((entity) => entity.name === name);
    if (index < 0) throw Object.assign(new Error('Memory item was not found'), { statusCode: 404 });
    const [entity] = store.entities.splice(index, 1);
    const before = store.relations.length;
    store.relations = store.relations.filter((relation) => relation.from !== name && relation.to !== name);
    removedRelations = before - store.relations.length;
    return entity;
  });
  const metadata = readMetadata(projectRoot);
  metadata.pins = metadata.pins.filter((value) => value !== name);
  delete metadata.provenance[name];
  writeMetadata(projectRoot, metadata);
  return { name: removed.name, removedRelations };
}

function setPinned(projectRoot, nameValue, pinnedValue) {
  const name = validateText(nameValue, 'Memory item name', MAX_NAME);
  if (typeof pinnedValue !== 'boolean') {
    throw Object.assign(new Error('Pinned state must be true or false'), { statusCode: 400 });
  }
  if (!readStore(projectRoot).entities.some((entity) => entity.name === name)) {
    throw Object.assign(new Error('Memory item was not found'), { statusCode: 404 });
  }
  const metadata = readMetadata(projectRoot);
  metadata.pins = metadata.pins.filter((value) => value !== name);
  if (pinnedValue) metadata.pins.push(name);
  writeMetadata(projectRoot, metadata);
  return { name, pinned: pinnedValue };
}

// Merge the local store with an incoming store. Last-write-wins is deliberately
// avoided: distinct observations and graph edges from both devices survive.
function mergeStores(local, incoming) {
  const entitiesByName = new Map();
  for (const entity of local.entities) {
    entitiesByName.set(entity.name, {
      name: entity.name,
      entityType: entity.entityType || 'entity',
      observations: [...(entity.observations || [])],
    });
  }
  let addedEntities = 0;
  let addedObs = 0;
  const changedEntityNames = new Set();
  const addedEntityRecords = [];
  const addedObservationRecords = [];
  for (const entity of incoming.entities) {
    const current = entitiesByName.get(entity.name);
    if (!current) {
      const observations = [...new Set(entity.observations || [])];
      entitiesByName.set(entity.name, {
        name: entity.name,
        entityType: entity.entityType || 'entity',
        observations,
      });
      addedEntities++;
      addedObs += observations.length;
      changedEntityNames.add(entity.name);
      addedEntityRecords.push({
        name: entity.name,
        entityType: entity.entityType || 'entity',
      });
      for (const observation of observations) addedObservationRecords.push({ name: entity.name, observation });
      continue;
    }
    for (const observation of entity.observations || []) {
      if (!current.observations.includes(observation)) {
        current.observations.push(observation);
        addedObs++;
        changedEntityNames.add(entity.name);
        addedObservationRecords.push({ name: entity.name, observation });
      }
    }
  }

  const relationKey = (relation) => `${relation.from}\u0000${relation.to}\u0000${relation.relationType}`;
  const relations = new Map();
  for (const relation of local.relations) relations.set(relationKey(relation), relation);
  let addedRels = 0;
  const addedRelationRecords = [];
  for (const relation of incoming.relations) {
    if (!relations.has(relationKey(relation))) {
      relations.set(relationKey(relation), relation);
      addedRels++;
      addedRelationRecords.push({
        from: relation.from,
        to: relation.to,
        relationType: relation.relationType,
      });
      changedEntityNames.add(relation.from);
      changedEntityNames.add(relation.to);
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
    changedEntityNames: [...changedEntityNames].sort(),
    addedEntityRecords,
    addedObservationRecords,
    addedRelationRecords,
  };
}

function recordImportedProvenance(projectRoot, result, options) {
  if (!options || !options.sourcePeerId || !result.addedObservationRecords.length) return;
  const metadata = readMetadata(projectRoot);
  const receivedAt = options.receivedAt || new Date().toISOString();
  for (const record of result.addedObservationRecords) {
    if (!metadata.provenance[record.name] || typeof metadata.provenance[record.name] !== 'object') {
      metadata.provenance[record.name] = {};
    }
    metadata.provenance[record.name][observationKey(record.observation)] = {
      peerId: String(options.sourcePeerId),
      sessionId: options.sessionId ? String(options.sessionId) : null,
      receivedAt,
    };
  }
  writeMetadata(projectRoot, metadata);
}

// Merge the peer's memory into the local project and preserve a local backup.
function mergeMemoryInto(localRoot, incomingStore, options) {
  const hasIncoming = incomingStore.entities.length || incomingStore.relations.length;
  if (!hasIncoming) return null;

  const localStore = readStore(localRoot);
  const hasLocal = localStore.entities.length || localStore.relations.length;
  const result = mergeStores(localStore, incomingStore);
  if (result.addedEntities === 0 && result.addedObs === 0 && result.addedRels === 0 && hasLocal) {
    return { changed: false, ...result };
  }

  writeStore(localRoot, result.store);
  recordImportedProvenance(localRoot, result, options);
  return { changed: true, ...result };
}

module.exports = {
  SHARED_MEM_DIR,
  MEMORY_FILE,
  parseStore,
  readStore,
  toNdjson,
  list,
  summary,
  update,
  remove,
  setPinned,
  mergeStores,
  mergeMemoryInto,
  memoryFile,
};
