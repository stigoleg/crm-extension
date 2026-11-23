(function (root) {
  'use strict';
  const NS = (root.SNCRM = root.SNCRM || {});
  const { STORAGE_KEY, SETTINGS_VERSION } = NS.constants;
  const log = NS.log.make('storage');
  const DEFAULT_COLUMNS = 3;
  const MAX_LAYOUT_COLUMNS = 4;
  const FULL_SPAN_KEYS = new Set(['description', 'next_step', 'apps_comments']);

  const DEFAULT_FIELDS = [
    'account',
    'opportunity_name',
    'stage',
    'due_date',
    'close_date',
    'bid_room',
    'apps_status',
    'apps_client_developer',
    'apps_community',
    'apps_opportunity_manager',
    'apps_opportunity_team',
    'description',
    'next_step'
  ];

  function normalizeSpan(span, fallback) {
    const value = Number.isFinite(span) ? Math.round(span) : fallback;
    return Math.max(1, Math.min(MAX_LAYOUT_COLUMNS, value || 1));
  }

  function defaultSpanForKey(key, columns) {
    return FULL_SPAN_KEYS.has(key) ? columns : 1;
  }

  function fieldLayoutFromKeys(keys, columns) {
    return (keys || []).map((key) => ({
      type: 'field',
      key,
      span: defaultSpanForKey(key, columns)
    }));
  }

  function selectedFieldsFromLayout(layout) {
    const out = [];
    const seen = new Set();
    for (const item of layout || []) {
      if (!item || item.type !== 'field' || typeof item.key !== 'string' || seen.has(item.key)) continue;
      seen.add(item.key);
      out.push(item.key);
    }
    return out;
  }

  /* Backwards-compatibility: the first registry used camelCase keys. Map old
   * selections to their current canonical column names so user settings
   * survive the upgrade. Unknown legacy keys are silently dropped. */
  const LEGACY_KEY_MAP = Object.freeze({
    name: 'opportunity_name',
    dueDate: 'due_date',
    closeDate: 'close_date',
    appsStatus: 'apps_status',
    appsClientOwner: 'apps_client_developer',
    appsCommunity: 'apps_community',
    appsOpportunityManager: 'apps_opportunity_manager',
    appsOpportunityTeam: 'apps_opportunity_team',
    nextStep: 'next_step',
    shortDescription: 'short_description',
    assignedTo: 'opportunity_owner',
    appsDealType: 'contract_category',
    appsRegion: 'region',
    workNotes: 'work_notes',
    createdOn: 'sys_created_on',
    updatedOn: 'sys_updated_on'
  });

  const DEFAULTS = Object.freeze({
    version: SETTINGS_VERSION,
    enabled: true,
    debug: false,
    defaultCollapsed: false,
    columns: DEFAULT_COLUMNS,
    autoExpandSections: true,
    enhanceOriginalDescription: true,
    largeOriginalDescription: true,
    originalDescriptionHeight: null,
    /* Format used by the copy button on the native Description field and the
     * panel's Description card: 'markdown' copies the raw source, 'rich'
     * writes rendered HTML (with a plain-text fallback in the same write). */
    descriptionCopyFormat: 'markdown',
    /* Banner height as a percentage of viewport height. User-adjustable via
     * the drag handle on the bottom edge of the panel. Clamped to [15, 90]. */
    panelHeightPercent: 50,
    /* If true, the expanded panel covers the full viewport (100vh) and the
     * drag handle is hidden. If false, the panel is the height set by
     * `panelHeightPercent` and draggable. */
    panelFullHeight: true,
    /* If true, the Description block grows to fit its content (no internal
     * scrollbar). The panel scrollbar takes over for very long content. */
    descriptionAutoHeight: true,
    fieldLayout: fieldLayoutFromKeys(DEFAULT_FIELDS, DEFAULT_COLUMNS),
    selectedFields: DEFAULT_FIELDS.slice()
  });
  const SETTING_KEYS = Object.freeze(
    Object.keys(DEFAULTS).filter((key) => key !== 'version')
  );
  const STORAGE_ITEM_KEYS = Object.freeze(
    Object.fromEntries(SETTING_KEYS.map((key) => [key, `${STORAGE_KEY}.${key}`]))
  );
  const STORAGE_WATCH_KEYS = new Set([STORAGE_KEY, ...Object.values(STORAGE_ITEM_KEYS)]);
  let extensionContextInvalidated = false;

  function clone(v) { return JSON.parse(JSON.stringify(v)); }

  function isExtensionContextInvalidatedError(error) {
    const message = error && typeof error.message === 'string'
      ? error.message
      : String(error || '');
    return /Extension context invalidated/i.test(message);
  }

  function normalizeFieldKeys(keys) {
    const migrated = (keys || [])
      .filter((k) => typeof k === 'string')
      .map((k) => LEGACY_KEY_MAP[k] || k);
    const seen = new Set();
    const deduped = [];
    for (const k of migrated) {
      if (seen.has(k)) continue;
      seen.add(k);
      deduped.push(k);
    }
    return deduped;
  }

  function normalizeFieldLayout(items, columns) {
    const out = [];
    const seenFields = new Set();
    let emptyIndex = 0;
    for (const item of items || []) {
      if (!item) continue;
      if (typeof item === 'string') {
        const key = LEGACY_KEY_MAP[item] || item;
        if (seenFields.has(key)) continue;
        seenFields.add(key);
        out.push({
          type: 'field',
          key,
          span: defaultSpanForKey(key, columns)
        });
        continue;
      }
      if (item.type === 'empty') {
        out.push({
          type: 'empty',
          id: typeof item.id === 'string' && item.id ? item.id : `empty-${emptyIndex++}`,
          span: 1
        });
        continue;
      }
      const key = typeof item.key === 'string' ? (LEGACY_KEY_MAP[item.key] || item.key) : '';
      if (!key || seenFields.has(key)) continue;
      seenFields.add(key);
      out.push({
        type: 'field',
        key,
        span: normalizeSpan(item.span, defaultSpanForKey(key, columns))
      });
    }
    return out;
  }

  /* Shape-validate persisted settings. Unknown fields are dropped. Missing
   * fields fall back to defaults. Returning a fresh object keeps callers free
   * to mutate without affecting the defaults. */
  function normalize(raw) {
    const out = clone(DEFAULTS);
    if (!raw || typeof raw !== 'object') return out;
    if (typeof raw.enabled === 'boolean') out.enabled = raw.enabled;
    if (typeof raw.debug === 'boolean') out.debug = raw.debug;
    if (typeof raw.defaultCollapsed === 'boolean') out.defaultCollapsed = raw.defaultCollapsed;
    if (raw.columns === 2 || raw.columns === 3 || raw.columns === 4) out.columns = raw.columns;
    if (typeof raw.autoExpandSections === 'boolean') out.autoExpandSections = raw.autoExpandSections;
    if (typeof raw.enhanceOriginalDescription === 'boolean') {
      out.enhanceOriginalDescription = raw.enhanceOriginalDescription;
    }
    if (typeof raw.largeOriginalDescription === 'boolean') {
      out.largeOriginalDescription = raw.largeOriginalDescription;
    }
    if (typeof raw.originalDescriptionHeight === 'number' && Number.isFinite(raw.originalDescriptionHeight)) {
      out.originalDescriptionHeight = Math.max(120, Math.round(raw.originalDescriptionHeight));
    }
    if (raw.descriptionCopyFormat === 'markdown' || raw.descriptionCopyFormat === 'rich') {
      out.descriptionCopyFormat = raw.descriptionCopyFormat;
    }
    if (typeof raw.panelHeightPercent === 'number' && Number.isFinite(raw.panelHeightPercent)) {
      out.panelHeightPercent = Math.max(15, Math.min(90, Math.round(raw.panelHeightPercent)));
    }
    if (typeof raw.panelFullHeight === 'boolean') out.panelFullHeight = raw.panelFullHeight;
    if (typeof raw.descriptionAutoHeight === 'boolean') out.descriptionAutoHeight = raw.descriptionAutoHeight;
    const hasFieldLayout = Array.isArray(raw.fieldLayout);
    const hasSelectedFields = Array.isArray(raw.selectedFields);
    if (hasFieldLayout) {
      out.fieldLayout = normalizeFieldLayout(raw.fieldLayout, out.columns);
    } else if (hasSelectedFields) {
      out.fieldLayout = fieldLayoutFromKeys(normalizeFieldKeys(raw.selectedFields), out.columns);
    }
    if (!hasFieldLayout && !hasSelectedFields) {
      out.fieldLayout = fieldLayoutFromKeys(DEFAULT_FIELDS, out.columns);
    }
    out.selectedFields = selectedFieldsFromLayout(out.fieldLayout);
    out.version = SETTINGS_VERSION;
    return out;
  }

  function readRawSettings(stored) {
    const legacy = stored && stored[STORAGE_KEY];
    const raw = legacy && typeof legacy === 'object' ? clone(legacy) : {};
    for (const key of SETTING_KEYS) {
      const storageKey = STORAGE_ITEM_KEYS[key];
      if (stored && Object.prototype.hasOwnProperty.call(stored, storageKey)) {
        raw[key] = stored[storageKey];
      }
    }
    return raw;
  }

  function sameValue(a, b) {
    return JSON.stringify(a) === JSON.stringify(b);
  }

  async function get() {
    if (extensionContextInvalidated) return clone(DEFAULTS);
    try {
      const res = await chrome.storage.sync.get([STORAGE_KEY, ...Object.values(STORAGE_ITEM_KEYS)]);
      return normalize(readRawSettings(res));
    } catch (e) {
      if (isExtensionContextInvalidatedError(e)) {
        extensionContextInvalidated = true;
        log.debug('extension context invalidated during read; using defaults');
        return clone(DEFAULTS);
      }
      log.error('read failed, using defaults', e);
      return clone(DEFAULTS);
    }
  }

  async function set(patch) {
    const current = await get();
    const nextPatch = { ...patch };
    if (!Object.prototype.hasOwnProperty.call(nextPatch, 'fieldLayout') && Array.isArray(nextPatch.selectedFields)) {
      nextPatch.fieldLayout = fieldLayoutFromKeys(normalizeFieldKeys(nextPatch.selectedFields), current.columns);
    }
    const next = normalize({ ...current, ...nextPatch });
    const entries = {};
    for (const key of SETTING_KEYS) {
      if (!Object.prototype.hasOwnProperty.call(nextPatch || {}, key)) continue;
      if (sameValue(current[key], next[key])) continue;
      entries[STORAGE_ITEM_KEYS[key]] = clone(next[key]);
    }
    if (extensionContextInvalidated) return next;
    try {
      if (Object.keys(entries).length > 0) {
        await chrome.storage.sync.set(entries);
      }
      const merged = Object.keys(entries).length > 0 ? await get() : next;
      log.debug('saved', merged);
      return merged;
    } catch (e) {
      if (isExtensionContextInvalidatedError(e)) {
        extensionContextInvalidated = true;
        log.debug('extension context invalidated during write; skipping persist');
        return next;
      }
      log.error('write failed', e);
      throw e;
    }
  }

  function onChange(listener) {
    const handler = (changes, area) => {
      if (area !== 'sync') return;
      if (!Object.keys(changes).some((key) => STORAGE_WATCH_KEYS.has(key))) {
        return;
      }
      get()
        .then((next) => listener(next, null))
        .catch((e) => log.error('read-after-change failed', e));
    };
    chrome.storage.onChanged.addListener(handler);
    return () => chrome.storage.onChanged.removeListener(handler);
  }

  NS.storage = { get, set, onChange, DEFAULTS, DEFAULT_FIELDS };
})(typeof self !== 'undefined' ? self : globalThis);
