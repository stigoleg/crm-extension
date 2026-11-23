'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const constantsSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'shared', 'constants.js'), 'utf8');
const discoverySrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'shared', 'discovery-storage.js'), 'utf8');

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

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`);
  }
}

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function createChromeStub(initialLocal = {}) {
  const localStore = clone(initialLocal);
  const syncStore = {};
  const listeners = new Set();

  return {
    chrome: {
      storage: {
        local: {
          async get(key) {
            if (Array.isArray(key)) {
              const out = {};
              key.forEach((entry) => { out[entry] = clone(localStore[entry]); });
              return out;
            }
            return { [key]: clone(localStore[key]) };
          },
          async set(entries) {
            const changes = {};
            for (const [key, value] of Object.entries(entries || {})) {
              changes[key] = {
                oldValue: clone(localStore[key]),
                newValue: clone(value)
              };
              localStore[key] = clone(value);
            }
            listeners.forEach((listener) => listener(changes, 'local'));
          }
        },
        sync: {
          async get() {
            return clone(syncStore);
          },
          async set(entries) {
            Object.assign(syncStore, clone(entries));
            listeners.forEach((listener) => listener({}, 'sync'));
          }
        },
        onChanged: {
          addListener(listener) {
            listeners.add(listener);
          },
          removeListener(listener) {
            listeners.delete(listener);
          }
        }
      }
    },
    localStore,
    syncStore
  };
}

function loadDiscoveryStore(fakeChrome) {
  const context = {
    console,
    chrome: fakeChrome,
    self: {
      SNCRM: {
        log: {
          make() {
            return {
              debug() {},
              info() {},
              warn() {},
              error() {}
            };
          }
        },
        fieldRegistry: {
          detectedKeyFor(serviceNowName) {
            return `detected:${serviceNowName}`;
          },
          internalCompanionBaseName(serviceNowName) {
            const name = String(serviceNowName || '').trim();
            if (!name || name === '_input') return '';
            if (name.endsWith('_input') && name.length > '_input'.length) return name.slice(0, -'_input'.length);
            if (name.endsWith('-date') && name.length > '-date'.length) return name.slice(0, -'-date'.length);
            return '';
          },
          isInternalDiscoveryNoiseName(serviceNowName) {
            const name = String(serviceNowName || '').trim();
            if (!name) return false;
            if (name === '_input') return true;
            return Boolean(this.internalCompanionBaseName(name));
          },
          friendlyDetectedLabel(serviceNowName) {
            return String(serviceNowName || '')
              .replace(/[_-]+/g, ' ')
              .replace(/\b\w/g, (ch) => ch.toUpperCase());
          },
          hasStaticField(serviceNowName) {
            return [
              'account',
              'close_date',
              'due_date',
              'apps_client_developer',
              'apps_market_offering',
              'apps_opportunity_manager',
              'advisory_bid_manager'
            ].includes(serviceNowName);
          }
        }
      }
    }
  };
  vm.createContext(context);
  vm.runInContext(constantsSrc, context);
  vm.runInContext(discoverySrc, context);
  return context.self.SNCRM.discoveryStore;
}

async function run() {
  console.log('discovery storage');

  test('merge persists local discovery metadata without touching sync settings', async () => {
    const stub = createChromeStub();
    const discoveryStore = loadDiscoveryStore(stub.chrome);

    const merged = await discoveryStore.merge([
      {
        serviceNowName: 'partner_focus',
        label: 'Partner Focus',
        group: 'Opportunity Information',
        renderAs: 'text',
        reason: 'new-field'
      }
    ]);

    assertEqual(merged.length, 1, 'expected one stored discovery');
    assertEqual(merged[0].key, 'detected:partner_focus', 'expected detected keys to be generated from the ServiceNow field name');
    assertEqual(merged[0].group, 'Opportunity Information', 'expected the detected field section to be preserved in local storage');
    assertEqual(stub.syncStore['sncrm.discovery.v1'], undefined, 'expected sync storage to stay untouched');
    assert(Array.isArray(stub.localStore['sncrm.discovery.v1']), 'expected discovery metadata to persist in local storage only');
  });

  test('merge removes resolved fields unless the detected key is still pinned', async () => {
    const stub = createChromeStub({
      'sncrm.discovery.v1': [
        {
          key: 'detected:legacy_account',
          serviceNowName: 'legacy_account',
          label: 'Account',
          group: 'Opportunity Information',
          renderAs: 'text',
          reason: 'name-change',
          matchedRegistryKey: 'account',
          firstSeenAt: 1,
          lastSeenAt: 2
        },
        {
          key: 'detected:new_field',
          serviceNowName: 'new_field',
          label: 'New Field',
          group: 'Description',
          renderAs: 'text',
          reason: 'new-field',
          firstSeenAt: 3,
          lastSeenAt: 4
        }
      ]
    });
    const discoveryStore = loadDiscoveryStore(stub.chrome);

    const merged = await discoveryStore.merge([], {
      resolvedServiceNowNames: ['legacy_account', 'new_field'],
      keepDetectedKeys: new Set(['detected:new_field'])
    });

    assertEqual(merged.length, 1, 'expected resolved unpinned discoveries to be removed');
    assertEqual(merged[0].serviceNowName, 'new_field', 'expected pinned detected keys to survive resolution cleanup');
  });

  test('onChange reacts only to local discovery updates', async () => {
    const stub = createChromeStub();
    const discoveryStore = loadDiscoveryStore(stub.chrome);
    const seen = [];
    const unsubscribe = discoveryStore.onChange((fields) => {
      seen.push(fields.map((field) => field.serviceNowName).join(','));
    });

    await stub.chrome.storage.sync.set({ other: true });
    assertEqual(seen.length, 0, 'expected sync updates to be ignored');

    await discoveryStore.merge([
      {
        serviceNowName: 'engagement_type',
        label: 'Engagement Type',
        group: 'Opportunity Information',
        renderAs: 'text',
        reason: 'new-field'
      }
    ]);

    assertEqual(seen.length, 1, 'expected local discovery updates to notify listeners');
    assertEqual(seen[0], 'engagement_type', 'expected onChange to emit the normalized local discovery list');

    unsubscribe();
  });

  test('merge persists known-field entries with a plain key and keeps the detected group', async () => {
    const stub = createChromeStub();
    const discoveryStore = loadDiscoveryStore(stub.chrome);

    await discoveryStore.merge([
      {
        key: 'account',
        serviceNowName: 'account',
        label: 'Account',
        group: 'Deal Team',
        renderAs: 'text',
        reason: 'known',
        matchedRegistryKey: 'account'
      }
    ]);
    const remerged = await discoveryStore.merge([
      {
        key: 'account',
        serviceNowName: 'account',
        label: 'Account',
        group: 'Core Team',
        renderAs: 'text',
        reason: 'known',
        matchedRegistryKey: 'account'
      }
    ]);

    assertEqual(remerged.length, 1, 'expected one stored known entry across merges');
    assertEqual(remerged[0].key, 'account', 'expected known entries to keep their plain static key');
    assertEqual(remerged[0].reason, 'known', 'expected the reason to be preserved');
    assertEqual(remerged[0].group, 'Core Team', 'expected re-detection to update the group');
    assertEqual(remerged[0].matchedRegistryKey, 'account', 'expected the matched registry key to be preserved');
  });

  test('get returns persisted known entries for the options page', async () => {
    const stub = createChromeStub({
      'sncrm.discovery.v1': [
        {
          key: 'account',
          serviceNowName: 'account',
          label: 'Account',
          group: 'Deal Team',
          renderAs: 'text',
          reason: 'known',
          matchedRegistryKey: 'account',
          firstSeenAt: 1,
          lastSeenAt: 1
        }
      ]
    });
    const discoveryStore = loadDiscoveryStore(stub.chrome);

    const fields = await discoveryStore.get();

    assertEqual(fields.length, 1, 'expected the known entry to be returned');
    assertEqual(fields[0].key, 'account', 'expected the known entry to keep its plain key');
    assertEqual(fields[0].group, 'Deal Team', 'expected the detected group to survive a read round-trip');
  });

  test('get filters persisted *_input companions when the base field already exists in the registry', async () => {
    const stub = createChromeStub({
      'sncrm.discovery.v1': [
        {
          key: 'detected:apps_client_developer_input',
          serviceNowName: 'apps_client_developer_input',
          label: 'Apps Client Developer Input',
          group: 'APPS Status',
          renderAs: 'text',
          reason: 'new-field',
          firstSeenAt: 1,
          lastSeenAt: 1
        },
        {
          key: 'detected:partner_focus',
          serviceNowName: 'partner_focus',
          label: 'Partner Focus',
          group: 'Opportunity Information',
          renderAs: 'text',
          reason: 'new-field',
          firstSeenAt: 2,
          lastSeenAt: 2
        }
      ]
    });
    const discoveryStore = loadDiscoveryStore(stub.chrome);

    const fields = await discoveryStore.get();

    assertEqual(fields.length, 1, 'expected persisted internal *_input companions to be filtered out on read');
    assertEqual(fields[0].serviceNowName, 'partner_focus', 'expected legitimate discoveries to remain visible');
  });

  test('get filters persisted -date companions and bare _input noise names', async () => {
    const stub = createChromeStub({
      'sncrm.discovery.v1': [
        {
          key: 'detected:due_date-date',
          serviceNowName: 'due_date-date',
          label: 'Due Date',
          group: 'Opportunity Information',
          renderAs: 'date',
          reason: 'name-change',
          firstSeenAt: 1,
          lastSeenAt: 1
        },
        {
          key: 'detected:_input',
          serviceNowName: '_input',
          label: 'Input',
          group: 'Opportunity Information',
          renderAs: 'text',
          reason: 'new-field',
          firstSeenAt: 2,
          lastSeenAt: 2
        },
        {
          key: 'detected:partner_focus',
          serviceNowName: 'partner_focus',
          label: 'Partner Focus',
          group: 'Opportunity Information',
          renderAs: 'text',
          reason: 'new-field',
          firstSeenAt: 3,
          lastSeenAt: 3
        }
      ]
    });
    const discoveryStore = loadDiscoveryStore(stub.chrome);

    const fields = await discoveryStore.get();

    assertEqual(fields.length, 1, 'expected persisted -date companions and bare _input names to be filtered out on read');
    assertEqual(fields[0].serviceNowName, 'partner_focus', 'expected legitimate discoveries to remain after filtering internal control names');
  });

  await Promise.all(pending);
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
