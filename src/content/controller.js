(function (root) {
  'use strict';
  const NS = (root.SNCRM = root.SNCRM || {});
  const log = NS.log.make('ctrl');
  const {
    MOUNT_DEBOUNCE_MS,
    REFRESH_DEBOUNCE_MS,
    HYDRATION_TIMEOUT_MS,
    HYDRATION_POLL_MS,
    HYDRATION_BACKOFF_MS: CONFIGURED_HYDRATION_BACKOFF_MS,
    MSG
  } = NS.constants;
  const HYDRATION_BACKOFF_MS =
    CONFIGURED_HYDRATION_BACKOFF_MS || Math.max(HYDRATION_POLL_MS * 10, 5000);
  const REVALIDATE_BASE_MS = 3000;
  const REVALIDATE_MAX_MS = 30000;
  const COMPLETION_POLL_MAX_MS = Math.max(HYDRATION_POLL_MS, 5000);
  const { isSupportedUrl, extractRecordId } = NS.url;
  const storage = NS.storage;
  const discoveryStore = NS.discoveryStore || {
    async get() { return []; },
    async merge(fields) { return fields || []; },
    onChange() { return () => {}; }
  };
  const fieldRegistry = NS.fieldRegistry || {
    byKey: {},
    refreshDiscoveredFields() {},
    isDetectedKey() { return false; },
    serviceNowNameFromDetectedKey() { return ''; },
    createDetectedField(field) { return field; },
    canonicalKey(key) { return key; }
  };
  const {
    extractAll,
    discoverFields = () => ({ discoveries: [], resolvedServiceNowNames: [] }),
    isHydrated,
    resolveActiveRecordScope,
    invalidateCache = () => {}
  } = NS.extractors;
  const ui = NS.ui;
  const descriptionEnhancer = NS.originalDescriptionEnhancer || {
    apply() { return false; },
    clear() {}
  };
  const ACTIVE_SCOPE_PROBE_KEYS = Object.freeze([
    'opportunity_name',
    'account',
    'stage',
    'apps_status',
    'description',
    'next_step'
  ]);
  const APP_ROOT_SELECTOR = '[app-id][macroponent-namespace]';
  const SECTION_HEADER_SELECTOR = 'span.sn-section-header.collapsable';
  const SECTION_EXPANSION_SETTLE_MS = 50;

  /* State machine:
   *   IDLE → WAITING (no panel, looking for hydration)
   *   WAITING → DEGRADED (no stable record scope appeared before timeout)
   *   DEGRADED → MOUNTED (slow recovery finally finds the live record)
   *   WAITING → MOUNTED (panel injected, values rendered)
   *   MOUNTED → WAITING (URL/record changed → teardown)
   *   any → IDLE (page unsupported)
   */
  const S = Object.freeze({
    IDLE: 'idle',
    WAITING: 'waiting',
    DEGRADED: 'degraded',
    MOUNTED: 'mounted'
  });

  let state = S.IDLE;
  let settings = null;
  let currentRecordId = null;
  let activeScope = null;
  let mountObserver = null;
  let mountObserverRoot = null;
  let mountAttributeObserver = null;
  let mountAttributeObserverRoot = null;
  let rerenderObserver = null;
  let rerenderObserverRoot = null;
  let rerenderAttributeObserver = null;
  let rerenderAttributeObserverRoot = null;
  let bodyObserver = null;
  let hydrationDeadline = 0;
  let hydrationCheckHandle = null;
  let hydrationCheckMode = '';
  let hydrationCheckDelay = Number.POSITIVE_INFINITY;
  let refreshDebounceTimer = null;
  let refreshDebounceMode = '';
  let unsubscribeStorage = null;
  let unsubscribeDiscovery = null;
  let stopNavigation = null;
  let revalidateTimer = null;       // periodic extract-fresh while mounted
  let revalidateDelay = REVALIDATE_BASE_MS;
  let visibilityHandler = null;
  let resizeHandler = null;
  let lastScopeLogKey = '';
  let lastResponsiveColumns = null;
  let descriptionOnlyActive = false;
  let descriptionOnlyObserver = null;
  let descriptionOnlyObserverRoot = null;
  let descriptionOnlyRetryTimer = null;
  let descriptionOnlyRetryMode = '';
  let extractorCacheDirty = true;
  let sectionsExpandedForRecord = null;
  let sectionsExpandedScope = null;
  let sectionExpansionPendingRecord = null;
  let sectionExpansionPendingScope = null;
  let sectionExpansionTimer = null;
  let waitingSectionExpansionRecord = null;
  let discoveryFields = [];
  let discoveryScanHandle = null;
  let discoveryScanMode = '';
  let pendingDiscoveryScanKey = '';
  let lastDiscoveryScanKey = '';
  let nextScopeDiscoveryId = 0;
  const scopeDiscoveryIds = new WeakMap();

  function isOverviewPanelEnabled(s) {
    return Boolean(s && s.enabled === true);
  }

  function isDescriptionFeatureEnabled(s) {
    if (!s) return false;
    if (s.enhanceOriginalDescription === true) return true;
    if (s.largeOriginalDescription === true) return true;
    const h = s.originalDescriptionHeight;
    if (typeof h === 'number' && Number.isFinite(h) && h >= 120) return true;
    return false;
  }

  function setState(next) {
    if (state !== next) {
      log.debug(`state ${state} → ${next}`);
      state = next;
    }
  }

  function isDocumentVisible() {
    return typeof document.visibilityState !== 'string' || document.visibilityState !== 'hidden';
  }

  function liveRecordId() {
    return extractRecordId(location.href);
  }

  function isRenderTokenStale(token) {
    return token !== currentRecordId || liveRecordId() !== token;
  }

  function scopeProbeKeys() {
    const selected = settings && Array.isArray(settings.selectedFields)
      ? settings.selectedFields
      : [];
    return Array.from(new Set([...selected, ...ACTIVE_SCOPE_PROBE_KEYS]));
  }

  function effectiveColumns() {
    return ui && typeof ui.effectiveColumnCount === 'function'
      ? ui.effectiveColumnCount(settings && settings.columns)
      : ((settings && settings.columns) || 3);
  }

  function selectedDetectedFieldKeys() {
    const selected = settings && Array.isArray(settings.selectedFields)
      ? settings.selectedFields
      : [];
    return selected.filter((key) => fieldRegistry.isDetectedKey(key));
  }

  function withSelectedDetectedFallbacks(fields) {
    const out = Array.isArray(fields) ? fields.slice() : [];
    const existing = new Set(out.map((field) => field && field.key).filter(Boolean));
    for (const key of selectedDetectedFieldKeys()) {
      if (existing.has(key)) continue;
      out.push(fieldRegistry.createDetectedField({
        key,
        serviceNowName: fieldRegistry.serviceNowNameFromDetectedKey(key)
      }));
    }
    return out;
  }

  function applyDiscoveredFields(fields) {
    discoveryFields = Array.isArray(fields) ? fields.slice() : [];
    fieldRegistry.refreshDiscoveredFields(withSelectedDetectedFallbacks(discoveryFields));
  }

  function selectedDetectedFieldSignature() {
    return selectedDetectedFieldKeys()
      .map((key) => {
        const meta = fieldRegistry.byKey[key];
        return `${key}|${meta && meta.label ? meta.label : ''}|${meta && meta.renderAs ? meta.renderAs : ''}`;
      })
      .sort()
      .join('||');
  }

  function normalizeMigratedLayoutItems(items) {
    const next = [];
    const seen = new Set();
    for (const item of items || []) {
      if (!item || item.type !== 'field') {
        if (item) next.push(item);
        continue;
      }
      const canonicalKey = fieldRegistry.canonicalKey(item.key);
      if (!canonicalKey || seen.has(canonicalKey)) continue;
      seen.add(canonicalKey);
      next.push(canonicalKey === item.key ? item : { ...item, key: canonicalKey });
    }
    return next;
  }

  function detectedFieldMigrationPatch(sourceSettings) {
    if (!sourceSettings || !Array.isArray(sourceSettings.fieldLayout)) return null;
    const nextFieldLayout = normalizeMigratedLayoutItems(sourceSettings.fieldLayout);
    const nextSelectedFields = nextFieldLayout
      .filter((item) => item && item.type === 'field' && typeof item.key === 'string')
      .map((item) => item.key);
    const prevSelectedFields = Array.isArray(sourceSettings.selectedFields)
      ? sourceSettings.selectedFields
      : [];
    const prevLayoutJson = JSON.stringify(sourceSettings.fieldLayout);
    const nextLayoutJson = JSON.stringify(nextFieldLayout);
    const prevSelectedJson = JSON.stringify(prevSelectedFields);
    const nextSelectedJson = JSON.stringify(nextSelectedFields);
    if (prevLayoutJson === nextLayoutJson && prevSelectedJson === nextSelectedJson) return null;
    return {
      fieldLayout: nextFieldLayout,
      selectedFields: nextSelectedFields
    };
  }

  function scopeDiscoveryId(scope) {
    if (!scope || (typeof scope !== 'object' && typeof scope !== 'function')) return 'none';
    let id = scopeDiscoveryIds.get(scope);
    if (!id) {
      nextScopeDiscoveryId += 1;
      id = String(nextScopeDiscoveryId);
      scopeDiscoveryIds.set(scope, id);
    }
    return id;
  }

  function cancelScheduledDiscoveryScan() {
    if (discoveryScanHandle == null) return;
    if (discoveryScanMode === 'idle' && typeof root.cancelIdleCallback === 'function') {
      root.cancelIdleCallback(discoveryScanHandle);
    } else {
      clearTimeout(discoveryScanHandle);
    }
    discoveryScanHandle = null;
    discoveryScanMode = '';
    pendingDiscoveryScanKey = '';
  }

  function resetDiscoveryTracking() {
    cancelScheduledDiscoveryScan();
    lastDiscoveryScanKey = '';
  }

  function findAppRoot() {
    return document.querySelector(APP_ROOT_SELECTOR);
  }

  function observerRootFor(scope) {
    if (scope && scope.isConnected && typeof scope.getRootNode === 'function') {
      const scopeRoot = scope.getRootNode();
      if (scopeRoot && scopeRoot.host instanceof Element) return scopeRoot;
    }
    const appRoot = findAppRoot();
    if (appRoot && appRoot.shadowRoot) return appRoot.shadowRoot;
    return appRoot || document.body || document.documentElement;
  }

  function reconnectObserver(currentObserver, currentRoot, nextRoot, options, callback) {
    const target = nextRoot || document.body || document.documentElement;
    if (currentObserver && currentRoot === target) {
      return { observer: currentObserver, root: currentRoot };
    }
    if (currentObserver) currentObserver.disconnect();
    const observer = new MutationObserver(callback);
    observer.observe(target, options);
    return { observer, root: target };
  }

  function clearScheduledRefresh() {
    if (refreshDebounceTimer == null) return;
    if (refreshDebounceMode === 'idle' && typeof root.cancelIdleCallback === 'function') {
      root.cancelIdleCallback(refreshDebounceTimer);
    } else {
      clearTimeout(refreshDebounceTimer);
    }
    refreshDebounceTimer = null;
    refreshDebounceMode = '';
  }

  function clearDescriptionOnlyRetry() {
    if (descriptionOnlyRetryTimer == null) return;
    if (descriptionOnlyRetryMode === 'idle' && typeof root.cancelIdleCallback === 'function') {
      root.cancelIdleCallback(descriptionOnlyRetryTimer);
    } else {
      clearTimeout(descriptionOnlyRetryTimer);
    }
    descriptionOnlyRetryTimer = null;
    descriptionOnlyRetryMode = '';
  }

  function markExtractorCacheDirty() {
    extractorCacheDirty = true;
  }

  function refreshExtractorCachesIfNeeded() {
    if (!extractorCacheDirty) return false;
    invalidateCache();
    extractorCacheDirty = false;
    return true;
  }

  function scheduleDescriptionOnlyPass(delay = MOUNT_DEBOUNCE_MS) {
    if (!descriptionOnlyActive || descriptionOnlyRetryTimer != null) return;
    const nextDelay = Math.max(0, delay);
    const run = () => {
      descriptionOnlyRetryTimer = null;
      descriptionOnlyRetryMode = '';
      runDescriptionOnlyPass();
    };
    if (typeof root.requestIdleCallback === 'function') {
      descriptionOnlyRetryMode = 'idle';
      descriptionOnlyRetryTimer = root.requestIdleCallback(run, { timeout: nextDelay });
      return;
    }
    descriptionOnlyRetryMode = 'timeout';
    descriptionOnlyRetryTimer = setTimeout(run, nextDelay);
  }

  function isRecordOutsidePanel(record, panel) {
    return !panel || !(record && record.target instanceof Node) || !panel.contains(record.target);
  }

  function logScopeOnce(message, data) {
    const recordId = data && data.recordId ? data.recordId : currentRecordId || 'none';
    const key = `${message}|${recordId}`;
    if (key === lastScopeLogKey) return;
    lastScopeLogKey = key;
    log.debug(message, data);
  }

  function resolveScopeForRecord(token, fallbackScope) {
    if (!token) return { stale: false, scope: null, probeKeys: [] };
    if (isRenderTokenStale(token)) {
      log.debug('discarded scope resolution for stale record', {
        token,
        tracked: currentRecordId,
        live: liveRecordId()
      });
      return { stale: true, scope: null, probeKeys: [] };
    }

    const probeKeys = scopeProbeKeys();
    const freshScope = resolveActiveRecordScope(document.body, probeKeys);
    const scope = fallbackScope &&
      fallbackScope === freshScope &&
      fallbackScope.isConnected &&
      document.body.contains(fallbackScope)
      ? fallbackScope
      : freshScope;

    if (isRenderTokenStale(token)) {
      log.debug('discarded resolved scope for stale record', {
        token,
        tracked: currentRecordId,
        live: liveRecordId()
      });
      return { stale: true, scope: null, probeKeys };
    }

    if (!scope) {
      activeScope = null;
      logScopeOnce('waiting for stable active record scope', {
        recordId: token,
        url: location.href
      });
      return { stale: false, scope: null, probeKeys };
    }

    activeScope = scope;
    logScopeOnce('active record scope resolved', { recordId: token });
    return { stale: false, scope, probeKeys };
  }

  function clearSectionExpansionTimer() {
    if (!sectionExpansionTimer) return;
    clearTimeout(sectionExpansionTimer);
    sectionExpansionTimer = null;
  }

  function resetSectionExpansionTracking() {
    clearSectionExpansionTimer();
    sectionsExpandedForRecord = null;
    sectionsExpandedScope = null;
    sectionExpansionPendingRecord = null;
    sectionExpansionPendingScope = null;
    waitingSectionExpansionRecord = null;
  }

  function sectionExpansionSettledFor(token, scope) {
    return sectionsExpandedForRecord === token && sectionsExpandedScope === scope;
  }

  function sectionExpansionPendingFor(token, scope) {
    return sectionExpansionPendingRecord === token && sectionExpansionPendingScope === scope;
  }

  function isExpandedSectionMutation(record) {
    return Boolean(
      record &&
      record.type === 'attributes' &&
      record.attributeName === 'aria-expanded' &&
      record.target instanceof Element &&
      record.target.matches(SECTION_HEADER_SELECTOR) &&
      record.target.getAttribute('aria-expanded') === 'true'
    );
  }

  function scheduleSectionExpansionSettle(token) {
    clearSectionExpansionTimer();
    sectionExpansionTimer = setTimeout(() => {
      sectionExpansionTimer = null;
      if (sectionExpansionPendingRecord !== token) return;
      sectionExpansionPendingRecord = null;
      sectionExpansionPendingScope = null;
      if (isRenderTokenStale(token)) return;
      rerenderValues({ token });
    }, SECTION_EXPANSION_SETTLE_MS);
  }

  function clearWaitingLoop() {
    if (mountObserver) { mountObserver.disconnect(); mountObserver = null; }
    if (mountAttributeObserver) { mountAttributeObserver.disconnect(); mountAttributeObserver = null; }
    if (bodyObserver) { bodyObserver.disconnect(); bodyObserver = null; }
    mountObserverRoot = null;
    mountAttributeObserverRoot = null;
    cancelScheduledHydrationCheck();
  }

  function tearDownPanelOnly() {
    clearWaitingLoop();
    resetSectionExpansionTracking();
    resetDiscoveryTracking();
    if (rerenderObserver) { rerenderObserver.disconnect(); rerenderObserver = null; }
    if (rerenderAttributeObserver) { rerenderAttributeObserver.disconnect(); rerenderAttributeObserver = null; }
    if (bodyObserver) { bodyObserver.disconnect(); bodyObserver = null; }
    rerenderObserverRoot = null;
    rerenderAttributeObserverRoot = null;
    clearScheduledRefresh();
    if (completionTimer) { clearTimeout(completionTimer); completionTimer = null; }
    if (heightSaveTimer) { clearTimeout(heightSaveTimer); heightSaveTimer = null; }
    stopRevalidateTimer();
    ui.remove();
    lastResultsKey = '';
    lastResponsiveColumns = null;
    completionDeadline = 0;
    completionPollDelay = HYDRATION_POLL_MS;
    cachedShell = null;
    setState(S.IDLE);
  }

  function stopDescriptionOnly() {
    if (descriptionOnlyObserver) { descriptionOnlyObserver.disconnect(); descriptionOnlyObserver = null; }
    descriptionOnlyObserverRoot = null;
    clearDescriptionOnlyRetry();
    descriptionOnlyActive = false;
  }

  function tearDown(reason) {
    log.debug(`teardown (${reason})`);
    tearDownPanelOnly();
    stopDescriptionOnly();
    descriptionEnhancer.clear();
    markExtractorCacheDirty();
    currentRecordId = null;
    activeScope = null;
    lastScopeLogKey = '';
  }

  async function init() {
    const [initialSettings, initialDiscoveries] = await Promise.all([
      storage.get(),
      discoveryStore.get()
    ]);
    settings = initialSettings;
    applyDiscoveredFields(initialDiscoveries);
    const migrationPatch = detectedFieldMigrationPatch(settings);
    if (migrationPatch) {
      settings = await storage.set(migrationPatch);
      applyDiscoveredFields(discoveryFields);
    }
    NS.log.setDebug(settings.debug);

    unsubscribeStorage = storage.onChange((next) => {
      const prevDebug = settings && settings.debug;
      settings = next;
      applyDiscoveredFields(discoveryFields);
      NS.log.setDebug(settings.debug);
      log.debug('settings changed', settings);
      if (prevDebug !== settings.debug) log.info('debug toggled', settings.debug);
      evaluate();
      if (state === S.MOUNTED) rerenderValues();
      else if (descriptionOnlyActive) runDescriptionOnlyPass();
    });

    unsubscribeDiscovery = discoveryStore.onChange((nextFields) => {
      const beforeSignature = selectedDetectedFieldSignature();
      applyDiscoveredFields(nextFields);
      const afterSignature = selectedDetectedFieldSignature();
      if (beforeSignature === afterSignature) return;
      if (state === S.MOUNTED) rerenderValues();
    });

    window.addEventListener('beforeunload', () => {
      if (unsubscribeStorage) unsubscribeStorage();
      if (unsubscribeDiscovery) unsubscribeDiscovery();
      if (stopNavigation) { stopNavigation(); stopNavigation = null; }
      if (visibilityHandler) {
        document.removeEventListener('visibilitychange', visibilityHandler);
        window.removeEventListener('focus', visibilityHandler);
        visibilityHandler = null;
      }
      if (resizeHandler) {
        window.removeEventListener('resize', resizeHandler);
        resizeHandler = null;
      }
      cancelScheduledDiscoveryScan();
      tearDown('unload');
    }, { once: true });
    chrome.runtime.onMessage.addListener(onRuntimeMessage);

    stopNavigation = NS.navigation.start((nowUrl) => {
      log.debug('nav', nowUrl);
      evaluate();
    });

    // When the tab becomes visible (user returns from another tab), verify
    // the URL hasn't drifted while we were backgrounded and the poll was
    // throttled by the browser.
    visibilityHandler = () => {
      if (!isDocumentVisible()) {
        stopRevalidateTimer();
        return;
      }
      restartRevalidateTimer();
      evaluate();
    };
    document.addEventListener('visibilitychange', visibilityHandler);
    window.addEventListener('focus', visibilityHandler);

    resizeHandler = () => {
      if (!settings || state !== S.MOUNTED) return;
      const responsiveColumns = effectiveColumns();
      if (responsiveColumns === lastResponsiveColumns) return;
      lastResponsiveColumns = responsiveColumns;
      scheduleRefresh(true);
    };
    window.addEventListener('resize', resizeHandler);

    evaluate();
  }

  function onRuntimeMessage(msg, _sender, sendResponse) {
    if (!msg || typeof msg.type !== 'string') return;
    if (msg.type === MSG.GET_STATUS) {
      sendResponse({
        ok: true,
        supported: isSupportedUrl(location.href),
        mounted: state === S.MOUNTED || state === S.DEGRADED,
        state,
        url: location.href
      });
      return true;
    }
    if (msg.type === MSG.REFRESH) {
      markExtractorCacheDirty();
      scheduleRefresh(true, { resetSectionExpansion: true });
      sendResponse({ ok: true });
      return true;
    }
    return undefined;
  }

  function evaluate() {
    if (!settings) return;
    const supported = isSupportedUrl(location.href);
    if (!supported) {
      if (state !== S.IDLE || descriptionOnlyActive) tearDown('unsupported url');
      return;
    }
    const panelOn = isOverviewPanelEnabled(settings);
    const descOn = isDescriptionFeatureEnabled(settings);
    if (!panelOn && !descOn) {
      if (state !== S.IDLE || descriptionOnlyActive) tearDown('all features disabled');
      return;
    }

    const recordId = liveRecordId();
    if (!recordId) return;

    const recordChanged = recordId !== currentRecordId;
    if (recordChanged) {
      if (state !== S.IDLE || descriptionOnlyActive) {
        log.debug('record changed', { from: currentRecordId, to: recordId });
        tearDown('record change');
      }
    }

    if (panelOn) {
      if (state === S.IDLE) beginWaiting(recordId);
      else if (state === S.DEGRADED) checkHydration();
    } else {
      if (state !== S.IDLE) {
        log.debug('panel disabled; removing panel UI, keeping description enhancer');
        tearDownPanelOnly();
        if (descOn) descriptionEnhancer.clear();
        currentRecordId = recordId;
      }
    }

    if (descOn && !panelOn) {
      currentRecordId = recordId;
      if (!descriptionOnlyActive || recordChanged) startDescriptionOnly();
    } else if (!descOn && descriptionOnlyActive) {
      stopDescriptionOnly();
      descriptionEnhancer.clear();
    }
  }

  function runDescriptionOnlyPass() {
    if (!descriptionOnlyActive || !settings) return;
    refreshExtractorCachesIfNeeded();
    const probeKeys = scopeProbeKeys();
    const scope = resolveActiveRecordScope(document.body, probeKeys) || document.body;
    ensureDescriptionOnlyObserver(scope);
    const applied = descriptionEnhancer.apply(scope, settings);
    if (!applied && descriptionOnlyActive) {
      markExtractorCacheDirty();
      scheduleDescriptionOnlyPass(HYDRATION_POLL_MS);
    }
  }

  function startDescriptionOnly() {
    descriptionOnlyActive = true;
    markExtractorCacheDirty();
    runDescriptionOnlyPass();
  }

  function ensureDescriptionOnlyObserver(scope) {
    const nextRoot = observerRootFor(scope);
    const connected = reconnectObserver(
      descriptionOnlyObserver,
      descriptionOnlyObserverRoot,
      nextRoot,
      {
        childList: true,
        subtree: true
      },
      () => {
        if (!descriptionOnlyActive) return;
        markExtractorCacheDirty();
        scheduleDescriptionOnlyPass(MOUNT_DEBOUNCE_MS);
      }
    );
    descriptionOnlyObserver = connected.observer;
    descriptionOnlyObserverRoot = connected.root;
  }

  function ensureWaitingObservers(scope) {
    const nextRoot = observerRootFor(scope);
    const structureObserver = reconnectObserver(
      mountObserver,
      mountObserverRoot,
      nextRoot,
      {
        childList: true,
        subtree: true
      },
      (records) => {
        const panel = ui.existing();
        for (const record of records) {
          if (!isRecordOutsidePanel(record, panel)) continue;
          markExtractorCacheDirty();
          waitingSectionExpansionRecord = null;
          scheduleHydrationCheck(MOUNT_DEBOUNCE_MS);
          return;
        }
      }
    );
    mountObserver = structureObserver.observer;
    mountObserverRoot = structureObserver.root;

    const attributeObserver = reconnectObserver(
      mountAttributeObserver,
      mountAttributeObserverRoot,
      nextRoot,
      {
        attributes: true,
        attributeFilter: ['aria-expanded'],
        subtree: true
      },
      (records) => {
        const panel = ui.existing();
        for (const record of records) {
          if (!isRecordOutsidePanel(record, panel)) continue;
          if (!isExpandedSectionMutation(record)) continue;
          markExtractorCacheDirty();
          waitingSectionExpansionRecord = null;
          scheduleHydrationCheck(SECTION_EXPANSION_SETTLE_MS);
          return;
        }
      }
    );
    mountAttributeObserver = attributeObserver.observer;
    mountAttributeObserverRoot = attributeObserver.root;

    if (!bodyObserver) {
      bodyObserver = new MutationObserver((records) => {
        if (state !== S.WAITING && state !== S.DEGRADED) return;
        let outsidePanelChange = false;
        const panel = ui.existing();
        for (const record of records) {
          if (record.type !== 'childList') continue;
          for (const node of record.addedNodes) {
            if (panel && panel.contains(node)) continue;
            outsidePanelChange = true;
            break;
          }
          if (outsidePanelChange) break;
          for (const node of record.removedNodes) {
            if (panel && panel.contains(node)) continue;
            outsidePanelChange = true;
            break;
          }
          if (outsidePanelChange) break;
        }
        if (!outsidePanelChange) return;
        ensureWaitingObservers(activeScope);
        markExtractorCacheDirty();
        waitingSectionExpansionRecord = null;
        scheduleHydrationCheck(MOUNT_DEBOUNCE_MS);
      });
      bodyObserver.observe(document.body, { childList: true });
    }
  }

  function ensureMountedObservers(scope) {
    const nextRoot = observerRootFor(scope);
    const structureObserver = reconnectObserver(
      rerenderObserver,
      rerenderObserverRoot,
      nextRoot,
      {
        childList: true,
        subtree: true
      },
      (records) => {
        if (state !== S.MOUNTED) return;
        const panel = ui.existing();
        for (const record of records) {
          if (!isRecordOutsidePanel(record, panel)) continue;
          markExtractorCacheDirty();
          scheduleRefresh(false, { idle: true, resetRevalidate: true });
          return;
        }
      }
    );
    rerenderObserver = structureObserver.observer;
    rerenderObserverRoot = structureObserver.root;

    const attributeObserver = reconnectObserver(
      rerenderAttributeObserver,
      rerenderAttributeObserverRoot,
      nextRoot,
      {
        attributes: true,
        attributeFilter: ['aria-expanded'],
        subtree: true
      },
      (records) => {
        if (state !== S.MOUNTED) return;
        const panel = ui.existing();
        for (const record of records) {
          if (!isRecordOutsidePanel(record, panel)) continue;
          if (!isExpandedSectionMutation(record)) continue;
          markExtractorCacheDirty();
          scheduleRefresh(true, { idle: true, resetRevalidate: true });
          return;
        }
      }
    );
    rerenderAttributeObserver = attributeObserver.observer;
    rerenderAttributeObserverRoot = attributeObserver.root;

    if (!bodyObserver) {
      bodyObserver = new MutationObserver((records) => {
        if (state !== S.MOUNTED) return;
        const liveId = liveRecordId();
        if (liveId && liveId !== currentRecordId) {
          tearDown('record drift in observer');
          beginWaiting(liveId);
          return;
        }
        const panel = ui.existing();
        if (!panel) {
          log.debug('panel removed from body, remounting');
          if (!cachedShell) cachedShell = buildPanel();
          if (currentRecordId) cachedShell.panel.setAttribute('data-record-id', currentRecordId);
          ui.mountInto(cachedShell.panel);
          applyHeightMode(cachedShell.panel);
          if (!settings.panelFullHeight) {
            ui.attachResize(cachedShell, settings.panelHeightPercent, persistHeight);
          }
          lastResultsKey = '';
          restartRevalidateTimer();
          rerenderValues();
          return;
        }

        let outsidePanelChange = false;
        for (const record of records) {
          if (record.type !== 'childList') continue;
          for (const node of record.addedNodes) {
            if (panel.contains(node)) continue;
            outsidePanelChange = true;
            break;
          }
          if (outsidePanelChange) break;
          for (const node of record.removedNodes) {
            if (panel.contains(node)) continue;
            outsidePanelChange = true;
            break;
          }
          if (outsidePanelChange) break;
        }
        if (!outsidePanelChange) return;
        ensureMountedObservers(activeScope);
        markExtractorCacheDirty();
        scheduleRefresh(false, { idle: true, resetRevalidate: true });
      });
      bodyObserver.observe(document.body, { childList: true });
    }
  }

  function beginWaiting(recordId) {
    clearWaitingLoop();
    markExtractorCacheDirty();
    currentRecordId = recordId;
    activeScope = null;
    lastScopeLogKey = '';
    setState(S.WAITING);

    // Mount skeleton immediately into best-effort container so user sees
    // instant feedback. If the preferred container shows up later, we
    // re-mount.
    mountSkeleton();

    hydrationDeadline = Date.now() + HYDRATION_TIMEOUT_MS;
    ensureWaitingObservers(activeScope);
    scheduleHydrationCheck(0);
  }

  function cancelScheduledHydrationCheck() {
    if (hydrationCheckHandle == null) return;
    if (hydrationCheckMode === 'idle' && typeof root.cancelIdleCallback === 'function') {
      root.cancelIdleCallback(hydrationCheckHandle);
    } else {
      clearTimeout(hydrationCheckHandle);
    }
    hydrationCheckHandle = null;
    hydrationCheckMode = '';
    hydrationCheckDelay = Number.POSITIVE_INFINITY;
  }

  function scheduleHydrationCheck(delay = MOUNT_DEBOUNCE_MS) {
    if (state !== S.WAITING && state !== S.DEGRADED) return;
    const nextDelay = Math.max(0, delay);
    if (hydrationCheckHandle != null) {
      if (nextDelay >= hydrationCheckDelay) return;
      cancelScheduledHydrationCheck();
    }

    const run = () => {
      hydrationCheckHandle = null;
      hydrationCheckMode = '';
      hydrationCheckDelay = Number.POSITIVE_INFINITY;
      checkHydration();
    };

    hydrationCheckDelay = nextDelay;
    if (typeof root.requestIdleCallback === 'function') {
      hydrationCheckMode = 'idle';
      hydrationCheckHandle = root.requestIdleCallback(run, { timeout: nextDelay });
      return;
    }

    hydrationCheckMode = 'timeout';
    hydrationCheckHandle = setTimeout(run, nextDelay);
  }

  function renderFailedState() {
    if (!cachedShell) cachedShell = buildPanel();
    if (currentRecordId) cachedShell.panel.setAttribute('data-record-id', currentRecordId);
    if (!ui.existing()) ui.mountInto(cachedShell.panel);
    applyHeightMode(cachedShell.panel);
    if (!settings.panelFullHeight) {
      ui.attachResize(cachedShell, settings.panelHeightPercent, persistHeight);
    }
    ui.renderEmpty(
      cachedShell.content,
      'Opportunity overview unavailable on this page.',
      'Refresh or reopen the record to try again.'
    );
  }

  function enterRecoveryBackoff(token) {
    clearWaitingLoop();
    log.warn('hydration timeout; no stable active record scope found', {
      recordId: token
    });
    renderFailedState();
    setState(S.DEGRADED);
    scheduleHydrationCheck(HYDRATION_BACKOFF_MS);
  }

  function checkHydration() {
    if (state !== S.WAITING && state !== S.DEGRADED) return;
    refreshExtractorCachesIfNeeded();
    const waitingAggressively = state === S.WAITING;
    const token = currentRecordId;
    ensureWaitingObservers(activeScope);
    if (settings.autoExpandSections !== false && waitingSectionExpansionRecord !== token) {
      const expansionRoot = activeScope &&
        activeScope.isConnected &&
        document.body.contains(activeScope)
        ? activeScope
        : document.body;
      const expandedCount = NS.sectionExpander.expandAll(expansionRoot);
      if (expandedCount > 0) {
        waitingSectionExpansionRecord = token;
        markExtractorCacheDirty();
        scheduleHydrationCheck(SECTION_EXPANSION_SETTLE_MS);
        return;
      }
    }
    const resolved = resolveScopeForRecord(token, activeScope);
    if (resolved.stale) return;
    if (!resolved.scope) {
      if (waitingAggressively && Date.now() > hydrationDeadline) {
        enterRecoveryBackoff(token);
        return;
      }
      markExtractorCacheDirty();
      if (waitingAggressively) scheduleHydrationCheck(HYDRATION_POLL_MS);
      else scheduleHydrationCheck(HYDRATION_BACKOFF_MS);
      return;
    }
    if (waitingSectionExpansionRecord === token) {
      sectionsExpandedForRecord = token;
      sectionsExpandedScope = resolved.scope;
      waitingSectionExpansionRecord = null;
    }
    ensureWaitingObservers(resolved.scope);
    if (isHydrated(resolved.scope, resolved.probeKeys)) {
      finalizeMount({ token, scope: resolved.scope });
      return;
    }
    if (waitingAggressively && Date.now() > hydrationDeadline) {
      log.warn('hydration timeout; rendering scoped empty panel', {
        recordId: token
      });
      finalizeMount({ token, scope: resolved.scope });
      return;
    }
    markExtractorCacheDirty();
    if (waitingAggressively) scheduleHydrationCheck(HYDRATION_POLL_MS);
    else scheduleHydrationCheck(HYDRATION_BACKOFF_MS);
  }

  function buildPanel() {
    const shell = ui.buildShell({
      collapsed: settings.defaultCollapsed || window.innerWidth < 720,
      onToggle: (btn) => {
        const panel = ui.existing();
        if (!panel) return;
        const collapsed = panel.classList.toggle('is-collapsed');
        btn.textContent = collapsed ? ui.TOGGLE_SHOW : ui.TOGGLE_HIDE;
        btn.setAttribute('aria-expanded', String(!collapsed));
      },
      onRefresh: () => scheduleRefresh(true, { resetSectionExpansion: true }),
      onConfigure: () => {
        NS.messages.send({ type: MSG.OPEN_OPTIONS });
      }
    });
    return shell;
  }

  /* Persist height changes from the drag handle. The in-memory settings
   * update synchronously so applyHeightMode (called on every rerender) uses
   * the drag-set value instead of clobbering back to the stored one. The
   * chrome.storage write is debounced — we only commit the final value. */
  let heightSaveTimer = null;
  function persistHeight(pct) {
    if (!settings) return;
    settings.panelHeightPercent = pct;
    if (heightSaveTimer) clearTimeout(heightSaveTimer);
    heightSaveTimer = setTimeout(() => {
      heightSaveTimer = null;
      storage.set({ panelHeightPercent: pct }).catch(() => { /* best-effort */ });
    }, 300);
  }

  let cachedShell = null;
  let lastResultsKey = '';      // fingerprint of the last rendered payload, used to skip no-op re-renders
  let completionTimer = null;   // polling fallback until all fields populated
  let completionDeadline = 0;
  let completionPollDelay = HYDRATION_POLL_MS;

  function applyHeightMode(panel) {
    if (!panel || !cachedShell) return;
    const body = cachedShell.body;
    if (settings.panelFullHeight) {
      panel.classList.add('is-full-height');
      // Full-height is driven by the .is-full-height CSS rule so the
      // collapsed state can shrink the panel back to its header.
      if (body) body.style.maxHeight = '';
    } else {
      panel.classList.remove('is-full-height');
      if (body) body.style.maxHeight = `calc(${settings.panelHeightPercent}vh - 54px)`;
    }
  }

  function stopRevalidateTimer() {
    if (!revalidateTimer) return;
    clearTimeout(revalidateTimer);
    revalidateTimer = null;
  }

  function resetRevalidateBackoff() {
    revalidateDelay = REVALIDATE_BASE_MS;
  }

  function ensureRevalidateTimer() {
    if (revalidateTimer) return;
    if (state !== S.MOUNTED) return;
    if (!isDocumentVisible()) return;
    revalidateTimer = setTimeout(() => {
      revalidateTimer = null;
      if (!isDocumentVisible()) return;
      if (state !== S.MOUNTED) return;
      markExtractorCacheDirty();
      const result = rerenderValues();
      if (result && result.stale) return;
      if (result && result.waiting) {
        resetRevalidateBackoff();
        ensureRevalidateTimer();
        return;
      }
      if (result && result.unchanged) {
        revalidateDelay = Math.min(revalidateDelay * 2, REVALIDATE_MAX_MS);
      } else {
        resetRevalidateBackoff();
      }
      ensureRevalidateTimer();
    }, revalidateDelay);
  }

  function restartRevalidateTimer(reset = true) {
    stopRevalidateTimer();
    if (reset) resetRevalidateBackoff();
    ensureRevalidateTimer();
  }

  function mountSkeleton() {
    if (!cachedShell) cachedShell = buildPanel();
    if (currentRecordId) cachedShell.panel.setAttribute('data-record-id', currentRecordId);
    if (!ui.existing()) ui.mountInto(cachedShell.panel);
    applyHeightMode(cachedShell.panel);
    if (!settings.panelFullHeight) {
      ui.attachResize(cachedShell, settings.panelHeightPercent, persistHeight);
    }
    ui.renderSkeleton(cachedShell.content, settings.selectedFields.length || 6);
  }

  function finalizeMount({ token, scope }) {
    clearWaitingLoop();
    if (!ui.existing()) mountSkeleton();
    const result = rerenderValues({ token, scope });
    if (result && result.stale) return;
    if (result && result.waiting) {
      setState(S.WAITING);
      scheduleHydrationCheck();
      return;
    }
    if (isRenderTokenStale(token)) return;
    setState(S.MOUNTED);
    watchForRerender(scope);
    // Revalidation fallback: shadow-root updates can bypass the observer, so
    // keep a mounted extract timer that starts at 3s, backs off on stable
    // pages, and stops entirely while the tab is hidden.
    restartRevalidateTimer();
  }

  function scheduleDiscoveryScan(token, scope) {
    if (!token || !scope || typeof discoverFields !== 'function') return;
    const key = `${token}|${scopeDiscoveryId(scope)}`;
    if (!key || key === lastDiscoveryScanKey || key === pendingDiscoveryScanKey) return;
    pendingDiscoveryScanKey = key;

    const run = async () => {
      discoveryScanHandle = null;
      discoveryScanMode = '';
      pendingDiscoveryScanKey = '';
      if (isRenderTokenStale(token) || !scope.isConnected) return;
      try {
        const discovered = discoverFields(scope);
        const merged = await discoveryStore.merge(discovered.discoveries, {
          resolvedServiceNowNames: discovered.resolvedServiceNowNames || []
        });
        lastDiscoveryScanKey = key;
        applyDiscoveredFields(merged);
      } catch (error) {
        log.debug('field discovery scan failed', error && error.message);
      }
    };

    if (typeof root.requestIdleCallback === 'function') {
      discoveryScanMode = 'idle';
      discoveryScanHandle = root.requestIdleCallback(() => { run(); }, {
        timeout: MOUNT_DEBOUNCE_MS
      });
      return;
    }

    discoveryScanMode = 'timeout';
    discoveryScanHandle = setTimeout(() => { run(); }, MOUNT_DEBOUNCE_MS);
  }

  function appendFingerprint(hash, value) {
    const text = String(value || '');
    let next = hash | 0;
    for (let i = 0; i < text.length; i++) {
      next = ((next << 5) + next + text.charCodeAt(i)) | 0;
    }
    return ((next << 5) + next + text.length) | 0;
  }

  function layoutFingerprint(layout) {
    if (!Array.isArray(layout) || layout.length === 0) return '0|0';
    let hash = 5381;
    for (const item of layout) {
      if (!item) {
        hash = appendFingerprint(hash, 'null');
        continue;
      }
      hash = appendFingerprint(hash, item.type || '');
      if (item.type === 'field') {
        hash = appendFingerprint(hash, item.key || '');
      } else if (item.type === 'empty') {
        hash = appendFingerprint(hash, item.id || '');
      }
      hash = appendFingerprint(hash, Number.isFinite(item.span) ? Math.round(item.span) : '');
    }
    return `${layout.length}|${hash}`;
  }

  function resultsFingerprint(selectedKeys, results, layout, requestedColumns, responsiveColumns, autoHeight) {
    let hash = 5381;
    const keys = Array.isArray(selectedKeys) ? selectedKeys : [];
    for (const key of keys) {
      const result = results[key] || {};
      const badges = Array.isArray(result.badges) ? result.badges : [];
      hash = appendFingerprint(hash, key);
      hash = appendFingerprint(hash, result.value || '');
      hash = appendFingerprint(hash, badges.length);
      for (const badge of badges) {
        hash = appendFingerprint(hash, badge);
      }
    }
    return [
      keys.length,
      requestedColumns || 0,
      responsiveColumns || 0,
      autoHeight ? 1 : 0,
      layoutFingerprint(layout),
      hash
    ].join('|');
  }

  function rerenderValues(opts = {}) {
    if (!cachedShell) return { rendered: false };
    const token = opts.token || currentRecordId;
    if (!token) return { rendered: false };
    if (isRenderTokenStale(token)) {
      const nextId = liveRecordId();
      log.info('record drift detected in rerender; remounting', {
        from: token,
        tracked: currentRecordId,
        to: nextId
      });
      if (nextId) {
        tearDown('record drift');
        beginWaiting(nextId);
      } else {
        evaluate();
      }
      return { stale: true };
    }

    refreshExtractorCachesIfNeeded();
    const resolved = resolveScopeForRecord(token, opts.scope || activeScope);
    if (resolved.stale) return { stale: true };
    if (!resolved.scope) {
      return { waiting: true };
    }

    const scope = resolved.scope;
    if (state === S.MOUNTED) ensureMountedObservers(scope);
    if (settings.autoExpandSections !== false) {
      if (sectionExpansionPendingFor(token, scope)) {
        return { rendered: false, settling: true };
      }
      if (!sectionExpansionSettledFor(token, scope)) {
        const expandedCount = NS.sectionExpander.expandAll(scope);
        sectionsExpandedForRecord = token;
        sectionsExpandedScope = scope;
        if (expandedCount > 0) {
          markExtractorCacheDirty();
          sectionExpansionPendingRecord = token;
          sectionExpansionPendingScope = scope;
          scheduleSectionExpansionSettle(token);
          return { rendered: false, settling: true };
        }
      }
    }
    descriptionEnhancer.apply(scope, settings);
    if (isRenderTokenStale(token)) {
      log.debug('discarded render after section expansion', {
        token,
        tracked: currentRecordId,
        live: liveRecordId()
      });
      return { stale: true };
    }

    const results = extractAll(scope, settings.selectedFields);
    if (isRenderTokenStale(token)) {
      log.debug('discarded extracted values for stale record', {
        token,
        tracked: currentRecordId,
        live: liveRecordId()
      });
      return { stale: true };
    }

    const responsiveColumns = effectiveColumns();
    const key = token + '|' + resultsFingerprint(
      settings.selectedFields,
      results,
      settings.fieldLayout || [],
      settings.columns,
      responsiveColumns,
      !!settings.descriptionAutoHeight
    );
    if (key === lastResultsKey) {
      maybeScheduleCompletionPoll(results);
      log.debug('values unchanged, skipping render', { recordId: token });
      return { rendered: false, unchanged: true };
    }
    lastResultsKey = key;
    lastResponsiveColumns = responsiveColumns;
    cachedShell.panel.setAttribute('data-record-id', token);
    ui.renderValues(cachedShell.content, settings.selectedFields, results, {
      columns: settings.columns,
      descriptionAutoHeight: settings.descriptionAutoHeight,
      layout: settings.fieldLayout
    });
    scheduleDiscoveryScan(token, scope);
    applyHeightMode(cachedShell.panel);
    if (NS.log.debugEnabled) {
      const summary = Object.fromEntries(
        Object.entries(results).map(([k, r]) => [k, r.found ? r.source : 'miss'])
      );
      log.debug('render', summary);
    }
    maybeScheduleCompletionPoll(results);
    return { rendered: true };
  }

  /* If any selected field is still missing, keep polling for a while. SN
   * renders fields asynchronously and the initial mount often precedes the
   * final field paint. Combined with the mutation observer below, this
   * guarantees the panel converges without any user action. */
  function maybeScheduleCompletionPoll(results) {
    const missing = settings.selectedFields.some((key) => !results[key] || !results[key].found);
    if (!missing) {
      if (completionTimer) { clearTimeout(completionTimer); completionTimer = null; }
      completionDeadline = 0;
      completionPollDelay = HYDRATION_POLL_MS;
      return;
    }
    if (completionTimer) return;
    if (!completionDeadline) {
      completionDeadline = Date.now() + HYDRATION_TIMEOUT_MS;
      completionPollDelay = HYDRATION_POLL_MS;
    }
    if (Date.now() > completionDeadline) {
      log.debug('completion poll gave up; some fields still missing');
      completionTimer = null;
      completionDeadline = 0;
      completionPollDelay = HYDRATION_POLL_MS;
      return;
    }
    const nextDelay = completionPollDelay;
    completionTimer = setTimeout(() => {
      completionTimer = null;
      completionPollDelay = Math.min(nextDelay * 2, COMPLETION_POLL_MAX_MS);
      markExtractorCacheDirty();
      rerenderValues();
    }, nextDelay);
  }

  /* Observer does two jobs:
   *   1. Remount our panel if ServiceNow's shell wipes it.
   *   2. Re-run extraction when SN mutates the record form (fields populate
   *      asynchronously; Description/Next Step often arrive after the grid
   *      fields).
   *
   * Feedback loop prevention:
   *   - We ignore mutations whose target is inside our own panel.
   *   - `rerenderValues` is diff-guarded via `lastResultsKey`, so identical
   *     extractions do not write to the DOM.
   *   - The refresh is debounced via scheduleRefresh. */
  function watchForRerender(scope) {
    ensureMountedObservers(scope || activeScope);
  }

  function scheduleRefresh(immediate, opts = {}) {
    if (state !== S.MOUNTED && state !== S.WAITING && state !== S.DEGRADED) return;
    if (opts.resetRevalidate && state === S.MOUNTED) restartRevalidateTimer();
    clearScheduledRefresh();
    const delay = typeof opts.delay === 'number'
      ? Math.max(0, opts.delay)
      : (immediate ? 0 : REFRESH_DEBOUNCE_MS);
    const run = () => {
      refreshDebounceTimer = null;
      refreshDebounceMode = '';
      if (opts.resetSectionExpansion) resetSectionExpansionTracking();
      const liveId = liveRecordId();
      if (liveId && liveId !== currentRecordId) {
        evaluate();
        return;
      }
      if (state === S.DEGRADED) {
        beginWaiting(currentRecordId);
        return;
      }
      if (!ui.existing()) {
        log.debug('panel missing, rebuilding');
        cachedShell = buildPanel();
        if (currentRecordId) cachedShell.panel.setAttribute('data-record-id', currentRecordId);
        ui.mountInto(cachedShell.panel);
        applyHeightMode(cachedShell.panel);
        if (!settings.panelFullHeight) {
          ui.attachResize(cachedShell, settings.panelHeightPercent, persistHeight);
        }
      }
      rerenderValues();
    };
    if (opts.idle && typeof root.requestIdleCallback === 'function') {
      refreshDebounceMode = 'idle';
      refreshDebounceTimer = root.requestIdleCallback(run, { timeout: delay });
      return;
    }
    refreshDebounceMode = 'timeout';
    refreshDebounceTimer = setTimeout(run, delay);
  }

  NS.controller = { init, _state: () => state };
})(typeof self !== 'undefined' ? self : globalThis);
