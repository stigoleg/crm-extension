(function (root) {
  'use strict';
  const NS = (root.SNCRM = root.SNCRM || {});
  const log = NS.log.make('desc');
  const storage = NS.storage;
  const FIELD_CLASS = 'sncrm-original-description-field';
  const FLOW_CLASS = 'sncrm-original-description-flow';
  const HOST_CLASS = 'sncrm-original-description-host';
  const EDITOR_CLASS = 'sncrm-original-description-editor';
  const LARGE_CLASS = 'sncrm-original-description-large';
  const RESIZE_ROW_CLASS = 'sncrm-description-resize-row';
  const RESIZE_HANDLE_CLASS = 'sncrm-description-resize-handle';
  const COPY_ROW_CLASS = 'sncrm-description-copy-row';
  const COPY_BUTTON_CLASS = 'sncrm-description-copy-button';
  const SHADOW_STYLE_ATTR = 'data-sncrm-original-description-style';
  const MIN_RESIZE_EDITOR_HEIGHT = 120;
  const MAX_RESIZE_EDITOR_HEIGHT = 2000;
  const KEY_STEP = 24;
  const KEY_STEP_LARGE = 96;
  const EDITOR_SELECTOR = [
    'textarea',
    '[contenteditable="true"]',
    '[contenteditable="plaintext-only"]',
    '[role="textbox"]'
  ].join(', ');
  const LABEL_SELECTOR = [
    'dt',
    '.now-label-value-label',
    'label',
    '[role="label"]',
    '.label',
    '.sn-form-label',
    'now-label',
    'span[class*="label"]'
  ].join(', ');
  const CONTAINER_SELECTOR = [
    '.now-label-value-pair',
    '[class*="label-value"]',
    '.sn-form-field',
    '[class*="form-field"]',
    '[class*="record-field"]',
    '[class*="field"]'
  ].join(', ');

  const appliedNodes = new Set();
  // node -> Map(prop -> { value, priority }) of pre-enhance values.
  const propSnapshots = new Map();
  let activeTarget = null;
  let activeMode = null;
  let activeHandleRow = null;
  let activeHandle = null;
  let activeCopyRow = null;
  let activeCopyButton = null;
  // Every copy row this module has mounted (light DOM or shadow). Tracked so
  // mounts are removed even across shadow roots, which document.querySelector
  // cannot see.
  const mountedCopyRows = new Set();
  let activeResizeObserver = null;
  let preferredEditorHeight = null;
  let saveHeightTimer = null;
  let dragState = null;
  let dragFrameHandle = null;
  let pendingDragHeight = null;

  function parentElementOrHost(node) {
    if (!node) return null;
    if (node.parentElement) return node.parentElement;
    const rootNode = node.getRootNode && node.getRootNode();
    return rootNode && rootNode.host instanceof Element ? rootNode.host : null;
  }

  function textOf(el) {
    if (!el) return '';
    const t = (el.innerText || el.textContent || '').replace(/\u00A0/g, ' ');
    return t.replace(/\s+/g, ' ').trim();
  }

  function matchesEditor(node) {
    if (!node || !(node instanceof Element)) return false;
    if (node.matches && node.matches('textarea')) return true;
    const contenteditable = node.getAttribute && node.getAttribute('contenteditable');
    if (contenteditable === 'true' || contenteditable === 'plaintext-only') return true;
    return node.getAttribute && node.getAttribute('role') === 'textbox';
  }

  function isContainerCandidate(node) {
    return Boolean(
      node &&
      node instanceof Element &&
      !matchesEditor(node) &&
      node.matches &&
      node.matches(CONTAINER_SELECTOR)
    );
  }

  function pushUnique(out, seen, node) {
    if (!node || seen.has(node)) return;
    seen.add(node);
    out.push(node);
  }

  function normalizeStoredHeight(value) {
    return typeof value === 'number' && Number.isFinite(value) && value >= MIN_RESIZE_EDITOR_HEIGHT
      ? Math.round(value)
      : null;
  }

  function clampHeight(value) {
    const n = Math.round(Number(value) || 0);
    if (!Number.isFinite(n)) return MIN_RESIZE_EDITOR_HEIGHT;
    return Math.max(MIN_RESIZE_EDITOR_HEIGHT, Math.min(MAX_RESIZE_EDITOR_HEIGHT, n));
  }

  function inlineHeightOf(node) {
    if (!node || !(node instanceof Element) || !node.style) return null;
    const raw = node.style.getPropertyValue('height');
    if (!raw) return null;
    const parsed = Number(String(raw).replace(/px$/i, ''));
    return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : null;
  }

  function currentEditorHeight(editorEl) {
    return inlineHeightOf(editorEl) ||
      normalizeStoredHeight(preferredEditorHeight) ||
      MIN_RESIZE_EDITOR_HEIGHT;
  }

  function applyPendingDragHeight() {
    if (pendingDragHeight == null) return null;
    const height = pendingDragHeight;
    pendingDragHeight = null;
    return setLiveHeight(height);
  }

  function clearPendingDragHeight() {
    if (dragFrameHandle != null && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(dragFrameHandle);
    }
    dragFrameHandle = null;
    pendingDragHeight = null;
  }

  function scheduleLiveHeight(nextHeight) {
    pendingDragHeight = nextHeight;
    if (dragFrameHandle != null) return;
    if (typeof requestAnimationFrame !== 'function') {
      applyPendingDragHeight();
      return;
    }
    dragFrameHandle = requestAnimationFrame(() => {
      dragFrameHandle = null;
      applyPendingDragHeight();
    });
  }

  function resizeObserverHeight(entry, editorEl) {
    const normalize = (value) => (
      Number.isFinite(value) && value > 0 ? Math.round(value) : null
    );
    if (entry) {
      const borderBox = entry.borderBoxSize;
      if (Array.isArray(borderBox) && borderBox[0]) {
        const size = normalize(borderBox[0].blockSize);
        if (size != null) return size;
      } else if (borderBox) {
        const size = normalize(borderBox.blockSize);
        if (size != null) return size;
      }
      if (entry.contentRect) {
        const size = normalize(entry.contentRect.height);
        if (size != null) return size;
      }
    }
    return currentEditorHeight(editorEl);
  }

  function findEditable(rootEl) {
    const { deepQueryAll, isVisible } = NS.extractors;
    if (!rootEl) return null;
    if (matchesEditor(rootEl) && isVisible(rootEl)) return rootEl;
    const candidates = deepQueryAll(rootEl, EDITOR_SELECTOR);
    for (const candidate of candidates) {
      if (!isVisible(candidate)) continue;
      return candidate;
    }
    return null;
  }

  function fieldContainerFor(node) {
    if (!node || !(node instanceof Element)) return null;
    const fallback = matchesEditor(node) ? parentElementOrHost(node) : node;
    let cur = fallback;
    while (cur) {
      if (isContainerCandidate(cur)) return cur;
      cur = parentElementOrHost(cur);
    }
    return fallback || null;
  }

  function surfaceElementFor(editorEl, fieldEl) {
    const directHost = parentElementOrHost(editorEl);
    if (directHost && directHost instanceof Element && !matchesEditor(directHost)) return directHost;
    if (fieldEl && fieldEl instanceof Element && !matchesEditor(fieldEl)) return fieldEl;
    return editorEl;
  }

  function resolveTarget(node) {
    const { isVisible } = NS.extractors;
    if (!node || !(node instanceof Element)) return null;
    const editorEl = findEditable(node);
    if (!editorEl) return null;
    const rootNode = editorEl.getRootNode && editorEl.getRootNode();
    const shadowHostEl = rootNode && rootNode.host instanceof Element
      ? rootNode.host
      : null;
    const fieldEl = fieldContainerFor(shadowHostEl || node) || fieldContainerFor(editorEl) || shadowHostEl || editorEl;
    const surfaceEl = surfaceElementFor(editorEl, fieldEl);
    if (!fieldEl || !isVisible(fieldEl)) return null;
    return {
      fieldEl,
      surfaceEl,
      editorEl,
      shadowRoot: shadowHostEl ? rootNode : null
    };
  }

  function candidatesFromLabel(labelEl) {
    const out = [];
    const seen = new Set();
    pushUnique(out, seen, labelEl.nextElementSibling);
    pushUnique(out, seen, labelEl.parentElement);
    pushUnique(out, seen, labelEl.parentElement && labelEl.parentElement.nextElementSibling);
    pushUnique(out, seen, labelEl.closest('.now-label-value-pair, [class*="label-value"]'));
    pushUnique(out, seen, labelEl.parentElement && labelEl.parentElement.parentElement);
    return out;
  }

  function findDescriptionTarget(scopeEl) {
    const scope = scopeEl && scopeEl.querySelectorAll ? scopeEl : document.body;
    const { deepQueryAll, isVisible } = NS.extractors;
    const { findByLabel } = NS.fieldRegistry;

    const namedHits = deepQueryAll(scope, '[name="description"]');
    for (const hit of namedHits) {
      if (!isVisible(hit)) continue;
      const target = resolveTarget(hit);
      if (target) return target;
    }

    const labels = deepQueryAll(scope, LABEL_SELECTOR);
    for (const labelEl of labels) {
      if (!isVisible(labelEl)) continue;
      const field = findByLabel(textOf(labelEl));
      if (!field || field.key !== 'description') continue;
      for (const candidate of candidatesFromLabel(labelEl)) {
        const target = resolveTarget(candidate);
        if (target) return target;
      }
    }
    return null;
  }

  function layoutNodesFor(target) {
    const out = [];
    const seen = new Set();
    const pushChain = (node, stop) => {
      let cur = node;
      while (cur) {
        if (cur instanceof Element) pushUnique(out, seen, cur);
        if (cur === stop) break;
        cur = parentElementOrHost(cur);
      }
    };
    pushChain(target.surfaceEl, target.fieldEl);
    pushUnique(out, seen, target.fieldEl);
    return out;
  }

  // Walk up from the field container to release height caps on the immediate
  // form-cell/row ancestors (max 5 levels) that would otherwise clip the grown
  // field. Deliberately shallow — going deeper risks hitting the page scroll
  // container and triggering ServiceNow's form-layout MutationObserver.
  function ancestorFlowNodesFor(target) {
    const MAX_DEPTH = 5;
    const out = [];
    const seen = new Set();
    let cur = parentElementOrHost(target.fieldEl);
    let depth = 0;
    while (cur && cur instanceof Element && depth < MAX_DEPTH) {
      const tag = cur.tagName;
      if (tag === 'BODY' || tag === 'HTML') break;
      pushUnique(out, seen, cur);
      cur = parentElementOrHost(cur);
      depth += 1;
    }
    return out;
  }

  // Built once; compared on each call so SPA-reused shadow roots get the
  // latest rules without a page reload.
  const SHADOW_STYLE_CONTENT = [
    // Dual-class selector → specificity 0,2,0 beats any single-class SN rule.
    // A stylesheet !important also beats an inline non-important assignment
    // (ServiceNow's autoresize does element.style.height = 'Xpx', non-important).
    `.${FLOW_CLASS}.${FIELD_CLASS} {`,
    '  height: auto !important;',
    '  max-height: none !important;',
    '  max-block-size: none !important;',
    '  overflow: visible !important;',
    '}',
    // Styled-mode rules — only active when HOST_CLASS is on the shadow host.
    `:host(.${HOST_CLASS}) {`,
    '  display: block;',
    '  width: 100%;',
    '  height: auto !important;',
    '  min-height: 0 !important;',
    '  overflow: visible !important;',
    '}',
    `:host(.${HOST_CLASS}) .${FLOW_CLASS}.${FIELD_CLASS} {`,
    '  overflow: visible !important;',
    '  contain: none !important;',
    '  align-self: stretch !important;',
    '}',
    `:host(.${HOST_CLASS}) .${EDITOR_CLASS} {`,
    '  box-sizing: border-box;',
    '  display: block;',
    '  width: 100%;',
    '  min-height: 0 !important;',
    '  max-block-size: none !important;',
    '  padding: 16px 18px;',
    '  line-height: 1.65;',
    '  font-size: 14px;',
    '  white-space: pre-wrap;',
    '  overflow-wrap: anywhere;',
    '  tab-size: 2;',
    '  resize: vertical !important;',
    '}',
    // Only remove the cap from the live textarea — NOT from the copy/backdrop
    // mirrors. Those elements size to the full text content (scrollHeight), so
    // removing their cap makes them taller than the visible textarea, pushing
    // the grid row (and the wrapper with height:auto) past the textarea height
    // and creating blank space below the field. SN's 16rem cap on copy/backdrop
    // keeps the grid row at max(textarea_height, ≤256px) = textarea_height.
    `:host(.${HOST_CLASS}) .now-textarea-field {`,
    '  max-block-size: none !important;',
    '  max-height: none !important;',
    '}',
    `:host(.${HOST_CLASS}):focus-within .${EDITOR_CLASS},`,
    `:host(.${HOST_CLASS}) .${EDITOR_CLASS}:focus {`,
    '  outline: 2px solid rgba(37, 99, 235, 0.22);',
    '  outline-offset: 0;',
    '}',
    // Copy button. Mounted at fieldEl.parentNode which can sit inside a shadow
    // root, where document-level styles.css cannot reach — so carry the rules
    // here too. High specificity + !important to beat SNow's own button reset.
    `.${COPY_ROW_CLASS} {`,
    '  display: flex;',
    '  justify-content: flex-end;',
    '  width: fit-content;',
    '  margin: 0 0 4px auto;',
    '  position: relative;',
    '  z-index: 2;',
    '  pointer-events: auto;',
    '}',
    `.${COPY_ROW_CLASS} .${COPY_BUTTON_CLASS} {`,
    '  appearance: none;',
    '  display: inline-flex !important;',
    '  align-items: center;',
    '  gap: 5px;',
    '  padding: 4px 11px !important;',
    '  font: 600 11px/1.2 inherit !important;',
    '  letter-spacing: 0.03em;',
    '  color: #334155 !important;',
    '  background: #ffffff !important;',
    '  border: 1px solid rgba(15, 23, 42, 0.18) !important;',
    '  border-radius: 6px !important;',
    '  box-shadow: 0 1px 2px rgba(15, 23, 42, 0.06);',
    '  cursor: pointer;',
    '  user-select: none;',
    '}',
    `.${COPY_ROW_CLASS} .${COPY_BUTTON_CLASS}:hover {`,
    '  border-color: rgba(37, 99, 235, 0.5) !important;',
    '  color: #1d4ed8 !important;',
    '  background: #f8fafc !important;',
    '}',
    `.${COPY_ROW_CLASS} .${COPY_BUTTON_CLASS}:focus-visible {`,
    '  outline: 2px solid rgba(37, 99, 235, 0.55);',
    '  outline-offset: 1px;',
    '}'
  ].join('\n');

  function ensureShadowStyle(shadowRoot) {
    if (!shadowRoot || !(shadowRoot instanceof ShadowRoot)) return;
    let style = shadowRoot.querySelector(`[${SHADOW_STYLE_ATTR}]`);
    if (!style) {
      style = document.createElement('style');
      style.setAttribute(SHADOW_STYLE_ATTR, 'true');
      shadowRoot.appendChild(style);
    }
    // Always sync content so SPA-reused shadow roots pick up updated rules.
    if (style.textContent !== SHADOW_STYLE_CONTENT) {
      style.textContent = SHADOW_STYLE_CONTENT;
    }
  }

  function snapshotProp(node, prop) {
    if (!node || !(node instanceof Element)) return;
    let map = propSnapshots.get(node);
    if (!map) { map = new Map(); propSnapshots.set(node, map); }
    if (!map.has(prop)) {
      map.set(prop, {
        value: node.style.getPropertyValue(prop),
        priority: node.style.getPropertyPriority(prop)
      });
    }
  }

  function applyInline(node, prop, value) {
    if (!node || !(node instanceof Element)) return;
    snapshotProp(node, prop);
    node.style.setProperty(prop, value, 'important');
  }

  function restoreProps() {
    for (const [node, map] of propSnapshots.entries()) {
      if (!node || !(node instanceof Element)) continue;
      for (const [prop, snap] of map.entries()) {
        if (!snap || !snap.value) node.style.removeProperty(prop);
        else node.style.setProperty(prop, snap.value, snap.priority);
      }
      if (!node.getAttribute('style')) node.removeAttribute('style');
    }
    propSnapshots.clear();
  }

  function baseHeights(isLarge) {
    const width = window.innerWidth || 1280;
    if (width <= 720) {
      return isLarge
        ? { minEditor: 220, preferredEditor: 360 }
        : { minEditor: 180, preferredEditor: 240 };
    }
    if (width <= 1024) {
      return isLarge
        ? { minEditor: 260, preferredEditor: 460 }
        : { minEditor: 220, preferredEditor: 300 };
    }
    return isLarge
      ? { minEditor: 320, preferredEditor: 560 }
      : { minEditor: 220, preferredEditor: 340 };
  }

  function tempInlineProp(node, prop) {
    return {
      value: node.style.getPropertyValue(prop),
      priority: node.style.getPropertyPriority(prop)
    };
  }

  function restoreTempProp(node, prop, snap) {
    if (!snap || !snap.value) node.style.removeProperty(prop);
    else node.style.setProperty(prop, snap.value, snap.priority);
  }

  function measureContentHeight(editorEl, minEditor) {
    if (!editorEl) return minEditor;
    const h = tempInlineProp(editorEl, 'height');
    const mh = tempInlineProp(editorEl, 'min-height');
    editorEl.style.removeProperty('height');
    editorEl.style.removeProperty('min-height');
    // Read scrollHeight without touching overflow — changing overflow-y resets
    // the textarea's scrollTop, which would jump the user's read position.
    const scrollHeight = Number(editorEl.scrollHeight) || 0;
    restoreTempProp(editorEl, 'height', h);
    restoreTempProp(editorEl, 'min-height', mh);
    return Math.max(minEditor, Math.ceil(scrollHeight + 8));
  }

  function appliedEditorHeight(target, isLarge) {
    const base = baseHeights(isLarge);
    const preferred = normalizeStoredHeight(preferredEditorHeight);
    if (preferred != null) return clampHeight(preferred);
    const autoPreferred = Math.max(base.minEditor, base.preferredEditor);
    const content = measureContentHeight(target.editorEl, base.minEditor);
    return Math.max(base.minEditor, Math.min(autoPreferred, content));
  }

  function normalizeMode(settings) {
    const storedHeight = normalizeStoredHeight(settings && settings.originalDescriptionHeight);
    const stylingEnabled = Boolean(settings && settings.enhanceOriginalDescription === true);
    const sizingEnabled = Boolean(settings && (settings.largeOriginalDescription === true || storedHeight != null));
    return {
      active: Boolean(settings && (stylingEnabled || sizingEnabled)),
      stylingEnabled,
      sizingEnabled,
      isLarge: Boolean(settings && settings.largeOriginalDescription === true),
      storedHeight
    };
  }

  function sameMode(a, b) {
    return Boolean(
      a &&
      b &&
      a.stylingEnabled === b.stylingEnabled &&
      a.sizingEnabled === b.sizingEnabled &&
      a.isLarge === b.isLarge
    );
  }

  // Enforce surfaceEl height immediately (sync) and again after the next
  // animation frame so ServiceNow's autoresize MO (which fires synchronously
  // in response to our textarea height write) cannot cap it back to 16rem.
  function enforceSurfaceHeight(target, editorPx) {
    const surf = target.surfaceEl;
    if (!surf || surf === target.editorEl || surf === target.fieldEl) return;
    // height: auto lets the wrapper grow with the textarea after native resize.
    // min-height keeps the wrapper at least as tall as the initial computed height.
    // SN's autoresize sets wrapper.style.height = 'Xpx' (non-important inline);
    // our height: auto !important wins, so the rAF re-enforcement is still needed.
    surf.style.setProperty('height', 'auto', 'important');
    surf.style.setProperty('min-height', editorPx, 'important');
    surf.style.setProperty('max-height', 'none', 'important');
    surf.style.setProperty('max-block-size', 'none', 'important');
    surf.style.setProperty('overflow', 'visible', 'important');
  }

  function applyLayoutStyles(target, mode) {
    const editor = appliedEditorHeight(target, mode.isLarge);
    const editorPx = `${editor}px`;
    const surfaceEl = target.surfaceEl || target.fieldEl;

    for (const node of layoutNodesFor(target)) {
      // surfaceEl is the immediate wrapper of the textarea (e.g.
      // now-textarea-wrapper). Give it the same explicit pixel height as the
      // textarea so ServiceNow's autoresize script — which computes
      // min(scrollHeight, maxBlockSize) and writes wrapper.style.height —
      // cannot shrink it back to 16rem. All other ancestors use height:auto
      // so they size naturally from their content.
      const isSurface = node === surfaceEl && node !== target.fieldEl;
      applyInline(node, 'height', 'auto');
      applyInline(node, 'min-height', isSurface ? editorPx : '0');
      applyInline(node, 'max-height', 'none');
      applyInline(node, 'max-block-size', 'none');
      // surfaceEl (now-textarea-wrapper) always needs overflow:visible so the
      // native resize corner is not clipped by the wrapper's default overflow:hidden.
      if (mode.stylingEnabled || isSurface) {
        applyInline(node, 'overflow', 'visible');
      }
      if (mode.stylingEnabled) {
        applyInline(node, 'align-self', 'stretch');
        applyInline(node, 'contain', 'none');
      }
    }

    // Re-enforce AFTER the current call stack — ServiceNow's MutationObserver
    // runs synchronously inside our applyInline(editorEl, 'height') call below
    // and may reset the wrapper. The rAF fires after all synchronous MO
    // callbacks, giving us the final word before the frame paints.
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => {
        if (!activeTarget || activeTarget.editorEl !== target.editorEl) return;
        enforceSurfaceHeight(target, editorPx);
      });
    }

    // Release height caps on immediate ancestor form cells/rows so the grown
    // description pushes subsequent rows down. Setting min-height is
    // intentionally omitted: forcing 0 on a scroll-container ancestor resets
    // its scroll position. height: auto allows the cell to size from content.
    for (const node of ancestorFlowNodesFor(target)) {
      applyInline(node, 'height', 'auto');
      applyInline(node, 'max-height', 'none');
      applyInline(node, 'max-block-size', 'none');
    }

    // Ensure the shadow host is block-level so its height participates in the
    // form grid/flex layout. Without this, an inline-display custom element
    // (the default for unregistered/partially-registered custom elements)
    // would be ignored for row sizing even after we set height: auto on it.
    if (target.shadowRoot) {
      applyInline(target.shadowRoot.host, 'display', 'block');
    }

    if (mode.stylingEnabled) {
      applyInline(target.fieldEl, 'position', 'relative');
      applyInline(target.fieldEl, 'width', '100%');
      if (surfaceEl && surfaceEl !== target.editorEl) {
        // Do NOT set display: block here. surfaceEl (now-textarea-wrapper) is
        // display: grid — all children (textarea, copy, backdrop) stack in the
        // same grid cell. Overriding to block makes them flow vertically, so the
        // invisible copy and backdrop divs (which mirror the textarea text) add
        // ~content-height of blank space below the textarea.
        applyInline(surfaceEl, 'position', 'relative');
        applyInline(surfaceEl, 'width', '100%');
        applyInline(surfaceEl, 'overflow', 'visible');
      }
      applyInline(target.editorEl, 'box-sizing', 'border-box');
      applyInline(target.editorEl, 'display', 'block');
      applyInline(target.editorEl, 'width', '100%');
      applyInline(target.editorEl, 'padding-top', '16px');
      applyInline(target.editorEl, 'padding-right', '18px');
      applyInline(target.editorEl, 'line-height', '1.65');
      applyInline(target.editorEl, 'font-size', '14px');
      applyInline(target.editorEl, 'white-space', 'pre-wrap');
      applyInline(target.editorEl, 'overflow-wrap', 'anywhere');
      applyInline(target.editorEl, 'tab-size', '2');
    }

    // Set height without !important so the browser's native resize corner can
    // override it. The snapshot is taken explicitly so clear() still restores.
    snapshotProp(target.editorEl, 'height');
    target.editorEl.style.setProperty('height', `${editor}px`);
    applyInline(target.editorEl, 'min-height', `${MIN_RESIZE_EDITOR_HEIGHT}px`);
    applyInline(target.editorEl, 'max-height', 'none');
    applyInline(target.editorEl, 'max-block-size', 'none');
    applyInline(target.editorEl, 'overflow-y', 'auto');
    applyInline(target.editorEl, 'overflow-x', 'hidden');
    applyInline(target.editorEl, 'resize', 'vertical');
  }

  function persistHeightDebounced(nextHeight) {
    const value = normalizeStoredHeight(nextHeight);
    if (value == null) return;
    if (saveHeightTimer) clearTimeout(saveHeightTimer);
    saveHeightTimer = setTimeout(() => {
      saveHeightTimer = null;
      storage.set({ originalDescriptionHeight: value }).catch(() => {
        log.debug('failed to persist original description height');
      });
    }, 250);
  }

  function flushPendingHeightSave() {
    if (!saveHeightTimer) return;
    clearTimeout(saveHeightTimer);
    saveHeightTimer = null;
    const value = normalizeStoredHeight(preferredEditorHeight);
    if (value == null) return;
    storage.set({ originalDescriptionHeight: value }).catch(() => {
      log.debug('failed to persist original description height');
    });
  }

  function commitHeight(nextHeight) {
    const clamped = clampHeight(nextHeight);
    preferredEditorHeight = clamped;
    if (activeTarget) {
      const { editorEl, surfaceEl, fieldEl } = activeTarget;
      // Non-important on editor so native resize is not blocked.
      if (editorEl) editorEl.style.setProperty('height', `${clamped}px`);
      if (surfaceEl && surfaceEl !== editorEl && surfaceEl !== fieldEl) {
        applyInline(surfaceEl, 'min-height', `${clamped}px`);
      }
    }
    persistHeightDebounced(clamped);
  }

  function setLiveHeight(nextHeight) {
    const clamped = clampHeight(nextHeight);
    if (activeTarget) {
      const { editorEl, surfaceEl, fieldEl } = activeTarget;
      if (editorEl) editorEl.style.setProperty('height', `${clamped}px`);
      if (surfaceEl && surfaceEl !== editorEl && surfaceEl !== fieldEl) {
        surfaceEl.style.setProperty('min-height', `${clamped}px`, 'important');
      }
    }
    return clamped;
  }

  function onHandlePointerDown(event) {
    if (!activeTarget || !activeHandle) return;
    if (event.button !== undefined && event.button !== 0) return;
    event.preventDefault();
    clearPendingDragHeight();
    const editorEl = activeTarget.editorEl;
    dragState = {
      startY: event.clientY,
      startHeight: currentEditorHeight(editorEl),
      pointerId: event.pointerId
    };
    try { activeHandle.setPointerCapture(event.pointerId); } catch (_) {}
    activeHandle.classList.add('is-dragging');
  }

  function onHandlePointerMove(event) {
    if (!dragState) return;
    if (dragState.pointerId !== undefined && event.pointerId !== dragState.pointerId) return;
    const delta = event.clientY - dragState.startY;
    scheduleLiveHeight(dragState.startHeight + delta);
  }

  function onHandlePointerEnd(event) {
    if (!dragState) return;
    if (dragState.pointerId !== undefined && event.pointerId !== dragState.pointerId) return;
    const delta = event.clientY - dragState.startY;
    const finalHeight = clampHeight(dragState.startHeight + delta);
    try { activeHandle.releasePointerCapture(dragState.pointerId); } catch (_) {}
    activeHandle.classList.remove('is-dragging');
    dragState = null;
    clearPendingDragHeight();
    commitHeight(finalHeight);
  }

  function onHandleKeyDown(event) {
    if (!activeTarget) return;
    const editorEl = activeTarget.editorEl;
    const current = currentEditorHeight(editorEl);
    const step = event.shiftKey ? KEY_STEP_LARGE : KEY_STEP;
    let next = null;
    if (event.key === 'ArrowDown') next = current + step;
    else if (event.key === 'ArrowUp') next = current - step;
    else if (event.key === 'Home') next = MIN_RESIZE_EDITOR_HEIGHT;
    else if (event.key === 'End') next = MAX_RESIZE_EDITOR_HEIGHT;
    else return;
    event.preventDefault();
    commitHeight(next);
  }

  function createHandle(doc) {
    const row = doc.createElement('div');
    row.className = RESIZE_ROW_CLASS;
    const handle = doc.createElement('div');
    handle.className = RESIZE_HANDLE_CLASS;
    handle.setAttribute('role', 'separator');
    handle.setAttribute('aria-orientation', 'horizontal');
    handle.setAttribute('aria-label', 'Resize Description field');
    handle.setAttribute('tabindex', '0');
    row.appendChild(handle);
    handle.addEventListener('pointerdown', onHandlePointerDown);
    handle.addEventListener('pointermove', onHandlePointerMove);
    handle.addEventListener('pointerup', onHandlePointerEnd);
    handle.addEventListener('pointercancel', onHandlePointerEnd);
    handle.addEventListener('keydown', onHandleKeyDown);
    return { row, handle };
  }

  function mountHandle(target) {
    // Always anchor on fieldEl (outermost field container in light DOM).
    // surfaceEl may be inside a shadow root where styles.css cannot reach.
    // shadowRoot.host may be inside a container with overflow:hidden that
    // clips the handle row. fieldEl.parentNode is outside all such constraints.
    const anchor = target.fieldEl;
    if (!anchor || !anchor.parentNode) return;
    const doc = anchor.ownerDocument || document;
    const { row, handle } = createHandle(doc);
    anchor.parentNode.insertBefore(row, anchor.nextSibling);
    activeHandleRow = row;
    activeHandle = handle;
  }

  function removeHandle() {
    if (!activeHandleRow) return;
    if (activeHandleRow.parentNode) activeHandleRow.parentNode.removeChild(activeHandleRow);
    activeHandleRow = null;
    activeHandle = null;
    dragState = null;
    clearPendingDragHeight();
  }

  /* Raw source text of the description editor: textarea value, or the
   * rendered text of a contenteditable / [role="textbox"] editor. */
  function editorSourceText(target) {
    const editor = target && target.editorEl;
    if (!editor) return null;
    if (typeof editor.value === 'string') return editor.value;
    return (editor.innerText || editor.textContent || '').replace(/\u00A0/g, ' ');
  }

  /* Copy button anchored in a right-aligned toolbar row ABOVE the field
   * (mirrors the resize row below it). The format comes from the
   * descriptionCopyFormat setting, read live at click time.
   *
   * Mounting is idempotent at the DOM level: every row this module previously
   * mounted is removed first (tracked in mountedCopyRows, so it works whether
   * the row landed in the light DOM or inside a ServiceNow shadow root).
   * Styles are injected into the row's own shadow root when needed, since
   * document-level styles.css cannot reach inside a shadow root. */
  function mountCopyButton(target) {
    const anchor = target.fieldEl;
    if (!anchor || !anchor.parentNode) return;
    removeAllMountedCopyRows();
    const doc = anchor.ownerDocument || document;
    const row = doc.createElement('div');
    row.className = COPY_ROW_CLASS;
    const button = doc.createElement('button');
    button.type = 'button';
    button.className = COPY_BUTTON_CLASS;
    button.setAttribute('aria-label', 'Copy Description');
    button.setAttribute('title', 'Copy Description');
    button.innerHTML = [
      '<svg class="sncrm-description-copy-icon" viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" focusable="false">',
      '<rect x="5.5" y="5.5" width="8" height="8" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.4"></rect>',
      '<path d="M10.5 5.5V4a1.5 1.5 0 0 0-1.5-1.5H4A1.5 1.5 0 0 0 2.5 4v5A1.5 1.5 0 0 0 4 10.5h1.5" fill="none" stroke="currentColor" stroke-width="1.4"></path>',
      '</svg>',
      '<span class="sncrm-description-copy-label">Copy</span>'
    ].join('');
    const label = button.querySelector('.sncrm-description-copy-label');
    row.appendChild(button);
    anchor.parentNode.insertBefore(row, anchor);
    mountedCopyRows.add(row);
    activeCopyRow = row;
    activeCopyButton = button;
    // Styled wherever it landed: page CSS covers the light DOM, and the
    // enhancer's shadow stylesheet carries the copy rules into shadow roots.
    const rowRoot = row.getRootNode && row.getRootNode();
    if (rowRoot && rowRoot instanceof ShadowRoot) ensureShadowStyle(rowRoot);
    button.addEventListener('click', () => {
      const value = editorSourceText(activeTarget || target);
      if (value == null) return;
      const settingsPromise = (storage && typeof storage.get === 'function')
        ? storage.get()
        : Promise.resolve({ descriptionCopyFormat: 'markdown' });
      settingsPromise
        .then((settings) => NS.clipboard.copyDescription(
          value,
          settings && settings.descriptionCopyFormat,
          NS.markdown && NS.markdown.render
        ))
        .catch(() => false)
        .then((ok) => {
          if (!ok) return;
          if (label) label.textContent = 'Copied';
          if (button._sncrmCopyTimer) clearTimeout(button._sncrmCopyTimer);
          button._sncrmCopyTimer = setTimeout(() => {
            if (label) label.textContent = 'Copy';
          }, 1200);
        });
    });
  }

  function removeAllMountedCopyRows() {
    for (const row of mountedCopyRows) {
      const button = row && row.querySelector && row.querySelector('.' + COPY_BUTTON_CLASS);
      if (button && button._sncrmCopyTimer) {
        clearTimeout(button._sncrmCopyTimer);
        button._sncrmCopyTimer = null;
      }
      if (row && row.parentNode) row.parentNode.removeChild(row);
    }
    mountedCopyRows.clear();
  }

  function removeCopyButton() {
    removeAllMountedCopyRows();
    // Belt-and-braces: sweep any stragglers from earlier bundle instances that
    // are still in the document's light DOM.
    for (const stray of document.querySelectorAll('.' + COPY_ROW_CLASS)) {
      stray.remove();
    }
    activeCopyRow = null;
    activeCopyButton = null;
  }

  function clear() {
    flushPendingHeightSave();
    if (activeResizeObserver) {
      activeResizeObserver.disconnect();
      activeResizeObserver = null;
    }
    removeHandle();
    removeCopyButton();
    restoreProps();
    for (const node of appliedNodes) {
      if (!node || !(node instanceof Element)) continue;
      node.classList.remove(
        FIELD_CLASS,
        FLOW_CLASS,
        HOST_CLASS,
        EDITOR_CLASS,
        LARGE_CLASS
      );
    }
    appliedNodes.clear();
    activeTarget = null;
    activeMode = null;
  }

  function apply(scopeEl, settings) {
    const mode = normalizeMode(settings);
    if (!mode.active) {
      clear();
      return false;
    }

    const scope = scopeEl && scopeEl.querySelectorAll ? scopeEl : document.body;
    const target = findDescriptionTarget(scope) ||
      (scope !== document.body ? findDescriptionTarget(document.body) : null);

    if (!target) {
      clear();
      log.debug('original description field not found');
      return false;
    }

    const sameTarget = activeTarget && activeTarget.editorEl === target.editorEl;
    if (!sameTarget || !sameMode(activeMode, mode)) clear();

    // Stored value wins on initial apply for this session. Once preferred is
    // set (from storage OR from a completed handle interaction), it stays.
    if (mode.storedHeight != null || preferredEditorHeight == null) {
      preferredEditorHeight = mode.storedHeight;
    }

    const { editorEl, shadowRoot } = target;
    for (const node of layoutNodesFor(target)) {
      node.classList.add(FIELD_CLASS, FLOW_CLASS);
      if (mode.stylingEnabled && node !== document.body) node.classList.add(HOST_CLASS);
      else node.classList.remove(HOST_CLASS);
      if (mode.isLarge) node.classList.add(LARGE_CLASS);
      else node.classList.remove(LARGE_CLASS);
      appliedNodes.add(node);
    }
    activeTarget = target;
    activeMode = mode;
    applyLayoutStyles(target, mode);

    if (editorEl) {
      editorEl.classList.add(EDITOR_CLASS);
      if (mode.isLarge) editorEl.classList.add(LARGE_CLASS);
      else editorEl.classList.remove(LARGE_CLASS);
      appliedNodes.add(editorEl);
    }

    if (shadowRoot) ensureShadowStyle(shadowRoot);

    if (!activeHandle) mountHandle(target);

    if (!activeCopyButton) mountCopyButton(target);

    // Observe native resize-corner drags. Height is set without !important so
    // the browser's own resize drag can update element.style.height freely.
    // When the ResizeObserver fires we treat any height change as the new user
    // preference and persist it — the custom-handle and keyboard paths also
    // call commitHeight which calls persistHeightDebounced, so all resize
    // mechanisms converge on the same persistence path.
    if (!activeResizeObserver && typeof ResizeObserver !== 'undefined' && target.editorEl) {
      const observed = target.editorEl;
      const ro = new ResizeObserver((entries) => {
        if (!activeTarget || activeTarget.editorEl !== observed) { ro.disconnect(); return; }
        const h = resizeObserverHeight(entries && entries[0], observed);
        if (h >= MIN_RESIZE_EDITOR_HEIGHT) {
          // commitHeight syncs preferredEditorHeight, editorEl height,
          // surfaceEl min-height, and debounce-persists in one place.
          commitHeight(h);
        }
      });
      ro.observe(observed);
      activeResizeObserver = ro;
    }

    log.debug('enhanced original description field', {
      large: mode.isLarge,
      styled: mode.stylingEnabled,
      shadow: Boolean(shadowRoot),
      storedHeight: preferredEditorHeight
    });
    return true;
  }

  NS.originalDescriptionEnhancer = { apply, clear };
})(typeof self !== 'undefined' ? self : globalThis);
