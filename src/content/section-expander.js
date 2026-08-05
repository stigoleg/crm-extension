(function (root) {
  'use strict';
  const NS = (root.SNCRM = root.SNCRM || {});
  const log = NS.log.make('expand');

  /* Form sections on the opportunity page are collapsible accordions.
   * ServiceNow renders them with:
   *   <span class="sn-section-header collapsable" aria-expanded="true|false">
   * When collapsed, their fields are either hidden or not in the DOM, so the
   * extension cannot surface values. We click any collapsed header to open
   * it. The controller decides when to call this so we do not keep re-clicking
   * the same headers on every observer-driven rerender. */
  function expandAll(scopeEl) {
    const rootEl = scopeEl && scopeEl.querySelectorAll ? scopeEl : document;
    const isVisible = NS.extractors && typeof NS.extractors.isVisible === 'function'
      ? NS.extractors.isVisible
      : () => true;
    const headers = Array.from(rootEl.querySelectorAll(
      'span.sn-section-header.collapsable[aria-expanded="false"]'
    )).filter(isVisible);
    if (headers.length === 0) return 0;
    for (const h of headers) {
      try { h.click(); } catch (e) { log.debug('click threw', e); }
    }
    log.debug(`expanded ${headers.length} section(s)`);
    return headers.length;
  }

  NS.sectionExpander = { expandAll };
})(typeof self !== 'undefined' ? self : globalThis);
