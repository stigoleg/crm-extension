'use strict';

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

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

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function installDomStubs(window) {
  window.self = window;
  if (!window.CSS) window.CSS = {};
  if (!window.CSS.escape) {
    window.CSS.escape = (value) => String(value).replace(/["\\]/g, '\\$&');
  }
  if (!Object.getOwnPropertyDescriptor(window.HTMLElement.prototype, 'innerText')) {
    Object.defineProperty(window.HTMLElement.prototype, 'innerText', {
      configurable: true,
      get() { return this.textContent; },
      set(value) { this.textContent = value; }
    });
  }
  window.requestIdleCallback = (callback) => window.setTimeout(() => callback({
    didTimeout: false,
    timeRemaining() { return 1; }
  }), 0);
  window.cancelIdleCallback = (id) => window.clearTimeout(id);
  window.Element.prototype.getBoundingClientRect = function getBoundingClientRect() {
    return { width: 120, height: 24, top: 0, right: 120, bottom: 24, left: 0 };
  };
}

function makeDom(html, url) {
  const dom = new JSDOM(html, {
    runScripts: 'outside-only',
    url
  });
  installDomStubs(dom.window);
  return dom;
}

function loadScript(window, relPath) {
  const src = fs.readFileSync(path.join(__dirname, '..', relPath), 'utf8');
  window.eval(src);
}

function makeLog() {
  return {
    debugEnabled: false,
    setDebug(value) {
      this.debugEnabled = Boolean(value);
    },
    make() {
      return {
        debug() {},
        info() {},
        warn() {},
        error() {}
      };
    }
  };
}

function parseRecordId(url) {
  const u = new URL(url, 'https://thehub.soprasteria.com');
  const prefix = '/x/ssasi/crm/record/x_ssasi_crm_opportunity/';
  if (!u.pathname.startsWith(prefix)) return null;
  const tail = u.pathname.slice(prefix.length);
  return tail.split('/', 1)[0] || null;
}

function loadExtractorHarness(window) {
  window.SNCRM = { log: makeLog() };
  loadScript(window, 'src/shared/dates.js');
  loadScript(window, 'src/content/field-registry.js');
  loadScript(window, 'src/content/extractors.js');
}

async function run() {
  console.log('field discovery');

  test('discoverFields finds brand-new fields and infers link rendering conservatively', async () => {
    const dom = makeDom(`
      <body>
        <div id="scope">
          <span class="sn-section-header collapsable" aria-expanded="true">Opportunity Information</span>
          <div class="field">
            <label for="partner_focus">Partner Focus</label>
            <input id="partner_focus" name="partner_focus" value="https://example.com/partner-focus">
          </div>
        </div>
      </body>
    `, 'https://thehub.soprasteria.com/x/ssasi/crm/record/x_ssasi_crm_opportunity/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    const { window } = dom;

    loadExtractorHarness(window);

    const { discoverFields } = window.SNCRM.extractors;
    const result = discoverFields(window.document.getElementById('scope'));

    assertEqual(result.discoveries.length, 1, 'expected one discovered field');
    assertEqual(result.discoveries[0].key, 'detected:partner_focus', 'expected discovered keys to use the detected: prefix');
    assertEqual(result.discoveries[0].label, 'Partner Focus', 'expected the discovered field label to come from the DOM');
    assertEqual(result.discoveries[0].group, 'Opportunity Information', 'expected discovered fields to keep the ServiceNow section heading they belong to');
    assertEqual(result.discoveries[0].reason, 'new-field', 'expected unknown name + label pairs to register as new fields');
    assertEqual(result.discoveries[0].renderAs, 'link', 'expected URL-valued fields to infer link rendering');

    dom.window.close();
  });

  test('discoverFields classifies changed underlying field names and ignores label-only renames', async () => {
    const dom = makeDom(`
      <body>
        <div id="scope">
          <span class="sn-section-header collapsable" aria-expanded="true">Opportunity Information</span>
          <div class="field">
            <label for="legacy_account">Account</label>
            <input id="legacy_account" name="legacy_account" value="Acme">
          </div>
          <div class="field">
            <label for="account">Customer Account</label>
            <input id="account" name="account" value="Acme">
          </div>
        </div>
      </body>
    `, 'https://thehub.soprasteria.com/x/ssasi/crm/record/x_ssasi_crm_opportunity/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    const { window } = dom;

    loadExtractorHarness(window);

    const { discoverFields } = window.SNCRM.extractors;
    const result = discoverFields(window.document.getElementById('scope'));

    assertEqual(result.discoveries.length, 1, 'expected only the changed underlying field name to be surfaced');
    assertEqual(result.discoveries[0].serviceNowName, 'legacy_account', 'expected the unknown ServiceNow name to be reported');
    assertEqual(result.discoveries[0].group, 'Opportunity Information', 'expected name-changed fields to stay grouped under the detected ServiceNow section');
    assertEqual(result.discoveries[0].reason, 'name-change', 'expected matching a known static label to classify as a name change');
    assertEqual(result.discoveries[0].matchedRegistryKey, 'account', 'expected name changes to point back to the matched static field');
    assert(result.resolvedServiceNowNames.includes('account'), 'expected known field names to be marked as resolved even when their labels changed');

    dom.window.close();
  });

  test('discoverFields ignores internal companion *_input controls when the base field exists', async () => {
    const dom = makeDom(`
      <body>
        <div id="scope">
          <span class="sn-section-header collapsable" aria-expanded="true">Advisory Status</span>
          <div class="field">
            <label for="advisory_bid_manager_input">Advisory Bid Manager</label>
            <now-record-string name="advisory_bid_manager" value="Jane Doe"></now-record-string>
            <input id="advisory_bid_manager_input" name="advisory_bid_manager_input" value="Jane Doe">
          </div>
        </div>
      </body>
    `, 'https://thehub.soprasteria.com/x/ssasi/crm/record/x_ssasi_crm_opportunity/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    const { window } = dom;

    loadExtractorHarness(window);

    const { discoverFields } = window.SNCRM.extractors;
    const result = discoverFields(window.document.getElementById('scope'));

    assertEqual(result.discoveries.length, 0, 'expected internal *_input controls to be ignored when the base field already exists');
    assert(result.resolvedServiceNowNames.includes('advisory_bid_manager'), 'expected the base field itself to remain resolved as known');
    assert(result.resolvedServiceNowNames.includes('advisory_bid_manager_input'), 'expected ignored *_input companions to be marked resolved so stale local discoveries are cleaned up');

    dom.window.close();
  });

  test('discoverFields ignores internal -date companions and bare _input names', async () => {
    const dom = makeDom(`
      <body>
        <div id="scope">
          <span class="sn-section-header collapsable" aria-expanded="true">Opportunity Information</span>
          <div class="field">
            <label for="due_date-date">Due Date</label>
            <now-record-string name="due_date" value="30.04.2026"></now-record-string>
            <input id="due_date-date" name="due_date-date" value="30.04.2026">
          </div>
          <div class="field">
            <label for="close_date-date">Close Date</label>
            <now-record-string name="close_date" value="01.05.2026"></now-record-string>
            <input id="close_date-date" name="close_date-date" value="01.05.2026">
          </div>
          <div class="field">
            <label for="_input">Input</label>
            <input id="_input" name="_input" value="">
          </div>
        </div>
      </body>
    `, 'https://thehub.soprasteria.com/x/ssasi/crm/record/x_ssasi_crm_opportunity/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    const { window } = dom;

    loadExtractorHarness(window);

    const { discoverFields } = window.SNCRM.extractors;
    const result = discoverFields(window.document.getElementById('scope'));

    assertEqual(result.discoveries.length, 0, 'expected internal -date companions and bare _input names to be ignored');
    assert(result.resolvedServiceNowNames.includes('due_date-date'), 'expected ignored date companions to be marked resolved so stale local discoveries are cleaned up');
    assert(result.resolvedServiceNowNames.includes('close_date-date'), 'expected ignored date companions to be marked resolved so stale local discoveries are cleaned up');
    assert(result.resolvedServiceNowNames.includes('_input'), 'expected bare _input names to be marked resolved so stale local discoveries are cleaned up');

    dom.window.close();
  });

  test('discoverFields prefers labels whose tokens match the field name inside multi-field containers', async () => {
    const dom = makeDom(`
      <body>
        <div id="scope">
          <span class="sn-section-header collapsable" aria-expanded="true">Estimates</span>
          <div class="field-group">
            <span class="sn-form-label">Weighted Gross Amount TCV</span>
            <div class="value">100</div>
            <span class="sn-form-label">Yearly Estimated Value</span>
            <div class="value">200</div>
            <span class="sn-form-label">Estimated Value Sopra</span>
            <div class="value"><input name="estimated_value_sopra" value="300"></div>
          </div>
        </div>
      </body>
    `, 'https://thehub.soprasteria.com/x/ssasi/crm/record/x_ssasi_crm_opportunity/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    const { window } = dom;

    loadExtractorHarness(window);

    const { discoverFields } = window.SNCRM.extractors;
    const result = discoverFields(window.document.getElementById('scope'));

    assertEqual(result.discoveries.length, 0, 'expected known estimate fields to stop appearing as missing once added to the registry');

    dom.window.close();
  });

  test('discoverFields infers badge-list, date, and text fallback types', async () => {
    const dom = makeDom(`
      <body>
        <div id="scope">
          <span class="sn-section-header collapsable" aria-expanded="true">Opportunity Information</span>
          <div class="field">
            <label for="go_live_date">Go Live Date</label>
            <input id="go_live_date" name="go_live_date" value="30.04.2026">
          </div>
          <span class="sn-section-header collapsable" aria-expanded="true">Description</span>
          <div class="field">
            <span class="sn-form-label">Delivery Modes</span>
            <div name="delivery_modes">
              <span class="now-pill-button">Cloud</span>
              <span class="now-pill-button">Data</span>
            </div>
          </div>
          <div class="field">
            <label for="win_theme">Win Theme</label>
            <input id="win_theme" name="win_theme" value="Advisory">
          </div>
        </div>
      </body>
    `, 'https://thehub.soprasteria.com/x/ssasi/crm/record/x_ssasi_crm_opportunity/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    const { window } = dom;

    loadExtractorHarness(window);

    const { discoverFields } = window.SNCRM.extractors;
    const result = discoverFields(window.document.getElementById('scope'));
    const byName = Object.fromEntries(result.discoveries.map((field) => [field.serviceNowName, field]));

    assertEqual(byName.go_live_date.renderAs, 'date', 'expected parseable date fields with date-like labels to infer date rendering');
    assertEqual(byName.go_live_date.group, 'Opportunity Information', 'expected discovered fields to stay grouped under the active ServiceNow section');
    assertEqual(byName.delivery_modes.renderAs, 'badge-list', 'expected multiple pill badges to infer badge-list rendering');
    assertEqual(byName.delivery_modes.group, 'Description', 'expected later discovered fields to follow the most recent section heading');
    assertEqual(byName.win_theme.renderAs, 'text', 'expected unknown fields to fall back to text rendering');

    dom.window.close();
  });

  test('controller loads selected discovered fields before first render', async () => {
    const dom = makeDom(`
      <body>
        <div id="record">
          <div class="field">
            <label for="account">Account</label>
            <input id="account" name="account" value="Acme">
          </div>
          <div class="field">
            <label for="partner_focus">Partner Focus</label>
            <input id="partner_focus" name="partner_focus" value="Cloud">
          </div>
        </div>
      </body>
    `, 'https://thehub.soprasteria.com/x/ssasi/crm/record/x_ssasi_crm_opportunity/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    const { window } = dom;

    let settings = {
      enabled: true,
      debug: false,
      defaultCollapsed: false,
      columns: 2,
      autoExpandSections: true,
      panelHeightPercent: 50,
      panelFullHeight: false,
      descriptionAutoHeight: false,
      selectedFields: ['account', 'detected:partner_focus'],
      fieldLayout: [
        { type: 'field', key: 'account', span: 1 },
        { type: 'field', key: 'detected:partner_focus', span: 1 }
      ]
    };

    window.chrome = {
      runtime: {
        onMessage: {
          addListener() {}
        }
      }
    };

    window.SNCRM = {
      log: makeLog(),
      constants: {
        PANEL_ID: 'sncrm-overview-panel',
        MOUNT_DEBOUNCE_MS: 0,
        REFRESH_DEBOUNCE_MS: 0,
        HYDRATION_TIMEOUT_MS: 50,
        HYDRATION_POLL_MS: 5,
        HYDRATION_BACKOFF_MS: 25,
        MSG: {
          GET_STATUS: 'sncrm/get-status',
          REFRESH: 'sncrm/refresh',
          OPEN_OPTIONS: 'sncrm/open-options'
        }
      },
      url: {
        isSupportedUrl(url) {
          return /\/x\/ssasi\/crm\/record\/x_ssasi_crm_opportunity\//.test(url);
        },
        extractRecordId: parseRecordId
      },
      markdown: {
        render(value) {
          return String(value || '');
        }
      },
      storage: {
        async get() {
          return JSON.parse(JSON.stringify(settings));
        },
        async set(patch) {
          settings = { ...settings, ...patch };
          return JSON.parse(JSON.stringify(settings));
        },
        onChange() {
          return () => {};
        }
      },
      discoveryStore: {
        async get() {
          return [{
            key: 'detected:partner_focus',
            serviceNowName: 'partner_focus',
            label: 'Partner Focus',
            renderAs: 'text',
            reason: 'new-field',
            firstSeenAt: 1,
            lastSeenAt: 1
          }];
        },
        async merge(fields) {
          return fields;
        },
        onChange() {
          return () => {};
        }
      },
      navigation: {
        start() {
          return () => {};
        }
      },
      messages: {
        send() {
          return Promise.resolve({ ok: true });
        }
      },
      sectionExpander: {
        expandAll() {
          return 0;
        }
      }
    };

    loadScript(window, 'src/shared/dates.js');
    loadScript(window, 'src/content/field-registry.js');
    loadScript(window, 'src/content/extractors.js');
    loadScript(window, 'src/content/ui.js');
    loadScript(window, 'src/content/controller.js');

    await window.SNCRM.controller.init();
    await delay(30);

    const labels = Array.from(window.document.querySelectorAll('.sncrm-card-label')).map((node) => node.textContent.trim());
    const values = Array.from(window.document.querySelectorAll('.sncrm-card-value')).map((node) => node.textContent.trim());

    assert(labels.includes('Partner Focus'), 'expected discovered fields to be available to the overview renderer on first mount');
    assert(values.includes('Cloud'), 'expected the discovered field value to render from the live page');

    window.dispatchEvent(new window.Event('beforeunload'));
    dom.window.close();
  });

  test('controller discovery scan runs once per stable scope and local discovery changes do not rerender unselected fields', async () => {
    const dom = makeDom(`
      <body>
        <div id="record">
          <now-record-string name="account" value="Acme"></now-record-string>
        </div>
      </body>
    `, 'https://thehub.soprasteria.com/x/ssasi/crm/record/x_ssasi_crm_opportunity/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    const { window } = dom;

    let messageHandler = null;
    let discoveryListener = null;
    let renderValueCalls = 0;
    let mergeCalls = 0;

    window.chrome = {
      runtime: {
        onMessage: {
          addListener(fn) {
            messageHandler = fn;
          }
        }
      }
    };

    window.SNCRM = {
      log: makeLog(),
      constants: {
        MOUNT_DEBOUNCE_MS: 0,
        REFRESH_DEBOUNCE_MS: 0,
        HYDRATION_TIMEOUT_MS: 40,
        HYDRATION_POLL_MS: 5,
        HYDRATION_BACKOFF_MS: 20,
        MSG: {
          GET_STATUS: 'sncrm/get-status',
          REFRESH: 'sncrm/refresh',
          OPEN_OPTIONS: 'sncrm/open-options'
        }
      },
      url: {
        isSupportedUrl(url) {
          return /\/x\/ssasi\/crm\/record\/x_ssasi_crm_opportunity\//.test(url);
        },
        extractRecordId: parseRecordId
      },
      storage: {
        async get() {
          return {
            enabled: true,
            debug: false,
            defaultCollapsed: false,
            columns: 2,
            autoExpandSections: true,
            panelHeightPercent: 50,
            panelFullHeight: false,
            descriptionAutoHeight: false,
            selectedFields: ['account'],
            fieldLayout: [{ type: 'field', key: 'account', span: 1 }]
          };
        },
        async set(patch) {
          return {
            enabled: true,
            debug: false,
            defaultCollapsed: false,
            columns: 2,
            autoExpandSections: true,
            panelHeightPercent: 50,
            panelFullHeight: false,
            descriptionAutoHeight: false,
            ...patch
          };
        },
        onChange() {
          return () => {};
        }
      },
      discoveryStore: {
        async get() {
          return [];
        },
        async merge(fields) {
          mergeCalls++;
          return fields || [];
        },
        onChange(listener) {
          discoveryListener = listener;
          return () => {};
        }
      },
      fieldRegistry: null,
      extractors: {
        resolveActiveRecordScope() {
          return window.document.getElementById('record');
        },
        isHydrated() {
          return true;
        },
        extractAll() {
          return {
            account: { key: 'account', found: true, value: 'Acme', source: 'test' }
          };
        },
        discoverFields() {
          return {
            discoveries: [{
              key: 'detected:new_field',
              serviceNowName: 'new_field',
              label: 'New Field',
              renderAs: 'text',
              reason: 'new-field'
            }],
            resolvedServiceNowNames: []
          };
        }
      },
      ui: {
        TOGGLE_SHOW: 'Expand',
        TOGGLE_HIDE: 'Collapse',
        effectiveColumnCount(columns) {
          return columns || 2;
        },
        buildShell() {
          const panel = window.document.createElement('section');
          panel.id = 'sncrm-overview-panel';
          const body = window.document.createElement('div');
          const content = window.document.createElement('div');
          body.appendChild(content);
          panel.appendChild(body);
          return { panel, body, content };
        },
        mountInto(panel) {
          window.document.body.insertBefore(panel, window.document.body.firstChild);
          return window.document.body;
        },
        existing() {
          return window.document.getElementById('sncrm-overview-panel');
        },
        remove() {
          const panel = window.document.getElementById('sncrm-overview-panel');
          if (panel && panel.parentNode) panel.parentNode.removeChild(panel);
        },
        attachResize() {},
        renderSkeleton(content) {
          content.textContent = 'loading';
        },
        renderEmpty(content, message) {
          content.textContent = message;
        },
        renderValues(content, selectedKeys, results) {
          renderValueCalls++;
          content.textContent = `${selectedKeys.join(',')}:${results.account.value}`;
        }
      },
      navigation: {
        start() {
          return () => {};
        }
      },
      messages: {
        send() {
          return Promise.resolve({ ok: true });
        }
      },
      sectionExpander: {
        expandAll() {
          return 0;
        }
      }
    };

    loadScript(window, 'src/content/field-registry.js');
    window.SNCRM.fieldRegistry = window.SNCRM.fieldRegistry;
    loadScript(window, 'src/content/controller.js');

    await window.SNCRM.controller.init();
    await delay(20);

    assertEqual(renderValueCalls, 1, 'expected the initial mount to render once');
    assertEqual(mergeCalls, 1, 'expected the discovery scan to run once after mount');

    messageHandler({ type: 'sncrm/refresh' }, null, () => {});
    await delay(20);

    assertEqual(renderValueCalls, 1, 'expected unchanged refreshes to keep skipping the overview rerender');
    assertEqual(mergeCalls, 1, 'expected the discovery scan to stay one-shot for the stable record scope');

    discoveryListener([{
      key: 'detected:another_field',
      serviceNowName: 'another_field',
      label: 'Another Field',
      renderAs: 'text',
      reason: 'new-field'
    }]);
    await delay(10);

    assertEqual(renderValueCalls, 1, 'expected local discovery metadata changes to avoid rerendering when no detected field is selected');

    window.dispatchEvent(new window.Event('beforeunload'));
    dom.window.close();
  });

  await Promise.all(pending);
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
