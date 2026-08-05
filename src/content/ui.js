(function (root) {
  'use strict';
  const NS = (root.SNCRM = root.SNCRM || {});
  const log = NS.log.make('ui');
  const { PANEL_ID } = NS.constants;
  const { byKey } = NS.fieldRegistry;

  // Single source of truth for the toggle button label. Shared between initial
  // render (buildShell) and the click handler in controller.js so the text
  // never diverges between code paths.
  const TOGGLE_SHOW = 'Expand';
  const TOGGLE_HIDE = 'Collapse';
  const MOBILE_MAX_WIDTH = 720;
  const TABLET_MAX_WIDTH = 1024;
  const renderStateByContent = new WeakMap();

  function el(tag, opts = {}) {
    const n = document.createElement(tag);
    if (opts.className) n.className = opts.className;
    if (opts.text != null) n.textContent = opts.text;
    if (opts.attrs) for (const [k, v] of Object.entries(opts.attrs)) n.setAttribute(k, v);
    return n;
  }

  /* Format a pure-integer value with locale thousand separators. Returns the
   * original string if the value isn't a clean integer (so we don't mangle
   * text like "N/A" or already-formatted currency strings with units). */
  function formatInteger(v) {
    if (v == null) return '';
    const s = String(v).trim();
    if (!s) return s;
    // Strip existing separators (spaces, NBSPs, commas, apostrophes, underscores).
    const stripped = s.replace(/[\s\u00A0,'_]/g, '');
    if (!/^-?\d+$/.test(stripped)) return s;
    const sign = stripped.startsWith('-') ? '-' : '';
    const digits = sign ? stripped.slice(1) : stripped;
    return sign + digits.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  }

  function effectiveColumnCount(requestedColumns, viewportWidth) {
    const requested = Math.max(1, Math.min(4, Number(requestedColumns) || 3));
    const width = Number(viewportWidth) || window.innerWidth || 0;
    if (width <= MOBILE_MAX_WIDTH) return 1;
    if (width <= TABLET_MAX_WIDTH) return Math.min(2, requested);
    return requested;
  }

  function splitBadgeItems(value) {
    return String(value || '')
      .split(/\s*(?:\n|;|,)\s*/g)
      .map((item) => item.trim())
      .filter(Boolean);
  }

  function normalizeAbsoluteHttpUrl(value) {
    const raw = String(value || '').trim();
    if (!raw) return '';
    try {
      const parsed = new URL(raw);
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
        return parsed.toString();
      }
    } catch {
      return '';
    }
    return '';
  }

  function badgeItemsFor(meta, result) {
    if (result && Array.isArray(result.badges) && result.badges.length) {
      return result.badges;
    }
    if (meta.renderAs === 'badge-list') return splitBadgeItems(result && result.value);
    if (meta.renderAs === 'badge') return result && result.value ? [String(result.value).trim()] : [];
    return [];
  }

  function buildTag(text) {
    return el('span', {
      className: 'sncrm-tag',
      text
    });
  }

  function renderedValue(result) {
    return result && result.found ? String(result.value || '') : '';
  }

  function ensureCardNodes(card) {
    let label = card && card._sncrmLabelEl;
    let valueRow = card && card._sncrmValueEl;
    if (label instanceof Element && valueRow instanceof Element) {
      return { label, valueRow };
    }
    label = el('div', { className: 'sncrm-card-label' });
    valueRow = el('div', { className: 'sncrm-card-value' });
    card.replaceChildren(label, valueRow);
    card._sncrmLabelEl = label;
    card._sncrmValueEl = valueRow;
    return { label, valueRow };
  }

  function updateCard(card, meta, result) {
    const value = renderedValue(result);
    const badgeItems = badgeItemsFor(meta, result);
    const { label, valueRow } = ensureCardNodes(card);
    label.textContent = meta.label;
    valueRow.className = 'sncrm-card-value' + (value ? '' : ' is-empty');
    valueRow.replaceChildren();

    if (!value) {
      valueRow.textContent = '—';
      card.setAttribute('aria-label', `${meta.label}: not available`);
      return card;
    }

    card.removeAttribute('aria-label');
    if (badgeItems.length) {
      valueRow.classList.add('is-tags');
      badgeItems.forEach((item) => valueRow.append(buildTag(item)));
    } else if (meta.renderAs === 'date') {
      const text = el('span', { className: 'sncrm-date-text', text: value });
      valueRow.append(text);
      const parsed = self.SNCRM.dates.parseSnDate(value);
      if (parsed) {
        const days = self.SNCRM.dates.daysUntil(parsed);
        const tone = self.SNCRM.dates.countdownTone(days);
        const labelText = self.SNCRM.dates.countdownLabel(days);
        const badge = el('span', {
          className: `sncrm-badge sncrm-badge-${tone}`,
          text: labelText
        });
        badge.setAttribute('title', `${meta.label}: ${labelText}`);
        valueRow.append(badge);
      }
    } else if (meta.renderAs === 'link') {
      const href = normalizeAbsoluteHttpUrl(value);
      const link = el('a', {
        className: 'sncrm-link',
        text: value,
        attrs: { href: href || '#', target: '_blank', rel: 'noopener', title: value }
      });
      if (href) {
        link.addEventListener('click', (event) => {
          event.preventDefault();
          event.stopPropagation();
          window.open(href, '_blank', 'noopener');
        });
      }
      valueRow.append(link);
    } else if (meta.renderAs === 'number') {
      valueRow.textContent = formatInteger(value);
      valueRow.classList.add('sncrm-num');
    } else {
      valueRow.textContent = value;
    }

    return card;
  }

  function buildCard(meta, result) {
    const card = el('div', { className: 'sncrm-card' });
    const label = el('div', { className: 'sncrm-card-label' });
    const valueRow = el('div', { className: 'sncrm-card-value' });
    card._sncrmLabelEl = label;
    card._sncrmValueEl = valueRow;
    card.append(label, valueRow);
    return updateCard(card, meta, result);
  }

  function gridSpanFor(meta, item, columns) {
    const rawSpan = item && Number.isFinite(item.span) ? Math.round(item.span) : (meta && meta.renderAs === 'markdown' ? columns : 1);
    return Math.max(1, Math.min(columns, rawSpan));
  }

  function applyGridSpan(node, span) {
    if (!node) return;
    if (span > 1) node.style.gridColumn = `span ${span}`;
    else node.style.gridColumn = '';
  }

  function normalizeLayoutItems(layout, selectedKeys, columns) {
    const keys = Array.isArray(selectedKeys) ? selectedKeys : [];
    const selectedSet = new Set(keys);
    if (!Array.isArray(layout)) {
      return keys.map((key) => ({ type: 'field', key, span: byKey[key] && byKey[key].renderAs === 'markdown' ? columns : 1 }));
    }

    const out = [];
    const seen = new Set();
    for (const item of layout) {
      if (!item) continue;
      if (item.type === 'empty') {
        out.push({ type: 'empty', id: item.id || '', span: 1 });
        continue;
      }
      if (item.type !== 'field' || !selectedSet.has(item.key) || seen.has(item.key)) continue;
      seen.add(item.key);
      out.push({ type: 'field', key: item.key, span: item.span });
    }
    for (const key of keys) {
      if (seen.has(key)) continue;
      out.push({ type: 'field', key, span: byKey[key] && byKey[key].renderAs === 'markdown' ? columns : 1 });
    }
    return out;
  }

  function buildSpacer(span) {
    const spacer = el('div', {
      className: 'sncrm-spacer',
      attrs: { 'aria-hidden': 'true' }
    });
    applyGridSpan(spacer, span);
    return spacer;
  }

  function existing() {
    return document.getElementById(PANEL_ID);
  }

  function buildShell({ collapsed, onToggle, onRefresh, onConfigure }) {
    const panel = el('section', {
      attrs: {
        id: PANEL_ID,
        role: 'region',
        'aria-label': 'Opportunity overview'
      }
    });
    if (collapsed) panel.classList.add('is-collapsed');

    // Header is a floating toolbar in the top-right corner of the page.
    // Because the panel itself is pointer-events: none, the CRM top bar
    // stays interactive in the empty airspace; only the buttons catch clicks.
    const header = el('div', { className: 'sncrm-header' });

    const toggleBtn = el('button', {
      className: 'sncrm-btn sncrm-btn-toggle',
      text: collapsed ? TOGGLE_SHOW : TOGGLE_HIDE,
      attrs: { type: 'button', 'aria-expanded': String(!collapsed) }
    });
    toggleBtn.addEventListener('click', () => onToggle(toggleBtn));

    const refreshBtn = el('button', {
      className: 'sncrm-btn',
      text: 'Refresh',
      attrs: { type: 'button', title: 'Re-read fields from the page' }
    });
    refreshBtn.addEventListener('click', onRefresh);

    const configBtn = el('button', {
      className: 'sncrm-btn',
      text: 'Configure',
      attrs: { type: 'button', title: 'Open extension options' }
    });
    configBtn.addEventListener('click', onConfigure);

    // Order: secondary actions first, primary toggle last so it anchors
    // visually on the right — the highest-traffic control sits closest to
    // the user's pointer.
    header.append(refreshBtn, configBtn, toggleBtn);

    // `body` owns layout/scroll/chrome. `content` holds the rendered fields.
    // Rendering wipes `content` only — the resize handle (appended to `body`
    // by attachResize) stays put across every re-render. Without this split
    // the handle would be lost on the first rerenderValues call.
    const body = el('div', { className: 'sncrm-body' });
    const content = el('div', { className: 'sncrm-body-content' });
    body.append(content);
    panel.append(header, body);
    return { panel, body, content, toggleBtn };
  }

  function renderSkeleton(content, count = 6) {
    renderStateByContent.delete(content);
    content.replaceChildren();
    for (let i = 0; i < count; i++) {
      const row = el('div', { className: 'sncrm-skel-row' });
      const a = el('div', { className: 'sncrm-skel' });
      const b = el('div', { className: 'sncrm-skel' });
      a.style.width = `${50 + (i % 3) * 15}%`;
      b.style.width = `${60 + ((i + 1) % 4) * 10}%`;
      row.append(a, b);
      content.append(row);
    }
  }

  function renderEmpty(content, message, detail) {
    renderStateByContent.delete(content);
    content.replaceChildren();
    content.append(el('div', {
      className: 'sncrm-empty',
      text: message || 'Nothing to show.'
    }));
    if (detail) {
      content.append(el('div', {
        className: 'sncrm-empty-detail',
        text: detail
      }));
    }
  }

  function ensureMarkdownNodes(block) {
    let head = block && block._sncrmHeadEl;
    let body = block && block._sncrmBodyEl;
    if (head instanceof Element && body instanceof Element) {
      return { head, body };
    }
    head = el('div', { className: 'sncrm-md-label' });
    body = el('div', { className: 'sncrm-md-body' });
    block.replaceChildren(head, body);
    block._sncrmHeadEl = head;
    block._sncrmBodyEl = body;
    return { head, body };
  }

  function updateMarkdownBlock(block, meta, value, opts) {
    const autoHeight = !!(opts && opts.autoHeight);
    const { head, body } = ensureMarkdownNodes(block);
    block.className = `sncrm-md sncrm-md-${meta.key}` + (autoHeight ? ' is-auto-height' : '');
    head.textContent = meta.label;
    body.className = 'sncrm-md-body' + (value ? '' : ' is-empty');
    if (value) {
      body.innerHTML = self.SNCRM.markdown.render(value);
    } else {
      body.textContent = `No ${meta.label.toLowerCase()} provided`;
    }
    return block;
  }

  function buildMarkdownBlock(meta, value, opts) {
    const block = el('section');
    const head = el('div', { className: 'sncrm-md-label' });
    const content = el('div', { className: 'sncrm-md-body' });
    block._sncrmHeadEl = head;
    block._sncrmBodyEl = content;
    block.append(head, content);
    return updateMarkdownBlock(block, meta, value, opts);
  }

  function itemId(item, index) {
    if (item && item.type === 'field') return `field:${item.key}`;
    return `empty:${item && item.id ? item.id : index}`;
  }

  function fieldSnapshot(meta, result, span, autoHeight) {
    return {
      span,
      autoHeight: !!autoHeight,
      value: renderedValue(result),
      badges: badgeItemsFor(meta, result)
    };
  }

  function sameFieldSnapshot(a, b) {
    if (!a || !b) return false;
    if (a.span !== b.span || a.autoHeight !== b.autoHeight || a.value !== b.value) return false;
    const aBadges = a.badges || [];
    const bBadges = b.badges || [];
    if (aBadges.length !== bBadges.length) return false;
    for (let i = 0; i < aBadges.length; i++) {
      if (aBadges[i] !== bBadges[i]) return false;
    }
    return true;
  }

  function syncGridChildren(grid, nextNodes) {
    let cursor = grid.firstChild;
    for (const node of nextNodes) {
      if (node === cursor) {
        cursor = cursor.nextSibling;
        continue;
      }
      grid.insertBefore(node, cursor);
    }
    while (cursor) {
      const next = cursor.nextSibling;
      grid.removeChild(cursor);
      cursor = next;
    }
  }

  /* All fields render into a single grid in the user's selected order.
   * Short-form fields occupy one column; long-form (markdown) fields span
   * the full row via `grid-column: 1 / -1` in CSS. This lets the user
   * interleave them — e.g. place Description above Status. */
  function renderValues(content, selectedKeys, results, opts) {
    const keys = Array.isArray(selectedKeys) ? selectedKeys : [];
    if (!keys.length) {
      renderStateByContent.delete(content);
      content.replaceChildren();
      content.append(el('div', {
        className: 'sncrm-empty',
        text: 'No fields selected. Open Configure to choose fields.'
      }));
      return;
    }
    const requestedColumns = (opts && opts.columns) || 3;
    const columns = effectiveColumnCount(requestedColumns);
    const autoHeight = !!(opts && opts.descriptionAutoHeight);
    const layoutItems = normalizeLayoutItems(opts && opts.layout, keys, requestedColumns);

    let state = renderStateByContent.get(content);
    let grid = state && state.grid;
    if (!(grid instanceof Element) || grid.parentNode !== content) {
      grid = el('div', { className: 'sncrm-cards' });
      state = { grid, items: new Map() };
      renderStateByContent.set(content, state);
      content.replaceChildren(grid);
    } else if (content.firstChild !== grid || content.childNodes.length !== 1) {
      content.replaceChildren(grid);
    }
    grid.style.setProperty('--sncrm-columns', String(columns));
    const prevItems = state.items || new Map();
    const nextItems = new Map();
    const nextNodes = [];

    for (let index = 0; index < layoutItems.length; index++) {
      const item = layoutItems[index];
      const id = itemId(item, index);
      if (item.type === 'empty') {
        const span = 1;
        const prev = prevItems.get(id);
        const spacer = prev && prev.type === 'empty'
          ? prev.node
          : buildSpacer(span);
        applyGridSpan(spacer, span);
        nextItems.set(id, { type: 'empty', node: spacer, span });
        nextNodes.push(spacer);
        continue;
      }
      const meta = byKey[item.key];
      if (!meta) continue;
      const result = results[item.key];
      const span = gridSpanFor(meta, item, columns);
      const prev = prevItems.get(id);
      const snapshot = fieldSnapshot(meta, result, span, autoHeight);
      if (meta.renderAs === 'markdown') {
        const block = prev && prev.type === 'field' && prev.node.tagName === 'SECTION'
          ? prev.node
          : buildMarkdownBlock(meta, snapshot.value, { autoHeight });
        if (!prev || prev.type !== 'field' || !sameFieldSnapshot(prev.snapshot, snapshot)) {
          updateMarkdownBlock(block, meta, snapshot.value, { autoHeight });
        }
        applyGridSpan(block, span);
        nextItems.set(id, { type: 'field', node: block, snapshot });
        nextNodes.push(block);
      } else {
        const card = prev && prev.type === 'field' && prev.node.tagName === 'DIV'
          ? prev.node
          : buildCard(meta, result);
        if (!prev || prev.type !== 'field' || !sameFieldSnapshot(prev.snapshot, snapshot)) {
          updateCard(card, meta, result);
        }
        applyGridSpan(card, span);
        nextItems.set(id, { type: 'field', node: card, snapshot });
        nextNodes.push(card);
      }
    }

    syncGridChildren(grid, nextNodes);
    state.items = nextItems;
  }

  /* Mount as a fixed banner ABOVE the native ServiceNow header.
   *
   * The SN chrome (header, search, menu) lives inside a shadow-DOM web
   * component (macroponent-*) which is typically position:fixed / inset:0 or
   * occupies 100vh. A plain body padding-top therefore has no effect — we
   * must actively shift every non-banner sibling down by the banner's
   * height and compress its effective height.
   *
   * We do this via inline style on each body child:
   *   - margin-top: h  (flow layout)
   *   - top: h         (position:fixed/absolute anchored to viewport)
   *   - height: calc(100vh - h)  (100vh fills shrink to fit)
   * A MutationObserver re-applies when SN inserts new body children.
   * All inline overrides are tagged with data-sncrm-shifted so teardown can
   * restore pristine styles.
   *
   * A ResizeObserver keeps the shift in sync with the banner's height when
   * it collapses/expands or the user resizes the body. */
  /* Push the ServiceNow app body down via an injected stylesheet. Inline
   * styles on the macroponent element are fragile: the tag is a custom
   * element (default display: inline in older engines) and SN may rewrite
   * its style attribute on render. A stylesheet in <head> using `!important`
   * wins reliably and applies to any future replacement of the same node.
   *
   * Selector strategy: SN's top-level app is a `<macroponent-*>` element
   * with `app-id` and `macroponent-namespace` attributes. Targeting those
   * attributes matches the app root without hardcoding its tag name. */
  /* Reserve room for the banner's collapsed header via a fixed body
   * margin-top (55px). The banner itself is position:fixed at the top, so
   * when expanded it overlays the CRM content below the header — without
   * shifting anything further. `left: 73px` on the banner keeps the SN left
   * sidebar fully visible at all times, even during expansion.
   *
   * CSS vars:
   *   --sncrm-topbar-height  collapsed banner height (= body margin-top)
   *   --sncrm-sidebar-width  left offset of the banner so the SN sidebar
   *                          remains uncovered
   * Both are defined at :root so downstream overrides (future settings,
   * responsive tweaks) can redefine them without touching JS. */
  const TOPBAR_VAR = '--sncrm-topbar-height';
  const SIDEBAR_VAR = '--sncrm-sidebar-width';
  const TOPBAR_DEFAULT = 55;
  const SIDEBAR_DEFAULT = 73;
  const SHIFT_STYLE_ID = 'sncrm-shift-style';

  function ensureShiftStyle() {
    let style = document.getElementById(SHIFT_STYLE_ID);
    if (style) return style;
    style = document.createElement('style');
    style.id = SHIFT_STYLE_ID;
    // The panel is pointer-events:none and the body has its own margin-top,
    // so the CRM top bar stays fully usable. We only publish the CSS vars
    // here so stylesheets/settings can consume them.
    style.textContent = `
      :root {
        ${TOPBAR_VAR}: ${TOPBAR_DEFAULT}px;
        ${SIDEBAR_VAR}: ${SIDEBAR_DEFAULT}px;
      }
    `;
    (document.head || document.documentElement).appendChild(style);
    return style;
  }

  function removeShiftStyle() {
    const s = document.getElementById(SHIFT_STYLE_ID);
    if (s && s.parentNode) s.parentNode.removeChild(s);
  }

  function mountInto(panel) {
    panel.style.position = 'fixed';
    panel.style.top = '0';
    panel.style.left = '0';
    panel.style.right = '0';
    panel.style.zIndex = '2147483000';
    panel.style.margin = '0';
    document.body.insertBefore(panel, document.body.firstChild);
    ensureShiftStyle();

    log.debug('mounted as top banner');
    return document.body;
  }

  function remove() {
    const e = existing();
    if (e && e.parentNode) e.parentNode.removeChild(e);
    removeShiftStyle();
  }

  /* Bottom-edge drag handle. Drag changes the body's max-height — the body
   * is the scroll container; the panel itself is transparent and size-less.
   * Height stored as percent of viewport so it stays sensible across
   * resolutions. */
  function attachResize(shell, initialPercent, onChange) {
    const { panel, body } = shell;
    // De-dup: remount paths may call attachResize more than once. Drop any
    // stale handle from a previous attach so we don't stack them.
    body.querySelectorAll('.sncrm-resize-handle').forEach((n) => n.remove());
    const handle = el('div', {
      className: 'sncrm-resize-handle',
      attrs: { 'aria-label': 'Resize overview panel', role: 'separator', tabindex: '0' }
    });
    body.append(handle);

    const applyHeight = (pct) => {
      const clamped = Math.max(15, Math.min(90, pct));
      body.style.maxHeight = `calc(${clamped}vh - var(${TOPBAR_VAR}, ${TOPBAR_DEFAULT}px))`;
      return clamped;
    };
    let currentPercent = applyHeight(initialPercent);

    let dragging = false;
    let startY = 0;
    let startPct = currentPercent;
    let moveFrameHandle = null;
    let pendingPercent = null;

    const flushPendingHeight = () => {
      if (pendingPercent == null) return currentPercent;
      currentPercent = applyHeight(pendingPercent);
      pendingPercent = null;
      return currentPercent;
    };

    const clearPendingHeight = () => {
      if (moveFrameHandle != null && typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(moveFrameHandle);
      }
      moveFrameHandle = null;
      pendingPercent = null;
    };

    // Drag events can outpace paint on slower machines; keep only the latest
    // requested height and collapse DOM writes to one per animation frame.
    const scheduleHeight = (pct) => {
      pendingPercent = pct;
      if (moveFrameHandle != null) return;
      if (typeof requestAnimationFrame !== 'function') {
        flushPendingHeight();
        return;
      }
      moveFrameHandle = requestAnimationFrame(() => {
        moveFrameHandle = null;
        flushPendingHeight();
      });
    };

    const onMove = (e) => {
      if (!dragging) return;
      const dy = e.clientY - startY;
      const vh = window.innerHeight || 1;
      const nextPct = startPct + (dy / vh) * 100;
      scheduleHeight(nextPct);
    };
    const onUp = () => {
      if (!dragging) return;
      dragging = false;
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      document.body.style.userSelect = '';
      const clamped = flushPendingHeight();
      if (onChange) onChange(clamped);
    };
    handle.addEventListener('pointerdown', (e) => {
      if (panel.classList.contains('is-collapsed')) return;
      dragging = true;
      startY = e.clientY;
      clearPendingHeight();
      startPct = currentPercent;
      document.body.style.userSelect = 'none';
      document.addEventListener('pointermove', onMove);
      document.addEventListener('pointerup', onUp);
      e.preventDefault();
    });
    // Keyboard nudge (±5 %).
    handle.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
      clearPendingHeight();
      const next = applyHeight(currentPercent + (e.key === 'ArrowDown' ? 5 : -5));
      currentPercent = next;
      if (onChange) onChange(next);
      e.preventDefault();
    });
    return { setPercent: applyHeight };
  }

  NS.ui = {
    buildShell, renderSkeleton, renderEmpty, renderValues, mountInto, existing, remove, attachResize,
    TOGGLE_SHOW, TOGGLE_HIDE, effectiveColumnCount
  };
})(typeof self !== 'undefined' ? self : globalThis);
