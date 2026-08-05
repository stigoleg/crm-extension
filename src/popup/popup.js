(function () {
  'use strict';
  const { storage, messages, constants } = self.SNCRM;
  const { MSG } = constants;

  const $ = (id) => document.getElementById(id);
  const statusRoot = $('status');
  const statusText = $('statusText');
  const hint = $('hint');
  const quickToggles = $('quickToggles');
  const enabledCb = $('enabled');
  const expandedCb = $('expanded');
  const debugCb = $('debug');
  const refreshBtn = $('refresh');
  const openOptionsBtn = $('openOptions');

  let currentTabId = null;
  let supported = false;

  async function render() {
    const settings = await storage.get();
    enabledCb.checked = Boolean(settings.enabled);
    expandedCb.checked = !settings.defaultCollapsed;
    debugCb.checked = Boolean(settings.debug);

    const res = await messages.send({ type: MSG.GET_STATUS });
    supported = Boolean(res && res.supported);
    currentTabId = res && res.tabId;

    statusRoot.classList.toggle('supported', supported);
    statusRoot.classList.toggle('unsupported', !supported);
    statusText.textContent = supported
      ? 'Active on this tab'
      : 'Not a CRM opportunity page';
    hint.textContent = supported
      ? 'The overview panel is injected on this page.'
      : 'Settings below are saved globally and apply on supported opportunity pages.';

    // Refresh + page-specific toggles only usable when supported; settings
    // stay editable either way.
    refreshBtn.classList.toggle('disabled', !supported);
    refreshBtn.disabled = !supported;
  }

  async function patch(partial) {
    await storage.set(partial);
  }

  enabledCb.addEventListener('change', () => patch({ enabled: enabledCb.checked }));
  expandedCb.addEventListener('change', () => patch({ defaultCollapsed: !expandedCb.checked }));
  debugCb.addEventListener('change', () => patch({ debug: debugCb.checked }));

  refreshBtn.addEventListener('click', async () => {
    if (!supported || currentTabId == null) return;
    await messages.sendToTab(currentTabId, { type: MSG.REFRESH });
  });

  openOptionsBtn.addEventListener('click', async () => {
    // Route through the service worker so it can fall back to tabs.create
    // if chrome.runtime.openOptionsPage misbehaves in this Chrome build.
    const res = await messages.send({ type: MSG.OPEN_OPTIONS });
    if (!res || !res.ok) {
      // Last-resort: open the options HTML directly from the popup.
      const url = chrome.runtime.getURL('src/options/options.html');
      chrome.tabs.create({ url });
    }
    window.close();
  });

  // React to setting changes made elsewhere (options page, other tabs).
  storage.onChange(() => { render(); });

  // Guard against the quickToggles section being shown while storage is still
  // loading — `render` resolves fast, but we mark disabled initially.
  quickToggles.classList.add('disabled');
  render().finally(() => quickToggles.classList.remove('disabled'));
})();
