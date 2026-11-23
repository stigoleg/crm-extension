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

  test('discoverFields keeps the curated group for known fields when no section header is present', async () => {
    const dom = makeDom(`
      <body>
        <div id="scope">
          <div class="field">
            <label for="account">Account</label>
            <input id="account" name="account" value="Acme">
          </div>
        </div>
      </body>
    `, 'https://thehub.soprasteria.com/x/ssasi/crm/record/x_ssasi_crm_opportunity/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    const { window } = dom;

    loadExtractorHarness(window);

    const { discoverFields } = window.SNCRM.extractors;
    const result = discoverFields(window.document.getElementById('scope'));

    assertEqual(result.discoveries.length, 1, 'expected the known account field to be surfaced');
    assertEqual(result.discoveries[0].reason, 'known', 'expected an unchanged known name to register as a known field');
    assertEqual(result.discoveries[0].key, 'account', 'expected known fields to keep their static key');
    assertEqual(result.discoveries[0].group, 'Opportunity Information', 'expected known fields to fall back to the curated group when no section is detected');

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

    const byName = Object.fromEntries(result.discoveries.map((field) => [field.serviceNowName, field]));
    assertEqual(result.discoveries.length, 2, 'expected both the known field and the renamed field to be surfaced');
    assertEqual(byName.account.reason, 'known', 'expected an unchanged known name to register as a known field');
    assertEqual(byName.account.key, 'account', 'expected known fields to keep their static key');
    assertEqual(byName.account.group, 'Opportunity Information', 'expected known fields to adopt the detected ServiceNow section');
    assertEqual(byName.legacy_account.serviceNowName, 'legacy_account', 'expected the unknown ServiceNow name to be reported');
    assertEqual(byName.legacy_account.reason, 'name-change', 'expected matching a known static label to classify as a name change');
    assertEqual(byName.legacy_account.matchedRegistryKey, 'account', 'expected name changes to point back to the matched static field');
    assert(!result.resolvedServiceNowNames.includes('account'), 'expected known fields to be reported as discoveries, not resolved skip-listed');

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

    const byName = Object.fromEntries(result.discoveries.map((field) => [field.serviceNowName, field]));
    assertEqual(result.discoveries.length, 1, 'expected only the base known field to be surfaced, not its *_input companion');
    assertEqual(byName.advisory_bid_manager.reason, 'known', 'expected the base field to register as known');
    assert(!result.resolvedServiceNowNames.includes('advisory_bid_manager'), 'expected the base field to be a discovery, not resolved');
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

    const byName = Object.fromEntries(result.discoveries.map((field) => [field.serviceNowName, field]));
    assertEqual(result.discoveries.length, 2, 'expected only the base known date fields to be surfaced');
    assertEqual(byName.due_date.reason, 'known', 'expected due_date to register as a known field');
    assertEqual(byName.close_date.reason, 'known', 'expected close_date to register as a known field');
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

    const byName = Object.fromEntries(result.discoveries.map((field) => [field.serviceNowName, field]));
    assertEqual(result.discoveries.length, 1, 'expected the known estimate field to be surfaced, not added as a new field');
    assertEqual(byName.estimated_value_sopra.reason, 'known', 'expected the known estimate field to register as known');
    assertEqual(byName.estimated_value_sopra.group, 'Estimates', 'expected known fields to adopt the live ServiceNow section heading over the curated group');
    assertEqual(byName.estimated_value_sopra.label, 'Estimated Value Sopra', 'expected known fields to keep their curated label');

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

  test('discoverFields recognizes every newly integrated ServiceNow column as known', async () => {
    const dom = makeDom(`
      <body>
        <div id="scope">
          <span class="sn-section-header collapsable" aria-expanded="true">Opportunity Information</span>
          <div class="field"><label for="internal_due_date">Internal Due Date</label><input id="internal_due_date" name="internal_due_date" value="30.04.2026"></div>
          <span class="sn-section-header collapsable" aria-expanded="true">APPS Status</span>
          <div class="field"><label for="apps_comments">APPS Comments</label><textarea id="apps_comments" name="apps_comments">Needs a partner review.</textarea></div>
          <div class="field"><label for="apps_demand_state">APPS Demand State</label><input id="apps_demand_state" name="apps_demand_state" value="Qualified"></div>
          <div class="field"><label for="apps_opportunity_owner">APPS Opportunity Owner</label><input id="apps_opportunity_owner" name="apps_opportunity_owner" value="Jane Doe"></div>
          <div class="field"><label for="apps_substatus">APPS Substatus</label><input id="apps_substatus" name="apps_substatus" value="Active"></div>
          <div class="field"><label for="bid_review">Bid Review</label><input id="bid_review" name="bid_review" value="true"></div>
          <span class="sn-section-header collapsable" aria-expanded="true">DPS Status</span>
          <div class="field"><label for="dps_demand_state">DPS Demand State</label><input id="dps_demand_state" name="dps_demand_state" value="Qualified"></div>
          <span class="sn-section-header collapsable" aria-expanded="true">Advisory Status</span>
          <div class="field"><label for="advisory_business_domain">Advisory Business Domain</label><input id="advisory_business_domain" name="advisory_business_domain" value="Banking"></div>
          <div class="field"><label for="advisory_demand_state">Advisory Demand State</label><input id="advisory_demand_state" name="advisory_demand_state" value="Qualified"></div>
          <div class="field"><label for="advisory_substatus">Advisory Substatus</label><input id="advisory_substatus" name="advisory_substatus" value="Active"></div>
          <span class="sn-section-header collapsable" aria-expanded="true">System Information</span>
          <div class="field"><label for="lead">Lead</label><input id="lead" name="lead" value="Jane Doe"></div>
          <div class="field"><label for="primary_event_source">Primary Event Source</label><input id="primary_event_source" name="primary_event_source" value="Event"></div>
        </div>
      </body>
    `, 'https://thehub.soprasteria.com/x/ssasi/crm/record/x_ssasi_crm_opportunity/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    const { window } = dom;

    loadExtractorHarness(window);

    const { discoverFields } = window.SNCRM.extractors;
    const result = discoverFields(window.document.getElementById('scope'));
    const byName = Object.fromEntries(result.discoveries.map((field) => [field.serviceNowName, field]));

    const expectedKeys = [
      'internal_due_date',
      'apps_comments',
      'apps_demand_state',
      'apps_opportunity_owner',
      'apps_substatus',
      'bid_review',
      'dps_demand_state',
      'advisory_business_domain',
      'advisory_demand_state',
      'advisory_substatus',
      'lead',
      'primary_event_source'
    ];
    assertEqual(result.discoveries.length, expectedKeys.length, 'expected one discovery per integrated column');
    for (const name of expectedKeys) {
      const field = byName[name];
      assert(field, `expected ${name} to be discovered`);
      assertEqual(field.reason, 'known', `expected ${name} to register as a known field`);
      assertEqual(field.key, name, `expected ${name} to use its static registry key`);
    }
    assert(!result.discoveries.some((field) => field.key.startsWith('detected:')), 'expected no new detected fields for integrated names');

    assertEqual(byName.internal_due_date.group, 'Opportunity Information', 'expected Internal Due Date to stay in Opportunity Information');
    assertEqual(byName.internal_due_date.renderAs, 'date', 'expected Internal Due Date to render as a date');
    assertEqual(byName.apps_comments.group, 'APPS Status', 'expected APPS Comments to stay in APPS Status');
    assertEqual(byName.apps_comments.renderAs, 'markdown', 'expected APPS Comments to render as a markdown block');
    assertEqual(byName.bid_review.renderAs, 'badge', 'expected Bid Review to render as a badge');
    assertEqual(byName.dps_demand_state.group, 'DPS Status', 'expected the DPS field to stay in DPS Status');
    assertEqual(byName.advisory_substatus.group, 'Advisory Status', 'expected the Advisory fields to stay in Advisory Status');
    assertEqual(byName.primary_event_source.group, 'System Information', 'expected Primary Event Source to stay in System Information');

    dom.window.close();
  });

  test('discoverFields prefers the full label over a shorter ambiguous neighbor', async () => {
    const dom = makeDom(`
      <body>
        <div id="scope">
          <span class="sn-section-header collapsable" aria-expanded="true">Opportunity Information</span>
          <div class="field">
            <input name="internal_review_date" value="30.04.2026">
            <span class="sn-form-label">Due Date</span>
            <span class="sn-form-label">Internal Review Date</span>
          </div>
        </div>
      </body>
    `, 'https://thehub.soprasteria.com/x/ssasi/crm/record/x_ssasi_crm_opportunity/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    const { window } = dom;

    loadExtractorHarness(window);

    const { discoverFields } = window.SNCRM.extractors;
    const result = discoverFields(window.document.getElementById('scope'));

    assertEqual(result.discoveries.length, 1, 'expected one discovered field');
    assertEqual(
      result.discoveries[0].label,
      'Internal Review Date',
      'expected the label covering the whole field name to win over a shorter neighbor'
    );
    assertEqual(result.discoveries[0].reason, 'new-field', 'expected the unknown column to stay a new field');

    dom.window.close();
  });

  test('discoverFields infers markdown for long-form field names', async () => {
    const dom = makeDom(`
      <body>
        <div id="scope">
          <span class="sn-section-header collapsable" aria-expanded="true">APPS Status</span>
          <div class="field"><label for="delivery_comments">Delivery Comments</label><textarea id="delivery_comments" name="delivery_comments">Needs a partner review.</textarea></div>
        </div>
      </body>
    `, 'https://thehub.soprasteria.com/x/ssasi/crm/record/x_ssasi_crm_opportunity/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    const { window } = dom;

    loadExtractorHarness(window);

    const { discoverFields } = window.SNCRM.extractors;
    const result = discoverFields(window.document.getElementById('scope'));

    assertEqual(result.discoveries.length, 1, 'expected one discovered field');
    assertEqual(result.discoveries[0].renderAs, 'markdown', 'expected comments-shaped names to infer markdown rendering');

    dom.window.close();
  });

  test('extractAll reads the newly integrated date, markdown, and badge fields', async () => {
    const dom = makeDom(`
      <body>
        <div id="scope">
          <span class="sn-section-header collapsable" aria-expanded="true">Opportunity Information</span>
          <div class="field">
            <label for="internal_due_date">Internal Due Date</label>
            <now-record-string id="internal_due_date" name="internal_due_date" value="30.04.2026"></now-record-string>
          </div>
          <span class="sn-section-header collapsable" aria-expanded="true">APPS Status</span>
          <div class="field">
            <label for="apps_comments">APPS Comments</label>
            <now-record-textarea id="apps_comments" name="apps_comments">Needs a partner review.</now-record-textarea>
          </div>
          <div class="field">
            <label for="bid_review">Bid Review</label>
            <now-record-checkbox id="bid_review" name="bid_review" value="true"></now-record-checkbox>
          </div>
        </div>
      </body>
    `, 'https://thehub.soprasteria.com/x/ssasi/crm/record/x_ssasi_crm_opportunity/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    const { window } = dom;

    loadExtractorHarness(window);

    const { extractAll } = window.SNCRM.extractors;
    const results = extractAll(window.document.getElementById('scope'), [
      'internal_due_date',
      'apps_comments',
      'bid_review'
    ]);

    assertEqual(results.internal_due_date.found, true, 'expected Internal Due Date to be found by column name');
    assertEqual(results.internal_due_date.value, '30.04.2026', 'expected the date value to be read verbatim');
    assertEqual(results.apps_comments.found, true, 'expected APPS Comments to be found by column name');
    assertEqual(results.apps_comments.value, 'Needs a partner review.', 'expected long-form text to be read');
    assertEqual(results.bid_review.found, true, 'expected Bid Review to be found by column name');
    assertEqual(results.bid_review.value, 'true', 'expected the boolean value to survive extraction');

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

  test('controller rescans discovery on manual refresh without rerendering unchanged values', async () => {
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
    assertEqual(mergeCalls, 2, 'expected manual refresh to re-run the discovery scan for the stable record scope');

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
