(function (root) {
  'use strict';
  const NS = (root.SNCRM = root.SNCRM || {});
  const log = NS.log && NS.log.make ? NS.log.make('clipboard') : { error() {} };

  function copyTextareaFallback(doc, text) {
    const textarea = doc.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.top = '-10000px';
    doc.body.appendChild(textarea);
    textarea.select();
    let ok = false;
    try {
      ok = doc.execCommand('copy');
    } catch (e) {
      log.error('execCommand copy failed', e);
    }
    textarea.remove();
    return ok;
  }

  function writePlain(doc, text) {
    const nav = doc.defaultView && doc.defaultView.navigator;
    if (nav && nav.clipboard && typeof nav.clipboard.writeText === 'function') {
      return nav.clipboard.writeText(text).then(
        () => true,
        () => copyTextareaFallback(doc, text)
      );
    }
    return Promise.resolve(copyTextareaFallback(doc, text));
  }

  function writeRich(doc, text, html) {
    const nav = doc.defaultView && doc.defaultView.navigator;
    const ClipboardItem = doc.defaultView && doc.defaultView.ClipboardItem;
    if (
      nav &&
      nav.clipboard &&
      typeof nav.clipboard.write === 'function' &&
      typeof ClipboardItem === 'function'
    ) {
      const item = new ClipboardItem({
        'text/plain': new Blob([text], { type: 'text/plain' }),
        'text/html': new Blob([html], { type: 'text/html' })
      });
      return nav.clipboard.write([item]).then(
        () => true,
        () => writePlain(doc, text)
      );
    }
    return writePlain(doc, text);
  }

  /* Copy a description to the clipboard. `format` is the value of the
   * `descriptionCopyFormat` setting ('markdown' | 'rich'). `renderHtml` is
   * only invoked for 'rich'. Resolves to true when the copy succeeded. */
  function copyDescription(text, format, renderHtml) {
    const doc = (typeof document !== 'undefined' && document) || null;
    if (!doc || text == null) return Promise.resolve(false);
    if (format === 'rich') {
      let html = '';
      try {
        html = typeof renderHtml === 'function' ? renderHtml(String(text)) : String(text);
      } catch (e) {
        log.error('rich render failed, falling back to plain text', e);
      }
      return writeRich(doc, String(text), html);
    }
    return writePlain(doc, String(text));
  }

  NS.clipboard = { copyDescription };
})(typeof self !== 'undefined' ? self : globalThis);
