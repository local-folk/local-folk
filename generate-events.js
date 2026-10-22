#!/usr/bin/env node
/**
 * The Kirn - static event page generator.
 *
 * Reads the published Google Sheet CSV and writes one static HTML page per
 * upcoming event at  /events/<slug>/  plus a sitemap and a static events index.
 *
 * Why static files? Link previews (WhatsApp, Facebook, X, Slack, iMessage) are
 * built by crawlers that fetch raw HTML and never execute JavaScript. The site
 * renders its event list client-side from the CSV, so there is nothing for those
 * crawlers to read. A real file per event is what makes a shared link show the
 * event's own title, description and date instead of a generic card.
 *
 * Runs on Node 18+ (fetch is global). No dependencies.
 *
 * Usage:  node generate-events.js
 */

'use strict';

const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const CONFIG = {
  siteOrigin: 'https://thekirn.co.uk',

  // The Published tab. The scraper moves an event over to the Archive tab
  // the day after it happens, so this holds what is still to come, plus
  // anything that happened in the last day or two.
  csvUrl:
    'https://docs.google.com/spreadsheets/d/e/2PACX-1vRtJN8W8AwbpQfUMykoANi9RfW6XA8ghJ-F-vagUGkQ8Ep5PWTbyae6f45kLlCVEpwJS2Mg0U9eKdz4/pub?gid=514788102&single=true&output=csv',

  // The site's public copy of past events.
  //
  // These live in a second spreadsheet, "The Kirn Site", which holds nothing
  // but the events that were published and have since happened. It is
  // published to the web in its entirety, so publishing it publishes nothing
  // but the site's own data.
  //
  // It is a separate sheet on purpose. The Archive tab of The Kirn holds the
  // decisions as well - the events that were rejected, the artists that were
  // turned down - so The Kirn is published to the web as the Published tab
  // only and those stay private.
  //
  // PUT THE PUBLISHED LINK FOR "The Kirn Site" HERE. The scraper creates the
  // sheet when setupSiteArchive() is run, and it logs the link to publish.
  //
  // Published 22 October 2026 as "Entire document". It has one tab,
  // Archive, holding only events that were published and have since
  // happened.
  archiveCsvUrl:
    'https://docs.google.com/spreadsheets/d/e/2PACX-1vQ4ZOkaGicLUQoD7ubgMRDiN-HGkY3EhGzzkfueGmg6jQY3U8D6_HPjHexj5r0Lj5aUMFa349ikxgq1/pub?gid=335963804&single=true&output=csv',

  // How long an event's page stays online after the event has happened.
  // After this, the event is still in the Archive tab - the sheet keeps
  // everything - but it no longer gets a page.
  archiveRetentionMonths: 6,

  eventsDir: path.join(__dirname, 'events'),
  sitemapPath: path.join(__dirname, 'sitemap.xml'),
  logoImage: '/og-image.png',
  dryRun: process.argv.includes('--dry-run')
};

// Must stay identical to eventSlug() in index.html. Verified by assertSlugAgreement().
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];

// ---------------------------------------------------------------------------
// CSV parsing - RFC4180-ish: quoted fields, escaped quotes, embedded newlines
// ---------------------------------------------------------------------------

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  // strip BOM
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  for (let i = 0; i < text.length; i++) {
    const c = text[i];

    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else {
        field += c;
      }
      continue;
    }

    if (c === '"') { inQuotes = true; continue; }
    if (c === ',') { row.push(field); field = ''; continue; }
    if (c === '\r') continue;
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    field += c;
  }

  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  if (!rows.length) return [];

  const header = rows[0].map(h => h.trim());
  return rows
    .slice(1)
    .filter(r => r.some(cell => cell !== ''))
    .map(r => {
      const o = {};
      header.forEach((h, i) => { o[h] = r[i] === undefined ? '' : r[i]; });
      return o;
    });
}

// ---------------------------------------------------------------------------
// Slug + formatting helpers (kept in lockstep with index.html)
// ---------------------------------------------------------------------------

/** Matches favId() in index.html - used to deep-link back to the map. */
function favId(e) {
  if (e.EventID) return e.EventID;
  const norm = s => String(s || '').toLowerCase()
    .replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
  return e.Date + '|' + norm(e.Venue) + '|' + norm(e.Title);
}

