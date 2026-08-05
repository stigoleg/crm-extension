/* Minimal service worker.
 *   - Shows action badge per tab: "ON" on supported tabs, "" otherwise.
 *   - Relays OPEN_OPTIONS requests (content script cannot open options directly).
 *   - Answers GET_STATUS for the popup by checking the active tab URL, so the
 *     popup works even when the content script has not yet loaded.
 * Intentionally does not own any page enhancement logic.
 */

try {
  importScripts(
    '../shared/constants.js',
    '../shared/log.js',
    '../shared/url.js'
  );
} catch (e) {
  console.error('[sncrm:sw] importScripts failed', e);
}

const { constants, url, log } = self.SNCRM;
const swLog = log.make('sw');
const { MSG } = constants;
const CONTENT_SCRIPT_ENTRY = (() => {
  try {
    const manifest = chrome.runtime.getManifest();
    const contentScripts = manifest && Array.isArray(manifest.content_scripts)
      ? manifest.content_scripts
      : [];
    if (!contentScripts.length) return { js: [], css: [] };
    return contentScripts[0];
  } catch (e) {
    swLog.error('failed to read content script manifest entry', e);
    return { js: [], css: [] };
  }
})();
const CONTENT_SCRIPT_FILES = Object.freeze(
  Array.isArray(CONTENT_SCRIPT_ENTRY.js)
    ? CONTENT_SCRIPT_ENTRY.js.slice()
    : []
);
const CONTENT_STYLE_FILES = Object.freeze(
  Array.isArray(CONTENT_SCRIPT_ENTRY.css)
    ? CONTENT_SCRIPT_ENTRY.css.slice()
    : []
);
const confirmedContentScriptTabs = new Set();
const pendingInjections = new Map();

function normalizeSupportedUrl(tabUrl) {
  return url.isSupportedUrl(tabUrl || '') ? String(tabUrl) : '';
}

function updateBadgeForTab(tabId, tabUrl) {
  const supported = url.isSupportedUrl(tabUrl || '');
  const text = supported ? 'ON' : '';
  const color = supported ? '#2b6cb0' : '#888888';
  chrome.action.setBadgeBackgroundColor({ tabId, color });
  chrome.action.setBadgeText({ tabId, text });
}

async function hasContentScript(tabId) {
  if (confirmedContentScriptTabs.has(tabId)) return true;
  try {
    const response = await chrome.tabs.sendMessage(tabId, { type: MSG.GET_STATUS });
    const ok = Boolean(response && response.ok);
    if (ok) confirmedContentScriptTabs.add(tabId);
    return ok;
  } catch {
    return false;
  }
}

async function injectContentScript(tabId, tabUrl) {
  const supportedUrl = normalizeSupportedUrl(tabUrl);
  if (!tabId || !supportedUrl) return false;
  if (confirmedContentScriptTabs.has(tabId)) return false;
  const pending = pendingInjections.get(tabId);
  if (pending && pending.url === supportedUrl) return pending.promise;
  if (!CONTENT_SCRIPT_FILES.length) return false;

  let job;
  job = (async () => {
    if (await hasContentScript(tabId)) return false;
    swLog.info('injecting content script fallback', { tabId, tabUrl: supportedUrl });
    if (CONTENT_STYLE_FILES.length) {
      await chrome.scripting.insertCSS({
        target: { tabId },
        files: CONTENT_STYLE_FILES
      });
    }
    await chrome.scripting.executeScript({
      target: { tabId },
      files: CONTENT_SCRIPT_FILES
    });
    confirmedContentScriptTabs.add(tabId);
    return true;
  })().catch((e) => {
    swLog.debug('content script fallback skipped', {
      tabId,
      tabUrl: supportedUrl,
      error: String(e && e.message || e)
    });
    return false;
  }).finally(() => {
    const current = pendingInjections.get(tabId);
    if (current && current.promise === job) {
      pendingInjections.delete(tabId);
    }
  });

  pendingInjections.set(tabId, { url: supportedUrl, promise: job });
  return job;
}

/* Reliable options opener. `chrome.runtime.openOptionsPage` throws on some
 * Chrome builds if the options page has never been opened before or if the
 * caller context is closing (popup). Fall back to opening the options HTML
 * directly in a new tab. */
function openOptions() {
  return new Promise((resolve, reject) => {
    try {
      chrome.runtime.openOptionsPage(() => {
        const err = chrome.runtime.lastError;
        if (!err) return resolve();
        const optionsUrl = chrome.runtime.getURL('src/options/options.html');
        chrome.tabs.create({ url: optionsUrl }, () => {
          const err2 = chrome.runtime.lastError;
          if (err2) return reject(new Error(err2.message));
          resolve();
        });
      });
    } catch (e) {
      const optionsUrl = chrome.runtime.getURL('src/options/options.html');
      chrome.tabs.create({ url: optionsUrl }, () => resolve());
    }
  });
}

chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.status === 'loading' || info.url) {
    updateBadgeForTab(tabId, tab && tab.url);
  }
  if (info.status === 'complete') {
    injectContentScript(tabId, tab && tab.url);
  }
});

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    const tab = await chrome.tabs.get(tabId);
    updateBadgeForTab(tabId, tab && tab.url);
    if (tab && tab.status === 'complete') {
      injectContentScript(tabId, tab.url);
    }
  } catch { /* tab may have closed */ }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  confirmedContentScriptTabs.delete(tabId);
  pendingInjections.delete(tabId);
});

chrome.webNavigation.onCommitted.addListener(({ tabId, frameId, url: nextUrl }) => {
  if (frameId !== 0) return;
  confirmedContentScriptTabs.delete(tabId);
  pendingInjections.delete(tabId);
  updateBadgeForTab(tabId, nextUrl);
});

chrome.webNavigation.onHistoryStateUpdated.addListener(({ tabId, frameId, url: nextUrl }) => {
  if (frameId !== 0) return;
  updateBadgeForTab(tabId, nextUrl);
  injectContentScript(tabId, nextUrl);
});

chrome.runtime.onInstalled.addListener(() => {
  swLog.info('installed');
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string') return;

  if (msg.type === MSG.OPEN_OPTIONS) {
    openOptions().then(() => sendResponse({ ok: true })).catch((e) => {
      swLog.error('openOptions failed', e);
      sendResponse({ ok: false, error: String(e && e.message || e) });
    });
    return true;
  }

  if (msg.type === MSG.GET_STATUS) {
    (async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      const tabUrl = tab && tab.url;
      sendResponse({
        ok: true,
        tabId: tab && tab.id,
        url: tabUrl || '',
        supported: url.isSupportedUrl(tabUrl || '')
      });
    })();
    return true;
  }
  return undefined;
});
