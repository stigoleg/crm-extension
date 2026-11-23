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

function loadScript(window, relPath) {
  const src = fs.readFileSync(path.join(__dirname, '..', relPath), 'utf8');
  window.eval(src);
}

function makeDom() {
  const dom = new JSDOM(`
    <!doctype html>
    <html>
      <body>
        <input type="checkbox" id="enabled">
        <input type="checkbox" id="startExpanded">
        <input type="checkbox" id="autoExpandSections">
        <input type="checkbox" id="panelFullHeight">
        <input type="checkbox" id="descriptionAutoHeight">
        <input type="checkbox" id="enhanceOriginalDescription">
        <input type="checkbox" id="largeOriginalDescription">
        <select id="descriptionCopyFormat"><option value="markdown">Raw markdown</option><option value="rich">Rich text (HTML)</option></select>
        <input type="checkbox" id="debug">
        <section id="detectedFieldsCard" hidden><div id="detectedFields"></div></section>
        <div id="layoutGrid"></div>
        <div id="columnsSegment">
          <button type="button" data-cols="2">2</button>
          <button type="button" data-cols="3">3</button>
          <button type="button" data-cols="4">4</button>
        </div>
        <button type="button" id="addEmptyCell"></button>
        <div id="saveIndicator"></div>
        <button type="button" id="selectAll"></button>
        <button type="button" id="selectNone"></button>
        <button type="button" id="resetDefaults"></button>
        <section id="fields"></section>
      </body>
    </html>
  `, {
    runScripts: 'outside-only',
    url: 'https://extension-settings.local/'
  });
  const { window } = dom;
  window.self = window;
  if (!window.CSS) window.CSS = {};
  if (!window.CSS.escape) {
    window.CSS.escape = (value) => String(value).replace(/["\\]/g, '\\$&');
  }
  return dom;
}

async function run() {
  console.log('options detected fields');

  test('detected field card stays hidden when there are no persisted discoveries', async () => {
    const dom = makeDom();
    const { window } = dom;

    const defaultSettings = {
      enabled: true,
      debug: false,
      defaultCollapsed: false,
      columns: 3,
      autoExpandSections: true,
      panelHeightPercent: 50,
      panelFullHeight: true,
      descriptionAutoHeight: true,
      enhanceOriginalDescription: false,
      largeOriginalDescription: false,
      fieldLayout: [{ type: 'field', key: 'account', span: 1 }],
      selectedFields: ['account']
    };

    window.SNCRM = {
      storage: {
        DEFAULTS: JSON.parse(JSON.stringify(defaultSettings)),
        async get() {
          return JSON.parse(JSON.stringify(defaultSettings));
        },
        async set(patch) {
          Object.assign(defaultSettings, patch);
          return JSON.parse(JSON.stringify(defaultSettings));
        },
        onChange() {}
      },
      discoveryStore: {
        async get() {
          return [];
        },
        onChange() {}
      }
    };

    loadScript(window, 'src/content/field-registry.js');
    loadScript(window, 'src/options/options.js');
    await delay(20);

    assertEqual(window.document.getElementById('detectedFieldsCard').hidden, true, 'expected the detected fields card to stay hidden when there are no discoveries');

    dom.window.close();
  });

  test('detected field card appears above Fields and toggling a discovered field updates the layout', async () => {
    const dom = makeDom();
    const { window } = dom;

    const savedPatches = [];
    const settings = {
      enabled: true,
      debug: false,
      defaultCollapsed: false,
      columns: 3,
      autoExpandSections: true,
      panelHeightPercent: 50,
      panelFullHeight: true,
      descriptionAutoHeight: true,
      enhanceOriginalDescription: false,
      largeOriginalDescription: false,
      fieldLayout: [{ type: 'field', key: 'account', span: 1 }],
      selectedFields: ['account']
    };

    window.SNCRM = {
      storage: {
        DEFAULTS: JSON.parse(JSON.stringify(settings)),
        async get() {
          return JSON.parse(JSON.stringify(settings));
        },
        async set(patch) {
          savedPatches.push(JSON.parse(JSON.stringify(patch)));
          Object.assign(settings, patch);
          return JSON.parse(JSON.stringify(settings));
        },
        onChange() {}
      },
      discoveryStore: {
        async get() {
          return [{
            key: 'detected:partner_focus',
            serviceNowName: 'partner_focus',
            label: 'Partner Focus',
            group: 'Opportunity Information',
            renderAs: 'text',
            reason: 'new-field',
            firstSeenAt: 1,
            lastSeenAt: 1
          }];
        },
        onChange() {}
      }
    };

    loadScript(window, 'src/content/field-registry.js');
    loadScript(window, 'src/options/options.js');
    await delay(20);

    const detectedCard = window.document.getElementById('detectedFieldsCard');
    const fieldsSection = window.document.getElementById('fields');
    assertEqual(detectedCard.hidden, false, 'expected the detected fields card to be visible when discoveries exist');
    assert(detectedCard.compareDocumentPosition(fieldsSection) & window.Node.DOCUMENT_POSITION_FOLLOWING, 'expected the detected fields card to render before the regular Fields section');

    const checkbox = window.document.querySelector('#detectedFields input[data-key="detected:partner_focus"]');
    assert(checkbox, 'expected the detected field to render as a selectable checkbox');
    const headings = Array.from(window.document.querySelectorAll('#detectedFields .group-title')).map((node) => node.textContent.trim());
    assertEqual(headings.join(','), 'Opportunity Information', 'expected detected fields to be grouped under their ServiceNow section heading');
    const helpText = window.document.querySelector('#detectedFields .row-help');
    assert(helpText, 'expected detected field rows to include add-location help text');
    assert(helpText.textContent.includes('partner_focus'), 'expected detected field rows to show the raw ServiceNow field name');
    assert(helpText.textContent.includes('Opportunity Information'), 'expected detected field rows to mention the section to update in the registry');
    checkbox.checked = true;
    checkbox.dispatchEvent(new window.Event('change', { bubbles: true }));
    await delay(260);

    assert(
      savedPatches.some((patch) => Array.isArray(patch.fieldLayout) && patch.fieldLayout.some((item) => item.key === 'detected:partner_focus')),
      'expected selecting a detected field to save it through the normal fieldLayout flow'
    );
    assert(
      Array.from(window.document.querySelectorAll('#layoutGrid .chip-label')).some((node) => node.textContent.trim() === 'Partner Focus'),
      'expected selecting a detected field to add it to the layout grid with the inferred label'
    );

    dom.window.close();
  });

  test('persisted known-field discovery groups the Fields card by the live section and stays out of the detected card', async () => {
    const dom = makeDom();
    const { window } = dom;

    const settings = {
      enabled: true,
      debug: false,
      defaultCollapsed: false,
      columns: 3,
      autoExpandSections: true,
      panelHeightPercent: 50,
      panelFullHeight: true,
      descriptionAutoHeight: true,
      enhanceOriginalDescription: false,
      largeOriginalDescription: false,
      fieldLayout: [{ type: 'field', key: 'account', span: 1 }],
      selectedFields: ['account']
    };

    window.SNCRM = {
      storage: {
        DEFAULTS: JSON.parse(JSON.stringify(settings)),
        async get() {
          return JSON.parse(JSON.stringify(settings));
        },
        async set(patch) {
          Object.assign(settings, patch);
          return JSON.parse(JSON.stringify(settings));
        },
        onChange() {}
      },
      discoveryStore: {
        async get() {
          return [{
            key: 'account',
            serviceNowName: 'account',
            label: 'Account',
            group: 'Deal Team',
            renderAs: 'text',
            reason: 'known',
            matchedRegistryKey: 'account',
            firstSeenAt: 1,
            lastSeenAt: 1
          }];
        },
        onChange() {}
      }
    };

    loadScript(window, 'src/content/field-registry.js');
    loadScript(window, 'src/options/options.js');
    await delay(20);

    const fieldsSection = window.document.getElementById('fields');
    const groupHeadings = Array.from(fieldsSection.querySelectorAll('.group-title')).map((node) => node.textContent.trim());
    assert(groupHeadings.includes('Deal Team'), 'expected the Fields card to group the known field under its live section');
    const labels = Array.from(fieldsSection.querySelectorAll('label')).map((node) => node.textContent.trim());
    assert(labels.some((text) => text.startsWith('Account')), 'expected the Account field to remain in the Fields card');

    const detectedCard = window.document.getElementById('detectedFieldsCard');
    assertEqual(detectedCard.hidden, true, 'expected a known field not to appear in the detected field changes card');

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
