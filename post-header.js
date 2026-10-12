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
 * The span is read off the event days themselves rather than recomputed from
 * the roundup's window, so it cannot disagree with the days printed underneath
 * it. A day with no events is simply absent, which is the honest reading.
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

/* "12-16 OCT", or "29 SEP - 02 OCT" across a month boundary. */
function dateSpan(rows) {
  const dates = [];
  for (const row of rows || []) {
    const d = dayDate(row && row.day);
    if (d) dates.push(d);
  }
  if (!dates.length) return '';

  // Numeric sort, so 09/10 comes before 12/10 rather than after it.
  const sorted = dates.slice().sort((a, b) => (a.mm - b.mm) || (a.dd - b.dd));
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  const pad = (n) => (n < 10 ? '0' + n : String(n));

  if (first.mm === last.mm) {
    return pad(first.dd) + '-' + pad(last.dd) + ' ' + MONTHS[first.mm - 1];
  }
  return pad(first.dd) + ' ' + MONTHS[first.mm - 1] +
         ' - ' + pad(last.dd) + ' ' + MONTHS[last.mm - 1];
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
  const span = dateSpan((post && post.rows) || []);
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
  const span = dateSpan((post && post.rows) || []);
  const label = headerLabel(post);
  if (!span) return [label];
  return ['// ' + span + ' //', label];
}

module.exports = { header, splitLines, headerLabel, dateSpan, dayDate, MONTHS };