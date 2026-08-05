(function (root) {
  'use strict';
  const NS = (root.SNCRM = root.SNCRM || {});

  /* Parse common ServiceNow date formats. Handles:
   *   - DD.MM.YYYY            (e.g. 30.04.2026)
   *   - DD.MM.YYYY HH:MM[:SS] (e.g. 16.04.2026 14:00:00)
   *   - DD/MM/YYYY            (locale variant)
   *   - YYYY-MM-DD[ HH:MM:SS] (ISO-ish)
   * Returns a Date in local time, or null if unparseable. */
  function parseSnDate(value) {
    if (!value || typeof value !== 'string') return null;
    const s = value.trim();

    // DD.MM.YYYY [HH:MM[:SS]] or DD/MM/YYYY [HH:MM[:SS]]
    let m = /^(\d{1,2})[./-](\d{1,2})[./-](\d{4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(s);
    if (m) {
      const [, d, mo, y, hh, mm, ss] = m;
      const date = new Date(
        Number(y), Number(mo) - 1, Number(d),
        Number(hh || 0), Number(mm || 0), Number(ss || 0)
      );
      return isNaN(date.getTime()) ? null : date;
    }

    // YYYY-MM-DD [HH:MM:SS]
    m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(s);
    if (m) {
      const [, y, mo, d, hh, mm, ss] = m;
      const date = new Date(
        Number(y), Number(mo) - 1, Number(d),
        Number(hh || 0), Number(mm || 0), Number(ss || 0)
      );
      return isNaN(date.getTime()) ? null : date;
    }
    return null;
  }

  /* Whole-day diff ignoring time-of-day. Negative = past. */
  function daysUntil(target, from) {
    if (!(target instanceof Date)) return null;
    const base = from instanceof Date ? from : new Date();
    const a = new Date(base.getFullYear(), base.getMonth(), base.getDate());
    const b = new Date(target.getFullYear(), target.getMonth(), target.getDate());
    return Math.round((b.getTime() - a.getTime()) / 86400000);
  }

  /* Color band per product requirements.
   *   overdue / <= 3 days  → red
   *   4 – 9 days           → orange
   *   >= 10 days           → green
   * Returns one of 'red' | 'orange' | 'green'. */
  function countdownTone(days) {
    if (days == null) return 'neutral';
    if (days <= 3) return 'red';
    if (days <= 9) return 'orange';
    return 'green';
  }

  function countdownLabel(days) {
    if (days == null) return '';
    if (days < 0) {
      const n = Math.abs(days);
      return n === 1 ? 'overdue 1 day' : `overdue ${n} days`;
    }
    if (days === 0) return 'today';
    if (days === 1) return 'tomorrow';
    return `in ${days} days`;
  }

  NS.dates = { parseSnDate, daysUntil, countdownTone, countdownLabel };
})(typeof self !== 'undefined' ? self : globalThis);
