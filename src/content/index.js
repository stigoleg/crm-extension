/* Content script entrypoint. Kicks off the controller once all sibling
 * scripts are loaded. The manifest lists files in order so NS.* is fully
 * populated by the time this file runs.
 *
 * The service worker can re-inject the whole bundle via chrome.scripting as a
 * fallback (raced against the manifest's document_idle injection), so guard
 * boot with a world-shared flag. Both injections share the same isolated
 * world, so the second start sees this and no-ops — one controller, one of
 * every piece of UI. */
(function () {
  'use strict';
  if (self.__sncrmBooted === true) return;
  self.__sncrmBooted = true;
  try {
    self.SNCRM.controller.init();
  } catch (e) {
    console.error('[sncrm:boot] init failed', e);
  }
})();
