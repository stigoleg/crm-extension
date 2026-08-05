(function (root) {
  'use strict';
  const NS = (root.SNCRM = root.SNCRM || {});

  /* Minimal, dependency-free Markdown-to-HTML renderer.
   *
   * Security model: ALL input is HTML-escaped up front, so raw HTML in the
   * source becomes visible text (never executed). Formatting is then applied
   * by replacing specific, already-escaped markdown syntax with safe HTML
   * tags. Link hrefs are sanitized to http(s), mailto, or same-origin
   * root-relative paths such as `/nav_to.do?...`, which keeps typical
   * ServiceNow CRM cross-record links working without allowing scriptable or
   * protocol-relative targets.
   *
   * Supported:
   *   - headings (# .. ######)
   *   - bold **x** __x__, italic *x* _x_, inline code `x`
   *   - strikethrough ~~x~~
   *   - fenced code blocks ```...```
   *   - blockquotes (>)
   *   - unordered lists (-, *, +) and ordered lists (1.)
   *   - links [text](url) and bare URLs (http/https/mailto)
   *   - root-relative links [text](/path) for same-origin ServiceNow routes
   *   - paragraphs and hard line breaks (two trailing spaces or \n\n)
   *   - horizontal rules (--- / ***)
   */

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function safeHref(raw) {
    const href = String(raw || '').trim();
    if (/^(https?:|mailto:)/i.test(href)) return href;
    if (/^\/(?!\/)/.test(href)) return href;
    return '#';
  }

  function renderInline(s) {
    // Inline code first so its contents are protected from further rewriting.
    const codeSlots = [];
    s = s.replace(/`([^`]+)`/g, (_, c) => {
      codeSlots.push(`<code>${c}</code>`);
      return `\u0000CODE${codeSlots.length - 1}\u0000`;
    });

    // Links: [text](url)
    s = s.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_, text, url) => {
      return `<a href="${escapeHtml(safeHref(url))}" target="_blank" rel="noopener noreferrer">${text}</a>`;
    });

    // Autolinks (bare URLs)
    s = s.replace(/(^|\s)(https?:\/\/[^\s<]+)/g, (_, pre, url) => {
      return `${pre}<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${url}</a>`;
    });

    // Bold, italic, strikethrough. Order matters: handle strong (**) before em (*).
    s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/__([^_\n]+)__/g, '<strong>$1</strong>');
    s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
    s = s.replace(/(^|[^_\w])_([^_\n]+)_/g, '$1<em>$2</em>');
    s = s.replace(/~~([^~\n]+)~~/g, '<del>$1</del>');

    // Preserve every newline inside a paragraph as a hard break. ServiceNow
     // text fields are free-form — users write one thought per line and
     // expect those lines to stay distinct.
    s = s.replace(/\n/g, '<br>\n');

    // Restore inline code placeholders.
    s = s.replace(/\u0000CODE(\d+)\u0000/g, (_, i) => codeSlots[Number(i)]);
    return s;
  }

  /* Collect list items starting at `start`. `markerRe` matches the current
   * list's item marker; `otherListRe` matches the other list type (so we
   * stop at mixed-list boundaries).
   *
   * Continuation rules (ServiceNow-pragmatic, CommonMark-ish):
   *   - Non-blank, non-marker lines fold into the current item (tight
   *     continuation).
   *   - Blank line(s) are tolerated only if the next non-blank line is ANOTHER
   *     marker of this list (loose list) or an indented continuation.
   *     Otherwise the blank line closes the list — the next line becomes a
   *     sibling paragraph in the document.
   *   - Hard boundaries (fence/heading/HR/blockquote/other-list) always end.
   *
   * Examples:
   *   "1. a\n\n1. b\n\n1. c"       → one <ol> with three <li> (blanks between
   *                                  markers, common in pasted SN text).
   *   "- a\n\nLorem ipsum"         → <ul><li>a</li></ul> then <p>Lorem…</p>.
   *   "- a\n  continuation\n- b"   → two items, first with folded continuation.
   *
   * Returns { items: string[][], next: number }. */
  function collectListItems(lines, start, markerRe, otherListRe) {
    const items = [];
    let current = [lines[start].replace(markerRe, '')];
    let i = start + 1;
    const isHardBoundary = (ln) => (
      /^```/.test(ln) ||
      /^#{1,6}\s+/.test(ln) ||
      /^(\s*)(---+|\*\*\*+|___+)\s*$/.test(ln) ||
      /^\s*&gt;\s?/.test(ln) ||
      (otherListRe && otherListRe.test(ln))
    );
    while (i < lines.length) {
      const ln = lines[i];
      if (markerRe.test(ln)) {
        items.push(current);
        current = [ln.replace(markerRe, '')];
        i++;
        continue;
      }
      if (isHardBoundary(ln)) break;
      if (/^\s*$/.test(ln)) {
        // Peek past contiguous blank lines. The next non-blank line decides:
        //   - marker of this list → loose-list continuation, keep folding.
        //   - indented text       → item body continues across a blank.
        //   - anything else       → the list is done.
        let j = i;
        while (j < lines.length && /^\s*$/.test(lines[j])) j++;
        if (j >= lines.length) { i = j; break; }
        const nextLine = lines[j];
        if (isHardBoundary(nextLine)) break;
        if (markerRe.test(nextLine) || /^\s{2,}/.test(nextLine)) {
          // Keep the blank (so the renderer wraps paras in <p> when loose).
          current.push(ln);
          i++;
          continue;
        }
        break;
      }
      // Non-blank, non-marker, non-boundary → fold into current item.
      current.push(ln);
      i++;
    }
    // Strip trailing blank lines from the final item so we don't render an
    // empty <p> when the input ends with whitespace.
    while (current.length && /^\s*$/.test(current[current.length - 1])) current.pop();
    items.push(current);
    return { items, next: i };
  }

  function renderListItem(bodyLines) {
    // Trim surrounding blank lines.
    while (bodyLines.length && /^\s*$/.test(bodyLines[0])) bodyLines.shift();
    while (bodyLines.length && /^\s*$/.test(bodyLines[bodyLines.length - 1])) bodyLines.pop();
    if (bodyLines.length === 0) return '<li></li>';
    // Split on blank lines into paragraphs.
    const paras = [];
    let cur = [];
    for (const ln of bodyLines) {
      if (/^\s*$/.test(ln)) {
        if (cur.length) { paras.push(cur); cur = []; }
      } else {
        cur.push(ln);
      }
    }
    if (cur.length) paras.push(cur);
    if (paras.length <= 1) {
      return `<li>${renderInline(paras[0].join('\n'))}</li>`;
    }
    return `<li>${paras.map((p) => `<p>${renderInline(p.join('\n'))}</p>`).join('')}</li>`;
  }

  function render(markdown) {
    if (markdown == null) return '';
    const escaped = escapeHtml(String(markdown));
    const lines = escaped.split(/\r?\n/);

    const out = [];
    let i = 0;
    let inPara = [];

    const flushPara = () => {
      if (inPara.length === 0) return;
      const joined = inPara.join('\n');
      out.push(`<p>${renderInline(joined)}</p>`);
      inPara = [];
    };

    while (i < lines.length) {
      const line = lines[i];

      // Fenced code block
      const fence = /^```(\w*)\s*$/.exec(line);
      if (fence) {
        flushPara();
        const lang = fence[1];
        const body = [];
        i++;
        while (i < lines.length && !/^```\s*$/.test(lines[i])) {
          body.push(lines[i]);
          i++;
        }
        i++; // closing fence
        const langAttr = lang ? ` class="lang-${escapeHtml(lang)}"` : '';
        out.push(`<pre><code${langAttr}>${body.join('\n')}</code></pre>`);
        continue;
      }

      // Horizontal rule
      if (/^(\s*)(---+|\*\*\*+|___+)\s*$/.test(line)) {
        flushPara();
        out.push('<hr>');
        i++;
        continue;
      }

      // ATX heading
      const h = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
      if (h) {
        flushPara();
        const level = h[1].length;
        out.push(`<h${level}>${renderInline(h[2])}</h${level}>`);
        i++;
        continue;
      }

      // Blockquote
      if (/^\s*&gt;\s?/.test(line)) {
        flushPara();
        const body = [];
        while (i < lines.length && /^\s*&gt;\s?/.test(lines[i])) {
          body.push(lines[i].replace(/^\s*&gt;\s?/, ''));
          i++;
        }
        // renderInline already converts embedded \n to <br>, so no extra
        // newline substitution is needed here.
        out.push(`<blockquote>${renderInline(body.join('\n'))}</blockquote>`);
        continue;
      }

      // Unordered list. Accepts standard markdown markers (-, *, +) and the
      // common Unicode bullets ServiceNow users paste into free-text fields
      // (•, ◦, ‣, ·, –, —).
      const UL_RE = /^\s*(?:[-*+]|[\u2022\u25E6\u2023\u00B7\u2013\u2014])\s+/;
      const OL_RE = /^\s*\d+\.\s+/;
      if (UL_RE.test(line)) {
        flushPara();
        const collected = collectListItems(lines, i, UL_RE, OL_RE);
        i = collected.next;
        out.push(`<ul>${collected.items.map(renderListItem).join('')}</ul>`);
        continue;
      }

      // Ordered list. Items may span multiple paragraphs separated by blank
      // lines — the list only ends at a hard block boundary (fence, heading,
      // hr, blockquote, UL) or EOF. This matches CommonMark "loose list"
      // semantics closely enough for ServiceNow's free-text fields, where
      // users routinely press Enter twice between numbered bullets.
      if (OL_RE.test(line)) {
        flushPara();
        const collected = collectListItems(lines, i, OL_RE, UL_RE);
        i = collected.next;
        out.push(`<ol>${collected.items.map(renderListItem).join('')}</ol>`);
        continue;
      }

      // Blank line → paragraph break
      if (/^\s*$/.test(line)) {
        flushPara();
        i++;
        continue;
      }

      // Default: accumulate into paragraph
      inPara.push(line);
      i++;
    }
    flushPara();

    return out.join('\n');
  }

  NS.markdown = { render, escapeHtml, safeHref };
})(typeof self !== 'undefined' ? self : globalThis);
