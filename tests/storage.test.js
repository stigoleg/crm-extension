'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'shared', 'storage.js'), 'utf8');

let passed = 0;
let failed = 0;
const pending = [];

function test(name, fn) {
  const run = Promise.resolve()
    .then(fn)
    .then(() => {
      passed++;
      console.log(`  ok  ${name}`);
    })
    .catch((err) => {
      failed++;
      console.log(`  FAIL ${name}`);
      console.log(`       ${err.message}`);
      if (err.stack) console.log(err.stack.split('\n').slice(1).join('\n'));
    });
  pending.push(run);
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`);
  }
}

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function deferred() {
  let resolve;
  const promise = new Promise((res) => { resolve = res; });
  return { promise, resolve };
}

function createChromeStub(initial = {}) {
  const store = clone(initial);
  const listeners = new Set();
  let pausedGet = null;

  function readKeys(keys) {
    if (keys == null) return clone(store);
    const keyList = Array.isArray(keys)
      ? keys
      : typeof keys === 'string'
        ? [keys]
        : Object.keys(keys);
    const out = {};
    for (const key of keyList) {
      if (Object.prototype.hasOwnProperty.call(store, key)) out[key] = clone(store[key]);
      else if (keys && !Array.isArray(keys) && typeof keys === 'object') out[key] = clone(keys[key]);
    }
    return out;
  }

  return {
    chrome: {
      storage: {
        sync: {
          async get(keys) {
            const snapshot = readKeys(keys);
            if (pausedGet) {
              const gate = pausedGet;
              pausedGet = null;
              await gate.promise;
            }
            return snapshot;
          },
          async set(entries) {
            const changes = {};
            for (const [key, value] of Object.entries(entries || {})) {
              changes[key] = {
                oldValue: clone(store[key]),
                newValue: clone(value)
              };
              store[key] = clone(value);
            }
            if (Object.keys(changes).length > 0) {
              listeners.forEach((listener) => listener(changes, 'sync'));
            }
          }
        },
        onChanged: {
          addListener(listener) { listeners.add(listener); },
          removeListener(listener) { listeners.delete(listener); }
        }
      }
    },
    pauseNextGet() {
      pausedGet = deferred();
      return pausedGet;
    }
  };
}

function loadStorage(fakeChrome) {
  const context = {
    console,
    chrome: fakeChrome,
    self: {
      SNCRM: {
        constants: {
          STORAGE_KEY: 'sncrm.settings.v1',
          SETTINGS_VERSION: 1
        },
        log: {
          make() {
            return {
              debug() {},
              info() {},
              warn() {},
              error() {}
            };
          }
        }
      }
    }
  };
  vm.createContext(context);
  vm.runInContext(src, context);
  return context.self.SNCRM.storage;
}

async function run() {
  console.log('storage merge safety');

  test('concurrent writes to different settings keep both changes', async () => {
    const stub = createChromeStub();
    const storage = loadStorage(stub.chrome);

    const gate = stub.pauseNextGet();
    const optionsSave = storage.set({ selectedFields: ['account', 'stage'] });
    await Promise.resolve();

    const popupSave = await storage.set({ debug: true });
    assertEqual(popupSave.debug, true, 'popup save should persist the debug toggle');

    gate.resolve();
    const optionsResult = await optionsSave;
    assertEqual(optionsResult.debug, true, 'late options save must not overwrite popup changes');
    assertEqual(optionsResult.selectedFields.join(','), 'account,stage', 'options save should persist its field order');

    const merged = await storage.get();
    assertEqual(merged.debug, true, 'final stored settings should keep popup changes');
    assertEqual(merged.selectedFields.join(','), 'account,stage', 'final stored settings should keep options changes');
  });

  test('legacy selectedFields migrate into fieldLayout with the new 3-column defaults', async () => {
    const stub = createChromeStub({
      'sncrm.settings.v1.selectedFields': ['account', 'description']
    });
    const storage = loadStorage(stub.chrome);

    const settings = await storage.get();

    assertEqual(settings.columns, 3, 'expected the default layout to use three columns');
    assertEqual(settings.enhanceOriginalDescription, true, 'expected original description enhancement to default on');
    assertEqual(settings.largeOriginalDescription, true, 'expected large original description mode to default on');
    assertEqual(settings.originalDescriptionHeight, null, 'expected original description preferred height to default to null');
    assertEqual(settings.selectedFields.join(','), 'account,description', 'expected selected fields to survive migration');
    assertEqual(settings.fieldLayout.length, 2, 'expected selected fields to become layout items');
    assertEqual(settings.fieldLayout[0].type, 'field', 'expected migrated layout entries to be field items');
    assertEqual(settings.fieldLayout[0].key, 'account', 'expected the first field to keep its position');
    assertEqual(settings.fieldLayout[0].span, 1, 'regular fields should default to one column');
    assertEqual(settings.fieldLayout[1].key, 'description', 'expected markdown fields to stay selected');
    assertEqual(settings.fieldLayout[1].span, 3, 'markdown fields should default to full-width in a 3-column layout');
  });

  test('manual original Description height below 220 survives normalization', async () => {
    const stub = createChromeStub({
      'sncrm.settings.v1.originalDescriptionHeight': 156
    });
    const storage = loadStorage(stub.chrome);

    const settings = await storage.get();

    assertEqual(settings.originalDescriptionHeight, 156, 'expected native manual resize heights below 220 to remain persisted');
  });

  test('descriptionCopyFormat defaults to raw markdown and rejects unknown values', async () => {
    const stub = createChromeStub();
    const storage = loadStorage(stub.chrome);

    const defaults = await storage.get();
    assertEqual(defaults.descriptionCopyFormat, 'markdown', 'expected raw markdown to be the default copy format');

    const stored = await storage.set({ descriptionCopyFormat: 'rich' });
    assertEqual(stored.descriptionCopyFormat, 'rich', 'expected the rich format to be accepted');

    const bogus = await storage.set({ descriptionCopyFormat: 'pdf' });
    assertEqual(bogus.descriptionCopyFormat, 'markdown', 'expected unknown copy formats to fall back to the default');
  });

  test('extension context invalidation during read falls back to defaults once without repeated storage calls', async () => {
    let getCalls = 0;
    const storage = loadStorage({
      storage: {
        sync: {
          async get() {
            getCalls++;
            throw new Error('Extension context invalidated.');
          },
          async set() {}
        },
        onChanged: {
          addListener() {},
          removeListener() {}
        }
      }
    });

    const first = await storage.get();
    const second = await storage.get();

    assertEqual(first.enabled, true, 'expected invalidated reads to fall back to defaults');
    assertEqual(second.enabled, true, 'expected subsequent reads to keep using defaults');
    assertEqual(getCalls, 1, 'expected storage reads to stop retrying once the context is invalidated');
  });

  test('extension context invalidation during write returns merged settings without throwing', async () => {
    let setCalls = 0;
    const storage = loadStorage({
      storage: {
        sync: {
          async get() {
            return {};
          },
          async set() {
            setCalls++;
            throw new Error('Extension context invalidated.');
          }
        },
        onChanged: {
          addListener() {},
          removeListener() {}
        }
      }
    });

    const saved = await storage.set({ debug: true });
    const after = await storage.get();

    assertEqual(saved.debug, true, 'expected invalidated writes to return the merged in-memory settings');
    assertEqual(after.enabled, true, 'expected later reads to fall back to defaults after invalidation');
    assertEqual(setCalls, 1, 'expected only the first write attempt to hit chrome.storage after invalidation');
  });

  await Promise.all(pending);
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
