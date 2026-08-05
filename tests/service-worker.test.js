'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'background', 'service-worker.js'), 'utf8');
const manifest = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'manifest.json'), 'utf8')
);

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

function flush() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function createEvent() {
  const listeners = [];
  return {
    listeners,
    addListener(listener) {
      listeners.push(listener);
    }
  };
}

function makeChrome(overrides = {}) {
  const tabsOnUpdated = createEvent();
  const tabsOnActivated = createEvent();
  const tabsOnRemoved = createEvent();
  const runtimeOnInstalled = createEvent();
  const runtimeOnMessage = createEvent();
  const historyStateUpdated = createEvent();
  const committed = createEvent();

  const chrome = {
    action: {
      setBadgeBackgroundColor() {},
      setBadgeText() {}
    },
    tabs: {
      onUpdated: tabsOnUpdated,
      onActivated: tabsOnActivated,
      onRemoved: tabsOnRemoved,
      async sendMessage() {
        throw new Error('no receiver');
      },
      async get() {
        return { id: 1, status: 'complete', url: '' };
      },
      async query() {
        return [];
      },
      create(_opts, cb) {
        if (cb) cb();
      }
    },
    runtime: {
      onInstalled: runtimeOnInstalled,
      onMessage: runtimeOnMessage,
      getManifest() {
        return manifest;
      },
      openOptionsPage(cb) {
        if (cb) cb();
      },
      getURL(rel) {
        return `chrome-extension://test/${rel}`;
      }
    },
    scripting: {
      async insertCSS() {},
      async executeScript() {}
    },
    webNavigation: {
      onCommitted: committed,
      onHistoryStateUpdated: historyStateUpdated
    }
  };

  Object.assign(chrome.action, overrides.action || {});
  Object.assign(chrome.tabs, overrides.tabs || {});
  Object.assign(chrome.runtime, overrides.runtime || {});
  Object.assign(chrome.scripting, overrides.scripting || {});
  if (overrides.webNavigation) {
    Object.assign(chrome.webNavigation, overrides.webNavigation);
  }

  return {
    chrome,
    events: {
      tabsOnUpdated,
      tabsOnActivated,
      tabsOnRemoved,
      runtimeOnInstalled,
      runtimeOnMessage,
      historyStateUpdated,
      committed
    }
  };
}

