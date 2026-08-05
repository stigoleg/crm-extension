(function (root) {
  'use strict';
  const NS = (root.SNCRM = root.SNCRM || {});

  // Debug state is populated by storage layer on load. Default off.
  let debugEnabled = false;
  function setDebug(v) { debugEnabled = Boolean(v); }

  function make(area) {
    const tag = `[sncrm:${area}]`;
    return {
      debug: (...a) => { if (debugEnabled) console.debug(tag, ...a); },
      info:  (...a) => { if (debugEnabled) console.info(tag, ...a); },
      warn:  (...a) => console.warn(tag, ...a),
      error: (...a) => console.error(tag, ...a)
    };
  }

  NS.log = { make, setDebug, get debugEnabled() { return debugEnabled; } };
})(typeof self !== 'undefined' ? self : globalThis);
