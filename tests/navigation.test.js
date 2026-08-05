'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'content', 'navigation.js'), 'utf8');

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

function createNavigationEnv({ withNavigationApi = false } = {}) {
  const windowListeners = new Map();
  const navigationListeners = new Map();
  const intervals = new Map();
  const timeouts = new Map();
  const changes = [];
  let nextIntervalId = 1;
  let nextTimeoutId = 1;

  const location = { href: 'https://example.com/start' };
  const history = {
    pushState(_state, _title, url) {
      if (url) location.href = new URL(url, location.href).href;
      return null;
    },
    replaceState(_state, _title, url) {
      if (url) location.href = new URL(url, location.href).href;
      return null;
    }
  };

  const window = {
    location,
    history,
    addEventListener(type, listener) {
      windowListeners.set(type, listener);
    },
    removeEventListener(type, listener) {
      if (windowListeners.get(type) === listener) windowListeners.delete(type);
    },
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
      constants: {
        NAV_POLL_MS: 25
      }
    }
  };
  window.window = window;
  if (withNavigationApi) {
    window.navigation = {
      addEventListener(type, listener) {
        navigationListeners.set(type, listener);
      },
      removeEventListener(type, listener) {
        if (navigationListeners.get(type) === listener) navigationListeners.delete(type);
      }
    };
  }

  const context = {
    console,
    window,
    self: window,
    globalThis: window,
    location,
    history,
    setInterval(fn, delay) {
      const id = nextIntervalId++;
      intervals.set(id, { fn, delay });
      return id;
    },
    clearInterval(id) {
      intervals.delete(id);
    },
    setTimeout(fn, delay) {
      const id = nextTimeoutId++;
      timeouts.set(id, { fn, delay });
      return id;
    },
    clearTimeout(id) {
      timeouts.delete(id);
    }
  };

  vm.createContext(context);
  vm.runInContext(src, context);

  const stop = window.SNCRM.navigation.start((now, prev) => {
    changes.push({ now, prev });
  });

  return {
    stop,
    changes,
    intervals,
    navigationListeners,
    timeouts,
    windowListeners,
    window
  };
}

async function run() {
  console.log('navigation fallback windows');

  test('navigation polling stays dormant until an explicit navigation signal arrives', async () => {
    const env = createNavigationEnv();

    assertEqual(env.intervals.size, 0, 'expected no permanent polling interval at startup');

    env.window.history.pushState({}, '', '/record/next');

    assertEqual(env.changes.length, 1, 'expected pushState to emit one navigation change');
    assertEqual(env.changes[0].prev, 'https://example.com/start', 'expected the previous URL to be tracked');
    assertEqual(env.changes[0].now, 'https://example.com/record/next', 'expected the new URL to be reported');
    assertEqual(env.intervals.size, 1, 'expected a short-lived poll interval after pushState');
    assertEqual(Array.from(env.intervals.values())[0].delay, 25, 'expected fallback polling to use NAV_POLL_MS');
    assertEqual(Array.from(env.timeouts.values())[0].delay, 2000, 'expected the poll window to auto-stop after 2s');

    const [timeoutId, timeout] = Array.from(env.timeouts.entries())[0];
    env.timeouts.delete(timeoutId);
    timeout.fn();
    assertEqual(env.intervals.size, 0, 'expected the fallback poll interval to stop after the window expires');

    env.stop();
  });

  test('navigation API events drive URL changes without requiring the permanent poll', async () => {
    const env = createNavigationEnv({ withNavigationApi: true });
    const navigate = env.navigationListeners.get('navigate');
    const nextUrl = 'https://example.com/record/from-navigation-api';

    assert(navigate, 'expected the navigation module to subscribe to window.navigation');
    assertEqual(env.intervals.size, 0, 'expected no poll interval before any navigation event');

    navigate({
      destination: {
        url: nextUrl
      }
    });

    env.window.location.href = nextUrl;
    const emitTimeout = Array.from(env.timeouts.entries()).find(([, timer]) => timer.delay === 0);
    assert(emitTimeout, 'expected the navigation API path to schedule an immediate URL check');
    const [emitTimeoutId, emitTimer] = emitTimeout;
    env.timeouts.delete(emitTimeoutId);
    emitTimer.fn();

    assertEqual(env.changes.length, 1, 'expected the navigation API to trigger one URL change');
    assertEqual(
      env.changes[0].now,
      nextUrl,
      'expected the navigation API path to pick up the committed location URL'
    );
    assertEqual(env.intervals.size, 1, 'expected the navigation API path to arm the short fallback poll window');

    env.stop();
    assert(!env.navigationListeners.has('navigate'), 'expected stop() to remove the navigation API listener');
  });

  test('stopping an older watcher does not remove a newer history patch', async () => {
    const env = createNavigationEnv();
    const secondaryChanges = [];
    const stopPrimary = env.stop;
    const stopSecondary = env.window.SNCRM.navigation.start((now, prev) => {
      secondaryChanges.push({ now, prev });
    });

    stopPrimary();
    env.window.history.pushState({}, '', '/record/from-secondary');

    assertEqual(secondaryChanges.length, 1, 'expected the newer watcher to keep receiving pushState events');
    assertEqual(
      secondaryChanges[0].now,
      'https://example.com/record/from-secondary',
      'expected the newer watcher to observe the committed URL after the older stop() runs'
    );

    stopSecondary();
  });

  await Promise.all(pending);
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
