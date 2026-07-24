'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

class TestElement {
  constructor() {
    this.attributes = new Map();
    this.classList = { add() {}, remove() {}, toggle() {} };
    this.dataset = {};
    this.disabled = false;
    this.hidden = false;
    this.innerHTML = '';
    this.style = {};
    this.textContent = '';
  }

  addEventListener() {}
  appendChild() {}
  close() {}
  querySelector() { return new TestElement(); }
  remove() {}
  removeAttribute(name) { this.attributes.delete(name); }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
}

(async function testFolderPickerSingleFlight() {
  const elements = new Map();
  const element = (id) => {
    if (!elements.has(id)) elements.set(id, new TestElement());
    return elements.get(id);
  };
  const folderSwitcher = element('folder-switcher');
  const chooseButton = new TestElement();
  let fetchCalls = 0;
  let finishRequest;

  const document = {
    cookie: '',
    documentElement: new TestElement(),
    hidden: false,
    addEventListener() {},
    createElement: () => new TestElement(),
    getElementById: element,
    querySelectorAll(selector) {
      return selector.includes('choose-folder') ? [folderSwitcher, chooseButton] : [];
    },
  };

  const context = {
    clearTimeout() {},
    console,
    document,
    fetch() {
      fetchCalls++;
      return new Promise((resolve) => { finishRequest = resolve; });
    },
    location: { hash: '' },
    matchMedia: () => ({ matches: false }),
    navigator: { clipboard: { writeText: async () => {} } },
    setTimeout: () => 1,
    window: { addEventListener() {} },
  };

  const source = fs.readFileSync(path.join(__dirname, '..', 'app', 'app.js'), 'utf8');
  const markup = fs.readFileSync(path.join(__dirname, '..', 'app', 'index.html'), 'utf8');
  const styles = fs.readFileSync(path.join(__dirname, '..', 'app', 'styles.css'), 'utf8');
  vm.runInNewContext(source, context, { filename: 'app/app.js' });

  assert.match(markup, /data-view="devices" aria-label="Devices"/,
    'compact navigation retains accessible names when visible labels collapse');
  assert.match(markup, /data-view="memory" aria-label="Memory"/,
    'shared memory has a first-class navigation view separate from activity');
  assert.match(markup, /id="memory-edit-dialog"/,
    'shared memory items have a dedicated editor instead of using the activity log');
  assert.match(source, /\/api\/memory\/(update|delete|pin)/,
    'memory management actions use explicit graph endpoints');
  assert.match(source, /checkpoint-memory-impact/,
    'checkpoint inspection renders shared-memory impact separately from project files');
  assert.match(source, /data-memory-session/,
    'activity deep links carry their sync-session context into the memory inspector');
  assert.match(styles, /\.memory-observation\.is-sync-highlight/,
    'observations added by a selected sync receive a persistent visual highlight');
  assert.doesNotMatch(styles, /@media \(max-width: 900px\)[\s\S]*?\.inspector\s*\{\s*display:\s*none/,
    'the narrow layout does not hide device and checkpoint actions');
  assert.match(
    context.memoryRows([{
      name: 'demo/decision',
      entityType: 'decision',
      pinned: true,
      observations: [{ text: 'Use Postgres (codex, 2026-07-23 12:00)' }],
      relations: [],
    }]),
    /memory-row is-pinned[\s\S]*data-memory-item="demo%2Fdecision"/,
    'memory ledger promotes pinned graph items with stable encoded selection keys',
  );
  const memorySession = {
    sessionId: 'sync/recent',
    status: 'completed',
    memory: {
      status: 'changed',
      addedEntities: 1,
      addedObservations: 1,
      addedRelations: 1,
      entityNames: ['demo/decision', 'demo/database'],
      entities: [{ name: 'demo/decision', entityType: 'decision' }],
      observations: [{ name: 'demo/decision', text: 'Use <Postgres> for durable storage' }],
      relations: [{ from: 'demo/decision', to: 'demo/database', relationType: 'depends-on' }],
    },
  };
  const activityMemory = context.renderSessionMemoryChanges(memorySession, { name: 'Laptop' });
  assert.match(activityMemory, /Memory added in this sync/,
    'activity names the exact memory additions section');
  assert.match(activityMemory, /Use &lt;Postgres&gt; for durable storage/,
    'activity shows exact observation text with HTML escaping');
  assert.match(activityMemory, /depends-on &rarr; demo\/database/,
    'activity shows exact relationship additions');
  assert.match(activityMemory, /data-memory-session="sync%2Frecent"/,
    'each memory change carries a stable deep-link session identifier');
  assert.deepStrictEqual(
    JSON.parse(JSON.stringify(context.memoryChangesForItem(memorySession, 'demo/decision'))),
    {
      entity: { name: 'demo/decision', entityType: 'decision' },
      observations: [{ name: 'demo/decision', text: 'Use <Postgres> for durable storage' }],
      relations: [{ from: 'demo/decision', to: 'demo/database', relationType: 'depends-on' }],
    },
    'memory highlighting resolves the exact item, observations, and relationships from a sync',
  );
  assert.match(context.sessionSummary(memorySession), /3 memory additions/,
    'activity rows surface memory-only syncs without calling them no-op sessions');
  assert.strictEqual(
    context.modelFingerprint({ remote: { status: 'ready', lastActivityAt: 'first' } }),
    context.modelFingerprint({ remote: { status: 'ready', lastActivityAt: 'second' } }),
    'heartbeat-only timestamps do not trigger a destructive full rerender',
  );

  const firstSelection = context.chooseFolder();
  const repeatedSelections = Array.from({ length: 8 }, () => context.chooseFolder());

  assert.strictEqual(fetchCalls, 1, 'rapid clicks must start only one folder selection request');
  assert.strictEqual(folderSwitcher.disabled, true, 'folder switcher is disabled while the picker is open');
  assert.strictEqual(chooseButton.disabled, true, 'choose-folder buttons are disabled while the picker is open');
  assert.strictEqual(folderSwitcher.attributes.get('aria-busy'), 'true');

  finishRequest({
    ok: false,
    status: 409,
    json: async () => ({ error: 'Folder selection was cancelled' }),
  });
  await Promise.all([firstSelection, ...repeatedSelections]);

  assert.strictEqual(folderSwitcher.disabled, false, 'folder switcher recovers after cancellation');
  assert.strictEqual(chooseButton.disabled, false, 'choose-folder buttons recover after cancellation');
  assert.strictEqual(folderSwitcher.attributes.has('aria-busy'), false);
  console.log('UI INTEGRATION PASS: folder selection is single-flight during rapid clicks.');
})().catch((error) => {
  console.error('UI INTEGRATION FAIL:', error);
  process.exitCode = 1;
});
