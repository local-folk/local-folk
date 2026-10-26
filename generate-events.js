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
  // The past-events page. It lists the event pages that are still inside the
  // retention window but no longer upcoming, so they are reachable by a link
  // rather than existing only in the sitemap.
  archiveDir: path.join(__dirname, 'archive'),
  sitemapPath: path.join(__dirname, 'sitemap.xml'),
  // The homepage's copy of the upcoming events. The homepage renders its list
  // from the sheet in the browser, which Google's renderer snapshots before an
  // async fetch has returned - so it saw "Loading events..." and no events at
  // all. This file is loaded with a blocking <script> so the list is present in
  // the first render. See buildEventsData().
  eventsDataPath: path.join(__dirname, 'events-data.js'),
  // The lastmod memory. See buildSitemap() for why this is a file rather than
  // "today" on every entry.
  lastmodPath: path.join(__dirname, 'lastmod.json'),
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
// Structured data helpers
// ---------------------------------------------------------------------------

/**
 * The UTC offset for a London wall-clock time, as "+01:00" or "+00:00".
 *
 * Event startDate was previously written without an offset ("2026-11-29T19:30").
 * Google falls back to the location's timezone in that case, which happens to
 * be right while every event is in Newcastle, but it is a guess. An explicit
 * offset removes the guess and fixes the event to the correct instant across
 * the March and October clock changes.
 *
 * The offset is worked out by treating the wall-clock time as UTC, formatting
 * that instant in Europe/London, and reading back the difference. That uses the
 * platform's own timezone rules, so it follows the real transition dates rather
 * than a hard-coded month boundary.
 */
function londonOffsetSuffix_(dateStr, timeStr) {
  const d = parseDate(dateStr);
  if (!d) return '';
  const m = String(timeStr || '').match(/^(\d{1,2}):(\d{2})/);
  const hours = m ? parseInt(m[1], 10) : 0;
  const minutes = m ? parseInt(m[2], 10) : 0;
  if (hours > 23 || minutes > 59) return '';

  const guess = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(),
    hours, minutes);
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London',
    hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit'
  }).formatToParts(new Date(guess));

  const value = type => {
    const found = parts.find(p => p.type === type);
    return found ? parseInt(found.value, 10) : 0;
  };
  const asUtc = Date.UTC(value('year'), value('month') - 1, value('day'),
    value('hour') % 24, value('minute'));

  const offsetMinutes = Math.round((asUtc - guess) / 60000);
  const sign = offsetMinutes < 0 ? '-' : '+';
  const abs = Math.abs(offsetMinutes);
  return sign + ('0' + Math.floor(abs / 60)).slice(-2) + ':' +
    ('0' + (abs % 60)).slice(-2);
}

/**
 * A schema.org PostalAddress from the sheet's single-line address.
 *
 * The sheet holds addresses like
 *   "James Place Street, Ouseburn, Newcastle, NE6 1LD"
 *   "Main Road, Ryton, Gateshead, England, NE40 3RX, United Kingdom"
 *   "Church Bank, Jarrow NE32 3DY"
 * and sometimes nothing at all. Google's Event documentation wants
 * location.address to be a PostalAddress rather than a plain string, so this
 * splits off the postcode and the final place name and hands the rest over as
 * the street address.
 *
 * It never invents anything: if no postcode is recognised, the address is kept
 * whole as the street address, which is still a valid PostalAddress.
 */
function postalAddress_(raw) {
  const text = String(raw || '').trim();
  if (!text) return null;

  // Country names are not part of the street address, and addressCountry is
  // set from the site's own location rather than parsed from the text.
  let parts = text.split(',')
    .map(s => s.trim())
    .filter(Boolean)
    .filter(s => !/^(united kingdom|great britain|england|scotland|wales|uk|gb)\.?$/i.test(s));
  if (!parts.length) parts = [text];

  let postalCode = '';
  const last = parts[parts.length - 1];
  const code = last.match(/([A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2})\s*$/i);
  if (code) {
    postalCode = code[1].toUpperCase().replace(/\s+/g, ' ');
    const before = last.slice(0, code.index).replace(/[,\s]+$/, '').trim();
    if (before) parts[parts.length - 1] = before;
    else parts.pop();
  }
  if (!parts.length) return null;

  // The last remaining part is the town, unless it is all there is.
  const locality = parts.length > 1 ? parts[parts.length - 1] : '';
  const street = parts.length > 1 ? parts.slice(0, -1).join(', ') : parts[0];

  const address = { '@type': 'PostalAddress' };
  if (street) address.streetAddress = street;
  if (locality) address.addressLocality = locality;
  if (postalCode) address.postalCode = postalCode;
  address.addressCountry = 'GB';
  return address;
}

