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

function installDomStubs(window) {
  window.self = window;
  Object.defineProperty(window, 'innerWidth', {
    configurable: true,
    writable: true,
    value: 1280
  });
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
    const height = Number((this.style && this.style.height || '').replace('px', '')) || 32;
    return { width: 120, height, top: 0, right: 120, bottom: height, left: 0 };
  };
  if (!window.Element.prototype.setPointerCapture) {
    window.Element.prototype.setPointerCapture = function () {};
  }
  if (!window.Element.prototype.releasePointerCapture) {
    window.Element.prototype.releasePointerCapture = function () {};
  }
  if (!window.Element.prototype.hasPointerCapture) {
    window.Element.prototype.hasPointerCapture = function () { return false; };
  }
}

function fireHandleEvent(window, node, type, payload = {}) {
  const ev = new window.Event(type, { bubbles: true, cancelable: true });
  Object.assign(ev, { pointerId: 1, button: 0 }, payload);
  node.dispatchEvent(ev);
  return ev;
}

function dragHandle(window, handle, deltaY) {
  fireHandleEvent(window, handle, 'pointerdown', { clientY: 0 });
  fireHandleEvent(window, handle, 'pointermove', { clientY: deltaY });
  fireHandleEvent(window, handle, 'pointerup', { clientY: deltaY });
}

