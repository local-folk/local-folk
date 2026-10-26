/*
 * post-header.js
 *
 * Builds the roundup header line:
 *
 *   // 12-16 OCT // WEEKLY ROUNDUP
 *
 * Shared between build-captions.js and generate-social-images.js because the
 * caption and the image must say exactly the same thing. When the caption was
 * built here and the subtitle there, they were two implementations of one rule
 * and would have drifted.
 *
 * The span is the roundup's fixed window - every day it covers - rather than
 * the days that happen to have an event. A quiet Thursday must not shorten
 * "26-30 OCT" to "26-28 OCT": the header promises the week, and the list below
 * is what it has to say about it.
 *
 * Older posts have no window recorded. Their candidatesByDay still records the
 * days selection looked at (including empty ones), so that is the fallback;
 * only a post with neither falls back to the days it actually lists.
 */

'use strict';

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN',
                'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

/* Day headings look like "MONDAY - 12/10". Pull the dd and mm out of that. */
function dayDate(dayHeading) {
  const m = /(\d{2})\/(\d{2})\s*$/.exec(String(dayHeading || ''));
  if (!m) return null;
  return { dd: Number(m[1]), mm: Number(m[2]) };
}

/* A window date is ISO "2026-10-26". The year is kept so a window that crosses
 * New Year still sorts December before January. */
function isoDate(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ''));
  if (!m) return null;
  return { yyyy: Number(m[1]), mm: Number(m[2]), dd: Number(m[3]) };
}

/* "12-16 OCT", or "29 SEP - 02 OCT" across a month boundary. */
function formatSpan(dates) {
  if (!dates.length) return '';

  // Numeric sort, so 09/10 comes before 12/10 rather than after it.
  const sorted = dates.slice().sort((a, b) =>
    ((a.yyyy || 0) - (b.yyyy || 0)) || (a.mm - b.mm) || (a.dd - b.dd));
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  const pad = (n) => (n < 10 ? '0' + n : String(n));

  if (first.mm === last.mm && first.yyyy === last.yyyy) {
    return pad(first.dd) + '-' + pad(last.dd) + ' ' + MONTHS[first.mm - 1];
  }
  return pad(first.dd) + ' ' + MONTHS[first.mm - 1] +
         ' - ' + pad(last.dd) + ' ' + MONTHS[last.mm - 1];
}

/* The span read from the days that actually list an event. This was the old
 * rule and is now only the last fallback. */
function dateSpan(rows) {
  const dates = [];
  for (const row of rows || []) {
    const d = dayDate(row && row.day);
    if (d) dates.push(d);
  }
  return formatSpan(dates);
}

/* The roundup's window, in preference order:
 *
 *   1. post.window          - recorded by select-social-events.js
 *   2. post.candidatesByDay - the days selection looked at, empty ones included
 *   3. post.rows            - the days that actually have an event
 *
 * Step 2 exists so a post selected before windows were recorded still gets the
 * right header without being regenerated.
 */
function postSpan(post) {
  const window = (post && Array.isArray(post.window)) ? post.window : [];
  const windowDates = window.map(isoDate).filter(Boolean);
  if (windowDates.length) return formatSpan(windowDates);

  const candidateDates = ((post && post.candidatesByDay) || [])
    .map((d) => isoDate(d && d.date))
    .filter(Boolean);
  if (candidateDates.length) return formatSpan(candidateDates);

  return dateSpan((post && post.rows) || []);
}

/* The label part alone, e.g. "WEEKLY ROUNDUP". */
function headerLabel(post) {
  return String((post && (post.subtitle || post.variant)) || 'Roundup').toUpperCase();
}

/* Full header: "// 12-16 OCT // WEEKLY ROUNDUP".
 *
 * No span (an empty event list, or rows the caller could not parse) still
 * yields a usable label rather than a dangling "// //".
 */
function header(post) {
  const span = postSpan(post);
  const label = headerLabel(post);
  return span ? '// ' + span + ' // ' + label : '// ' + label;
}

/* The header as two lines, for the image:
 *
 *   // 12-16 OCT //
 *   WEEKLY ROUNDUP
 *
 * Set on one line the whole string measures ~1473px at 88px against 932px of
 * usable width, so it would have shrunk to about 56px - smaller than the
 * wordmark. Splitting lets both lines stay large.
 *
 * The caption stays on one line: there is no width pressure in a text post.
 */
function splitLines(post) {
  const span = postSpan(post);
  const label = headerLabel(post);
  if (!span) return [label];
  return ['// ' + span + ' //', label];
}

module.exports = {
  header, splitLines, headerLabel, dateSpan, postSpan, dayDate, isoDate, MONTHS
};