/** Matches eventSlug() in index.html. */
function slugPart(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')  // strip combining diacritics U+0300-036F
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function eventSlug(e) {
  const date = String(e.Date || '').replace(/[^0-9]/g, '');
  return [slugPart(e.Title), slugPart(e.Venue), date].filter(Boolean).join('-');
}

/** Guard: the client-side share button must compute the same slug we wrote. */
function clientSideSlug(row) {
  const title = row.Title;
  const venue = row.Venue;
  const date = String(row.Date || '').replace(/[^0-9]/g, '');
  const norm = s => String(s || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return [norm(title), norm(venue), date].filter(Boolean).join('-');
}

/**
 * The rows that belong on the site at all.
 *
 * A row needs a title and a real date, and its Status has to be Published.
 * A row with any other status - approved by hand, recalled, expired - is not
 * published and must not appear on the site.
 *
 * Note that this says nothing about the date being in the past. A published
 * event that has already happened still belongs on the site: it keeps its own
 * page for as long as the scraper keeps its row in the Published tab.
 */
function isPublishedRow(r) {
  return !!(r.Title && r.Date) &&
    String(r.Status || 'Published').trim().toLowerCase() === 'published' &&
    /^\d{4}-\d{2}-\d{2}$/.test(String(r.Date).trim());
}

/**
 * Whether an event is still to come. Events that have already happened are
 * left out of the listing - the index page and the sitemap - but they still
 * get a page of their own.
 */
function isUpcoming(ev, today) {
  return String(ev.date || '') >= today;
}

/**
 * A YYYY-MM-DD date a whole number of months ago.
 *
 * Used for the archive window. Month arithmetic from a date at the end of a
 * month can land a few days off - six months from 31 August is 3 March, not
 * 28 February - which is a day or two of slack either way on a window that
 * only has to be about six months.
 */
function monthsAgoStr(months) {
  const d = new Date();
  d.setMonth(d.getMonth() - months);
  const m = ('0' + (d.getMonth() + 1)).slice(-2);
  const day = ('0' + d.getDate()).slice(-2);
  return d.getFullYear() + '-' + m + '-' + day;
}

/**
 * The rows from the Archive tab that should still have a page.
 *
 * The Archive tab holds three kinds of row:
 *
 *   - events that were published and have now happened (Status "Published");
 *   - events that were rejected (Status "Rejected");
 *   - events that expired in Pending without ever being reviewed
 *     (Status "Expired - Not Reviewed").
 *
 * Only the first kind was ever public. The second and third must never
 * appear on the site, so they are filtered out here rather than further up.
 *
 * An event's page lives for CONFIG.archiveRetentionMonths after the event.
 * After that its row is still in the Archive tab, but it no longer gets a
 * page, and the build drops the page it had.
 */
function isArchivedButStillPublic(row, cutoff) {
  return isPublishedRow(row) && String(row.Date).trim() >= cutoff;
}

/**
 * Fetches one published CSV.
 *
 * A failure here stops the build. That is deliberate: the build wipes the
 * events directory and writes it again from scratch, so if the Archive tab
 * could not be read and the build carried on, every event that has already
 * happened would lose its page. Stopping leaves the published site as it
 * was, which is much better than quietly emptying it.
 */
async function fetchRows_(url, label) {
  // A link that has not been filled in yet. Caught here, with an
  // explanation, rather than as a 401 that looks like a publishing problem.
  if (!url || url.indexOf('PUBLISHED_URL') !== -1) {
    throw new Error('The ' + label +
      ' link has not been set in generate-events.js yet. For the Archive ' +
      'tab it is the published link for the "The Kirn Site" sheet.');
  }

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(label + ' CSV fetch failed: HTTP ' + res.status +
      '. Check that the tab is published to the web - run check-published-tabs.js.');
  }
  const text = await res.text();
  const rows = parseCsv(text);
  console.log('Parsed ' + rows.length + ' rows from ' + label + '.');
  return rows;
}

function parseDate(dateStr) {
  const p = String(dateStr || '').split('-');
  if (p.length !== 3) return null;
  const d = new Date(Date.UTC(Number(p[0]), Number(p[1]) - 1, Number(p[2])));
  return isNaN(d.getTime()) ? null : d;
}

/** "Tuesday 13th October" */
function formatDateLong(dateStr) {
  const d = parseDate(dateStr);
  if (!d) return String(dateStr || '');
  const day = d.getUTCDate();
  const suffix = day % 10 === 1 && day !== 11 ? 'st'
    : day % 10 === 2 && day !== 12 ? 'nd'
      : day % 10 === 3 && day !== 13 ? 'rd' : 'th';
  return WEEKDAYS[d.getUTCDay()] + ' ' + day + suffix + ' ' + MONTHS[d.getUTCMonth()];
}

/** "Tue 13 Oct" */
function formatDateShort(dateStr) {
  const d = parseDate(dateStr);
  if (!d) return String(dateStr || '');
  return WEEKDAYS[d.getUTCDay()].slice(0, 3) + ' ' + d.getUTCDate() + ' ' + MONTHS[d.getUTCMonth()].slice(0, 3);
}

/** "8pm" - matches formatTimeDisplay() in index.html */
/** "08/10/26" - unambiguous UK day/month/year, short enough to lead a list line */
function formatDateNumeric(dateStr) {
  const d = parseDate(dateStr);
  if (!d) return String(dateStr || '');
  const dd = ('0' + d.getUTCDate()).slice(-2);
  const mm = ('0' + (d.getUTCMonth() + 1)).slice(-2);
  const yy = ('0' + d.getUTCFullYear()).slice(-2);
  return dd + '/' + mm + '/' + yy;
}

/** Anchor id for a month heading: "October 2026" -> "october-2026" */
function monthSlug(month) {
  return String(month).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function formatTime(timeStr) {
  if (!timeStr) return '';
  const m = String(timeStr).match(/(\d{1,2}):(\d{2})/);
  if (!m) return String(timeStr);
  let hour = parseInt(m[1], 10);
  const minute = m[2];
  const suffix = hour >= 12 ? 'pm' : 'am';
  hour = hour % 12;
  if (hour === 0) hour = 12;
  return hour + (minute === '00' ? '' : ':' + minute) + suffix;
}

/** Matches esc() in index.html */
function esc(s) {
  return String(s === undefined || s === null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** JSON-LD safe string */
function jesc(s) {
  return JSON.stringify(String(s === undefined || s === null ? '' : s));
}

/** Matches isSafeUrl() in index.html */
function isSafeUrl(url) {
  return /^https?:\/\//i.test(String(url || '').trim());
}

/** Matches isGenericListingLink() in index.html */
function isGenericListingLink(url) {
  if (!url) return true;
  return String(url).indexOf('thecrackmagazine.com/whatson') !== -1;
}

// ---------------------------------------------------------------------------
// Category -> public label
//
// The spreadsheet stores the organiser-facing category ("Heritage Workshop").
// The website shows a shorter public label ("Crafts"). Rather than duplicating
// that mapping, we read TYPE_GROUPS straight out of index.html so there is one
// source of truth: change a label there and this picks it up automatically.
// ---------------------------------------------------------------------------

function loadTypeGroups() {
  const indexPath = path.join(__dirname, 'index.html');
  const html = fs.readFileSync(indexPath, 'utf8');

  const filterMatch = html.match(
    /<div class="filter-row" id="typeFilters">([\s\S]*?)<\/div>/);
  if (!filterMatch) {
    throw new Error('Could not find #typeFilters in index.html');
  }

  // Public label for each filter key, read off the buttons themselves.
  const labels = {};
  const btnRe = /<button class="filter-btn" data-type="([^"]+)">([^<]*)<\/button>/g;
  let m;
  while ((m = btnRe.exec(filterMatch[1])) !== null) {
    labels[m[1]] = m[2].trim();
  }

  // Which spreadsheet categories belong to each key.
  const groupsMatch = html.match(/const\s+TYPE_GROUPS\s*=\s*\{([\s\S]*?)\n\};/);
  if (!groupsMatch) {
    throw new Error('Could not find TYPE_GROUPS in index.html');
  }

  const byCategory = {};
  const arrRe = /(\w+)\s*:\s*\[([^\]]*)\]/g;
  while ((m = arrRe.exec(groupsMatch[1])) !== null) {
    const key = m[1];
    const cats = (m[2].match(/'([^']*)'/g) || [])
      .map(s => s.slice(1, -1));
    const label = labels[key];
    if (!label) {
      throw new Error('Filter key "' + key + '" in TYPE_GROUPS has no matching button in #typeFilters');
    }
    cats.forEach(cat => { byCategory[cat] = label; });
  }

  return { labels, byCategory };
}

const TYPE_MAP = loadTypeGroups();

/** "Heritage Workshop" -> "Crafts". Unknown categories fall through unchanged. */
function publicCategory(sheetCategory) {
  const cat = String(sheetCategory || '').trim();
  if (!cat) return '';
  return TYPE_MAP.byCategory[cat] || cat;
}

function todayStr() {
  const d = new Date();
  const m = ('0' + (d.getMonth() + 1)).slice(-2);
  const day = ('0' + d.getDate()).slice(-2);
  return d.getFullYear() + '-' + m + '-' + day;
}

function clamp(s, n) {
  s = String(s || '').trim();
  return s.length <= n ? s : s.slice(0, n - 1).replace(/\s+\S*$/, '') + '…';
}

// ---------------------------------------------------------------------------
// Per-event page
// ---------------------------------------------------------------------------

function buildEventPage(ev, isPast) {
  const origin = CONFIG.siteOrigin;
  const url = origin + '/events/' + ev.slug + '/';

  const dateLong = formatDateLong(ev.date);
  const time = formatTime(ev.startTime);
  const timeRange = ev.startTime
    ? (ev.endTime ? time + ' – ' + formatTime(ev.endTime) : time)
    : '';
  const whenLine = [dateLong, timeRange].filter(Boolean).join(', ');

  // The marker that says an event has already happened. It goes in front of
  // the event's title, wherever the title is shown, so that someone arriving
  // at a link they saved weeks ago can see at once that it is over.
  //
  // clamp() cuts from the end, so putting the marker first means it can
  // never be the thing that gets cut off.
  const pastFlag = isPast ? 'PAST EVENT - ' : '';

  const title = clamp(pastFlag + ev.title + ' – ' + (ev.venue || 'Newcastle'), 58) + ' | The Kirn';
  const shareTitle = pastFlag + ev.title + (ev.venue ? ' – ' + ev.venue : '');
  const shareText = [ev.title, ev.venue, formatDateShort(ev.date), time]
    .filter(Boolean).join(', ');

  const metaDesc = clamp(
    [isPast ? 'This event has passed' : '', whenLine, ev.venue, ev.description]
      .filter(Boolean).join('. ') + '.', 158);

  const lat = parseFloat(ev.lat);
  const lng = parseFloat(ev.lng);
  const hasGeo = !isNaN(lat) && !isNaN(lng);

  /* Search Google Maps for the venue by name and address rather than dropping
     the visitor on a pair of coordinates, which is a pin in the middle of a
     field rather than the front door. Falls back to coordinates only if the
     sheet has no venue name or address to search for. */
  const mapQuery = [ev.venue, ev.address].filter(Boolean).join(', ');
  const mapUrl = mapQuery
    ? 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(mapQuery)
    : (hasGeo
      ? 'https://www.google.com/maps/search/?api=1&query=' + lat + ',' + lng
      : null);

  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'Event',
    name: ev.title,
    startDate: ev.date + (ev.startTime ? 'T' + padTime(ev.startTime) : ''),
    eventAttendanceMode: 'https://schema.org/OfflineEventAttendanceMode',
    url: url,
    description: ev.description || shareText,
    inLanguage: 'en-GB'
  };
  // eventStatus is left off a page for an event that has already happened.
  // The schema.org EventStatusType enumeration has no member that means
  // "this has ended" - its members are EventCancelled, EventMovedOnline,
  // EventPostponed, EventRescheduled and EventScheduled - so every one of
  // them would be wrong. Saying nothing is the accurate answer.
  if (!isPast) jsonLd.eventStatus = 'https://schema.org/EventScheduled';
  if (ev.endTime) jsonLd.endDate = ev.date + 'T' + padTime(ev.endTime);
  jsonLd.location = {
    '@type': 'Place',
    name: ev.venue || 'Event location',
    address: ev.address || (ev.venue ? ev.venue + ', Newcastle upon Tyne' : 'Newcastle upon Tyne')
  };
  if (hasGeo) {
    jsonLd.location.geo = { '@type': 'GeoCoordinates', latitude: lat, longitude: lng };
  }
  if (ev.category) jsonLd.about = ev.category;
  jsonLd.organizer = { '@type': 'Organization', name: 'The Kirn', url: origin + '/' };
  jsonLd.superOrganizer = jsonLd.organizer;

  // A past event is not in the homepage's list, so linking to it with the
  // event id would land on a page that cannot find it. Link to the homepage
  // itself instead.
  const homeHref = isPast
    ? origin + '/'
    : origin + '/?event=' + encodeURIComponent(ev.favId);
  const venueHref = origin + '/?venue=' + encodeURIComponent(ev.venueKey);
  const allEventsHref = origin + '/';

  return `<!DOCTYPE html>
<html lang="en-GB">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(metaDesc)}">
<link rel="canonical" href="${esc(url)}">

<meta property="og:type" content="website">
<meta property="og:site_name" content="The Kirn">
<meta property="og:title" content="${esc(shareTitle)}">
<meta property="og:description" content="${esc(metaDesc)}">
<meta property="og:url" content="${esc(url)}">
<meta property="og:image" content="${esc(origin + CONFIG.logoImage)}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="The Kirn - folk and traditional events in Newcastle and the North East">
<meta property="og:locale" content="en_GB">

<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(shareTitle)}">
<meta name="twitter:description" content="${esc(metaDesc)}">
<meta name="twitter:image" content="${esc(origin + CONFIG.logoImage)}">

<meta name="theme-color" content="#660000">
<link rel="icon" href="/favicon.ico" sizes="any">
<link rel="icon" type="image/png" href="/favicon.png">
<link rel="apple-touch-icon" href="/favicon.png">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IM+Fell+English&display=swap">
<style>
  :root {
    --bg: #ffffea; --text: #210000; --line: #c9c2a0; --link: #b82e00;
    --band: #660000; --onband: #ffffea; --chip: #ffe680;
    --btn-bg: #f0f0f0; --muted: #6b4a3a; --panel: #ffffea; --menu-text: #210000;
  }
  body.dark {
    --bg: #210000; --text: #ffffea; --line: #5c3828; --link: #ffcc33;
    --chip: #7a1a1a; --btn-bg: #222222; --muted: #d8a58f;
    --panel: #2b0d0d; --menu-text: #ffffea;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--text);
    font-family: -apple-system, Segoe UI, Roboto, Arial, sans-serif;
    line-height: 1.55;
  }

  /* Header matches the main site: title centred, menu left, donate right. */
  header { background: var(--band); padding: 14px 16px; text-align: center; position: relative; }
  @media (min-width: 620px) { header { padding-left: 110px; padding-right: 110px; } }
  header h1 {
    margin: 0; font-family: 'IM Fell English', 'Palatino Linotype', Palatino,
      'Book Antiqua', Georgia, serif;
    font-size: 2.6rem; font-weight: 400; letter-spacing: 0.03em;
    color: #ffffea;
  }
  @media (max-width: 619px) { header h1 { font-size: 1.9rem; } }
  header h1 a { color: #ffffea; text-decoration: none; }
  header h1 a:hover { text-decoration: none; }

  #menuBtn {
    position: absolute; left: 14px; top: 50%; transform: translateY(-50%);
    border: 1px solid #cc9900; background: #ffcc33; border-radius: 20px;
    padding: 6px 12px; cursor: pointer; display: flex; align-items: center; height: 32px;
  }
  #menuBtn:hover { background: #ffdb66; }
  #menuBtn svg { display: block; width: 20px; height: 16px; }
  #menuBtn svg line { stroke: #210000; stroke-width: 2.2; stroke-linecap: round; }

  #kofiSlot { position: absolute; right: 14px; top: 50%; transform: translateY(-50%); }
  .kofi-button {
    display: inline-block; white-space: nowrap; padding: 6px 14px;
    border-radius: 16px; background-color: #ffcc33; border: 1px solid #cc9900;
    color: #111111; text-decoration: none; font-size: 0.9rem; font-weight: 600;
  }
  .kofi-button:hover { text-decoration: none; background-color: #ffdb66; }
  .kofi-button .kofiimg {
    vertical-align: middle; height: 13px; width: 20px; margin-right: 6px;
    margin-bottom: 3px; border: none;
  }
  @media (max-width: 419px) {
    .kofi-word { display: none; }
    .kofi-button .kofiimg { margin-right: 0; }
    .kofi-button { padding: 6px 9px; }
  }

  #menuShade {
    display: none; position: fixed; inset: 0; background: rgba(0,0,0,0.45); z-index: 40;
  }
  #menuShade.open { display: block; }
  #menuPanel {
    display: none; position: fixed; top: 0; left: 0; bottom: 0; width: 250px;
    max-width: 82vw; background: var(--panel); z-index: 50;
    padding: 16px 18px 30px; overflow-y: auto;
    box-shadow: 2px 0 10px rgba(0,0,0,0.3);
  }
  #menuPanel.open { display: block; }
  #menuClose {
    background: none; border: 0; color: var(--menu-text); font-size: 2rem;
    line-height: 1; cursor: pointer; padding: 0 6px 6px 0;
  }
  #menuHeading {
    font-family: 'IM Fell English', Georgia, serif; font-size: 1.5rem;
    color: var(--menu-text); margin: 4px 0 14px;
  }
  .menu-link {
    display: block; padding: 9px 0; color: var(--menu-text);
    text-decoration: none; font-size: 1.05rem;
    border-bottom: 1px solid var(--line);
  }
  .menu-link:hover { text-decoration: underline; }
  .menu-btn {
    margin-top: 16px; background: var(--btn-bg); color: var(--text);
    border: 1px solid var(--line); border-radius: 8px; padding: 9px 14px;
    font-size: 1rem; cursor: pointer; font-family: inherit;
  }

  main { max-width: 660px; margin: 0 auto; padding: 26px 18px 60px; }
  .chip {
    display: inline-block; background: var(--chip); border: 1px solid var(--line);
    border-radius: 12px; padding: 2px 12px; font-size: .82rem; margin-bottom: 14px;
  }
  h2.title {
    font-family: 'IM Fell English', 'Palatino Linotype', Palatino,
      'Book Antiqua', Georgia, serif;
    font-size: clamp(1.7rem, 5.2vw, 2.4rem); font-weight: 400;
    margin: 0 0 14px; line-height: 1.2;
  }
  .line { margin: 0 0 10px; }
  .venue { font-weight: 600; }
  .muted { color: var(--muted); }
  /* The note on the page of an event that has already happened. */
  .passed { color: var(--muted); font-style: italic; }
  /* The marker that goes in front of the title of an event that has already
     happened. It is a label, not part of the event's name, so it is kept
     outside the link and set apart from the title itself. */
  .pastflag { color: var(--muted); font-style: italic; }
  .actions { display: flex; flex-wrap: wrap; gap: 10px; margin: 22px 0 8px; }
  .btn {
    display: inline-block; padding: 9px 16px; border-radius: 8px;
    border: 1px solid var(--line); background: var(--btn-bg); color: var(--text);
    text-decoration: none; font-size: .95rem; cursor: pointer; font-family: inherit;
  }
  .btn.primary { background: var(--band); border-color: var(--band); color: var(--onband); }
  .btn:hover { text-decoration: underline; }
  a.titlelink { color: inherit; text-decoration: none; }
  a.titlelink:hover { text-decoration: underline; }
  /* Venue and address read as links but are not underlined, matching the
     weight of the surrounding text rather than shouting over it. */
  a.maplink { color: var(--link); text-decoration: none; }
  a.maplink:hover { text-decoration: underline; }
  hr { border: 0; border-top: 1px solid var(--line); margin: 26px 0 18px; }
  .more { margin-top: 26px; }
  footer { border-top: 1px solid var(--line); padding: 18px; text-align: center; font-size: .9rem; }
  footer a { color: var(--link); }
</style>
<script type="application/ld+json">
${JSON.stringify(jsonLd, null, 2)}
</script>
</head>
<body class="dark">
<script>
/* Applied before first paint so a visitor who chose dark mode never sees a
   flash of the light theme. Mirrors the main site. */
(function () {
  try {
    if (localStorage.getItem('kirnTheme') === 'light') document.body.classList.remove('dark');
  } catch (err) {}
})();
</script>
<header>
  <h1><a href="/">The Kirn</a></h1>
  <button id="menuBtn" aria-label="Open menu" aria-expanded="false" aria-controls="menuPanel">
    <svg viewBox="0 0 20 16" aria-hidden="true" focusable="false">
      <line x1="0" y1="2" x2="20" y2="2"/>
      <line x1="0" y1="8" x2="20" y2="8"/>
      <line x1="0" y1="14" x2="20" y2="14"/>
    </svg>
  </button>
  <div id="kofiSlot">
    <a class="kofi-button" title="Support me on ko-fi.com"
       href="https://ko-fi.com/D7F8284K0C" target="_blank" rel="noopener noreferrer">
      <img class="kofiimg" src="https://storage.ko-fi.com/cdn/cup-border.png"
           alt="Ko-fi donations"><span class="kofi-word">Donate</span>
    </a>
  </div>
</header>

<div id="menuShade"></div>
<div id="menuPanel">
  <button id="menuClose" aria-label="Close menu">&times;</button>
  <div id="menuHeading">Menu</div>
  <a class="menu-link" href="/">Home</a>
  <a class="menu-link" href="/about/">About</a>
  <a class="menu-link" href="/submit/">Submit An Event</a>
  <a class="menu-link" href="https://ko-fi.com/thekirn" target="_blank" rel="noopener noreferrer">Donate</a>
  <a class="menu-link" href="/contact/">Contact</a>
  <button id="darkToggle" class="menu-btn">Dark mode</button>
</div>

<main>
${ev.category ? '  <span class="chip">' + esc(ev.category) + '</span>\n' : ''}  <h2 class="title">${isPast ? '<span class="pastflag">PAST EVENT - </span>' : ''}<a class="titlelink" href="${esc(homeHref)}">${esc(ev.title)}</a></h2>
  <p class="line"><strong>${esc(whenLine)}</strong></p>
${isPast ? '  <p class="line passed"><strong>This event has passed.</strong></p>\n' : ''}${ev.venue ? '  <p class="line venue">' + venueHtml(ev.venue, mapUrl) + '</p>\n' : ''}${ev.address ? '  <p class="line muted">' + venueHtml(ev.address, mapUrl) + '</p>\n' : ''}${ev.description ? '  <p class="line">' + esc(ev.description) + '</p>\n' : ''}  <div class="actions">
    <button class="btn primary" id="shareBtn" type="button">Share this event</button>
    <a class="btn" href="${esc(venueHref)}">${isPast ? 'See upcoming events at this venue' : 'See on the map'}</a>
${mapUrl ? '    <a class="btn" href="' + esc(mapUrl) + '" target="_blank" rel="noopener noreferrer">Directions</a>\n' : ''}  </div>
  <p class="more"><a class="btn" href="${esc(allEventsHref)}">View All Events</a></p>
  <hr>
  <p class="muted">Listed on The Kirn, folk and traditional events across Newcastle and the North East.</p>
  <p><a href="/">&larr; All events</a></p>
</main>
<footer>
  <p><a href="/">thekirn.co.uk</a></p>
</footer>
<script>
(function () {
  var btn = document.getElementById('shareBtn');
  if (btn) {
    var data = { title: ${jesc(shareTitle)}, text: ${jesc(shareText)}, url: ${jesc(url)} };
    btn.addEventListener('click', function () {
      if (navigator.share) {
        navigator.share(data)['catch'](function () {});
        return;
      }
      var done = function () {
        btn.textContent = 'Link copied';
        setTimeout(function () { btn.textContent = 'Share this event'; }, 2500);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(data.url).then(done, function () {});
      }
    });
  }

  /* Dark mode, sharing the same preference key as the rest of the site so the
     choice follows the visitor from page to page. */
  var darkToggle = document.getElementById('darkToggle');
  function updateThemeLabel() {
    if (!darkToggle) return;
    darkToggle.textContent =
      document.body.classList.contains('dark') ? 'Light mode' : 'Dark mode';
  }
  try {
    if (localStorage.getItem('kirnTheme') === 'dark') {
      document.body.classList.add('dark');
    }
  } catch (err) {}
  updateThemeLabel();
  if (darkToggle) {
    darkToggle.addEventListener('click', function () {
      document.body.classList.toggle('dark');
      try {
        localStorage.setItem('kirnTheme',
          document.body.classList.contains('dark') ? 'dark' : 'light');
      } catch (err) {}
      updateThemeLabel();
    });
  }

  /* Slide-out menu, matching the main site. */
  var menuPanel = document.getElementById('menuPanel');
  var menuBtn = document.getElementById('menuBtn');
  var menuShade = document.getElementById('menuShade');
  var menuClose = document.getElementById('menuClose');

  function setMenuOpen(open) {
    if (!menuPanel || !menuShade || !menuBtn) return;
    menuPanel.classList.toggle('open', open);
    menuShade.classList.toggle('open', open);
    menuBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) menuPanel.scrollTop = 0;
  }

  if (menuBtn) {
    menuBtn.addEventListener('click', function () {
      setMenuOpen(!menuPanel.classList.contains('open'));
    });
  }
  if (menuClose) {
    menuClose.addEventListener('click', function () { setMenuOpen(false); });
  }
  if (menuShade) {
    menuShade.addEventListener('click', function () { setMenuOpen(false); });
  }
  document.addEventListener('keydown', function (ev) {
    if (ev.key === 'Escape' && menuPanel && menuPanel.classList.contains('open')) {
      setMenuOpen(false);
    }
  });
})();
</script>
</body>
</html>
`;
}