/**
 * The acts named in an event title, or null when they cannot be told apart.
 *
 * Several listings name more than one act with " + ", for example
 * "Craven + Sam Baxter and Merle Harbron + Frankie Insley". Splitting on that
 * separator gives real performer names.
 *
 * Titles that also carry a promoter or series prefix ("Fresh Thursday //
 * Salt House + Maja Bugge & Dave Evans", "OFFGRID: MAAR + Glad Town Ghost")
 * are left alone: splitting them would publish the prefix as part of the act's
 * name, and a wrong name is worse than no performer field. Google lists
 * performer as recommended, not required, so omitting it costs nothing.
 */
function performersFor_(title) {
  const parts = String(title || '')
    .split(' + ')
    .map(s => s.trim())
    .filter(Boolean);
  if (parts.length < 2) return null;
  if (parts.some(p => p.indexOf('//') !== -1 || p.indexOf(':') !== -1)) return null;
  return parts.map(name => ({ '@type': 'PerformingGroup', name: name }));
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

  // An explicit UTC offset makes the start and end times unambiguous. The
  // offset is per event, because it changes with the clocks.
  const startOffset = ev.startTime ? londonOffsetSuffix_(ev.date, ev.startTime) : '';
  const endOffset = ev.endTime ? londonOffsetSuffix_(ev.date, ev.endTime) : '';
  const startDate = ev.startTime
    ? ev.date + 'T' + padTime(ev.startTime) + ':00' + startOffset
    : ev.date;
  const endDate = ev.endTime
    ? ev.date + 'T' + padTime(ev.endTime) + ':00' + endOffset
    : '';

  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'Event',
    name: ev.title,
    startDate: startDate,
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
  if (endDate) jsonLd.endDate = endDate;

  const addressText = ev.address ||
    (ev.venue ? ev.venue + ', Newcastle upon Tyne' : 'Newcastle upon Tyne');
  jsonLd.location = {
    '@type': 'Place',
    name: ev.venue || 'Event location',
    // A PostalAddress rather than a bare string: Google asks for the address
    // as an object. postalAddress_ keeps the text verbatim when it cannot
    // recognise a postcode, so this never invents an address.
    address: postalAddress_(addressText) || addressText
  };
  if (hasGeo) {
    jsonLd.location.geo = { '@type': 'GeoCoordinates', latitude: lat, longitude: lng };
  }
  if (ev.category) jsonLd.about = ev.category;

  // Only present when the title names more than one act unambiguously.
  const performers = performersFor_(ev.title);
  if (performers) jsonLd.performer = performers;

  jsonLd.organizer = { '@type': 'Organization', name: 'The Kirn', url: origin + '/' };
  jsonLd.superOrganizer = jsonLd.organizer;

  // A past event is not in the homepage's list, so linking to it with the
  // event id would land on a page that cannot find it. Link to the homepage
  // itself instead.
  //
  // The deep links are fragments, not query strings.
  //
  // Changed 26 October 2026. A fragment is never sent to the server, so every
  // one of these links is just a link to "/" as far as Google is concerned.
  // The query form produced a separate, crawlable URL for every event and every
  // venue - around 600 of them - all serving the same homepage. They were
  // canonicalised to "/", but on 24 October Search Console still listed a batch
  // under "Soft 404": the page had returned 200 with an empty list because the
  // scripts it loaded from cdnjs were blocked in Google's renderer. That is
  // fixed, and the fragments stop the duplicate URLs being discovered at all.
  //
  // The homepage still reads ?event= and ?venue=, so links already shared or
  // indexed keep working exactly as before.
  const homeHref = isPast
    ? origin + '/'
    : origin + '/#event=' + encodeURIComponent(ev.favId);
  const venueHref = origin + '/#venue=' + encodeURIComponent(ev.venueKey);
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

function buildEventsIndex(events, pastCount) {
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
${pastCount ? '  <p class="jump">Looking for something that has already happened? <a href="/archive/">Browse past events</a>.</p>\n' : ''}  <p class="jump">Jump to: ${months}</p>
${sections}
  <p><a href="/">&larr; All events</a></p>
</main>
<footer><p><a href="/">thekirn.co.uk</a></p></footer>
</body>
</html>
`;
}

/**
 * The homepage's copy of the upcoming events, at /events-data.js.
 *
 * The homepage draws its list by fetching the sheet in the browser, which
 * happens after the load event. Google's renderer took its snapshot of the
 * page before that fetch had returned, so the page as indexed held no events
 * at all - only "Loading events...". This file is loaded with a blocking
 * <script> ahead of the page's own script, so the list is there in the first
 * render. The page then fetches the sheet as before and only redraws if
 * something has actually changed.
 *
 * It holds the sheet's own rows rather than the built events: the homepage
 * filters on the sheet's raw Category ("Folk Music", not the public label) and
 * works out its venue keys from the row's address, so it needs the row as the
 * sheet gives it.
 *
 * Only the rows from the Published tab are included, in the sheet's own order,
 * because that is exactly the list the homepage fetches for itself. Archive
 * rows are not on that CSV, so including them would put an event on the page
 * for a moment and then take it away again when the fetch arrived.
 *
 * Descriptions are left out - they are most of the weight of the sheet, and
 * the fetch fills them in.
 */
const EVENTS_DATA_FIELDS = ['EventID', 'Title', 'Category', 'Date', 'StartTime',
  'EndTime', 'Venue', 'Address', 'Lat', 'Lng', 'SourceURL'];

/** JSON that is safe in a script file whatever encoding it is served with. */
function asciiJson_(value) {
  return JSON.stringify(value).replace(/[\u007f-\uffff]/g, c =>
    '\\u' + ('0000' + c.charCodeAt(0).toString(16)).slice(-4));
}

function buildEventsData(events) {
  const rows = (events || [])
    .filter(ev => ev.source && ev.sourceIndex !== null && ev.sourceIndex !== undefined)
    .sort((a, b) => a.sourceIndex - b.sourceIndex)
    .map(ev => {
      const row = {};
      EVENTS_DATA_FIELDS.forEach(key => {
        const value = ev.source[key];
        row[key] = value === undefined || value === null ? '' : String(value);
      });
      return row;
    });

  const body = rows.map(row => '  ' + asciiJson_(row)).join(',\n');
  const list = body ? '[\n' + body + '\n]' : '[]';

  return '/* Generated by generate-events.js. Do not edit by hand.\n' +
    '   The upcoming events, as the sheet\'s rows, so the homepage can draw its\n' +
    '   list in the first render. index.html reads window.KIRN_EVENTS. */\n' +
    'window.KIRN_EVENTS = ' + list + ';\n';
}

/**
 * The past-events page, at /archive/.
 *
 * Events that have happened keep their own pages and their own URLs for six
 * months (see CONFIG.archiveRetentionMonths), but the events index lists only
 * what is still to come. Without this page those event pages are linked from
 * nowhere at all - they are in the sitemap and nothing else points at them -
 * which is exactly the shape Google treats as low-value and slow to crawl.
 *
 * The page lists the same set the build writes pages for, newest first, so it
 * cannot advertise an event whose page has already gone.
 */
function buildArchiveIndex(past) {
  const origin = CONFIG.siteOrigin;

  const ordered = (past || []).slice().sort((a, b) =>
    b.date.localeCompare(a.date) ||
    (b.startTime || '').localeCompare(a.startTime || '') ||
    a.title.localeCompare(b.title));

  const byMonth = new Map();
  for (const ev of ordered) {
    const d = parseDate(ev.date);
    if (!d) continue;
    const key = MONTHS[d.getUTCMonth()] + ' ' + d.getUTCFullYear();
    if (!byMonth.has(key)) byMonth.set(key, []);
    byMonth.get(key).push(ev);
  }

  const sections = [...byMonth.entries()].map(([month, list]) => {
    const items = list.map(ev => {
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

  const intro = ordered.length
    ? `${ordered.length} past events. <a href="/events/">Browse what is still to come</a>, ` +
      'or <a href="/">see them on the map</a>.'
    : 'No past events are listed at the moment. ' +
      '<a href="/events/">Browse what is still to come</a>.';

  return `<!DOCTYPE html>
<html lang="en-GB">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Past Folk &amp; Traditional Events in Newcastle | The Kirn</title>
<meta name="description" content="Folk, traditional music, ceilidh, session and heritage events that have already taken place across Newcastle and the North East.">
<link rel="canonical" href="${esc(origin + '/archive/')}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="The Kirn">
<meta property="og:title" content="Past Folk &amp; Traditional Events in Newcastle">
<meta property="og:description" content="Folk, traditional music, ceilidh, session and heritage events that have already taken place across Newcastle and the North East.">
<meta property="og:url" content="${esc(origin + '/archive/')}">
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
  <p>${intro}</p>
  <p class="jump">Jump to: ${months}</p>
${sections}
  <p><a href="/events/">&larr; Upcoming events</a></p>
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
/**
 * A short fingerprint of a rendered page, used to decide whether its
 * <lastmod> should move.
 *
 * FNV-1a over the UTF-16 code units, with the length appended so that two
 * different strings cannot collide just by landing on the same 32-bit value.
 * This only has to notice that a page changed between two builds; it is not a
 * security hash and does not need to be one.
 */
function contentHash_(text) {
  const s = String(text);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16) + '-' + s.length.toString(16);
}

/** The lastmod memory, or an empty one if it is missing or unreadable. */
function readLastmodState_(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (raw && raw.pages && typeof raw.pages === 'object') return raw.pages;
  } catch (err) {
    // First run, or a corrupt file. Every page is treated as new, which is
    // what the build did before this existed - so the worst case is the old
    // behaviour, never a missing sitemap.
  }
  return {};
}

