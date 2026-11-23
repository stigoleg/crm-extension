(function (root) {
  'use strict';
  const NS = (root.SNCRM = root.SNCRM || {});
  const log = NS.log.make('discovery-store');
  const { DISCOVERY_STORAGE_KEY } = NS.constants;

  function clone(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
  }

  function normalizeName(value) {
    return String(value || '').trim();
  }

  function normalizeLabel(value, fallback) {
    const label = String(value || '').replace(/\s+/g, ' ').trim();
    return label || fallback || '';
  }

  function normalizeGroup(value) {
    const group = String(value || '').replace(/\s+/g, ' ').trim();
    return group || 'Other';
  }

  function normalizeRenderAs(value) {
    switch (value) {
      case 'badge':
      case 'badge-list':
      case 'date':
      case 'link':
      case 'markdown':
        return value;
      default:
        return 'text';
    }
  }

  function normalizeReason(value) {
    return value === 'known' ? 'known' : (value === 'name-change' ? 'name-change' : 'new-field');
  }

  function detectedKeyFor(serviceNowName) {
    return NS.fieldRegistry && typeof NS.fieldRegistry.detectedKeyFor === 'function'
      ? NS.fieldRegistry.detectedKeyFor(serviceNowName)
      : `detected:${serviceNowName}`;
  }

  function normalizeField(item, now = Date.now()) {
    if (!item || typeof item !== 'object') return null;
    const serviceNowName = normalizeName(item.serviceNowName);
    if (!serviceNowName) return null;
    if (
      NS.fieldRegistry &&
      typeof NS.fieldRegistry.isInternalDiscoveryNoiseName === 'function' &&
      NS.fieldRegistry.isInternalDiscoveryNoiseName(serviceNowName)
    ) {
      if (
        serviceNowName === '_input' ||
        !NS.fieldRegistry.hasStaticField ||
        !NS.fieldRegistry.hasStaticField(NS.fieldRegistry.internalCompanionBaseName(serviceNowName))
      ) {
        return null;
      }
    }
    const companionBaseName = NS.fieldRegistry && typeof NS.fieldRegistry.internalCompanionBaseName === 'function'
      ? NS.fieldRegistry.internalCompanionBaseName(serviceNowName)
      : '';
    if (
      companionBaseName &&
      NS.fieldRegistry &&
      typeof NS.fieldRegistry.hasStaticField === 'function' &&
      NS.fieldRegistry.hasStaticField(companionBaseName)
    ) {
      return null;
    }
    const reason = normalizeReason(item.reason);
    const label = normalizeLabel(
      item.label,
      NS.fieldRegistry && typeof NS.fieldRegistry.friendlyDetectedLabel === 'function'
        ? NS.fieldRegistry.friendlyDetectedLabel(serviceNowName)
        : serviceNowName
    );
    let key = normalizeName(item.key);
    if (!key) {
      if (
        reason === 'known' &&
        NS.fieldRegistry &&
        typeof NS.fieldRegistry.hasStaticField === 'function' &&
        NS.fieldRegistry.hasStaticField(serviceNowName)
      ) {
        key = serviceNowName;
      } else {
        key = detectedKeyFor(serviceNowName);
      }
    }
    /* A discovered field can become part of the static registry later. Fold
     * those stale `detected:` entries into `known` ones so the options page
     * stops reporting them as changes while their live section still wins. */
    const staticNow = reason !== 'known' &&
      NS.fieldRegistry &&
      typeof NS.fieldRegistry.hasStaticField === 'function' &&
      NS.fieldRegistry.hasStaticField(serviceNowName);
    if (staticNow) {
      key = serviceNowName;
    }
    const firstSeenAt = Number.isFinite(item.firstSeenAt) ? Math.round(item.firstSeenAt) : now;
    const lastSeenAt = Number.isFinite(item.lastSeenAt) ? Math.round(item.lastSeenAt) : now;
    const normalized = {
      key,
      serviceNowName,
      label,
      group: normalizeGroup(item.group),
      renderAs: normalizeRenderAs(item.renderAs),
      reason: staticNow ? 'known' : reason,
      firstSeenAt: Math.min(firstSeenAt, lastSeenAt),
      lastSeenAt: Math.max(firstSeenAt, lastSeenAt)
    };
    if (typeof item.matchedRegistryKey === 'string' && item.matchedRegistryKey.trim()) {
      normalized.matchedRegistryKey = item.matchedRegistryKey.trim();
    }
    return normalized;
  }

  function sortFields(fields) {
    return fields.sort((a, b) => (
      a.group.localeCompare(b.group) ||
      a.label.localeCompare(b.label) ||
      a.serviceNowName.localeCompare(b.serviceNowName)
    ));
  }

  function normalizeFields(raw) {
    const fields = Array.isArray(raw)
      ? raw
      : raw && Array.isArray(raw.fields)
        ? raw.fields
        : [];
    const byName = new Map();
    const now = Date.now();
    for (const item of fields) {
      const normalized = normalizeField(item, now);
      if (!normalized) continue;
      const prev = byName.get(normalized.serviceNowName);
      if (!prev || normalized.lastSeenAt >= prev.lastSeenAt) {
        byName.set(normalized.serviceNowName, normalized);
      }
    }
    return sortFields(Array.from(byName.values()));
  }

  async function get() {
    try {
      const stored = await chrome.storage.local.get(DISCOVERY_STORAGE_KEY);
      return normalizeFields(stored[DISCOVERY_STORAGE_KEY]);
    } catch (error) {
      log.error('read failed, using empty discovery list', error);
      return [];
    }
  }

  async function save(fields) {
    const normalized = normalizeFields(fields);
    try {
      await chrome.storage.local.set({
        [DISCOVERY_STORAGE_KEY]: clone(normalized)
      });
    } catch (error) {
      log.error('write failed', error);
      throw error;
    }
    return normalized;
  }

  async function merge(incoming, opts = {}) {
    const current = await get();
    const now = Date.now();
    const nextByName = new Map(current.map((item) => [item.serviceNowName, item]));

    for (const item of incoming || []) {
      const normalized = normalizeField(item, now);
      if (!normalized) continue;
      const previous = nextByName.get(normalized.serviceNowName);
      nextByName.set(normalized.serviceNowName, {
        ...previous,
        ...normalized,
        firstSeenAt: previous ? previous.firstSeenAt : normalized.firstSeenAt,
        lastSeenAt: normalized.lastSeenAt
      });
    }

    const keepDetectedKeys = opts.keepDetectedKeys && typeof opts.keepDetectedKeys.has === 'function'
      ? opts.keepDetectedKeys
      : new Set(Array.isArray(opts.keepDetectedKeys) ? opts.keepDetectedKeys : []);
    for (const serviceNowName of opts.resolvedServiceNowNames || []) {
      const existing = nextByName.get(serviceNowName);
      if (!existing) continue;
      if (keepDetectedKeys.has(existing.key)) continue;
      nextByName.delete(serviceNowName);
    }

    return save(Array.from(nextByName.values()));
  }

  function onChange(listener) {
    const handler = (changes, area) => {
      if (area !== 'local') return;
      if (!Object.prototype.hasOwnProperty.call(changes, DISCOVERY_STORAGE_KEY)) return;
      listener(normalizeFields(changes[DISCOVERY_STORAGE_KEY].newValue));
    };
    chrome.storage.onChanged.addListener(handler);
    return () => chrome.storage.onChanged.removeListener(handler);
  }

  NS.discoveryStore = { get, save, merge, onChange, normalizeFields };
})(typeof self !== 'undefined' ? self : globalThis);
