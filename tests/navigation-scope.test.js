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
  const noop = () => {};
  return {
    debugEnabled: false,
    setDebug(value) { this.debugEnabled = Boolean(value); },
    make() {
      return {
        debug: noop,
        info: noop,
        warn: noop,
        error: noop
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

async function run() {
  console.log('navigation scope + stale render guard');

  test('resolveActiveRecordScope ignores hidden old record DOM', async () => {
    const dom = makeDom(`
      <body>
        <div id="record-old" aria-hidden="true">
          <span class="sn-section-header collapsable" aria-expanded="true">Opportunity Information</span>
          <now-record-string name="account" value="Old Account"></now-record-string>
          <now-record-string name="opportunity_name" value="Old Opportunity"></now-record-string>
          <now-record-string name="stage" value="Qualification"></now-record-string>
          <span class="sn-section-header collapsable" aria-expanded="true">Description</span>
          <textarea name="description">Old description</textarea>
          <span class="sn-section-header collapsable" aria-expanded="true">APPS Status</span>
          <now-record-string name="apps_status" value="Old status"></now-record-string>
        </div>
        <div id="record-new">
          <span class="sn-section-header collapsable" aria-expanded="true">Opportunity Information</span>
          <now-record-string name="account" value="New Account"></now-record-string>
          <now-record-string name="opportunity_name" value="New Opportunity"></now-record-string>
          <now-record-string name="stage" value="Proposal"></now-record-string>
          <span class="sn-section-header collapsable" aria-expanded="true">Description</span>
          <textarea name="description">New description</textarea>
          <span class="sn-section-header collapsable" aria-expanded="true">APPS Status</span>
          <now-record-string name="apps_status" value="In Review"></now-record-string>
        </div>
      </body>
    `, 'https://thehub.soprasteria.com/x/ssasi/crm/record/x_ssasi_crm_opportunity/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/params/selected-tab/id%3Ddetails');

    dom.window.SNCRM = { log: makeLog() };
    loadScript(dom.window, 'src/content/field-registry.js');
    loadScript(dom.window, 'src/content/extractors.js');

    const { resolveActiveRecordScope, extractAll } = dom.window.SNCRM.extractors;
    const scope = resolveActiveRecordScope(dom.window.document.body, [
      'account',
      'opportunity_name',
      'stage',
      'description',
      'apps_status'
    ]);

    assert(scope, 'expected a visible record scope');
    assertEqual(scope.id, 'record-new', 'expected the visible record subtree to win');

    const results = extractAll(scope, [
      'account',
      'opportunity_name',
      'stage',
      'description',
      'apps_status'
    ]);

    assertEqual(results.account.value, 'New Account', 'account should come from the active record');
    assertEqual(results.opportunity_name.value, 'New Opportunity', 'name should come from the active record');
    assertEqual(results.stage.value, 'Proposal', 'stage should come from the active record');
    assertEqual(results.description.value, 'New description', 'description should come from the active record');
    assertEqual(results.apps_status.value, 'In Review', 'apps status should come from the active record');

    dom.window.close();
  });

  test('deepQueryAll returns each light and shadow DOM match once', async () => {
    const dom = makeDom(`
      <body>
        <div id="scope">
          <section>
            <div>
              <span class="hit">Light</span>
            </div>
          </section>
          <x-shadow-host id="shadow-host"></x-shadow-host>
        </div>
      </body>
    `, 'https://thehub.soprasteria.com/x/ssasi/crm/record/x_ssasi_crm_opportunity/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');

    dom.window.SNCRM = { log: makeLog() };
    loadScript(dom.window, 'src/content/field-registry.js');
    const shadowHost = dom.window.document.getElementById('shadow-host');
    shadowHost.attachShadow({ mode: 'open' }).innerHTML = `
      <div>
        <span class="hit">Shadow</span>
      </div>
    `;
    loadScript(dom.window, 'src/content/extractors.js');

    const { deepQueryAll } = dom.window.SNCRM.extractors;
    const hits = deepQueryAll(dom.window.document.getElementById('scope'), '.hit');

    assertEqual(hits.length, 2, 'expected each match once across light and shadow DOM');
    assertEqual(new Set(hits).size, 2, 'expected each returned node to be unique');

    dom.window.close();
  });

  test('deepQueryAll reuses cached results until invalidateCache refreshes them', async () => {
    const dom = makeDom(`
      <body>
        <div id="scope">
          <span class="hit">First</span>
        </div>
      </body>
    `, 'https://thehub.soprasteria.com/x/ssasi/crm/record/x_ssasi_crm_opportunity/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');

    dom.window.SNCRM = { log: makeLog() };
    loadScript(dom.window, 'src/content/field-registry.js');
    loadScript(dom.window, 'src/content/extractors.js');

    const scope = dom.window.document.getElementById('scope');
    const {
      deepQueryAll,
      invalidateCache
    } = dom.window.SNCRM.extractors;

    assertEqual(deepQueryAll(scope, '.hit').length, 1, 'expected the initial query to find one hit');

    const next = dom.window.document.createElement('span');
    next.className = 'hit';
    next.textContent = 'Second';
    scope.appendChild(next);

    assertEqual(
      deepQueryAll(scope, '.hit').length,
      1,
      'expected the second query to reuse the cached traversal before invalidation'
    );

    invalidateCache();
    assertEqual(deepQueryAll(scope, '.hit').length, 2, 'expected invalidation to refresh the cached query results');

    dom.window.close();
  });

  test('isVisible avoids layout rect reads and still respects CSS-hidden ancestors', async () => {
    const dom = makeDom(`
      <html>
        <head>
          <style>
            .css-hidden { display: none; }
          </style>
        </head>
        <body>
          <div id="visible-wrap"><span id="visible-child">Visible</span></div>
          <div id="hidden-wrap" class="css-hidden"><span id="hidden-child">Hidden</span></div>
        </body>
      </html>
    `, 'https://thehub.soprasteria.com/x/ssasi/crm/record/x_ssasi_crm_opportunity/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');

    dom.window.SNCRM = { log: makeLog() };
    dom.window.Element.prototype.getBoundingClientRect = function getBoundingClientRect() {
      throw new Error('getBoundingClientRect should not be used in extractor visibility checks');
    };
    loadScript(dom.window, 'src/content/field-registry.js');
    loadScript(dom.window, 'src/content/extractors.js');

    const { isVisible, invalidateCache } = dom.window.SNCRM.extractors;
    assertEqual(isVisible(dom.window.document.getElementById('visible-child')), true, 'expected visible nodes to remain visible without layout reads');
    invalidateCache();
    assertEqual(isVisible(dom.window.document.getElementById('hidden-child')), false, 'expected CSS-hidden ancestors to keep nodes hidden');

    dom.window.close();
  });

  test('isVisible prefers native checkVisibility over computed-style walks when available', async () => {
    const dom = makeDom(`
      <body>
        <div id="visible-wrap"><span id="visible-child">Visible</span></div>
        <div id="hidden-wrap"><span id="hidden-child">Hidden</span></div>
      </body>
    `, 'https://thehub.soprasteria.com/x/ssasi/crm/record/x_ssasi_crm_opportunity/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');

    dom.window.SNCRM = { log: makeLog() };
    loadScript(dom.window, 'src/content/field-registry.js');
    loadScript(dom.window, 'src/content/extractors.js');

    let nativeChecks = 0;
    let styleReads = 0;
    const originalGetComputedStyle = dom.window.getComputedStyle.bind(dom.window);
    dom.window.Element.prototype.checkVisibility = function checkVisibility() {
      nativeChecks++;
      return this.id !== 'hidden-child';
    };
    dom.window.getComputedStyle = function getComputedStyle(...args) {
      styleReads++;
      return originalGetComputedStyle(...args);
    };

    const { isVisible } = dom.window.SNCRM.extractors;
    assertEqual(isVisible(dom.window.document.getElementById('visible-child')), true, 'expected native visibility checks to keep visible nodes visible');
    assertEqual(isVisible(dom.window.document.getElementById('hidden-child')), false, 'expected native visibility checks to hide reported-hidden nodes');
    assert(nativeChecks >= 2, 'expected the native visibility API to be consulted for each checked element');
    assertEqual(styleReads, 0, 'expected native visibility checks to avoid computed-style reads entirely');

    dom.window.close();
  });

  test('extractLinkField returns bid room URL from tooltip-backed now-text-link anchors', async () => {
    const dom = makeDom(`
      <body>
        <dl class="now-label-value-pair" id="record">
          <dt class="now-label-value-label">Bid Room</dt>
          <dd class="now-label-value-content">
            <a
              href="javascript:void(0)"
              class="now-text-link -primary"
              data-ariadescribedby="https://steria.sharepoint.com/sites/intra_sc_tilbud_sn1/335c0d7a2bcc0f546f1efe01fe91bf4a"
              data-tooltip="https://steria.sharepoint.com/sites/intra_sc_tilbud_sn1/335c0d7a2bcc0f546f1efe01fe91bf4a"
            >https://steria.sharepoint.com/sites/intra_sc_tilbud_sn1/335c0d7a2bcc0f546f1efe01fe91bf4a</a>
          </dd>
        </dl>
      </body>
    `, 'https://thehub.soprasteria.com/x/ssasi/crm/record/x_ssasi_crm_opportunity/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');

    dom.window.SNCRM = { log: makeLog() };
    loadScript(dom.window, 'src/content/field-registry.js');
    loadScript(dom.window, 'src/content/extractors.js');

    const { extractField } = dom.window.SNCRM.extractors;
    const result = extractField(dom.window.document.body, 'bid_room');

    assert(result.found, 'expected bid room extractor to find a URL');
    assertEqual(
      result.value,
      'https://steria.sharepoint.com/sites/intra_sc_tilbud_sn1/335c0d7a2bcc0f546f1efe01fe91bf4a',
      'expected bid room URL to come from the anchor text or tooltip attributes'
    );

    dom.window.close();
  });

  test('extractLinkField handles non-dl bid room layouts by reading tooltip URLs from the value container', async () => {
    const dom = makeDom(`
      <body>
        <div id="record">
          <div class="sn-form-label">Bid Room</div>
          <div class="sn-form-value">
            <a
              href="javascript:void(0)"
              class="now-text-link -primary"
              data-tooltip="https://steria.sharepoint.com/sites/example/bid-room"
              data-ariadescribedby="https://steria.sharepoint.com/sites/example/bid-room"
            ></a>
          </div>
        </div>
      </body>
    `, 'https://thehub.soprasteria.com/x/ssasi/crm/record/x_ssasi_crm_opportunity/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');

    dom.window.SNCRM = { log: makeLog() };
    loadScript(dom.window, 'src/content/field-registry.js');
    loadScript(dom.window, 'src/content/extractors.js');

    const { extractField } = dom.window.SNCRM.extractors;
    const result = extractField(dom.window.document.body, 'bid_room');

    assert(result.found, 'expected bid room extractor to find tooltip-backed URLs outside dl markup');
    assertEqual(
      result.value,
      'https://steria.sharepoint.com/sites/example/bid-room',
      'expected bid room URL to come from tooltip attributes when the anchor text is empty'
    );

    dom.window.close();
  });

  test('extractLinkField still finds bid room URLs when the value wrapper itself has zero size', async () => {
    const dom = makeDom(`
      <body>
        <div id="record">
          <div class="sn-form-label">Bid Room</div>
          <div class="sn-form-value" id="value-wrap">
            <a
              href="javascript:void(0)"
              class="now-text-link -primary"
              data-tooltip="https://steria.sharepoint.com/sites/intra_sc_tilbud_sn1/335c0d7a2bcc0f546f1efe01fe91bf4a"
            >https://steria.sharepoint.com/sites/intra_sc_tilbud_sn1/335c0d7a2bcc0f546f1efe01fe91bf4a</a>
          </div>
        </div>
      </body>
    `, 'https://thehub.soprasteria.com/x/ssasi/crm/record/x_ssasi_crm_opportunity/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');

    const valueWrap = dom.window.document.getElementById('value-wrap');
    valueWrap.getBoundingClientRect = () => ({
      width: 0,
      height: 0,
      top: 0,
      right: 0,
      bottom: 0,
      left: 0
    });

    dom.window.SNCRM = { log: makeLog() };
    loadScript(dom.window, 'src/content/field-registry.js');
    loadScript(dom.window, 'src/content/extractors.js');

    const { extractField } = dom.window.SNCRM.extractors;
    const result = extractField(dom.window.document.body, 'bid_room');

    assert(result.found, 'expected bid room extraction to ignore zero-size wrappers around a visible link');
    assertEqual(
      result.value,
      'https://steria.sharepoint.com/sites/intra_sc_tilbud_sn1/335c0d7a2bcc0f546f1efe01fe91bf4a',
      'expected the visible link URL to survive wrapper-level visibility quirks'
    );

    dom.window.close();
  });

  test('extractLinkField still finds bid room URLs when the shadow-root anchor reports zero size', async () => {
    const dom = makeDom(`
      <body>
        <div class="now-label-value-pair">
          <dt><div class="now-label-value-label">Bid Room</div></dt>
          <dd><div class="now-align -block-end"><now-text-link class="now-label-value-value"></now-text-link></div></dd>
        </div>
      </body>
    `, 'https://thehub.soprasteria.com/x/ssasi/crm/record/x_ssasi_crm_opportunity/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');

    const host = dom.window.document.querySelector('now-text-link');
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `
      <a
        href="javascript:void(0)"
        class="now-text-link -primary"
        data-tooltip="https://steria.sharepoint.com/sites/intra_sc_tilbud_sn1/335c0d7a2bcc0f546f1efe01fe91bf4a"
      >https://steria.sharepoint.com/sites/intra_sc_tilbud_sn1/335c0d7a2bcc0f546f1efe01fe91bf4a</a>
    `;
    const anchor = shadow.querySelector('a');
    anchor.getBoundingClientRect = () => ({
      width: 0,
      height: 0,
      top: 0,
      right: 0,
      bottom: 0,
      left: 0
    });

    dom.window.SNCRM = { log: makeLog() };
    loadScript(dom.window, 'src/content/field-registry.js');
    loadScript(dom.window, 'src/content/extractors.js');

    const { extractField } = dom.window.SNCRM.extractors;
    const result = extractField(dom.window.document.body, 'bid_room');

    assert(result.found, 'expected bid room extraction to survive zero-size shadow-root anchors');
    assertEqual(
      result.value,
      'https://steria.sharepoint.com/sites/intra_sc_tilbud_sn1/335c0d7a2bcc0f546f1efe01fe91bf4a',
      'expected the tooltip-backed SharePoint URL to be extracted from the open shadow root'
    );

    dom.window.close();
  });

  test('extractAll resolves mixed field strategies from one shared scope', async () => {
    const dom = makeDom(`
      <body>
        <div id="record">
          <now-record-string name="account" value="Acme"></now-record-string>
          <div class="field-row">
            <label for="stage-input">Stage</label>
            <input id="stage-input" value="Proposal" />
          </div>
          <div class="field-row">
            <div class="sn-form-label">Description</div>
            <div class="sn-form-value">Multi line description</div>
          </div>
          <dl class="now-label-value-pair">
            <dt class="now-label-value-label">Bid Room</dt>
            <dd class="now-label-value-content">
              <a
                href="javascript:void(0)"
                class="now-text-link -primary"
                data-tooltip="https://steria.sharepoint.com/sites/example/shared-scope"
                data-ariadescribedby="https://steria.sharepoint.com/sites/example/shared-scope"
              >https://steria.sharepoint.com/sites/example/shared-scope</a>
            </dd>
          </dl>
        </div>
      </body>
    `, 'https://thehub.soprasteria.com/x/ssasi/crm/record/x_ssasi_crm_opportunity/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');

    dom.window.SNCRM = { log: makeLog() };
    loadScript(dom.window, 'src/content/field-registry.js');
    loadScript(dom.window, 'src/content/extractors.js');

    const { extractAll } = dom.window.SNCRM.extractors;
    const results = extractAll(dom.window.document.getElementById('record'), [
      'account',
      'stage',
      'description',
      'bid_room'
    ]);

    assertEqual(results.account.value, 'Acme', 'expected account to resolve by name');
    assertEqual(results.stage.value, 'Proposal', 'expected stage to resolve via label[for]');
    assertEqual(results.description.value, 'Multi line description', 'expected description to resolve via label text');
    assertEqual(
      results.bid_room.value,
      'https://steria.sharepoint.com/sites/example/shared-scope',
      'expected bid room to resolve via the link-field strategy'
    );

    dom.window.close();
  });

  test('extractField ignores sys_id-looking rendered text and falls back to the display value attribute', async () => {
    const dom = makeDom(`
      <body>
        <div id="record">
          <now-record-reference
            name="account"
            value="Acme Corp"
          >aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa</now-record-reference>
        </div>
      </body>
    `, 'https://thehub.soprasteria.com/x/ssasi/crm/record/x_ssasi_crm_opportunity/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');

    dom.window.SNCRM = { log: makeLog() };
    loadScript(dom.window, 'src/content/field-registry.js');
    loadScript(dom.window, 'src/content/extractors.js');

    const { extractField } = dom.window.SNCRM.extractors;
    const result = extractField(dom.window.document.body, 'account');

    assert(result.found, 'expected the account extractor to resolve a display value');
    assertEqual(
      result.value,
      'Acme Corp',
      'expected sys_id-looking rendered text to fall back to the display value attribute'
    );

    dom.window.close();
  });

  test('extractField falls back to the visible page body for bid room when the scoped root is too narrow', async () => {
    const dom = makeDom(`
      <body>
        <section id="narrow-scope">
          <div>Only the primary record summary is inside this scope.</div>
        </section>
        <div class="now-label-value-pair">
          <dt><div class="now-label-value-label">Bid Room</div></dt>
          <dd><div class="now-align -block-end"><now-text-link class="now-label-value-value"></now-text-link></div></dd>
        </div>
      </body>
    `, 'https://thehub.soprasteria.com/x/ssasi/crm/record/x_ssasi_crm_opportunity/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');

    const host = dom.window.document.querySelector('now-text-link');
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `
      <a
        href="javascript:void(0)"
        class="now-text-link -primary"
        data-tooltip="https://steria.sharepoint.com/sites/intra_sc_tilbud_sn1/335c0d7a2bcc0f546f1efe01fe91bf4a"
      >https://steria.sharepoint.com/sites/intra_sc_tilbud_sn1/335c0d7a2bcc0f546f1efe01fe91bf4a</a>
    `;

    dom.window.SNCRM = { log: makeLog() };
    loadScript(dom.window, 'src/content/field-registry.js');
    loadScript(dom.window, 'src/content/extractors.js');

    const { extractField } = dom.window.SNCRM.extractors;
    const result = extractField(dom.window.document.getElementById('narrow-scope'), 'bid_room');

    assert(result.found, 'expected bid room extraction to recover from a too-narrow active scope');
    assertEqual(
      result.value,
      'https://steria.sharepoint.com/sites/intra_sc_tilbud_sn1/335c0d7a2bcc0f546f1efe01fe91bf4a',
      'expected the body fallback to recover the SharePoint URL'
    );
    assertEqual(
      result.source,
      'body-fallback:link-text',
      'expected the result source to show the body fallback path'
    );

    dom.window.close();
  });

  test('controller waits for a stable record scope when only one field is visible first', async () => {
    const dom = makeDom(`
      <body>
        <div id="record">
          <span class="sn-section-header collapsable" aria-expanded="true">Opportunity Information</span>
          <div class="field-shell">
            <now-record-string name="account" value="Acme"></now-record-string>
          </div>
        </div>
      </body>
    `, 'https://thehub.soprasteria.com/x/ssasi/crm/record/x_ssasi_crm_opportunity/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/params/selected-tab/id%3Ddetails');
    const { window } = dom;

    let renderSkeletonCalls = 0;
    let renderValueCalls = 0;

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
            selectedFields: ['account', 'opportunity_name', 'stage']
          };
        },
        async set(patch) {
          return patch;
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

    loadScript(window, 'src/content/field-registry.js');
    loadScript(window, 'src/content/extractors.js');

    const probeKeys = ['account', 'opportunity_name', 'stage'];
    const initialScope = window.SNCRM.extractors.resolveActiveRecordScope(window.document.body, probeKeys);
    assertEqual(initialScope, null, 'single-field partial hydration should not finalize a narrow scope');

    const panelId = 'sncrm-overview-panel';
    window.SNCRM.ui = {
      TOGGLE_SHOW: 'Expand',
      TOGGLE_HIDE: 'Collapse',
      buildShell() {
        const panel = window.document.createElement('section');
        panel.id = panelId;
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
        return window.document.getElementById(panelId);
      },
      remove() {
        const panel = window.document.getElementById(panelId);
        if (panel && panel.parentNode) panel.parentNode.removeChild(panel);
      },
      attachResize() {},
      renderSkeleton(content) {
        renderSkeletonCalls++;
        content.textContent = 'loading';
      },
      renderEmpty(content, message) {
        content.textContent = message;
      },
      renderValues(content, selectedKeys, results) {
        renderValueCalls++;
        content.textContent = `${selectedKeys.join(',')}:${results.account.value}|${results.opportunity_name.value}|${results.stage.value}`;
      }
    };

    loadScript(window, 'src/content/controller.js');
    await window.SNCRM.controller.init();
    await delay(15);

    assertEqual(window.SNCRM.controller._state(), 'waiting', 'controller should keep waiting while only one probe field is visible');
    assertEqual(renderValueCalls, 0, 'values should not render from a single-field scope');

    const record = window.document.getElementById('record');
    record.insertAdjacentHTML('beforeend', `
      <div class="field-shell">
        <now-record-string name="opportunity_name" value="Big Deal"></now-record-string>
      </div>
      <div class="field-shell">
        <now-record-string name="stage" value="Proposal"></now-record-string>
      </div>
    `);

    await delay(30);

    const resolvedScope = window.SNCRM.extractors.resolveActiveRecordScope(window.document.body, probeKeys);
    assert(resolvedScope, 'expected the record scope to resolve once more fields appear');
    assertEqual(resolvedScope.id, 'record', 'expected the full record container to win once hydrated');
    assertEqual(window.SNCRM.controller._state(), 'mounted', 'controller should mount once a stable record scope appears');
    assert(renderSkeletonCalls >= 1, 'expected a loading skeleton during partial hydration');
    assertEqual(renderValueCalls, 1, 'expected a single value render after hydration completes');
    assertEqual(
      window.document.getElementById(panelId).textContent,
      'account,opportunity_name,stage:Acme|Big Deal|Proposal',
      'expected all selected fields to render from the expanded record scope'
    );

    window.dispatchEvent(new window.Event('beforeunload'));
    dom.window.close();
  });

  test('controller auto-expands visible sections during waiting so collapsed fields can mount the overview', async () => {
    const dom = makeDom(`
      <body>
        <div id="record-stale" aria-hidden="true">
          <span id="stale-toggle" class="sn-section-header collapsable" aria-expanded="false">Old Hidden Section</span>
          <div style="display:none">
            <now-record-string name="opportunity_name" value="Old hidden"></now-record-string>
            <now-record-string name="stage" value="Closed"></now-record-string>
          </div>
        </div>
        <div id="record">
          <span id="visible-toggle" class="sn-section-header collapsable" aria-expanded="false">Opportunity Details</span>
          <div id="visible-body" style="display:none">
            <now-record-string name="opportunity_name" value="Big Deal"></now-record-string>
            <now-record-string name="stage" value="Proposal"></now-record-string>
          </div>
          <now-record-string name="account" value="Acme"></now-record-string>
        </div>
      </body>
    `, 'https://thehub.soprasteria.com/x/ssasi/crm/record/x_ssasi_crm_opportunity/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/params/selected-tab/id%3Ddetails');
    const { window } = dom;

    let renderValueCalls = 0;
    let staleClicks = 0;
    const visibleToggle = window.document.getElementById('visible-toggle');
    const visibleBody = window.document.getElementById('visible-body');
    visibleToggle.addEventListener('click', () => {
      visibleToggle.setAttribute('aria-expanded', 'true');
      visibleBody.style.display = '';
    });
    window.document.getElementById('stale-toggle').addEventListener('click', () => {
      staleClicks++;
    });

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
        MOUNT_DEBOUNCE_MS: 0,
        REFRESH_DEBOUNCE_MS: 0,
        HYDRATION_TIMEOUT_MS: 80,
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
            selectedFields: ['account', 'opportunity_name', 'stage']
          };
        },
        async set(patch) {
          return patch;
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
      }
    };

    loadScript(window, 'src/content/field-registry.js');
    loadScript(window, 'src/content/extractors.js');
    loadScript(window, 'src/content/section-expander.js');

    const panelId = 'sncrm-overview-panel';
    window.SNCRM.ui = {
      TOGGLE_SHOW: 'Expand',
      TOGGLE_HIDE: 'Collapse',
      buildShell() {
        const panel = window.document.createElement('section');
        panel.id = panelId;
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
        return window.document.getElementById(panelId);
      },
      remove() {
        const panel = window.document.getElementById(panelId);
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
        content.textContent = `${selectedKeys.join(',')}:${results.account.value}|${results.opportunity_name.value}|${results.stage.value}`;
      }
    };

    loadScript(window, 'src/content/controller.js');
    await window.SNCRM.controller.init();
    await delay(90);

    assertEqual(staleClicks, 0, 'expected hidden stale record sections to stay untouched');
    assertEqual(window.SNCRM.controller._state(), 'mounted', 'expected auto-expanded visible sections to unblock overview mounting');
    assertEqual(renderValueCalls, 1, 'expected a single render after the auto-expand settles');
    assertEqual(
      window.document.getElementById(panelId).textContent,
      'account,opportunity_name,stage:Acme|Big Deal|Proposal',
      'expected the overview to include fields revealed by auto-expanding the visible section'
    );

    window.dispatchEvent(new window.Event('beforeunload'));
    dom.window.close();
  });

  test('controller mounts after a manual section expand reveals fields without structural DOM changes', async () => {
    const dom = makeDom(`
      <body>
        <div id="record">
          <span id="section-toggle" class="sn-section-header collapsable" aria-expanded="false">Opportunity Details</span>
          <div id="section-body" style="display:none">
            <now-record-string name="opportunity_name" value="Big Deal"></now-record-string>
            <now-record-string name="stage" value="Proposal"></now-record-string>
          </div>
          <now-record-string name="account" value="Acme"></now-record-string>
        </div>
      </body>
    `, 'https://thehub.soprasteria.com/x/ssasi/crm/record/x_ssasi_crm_opportunity/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/params/selected-tab/id%3Ddetails');
    const { window } = dom;

    let renderValueCalls = 0;

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
        MOUNT_DEBOUNCE_MS: 0,
        REFRESH_DEBOUNCE_MS: 0,
        HYDRATION_TIMEOUT_MS: 80,
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
            selectedFields: ['account', 'opportunity_name', 'stage']
          };
        },
        async set(patch) {
          return patch;
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

    loadScript(window, 'src/content/field-registry.js');
    loadScript(window, 'src/content/extractors.js');

    const panelId = 'sncrm-overview-panel';
    window.SNCRM.ui = {
      TOGGLE_SHOW: 'Expand',
      TOGGLE_HIDE: 'Collapse',
      buildShell() {
        const panel = window.document.createElement('section');
        panel.id = panelId;
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
        return window.document.getElementById(panelId);
      },
      remove() {
        const panel = window.document.getElementById(panelId);
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
        content.textContent = `${selectedKeys.join(',')}:${results.account.value}|${results.opportunity_name.value}|${results.stage.value}`;
      }
    };

    loadScript(window, 'src/content/controller.js');
    await window.SNCRM.controller.init();
    await delay(20);

    assertEqual(window.SNCRM.controller._state(), 'waiting', 'expected the controller to stay waiting while the section is collapsed');
    assertEqual(renderValueCalls, 0, 'expected no values before the hidden section is opened');

    window.document.getElementById('section-toggle').setAttribute('aria-expanded', 'true');
    window.document.getElementById('section-body').style.display = '';
    await delay(90);

    assertEqual(window.SNCRM.controller._state(), 'mounted', 'expected the manual section expand to unblock overview mounting');
    assertEqual(renderValueCalls, 1, 'expected a single render after the section becomes visible');
    assertEqual(
      window.document.getElementById(panelId).textContent,
      'account,opportunity_name,stage:Acme|Big Deal|Proposal',
      'expected the overview to mount from the newly visible section fields'
    );

    window.dispatchEvent(new window.Event('beforeunload'));
    dom.window.close();
  });

  test('controller rerenders when a manual section expand reveals mounted overview fields', async () => {
    const dom = makeDom(`
      <body>
        <div id="record">
          <now-record-string name="account" value="Acme"></now-record-string>
          <now-record-string name="opportunity_name" value="Big Deal"></now-record-string>
          <span id="description-toggle" class="sn-section-header collapsable" aria-expanded="false">Description</span>
          <div id="description-body" style="display:none">
            <textarea name="description">Important note</textarea>
          </div>
        </div>
      </body>
    `, 'https://thehub.soprasteria.com/x/ssasi/crm/record/x_ssasi_crm_opportunity/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/params/selected-tab/id%3Ddetails');
    const { window } = dom;

    const renders = [];

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
        MOUNT_DEBOUNCE_MS: 0,
        REFRESH_DEBOUNCE_MS: 0,
        HYDRATION_TIMEOUT_MS: 80,
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
            selectedFields: ['account', 'opportunity_name', 'description']
          };
        },
        async set(patch) {
          return patch;
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

    loadScript(window, 'src/content/field-registry.js');
    loadScript(window, 'src/content/extractors.js');

    const panelId = 'sncrm-overview-panel';
    window.SNCRM.ui = {
      TOGGLE_SHOW: 'Expand',
      TOGGLE_HIDE: 'Collapse',
      buildShell() {
        const panel = window.document.createElement('section');
        panel.id = panelId;
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
        return window.document.getElementById(panelId);
      },
      remove() {
        const panel = window.document.getElementById(panelId);
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
        const description = results.description && results.description.found ? results.description.value : '';
        renders.push(description);
        content.textContent = `${selectedKeys.join(',')}:${results.account.value}|${results.opportunity_name.value}|${description}`;
      }
    };

    loadScript(window, 'src/content/controller.js');
    await window.SNCRM.controller.init();
    await delay(20);

    assertEqual(window.SNCRM.controller._state(), 'mounted', 'expected the overview to mount from the visible record shell');
    assertEqual(renders.length, 1, 'expected one initial render before the hidden section is opened');
    assertEqual(renders[0], '', 'expected hidden section fields to be absent before manual expansion');

    window.document.getElementById('description-toggle').setAttribute('aria-expanded', 'true');
    window.document.getElementById('description-body').style.display = '';
    await delay(30);

    assertEqual(renders.length, 2, 'expected a rerender when the hidden section becomes visible');
    assertEqual(renders[1], 'Important note', 'expected the revealed description to populate the overview');
    assertEqual(
      window.document.getElementById(panelId).textContent,
      'account,opportunity_name,description:Acme|Big Deal|Important note',
      'expected the mounted overview to refresh from the newly opened section'
    );

    window.dispatchEvent(new window.Event('beforeunload'));
    dom.window.close();
  });

  test('controller degrades to an explicit empty state when no record scope ever appears', async () => {
    const dom = makeDom(`
      <body>
        <div id="app-shell"></div>
      </body>
    `, 'https://thehub.soprasteria.com/x/ssasi/crm/record/x_ssasi_crm_opportunity/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/params/selected-tab/id%3Ddetails');
    const { window } = dom;

    let renderSkeletonCalls = 0;
    let renderEmptyCalls = 0;

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
        MOUNT_DEBOUNCE_MS: 0,
        REFRESH_DEBOUNCE_MS: 0,
        HYDRATION_TIMEOUT_MS: 15,
        HYDRATION_POLL_MS: 1,
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
            selectedFields: ['account']
          };
        },
        async set(patch) {
          return patch;
        },
        onChange() {
          return () => {};
        }
      },
      extractors: {
        resolveActiveRecordScope() {
          return null;
        },
        isHydrated() {
          return false;
        },
        extractAll() {
          return {};
        }
      },
      ui: {
        TOGGLE_SHOW: 'Expand',
        TOGGLE_HIDE: 'Collapse',
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
          renderSkeletonCalls++;
          content.textContent = 'loading';
        },
        renderEmpty(content, message, detail) {
          renderEmptyCalls++;
          content.textContent = `${message} ${detail}`;
        },
        renderValues(content) {
          content.textContent = 'values';
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

    loadScript(window, 'src/content/controller.js');
    await window.SNCRM.controller.init();
    await delay(60);

    assertEqual(renderSkeletonCalls, 1, 'expected the controller to show the loading skeleton once');
    assertEqual(renderEmptyCalls, 1, 'expected a single explicit degraded empty state');
    assertEqual(window.SNCRM.controller._state(), 'degraded', 'controller should leave the aggressive waiting loop');
    assertEqual(
      window.document.getElementById('sncrm-overview-panel').textContent,
      'Opportunity overview unavailable on this page. Refresh or reopen the record to try again.',
      'expected the user to see a stable degraded-state message'
    );

    window.dispatchEvent(new window.Event('beforeunload'));
    dom.window.close();
  });

  test('controller uses requestIdleCallback for hydration checks when available', async () => {
    const dom = makeDom(`
      <body>
        <div id="record"></div>
      </body>
    `, 'https://thehub.soprasteria.com/x/ssasi/crm/record/x_ssasi_crm_opportunity/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/params/selected-tab/id%3Ddetails');
    const { window } = dom;

    const idleTimeouts = [];
    let hydrationPasses = 0;

    window.requestIdleCallback = (cb, options = {}) => {
      idleTimeouts.push(options.timeout);
      return window.setTimeout(() => cb({
        didTimeout: false,
        timeRemaining() { return 10; }
      }), 0);
    };
    window.cancelIdleCallback = (id) => window.clearTimeout(id);
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
            selectedFields: ['account']
          };
        },
        async set(patch) {
          return patch;
        },
        onChange() {
          return () => {};
        }
      },
      extractors: {
        resolveActiveRecordScope() {
          return window.document.getElementById('record');
        },
        isHydrated() {
          hydrationPasses += 1;
          return hydrationPasses >= 2;
        },
        extractAll() {
          return {
            account: { key: 'account', found: true, value: 'A', source: 'test' }
          };
        }
      },
      ui: {
        TOGGLE_SHOW: 'Expand',
        TOGGLE_HIDE: 'Collapse',
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
        renderValues(content) {
          content.textContent = 'values';
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

    loadScript(window, 'src/content/controller.js');
    await window.SNCRM.controller.init();
    await delay(25);

    assert(idleTimeouts.length >= 2, 'expected hydration to schedule via requestIdleCallback more than once');
    assertEqual(idleTimeouts[0], 0, 'expected the first hydration check to run immediately');
    assertEqual(idleTimeouts[1], 5, 'expected follow-up hydration checks to use the configured hydration cadence');
    assertEqual(window.SNCRM.controller._state(), 'mounted', 'expected the controller to mount after hydration completes');

    window.dispatchEvent(new window.Event('beforeunload'));
    dom.window.close();
  });

  test('controller watches structure-only rerenders and drops the extra 200ms watchdog', async () => {
    const dom = makeDom(`
      <body>
        <div id="record"></div>
      </body>
    `, 'https://thehub.soprasteria.com/x/ssasi/crm/record/x_ssasi_crm_opportunity/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/params/selected-tab/id%3Ddetails');
    const { window } = dom;
    const panelId = 'sncrm-overview-panel';
    const calls = { apply: 0, clear: 0 };
    const observeCalls = [];
    const timeoutDelays = [];
    const nativeSetTimeout = window.setTimeout.bind(window);
    const nativeClearTimeout = window.clearTimeout.bind(window);

    window.requestIdleCallback = (cb, options = {}) => nativeSetTimeout(() => cb({
      didTimeout: false,
      timeout: options.timeout,
      timeRemaining() { return 10; }
    }), 0);
    window.cancelIdleCallback = (id) => nativeClearTimeout(id);
    window.setTimeout = (fn, delay, ...args) => {
      timeoutDelays.push(delay);
      return nativeSetTimeout(fn, delay, ...args);
    };
    window.MutationObserver = class MutationObserverSpy {
      constructor(callback) {
        this.callback = callback;
      }

      observe(target, options) {
        observeCalls.push({ target, options });
      }

      disconnect() {}
    };

    installControllerEnv(window, {
      enabled: true,
      enhanceOriginalDescription: false,
      largeOriginalDescription: false
    }, { panelId, enhancer: calls });

    loadScript(window, 'src/content/controller.js');
    await window.SNCRM.controller.init();
    await delay(20);

    const rerenderObserve = observeCalls.find((call) => call.target === window.document.body);
    assert(rerenderObserve, 'expected a rerender observer on document.body after mount');
    assertEqual(rerenderObserve.options.childList, true, 'expected rerender observer to watch child additions/removals');
    assertEqual(rerenderObserve.options.subtree, true, 'expected rerender observer to cover the record subtree');
    assert(!Object.prototype.hasOwnProperty.call(rerenderObserve.options, 'characterData'), 'expected characterData observation to be disabled');
    assert(timeoutDelays.includes(3000), 'expected mounted revalidation to schedule at 3000ms');
    assert(!timeoutDelays.includes(200), 'expected the 200ms controller URL watchdog to be removed');

    window.dispatchEvent(new window.Event('beforeunload'));
    dom.window.close();
  });

  test('controller scopes record observers to the ServiceNow app root when present', async () => {
    const dom = makeDom(`
      <body>
        <macroponent-test app-id="crm" macroponent-namespace="x_ssasi">
          <div id="record"></div>
        </macroponent-test>
      </body>
    `, 'https://thehub.soprasteria.com/x/ssasi/crm/record/x_ssasi_crm_opportunity/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/params/selected-tab/id%3Ddetails');
    const { window } = dom;
    const observeCalls = [];

    window.requestIdleCallback = (cb, options = {}) => window.setTimeout(() => cb({
      didTimeout: false,
      timeout: options.timeout,
      timeRemaining() { return 10; }
    }), 0);
    window.cancelIdleCallback = (id) => window.clearTimeout(id);
    window.MutationObserver = class MutationObserverSpy {
      constructor(callback) {
        this.callback = callback;
      }

      observe(target, options) {
        observeCalls.push({ target, options });
      }

      disconnect() {}
    };

    installControllerEnv(window, {
      enabled: true,
      enhanceOriginalDescription: false,
      largeOriginalDescription: false
    }, { panelId: 'sncrm-overview-panel', enhancer: { apply: 0, clear: 0 } });

    loadScript(window, 'src/content/controller.js');
    await window.SNCRM.controller.init();
    await delay(20);

    const appRoot = window.document.querySelector('[app-id][macroponent-namespace]');
    assert(appRoot, 'expected a synthetic ServiceNow app root for the observer scope test');
    assert(
      observeCalls.some((call) => (
        call.target === appRoot &&
        call.options.childList === true &&
        call.options.subtree === true &&
        !Object.prototype.hasOwnProperty.call(call.options, 'attributes')
      )),
      'expected structure observers to scope to the app root instead of the whole document'
    );
    assert(
      observeCalls.some((call) => (
        call.target === appRoot &&
        call.options.attributes === true &&
        Array.isArray(call.options.attributeFilter) &&
        call.options.attributeFilter.includes('aria-expanded')
      )),
      'expected aria-expanded observers to scope to the app root'
    );
    assert(
      observeCalls.some((call) => (
        call.target === window.document.body &&
        call.options.childList === true &&
        !Object.prototype.hasOwnProperty.call(call.options, 'subtree')
      )),
      'expected the body observer to stay shallow and only watch top-level shell churn'
    );
    assert(
      !observeCalls.some((call) => call.target === window.document.documentElement),
      'expected no observer to stay attached to document.documentElement'
    );

    window.dispatchEvent(new window.Event('beforeunload'));
    dom.window.close();
  });

  test('controller stops mounted revalidation while hidden and restarts it when visible again', async () => {
    const dom = makeDom(`
      <body>
        <div id="record"></div>
      </body>
    `, 'https://thehub.soprasteria.com/x/ssasi/crm/record/x_ssasi_crm_opportunity/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/params/selected-tab/id%3Ddetails');
    const { window } = dom;
    const panelId = 'sncrm-overview-panel';
    const calls = { apply: 0, clear: 0 };
    const timeouts = new Map();
    let nextTimeoutId = 1;
    let extractCalls = 0;
    let visibilityState = 'visible';
    const nativeSetTimeout = window.setTimeout.bind(window);
    const nativeClearTimeout = window.clearTimeout.bind(window);

    Object.defineProperty(window.document, 'visibilityState', {
      configurable: true,
      get() {
        return visibilityState;
      }
    });
    window.requestIdleCallback = (cb, options = {}) => nativeSetTimeout(() => cb({
      didTimeout: false,
      timeout: options.timeout,
      timeRemaining() { return 10; }
    }), 0);
    window.cancelIdleCallback = (id) => nativeClearTimeout(id);
    window.setTimeout = (fn, delay) => {
      const id = nextTimeoutId++;
      timeouts.set(id, { fn, delay });
      return id;
    };
    window.clearTimeout = (id) => {
      timeouts.delete(id);
    };

    installControllerEnv(window, {
      enabled: true,
      enhanceOriginalDescription: false,
      largeOriginalDescription: false
    }, { panelId, enhancer: calls });
    window.SNCRM.extractors.extractAll = () => {
      extractCalls++;
      return {
        account: { key: 'account', found: true, value: 'A', source: 'test' }
      };
    };

    loadScript(window, 'src/content/controller.js');
    await window.SNCRM.controller.init();
    await delay(20);

    assertEqual(timeouts.size, 1, 'expected one mounted revalidation timeout after init');
    const [initialTimerId, initialTimer] = Array.from(timeouts.entries())[0];
    assertEqual(initialTimer.delay, 3000, 'expected mounted revalidation to use a 3000ms timeout');

    const baselineExtractCalls = extractCalls;
    visibilityState = 'hidden';
    timeouts.delete(initialTimerId);
    initialTimer.fn();
    assertEqual(
      extractCalls,
      baselineExtractCalls,
      'expected hidden revalidation ticks to exit before extracting fields'
    );

    window.document.dispatchEvent(new window.Event('visibilitychange'));
    assertEqual(timeouts.size, 0, 'expected no revalidation timeout to remain while hidden');

    visibilityState = 'visible';
    window.document.dispatchEvent(new window.Event('visibilitychange'));
    assertEqual(timeouts.size, 1, 'expected revalidation to restart when the tab becomes visible again');
    const [restartedTimerId, restartedTimer] = Array.from(timeouts.entries())[0];
    assert(restartedTimerId !== initialTimerId, 'expected a new timer after visibility recovery');

    restartedTimer.fn();
    assert(
      extractCalls > baselineExtractCalls,
      'expected visible revalidation ticks to resume field extraction'
    );

    window.dispatchEvent(new window.Event('beforeunload'));
    dom.window.close();
  });

  test('controller backs off mounted revalidation and resets it after observer-driven refreshes', async () => {
    const dom = makeDom(`
      <body>
        <div id="record"></div>
      </body>
    `, 'https://thehub.soprasteria.com/x/ssasi/crm/record/x_ssasi_crm_opportunity/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/params/selected-tab/id%3Ddetails');
    const { window } = dom;
    const timeouts = new Map();
    const observers = [];
    let nextTimeoutId = 1;
    const nativeSetTimeout = window.setTimeout.bind(window);
    const nativeClearTimeout = window.clearTimeout.bind(window);

    window.requestIdleCallback = (cb, options = {}) => nativeSetTimeout(() => cb({
      didTimeout: false,
      timeout: options.timeout,
      timeRemaining() { return 10; }
    }), 0);
    window.cancelIdleCallback = (id) => nativeClearTimeout(id);
    window.setTimeout = (fn, delay) => {
      const id = nextTimeoutId++;
      timeouts.set(id, { fn, delay });
      return id;
    };
    window.clearTimeout = (id) => {
      timeouts.delete(id);
    };
    window.MutationObserver = class MutationObserverSpy {
      constructor(callback) {
        this.callback = callback;
      }

      observe(target, options) {
        observers.push({ target, options, instance: this });
      }

      disconnect() {}
    };

    installControllerEnv(window, {
      enabled: true,
      enhanceOriginalDescription: false,
      largeOriginalDescription: false
    }, { panelId: 'sncrm-overview-panel', enhancer: { apply: 0, clear: 0 } });
    window.SNCRM.extractors.extractAll = () => ({
      account: { key: 'account', found: true, value: 'A', source: 'test' }
    });

    loadScript(window, 'src/content/controller.js');
    await window.SNCRM.controller.init();
    await delay(20);

    const runTimeout = (delay) => {
      const match = Array.from(timeouts.entries()).find(([, timer]) => timer.delay === delay);
      assert(match, `expected a pending timeout at ${delay}ms`);
      const [id, timer] = match;
      timeouts.delete(id);
      timer.fn();
    };

    assertEqual(Array.from(timeouts.values())[0].delay, 3000, 'expected the initial revalidation timeout to start at 3000ms');
    runTimeout(3000);
    assertEqual(Array.from(timeouts.values())[0].delay, 6000, 'expected unchanged revalidation to back off to 6000ms');
    runTimeout(6000);
    assertEqual(Array.from(timeouts.values())[0].delay, 12000, 'expected unchanged revalidation to back off again to 12000ms');

    const structureObservers = observers.filter((observer) => (
      observer.target === window.document.body &&
      observer.options.childList === true &&
      observer.options.subtree === true &&
      !Object.prototype.hasOwnProperty.call(observer.options, 'attributes')
    ));
    const structureObserver = structureObservers[structureObservers.length - 1];
    assert(structureObserver, 'expected a mounted structure observer to be registered');

    structureObserver.instance.callback([{
      type: 'childList',
      target: window.document.body,
      addedNodes: [window.document.createElement('div')],
      removedNodes: []
    }]);
    await delay(10);

    assertEqual(Array.from(timeouts.values())[0].delay, 3000, 'expected observer-driven refreshes to reset revalidation back to 3000ms');

    window.dispatchEvent(new window.Event('beforeunload'));
    dom.window.close();
  });

  test('controller backs off completion polling while fields stay missing', async () => {
    const dom = makeDom(`
      <body>
        <div id="record"></div>
      </body>
    `, 'https://thehub.soprasteria.com/x/ssasi/crm/record/x_ssasi_crm_opportunity/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/params/selected-tab/id%3Ddetails');
    const { window } = dom;
    const timeouts = new Map();
    let nextTimeoutId = 1;
    const nativeSetTimeout = window.setTimeout.bind(window);
    const nativeClearTimeout = window.clearTimeout.bind(window);

    window.requestIdleCallback = (cb, options = {}) => nativeSetTimeout(() => cb({
      didTimeout: false,
      timeout: options.timeout,
      timeRemaining() { return 10; }
    }), 0);
    window.cancelIdleCallback = (id) => nativeClearTimeout(id);
    window.setTimeout = (fn, delay) => {
      const id = nextTimeoutId++;
      timeouts.set(id, { fn, delay });
      return id;
    };
    window.clearTimeout = (id) => {
      timeouts.delete(id);
    };

    installControllerEnv(window, {
      enabled: true,
      enhanceOriginalDescription: false,
      largeOriginalDescription: false,
      selectedFields: ['account', 'stage']
    }, { panelId: 'sncrm-overview-panel', enhancer: { apply: 0, clear: 0 } });
    window.SNCRM.extractors.extractAll = () => ({
      account: { key: 'account', found: true, value: 'A', source: 'test' },
      stage: { key: 'stage', found: false, value: '', source: 'none' }
    });

    loadScript(window, 'src/content/controller.js');
    await window.SNCRM.controller.init();
    await delay(20);

    const runTimeout = (delay) => {
      const match = Array.from(timeouts.entries()).find(([, timer]) => timer.delay === delay);
      assert(match, `expected a pending timeout at ${delay}ms`);
      const [id, timer] = match;
      timeouts.delete(id);
      timer.fn();
    };

    assert(
      Array.from(timeouts.values()).some((timer) => timer.delay === 5),
      'expected the initial completion retry to use the hydration poll delay'
    );
    runTimeout(5);
    assert(
      Array.from(timeouts.values()).some((timer) => timer.delay === 10),
      'expected the completion retry to back off to 10ms after an unchanged miss'
    );
    runTimeout(10);
    assert(
      Array.from(timeouts.values()).some((timer) => timer.delay === 20),
      'expected the completion retry to continue backing off while fields remain missing'
    );

    window.dispatchEvent(new window.Event('beforeunload'));
    dom.window.close();
  });

  test('controller keeps extractor caches warm across stable settings rerenders', async () => {
    const dom = makeDom(`
      <body>
        <div id="record"></div>
      </body>
    `, 'https://thehub.soprasteria.com/x/ssasi/crm/record/x_ssasi_crm_opportunity/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/params/selected-tab/id%3Ddetails');
    const { window } = dom;
    const panelId = 'sncrm-overview-panel';
    const env = installControllerEnv(window, {
      enabled: true,
      enhanceOriginalDescription: false,
      largeOriginalDescription: false
    }, { panelId, enhancer: { apply: 0, clear: 0 } });
    let invalidateCalls = 0;
    let renderValuesCalls = 0;

    window.SNCRM.extractors.invalidateCache = () => {
      invalidateCalls++;
    };
    const baseRenderValues = window.SNCRM.ui.renderValues;
    window.SNCRM.ui.renderValues = (...args) => {
      renderValuesCalls++;
      return baseRenderValues(...args);
    };

    loadScript(window, 'src/content/controller.js');
    await window.SNCRM.controller.init();
    await delay(20);

    assertEqual(invalidateCalls, 1, 'expected the initial hydration cycle to invalidate extractor caches once');
    const beforeSettingsRenderCalls = renderValuesCalls;

    env.updateSettings({ columns: 3 });
    await delay(20);

    assert(
      renderValuesCalls > beforeSettingsRenderCalls,
      'expected settings changes to trigger a mounted rerender'
    );
    assertEqual(
      invalidateCalls,
      1,
      'expected stable settings rerenders to reuse warm extractor caches instead of flushing them'
    );

    window.dispatchEvent(new window.Event('beforeunload'));
    dom.window.close();
  });

  test('controller expands sections once per record scope, waits to extract, and resets on manual refresh', async () => {
    const dom = makeDom(`
      <body>
        <div id="record">
          <span class="sn-section-header collapsable" aria-expanded="false">Opportunity Information</span>
        </div>
      </body>
    `, 'https://thehub.soprasteria.com/x/ssasi/crm/record/x_ssasi_crm_opportunity/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/params/selected-tab/id%3Ddetails');
    const { window } = dom;

    let messageHandler = null;
    let settingsListener = null;
    let expandCalls = 0;
    let extractCalls = 0;

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
            selectedFields: ['account']
          };
        },
        async set(patch) {
          return patch;
        },
        onChange(fn) {
          settingsListener = fn;
          return () => {};
        }
      },
      extractors: {
        resolveActiveRecordScope() {
          return window.document.getElementById('record');
        },
        isHydrated() {
          return true;
        },
        extractAll() {
          extractCalls++;
          return {
            account: { key: 'account', found: true, value: 'Acme', source: 'test' }
          };
        }
      },
      ui: {
        TOGGLE_SHOW: 'Expand',
        TOGGLE_HIDE: 'Collapse',
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
          expandCalls++;
          return 1;
        }
      }
    };

    loadScript(window, 'src/content/controller.js');
    await window.SNCRM.controller.init();
    await delay(20);

    assertEqual(expandCalls, 1, 'expected the initial mount to expand collapsed sections once');
    assertEqual(extractCalls, 0, 'expected extraction to wait for section expansion to settle');

    await delay(60);
    assertEqual(extractCalls, 1, 'expected extraction to run after the section expansion settle delay');

    settingsListener({
      enabled: true,
      debug: false,
      defaultCollapsed: false,
      columns: 3,
      autoExpandSections: true,
      panelHeightPercent: 50,
      panelFullHeight: false,
      descriptionAutoHeight: false,
      selectedFields: ['account']
    });
    await delay(20);

    assertEqual(expandCalls, 1, 'expected same-record rerenders to skip redundant section expansion');
    assertEqual(extractCalls, 2, 'expected rerenders to keep extracting after the initial settle');

    messageHandler({ type: 'sncrm/refresh' }, null, () => {});
    await delay(20);

    assertEqual(expandCalls, 2, 'expected manual refresh to reset the section expansion guard');
    assertEqual(extractCalls, 2, 'expected manual refresh to wait for the new expansion pass to settle');

    await delay(60);
    assertEqual(extractCalls, 3, 'expected manual refresh to extract once the refreshed expansion settles');

    window.dispatchEvent(new window.Event('beforeunload'));
    dom.window.close();
  });

  test('controller skips DOM rebuilds when refresh extracts unchanged values', async () => {
    const dom = makeDom(`
      <body>
        <div id="record">
          <now-record-string name="account" value="Acme"></now-record-string>
        </div>
      </body>
    `, 'https://thehub.soprasteria.com/x/ssasi/crm/record/x_ssasi_crm_opportunity/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    const { window } = dom;

    let messageHandler = null;
    let renderValueCalls = 0;
    const debugMessages = [];
    const log = {
      debugEnabled: false,
      setDebug(value) {
        this.debugEnabled = Boolean(value);
      },
      make() {
        return {
          debug(...args) {
            if (!log.debugEnabled) return;
            debugMessages.push(args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' '));
          },
          info() {},
          warn() {},
          error() {}
        };
      }
    };

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
      log,
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
            debug: true,
            defaultCollapsed: false,
            columns: 2,
            autoExpandSections: true,
            panelHeightPercent: 50,
            panelFullHeight: false,
            descriptionAutoHeight: false,
            selectedFields: ['account']
          };
        },
        async set() {},
        onChange() {
          return () => {};
        }
      },
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
        }
      },
      ui: {
        TOGGLE_SHOW: 'Expand',
        TOGGLE_HIDE: 'Collapse',
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

    loadScript(window, 'src/content/controller.js');
    await window.SNCRM.controller.init();
    await delay(20);

    assertEqual(renderValueCalls, 1, 'expected the initial mount to render once');
    messageHandler({ type: 'sncrm/refresh' }, null, () => {});
    await delay(20);

    assertEqual(renderValueCalls, 1, 'expected unchanged refreshes to skip rebuilding the overview DOM');
    assert(
      debugMessages.some((message) => message.includes('values unchanged, skipping render')),
      'expected debug logging when a refresh is diff-skipped'
    );

    window.dispatchEvent(new window.Event('beforeunload'));
    dom.window.close();
  });

  test('controller discards stale render results when the URL changes mid-extract', async () => {
    const dom = makeDom(`
      <body>
        <div id="record-a">
          <span class="sn-section-header collapsable" aria-expanded="true">Opportunity Information</span>
          <span class="sn-section-header collapsable" aria-expanded="true">Description</span>
        </div>
      </body>
    `, 'https://thehub.soprasteria.com/x/ssasi/crm/record/x_ssasi_crm_opportunity/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/params/selected-tab/id%3Ddetails');
    const { window } = dom;

    let renderSkeletonCalls = 0;
    let renderValueCalls = 0;
    const storageWrites = [];

    const panelId = 'sncrm-overview-panel';
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
        MOUNT_DEBOUNCE_MS: 0,
        REFRESH_DEBOUNCE_MS: 0,
        HYDRATION_TIMEOUT_MS: 25,
        HYDRATION_POLL_MS: 0,
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
            selectedFields: ['account']
          };
        },
        async set(patch) {
          storageWrites.push(patch);
          return patch;
        },
        onChange() {
          return () => {};
        }
      },
      extractors: {
        resolveActiveRecordScope() {
          return window.document.getElementById('record-a');
        },
        isHydrated() {
          return true;
        },
        extractAll() {
          window.history.replaceState(
            {},
            '',
            '/x/ssasi/crm/record/x_ssasi_crm_opportunity/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/params/selected-tab/id%3Ddetails'
          );
          return {
            account: { key: 'account', found: true, value: 'Opportunity A', source: 'test' }
          };
        }
      },
      ui: {
        TOGGLE_SHOW: 'Expand',
        TOGGLE_HIDE: 'Collapse',
        buildShell() {
          const panel = window.document.createElement('section');
          panel.id = panelId;
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
          return window.document.getElementById(panelId);
        },
        remove() {
          const panel = window.document.getElementById(panelId);
          if (panel && panel.parentNode) panel.parentNode.removeChild(panel);
        },
        attachResize() {},
        renderSkeleton(content) {
          renderSkeletonCalls++;
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

    loadScript(window, 'src/content/controller.js');
    await window.SNCRM.controller.init();
    await delay(20);

    const panel = window.document.getElementById(panelId);
    assert(panel, 'expected the overview panel shell to be mounted');
    assertEqual(renderSkeletonCalls, 1, 'expected the new record to show a loading skeleton');
    assertEqual(renderValueCalls, 0, 'stale extraction output must not be rendered');
    assertEqual(storageWrites.length, 0, 'controller should not persist opportunity data to storage');
    assert(window.SNCRM.controller._state() !== 'mounted', 'controller should stay out of mounted state for stale results');
    assertEqual(panel.textContent, 'loading', 'panel should remain in loading state until the next record is ready');

    window.dispatchEvent(new window.Event('beforeunload'));
    dom.window.close();
  });

  test('controller applies the description enhancer without mounting the panel when overview is disabled', async () => {
    const dom = makeDom(`
      <body>
        <div id="record">
          <textarea name="description">x</textarea>
        </div>
      </body>
    `, 'https://thehub.soprasteria.com/x/ssasi/crm/record/x_ssasi_crm_opportunity/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/params/selected-tab/id%3Ddetails');
    const { window } = dom;
    const panelId = 'sncrm-overview-panel';
    const calls = { apply: 0, clear: 0 };
    installControllerEnv(window, {
      enabled: false,
      enhanceOriginalDescription: true,
      largeOriginalDescription: false
    }, { panelId, enhancer: calls, capture: { statuses: [] } });

    loadScript(window, 'src/content/controller.js');
    await window.SNCRM.controller.init();
    await delay(20);

    assert(calls.apply >= 1, 'expected the enhancer to be applied in description-only mode');
    assertEqual(calls.clear, 0, 'expected no enhancer clear in description-only mode');
    assertEqual(window.document.getElementById(panelId), null, 'expected the overview panel to remain absent');
    const status = requestStatus(window);
    assertEqual(status.mounted, false, 'expected GET_STATUS.mounted to be false when only description features are active');
    window.dispatchEvent(new window.Event('beforeunload'));
    dom.window.close();
  });

  test('disabling the panel while description features stay on removes only the panel', async () => {
    const dom = makeDom(`
      <body>
        <div id="record">
          <textarea name="description">x</textarea>
        </div>
      </body>
    `, 'https://thehub.soprasteria.com/x/ssasi/crm/record/x_ssasi_crm_opportunity/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/params/selected-tab/id%3Ddetails');
    const { window } = dom;
    const panelId = 'sncrm-overview-panel';
    const calls = { apply: 0, clear: 0 };
    const env = installControllerEnv(window, {
      enabled: true,
      enhanceOriginalDescription: true,
      largeOriginalDescription: false
    }, { panelId, enhancer: calls });

    loadScript(window, 'src/content/controller.js');
    await window.SNCRM.controller.init();
    await delay(20);
    assert(window.document.getElementById(panelId), 'expected the overview panel to mount initially');
    const clearsBefore = calls.clear;

    env.updateSettings({
      enabled: false,
      enhanceOriginalDescription: true,
      largeOriginalDescription: false
    });
    await delay(20);

    assertEqual(window.document.getElementById(panelId), null, 'expected panel to be removed when overview is disabled');
    assertEqual(calls.clear, clearsBefore + 1, 'expected the enhancer state to be cleared before description-only mode takes over');
    assert(calls.apply >= 2, 'expected description-only mode to re-apply the enhancer after panel teardown');

    window.dispatchEvent(new window.Event('beforeunload'));
    dom.window.close();
  });

  test('description-only record changes clear enhancer state before reapply', async () => {
    const dom = makeDom(`
      <body>
        <div id="record">
          <textarea name="description">x</textarea>
        </div>
      </body>
    `, 'https://thehub.soprasteria.com/x/ssasi/crm/record/x_ssasi_crm_opportunity/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/params/selected-tab/id%3Ddetails');
    const { window } = dom;
    const panelId = 'sncrm-overview-panel';
    const calls = { apply: 0, clear: 0 };
    const env = installControllerEnv(window, {
      enabled: false,
      enhanceOriginalDescription: true,
      largeOriginalDescription: false
    }, { panelId, enhancer: calls });

    loadScript(window, 'src/content/controller.js');
    await window.SNCRM.controller.init();
    await delay(20);

    const applyCountBeforeRecordChange = calls.apply;
    const clearCountBeforeRecordChange = calls.clear;
    window.history.replaceState(
      {},
      '',
      '/x/ssasi/crm/record/x_ssasi_crm_opportunity/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/params/selected-tab/id%3Ddetails'
    );
    env.updateSettings({
      enabled: false,
      enhanceOriginalDescription: true,
      largeOriginalDescription: false
    });
    await delay(20);

    assertEqual(
      calls.clear,
      clearCountBeforeRecordChange + 1,
      'expected record changes in description-only mode to clear the prior enhancer state'
    );
    assert(
      calls.apply >= applyCountBeforeRecordChange + 1,
      'expected description-only mode to re-apply the enhancer after the record changes'
    );

    window.dispatchEvent(new window.Event('beforeunload'));
    dom.window.close();
  });

  test('disabling panel and description features tears down both', async () => {
    const dom = makeDom(`
      <body>
        <div id="record">
          <textarea name="description">x</textarea>
        </div>
      </body>
    `, 'https://thehub.soprasteria.com/x/ssasi/crm/record/x_ssasi_crm_opportunity/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/params/selected-tab/id%3Ddetails');
    const { window } = dom;
    const panelId = 'sncrm-overview-panel';
    const calls = { apply: 0, clear: 0 };
    const env = installControllerEnv(window, {
      enabled: true,
      enhanceOriginalDescription: true,
      largeOriginalDescription: false
    }, { panelId, enhancer: calls });

    loadScript(window, 'src/content/controller.js');
    await window.SNCRM.controller.init();
    await delay(20);

    env.updateSettings({
      enabled: false,
      enhanceOriginalDescription: false,
      largeOriginalDescription: false,
      originalDescriptionHeight: null
    });
    await delay(20);

    assertEqual(window.document.getElementById(panelId), null, 'expected the panel to be removed');
    assert(calls.clear >= 1, 'expected the enhancer to be cleared when all description features are off');

    window.dispatchEvent(new window.Event('beforeunload'));
    dom.window.close();
  });

  await Promise.all(pending);
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