function loadServiceWorker(chrome) {
  const context = {
    console,
    chrome,
    importScripts() {},
    self: {
      SNCRM: {
        constants: {
          MSG: {
            GET_STATUS: 'sncrm/get-status',
            OPEN_OPTIONS: 'sncrm/open-options'
          }
        },
        url: {
          isSupportedUrl(raw) {
            try {
              const parsed = new URL(raw);
              return parsed.protocol === 'https:' &&
                parsed.pathname.startsWith('/x/ssasi/crm/record/x_ssasi_crm_opportunity/');
            } catch {
              return false;
            }
          }
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
}

async function run() {
  console.log('service worker activation fallback');

  test('history-state navigation into a supported opportunity injects the fallback content script once', async () => {
    const insertCssCalls = [];
    const executeCalls = [];
    const { chrome, events } = makeChrome({
      tabs: {
        async sendMessage() {
          throw new Error('Could not establish connection');
        }
      },
      scripting: {
        async insertCSS(details) {
          insertCssCalls.push(details);
        },
        async executeScript(details) {
          executeCalls.push(details);
        }
      }
    });

    loadServiceWorker(chrome);
    const [listener] = events.historyStateUpdated.listeners;
    assert(listener, 'expected the worker to register a history-state listener');

    listener({
      tabId: 17,
      frameId: 0,
      url: 'https://thehub.soprasteria.com/x/ssasi/crm/record/x_ssasi_crm_opportunity/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    });
    await flush();
    await flush();

    assertEqual(insertCssCalls.length, 1, 'expected one CSS injection fallback');
    assertEqual(executeCalls.length, 1, 'expected one script injection fallback');
    assertEqual(insertCssCalls[0].target.tabId, 17, 'expected CSS injection into the supported tab');
    assertEqual(executeCalls[0].target.tabId, 17, 'expected script injection into the supported tab');
    assert(
      JSON.stringify(insertCssCalls[0].files) === JSON.stringify(manifest.content_scripts[0].css),
      'expected the fallback CSS files to come from the manifest content script entry'
    );
    assert(
      JSON.stringify(executeCalls[0].files) === JSON.stringify(manifest.content_scripts[0].js),
      'expected the fallback script files to come from the manifest content script entry'
    );
  });

  test('complete-page updates do not reinject when the content script is already present', async () => {
    let executeCalls = 0;
    const { chrome, events } = makeChrome({
      tabs: {
        async sendMessage() {
          return { ok: true, state: 'mounted' };
        }
      },
      scripting: {
        async insertCSS() {
          throw new Error('should not inject CSS when content script is already present');
        },
        async executeScript() {
          executeCalls++;
        }
      }
    });

    loadServiceWorker(chrome);
    const [listener] = events.tabsOnUpdated.listeners;
    assert(listener, 'expected the worker to register a tab-update listener');

    listener(21, { status: 'complete' }, {
      id: 21,
      status: 'complete',
      url: 'https://thehub.soprasteria.com/x/ssasi/crm/record/x_ssasi_crm_opportunity/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
    });
    await flush();
    await flush();

    assertEqual(executeCalls, 0, 'expected no fallback injection when the content script already responds');
  });

  test('confirmed tabs skip repeat complete-event status probes on the same document', async () => {
    let sendMessageCalls = 0;
    const { chrome, events } = makeChrome({
      tabs: {
        async sendMessage() {
          sendMessageCalls++;
          return { ok: true, state: 'mounted' };
        }
      },
      scripting: {
        async insertCSS() {
          throw new Error('should not inject CSS when the content script is already confirmed');
        },
        async executeScript() {
          throw new Error('should not inject JS when the content script is already confirmed');
        }
      }
    });

    loadServiceWorker(chrome);
    const [listener] = events.tabsOnUpdated.listeners;
    assert(listener, 'expected the worker to register a tab-update listener');

    const tab = {
      id: 21,
      status: 'complete',
      url: 'https://thehub.soprasteria.com/x/ssasi/crm/record/x_ssasi_crm_opportunity/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
    };
    listener(21, { status: 'complete' }, tab);
    await flush();
    await flush();

    listener(21, { status: 'complete' }, tab);
    await flush();
    await flush();

    assertEqual(sendMessageCalls, 1, 'expected the worker to cache confirmed content-script tabs');
  });

  test('top-level committed navigations clear the confirmed-tab cache for the next document', async () => {
    let sendMessageCalls = 0;
    const { chrome, events } = makeChrome({
      tabs: {
        async sendMessage() {
          sendMessageCalls++;
          return { ok: true, state: 'mounted' };
        }
      },
      scripting: {
        async insertCSS() {
          throw new Error('should not inject CSS when the content script responds');
        },
        async executeScript() {
          throw new Error('should not inject JS when the content script responds');
        }
      }
    });

    loadServiceWorker(chrome);
    const [updatedListener] = events.tabsOnUpdated.listeners;
    const [committedListener] = events.committed.listeners;
    assert(updatedListener, 'expected the worker to register a tab-update listener');
    assert(committedListener, 'expected the worker to register a committed-navigation listener');

    updatedListener(9, { status: 'complete' }, {
      id: 9,
      status: 'complete',
      url: 'https://thehub.soprasteria.com/x/ssasi/crm/record/x_ssasi_crm_opportunity/cccccccccccccccccccccccccccccccc'
    });
    await flush();
    await flush();

    committedListener({
      tabId: 9,
      frameId: 0,
      url: 'https://thehub.soprasteria.com/x/ssasi/crm/record/x_ssasi_crm_opportunity/dddddddddddddddddddddddddddddddd'
    });

    updatedListener(9, { status: 'complete' }, {
      id: 9,
      status: 'complete',
      url: 'https://thehub.soprasteria.com/x/ssasi/crm/record/x_ssasi_crm_opportunity/dddddddddddddddddddddddddddddddd'
    });
    await flush();
    await flush();

    assertEqual(sendMessageCalls, 2, 'expected committed navigations to force a fresh content-script probe');
  });

  await Promise.all(pending);
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
