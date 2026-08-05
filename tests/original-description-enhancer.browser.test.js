'use strict';

const assert = require('assert/strict');
const path = require('path');
const { pathToFileURL } = require('url');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..');
const FIXTURE_URL = pathToFileURL(
  path.join(__dirname, 'fixtures', 'original-description-enhancer.fixture.html')
).href;
const STYLE_PATH = path.join(ROOT, 'src', 'content', 'styles.css');
const FIELD_REGISTRY_PATH = path.join(ROOT, 'src', 'content', 'field-registry.js');
const EXTRACTORS_PATH = path.join(ROOT, 'src', 'content', 'extractors.js');
const ENHANCER_PATH = path.join(ROOT, 'src', 'content', 'original-description-enhancer.js');

const bootstrapScript = `
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
    storage: {
      set() {
        return Promise.resolve();
      }
    }
  };
`;

let passed = 0;
let failed = 0;

function boxMetrics(box) {
  if (!box) return null;
  return {
    x: box.x,
    y: box.y,
    width: box.width,
    height: box.height,
    top: box.y,
    bottom: box.y + box.height,
    left: box.x,
    right: box.x + box.width
  };
}

async function withPage(browser, fn) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  try {
    await page.goto(FIXTURE_URL);
    await page.addStyleTag({ path: STYLE_PATH });
    await page.addScriptTag({ content: bootstrapScript });
    await page.addScriptTag({ path: FIELD_REGISTRY_PATH });
    await page.addScriptTag({ path: EXTRACTORS_PATH });
    await page.addScriptTag({ path: ENHANCER_PATH });
    await fn(page);
  } finally {
    await page.close();
  }
}

async function applySettings(page, settings) {
  return page.evaluate((nextSettings) => {
    return window.SNCRM.originalDescriptionEnhancer.apply(
      document.getElementById('scope'),
      nextSettings
    );
  }, settings);
}

async function getState(page) {
  const textarea = page.locator('[name="description"]');
  const wrapper = page.locator('#wrapper');
  const value = page.locator('#value');
  const host = page.locator('#field');
  const handle = page.locator('.sncrm-description-resize-handle');
  const metrics = await page.evaluate(() => {
    const textareaEl = document.querySelector('[name="description"]');
    const handleEl = document.querySelector('.sncrm-description-resize-handle');
    if (!textareaEl) return { resizeMode: '', handleHit: false };
    const result = {
      resizeMode: window.getComputedStyle(textareaEl).resize
    };
    if (handleEl) {
      const r = handleEl.getBoundingClientRect();
      const x = r.left + r.width / 2;
      const y = r.top + r.height / 2;
      const hit = document.elementFromPoint(x, y);
      result.handleHit = Boolean(hit && (hit === handleEl || handleEl.contains(hit)));
    } else {
      result.handleHit = false;
    }
    return result;
  });
  return {
    textareaBox: boxMetrics(await textarea.boundingBox()),
    wrapperBox: boxMetrics(await wrapper.boundingBox()),
    valueBox: boxMetrics(await value.boundingBox()),
    handleBox: (await handle.count()) ? boxMetrics(await handle.boundingBox()) : null,
    hostClasses: await host.getAttribute('class'),
    resizeMode: metrics.resizeMode,
    handleHit: metrics.handleHit,
    rowExists: await page.locator('.sncrm-description-resize-row').count(),
    handleExists: await handle.count()
  };
}

function assertVisibleState(state, expectedStyled) {
  assert(state.textareaBox && state.textareaBox.height > 0, 'expected the description field to have a rendered height');
  assert.equal(state.resizeMode, 'vertical', 'expected the native textarea resize corner to be enabled');
  assert.equal(state.rowExists, 1, 'expected a single custom resize row');
  assert.equal(state.handleExists, 1, 'expected a single custom resize handle');
  assert(state.handleBox && state.handleBox.height > 0, 'expected the handle to be visible');
  assert(state.handleHit, 'expected the bottom handle to be reachable via elementFromPoint (not occluded by the copy/backdrop layer)');
  const hasStyledClass = /\bsncrm-original-description-host\b/.test(state.hostClasses || '');
  assert.equal(hasStyledClass, expectedStyled, 'unexpected styling mode class state on the field');
}

async function dragBottomHandle(page, deltaY) {
  const before = await getState(page);
  const box = before.handleBox;
  assert(box, 'expected a handle box before dragging');
  const startX = box.left + box.width / 2;
  const startY = box.top + box.height / 2;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX, startY + deltaY, { steps: 10 });
  await page.mouse.up();
  return {
    before,
    after: await getState(page)
  };
}

async function runTest(name, fn, browser) {
  try {
    await fn(browser);
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  FAIL ${name}`);
    console.log(`       ${error.message}`);
    if (error.stack) console.log(error.stack.split('\n').slice(1).join('\n'));
  }
}

async function main() {
  console.log('original description enhancer browser smoke');
  const browser = await chromium.launch({ headless: true });
  try {
    await runTest('styled mode keeps field and custom bottom handle visible and draggable', async () => {
      await withPage(browser, async (page) => {
        await applySettings(page, {
          enhanceOriginalDescription: true,
          largeOriginalDescription: false,
          originalDescriptionHeight: null
        });
        assertVisibleState(await getState(page), true);
        const { before, after } = await dragBottomHandle(page, 80);
        assert(after.textareaBox.height > before.textareaBox.height + 40, 'expected dragging the bottom handle down in styled mode to increase textarea height');
        const shrunk = await dragBottomHandle(page, -120);
        assert(shrunk.after.textareaBox.height < shrunk.before.textareaBox.height - 40, 'expected dragging the bottom handle up in styled mode to decrease textarea height');
      });
    }, browser);

    await runTest('non-styled large mode keeps field and custom bottom handle visible and draggable', async () => {
      await withPage(browser, async (page) => {
        await applySettings(page, {
          enhanceOriginalDescription: false,
          largeOriginalDescription: true,
          originalDescriptionHeight: null
        });
        assertVisibleState(await getState(page), false);
        const { before, after } = await dragBottomHandle(page, 72);
        assert(after.textareaBox.height > before.textareaBox.height + 40, 'expected dragging the bottom handle in non-styled mode to increase textarea height');
      });
    }, browser);

    await runTest('toggling styling off keeps the field and handle visible', async () => {
      await withPage(browser, async (page) => {
        await applySettings(page, {
          enhanceOriginalDescription: true,
          largeOriginalDescription: true,
          originalDescriptionHeight: null
        });
        assertVisibleState(await getState(page), true);

        await applySettings(page, {
          enhanceOriginalDescription: false,
          largeOriginalDescription: true,
          originalDescriptionHeight: null
        });
        assertVisibleState(await getState(page), false);
      });
    }, browser);

    await runTest('bottom handle is not occluded by copy/backdrop overlay siblings', async () => {
      await withPage(browser, async (page) => {
        await applySettings(page, {
          enhanceOriginalDescription: true,
          largeOriginalDescription: true,
          originalDescriptionHeight: null
        });
        const state = await getState(page);
        assert.equal(state.handleExists, 1, 'expected handle to be mounted');
        assert(state.handleHit, 'expected handle to be reachable at its centerline');
        const focused = await page.evaluate(() => {
          const h = document.querySelector('.sncrm-description-resize-handle');
          h.focus();
          return document.activeElement === h;
        });
        assert(focused, 'expected the handle to be keyboard-focusable');
      });
    }, browser);
  } finally {
    await browser.close();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
