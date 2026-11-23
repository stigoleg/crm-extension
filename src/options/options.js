(function () {
  'use strict';
  const { storage, discoveryStore, fieldRegistry } = self.SNCRM;
  const { STATIC_FIELDS, byKey, staticByKey, isDetectedKey } = fieldRegistry;

  const $ = (id) => document.getElementById(id);
  const enabledCb = $('enabled');
  const expandedCb = $('startExpanded');
  const autoExpandCb = $('autoExpandSections');
  const panelFullHeightCb = $('panelFullHeight');
  const descriptionAutoHeightCb = $('descriptionAutoHeight');
  const enhanceOriginalDescriptionCb = $('enhanceOriginalDescription');
  const largeOriginalDescriptionCb = $('largeOriginalDescription');
  const descriptionCopyFormatSelect = $('descriptionCopyFormat');
  const debugCb = $('debug');
  const detectedFieldsCard = $('detectedFieldsCard');
  const detectedFieldsHost = $('detectedFields');
  const fieldsHost = $('fields');
  const layoutGrid = $('layoutGrid');
  const columnsSegment = $('columnsSegment');
  const addEmptyBtn = $('addEmptyCell');
  const saveIndicator = $('saveIndicator');
  const selectAllBtn = $('selectAll');
  const selectNoneBtn = $('selectNone');
  const resetBtn = $('resetDefaults');

  let current = null;
  let saveTimer = null;
  let dirtyKeys = new Set();
  let emptyIdSeed = 0;
  let draggingId = null;
  let dropTargetId = null;
  let dropPosition = 'before';
  let dropAtEnd = false;
  let discoveredFields = [];

  function cloneValue(value) {
    if (value == null || typeof value !== 'object') return value;
    return JSON.parse(JSON.stringify(value));
  }

  function buildPatch(keys) {
    const patch = {};
    for (const key of keys) patch[key] = cloneValue(current[key]);
    return patch;
  }

  function selectedDetectedFieldKeys() {
    return (current && Array.isArray(current.selectedFields) ? current.selectedFields : [])
      .filter((key) => fieldRegistry.isDetectedKey(key));
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
    discoveredFields = Array.isArray(fields) ? fields.slice() : [];
    fieldRegistry.refreshDiscoveredFields(withSelectedDetectedFallbacks(discoveredFields));
  }

  function detectedFieldMigrationPatch() {
    if (!current || !Array.isArray(current.fieldLayout)) return null;
    const nextFieldLayout = [];
    const seen = new Set();
    for (const item of current.fieldLayout) {
      if (!item || item.type !== 'field') {
        if (item) nextFieldLayout.push(item);
        continue;
      }
      const canonicalKey = fieldRegistry.canonicalKey(item.key);
      if (!canonicalKey || seen.has(canonicalKey)) continue;
      seen.add(canonicalKey);
      nextFieldLayout.push(canonicalKey === item.key ? item : { ...item, key: canonicalKey });
    }
    const nextSelectedFields = nextFieldLayout
      .filter((item) => item && item.type === 'field' && typeof item.key === 'string')
      .map((item) => item.key);
    if (
      JSON.stringify(nextFieldLayout) === JSON.stringify(current.fieldLayout) &&
      JSON.stringify(nextSelectedFields) === JSON.stringify(current.selectedFields || [])
    ) {
      return null;
    }
    return {
      fieldLayout: nextFieldLayout,
      selectedFields: nextSelectedFields
    };
  }

  function markDirty() {
    for (const key of arguments) dirtyKeys.add(key);
  }

  function fieldItemId(item) {
    return item.type === 'empty' ? item.id : item.key;
  }

  function nextEmptyId() {
    emptyIdSeed += 1;
    return `empty-${Date.now().toString(36)}-${emptyIdSeed}`;
  }

  function defaultSpanForKey(key) {
    const meta = byKey[key];
    return meta && meta.renderAs === 'markdown' ? current.columns : 1;
  }

  function clampSpan(span) {
    const value = Number.isFinite(span) ? Math.round(span) : 1;
    return Math.max(1, Math.min(current.columns || 3, value));
  }

  function createFieldItem(key, span) {
    return {
      type: 'field',
      key,
      span: clampSpan(Number.isFinite(span) ? span : defaultSpanForKey(key))
    };
  }

  function createEmptyItem() {
    return { type: 'empty', id: nextEmptyId(), span: 1 };
  }

  function syncSelectedFieldsFromLayout() {
    const seen = new Set();
    current.selectedFields = (current.fieldLayout || [])
      .filter((item) => item && item.type === 'field' && typeof item.key === 'string' && !seen.has(item.key) && seen.add(item.key))
      .map((item) => item.key);
  }

  function ensureLayoutState() {
    if (!Array.isArray(current.fieldLayout)) current.fieldLayout = [];
    syncSelectedFieldsFromLayout();
  }

  function layoutIndexById(id) {
    return (current.fieldLayout || []).findIndex((item) => fieldItemId(item) === id);
  }

  function effectiveSpan(item) {
    if (!item || item.type !== 'field') return 1;
    return clampSpan(Number.isFinite(item.span) ? item.span : defaultSpanForKey(item.key));
  }

  function spanLabel(span) {
    return span === 1 ? '1 col' : `${span} cols`;
  }

  function clearDropIndicators() {
    layoutGrid.querySelectorAll('.drop-before, .drop-after').forEach((node) => {
      node.classList.remove('drop-before', 'drop-after');
    });
    const tail = layoutGrid.querySelector('.layout-tail');
    if (tail) tail.classList.remove('is-active');
  }

  function applyDropIndicators() {
    clearDropIndicators();
    if (!draggingId) return;
    if (dropAtEnd) {
      const tail = layoutGrid.querySelector('.layout-tail');
      if (tail) tail.classList.add('is-active');
      return;
    }
    if (!dropTargetId) return;
    const selectorId = self.CSS && self.CSS.escape ? self.CSS.escape(dropTargetId) : dropTargetId;
    const target = layoutGrid.querySelector(`[data-layout-id="${selectorId}"]`);
    if (!target) return;
    target.classList.add(dropPosition === 'after' ? 'drop-after' : 'drop-before');
  }

  function resetDragState() {
    draggingId = null;
    dropTargetId = null;
    dropPosition = 'before';
    dropAtEnd = false;
    layoutGrid.classList.remove('is-dragging');
    clearDropIndicators();
    layoutGrid.querySelectorAll('.dragging').forEach((node) => node.classList.remove('dragging'));
  }

  function resolveDropIndex() {
    if (dropAtEnd || !dropTargetId) return current.fieldLayout.length;
    const targetIndex = layoutIndexById(dropTargetId);
    if (targetIndex === -1) return current.fieldLayout.length;
    return dropPosition === 'after' ? targetIndex + 1 : targetIndex;
  }

  function applyDrop() {
    if (!draggingId) return;
    const fromIndex = layoutIndexById(draggingId);
    if (fromIndex === -1) {
      resetDragState();
      return;
    }
    const targetIndex = resolveDropIndex();
    const next = current.fieldLayout.slice();
    const [item] = next.splice(fromIndex, 1);
    const insertAt = targetIndex > fromIndex ? targetIndex - 1 : targetIndex;
    next.splice(insertAt, 0, item);
    current.fieldLayout = next;
    syncSelectedFieldsFromLayout();
    markDirty('fieldLayout', 'selectedFields');
    resetDragState();
    renderLayout();
    syncFieldCheckboxes();
    scheduleSave();
  }

  /* Autosave — debounced. Rapid DnD/typing batch into one write. */
  function scheduleSave() {
    if (saveTimer) clearTimeout(saveTimer);
    saveIndicator.textContent = 'Saving…';
    saveIndicator.classList.add('saving');
    saveTimer = setTimeout(async () => {
      saveTimer = null;
      const keys = Array.from(dirtyKeys);
      dirtyKeys = new Set();
      const patch = buildPatch(keys);
      try {
        const next = await storage.set(patch);
        const pendingLocal = buildPatch(Array.from(dirtyKeys));
        current = next;
        Object.assign(current, pendingLocal);
        ensureLayoutState();
        saveIndicator.textContent = 'Saved';
        saveIndicator.classList.remove('saving');
        setTimeout(() => {
          if (saveIndicator.textContent === 'Saved') saveIndicator.textContent = '';
        }, 1200);
        if (dirtyKeys.size) scheduleSave();
      } catch (_e) {
        keys.forEach((key) => dirtyKeys.add(key));
        saveIndicator.textContent = 'Save failed';
        saveIndicator.classList.remove('saving');
      }
    }, 200);
  }

  /* ----- Layout grid (drag, resize, spacers) ----- */

  function buildLayoutTile(item) {
    const tile = document.createElement('div');
    const span = item.type === 'field' ? effectiveSpan(item) : 1;
    tile.className = 'chip';
    if (item.type === 'empty') tile.classList.add('is-empty-slot');
    if (span > 1) tile.classList.add('is-wide');
    tile.draggable = true;
    tile.dataset.layoutId = fieldItemId(item);
    tile.style.gridColumn = span > 1 ? `span ${span}` : '';

    const handle = document.createElement('span');
    handle.className = 'handle';
    handle.setAttribute('aria-hidden', 'true');
    handle.textContent = '⋮⋮';

    const main = document.createElement('div');
    main.className = 'chip-main';

    const top = document.createElement('div');
    top.className = 'chip-topline';

    const label = document.createElement('span');
    label.className = 'chip-label';
    label.textContent = item.type === 'empty'
      ? 'Empty cell'
      : (byKey[item.key] ? byKey[item.key].label : item.key);
    top.append(label);

    if (item.type === 'field' && byKey[item.key] && byKey[item.key].renderAs === 'markdown') {
      const tag = document.createElement('span');
      tag.className = 'chip-tag';
      tag.textContent = 'markdown';
      top.append(tag);
    }

    const meta = document.createElement('div');
    meta.className = 'chip-meta';
    const spanChip = document.createElement('span');
    spanChip.className = 'chip-span';
    spanChip.textContent = item.type === 'field' ? spanLabel(span) : 'Spacer';
    meta.append(spanChip);

    const note = document.createElement('span');
    note.className = 'chip-note';
    note.textContent = item.type === 'empty'
      ? 'Keeps one grid cell blank in the panel'
      : 'Drag to reorder';
    meta.append(note);

    main.append(top, meta);
    tile.append(handle, main);

    if (item.type === 'field') {
      const resize = document.createElement('button');
      resize.type = 'button';
      resize.className = 'resize';
      resize.draggable = false;
      resize.title = 'Drag to change width';
      resize.setAttribute('aria-label', `Drag to resize ${label.textContent}`);
      resize.textContent = '↔';
      wireSpanResize(resize, item, tile, spanChip);
      tile.append(resize);
    }

    const remove = document.createElement('button');
    remove.className = 'remove';
    remove.type = 'button';
    remove.textContent = '×';
    remove.title = item.type === 'empty'
      ? 'Remove empty cell'
      : `Remove ${label.textContent}`;
    remove.setAttribute('aria-label', remove.title);
    remove.addEventListener('click', () => {
      current.fieldLayout = current.fieldLayout.filter((entry) => fieldItemId(entry) !== fieldItemId(item));
      syncSelectedFieldsFromLayout();
      renderLayout();
      syncFieldCheckboxes();
      markDirty('fieldLayout', 'selectedFields');
      scheduleSave();
    });
    tile.append(remove);

    wireLayoutDrag(tile, item);
    return tile;
  }

  function renderLayout() {
    layoutGrid.replaceChildren();
    layoutGrid.style.setProperty('--cols', String(current.columns));
    ensureLayoutState();

    if (current.fieldLayout.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty-state';
      empty.textContent = 'No fields selected. Pick fields below or add an empty cell to start arranging the panel.';
      layoutGrid.append(empty);
    } else {
      current.fieldLayout.forEach((item) => layoutGrid.append(buildLayoutTile(item)));
    }

    const tail = document.createElement('div');
    tail.className = 'layout-tail';
    tail.textContent = draggingId
      ? 'Drop here to move the item to the bottom'
      : 'Drag items here to place them at the bottom';
    tail.addEventListener('dragover', (e) => {
      if (!draggingId) return;
      e.preventDefault();
      dropAtEnd = true;
      dropTargetId = null;
      applyDropIndicators();
      e.dataTransfer.dropEffect = 'move';
    });
    tail.addEventListener('drop', (e) => {
      if (!draggingId) return;
      e.preventDefault();
      applyDrop();
    });
    layoutGrid.append(tail);
    applyDropIndicators();
  }

  function wireLayoutDrag(tile, item) {
    tile.addEventListener('dragstart', (e) => {
      draggingId = fieldItemId(item);
      dropTargetId = fieldItemId(item);
      dropPosition = 'before';
      dropAtEnd = false;
      tile.classList.add('dragging');
      layoutGrid.classList.add('is-dragging');
      try { e.dataTransfer.setData('text/plain', draggingId); } catch { /* ignore */ }
      e.dataTransfer.effectAllowed = 'move';
      applyDropIndicators();
    });
    tile.addEventListener('dragend', () => {
      resetDragState();
    });
    tile.addEventListener('dragover', (e) => {
      if (!draggingId) return;
      if (draggingId === fieldItemId(item)) return;
      e.preventDefault();
      const rect = tile.getBoundingClientRect();
      const after = e.clientY > rect.top + rect.height * 0.55 ||
        (e.clientY >= rect.top + rect.height * 0.35 && e.clientX > rect.left + rect.width * 0.55);
      dropTargetId = fieldItemId(item);
      dropPosition = after ? 'after' : 'before';
      dropAtEnd = false;
      applyDropIndicators();
      e.dataTransfer.dropEffect = 'move';
    });
    tile.addEventListener('drop', (e) => {
      if (!draggingId || draggingId === fieldItemId(item)) return;
      e.preventDefault();
      applyDrop();
    });
  }

  function wireSpanResize(handle, item, tile, spanChip) {
    handle.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const startX = e.clientX;
      const startSpan = effectiveSpan(item);
      let nextSpan = startSpan;
      const gridRect = layoutGrid.getBoundingClientRect();
      const styles = getComputedStyle(layoutGrid);
      const gap = parseFloat(styles.columnGap || styles.gap || '0') || 0;
      const columnWidth = Math.max(1, (gridRect.width - gap * (current.columns - 1)) / Math.max(current.columns, 1));

      const onMove = (moveEvent) => {
        const deltaCols = Math.round((moveEvent.clientX - startX) / columnWidth);
        const candidate = Math.max(1, Math.min(current.columns, startSpan + deltaCols));
        if (candidate === nextSpan) return;
        nextSpan = candidate;
        tile.style.gridColumn = nextSpan > 1 ? `span ${nextSpan}` : '';
        tile.classList.toggle('is-wide', nextSpan > 1);
        spanChip.textContent = spanLabel(nextSpan);
      };

      const onUp = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        if (nextSpan === startSpan) return;
        const index = layoutIndexById(item.key);
        if (index === -1) return;
        current.fieldLayout[index].span = nextSpan;
        syncSelectedFieldsFromLayout();
        markDirty('fieldLayout', 'selectedFields');
        renderLayout();
        scheduleSave();
      };

      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    });
  }

  layoutGrid.addEventListener('dragover', (e) => {
    if (!draggingId) return;
    if (e.target === layoutGrid) {
      e.preventDefault();
      dropAtEnd = true;
      dropTargetId = null;
      applyDropIndicators();
    }
  });

  addEmptyBtn.addEventListener('click', () => {
    current.fieldLayout.push(createEmptyItem());
    syncSelectedFieldsFromLayout();
    renderLayout();
    markDirty('fieldLayout', 'selectedFields');
    scheduleSave();
  });

  /* ----- Field checklist (grouped) ----- */

  function buildFieldToggleRow(field, opts = {}) {
    const id = `field-${field.key}`;
    const row = document.createElement('label');
    row.className = opts.detailed ? 'row row-setting' : 'row';
    row.htmlFor = id;
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.id = id;
    cb.dataset.key = field.key;
    cb.checked = current.selectedFields.includes(field.key);
    cb.addEventListener('change', () => onFieldToggle(field.key, cb.checked));

    if (opts.detailed) {
      const body = document.createElement('span');
      body.className = 'row-body';
      const title = document.createElement('span');
      title.className = 'row-title';
      title.textContent = field.label + (field.renderAs === 'markdown' ? '  ·  markdown' : '');
      const help = document.createElement('span');
      help.className = 'row-help';
      const parts = [`Field name: ${field.serviceNowName || field.key}`];
      if (field.matchedRegistryKey) parts.push(`Matches existing key: ${field.matchedRegistryKey}`);
      parts.push(`Add under "${field.group || 'Other'}" in src/content/field-registry.js`);
      help.textContent = parts.join(' · ');
      body.append(title, help);
      row.append(cb, body);
      return row;
    }

    const label = document.createElement('span');
    label.textContent = field.label + (field.renderAs === 'markdown' ? '  ·  markdown' : '');
    row.append(cb, label);
    return row;
  }

  function renderDetectedFields() {
    detectedFieldsHost.replaceChildren();
    const newFields = discoveredFields.filter((field) => field && isDetectedKey(field.key));
    if (!newFields.length) {
      detectedFieldsCard.hidden = true;
      return;
    }

    detectedFieldsCard.hidden = false;
    const groups = new Map();
    const sortedFields = newFields.slice().sort((a, b) => (
      String(a.group || 'Other').localeCompare(String(b.group || 'Other')) ||
      String(a.label || '').localeCompare(String(b.label || '')) ||
      String(a.serviceNowName || '').localeCompare(String(b.serviceNowName || ''))
    ));
    for (const field of sortedFields) {
      const group = field.group || 'Other';
      if (!groups.has(group)) groups.set(group, []);
      groups.get(group).push(field);
    }
    for (const [groupName, fields] of groups) {
      const section = document.createElement('div');
      section.className = 'group';
      const heading = document.createElement('div');
      heading.className = 'group-title';
      heading.textContent = groupName;
      section.append(heading);
      const list = document.createElement('div');
      fields.forEach((field) => list.append(buildFieldToggleRow(field, { detailed: true })));
      section.append(list);
      detectedFieldsHost.append(section);
    }
  }

  function renderFields() {
    fieldsHost.replaceChildren();
    const groups = new Map();
    for (const f of fieldRegistry.FIELDS) {
      if (!staticByKey[f.key]) continue;
      const g = f.group || 'Other';
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(f);
    }
    for (const entry of groups) {
      const groupName = entry[0];
      const items = entry[1];
      const section = document.createElement('div');
      section.className = 'group';
      const heading = document.createElement('div');
      heading.className = 'group-title';
      heading.textContent = groupName;
      section.append(heading);
      const grid = document.createElement('div');
      grid.className = 'fields';
      items.forEach((field) => grid.append(buildFieldToggleRow(field)));
      section.append(grid);
      fieldsHost.append(section);
    }
  }

  function syncFieldCheckboxes() {
    const set = new Set(current.selectedFields);
    document.querySelectorAll('#fields input[type="checkbox"], #detectedFields input[type="checkbox"]').forEach((cb) => {
      cb.checked = set.has(cb.dataset.key);
    });
  }

  function onFieldToggle(key, checked) {
    if (checked) {
      if (!current.selectedFields.includes(key)) current.fieldLayout.push(createFieldItem(key));
    } else {
      current.fieldLayout = current.fieldLayout.filter((item) => !(item.type === 'field' && item.key === key));
    }
    syncSelectedFieldsFromLayout();
    renderLayout();
    markDirty('fieldLayout', 'selectedFields');
    scheduleSave();
  }

  /* ----- Columns segment ----- */

  function renderColumnsSegment() {
    columnsSegment.querySelectorAll('button').forEach((b) => {
      b.classList.toggle('active', Number(b.dataset.cols) === current.columns);
      b.setAttribute('aria-pressed', String(Number(b.dataset.cols) === current.columns));
    });
  }

  columnsSegment.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-cols]');
    if (!btn) return;
    const cols = Number(btn.dataset.cols);
    if (cols !== 2 && cols !== 3 && cols !== 4) return;
    const prev = current.columns;
    current.columns = cols;
    current.fieldLayout = current.fieldLayout.map((item) => {
      if (item.type !== 'field') return item;
      if (item.span === prev) return { ...item, span: cols };
      return item;
    });
    renderColumnsSegment();
    renderLayout();
    markDirty('columns', 'fieldLayout', 'selectedFields');
    scheduleSave();
  });

  /* ----- General toggles ----- */

  function bindToggle(cb, field) {
    cb.addEventListener('change', () => {
      current[field] = cb.checked;
      markDirty(field);
      scheduleSave();
    });
  }
  function bindInvertedToggle(cb, field) {
    cb.addEventListener('change', () => {
      current[field] = !cb.checked;
      markDirty(field);
      scheduleSave();
    });
  }
  bindToggle(enabledCb, 'enabled');
  bindInvertedToggle(expandedCb, 'defaultCollapsed');
  bindToggle(autoExpandCb, 'autoExpandSections');
  bindToggle(panelFullHeightCb, 'panelFullHeight');
  bindToggle(descriptionAutoHeightCb, 'descriptionAutoHeight');
  bindToggle(enhanceOriginalDescriptionCb, 'enhanceOriginalDescription');
  bindToggle(largeOriginalDescriptionCb, 'largeOriginalDescription');
  descriptionCopyFormatSelect.addEventListener('change', () => {
    current.descriptionCopyFormat = descriptionCopyFormatSelect.value;
    markDirty('descriptionCopyFormat');
    scheduleSave();
  });
  bindToggle(debugCb, 'debug');

  /* ----- Bulk actions ----- */

  selectAllBtn.addEventListener('click', () => {
    const existing = new Set(current.selectedFields);
    for (const f of STATIC_FIELDS) {
      if (existing.has(f.key)) continue;
      current.fieldLayout.push(createFieldItem(f.key));
    }
    syncSelectedFieldsFromLayout();
    renderLayout();
    syncFieldCheckboxes();
    markDirty('fieldLayout', 'selectedFields');
    scheduleSave();
  });

  selectNoneBtn.addEventListener('click', () => {
    current.fieldLayout = [];
    syncSelectedFieldsFromLayout();
    renderLayout();
    syncFieldCheckboxes();
    markDirty('fieldLayout', 'selectedFields');
    scheduleSave();
  });

  resetBtn.addEventListener('click', () => {
    const defaults = storage.DEFAULTS;
    current.fieldLayout = cloneValue(defaults.fieldLayout);
    current.enabled = defaults.enabled;
    current.defaultCollapsed = defaults.defaultCollapsed;
    current.autoExpandSections = defaults.autoExpandSections;
    current.panelFullHeight = defaults.panelFullHeight;
    current.descriptionAutoHeight = defaults.descriptionAutoHeight;
    current.enhanceOriginalDescription = defaults.enhanceOriginalDescription;
    current.largeOriginalDescription = defaults.largeOriginalDescription;
    current.descriptionCopyFormat = defaults.descriptionCopyFormat;
    current.panelHeightPercent = defaults.panelHeightPercent;
    current.debug = defaults.debug;
    current.columns = defaults.columns;
    syncSelectedFieldsFromLayout();
    applyCurrentToControls();
    markDirty(
      'fieldLayout',
      'selectedFields',
      'enabled',
      'defaultCollapsed',
      'autoExpandSections',
      'panelFullHeight',
      'descriptionAutoHeight',
      'enhanceOriginalDescription',
      'largeOriginalDescription',
      'descriptionCopyFormat',
      'panelHeightPercent',
      'debug',
      'columns'
    );
    scheduleSave();
  });

  function applyCurrentToControls() {
    ensureLayoutState();
    enabledCb.checked = current.enabled;
    expandedCb.checked = !current.defaultCollapsed;
    autoExpandCb.checked = current.autoExpandSections !== false;
    panelFullHeightCb.checked = !!current.panelFullHeight;
    descriptionAutoHeightCb.checked = !!current.descriptionAutoHeight;
    enhanceOriginalDescriptionCb.checked = !!current.enhanceOriginalDescription;
    largeOriginalDescriptionCb.checked = !!current.largeOriginalDescription;
    descriptionCopyFormatSelect.value =
      current.descriptionCopyFormat === 'rich' ? 'rich' : 'markdown';
    debugCb.checked = current.debug;
    renderColumnsSegment();
    renderLayout();
    renderDetectedFields();
    renderFields();
  }

  /* ----- External changes (another tab saving) ----- */

  storage.onChange((next) => {
    if (!current) return;
    if (dirtyKeys.size > 0) {
      for (const key of dirtyKeys) next[key] = cloneValue(current[key]);
    }
    current = next;
    applyDiscoveredFields(discoveredFields);
    applyCurrentToControls();
  });

  discoveryStore.onChange((nextFields) => {
    if (!current) return;
    applyDiscoveredFields(nextFields);
    applyCurrentToControls();
  });

  /* ----- Boot ----- */

  Promise.all([storage.get(), discoveryStore.get()]).then(async ([nextSettings, nextFields]) => {
    current = nextSettings;
    applyDiscoveredFields(nextFields);
    const migrationPatch = detectedFieldMigrationPatch();
    if (migrationPatch) {
      current = await storage.set(migrationPatch);
      applyDiscoveredFields(discoveredFields);
    }
    applyCurrentToControls();
  });
})();
