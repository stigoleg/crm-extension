(function (root) {
  'use strict';
  const NS = (root.SNCRM = root.SNCRM || {});
  const log = NS.log.make('nav');
  const { NAV_POLL_MS } = NS.constants;
  const NAV_POLL_WINDOW_MS = Math.max(NAV_POLL_MS * 4, 2000);
  const HISTORY_PATCH_MARKER = Symbol('sncrm.navigation.historyPatch');

  /* Watch for URL changes in a SPA.
   *  - Prefer the Navigation API when available.
   *  - Patch pushState/replaceState, which the SN router uses.
   *  - Listen for popstate/hashchange for back/forward and fragment hops.
   *  - Poll only in a short fallback window after an explicit navigation
   *    signal so we catch delayed URL commits without a permanent timer.
   *
   * Patching history on window is safe: we call the originals before firing
   * the listener so we do not change navigation semantics for the page. */
  function start(onChange) {
    let lastUrl = location.href;
    let pollInterval = null;
    let pollWindowTimer = null;

    const emit = (source, nextUrl = location.href) => {
      const now = String(nextUrl || location.href);
      if (now !== lastUrl) {
        const prev = lastUrl;
        lastUrl = now;
        log.debug(`url change via ${source}`, { prev, now });
        try { onChange(now, prev); } catch (e) { log.error('onChange threw', e); }
      }
    };
    const stopPollWindow = () => {
      if (pollInterval != null) {
        clearInterval(pollInterval);
        pollInterval = null;
      }
      if (pollWindowTimer != null) {
        clearTimeout(pollWindowTimer);
        pollWindowTimer = null;
      }
    };
    const armPollWindow = () => {
      if (pollInterval == null) {
        pollInterval = setInterval(() => emit('poll'), NAV_POLL_MS);
      }
      if (pollWindowTimer != null) clearTimeout(pollWindowTimer);
      pollWindowTimer = setTimeout(stopPollWindow, NAV_POLL_WINDOW_MS);
    };
    const emitAndArmPoll = (source, nextUrl) => {
      emit(source, nextUrl);
      armPollWindow();
    };

    const origPush = history.pushState;
    const origReplace = history.replaceState;
    const patchedPush = function patchedPush() {
      const r = origPush.apply(this, arguments);
      emitAndArmPoll('pushState');
      return r;
    };
    patchedPush[HISTORY_PATCH_MARKER] = true;
    history.pushState = patchedPush;
    const patchedReplace = function patchedReplace() {
      const r = origReplace.apply(this, arguments);
      emitAndArmPoll('replaceState');
      return r;
    };
    patchedReplace[HISTORY_PATCH_MARKER] = true;
    history.replaceState = patchedReplace;

    const onNavigate = () => {
      armPollWindow();
      setTimeout(() => emit('navigate'), 0);
    };
    const onPop = () => emitAndArmPoll('popstate');
    const onHashChange = () => emitAndArmPoll('hashchange');
    window.addEventListener('popstate', onPop);
    window.addEventListener('hashchange', onHashChange);
    if (window.navigation && typeof window.navigation.addEventListener === 'function') {
      window.navigation.addEventListener('navigate', onNavigate);
    }

    return function stop() {
      stopPollWindow();
      window.removeEventListener('popstate', onPop);
      window.removeEventListener('hashchange', onHashChange);
      if (window.navigation && typeof window.navigation.removeEventListener === 'function') {
        window.navigation.removeEventListener('navigate', onNavigate);
      }
      // Only restore if our wrapper is still the active one. A newer content
      // script instance (or another extension) may have patched history after
      // we started, and stop() must not clobber that newer wrapper.
      if (history.pushState === patchedPush && history.pushState[HISTORY_PATCH_MARKER]) {
        history.pushState = origPush;
      }
      if (history.replaceState === patchedReplace && history.replaceState[HISTORY_PATCH_MARKER]) {
        history.replaceState = origReplace;
      }
    };
  }

  NS.navigation = { start };
})(typeof self !== 'undefined' ? self : globalThis);
