'use strict';

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (err) {
    failed++;
    console.log(`  FAIL ${name}`);
    console.log(`       ${err.message}`);
    if (err.stack) console.log(err.stack.split('\n').slice(1).join('\n'));
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`);
  }
}

function loadScript(window, relPath) {
  const src = fs.readFileSync(path.join(__dirname, '..', relPath), 'utf8');
  window.eval(src);
}

function makeDom() {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    runScripts: 'outside-only',
    url: 'https://thehub.soprasteria.com/'
  });
  const { window } = dom;
  window.self = window;
  if (!window.CSS) window.CSS = {};
  if (!window.CSS.escape) {
    window.CSS.escape = (value) => String(value).replace(/["\\]/g, '\\$&');
  }
  return dom;
}

function makeUiHarness() {
  const dom = makeDom();
  const { window } = dom;
  window.SNCRM = {
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
      PANEL_ID: 'sncrm-overview-panel'
    },
    dates: {
      parseSnDate() { return null; },
      daysUntil() { return 0; },
      countdownTone() { return 'neutral'; },
      countdownLabel() { return ''; }
    },
    markdown: {
      render(value) { return String(value || ''); }
    }
  };
  window.open = () => null;
  loadScript(window, 'src/content/field-registry.js');
  loadScript(window, 'src/content/ui.js');
  return { dom, window, ui: window.SNCRM.ui };
}

function setViewportWidth(window, width) {
  Object.defineProperty(window, 'innerWidth', {
    configurable: true,
    writable: true,
    value: width
  });
}

console.log('ui render');

test('integer cards use spaces as thousand separators', () => {
  const { dom, window, ui } = makeUiHarness();
  const host = window.document.createElement('div');
  ui.renderValues(host, ['assignment_amount'], {
    assignment_amount: {
      key: 'assignment_amount',
      found: true,
      value: '1234567',
      source: 'test'
    }
  }, {
    columns: 3,
    layout: [{ type: 'field', key: 'assignment_amount', span: 1 }]
  });

  const value = host.querySelector('.sncrm-card-value');
  assert(value, 'expected a rendered number card');
  assertEqual(value.textContent.trim(), '1 234 567', 'expected integer formatting to use spaces');

  dom.window.close();
});

test('badge fields render pill-style tags', () => {
  const { dom, window, ui } = makeUiHarness();
  const host = window.document.createElement('div');
  ui.renderValues(host, ['apps_community', 'bu_lead'], {
    apps_community: {
      key: 'apps_community',
      found: true,
      value: 'Cloud, Data',
      badges: ['Cloud', 'Data'],
      source: 'test'
    },
    bu_lead: {
      key: 'bu_lead',
      found: true,
      value: 'Jane Doe',
      source: 'test'
    }
  }, {
    columns: 3,
    layout: [
      { type: 'field', key: 'apps_community', span: 1 },
      { type: 'field', key: 'bu_lead', span: 1 }
    ]
  });

  const tags = Array.from(host.querySelectorAll('.sncrm-tag')).map((node) => node.textContent.trim());
  assertEqual(tags.join('|'), 'Cloud|Data|Jane Doe', 'expected badge-capable fields to render tags');

  dom.window.close();
});

test('layout rendering keeps explicit spacers and spans', () => {
  const { dom, window, ui } = makeUiHarness();
  const host = window.document.createElement('div');
  ui.renderValues(host, ['account', 'stage'], {
    account: { key: 'account', found: true, value: 'Acme', source: 'test' },
    stage: { key: 'stage', found: true, value: 'Proposal', source: 'test' }
  }, {
    columns: 4,
    layout: [
      { type: 'field', key: 'account', span: 2 },
      { type: 'empty', id: 'empty-1', span: 1 },
      { type: 'field', key: 'stage', span: 1 }
    ]
  });

  const cards = host.querySelectorAll('.sncrm-card');
  const spacer = host.querySelector('.sncrm-spacer');
  assertEqual(cards.length, 2, 'expected two rendered field cards');
  assert(spacer, 'expected an explicit spacer cell in the rendered grid');
  assertEqual(cards[0].style.gridColumn, 'span 2', 'expected the first card to span two columns');

  dom.window.close();
});

test('rerender updates changed fields in place and preserves unchanged markdown scroll state', () => {
  const { dom, window, ui } = makeUiHarness();
  const host = window.document.createElement('div');
  const selectedKeys = ['description', 'stage'];
  const layout = [
    { type: 'field', key: 'description', span: 3 },
    { type: 'field', key: 'stage', span: 1 }
  ];

  ui.renderValues(host, selectedKeys, {
    description: { key: 'description', found: true, value: 'Initial description', source: 'test' },
    stage: { key: 'stage', found: true, value: 'Qualification', source: 'test' }
  }, {
    columns: 3,
    descriptionAutoHeight: true,
    layout
  });

  const grid = host.querySelector('.sncrm-cards');
  const descriptionBlock = host.querySelector('.sncrm-md-description');
  const descriptionBody = descriptionBlock.querySelector('.sncrm-md-body');
  const stageCard = host.querySelector('.sncrm-card');
  descriptionBody.scrollTop = 48;

  ui.renderValues(host, selectedKeys, {
    description: { key: 'description', found: true, value: 'Initial description', source: 'test' },
    stage: { key: 'stage', found: true, value: 'Proposal', source: 'test' }
  }, {
    columns: 3,
    descriptionAutoHeight: true,
    layout
  });

  assert(host.querySelector('.sncrm-cards') === grid, 'expected the grid container to be reused across rerenders');
  assert(host.querySelector('.sncrm-md-description') === descriptionBlock, 'expected unchanged markdown blocks to keep the same DOM node');
  assert(descriptionBlock.querySelector('.sncrm-md-body') === descriptionBody, 'expected unchanged markdown content to keep the same scroll container');
  assertEqual(descriptionBody.scrollTop, 48, 'expected unchanged markdown scroll position to be preserved');
  assert(host.querySelector('.sncrm-card') === stageCard, 'expected changed short-form fields to update in place');
  assertEqual(
    stageCard.querySelector('.sncrm-card-value').textContent.trim(),
    'Proposal',
    'expected the changed card value to update without replacing the card node'
  );

  dom.window.close();
});

test('responsive grid uses one column on mobile, two on tablet, and settings on desktop', () => {
  const mobile = makeUiHarness();
  setViewportWidth(mobile.window, 640);
  let host = mobile.window.document.createElement('div');
  mobile.ui.renderValues(host, ['account'], {
    account: { key: 'account', found: true, value: 'Acme', source: 'test' }
  }, {
    columns: 4,
    layout: [{ type: 'field', key: 'account', span: 1 }]
  });
  assertEqual(
    host.querySelector('.sncrm-cards').style.getPropertyValue('--sncrm-columns'),
    '1',
    'expected mobile layouts to collapse to one column'
  );
  mobile.dom.window.close();

  const tablet = makeUiHarness();
  setViewportWidth(tablet.window, 900);
  host = tablet.window.document.createElement('div');
  tablet.ui.renderValues(host, ['account'], {
    account: { key: 'account', found: true, value: 'Acme', source: 'test' }
  }, {
    columns: 4,
    layout: [{ type: 'field', key: 'account', span: 1 }]
  });
  assertEqual(
    host.querySelector('.sncrm-cards').style.getPropertyValue('--sncrm-columns'),
    '2',
    'expected tablet layouts to clamp to two columns'
  );
  tablet.dom.window.close();

  const desktop = makeUiHarness();
  setViewportWidth(desktop.window, 1366);
  host = desktop.window.document.createElement('div');
  desktop.ui.renderValues(host, ['account'], {
    account: { key: 'account', found: true, value: 'Acme', source: 'test' }
  }, {
    columns: 4,
    layout: [{ type: 'field', key: 'account', span: 1 }]
  });
  assertEqual(
    host.querySelector('.sncrm-cards').style.getPropertyValue('--sncrm-columns'),
    '4',
    'expected desktop layouts to honor the configured column count'
  );
  desktop.dom.window.close();
});

test('link cards keep absolute SharePoint URLs and open them in a new tab', () => {
  const { dom, window, ui } = makeUiHarness();
  const host = window.document.createElement('div');
  let opened = null;
  window.open = (url, target, features) => {
    opened = { url, target, features };
    return null;
  };

  ui.renderValues(host, ['bid_room'], {
    bid_room: {
      key: 'bid_room',
      found: true,
      value: 'https://steria.sharepoint.com/sites/intra_sc_tilbud_sn1/335c0d7a2bcc0f546f1efe01fe91bf4a',
      source: 'test'
    }
  }, {
    columns: 3,
    layout: [{ type: 'field', key: 'bid_room', span: 1 }]
  });

  const link = host.querySelector('.sncrm-link');
  assert(link, 'expected the bid room field to render as a link');
  assertEqual(
    link.getAttribute('href'),
    'https://steria.sharepoint.com/sites/intra_sc_tilbud_sn1/335c0d7a2bcc0f546f1efe01fe91bf4a',
    'expected the rendered link href to keep the SharePoint URL'
  );
  assertEqual(link.getAttribute('target'), '_blank', 'expected bid room links to target a new tab');
  assertEqual(link.getAttribute('rel'), 'noopener', 'expected no extra rel flags to strip navigation context');

  link.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  assert(opened, 'expected clicking the rendered bid room link to call window.open');
  assertEqual(opened.url, link.getAttribute('href'), 'expected window.open to receive the SharePoint URL');
  assertEqual(opened.target, '_blank', 'expected window.open to use a new tab target');

  dom.window.close();
});

test('panel resize handle works without layout rect reads', () => {
  const { dom, window, ui } = makeUiHarness();
  Object.defineProperty(window, 'innerHeight', {
    configurable: true,
    writable: true,
    value: 1000
  });

  const shell = ui.buildShell({
    collapsed: false,
    onToggle() {},
    onRefresh() {},
    onConfigure() {}
  });

  let persisted = null;
  ui.attachResize(shell, 40, (next) => { persisted = next; });
  const handle = shell.body.querySelector('.sncrm-resize-handle');
  assert(handle, 'expected the resize handle to be mounted');

  window.Element.prototype.getBoundingClientRect = function getBoundingClientRect() {
    throw new Error('getBoundingClientRect should not be used by attachResize');
  };

  const down = new window.Event('pointerdown', { bubbles: true, cancelable: true });
  Object.assign(down, { clientY: 100 });
  handle.dispatchEvent(down);

  const move = new window.Event('pointermove', { bubbles: true, cancelable: true });
  Object.assign(move, { clientY: 150 });
  window.document.dispatchEvent(move);

  const up = new window.Event('pointerup', { bubbles: true, cancelable: true });
  Object.assign(up, { clientY: 150 });
  window.document.dispatchEvent(up);

  assertEqual(persisted, 45, 'expected drag distance to persist as viewport-relative height');

  const keyDown = new window.Event('keydown', { bubbles: true, cancelable: true });
  Object.assign(keyDown, { key: 'ArrowDown' });
  handle.dispatchEvent(keyDown);
  assertEqual(persisted, 50, 'expected keyboard resize to build on the tracked percentage instead of reading layout');

  dom.window.close();
});

test('panel resize drag batches writes into a single animation frame', () => {
  const { dom, window, ui } = makeUiHarness();
  Object.defineProperty(window, 'innerHeight', {
    configurable: true,
    writable: true,
    value: 1000
  });

  const queuedFrames = new Map();
  let nextFrameId = 1;
  window.requestAnimationFrame = (cb) => {
    const id = nextFrameId++;
    queuedFrames.set(id, cb);
    return id;
  };
  window.cancelAnimationFrame = (id) => {
    queuedFrames.delete(id);
  };

  const shell = ui.buildShell({
    collapsed: false,
    onToggle() {},
    onRefresh() {},
    onConfigure() {}
  });

  let persisted = null;
  ui.attachResize(shell, 40, (next) => { persisted = next; });
  const handle = shell.body.querySelector('.sncrm-resize-handle');
  assert(handle, 'expected the resize handle to be mounted');

  const initialHeight = shell.body.style.maxHeight;

  const down = new window.Event('pointerdown', { bubbles: true, cancelable: true });
  Object.assign(down, { clientY: 100 });
  handle.dispatchEvent(down);

  const moveA = new window.Event('pointermove', { bubbles: true, cancelable: true });
  Object.assign(moveA, { clientY: 150 });
  window.document.dispatchEvent(moveA);

  const moveB = new window.Event('pointermove', { bubbles: true, cancelable: true });
  Object.assign(moveB, { clientY: 200 });
  window.document.dispatchEvent(moveB);

  assertEqual(queuedFrames.size, 1, 'expected drag updates to schedule only one animation frame at a time');
  assertEqual(shell.body.style.maxHeight, initialHeight, 'expected max-height writes to wait for the scheduled animation frame');

  const [frameId, frameCallback] = Array.from(queuedFrames.entries())[0];
  queuedFrames.delete(frameId);
  frameCallback();

  assertEqual(
    shell.body.style.maxHeight,
    'calc(50vh - var(--sncrm-topbar-height, 55px))',
    'expected the latest drag position to win when the scheduled frame runs'
  );

  const up = new window.Event('pointerup', { bubbles: true, cancelable: true });
  Object.assign(up, { clientY: 200 });
  window.document.dispatchEvent(up);

  assertEqual(persisted, 50, 'expected the persisted height to use the final coalesced drag position');

  dom.window.close();
});

test('panel styles keep containment while avoiding expensive permanent layer promotion', () => {
  const styles = fs.readFileSync(path.join(__dirname, '..', 'src/content/styles.css'), 'utf8');

  assert(
    /#sncrm-overview-panel\s*\{[\s\S]*?contain:\s*layout paint;/.test(styles),
    'expected the overview panel root to use layout+paint containment'
  );
  assert(
    /#sncrm-overview-panel\s*\{[\s\S]*?min-height:\s*var\(--sncrm-topbar-height,\s*55px\);/.test(styles),
    'expected the overview panel root to keep enough height for the floating header when collapsed'
  );
  assert(
    !/#sncrm-overview-panel\s*\{[\s\S]*?will-change:\s*transform;/.test(styles),
    'expected the overview panel root to avoid a permanent transform layer hint'
  );
  assert(
    /#sncrm-overview-panel \.sncrm-body\s*\{[\s\S]*?contain:\s*layout paint;/.test(styles),
    'expected the panel body scroll container to use layout+paint containment'
  );
  assert(
    /#sncrm-overview-panel \.sncrm-cards\s*\{[\s\S]*?contain:\s*layout;/.test(styles),
    'expected the card grid to isolate layout reflows inside the panel'
  );
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
