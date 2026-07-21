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
  assert.doesNotMatch(styles, /@media \(max-width: 900px\)[\s\S]*?\.inspector\s*\{\s*display:\s*none/,
    'the narrow layout does not hide device and checkpoint actions');
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
