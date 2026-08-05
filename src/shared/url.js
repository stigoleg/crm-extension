(function (root) {
  'use strict';
  const NS = (root.SNCRM = root.SNCRM || {});
  const { SUPPORTED_PATH_PREFIX, SUPPORTED_SCHEMES } = NS.constants;

  /* Authoritative runtime gate. Host-agnostic because ServiceNow CRM is
   * hosted under different instance domains per customer. The stable part is
   * the path (the UX Framework route for the opportunity table). */
  function parse(url) {
    if (typeof url !== 'string' || !url) return null;
    try { return new URL(url); } catch { return null; }
  }

  function isSupportedUrl(url) {
    const u = parse(url);
    if (!u) return false;
    if (!SUPPORTED_SCHEMES.includes(u.protocol)) return false;
    return u.pathname.startsWith(SUPPORTED_PATH_PREFIX);
  }

  /* The path segment after the table prefix is the opportunity sysId. We
   * use it to detect record-to-record navigation inside the same tab. */
  function extractRecordId(url) {
    const u = parse(url);
    if (!u || !u.pathname.startsWith(SUPPORTED_PATH_PREFIX)) return null;
    const tail = u.pathname.slice(SUPPORTED_PATH_PREFIX.length);
    const seg = tail.split('/', 1)[0];
    return seg || null;
  }

  NS.url = { isSupportedUrl, extractRecordId };
})(typeof self !== 'undefined' ? self : globalThis);