/** Venue name / address, linked so it opens that venue on Google Maps. */
function venueHtml(text, mapUrl) {
  if (!mapUrl) return esc(text);
  return '<a class="maplink" href="' + esc(mapUrl) + '" target="_blank" rel="noopener noreferrer">' +
    esc(text) + '</a>';
}

/** Matches venueKeyFor() in index.html - the key the map groups markers by. */
function venueKeyFor(ev) {
  const venueNorm = (ev.venue || '')
    .toLowerCase()
    .replace(/^the\s+/, '')
    .replace(/\s+the\s+/g, ' ')
    .replace(/[^a-z0-9]/g, '')
    .trim();

  const postcodeMatch = (ev.address || '').match(/([A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2})/i);
  const postcode = postcodeMatch ? postcodeMatch[1].replace(/\s+/g, '') : '';

  return (venueNorm || postcode) ? venueNorm + '|' + postcode : ev.lat + ',' + ev.lng;
}

function padTime(t) {
  const m = String(t || '').match(/(\d{1,2}):(\d{2})/);
  if (!m) return '00:00';
  return ('0' + parseInt(m[1], 10)).slice(-2) + ':' + m[2];
}

// ---------------------------------------------------------------------------
// Static events index + sitemap
// ---------------------------------------------------------------------------

