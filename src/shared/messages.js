(function (root) {
  'use strict';
  const NS = (root.SNCRM = root.SNCRM || {});
  const { MSG } = NS.constants;

  function send(message) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(message, (response) => {
          const err = chrome.runtime.lastError;
          if (err) return resolve({ ok: false, error: err.message });
          resolve(response || { ok: true });
        });
      } catch (e) {
        resolve({ ok: false, error: String(e && e.message || e) });
      }
    });
  }

  function sendToTab(tabId, message) {
    return new Promise((resolve) => {
      try {
        chrome.tabs.sendMessage(tabId, message, (response) => {
          const err = chrome.runtime.lastError;
          if (err) return resolve({ ok: false, error: err.message });
          resolve(response || { ok: true });
        });
      } catch (e) {
        resolve({ ok: false, error: String(e && e.message || e) });
      }
    });
  }

  NS.messages = { send, sendToTab, MSG };
})(typeof self !== 'undefined' ? self : globalThis);
