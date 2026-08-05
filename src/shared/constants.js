/* Shared constants. Attached to globalThis.SNCRM for cross-script access.
 * Loaded first in the content script list. Also imported via importScripts() in the
 * service worker and via <script> tags in popup/options. */
(function (root) {
  'use strict';
  const NS = (root.SNCRM = root.SNCRM || {});

  NS.constants = Object.freeze({
    /* Path-based gate. ServiceNow CRM instances live at different hosts
     * (alfred.service-now.com, thehub.soprasteria.com, customer-instance, …)
     * but the UX Framework route is identical on every instance. The manifest
     * uses `https://*\/x/ssasi/crm/record/x_ssasi_crm_opportunity/*` and the
     * runtime rule below enforces the exact path prefix. */
    SUPPORTED_PATH_PREFIX: '/x/ssasi/crm/record/x_ssasi_crm_opportunity/',
    SUPPORTED_SCHEMES: ['https:'],
    PANEL_ID: 'sncrm-overview-panel',
    STYLE_ID: 'sncrm-overview-styles',
    STORAGE_KEY: 'sncrm.settings.v1',
    DISCOVERY_STORAGE_KEY: 'sncrm.discovery.v1',
    SETTINGS_VERSION: 1,
    MOUNT_DEBOUNCE_MS: 150,
    REFRESH_DEBOUNCE_MS: 400,
    HYDRATION_TIMEOUT_MS: 30000,
    HYDRATION_POLL_MS: 500,
    HYDRATION_BACKOFF_MS: 5000,
    NAV_POLL_MS: 500,
    MSG: {
      GET_STATUS: 'sncrm/get-status',
      STATUS_CHANGED: 'sncrm/status-changed',
      REFRESH: 'sncrm/refresh',
      OPEN_OPTIONS: 'sncrm/open-options'
    }
  });
})(typeof self !== 'undefined' ? self : globalThis);