/**
 * Keeps a page's lastmod only while its rendered HTML is unchanged.
 *
 * BEFORE: every URL in the sitemap carried today's date, because the build
 * stamped `todayStr()` on all of them. A sitemap where all 313 URLs changed
 * today, every day, is a signal Google learns to discount - so the one
 * freshness hint available was being thrown away.
 *
 * NOW: the date moves only when the page's content actually changes. The
 * memory lives in lastmod.json, which the workflow commits alongside the
 * pages. If that file is missing the result is the old behaviour, so this
 * cannot make the sitemap worse than it was.
 */
function lastmodFor_(url, html, previous, today) {
  const hash = contentHash_(html);
  const before = previous[url];
  if (before && before.hash === hash && before.lastmod) {
    return { hash: hash, lastmod: before.lastmod };
  }
  return { hash: hash, lastmod: today };
}

function buildSitemap(upcoming, past, lastmods) {
  const origin = CONFIG.siteOrigin;
  const dates = lastmods || {};
  const statics = [
    { loc: origin + '/', priority: '1.0', freq: 'daily' },
    { loc: origin + '/events/', priority: '0.9', freq: 'daily' },
    { loc: origin + '/archive/', priority: '0.6', freq: 'weekly' },
    { loc: origin + '/about/', priority: '0.5', freq: 'monthly' },
    { loc: origin + '/submit/', priority: '0.7', freq: 'monthly' },
    { loc: origin + '/contact/', priority: '0.3', freq: 'yearly' }
  ];

  // lastmod is optional, and is left out rather than guessed for the pages
  // this build does not render (the homepage, About, Submit, Contact).
  const lastmodLine = loc => dates[loc]
    ? `\n    <lastmod>${esc(dates[loc])}</lastmod>`
    : '';

  const eventUrl = ev => {
    const loc = origin + '/events/' + ev.slug + '/';
    return `  <url>\n    <loc>${esc(loc)}</loc>${lastmodLine(loc)}\n` +
      `    <changefreq>weekly</changefreq>\n    <priority>0.6</priority>\n  </url>`;
  };

  const urls = statics.map(s =>
    `  <url>\n    <loc>${esc(s.loc)}</loc>${lastmodLine(s.loc)}\n` +
    `    <changefreq>${s.freq}</changefreq>\n    <priority>${s.priority}</priority>\n  </url>`
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

  const rowsToBuild = published.concat(archived);

  for (let rowIndex = 0; rowIndex < rowsToBuild.length; rowIndex++) {
    const row = rowsToBuild[rowIndex];
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
      sourceUrl: row.SourceURL || '',
      // The row this event was built from, and where it sat in the Published
      // tab's CSV (null when it came from the Archive tab). buildEventsData()
      // publishes those rows in the sheet's own order, so the homepage starts
      // from exactly the list it would have fetched itself.
      source: row,
      sourceIndex: rowIndex < published.length ? rowIndex : null
    };

    // Must match venueKeyFor() in index.html so #venue= resolves to a marker.
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
    console.log('  ...and ' + expired.length + ' past event(s) that keep their pages ' +
      'and are listed on /archive/.');
    return;
  }

  // Render every page before writing anything. The sitemap dates pages from
  // what they actually render, so the text has to exist first.
  const rendered = events.map(ev => ({
    ev: ev,
    isPast: !isUpcoming(ev, today),
    url: CONFIG.siteOrigin + '/events/' + ev.slug + '/'
  }));
  rendered.forEach(page => { page.html = buildEventPage(page.ev, page.isPast); });

  const eventsUrl = CONFIG.siteOrigin + '/events/';
  const archiveUrl = CONFIG.siteOrigin + '/archive/';
  const eventsIndexHtml = buildEventsIndex(listed, expired.length);
  const archiveHtml = buildArchiveIndex(expired);

  // Carry forward each page's lastmod when nothing about it changed.
  const previous = readLastmodState_(CONFIG.lastmodPath);
  const nextState = {};
  const lastmods = {};
  const remember = (url, html) => {
    const entry = lastmodFor_(url, html, previous, today);
    lastmods[url] = entry.lastmod;
    nextState[url] = entry;
  };
  rendered.forEach(page => remember(page.url, page.html));
  remember(eventsUrl, eventsIndexHtml);
  remember(archiveUrl, archiveHtml);

  // Rebuild the events directory from scratch so stale pages disappear.
  fs.rmSync(CONFIG.eventsDir, { recursive: true, force: true });
  fs.mkdirSync(CONFIG.eventsDir, { recursive: true });

  for (const page of rendered) {
    const dir = path.join(CONFIG.eventsDir, page.ev.slug);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'index.html'), page.html, 'utf8');
  }

  fs.writeFileSync(path.join(CONFIG.eventsDir, 'index.html'), eventsIndexHtml, 'utf8');

  // The archive is rebuilt from scratch too, so it can never keep listing an
  // event whose page has fallen out of the retention window.
  fs.rmSync(CONFIG.archiveDir, { recursive: true, force: true });
  fs.mkdirSync(CONFIG.archiveDir, { recursive: true });
  fs.writeFileSync(path.join(CONFIG.archiveDir, 'index.html'), archiveHtml, 'utf8');

  // The homepage's own copy of what is still to come. Written after the pages
  // so a failed build cannot leave the homepage advertising an event whose
  // page was never written.
  fs.writeFileSync(CONFIG.eventsDataPath, buildEventsData(listed), 'utf8');

  fs.writeFileSync(CONFIG.sitemapPath, buildSitemap(listed, expired, lastmods), 'utf8');

  // Sorted keys so an unchanged build rewrites identical bytes and the
  // committed file stays diffable.
  const state = { version: 1, pages: {} };
  Object.keys(nextState).sort().forEach(url => { state.pages[url] = nextState[url]; });
  fs.writeFileSync(CONFIG.lastmodPath, JSON.stringify(state, null, 2) + '\n', 'utf8');

  console.log('Wrote ' + rendered.length + ' event pages (' + listed.length +
    ' upcoming and listed, ' + expired.length + ' past and kept), ' +
    'events/index.html, archive/index.html, events-data.js and sitemap.xml.');
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
  buildArchiveIndex: buildArchiveIndex,
  buildEventsData: buildEventsData,
  buildSitemap: buildSitemap,
  // Exported so the tests can check the structured-data helpers directly.
  londonOffsetSuffix_: londonOffsetSuffix_,
  postalAddress_: postalAddress_,
  performersFor_: performersFor_,
  contentHash_: contentHash_
};
