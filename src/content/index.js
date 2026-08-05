/* Content script entrypoint. Kicks off the controller once all sibling
 * scripts are loaded. The manifest lists files in order so NS.* is fully
 * populated by the time this file runs. */
(function () {
  'use strict';
  try {
    self.SNCRM.controller.init();
  } catch (e) {
    console.error('[sncrm:boot] init failed', e);
  }
})();