function installControllerEnv(window, initialSettings, opts) {
  const panelId = opts.panelId;
  const calls = opts.enhancer;
  const listeners = [];
  let currentSettings = Object.assign({
    debug: false,
    defaultCollapsed: false,
    columns: 2,
    autoExpandSections: true,
    panelHeightPercent: 50,
    panelFullHeight: false,
    descriptionAutoHeight: false,
    selectedFields: ['account']
  }, initialSettings);
  let messageHandler = null;
  window.chrome = {
    runtime: {
      onMessage: {
        addListener(fn) { messageHandler = fn; }
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
      isSupportedUrl(url) { return /\/x\/ssasi\/crm\/record\/x_ssasi_crm_opportunity\//.test(url); },
      extractRecordId: parseRecordId
    },
    storage: {
      async get() { return Object.assign({}, currentSettings); },
      async set(patch) { return patch; },
      onChange(fn) { listeners.push(fn); return () => {}; }
    },
    extractors: {
      resolveActiveRecordScope() { return window.document.getElementById('record'); },
      isHydrated() { return true; },
      extractAll() {
        return {
          account: { key: 'account', found: true, value: 'A', source: 'test' }
        };
      }
    },
    originalDescriptionEnhancer: {
      apply() { calls.apply++; return true; },
      clear() { calls.clear++; }
    },
    ui: {
      TOGGLE_SHOW: 'Expand',
      TOGGLE_HIDE: 'Collapse',
      buildShell() {
        const panel = window.document.createElement('section');
        panel.id = panelId;
        const body = window.document.createElement('div');
        const content = window.document.createElement('div');
        body.appendChild(content);
        panel.appendChild(body);
        return { panel, body, content };
      },
      mountInto(panel) { window.document.body.insertBefore(panel, window.document.body.firstChild); return window.document.body; },
      existing() { return window.document.getElementById(panelId); },
      remove() { const p = window.document.getElementById(panelId); if (p && p.parentNode) p.parentNode.removeChild(p); },
      attachResize() {},
      renderSkeleton(content) { content.textContent = 'loading'; },
      renderEmpty(content, message) { content.textContent = message; },
      renderValues(content) { content.textContent = 'values'; }
    },
    navigation: { start() { return () => {}; } },
    messages: { send() { return Promise.resolve({ ok: true }); } },
    sectionExpander: { expandAll() { return 0; } }
  };
  return {
    updateSettings(patch) {
      currentSettings = Object.assign({}, currentSettings, patch);
      const snap = Object.assign({}, currentSettings);
      for (const l of listeners) l(snap);
    },
    getMessageHandler() { return messageHandler; }
  };
}

function requestStatus(window) {
  let captured = null;
  const handler = window.SNCRM && window.SNCRM._messageHandler;
  // Controller registers via chrome.runtime.onMessage.addListener in init().
  // We poke it through the exposed hook if present; otherwise just read state.
  if (typeof handler === 'function') {
    handler({ type: 'sncrm/get-status' }, null, (resp) => { captured = resp; });
  }
  if (!captured) {
    captured = {
      mounted: window.SNCRM.controller._state() === 'mounted' || window.SNCRM.controller._state() === 'degraded'
    };
  }
  return captured;
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