function buildEventsIndex(events) {
  const origin = CONFIG.siteOrigin;
  const byMonth = new Map();
  for (const ev of events) {
    const d = parseDate(ev.date);
    if (!d) continue;
    const key = MONTHS[d.getUTCMonth()] + ' ' + d.getUTCFullYear();
    if (!byMonth.has(key)) byMonth.set(key, []);
    byMonth.get(key).push(ev);
  }

  const sections = [...byMonth.entries()].map(([month, list]) => {
    const items = list.map(ev => {
      // "08/10/26  Event Name - The Cumberland Arms"
      return `    <li><a href="/events/${esc(ev.slug)}/">` +
        `<span class="d">${esc(formatDateNumeric(ev.date))}</span> ` +
        esc(ev.title) +
        (ev.venue ? ` - ${esc(ev.venue)}` : '') +
        '</a></li>';
    }).join('\n');
    return `  <h2 id="${esc(monthSlug(month))}">${esc(month)}` +
      `<span class="count">${list.length}</span></h2>\n  <ul>\n${items}\n  </ul>`;
  }).join('\n');

  const months = [...byMonth.keys()]
    .map(m => `<a href="#${esc(monthSlug(m))}">${esc(m)}</a>`)
    .join('');

  return `<!DOCTYPE html>
<html lang="en-GB">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>All Folk &amp; Traditional Events in Newcastle | The Kirn</title>
<meta name="description" content="A full list of upcoming folk, traditional music, ceilidh, session and heritage events across Newcastle and the North East.">
<link rel="canonical" href="${esc(origin + '/events/')}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="The Kirn">
<meta property="og:title" content="All Folk &amp; Traditional Events in Newcastle">
<meta property="og:description" content="Every upcoming folk, traditional music, ceilidh, session and heritage event across Newcastle and the North East.">
<meta property="og:url" content="${esc(origin + '/events/')}">
<meta property="og:image" content="${esc(origin + CONFIG.logoImage)}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:image" content="${esc(origin + CONFIG.logoImage)}">
<meta name="theme-color" content="#660000">
<link rel="icon" href="/favicon.ico" sizes="any">
<link rel="icon" type="image/png" href="/favicon.png">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IM+Fell+English&display=swap">
<style>
  body { margin:0; background:#ffffea; color:#210000;
    font-family:-apple-system, Segoe UI, Roboto, Arial, sans-serif; line-height:1.55; }
  header { background:#660000; padding:14px 16px; text-align:center; }
  header h1 { margin:0; font-size:1.9rem; font-weight:400;
    font-family:'IM Fell English', Georgia, serif; }
  header a { color:#ffffea; text-decoration:none; }
  main { max-width:820px; margin:0 auto; padding:26px 18px 60px; }
  h2 { font-family:'IM Fell English', Georgia, serif; font-weight:400;
    font-size:1.5rem; margin:30px 0 8px; display:flex;
    align-items:baseline; gap:10px; scroll-margin-top:12px; }
  h2 .count { font-family:-apple-system, Segoe UI, Roboto, Arial, sans-serif;
    font-size:.85rem; color:#6b4a3a; }
  ul { list-style:none; padding:0; margin:0; }
  li { border-bottom:1px solid #c9c2a0; }
  li a { display:block; padding:9px 0; color:#210000; text-decoration:none;
    font-size:.97rem; line-height:1.45; }
  li a:hover, li a:focus { color:#b82e00; }
  /* Fixed-width date keeps every line's title in a neat column. */
  .d { display:inline-block; min-width:4.6em; font-variant-numeric:tabular-nums;
    color:#6b4a3a; }
  .jump { margin:0 0 6px; font-size:.9rem; }
  .jump a { display:inline-block; margin:0 8px 6px 0; }
  a { color:#b82e00; }
  footer { border-top:1px solid #c9c2a0; padding:18px; text-align:center; font-size:.9rem; }
</style>
</head>
<body>
<header><h1><a href="/">The Kirn</a></h1></header>
<main>
  <p>${events.length} upcoming events. <a href="/">Browse them on the map</a>.</p>
  <p class="jump">Jump to: ${months}</p>
${sections}
  <p><a href="/">&larr; All events</a></p>
</main>
<footer><p><a href="/">thekirn.co.uk</a></p></footer>
</body>
</html>
`;
}

