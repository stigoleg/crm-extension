(function (root) {
  'use strict';
  const NS = (root.SNCRM = root.SNCRM || {});
  const log = NS.log.make('extract');
  const {
    byKey,
    findByLabel,
    findStaticByLabel,
    detectedKeyFor,
    friendlyDetectedLabel
  } = NS.fieldRegistry;
  const SECTION_HEADER_SELECTOR = 'span.sn-section-header.collapsable';
  const BADGE_SELECTOR = '.now-pill-button, [class~="now-pill-button"]';
  const LABEL_TEXT_SELECTOR = 'label, [role="label"], .label, .sn-form-label, now-label, span[class*="label"]';
  const LINK_LABEL_SELECTOR = `dt, .now-label-value-label, ${LABEL_TEXT_SELECTOR}`;
  const NBSP_RE = /\u00A0/g;
  const WHITESPACE_RE = /\s+/g;
  const URL_RE = /^https?:\/\/\S+$/i;
  const SYS_ID_RE = /^[a-f0-9]{32}(,[a-f0-9]{32})*$/i;
  const DATE_FIELD_HINT_RE = /\b(date|deadline|due|created|updated|start|end|extension|close)\b/i;
  let queryCacheByRoot = new WeakMap();
  let deepTraversalCacheByRoot = new WeakMap();
  let extractionContextByRoot = new WeakMap();
  let attributeVisibilityCache = new WeakMap();
  let styleVisibilityCache = new WeakMap();
  let visibilityCache = new WeakMap();
  let sectionHeaderCountCache = new WeakMap();

  /* ServiceNow Next Experience renders form fields inside web components whose
   * shadow roots are usually open. We walk both light and shadow DOM. Each
   * strategy returns { value, source } where source names the winning probe
   * for diagnostic logging. */

  function invalidateCache() {
    queryCacheByRoot = new WeakMap();
    deepTraversalCacheByRoot = new WeakMap();
    extractionContextByRoot = new WeakMap();
    attributeVisibilityCache = new WeakMap();
    styleVisibilityCache = new WeakMap();
    visibilityCache = new WeakMap();
    sectionHeaderCountCache = new WeakMap();
  }

  function queryCacheFor(rootEl) {
    if (!rootEl || (typeof rootEl !== 'object' && typeof rootEl !== 'function')) return null;
    let selectors = queryCacheByRoot.get(rootEl);
    if (!selectors) {
      selectors = new Map();
      queryCacheByRoot.set(rootEl, selectors);
    }
    return selectors;
  }

  function deepTraversalFor(rootEl) {
    if (!rootEl || (typeof rootEl !== 'object' && typeof rootEl !== 'function')) return [];
    const cached = deepTraversalCacheByRoot.get(rootEl);
    if (cached) return cached;
    const out = [];
    const visit = (node) => {
      if (!node) return;
      if (node.shadowRoot) visit(node.shadowRoot);
      for (let child = node.firstElementChild; child; child = child.nextElementSibling) {
        out.push(child);
        visit(child);
      }
    };
    visit(rootEl);
    deepTraversalCacheByRoot.set(rootEl, out);
    return out;
  }

  function deepQueryAll(rootEl, selector) {
    if (!rootEl || !selector) return [];
    const selectors = queryCacheFor(rootEl);
    if (selectors && selectors.has(selector)) return selectors.get(selector);
    const out = [];
    let selectorOk = true;
    for (const child of deepTraversalFor(rootEl)) {
      try {
        try {
          if (child.matches(selector)) out.push(child);
        } catch {
          selectorOk = false;
          break;
        }
      } catch {
        selectorOk = false;
        break;
      }
    }
    const results = selectorOk ? out : [];
    if (selectors) selectors.set(selector, results);
    return results;
  }

  function parentElementOrHost(node) {
    if (!node) return null;
    if (node.parentElement) return node.parentElement;
    const rootNode = node.getRootNode && node.getRootNode();
    return rootNode && rootNode.host instanceof Element ? rootNode.host : null;
  }

  function ancestorElements(node, stopEl) {
    const out = [];
    let cur = node instanceof Element ? node : parentElementOrHost(node);
    while (cur) {
      out.push(cur);
      if (stopEl && cur === stopEl) break;
      cur = parentElementOrHost(cur);
    }
    return out;
  }

  function textOf(el) {
    if (!el) return '';
    const t = (el.innerText || el.textContent || '').replace(NBSP_RE, ' ');
    return t.replace(WHITESPACE_RE, ' ').trim();
  }

  function matchesSelector(el, selector) {
    if (!el || !el.matches) return false;
    try { return el.matches(selector); } catch { return false; }
  }

  function normalizeBadgeItems(items) {
    const out = [];
    const seen = new Set();
    for (const item of items || []) {
      const value = String(item || '').trim();
      if (!value || seen.has(value)) continue;
      seen.add(value);
      out.push(value);
    }
    return out;
  }

  function badgeItemsFrom(el) {
    if (!el) return [];
    const badges = [];
    if (matchesSelector(el, BADGE_SELECTOR)) badges.push(textOf(el));
    for (const badge of deepQueryAll(el, BADGE_SELECTOR)) badges.push(textOf(badge));
    return normalizeBadgeItems(badges);
  }

  function valueHit(value, extra = {}) {
    const normalized = String(value || '').trim();
    if (!normalized) return null;
    return { value: normalized, ...extra };
  }

  function badgeHit(items, fallbackValue) {
    const badges = normalizeBadgeItems(items);
    const value = String(fallbackValue || badges.join(', ')).trim();
    if (!value) return null;
    return { value, badges };
  }

  function directChildByTagName(el, tagName) {
    if (!el || !el.children) return null;
    const want = String(tagName || '').toUpperCase();
    for (const child of el.children) {
      if (child.tagName === want) return child;
    }
    return null;
  }

  function pushUnique(out, seen, el) {
    if (!el || seen.has(el)) return;
    seen.add(el);
    out.push(el);
  }

  function mapPush(map, key, value) {
    if (!key || !value) return;
    let list = map.get(key);
    if (!list) {
      list = [];
      map.set(key, list);
    }
    if (!list.includes(value)) list.push(value);
  }

  function extractionContextFor(rootEl) {
    if (!rootEl || (typeof rootEl !== 'object' && typeof rootEl !== 'function')) return null;
    const cached = extractionContextByRoot.get(rootEl);
    if (cached) return cached;

    const labelFieldKeyCache = new WeakMap();
    const labelFieldKeyFor = (el) => {
      if (!el || !(el instanceof Element)) return '';
      if (labelFieldKeyCache.has(el)) return labelFieldKeyCache.get(el);
      const field = findByLabel(textOf(el));
      const key = field ? field.key : '';
      labelFieldKeyCache.set(el, key);
      return key;
    };

    const context = {
      rootEl,
      byName: new Map(),
      byDataField: new Map(),
      byDataFieldName: new Map(),
      byDataName: new Map(),
      sectionByElement: new WeakMap(),
      ariaLabelsByFieldKey: new Map(),
      ariaRefsById: new Map(),
      labelsByForId: new Map(),
      labelsForByFieldKey: new Map(),
      dtsByFieldKey: new Map(),
      labelTextByFieldKey: new Map(),
      linkLabelByFieldKey: new Map(),
      elementsById: new Map()
    };

    let currentSection = '';
    for (const el of deepTraversalFor(rootEl)) {
      if (!(el instanceof Element)) continue;

      if (matchesSelector(el, SECTION_HEADER_SELECTOR)) {
        const sectionName = normalizeText(textOf(el));
        if (sectionName) currentSection = sectionName;
      } else if (currentSection) {
        context.sectionByElement.set(el, currentSection);
      }

      const name = el.getAttribute('name');
      if (name) mapPush(context.byName, name, el);

      const dataField = el.getAttribute('data-field');
      if (dataField) mapPush(context.byDataField, dataField, el);
      const dataFieldName = el.getAttribute('data-field-name');
      if (dataFieldName) mapPush(context.byDataFieldName, dataFieldName, el);
      const dataName = el.getAttribute('data-name');
      if (dataName) mapPush(context.byDataName, dataName, el);

      const labelledBy = el.getAttribute('aria-labelledby');
      if (labelledBy) {
        for (const token of labelledBy.split(/\s+/)) {
          mapPush(context.ariaRefsById, token, el);
        }
      }

      if (el.id) {
        mapPush(context.elementsById, el.id, el);
        const fieldKey = labelFieldKeyFor(el);
        if (fieldKey) mapPush(context.ariaLabelsByFieldKey, fieldKey, el);
      }

      if (el.tagName === 'LABEL' && el.hasAttribute('for')) {
        mapPush(context.labelsByForId, el.getAttribute('for'), el);
        const fieldKey = labelFieldKeyFor(el);
        if (fieldKey) mapPush(context.labelsForByFieldKey, fieldKey, el);
      }

      if (el.tagName === 'DT') {
        const fieldKey = labelFieldKeyFor(el);
        if (fieldKey) {
          mapPush(context.dtsByFieldKey, fieldKey, el);
          mapPush(context.linkLabelByFieldKey, fieldKey, el);
        }
        continue;
      }

      if (matchesSelector(el, LABEL_TEXT_SELECTOR)) {
        const fieldKey = labelFieldKeyFor(el);
        if (fieldKey) {
          mapPush(context.labelTextByFieldKey, fieldKey, el);
          mapPush(context.linkLabelByFieldKey, fieldKey, el);
        }
        continue;
      }

      if (matchesSelector(el, '.now-label-value-label')) {
        const fieldKey = labelFieldKeyFor(el);
        if (fieldKey) mapPush(context.linkLabelByFieldKey, fieldKey, el);
      }
    }

    extractionContextByRoot.set(rootEl, context);
    return context;
  }

  function pushTextPart(out, seen, value) {
    const text = textOf(value);
    const normalized = normalizeText(text);
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    out.push(text);
  }

  function normalizeText(value) {
    return String(value || '')
      .replace(NBSP_RE, ' ')
      .replace(WHITESPACE_RE, ' ')
      .trim();
  }

  function labelTokens(value) {
    const tokens = String(value || '')
      .toLowerCase()
      .split(/[^a-z0-9]+/g)
      .map((token) => token.trim())
      .filter(Boolean);
    return Array.from(new Set(tokens));
  }

  function detectedLabelScore(label, serviceNowName) {
    const labelTokenList = labelTokens(label);
    if (labelTokenList.length === 0) return 0;
    const expectedTokens = new Set(labelTokens(friendlyDetectedLabel(serviceNowName)));
    let matches = 0;
    for (const token of labelTokenList) {
      if (expectedTokens.has(token)) matches++;
    }
    return matches / labelTokenList.length;
  }

  function bestDetectedLabel(labels, serviceNowName) {
    let bestLabel = '';
    let bestScore = 0;
    for (const label of labels) {
      const score = detectedLabelScore(label, serviceNowName);
      if (score > bestScore) {
        bestLabel = label;
        bestScore = score;
      }
    }
    if (bestScore >= 0.75) {
      return { label: bestLabel, fallback: false };
    }
    return {
      label: friendlyDetectedLabel(serviceNowName),
      fallback: true
    };
  }

  function fieldLabelForElement(el, context, serviceNowName) {
    const labels = [];
    const seen = new Set();

    pushTextPart(labels, seen, el.getAttribute && el.getAttribute('aria-label'));

    const labelledBy = el.getAttribute && el.getAttribute('aria-labelledby');
    if (labelledBy && context) {
      for (const token of labelledBy.split(/\s+/)) {
        const refs = context.elementsById.get(token) || [];
        for (const ref of refs) pushTextPart(labels, seen, ref);
      }
    }

    if (el.id && context) {
      const refs = context.labelsByForId.get(el.id) || [];
      for (const ref of refs) pushTextPart(labels, seen, ref);
    }

    const nearbyContainers = [];
    const nearbySeen = new Set();
    pushUnique(nearbyContainers, nearbySeen, el.previousElementSibling);
    pushUnique(nearbyContainers, nearbySeen, el.parentElement);
    pushUnique(
      nearbyContainers,
      nearbySeen,
      el.closest('.now-label-value-pair, [class*="label-value"], sn-form-field, [class*="field"], [class*="cell"]')
    );

    for (const container of nearbyContainers) {
      if (!container) continue;
      if (matchesSelector(container, LINK_LABEL_SELECTOR) || matchesSelector(container, LABEL_TEXT_SELECTOR)) {
        pushTextPart(labels, seen, container);
      }
      for (const candidate of deepQueryAll(container, LINK_LABEL_SELECTOR)) {
        if (candidate === el || !isVisible(candidate)) continue;
        pushTextPart(labels, seen, candidate);
      }
    }

    if (labels.length > 0) return bestDetectedLabel(labels, serviceNowName);
    return bestDetectedLabel([], serviceNowName);
  }

  function fieldGroupForElement(el, context) {
    if (!el || !context || !context.sectionByElement) return 'Other';
    let cur = el;
    while (cur) {
      const group = context.sectionByElement.get(cur);
      if (group) return group;
      cur = parentElementOrHost(cur);
    }
    return 'Other';
  }

  function inferDiscoveredRenderAs(el, label, serviceNowName) {
    const badges = badgeItemsFrom(el);
    if (badges.length > 1) return 'badge-list';
    if (badges.length === 1) return 'badge';

    const urlHit = extractUrlLikeValue(el);
    if (urlHit && URL_RE.test(urlHit.value)) return 'link';

    const value = readComponentValue(el);
    const valueText = value && value.value ? value.value : '';
    if (valueText && URL_RE.test(valueText)) return 'link';

    const parseSnDate = NS.dates && typeof NS.dates.parseSnDate === 'function'
      ? NS.dates.parseSnDate
      : null;
    if (parseSnDate && valueText) {
      const hint = `${label} ${friendlyDetectedLabel(serviceNowName)}`;
      if (DATE_FIELD_HINT_RE.test(hint) && parseSnDate(valueText)) return 'date';
    }

    return 'text';
  }

  function shouldIgnoreDiscoveredName(serviceNowName, context) {
    if (!serviceNowName) return false;
    if (
      NS.fieldRegistry &&
      typeof NS.fieldRegistry.isInternalDiscoveryNoiseName === 'function' &&
      NS.fieldRegistry.isInternalDiscoveryNoiseName(serviceNowName) &&
      serviceNowName === '_input'
    ) {
      return true;
    }
    const baseName = NS.fieldRegistry && typeof NS.fieldRegistry.internalCompanionBaseName === 'function'
      ? NS.fieldRegistry.internalCompanionBaseName(serviceNowName)
      : '';
    if (!baseName) return false;
    if (byKey[baseName]) return true;
    const baseHits = context && context.byName ? (context.byName.get(baseName) || []) : [];
    return baseHits.some(isVisible);
  }

  /* Report every visible field on the live form, grouped by its real ServiceNow
   * section. Fields the registry already knows are emitted as `reason: 'known'`
   * with their static key and a live-detected group (curated group as fallback).
   * Genuinely new fields keep the `detected:*` key space. Only internal noise
   * names (`_input`, `*_input`, `*-date` companions) land in
   * `resolvedServiceNowNames` so stale local discoveries can be cleaned up. */
  function discoverFields(rootEl) {
    if (!rootEl) return { discoveries: [], resolvedServiceNowNames: [] };
    const context = extractionContextFor(rootEl);
    const discoveries = [];
    const resolvedServiceNowNames = [];
    const seenDiscoveries = new Set();

    for (const entry of context && context.byName ? context.byName.entries() : []) {
      const serviceNowName = String(entry[0] || '').trim();
      if (!serviceNowName) continue;
      if (shouldIgnoreDiscoveredName(serviceNowName, context)) {
        resolvedServiceNowNames.push(serviceNowName);
        continue;
      }

      const visible = (entry[1] || []).find(isVisible);
      if (!visible) continue;

      const knownByName = byKey[serviceNowName];
      if (knownByName) {
        const key = knownByName.key;
        if (seenDiscoveries.has(key)) continue;
        seenDiscoveries.add(key);
        const detectedGroup = fieldGroupForElement(visible, context);
        discoveries.push({
          key,
          serviceNowName,
          label: knownByName.label,
          group: detectedGroup !== 'Other' ? detectedGroup : knownByName.group,
          renderAs: knownByName.renderAs,
          reason: 'known',
          matchedRegistryKey: key
        });
        continue;
      }

      const labelMeta = fieldLabelForElement(visible, context, serviceNowName);
      const matchedStaticField = labelMeta.fallback ? null : findStaticByLabel(labelMeta.label);
      const reason = matchedStaticField ? 'name-change' : 'new-field';
      const key = detectedKeyFor(serviceNowName);
      if (seenDiscoveries.has(key)) continue;
      seenDiscoveries.add(key);

      const discovery = {
        key,
        serviceNowName,
        label: labelMeta.label,
        group: fieldGroupForElement(visible, context),
        renderAs: inferDiscoveredRenderAs(visible, labelMeta.label, serviceNowName),
        reason
      };
      if (matchedStaticField) discovery.matchedRegistryKey = matchedStaticField.key;
      discoveries.push(discovery);
    }

    return { discoveries, resolvedServiceNowNames };
  }

  function isHiddenStyle(style) {
    if (!style) return false;
    return style.display === 'none' ||
      style.visibility === 'hidden' ||
      style.visibility === 'collapse' ||
      style.contentVisibility === 'hidden';
  }

  function hasInlineHiddenStyle(node) {
    if (!node || !(node instanceof Element) || !node.style) return false;
    return node.style.display === 'none' ||
      node.style.visibility === 'hidden' ||
      node.style.visibility === 'collapse' ||
      node.style.contentVisibility === 'hidden';
  }

  function isHiddenBySemanticAttributes(node) {
    if (!node || !(node instanceof Element)) return true;
    if (node.hidden) return true;
    if (node.hasAttribute && node.hasAttribute('inert')) return true;
    if ('inert' in node && node.inert) return true;
    if (node.getAttribute('aria-hidden') === 'true') return true;
    const ds = node.dataset;
    if (ds && ds.hidden === 'true') return true;
    return hasInlineHiddenStyle(node);
  }

  function isVisibleByAttributes(el) {
    if (!el || !(el instanceof Element)) return false;
    const cached = attributeVisibilityCache.get(el);
    if (cached != null) return cached;
    const parent = parentElementOrHost(el);
    const visible = !isHiddenBySemanticAttributes(el) &&
      (!parent || isVisibleByAttributes(parent));
    attributeVisibilityCache.set(el, visible);
    return visible;
  }

  function nativeVisibilityCheck(el) {
    if (!el || typeof el.checkVisibility !== 'function') return null;
    try {
      return el.checkVisibility({
        checkVisibilityCSS: true,
        visibilityProperty: true,
        contentVisibilityAuto: true
      });
    } catch {
      try {
        return el.checkVisibility();
      } catch {
        return null;
      }
    }
  }

  function computedStyleOf(el) {
    if (!el || !(el instanceof Element) || typeof root.getComputedStyle !== 'function') return null;
    return root.getComputedStyle(el);
  }

  function isStyleVisibleThroughAncestors(el) {
    if (!el || !(el instanceof Element)) return false;
    if (!isVisibleByAttributes(el)) return false;
    const cached = styleVisibilityCache.get(el);
    if (cached != null) return cached;
    const chain = [];
    let cur = el;
    let inheritedVisible = true;

    while (cur) {
      const curCached = styleVisibilityCache.get(cur);
      if (curCached != null) {
        inheritedVisible = curCached;
        break;
      }
      chain.push(cur);
      cur = parentElementOrHost(cur);
    }

    for (let i = chain.length - 1; i >= 0; i--) {
      const node = chain[i];
      const nativeVisible = nativeVisibilityCheck(node);
      if (nativeVisible != null) {
        inheritedVisible = nativeVisible;
      } else if (inheritedVisible) {
        inheritedVisible = !isHiddenStyle(computedStyleOf(node));
      }
      styleVisibilityCache.set(node, inheritedVisible);
    }

    return styleVisibilityCache.get(el) === true;
  }

  function isVisible(el) {
    if (!el || !(el instanceof Element)) return false;
    const cached = visibilityCache.get(el);
    if (cached != null) return cached;
    const visible = isStyleVisibleThroughAncestors(el);
    visibilityCache.set(el, visible);
    return visible;
  }

  function normalizeProbeKeys(keys) {
    const out = [];
    const seen = new Set();
    for (const key of keys || []) {
      if (!byKey[key] || seen.has(key)) continue;
      seen.add(key);
      out.push(key);
    }
    return out;
  }

  function collectVisibleNamedFieldHits(rootEl, keys, context = extractionContextFor(rootEl)) {
    const out = [];
    const seen = new Set();
    for (const key of normalizeProbeKeys(keys)) {
      const field = byKey[key];
      const name = field && field.serviceNowName ? field.serviceNowName : key;
      const hits = context && context.rootEl === rootEl
        ? (context.byName.get(name) || [])
        : deepQueryAll(rootEl, `[name="${field.escapedHint || field.escapedKey}"]`);
      for (const hit of hits) {
        if (!isVisible(hit) || seen.has(hit)) continue;
        seen.add(hit);
        out.push({ key, el: hit });
      }
    }
    return out;
  }

  function depthWithin(rootEl, el) {
    let depth = 0;
    let cur = el;
    while (cur && cur !== rootEl) {
      depth++;
      cur = parentElementOrHost(cur);
    }
    return depth;
  }

  function countVisibleSectionHeaders(el) {
    if (!el || !el.querySelectorAll) return 0;
    const cached = sectionHeaderCountCache.get(el);
    if (cached != null) return cached;
    const count = Array.from(el.querySelectorAll(SECTION_HEADER_SELECTOR)).filter(isVisible).length;
    sectionHeaderCountCache.set(el, count);
    return count;
  }

  /* Pick the visible record subtree that best matches the currently selected
   * fields. In SPA transitions ServiceNow can leave the previous record DOM in
   * place but hidden; extracting from the whole document lets stale values
   * win. We resolve the active record by scoring visible ancestors of visible
   * field components and choosing the smallest non-root container that covers
   * the most probe keys and visible section headers.
   *
   * Partial hydration often renders one field wrapper before the surrounding
   * record container is stable. A candidate that covers only one probe field is
   * too narrow to cache as the active scope, so we intentionally keep waiting
   * until a non-root container covers at least two visible probe fields. */
  function resolveActiveRecordScope(rootEl, candidateKeys) {
    if (!rootEl) return null;
    const context = extractionContextFor(rootEl);
    const hits = collectVisibleNamedFieldHits(rootEl, candidateKeys, context);
    if (!hits.length) return null;

    const candidates = new Map();
    for (const hit of hits) {
      for (const ancestor of ancestorElements(hit.el, rootEl)) {
        if (!isVisible(ancestor)) continue;
        let entry = candidates.get(ancestor);
        if (!entry) {
          entry = { el: ancestor, keys: new Set() };
          candidates.set(ancestor, entry);
        }
        entry.keys.add(hit.key);
      }
    }

    const ranked = Array.from(candidates.values())
      .map((entry) => ({
        el: entry.el,
        keyCount: entry.keys.size,
        sectionCount: countVisibleSectionHeaders(entry.el),
        depth: depthWithin(rootEl, entry.el),
        isRoot: entry.el === rootEl
      }))
      .filter((entry) => entry.keyCount > 0)
      .sort((a, b) => (
        b.keyCount - a.keyCount ||
        b.sectionCount - a.sectionCount ||
        b.depth - a.depth
      ));

    const best = ranked.find((entry) => !entry.isRoot) || ranked[0];
    if (!best || best.isRoot || best.keyCount < 2) return null;
    return best.el;
  }

  /* Strategy 1: locate the ServiceNow form component by its `name` attribute.
   * This is the most reliable probe on the new UX Framework — each
   * `sn-record-*-connected` / `now-record-*` element carries the column name
   * verbatim. Registry keys are chosen to match the column name, so we look
   * up by `field.key` (with `field.hint` as an override). */
  function extractByName(rootEl, field, context) {
    const names = [
      { value: field.key, escaped: field.escapedKey },
      field.hint ? { value: field.hint, escaped: field.escapedHint } : null
    ].filter(Boolean);
    for (const name of names) {
      const hits = context && context.rootEl === rootEl
        ? (context.byName.get(name.value) || [])
        : deepQueryAll(rootEl, `[name="${name.escaped}"]`);
      for (const hit of hits) {
        if (!isVisible(hit)) continue;
        const value = readComponentValue(hit);
        if (value) return { ...value, source: `name=${name.value}` };
      }
    }
    return null;
  }

  /* Strategy 1b (legacy): explicit data attributes. Retained as a fallback
   * for older renderings. */
  function extractByDataAttr(rootEl, field, context) {
    if (!field.hint && !field.key) return null;
    const name = field.hint || field.key;
    const indexedHits = context && context.rootEl === rootEl
      ? [
        { selector: `[data-field="${name}"]`, hits: context.byDataField.get(name) || [] },
        { selector: `[data-field-name="${name}"]`, hits: context.byDataFieldName.get(name) || [] },
        { selector: `[data-name="${name}"]`, hits: context.byDataName.get(name) || [] }
      ]
      : [
        { selector: `[data-field="${name}"]` },
        { selector: `[data-field-name="${name}"]` },
        { selector: `[data-name="${name}"]` }
      ];
    for (const entry of indexedHits) {
      const hits = entry.hits || deepQueryAll(rootEl, entry.selector);
      for (const hit of hits) {
        if (!isVisible(hit)) continue;
        const value = readComponentValue(hit);
        if (value) return { ...value, source: `data-attr(${entry.selector})` };
      }
    }
    return null;
  }

  /* Strategy 2: aria-labelledby pairing. */
  function extractByAria(rootEl, field, context) {
    const labelNodes = context && context.rootEl === rootEl
      ? (context.ariaLabelsByFieldKey.get(field.key) || [])
      : deepQueryAll(rootEl, '[id]');
    for (const labelEl of labelNodes) {
      if (!isVisible(labelEl)) continue;
      const f = context && context.rootEl === rootEl
        ? field
        : findByLabel(textOf(labelEl));
      if (!f || f.key !== field.key) continue;
      const refs = context && context.rootEl === rootEl
        ? (context.ariaRefsById.get(labelEl.id) || [])
        : deepQueryAll(rootEl, `[aria-labelledby~="${CSS.escape(labelEl.id)}"]`);
      for (const ref of refs) {
        if (!isVisible(ref)) continue;
        const value = readValueFrom(ref);
        if (value) return { ...value, source: 'aria-labelledby' };
      }
    }
    return null;
  }

  /* Strategy 3: <label for=...> + input/control. */
  function extractByLabelFor(rootEl, field, context) {
    const labels = context && context.rootEl === rootEl
      ? (context.labelsForByFieldKey.get(field.key) || [])
      : deepQueryAll(rootEl, 'label[for]');
    for (const lbl of labels) {
      if (!isVisible(lbl)) continue;
      const f = context && context.rootEl === rootEl
        ? field
        : findByLabel(textOf(lbl));
      if (!f || f.key !== field.key) continue;
      const forId = lbl.getAttribute('for');
      const target = lbl.ownerDocument.getElementById(forId) ||
        (context && context.rootEl === rootEl
          ? (context.elementsById.get(forId) || []).find(isVisible)
          : deepQueryAll(rootEl, `#${CSS.escape(forId)}`).find(isVisible));
      if (target && isVisible(target)) {
        const value = readValueFrom(target);
        if (value) return { ...value, source: 'label[for]' };
      }
    }
    return null;
  }

  /* Strategy 4: definition lists. */
  function extractByDl(rootEl, field, context) {
    const dts = context && context.rootEl === rootEl
      ? (context.dtsByFieldKey.get(field.key) || [])
      : deepQueryAll(rootEl, 'dt');
    for (const dt of dts) {
      if (!isVisible(dt)) continue;
      const f = context && context.rootEl === rootEl
        ? field
        : findByLabel(textOf(dt));
      if (!f || f.key !== field.key) continue;
      const dd = dt.nextElementSibling;
      if (dd && dd.tagName === 'DD' && isVisible(dd)) {
        const value = readValueFrom(dd);
        if (value) return { ...value, source: 'dl' };
      }
    }
    return null;
  }

  /* Strategy 5: label-text normalized match → nearest sibling/descendant value.
   * Broadest probe. Runs last. */
  function extractByLabelText(rootEl, field, context) {
    const candidates = context && context.rootEl === rootEl
      ? (context.labelTextByFieldKey.get(field.key) || [])
      : deepQueryAll(rootEl, LABEL_TEXT_SELECTOR);
    for (const el of candidates) {
      if (!isVisible(el)) continue;
      const f = context && context.rootEl === rootEl
        ? field
        : findByLabel(textOf(el));
      if (!f || f.key !== field.key) continue;
      const value = findAdjacentValue(el);
      if (value) return { ...value, source: 'label-text' };
    }
    return null;
  }

  /* Given a label node, look for the value in conventional positions:
   *   1. Next element sibling.
   *   2. Parent's last text-bearing child that isn't the label.
   *   3. Closest container (`[class*=field]`, `sn-form-field`) → descendant value. */
  function findAdjacentValue(labelEl) {
    const sib = labelEl.nextElementSibling;
    if (sib) {
      const v = readValueFrom(sib);
      if (v) return v;
    }
    const parent = labelEl.parentElement;
    if (parent) {
      for (const child of parent.children) {
        if (child === labelEl) continue;
        const v = readValueFrom(child);
        if (v) return v;
      }
    }
    const container = labelEl.closest('[class*="field"], sn-form-field, [data-field], [class*="cell"]');
    if (container) {
      const v = readValueFrom(container, labelEl);
      if (v) return v;
    }
    return null;
  }

  /* Read a human-readable value from an arbitrary node.
   * - <input>/<select>/<textarea>: use `.value` (or selected option text).
   * - Elements with `aria-valuetext`: use that.
   * - Everything else: visible text, excluding a label subtree if provided. */
  function readValueFrom(el, excludeLabel) {
    if (!el || !isVisible(el)) return '';
    const badges = badgeItemsFrom(el);
    if (badges.length) return badgeHit(badges);
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
      return valueHit(el.value);
    }
    if (el.tagName === 'SELECT') {
      const opt = el.options && el.options[el.selectedIndex];
      return opt ? valueHit(textOf(opt)) : null;
    }
    const av = el.getAttribute && el.getAttribute('aria-valuetext');
    if (av) return valueHit(av);
    if (excludeLabel) {
      const clone = el.cloneNode(true);
      const toRemove = clone.querySelectorAll('label, [role="label"], .label');
      toRemove.forEach((n) => n.remove());
      return valueHit(textOf(clone));
    }
    return valueHit(textOf(el));
  }

  /* Link fields (renderAs: 'link'): find the now-label-value-pair by label
   * text, then dig into the DD (through any shadow roots) for an <a href>.
   * SN's `now-text-link` wraps the real URL in a shadow-DOM anchor whose
   * visible text IS the URL, but `href` is "javascript:void(0)". So we
   * prefer: visible text if URL-shaped > data-tooltip/data-ariadescribedby
   * attr > real href. Runs before the generic strategies for link fields. */
  function extractLinkField(rootEl, field, context) {
    if (field.renderAs !== 'link') return null;
    const labelCandidates = context && context.rootEl === rootEl
      ? (context.linkLabelByFieldKey.get(field.key) || [])
      : deepQueryAll(rootEl, LINK_LABEL_SELECTOR);
    for (const labelEl of labelCandidates) {
      if (!isVisible(labelEl)) continue;
      const f = context && context.rootEl === rootEl
        ? field
        : findByLabel(textOf(labelEl));
      if (!f || f.key !== field.key) continue;
      const scopes = [];
      const seen = new Set();
      const pair = labelEl.closest('.now-label-value-pair, [class*="label-value"]');
      pushUnique(scopes, seen, pair);
      pushUnique(scopes, seen, directChildByTagName(pair, 'DD'));
      pushUnique(scopes, seen, labelEl.nextElementSibling);
      pushUnique(scopes, seen, labelEl.parentElement);
      pushUnique(scopes, seen, labelEl.parentElement && directChildByTagName(labelEl.parentElement, 'DD'));
      pushUnique(scopes, seen, labelEl.parentElement && labelEl.parentElement.parentElement);
      pushUnique(scopes, seen, labelEl.parentElement && labelEl.parentElement.parentElement &&
        directChildByTagName(labelEl.parentElement.parentElement, 'DD'));

      for (const scope of scopes) {
        const hit = extractUrlLikeValue(scope);
        if (hit) return hit;
      }
    }
    return null;
  }

  function extractUrlLikeValue(scope) {
    if (!scope) return null;
    const direct = isStyleVisibleThroughAncestors(scope) ? urlValueFromNode(scope) : null;
    if (direct) return direct;
    const candidates = deepQueryAll(scope, 'a[href], [data-tooltip], [data-ariadescribedby]');
    for (const candidate of candidates) {
      if (!isStyleVisibleThroughAncestors(candidate)) continue;
      const hit = urlValueFromNode(candidate);
      if (hit) return hit;
    }
    return null;
  }

  function urlValueFromNode(node) {
    if (!node || !node.getAttribute) return null;
    const text = textOf(node);
    if (URL_RE.test(text)) return { value: text, source: 'link-text' };
    const tooltip = node.getAttribute('data-tooltip');
    if (tooltip && URL_RE.test(tooltip)) return { value: tooltip, source: 'link-tooltip' };
    const described = node.getAttribute('data-ariadescribedby');
    if (described && URL_RE.test(described)) return { value: described, source: 'link-aria-described-by' };
    const href = node.getAttribute('href') || '';
    if (URL_RE.test(href)) return { value: href, source: 'link-href' };
    return null;
  }

  const STRATEGIES = [
    extractLinkField,
    extractByName,
    extractByDataAttr,
    extractByAria,
    extractByLabelFor,
    extractByDl,
    extractByLabelText
  ];

  /* Read a display value from a ServiceNow form component. The `value`
   * attribute on reference fields holds a sys_id — not user-friendly — so we
   * prefer rendered text from the component (which includes open shadow DOM
   * content traversed by innerText). For date/number/string components the
   * `value` attribute IS the display value, so we fall back to it if the
   * rendered text is empty. */
  function readComponentValue(el) {
    if (!el || !isVisible(el)) return '';
    const badges = badgeItemsFrom(el);
    if (badges.length) return badgeHit(badges);
    const text = textOf(el);
    if (text) {
      if (!SYS_ID_RE.test(text)) return valueHit(text);
    }
    const v = el.getAttribute && el.getAttribute('value');
    if (v && !SYS_ID_RE.test(v)) return valueHit(v);
    return readValueFrom(el);
  }

  /* Empty rich-text / textarea fields in SN occasionally render their own
   * label as the only readable text ("Next Step" shows the string
   * "Next Step" when blank). Treat a value that matches the field's label
   * or any alias as empty. */
  function looksLikeOwnLabel(field, value) {
    if (!value) return false;
    const norm = String(value).trim().toLowerCase();
    if (!norm) return true;
    const candidates = [field.label, ...(field.aliases || [])]
      .filter(Boolean)
      .map((s) => String(s).trim().toLowerCase());
    return candidates.includes(norm);
  }

  function extractField(rootEl, key, context = extractionContextFor(rootEl)) {
    const field = byKey[key];
    if (!field) return { key, found: false, value: '', source: 'unknown-key' };
    for (const strat of STRATEGIES) {
      try {
        const hit = strat(rootEl, field, context);
        if (!hit || !hit.value) continue;
        if (looksLikeOwnLabel(field, hit.value)) {
          log.debug(`ignored label-as-value for ${key} via ${hit.source}`);
          continue;
        }
        log.debug(`found ${key} via ${hit.source}`);
        return { key, found: true, value: hit.value, source: hit.source };
      } catch (e) {
        log.debug(`strategy threw for ${key}`, e && e.message);
      }
    }
    const ownerBody = rootEl && rootEl.ownerDocument && rootEl.ownerDocument.body;
    if (field.renderAs === 'link' && ownerBody && rootEl !== ownerBody) {
      const ownerBodyContext = extractionContextFor(ownerBody);
      for (const strat of STRATEGIES) {
        try {
          const hit = strat(ownerBody, field, ownerBodyContext);
          if (!hit || !hit.value) continue;
          if (looksLikeOwnLabel(field, hit.value)) continue;
          log.debug(`found ${key} via body fallback ${hit.source}`);
          return { key, found: true, value: hit.value, source: `body-fallback:${hit.source}` };
        } catch (e) {
          log.debug(`body fallback strategy threw for ${key}`, e && e.message);
        }
      }
    }
    log.debug(`miss ${key}`);
    return { key, found: false, value: '', source: 'none' };
  }

  function extractAll(rootEl, keys) {
    const out = {};
    const context = extractionContextFor(rootEl);
    for (const key of keys) out[key] = extractField(rootEl, key, context);
    return out;
  }

  /* Detect whether the record content looks hydrated enough to try extracting.
   * We require at least one visible field probe inside the resolved scope so
   * generic labels elsewhere in the page cannot mark the record as ready. */
  function isHydrated(rootEl, probeKeys) {
    if (!rootEl) return false;
    return collectVisibleNamedFieldHits(rootEl, probeKeys).length > 0;
  }

  NS.extractors = {
    extractField,
    extractAll,
    discoverFields,
    isHydrated,
    deepQueryAll,
    isVisible,
    resolveActiveRecordScope,
    invalidateCache
  };
})(typeof self !== 'undefined' ? self : globalThis);