function makeDom(html) {
  const dom = new JSDOM(html, {
    runScripts: 'outside-only',
    url: 'https://thehub.soprasteria.com/x/ssasi/crm/record/x_ssasi_crm_opportunity/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
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

function loadEnhancer(window, extras = {}) {
  window.SNCRM = Object.assign({
    log: makeLog(),
    storage: {
      set() { return Promise.resolve(); }
    }
  }, extras);
  loadScript(window, 'src/content/field-registry.js');
  loadScript(window, 'src/content/extractors.js');
  loadScript(window, 'src/content/original-description-enhancer.js');
  return window.SNCRM.originalDescriptionEnhancer;
}

function installScrollHeightGetter(node, getter) {
  Object.defineProperty(node, 'scrollHeight', {
    configurable: true,
    get: typeof getter === 'function' ? getter : () => getter
  });
}

const FIELD_CLASS = 'sncrm-original-description-field';
const HOST_CLASS = 'sncrm-original-description-host';
const FLOW_CLASS = 'sncrm-original-description-flow';
const EDITOR_CLASS = 'sncrm-original-description-editor';
const LARGE_CLASS = 'sncrm-original-description-large';
const RESIZE_ROW_CLASS = 'sncrm-description-resize-row';
const RESIZE_HANDLE_CLASS = 'sncrm-description-resize-handle';

console.log('original description enhancer');

test('enhancer finds the visible original Description field by name with an open shadow-root editor', () => {
  const dom = makeDom(`
    <body>
      <section id="scope">
        <now-textarea name="description" id="desc-host"></now-textarea>
      </section>
    </body>
  `);
  const { window } = dom;
  const enhancer = loadEnhancer(window);
  const host = window.document.getElementById('desc-host');
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = '<textarea id="desc-editor"></textarea>';

  const applied = enhancer.apply(window.document.getElementById('scope'), {
    enhanceOriginalDescription: true,
    largeOriginalDescription: false
  });

  const editor = shadow.getElementById('desc-editor');
  assert(applied, 'expected enhancer to apply to the named description host');
  assert(host.classList.contains(HOST_CLASS), 'expected the host to be marked');
  assert(editor.classList.contains(EDITOR_CLASS), 'expected the shadow editor to be marked');
  assert(shadow.querySelector('[data-sncrm-original-description-style]'), 'expected a scoped shadow style to be injected');
  assertEqual(editor.style.height, '220px', 'expected the editor to shrink to the base minimum when content is short');

  dom.window.close();
});

test('enhancer falls back to the Description label when name lookup is not available', () => {
  const dom = makeDom(`
    <body>
      <section id="scope">
        <div class="sn-form-label">Description</div>
        <div class="sn-form-value">
          <textarea id="desc-editor"></textarea>
        </div>
      </section>
    </body>
  `);
  const { window } = dom;
  const enhancer = loadEnhancer(window);

  const applied = enhancer.apply(window.document.getElementById('scope'), {
    enhanceOriginalDescription: true,
    largeOriginalDescription: true
  });

  const editor = window.document.getElementById('desc-editor');
  assert(applied, 'expected enhancer to resolve the original Description field via label fallback');
  assert(editor.classList.contains(EDITOR_CLASS), 'expected the light-DOM editor to be marked');
  assert(editor.classList.contains(LARGE_CLASS), 'expected large mode to mark the editor');
  assert(editor.closest(`.${FIELD_CLASS}`), 'expected a field container to be marked');
  assert(editor.closest(`.${FLOW_CLASS}`), 'expected the wrapper chain to be marked for flow layout');
  assertEqual(editor.style.height, '320px', 'expected large mode to respect content height when it is smaller than the preferred height');

  dom.window.close();
});

test('enhancer no-ops safely when the original Description field is absent', () => {
  const dom = makeDom('<body><section id="scope"><div>No description here</div></section></body>');
  const { window } = dom;
  const enhancer = loadEnhancer(window);

  const applied = enhancer.apply(window.document.getElementById('scope'), {
    enhanceOriginalDescription: true,
    largeOriginalDescription: false
  });

  assertEqual(applied, false, 'expected enhancer to no-op when the field is absent');
  assertEqual(window.document.querySelectorAll(`.${EDITOR_CLASS}`).length, 0, 'expected no editor markers when the field is absent');

  dom.window.close();
});

test('enhancer preserves editability and clears previous nodes on reapply', () => {
  const dom = makeDom(`
    <body>
      <section id="scope-a">
        <textarea id="desc-a" name="description">A</textarea>
      </section>
      <section id="scope-b">
        <textarea id="desc-b" name="description">B</textarea>
      </section>
    </body>
  `);
  const { window } = dom;
  const enhancer = loadEnhancer(window);
  const editorA = window.document.getElementById('desc-a');
  const editorB = window.document.getElementById('desc-b');

  enhancer.apply(window.document.getElementById('scope-a'), {
    enhanceOriginalDescription: true,
    largeOriginalDescription: true
  });
  editorA.value = 'Updated value';
  assertEqual(editorA.value, 'Updated value', 'expected the native textarea to remain editable');
  assert(editorA.classList.contains(EDITOR_CLASS), 'expected the first editor to be enhanced');

  enhancer.apply(window.document.getElementById('scope-b'), {
    enhanceOriginalDescription: true,
    largeOriginalDescription: false
  });
  assert(!editorA.classList.contains(EDITOR_CLASS), 'expected the first editor to be cleared on reapply');
  assert(editorB.classList.contains(EDITOR_CLASS), 'expected the second editor to be enhanced');
  enhancer.clear();
  assert(!editorB.classList.contains(EDITOR_CLASS), 'expected clear() to remove editor classes');
  assert(!editorB.classList.contains(LARGE_CLASS), 'expected clear() to remove size classes');

  dom.window.close();
});

test('enhancer enables native resize and mounts a custom bottom handle', () => {
  const dom = makeDom(`
    <body>
      <section id="scope">
        <div class="now-label-value-pair" id="field">
          <div class="sn-form-label">Description</div>
          <div class="sn-form-value">
            <textarea id="desc-editor">Hello</textarea>
          </div>
        </div>
      </section>
    </body>
  `);
  const { window } = dom;
  const enhancer = loadEnhancer(window);
  const field = window.document.getElementById('field');
  const editor = window.document.getElementById('desc-editor');

  enhancer.apply(window.document.getElementById('scope'), {
    enhanceOriginalDescription: true,
    largeOriginalDescription: true
  });

  assertEqual(editor.style.resize, 'vertical', 'expected the native textarea resize corner to be enabled');
  const row = window.document.querySelector(`.${RESIZE_ROW_CLASS}`);
  const handle = window.document.querySelector(`.${RESIZE_HANDLE_CLASS}`);
  assert(row, 'expected a custom bottom resize row');
  assert(handle, 'expected a custom bottom resize handle');
  assertEqual(handle.getAttribute('role'), 'separator', 'expected the handle to expose a separator role');
  assertEqual(handle.getAttribute('tabindex'), '0', 'expected the handle to be keyboard focusable');
  assert(!editor.classList.contains(FIELD_CLASS), 'expected the editor to avoid field-container marker classes');
  assertEqual(window.document.querySelector('.sncrm-original-description-action'), null, 'expected no expand button');
  assertEqual(window.document.querySelector('.sncrm-original-description-modal'), null, 'expected no popup modal');
  assert(window.document.getElementById('scope').contains(field), 'expected the original field to stay inline in the document');

  dom.window.close();
});

test('enhancer keeps handle singleton and avoids touching copy/backdrop across reapply', () => {
  const dom = makeDom(`
    <body>
      <section id="scope">
        <div class="now-label-value-pair" id="field">
          <div class="sn-form-label">Description</div>
          <div class="sn-form-value" id="value">
            <div class="now-textarea-wrapper" id="wrapper">
              <textarea id="desc-editor" class="now-textarea-field -initial -resize-vertical" name="description">Hello</textarea>
              <div id="copy" class="now-textarea-field-copy" data-replicated-value="Hello" style="padding:12px"></div>
              <div id="backdrop" class="now-textarea-field-backdrop" style="opacity:0"></div>
            </div>
          </div>
        </div>
      </section>
    </body>
  `);
  const { window } = dom;
  const enhancer = loadEnhancer(window);
  const scope = window.document.getElementById('scope');
  const wrapper = window.document.getElementById('wrapper');
  const editor = window.document.getElementById('desc-editor');
  const copy = window.document.getElementById('copy');
  const backdrop = window.document.getElementById('backdrop');
  const copyStyle = copy.getAttribute('style');
  const backdropStyle = backdrop.getAttribute('style');
  installScrollHeightGetter(editor, 550);

  enhancer.apply(scope, { enhanceOriginalDescription: true, largeOriginalDescription: true });
  enhancer.apply(scope, { enhanceOriginalDescription: true, largeOriginalDescription: true });
  enhancer.apply(scope, { enhanceOriginalDescription: true, largeOriginalDescription: true });

  assertEqual(editor.style.resize, 'vertical', 'expected the native textarea resize corner to stay enabled');
  const rows = window.document.querySelectorAll(`.${RESIZE_ROW_CLASS}`);
  assertEqual(rows.length, 1, 'expected a single bottom handle row across reapplies');
  assert(!editor.classList.contains(FIELD_CLASS), 'expected the editor to never self-identify as the field container');
  assertEqual(editor.style.getPropertyValue('max-block-size'), 'none', 'expected the live textarea to clear ServiceNow max-block-size caps');
  assertEqual(copy.getAttribute('style'), copyStyle, 'expected the replica copy inline style to stay untouched');
  assertEqual(backdrop.getAttribute('style'), backdropStyle, 'expected the replica backdrop inline style to stay untouched');
  assert(wrapper.classList.contains(FLOW_CLASS), 'expected the textarea wrapper to keep the flow marker classes');
  assert(rows[0].parentNode === scope, 'expected the handle row to mount as sibling of fieldEl, outside the textarea grid stack');
  assertEqual(editor.value, 'Hello', 'expected the editor to remain editable after reapply cycles');

  dom.window.close();
});

test('cleanup via clear() removes handle and restores inline style of untouched copy/backdrop', () => {
  const dom = makeDom(`
    <body>
      <section id="scope">
        <div class="now-label-value-pair" id="field">
          <div class="sn-form-label">Description</div>
          <div class="sn-form-value" id="value">
            <div class="now-textarea-wrapper" id="wrapper" style="overflow:hidden">
              <textarea id="desc-editor" name="description" style="min-height:120px">Hello</textarea>
              <div id="copy" class="now-textarea-field-copy" style="opacity:0.5"></div>
              <div id="backdrop" class="now-textarea-field-backdrop" style="pointer-events:none"></div>
            </div>
          </div>
        </div>
      </section>
    </body>
  `);
  const { window } = dom;
  const enhancer = loadEnhancer(window);
  const scope = window.document.getElementById('scope');
  const editor = window.document.getElementById('desc-editor');
  const copy = window.document.getElementById('copy');
  const backdrop = window.document.getElementById('backdrop');
  const copyStyleBefore = copy.getAttribute('style');
  const backdropStyleBefore = backdrop.getAttribute('style');

  enhancer.apply(scope, { enhanceOriginalDescription: true, largeOriginalDescription: true });
  assert(window.document.querySelector(`.${RESIZE_ROW_CLASS}`), 'expected handle to exist after apply');
  enhancer.clear();
  assertEqual(window.document.querySelector(`.${RESIZE_ROW_CLASS}`), null, 'expected clear() to remove the handle row');
  assertEqual(editor.style.getPropertyValue('min-height'), '120px', 'expected inline min-height on the editor to restore to its pre-enhance value');
  assertEqual(copy.getAttribute('style'), copyStyleBefore, 'expected copy inline style to remain as the page authored it');
  assertEqual(backdrop.getAttribute('style'), backdropStyleBefore, 'expected backdrop inline style to remain as the page authored it');

  enhancer.apply(scope, { enhanceOriginalDescription: true, largeOriginalDescription: true });
  assert(window.document.querySelector(`.${RESIZE_ROW_CLASS}`), 'expected handle to be re-mounted on a later apply');

  dom.window.close();
});

test('clear() drops prior style snapshots so later teardowns do not revisit old nodes', () => {
  const dom = makeDom(`
    <body>
      <section id="scope">
        <div class="now-label-value-pair">
          <div class="sn-form-label">Description</div>
          <div class="sn-form-value">
            <textarea id="desc-editor" name="description">Hello</textarea>
          </div>
        </div>
      </section>
    </body>
  `);
  const { window } = dom;
  const enhancer = loadEnhancer(window);
  const scope = window.document.getElementById('scope');
  const editor = window.document.getElementById('desc-editor');

  enhancer.apply(scope, { enhanceOriginalDescription: true, largeOriginalDescription: true });

  const nativeRemoveProperty = editor.style.removeProperty.bind(editor.style);
  let removeCalls = 0;
  editor.style.removeProperty = function removeProperty(prop) {
    removeCalls++;
    return nativeRemoveProperty(prop);
  };

  enhancer.clear();
  assert(removeCalls > 0, 'expected the first clear() to restore enhanced inline styles');

  removeCalls = 0;
  enhancer.clear();
  assertEqual(removeCalls, 0, 'expected later clear() calls to skip already-cleared snapshots');

  dom.window.close();
});

test('enhancer auto-height is idempotent across repeated apply calls', () => {
  const dom = makeDom(`
    <body>
      <section id="scope">
        <div class="now-label-value-pair">
          <div class="sn-form-label">Description</div>
          <div class="sn-form-value">
            <textarea id="desc-editor" name="description">Hello</textarea>
          </div>
        </div>
      </section>
    </body>
  `);
  const { window } = dom;
  const enhancer = loadEnhancer(window);
  const scope = window.document.getElementById('scope');
  const editor = window.document.getElementById('desc-editor');
  installScrollHeightGetter(editor, () => ((editor.style.height ? Number(editor.style.height.replace('px', '')) : 300) + 40));

  enhancer.apply(scope, {
    enhanceOriginalDescription: true,
    largeOriginalDescription: true
  });
  const firstHeight = editor.style.height;

  enhancer.apply(scope, {
    enhanceOriginalDescription: true,
    largeOriginalDescription: true
  });
  const secondHeight = editor.style.height;

  enhancer.apply(scope, {
    enhanceOriginalDescription: true,
    largeOriginalDescription: true
  });
  const thirdHeight = editor.style.height;

  assertEqual(secondHeight, firstHeight, 'expected repeated apply() calls to keep the same computed height');
  assertEqual(thirdHeight, firstHeight, 'expected auto-height to stay stable across repeated refreshes');

  dom.window.close();
});

test('completed handle drag commits the height and survives a later apply', () => {
  const dom = makeDom(`
    <body>
      <section id="scope">
        <div class="now-label-value-pair">
          <div class="sn-form-label">Description</div>
          <div class="sn-form-value">
            <div class="now-textarea-wrapper">
              <textarea id="desc-editor" name="description">Hello</textarea>
              <div class="now-textarea-field-copy"></div>
            </div>
          </div>
        </div>
      </section>
    </body>
  `);
  const { window } = dom;
  const enhancer = loadEnhancer(window);
  const scope = window.document.getElementById('scope');
  const editor = window.document.getElementById('desc-editor');
  installScrollHeightGetter(editor, () => ((editor.style.height ? Number(editor.style.height.replace('px', '')) : 300) + 200));

  enhancer.apply(scope, {
    enhanceOriginalDescription: true,
    largeOriginalDescription: true
  });

  const handle = window.document.querySelector(`.${RESIZE_HANDLE_CLASS}`);
  const initialHeight = Number(editor.style.height.replace('px', ''));
  dragHandle(window, handle, 100);
  const resizedHeight = Number(editor.style.height.replace('px', ''));
  assertEqual(resizedHeight, initialHeight + 100, 'expected drag to move the editor by the pointer delta');

  enhancer.apply(scope, {
    enhanceOriginalDescription: true,
    largeOriginalDescription: true
  });

  assertEqual(editor.style.height, `${resizedHeight}px`, 'expected a completed handle drag to survive later rerenders');
  dom.window.close();
});

test('keyboard step on the handle commits height and persists across reapply', () => {
  const dom = makeDom(`
    <body>
      <section id="scope">
        <div class="now-label-value-pair">
          <div class="sn-form-label">Description</div>
          <div class="sn-form-value">
            <div class="now-textarea-wrapper">
              <textarea id="desc-editor" name="description">Hello</textarea>
            </div>
          </div>
        </div>
      </section>
    </body>
  `);
  const { window } = dom;
  const enhancer = loadEnhancer(window);
  const scope = window.document.getElementById('scope');
  const editor = window.document.getElementById('desc-editor');
  installScrollHeightGetter(editor, 320);

  enhancer.apply(scope, { enhanceOriginalDescription: true, largeOriginalDescription: true });
  const handle = window.document.querySelector(`.${RESIZE_HANDLE_CLASS}`);
  const initial = Number(editor.style.height.replace('px', ''));

  const keyDown = new window.Event('keydown', { bubbles: true, cancelable: true });
  Object.assign(keyDown, { key: 'ArrowDown', shiftKey: true });
  handle.dispatchEvent(keyDown);
  const afterKey = Number(editor.style.height.replace('px', ''));
  assertEqual(afterKey, initial + 96, 'expected Shift+ArrowDown to grow the field by the large step');

  enhancer.apply(scope, { enhanceOriginalDescription: true, largeOriginalDescription: true });
  assertEqual(editor.style.height, `${afterKey}px`, 'expected keyboard-driven height to persist across reapply');
  dom.window.close();
});

test('handle interactions do not depend on layout rect reads', () => {
  const dom = makeDom(`
    <body>
      <section id="scope">
        <div class="now-label-value-pair">
          <div class="sn-form-label">Description</div>
          <div class="sn-form-value">
            <div class="now-textarea-wrapper">
              <textarea id="desc-editor" name="description">Hello</textarea>
            </div>
          </div>
        </div>
      </section>
    </body>
  `);
  const { window } = dom;
  const enhancer = loadEnhancer(window);
  const scope = window.document.getElementById('scope');
  const editor = window.document.getElementById('desc-editor');
  installScrollHeightGetter(editor, 320);

  enhancer.apply(scope, { enhanceOriginalDescription: true, largeOriginalDescription: true });
  const handle = window.document.querySelector(`.${RESIZE_HANDLE_CLASS}`);
  const initial = Number(editor.style.height.replace('px', ''));

  window.Element.prototype.getBoundingClientRect = function getBoundingClientRect() {
    throw new Error('getBoundingClientRect should not be used by the description resize handle');
  };

  dragHandle(window, handle, 60);
  const afterDrag = Number(editor.style.height.replace('px', ''));
  assertEqual(afterDrag, initial + 60, 'expected pointer drag to keep working without layout rect reads');

  const keyDown = new window.Event('keydown', { bubbles: true, cancelable: true });
  Object.assign(keyDown, { key: 'ArrowUp' });
  handle.dispatchEvent(keyDown);
  const afterKey = Number(editor.style.height.replace('px', ''));
  assertEqual(afterKey, afterDrag - 24, 'expected keyboard resize to keep working without layout rect reads');

  dom.window.close();
});

test('large-by-default applies without the styling toggle', () => {
  const dom = makeDom(`
    <body>
      <section id="scope">
        <div class="now-label-value-pair" id="field">
          <div class="sn-form-label">Description</div>
          <div class="sn-form-value" id="value">
            <div class="now-textarea-wrapper">
              <textarea id="desc-editor" name="description">Hello</textarea>
              <div id="copy" class="now-textarea-field-copy"></div>
            </div>
          </div>
        </div>
      </section>
    </body>
  `);
  const { window } = dom;
  const enhancer = loadEnhancer(window);
  const scope = window.document.getElementById('scope');
  const field = window.document.getElementById('field');
  const editor = window.document.getElementById('desc-editor');
  const value = window.document.getElementById('value');
  const copy = window.document.getElementById('copy');
  installScrollHeightGetter(editor, 260);

  enhancer.apply(scope, {
    enhanceOriginalDescription: true,
    largeOriginalDescription: true,
    originalDescriptionHeight: null
  });

  const applied = enhancer.apply(scope, {
    enhanceOriginalDescription: false,
    largeOriginalDescription: true,
    originalDescriptionHeight: null
  });

  assert(applied, 'expected large-by-default to activate even when styling is disabled');
  assertEqual(editor.style.height, '320px', 'expected large mode sizing to work independently of the styling toggle');
  assertEqual(editor.style.resize, 'vertical', 'expected the native resize corner to be enabled without the styling toggle');
  assert(window.document.querySelector(`.${RESIZE_ROW_CLASS}`), 'expected the custom resize row to be mounted without the styling toggle');
  assert(
    value.style.minHeight === '' || value.style.minHeight === '0',
    'expected non-styled mode to avoid forcing a large wrapper min-height'
  );
  assertEqual(field.classList.contains(HOST_CLASS), false, 'expected non-styled mode to avoid the full styling class path');
  assertEqual(copy.style.getPropertyValue('max-block-size'), '', 'expected the replica copy to keep its inline style untouched in non-styled mode');

  dom.window.close();
});

test('enhancer releases height caps on ancestors above the field container', () => {
  const dom = makeDom(`
    <body>
      <main class="sn-form-layout" style="overflow:hidden;max-height:400px">
        <section class="sn-form-section" style="max-block-size:300px">
          <div class="sn-form-row" style="max-height:200px;min-height:200px">
            <div class="sn-form-cell">
              <section id="scope">
                <div class="now-label-value-pair" id="field">
                  <div class="sn-form-label">Description</div>
                  <div class="sn-form-value">
                    <textarea id="desc-editor" name="description">Hello</textarea>
                  </div>
                </div>
              </section>
            </div>
          </div>
        </section>
      </main>
    </body>
  `);
  const { window } = dom;
  const enhancer = loadEnhancer(window);
  const scope = window.document.getElementById('scope');
  const row = window.document.querySelector('.sn-form-row');
  const section = window.document.querySelector('.sn-form-section');
  const main = window.document.querySelector('main');
  const rowMaxBefore = row.style.maxHeight;
  const mainMaxHeightBefore = main.style.maxHeight;

  enhancer.apply(scope, { enhanceOriginalDescription: true, largeOriginalDescription: true });

  assertEqual(row.style.getPropertyValue('height'), 'auto', 'expected row height to be set to auto so the grid cell expands');
  assertEqual(row.style.getPropertyValue('max-height'), 'none', 'expected row max-height to be released');
  // min-height is intentionally left alone on ancestors to avoid collapsing scroll containers
  assertEqual(row.style.getPropertyValue('min-height'), '200px', 'expected row min-height to remain at its authored value');
  assertEqual(section.style.getPropertyValue('max-block-size'), 'none', 'expected section max-block-size to be released');
  assertEqual(main.style.getPropertyValue('max-height'), 'none', 'expected main max-height to be released');

  enhancer.clear();
  assertEqual(row.style.maxHeight, rowMaxBefore, 'expected row max-height to restore after clear');
  assertEqual(main.style.maxHeight, mainMaxHeightBefore, 'expected main max-height to restore after clear');
  assertEqual(row.style.getPropertyValue('height'), '', 'expected row height to be removed after clear (was not authored in original style)');

  dom.window.close();
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