/**
 * The sitemap.
 *
 * Upcoming events first, then the events that have already happened, at the
 * bottom. The two lists are separate because the same event moves from one
 * to the other when it happens, and its URL has to stay exactly the same
 * across that move - a link someone saved must not stop working the day
 * after the event.
 *
 * The slug is worked out from the title, the venue and the date, and none of
 * those change when the event is moved from one tab to the other, so the URL
 * is the same in both lists. That is the whole point of splitting them here
 * rather than rebuilding the list from scratch.
 */
function buildSitemap(upcoming, past) {
  const origin = CONFIG.siteOrigin;
  const today = todayStr();
  const statics = [
    { loc: origin + '/', priority: '1.0', freq: 'daily' },
    { loc: origin + '/events/', priority: '0.9', freq: 'daily' },
    { loc: origin + '/about/', priority: '0.5', freq: 'monthly' },
    { loc: origin + '/submit/', priority: '0.7', freq: 'monthly' },
    { loc: origin + '/contact/', priority: '0.3', freq: 'yearly' }
  ];
  const eventUrl = ev =>
    `  <url>\n    <loc>${esc(origin + '/events/' + ev.slug + '/')}</loc>\n    <lastmod>${today}</lastmod>\n    <changefreq>weekly</changefreq>\n    <priority>0.6</priority>\n  </url>`;

  const urls = statics.map(s =>
    `  <url>\n    <loc>${esc(s.loc)}</loc>\n    <lastmod>${today}</lastmod>\n    <changefreq>${s.freq}</changefreq>\n    <priority>${s.priority}</priority>\n  </url>`
  )
    .concat((upcoming || []).map(eventUrl))
    .concat((past || []).map(eventUrl));

  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('\n')}\n</urlset>\n`;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log('Fetching Published CSV…');
  const publishedRows = await fetchRows_(CONFIG.csvUrl, 'Published');

  console.log('Fetching Archive CSV…');
  const archivedRows = await fetchRows_(CONFIG.archiveCsvUrl, 'Archive');

  const today = todayStr();
  const cutoff = monthsAgoStr(CONFIG.archiveRetentionMonths);

  // The events that get a page come from two tabs.
  //
  // From Published: everything that is published and well-formed. These are
  // the events that are still to come, plus any that happened in the last day
  // or two and have not been moved over yet.
  //
  // From Archive: the events that were published and have since happened,
  // as long as they are still inside the retention window. An event's page
  // lives for about six months after the event and no longer.
  const published = publishedRows.filter(isPublishedRow);

  const archived = archivedRows.filter(row => isArchivedButStillPublic(row, cutoff));

  const publishedDropped = publishedRows.length - published.length;
  const archivedDropped = archivedRows.length - archived.length;

  console.log('Kept ' + published.length + ' published event(s) from Published (' +
    publishedDropped + ' not published or malformed).');
  console.log('Kept ' + archived.length + ' archived event(s) still inside the ' +
    CONFIG.archiveRetentionMonths + '-month window (' + archivedDropped +
    ' older than that, rejected, or never reviewed).');

  // Build events, de-duplicating slugs.
  const used = new Map();
  const events = [];
  let collisions = 0;
  let slugMismatches = 0;
  let repeats = 0;

  // The same event can be in the sheet more than once. The Archive tab has
  // a row of The Glasshouse's Shawn Colvin in it twice, for instance. They
  // are the same event, so they get one page - not two, one of which would
  // be called "...-2".
  const seenIds = new Set();

  for (const row of published.concat(archived)) {
    const eventId = String(row.EventID || '').trim();
    if (eventId && seenIds.has(eventId)) {
      repeats++;
      continue;
    }
    if (eventId) seenIds.add(eventId);

    const base = eventSlug(row);
    if (clientSideSlug(row) !== base) slugMismatches++;

    let slug = base;
    if (used.has(slug)) {
      collisions++;
      let n = 2;
      while (used.has(base + '-' + n)) n++;
      slug = base + '-' + n;
    }
    used.set(slug, true);

    const ev = {
      slug,
      favId: favId(row),
      title: row.Title,
      description: row.Description || '',
      category: publicCategory(row.Category),
      date: row.Date.trim(),
      startTime: (row.StartTime || '').trim(),
      endTime: (row.EndTime || '').trim(),
      venue: row.Venue || '',
      address: row.Address || '',
      lat: row.Lat,
      lng: row.Lng,
      sourceUrl: row.SourceURL || ''
    };

    // Must match venueKeyFor() in index.html so ?venue= resolves to a marker.
    ev.venueKey = venueKeyFor(ev);

    events.push(ev);
  }

  events.sort((a, b) =>
    a.date.localeCompare(b.date) ||
    (a.startTime || '99').localeCompare(b.startTime || '99') ||
    a.title.localeCompare(b.title));

  if (slugMismatches) {
    throw new Error('Slug mismatch between generator and client for ' +
      slugMismatches + ' events. index.html eventSlug() must match slugPart().');
  }
  if (collisions) {
    console.log('NOTE: ' + collisions + ' duplicate slug(s) received -2, -3 suffixes.');
  }
  if (repeats) {
    console.log('NOTE: ' + repeats + ' row(s) repeated an event that was already ' +
      'written, and were written once.');
  }

  // Upcoming events are listed on the events index and come first in the
  // sitemap. Events that have already happened keep their page - and their
  // URL - but they are not linked from the index, and they sit at the bottom
  // of the sitemap.
  const listed = events.filter(ev => isUpcoming(ev, today));
  const expired = events.filter(ev => !isUpcoming(ev, today));

  if (CONFIG.dryRun) {
    console.log('\n--dry-run: nothing written. First 5 upcoming slugs:');
    listed.slice(0, 5).forEach(ev => console.log('  /events/' + ev.slug + '/'));
    console.log('  ...and ' + expired.length + ' past event(s) that keep their pages.');
    return;
  }

  // Rebuild the events directory from scratch so stale pages disappear.
  fs.rmSync(CONFIG.eventsDir, { recursive: true, force: true });
  fs.mkdirSync(CONFIG.eventsDir, { recursive: true });

  let written = 0;
  for (const ev of events) {
    const isPast = !isUpcoming(ev, today);
    const dir = path.join(CONFIG.eventsDir, ev.slug);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'index.html'), buildEventPage(ev, isPast), 'utf8');
    written++;
  }

  fs.writeFileSync(path.join(CONFIG.eventsDir, 'index.html'), buildEventsIndex(listed), 'utf8');
  fs.writeFileSync(CONFIG.sitemapPath, buildSitemap(listed, expired), 'utf8');

  console.log('Wrote ' + written + ' event pages (' + listed.length +
    ' upcoming and listed, ' + expired.length + ' past and kept), ' +
    'events/index.html and sitemap.xml.');
}

// Run the build when this file is run directly, which is what the workflow
// does. Requiring it instead just gives the functions above, so the tests can
// use the real code rather than a copy of it.
if (require.main === module) {
  main().catch(err => {
    console.error('FAILED: ' + err.message);
    process.exit(1);
  });
}

module.exports = {
  CONFIG: CONFIG,
  main: main,
  parseCsv: parseCsv,
  isPublishedRow: isPublishedRow,
  isUpcoming: isUpcoming,
  isArchivedButStillPublic: isArchivedButStillPublic,
  monthsAgoStr: monthsAgoStr,
  eventSlug: eventSlug,
  buildEventPage: buildEventPage,
  buildEventsIndex: buildEventsIndex,
  buildSitemap: buildSitemap
};
