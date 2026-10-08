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
  csvUrl:
    'https://docs.google.com/spreadsheets/d/e/2PACX-1vRtJN8W8AwbpQfUMykoANi9RfW6XA8ghJ-F-vagUGkQ8Ep5PWTbyae6f45kLlCVEpwJS2Mg0U9eKdz4/pub?gid=514788102&single=true&output=csv',
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

function buildEventPage(ev) {
  const origin = CONFIG.siteOrigin;
  const url = origin + '/events/' + ev.slug + '/';

  const dateLong = formatDateLong(ev.date);
  const time = formatTime(ev.startTime);
  const timeRange = ev.startTime
    ? (ev.endTime ? time + ' – ' + formatTime(ev.endTime) : time)
    : '';
  const whenLine = [dateLong, timeRange].filter(Boolean).join(', ');

  const showMoreInfo = !isGenericListingLink(ev.sourceUrl) && isSafeUrl(ev.sourceUrl);

  const title = clamp(ev.title + ' – ' + (ev.venue || 'Newcastle'), 58) + ' | The Kirn';
  const shareTitle = ev.title + (ev.venue ? ' – ' + ev.venue : '');
  const shareText = [ev.title, ev.venue, formatDateShort(ev.date), time]
    .filter(Boolean).join(', ');

  const metaDesc = clamp(
    [whenLine, ev.venue, ev.description].filter(Boolean).join('. ') + '.', 158);

  const lat = parseFloat(ev.lat);
  const lng = parseFloat(ev.lng);
  const hasGeo = !isNaN(lat) && !isNaN(lng);
  const mapUrl = hasGeo
    ? 'https://www.google.com/maps/search/?api=1&query=' + lat + ',' + lng
    : null;

  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'Event',
    name: ev.title,
    startDate: ev.date + (ev.startTime ? 'T' + padTime(ev.startTime) : ''),
    eventStatus: 'https://schema.org/EventScheduled',
    eventAttendanceMode: 'https://schema.org/OfflineEventAttendanceMode',
    url: url,
    description: ev.description || shareText,
    inLanguage: 'en-GB'
  };
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

  const homeHref = origin + '/?event=' + encodeURIComponent(ev.favId);

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
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--text);
    font-family: -apple-system, Segoe UI, Roboto, Arial, sans-serif;
    line-height: 1.55;
  }
  header { background: var(--band); padding: 14px 16px; text-align: center; }
  header h1 { margin: 0; font-size: 1.9rem; font-family: 'IM Fell English', Georgia, serif; }
  header a { color: var(--onband); text-decoration: none; }
  main { max-width: 660px; margin: 0 auto; padding: 26px 18px 60px; }
  .chip {
    display: inline-block; background: var(--chip); border: 1px solid var(--line);
    border-radius: 12px; padding: 2px 12px; font-size: .82rem; margin-bottom: 14px;
  }
  h2.title {
    font-family: 'IM Fell English', Georgia, serif;
    font-size: clamp(1.7rem, 5.2vw, 2.4rem); font-weight: 400;
    margin: 0 0 14px; line-height: 1.2;
  }
  .line { margin: 0 0 10px; }
  .venue { font-weight: 600; }
  .muted { color: #6b4a3a; }
  .actions { display: flex; flex-wrap: wrap; gap: 10px; margin: 22px 0 8px; }
  .btn {
    display: inline-block; padding: 9px 16px; border-radius: 8px;
    border: 1px solid var(--line); background: #fff; color: var(--text);
    text-decoration: none; font-size: .95rem; cursor: pointer; font-family: inherit;
  }
  .btn.primary { background: var(--band); border-color: var(--band); color: var(--onband); }
  .btn:hover { text-decoration: underline; }
  hr { border: 0; border-top: 1px solid var(--line); margin: 26px 0 18px; }
  .more { margin-top: 26px; }
  footer { border-top: 1px solid var(--line); padding: 18px; text-align: center; font-size: .9rem; }
  footer a { color: var(--link); }
</style>
<script type="application/ld+json">
${JSON.stringify(jsonLd, null, 2)}
</script>
</head>
<body>
<header><h1><a href="/">The Kirn</a></h1></header>
<main>
${ev.category ? '  <span class="chip">' + esc(ev.category) + '</span>\n' : ''}  <h2 class="title">${esc(ev.title)}</h2>
  <p class="line"><strong>${esc(whenLine)}</strong></p>
${ev.venue ? '  <p class="line venue">' + esc(ev.venue) + '</p>\n' : ''}${ev.address ? '  <p class="line muted">' + esc(ev.address) + '</p>\n' : ''}${ev.description ? '  <p class="line">' + esc(ev.description) + '</p>\n' : ''}  <div class="actions">
    <button class="btn primary" id="shareBtn" type="button">Share this event</button>
    <a class="btn" href="${esc(homeHref)}">See on the map</a>
${mapUrl ? '    <a class="btn" href="' + esc(mapUrl) + '" target="_blank" rel="noopener noreferrer">Directions</a>\n' : ''}  </div>
${showMoreInfo ? '  <p class="more"><a class="btn" href="' + esc(ev.sourceUrl) + '" target="_blank" rel="noopener noreferrer">More info</a></p>\n' : ''}  <hr>
  <p class="muted">Listed on The Kirn, a collection of folk and traditional events across Newcastle and the North East.</p>
  <p><a href="/">&larr; All events</a></p>
</main>
<footer>
  <p><a href="/">thekirn.co.uk</a></p>
</footer>
<script>
(function () {
  var btn = document.getElementById('shareBtn');
  if (!btn) return;
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
})();
</script>
</body>
</html>
`;
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
      const time = formatTime(ev.startTime);
      return `    <li><a href="/events/${esc(ev.slug)}/">${esc(ev.title)}</a>` +
        (time ? ` <span class="muted">${esc(time)}</span>` : '') +
        (ev.venue ? ` <span class="muted">– ${esc(ev.venue)}</span>` : '') +
        `</li>`;
    }).join('\n');
    return `  <h2>${esc(month)}</h2>\n  <ul>\n${items}\n  </ul>`;
  }).join('\n');

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
  header h1 { margin:0; font-size:1.9rem; font-family:'IM Fell English', Georgia, serif; }
  header a { color:#ffffea; text-decoration:none; }
  main { max-width:720px; margin:0 auto; padding:26px 18px 60px; }
  h2 { font-family:'IM Fell English', Georgia, serif; font-weight:400;
    font-size:1.5rem; margin:28px 0 10px; }
  ul { list-style:none; padding:0; margin:0; }
  li { padding:8px 0; border-bottom:1px solid #c9c2a0; }
  a { color:#b82e00; }
  .muted { color:#6b4a3a; font-size:.9rem; }
  footer { border-top:1px solid #c9c2a0; padding:18px; text-align:center; font-size:.9rem; }
</style>
</head>
<body>
<header><h1><a href="/">The Kirn</a></h1></header>
<main>
  <p>${events.length} upcoming events. <a href="/">Browse them on the map</a>.</p>
${sections}
  <p><a href="/">&larr; All events</a></p>
</main>
<footer><p><a href="/">thekirn.co.uk</a></p></footer>
</body>
</html>
`;
}

function buildSitemap(events) {
  const origin = CONFIG.siteOrigin;
  const today = todayStr();
  const statics = [
    { loc: origin + '/', priority: '1.0', freq: 'daily' },
    { loc: origin + '/events/', priority: '0.9', freq: 'daily' },
    { loc: origin + '/about/', priority: '0.5', freq: 'monthly' },
    { loc: origin + '/submit/', priority: '0.7', freq: 'monthly' },
    { loc: origin + '/contact/', priority: '0.3', freq: 'yearly' }
  ];
  const urls = statics.map(s =>
    `  <url>\n    <loc>${esc(s.loc)}</loc>\n    <lastmod>${today}</lastmod>\n    <changefreq>${s.freq}</changefreq>\n    <priority>${s.priority}</priority>\n  </url>`
  ).concat(events.map(ev =>
    `  <url>\n    <loc>${esc(origin + '/events/' + ev.slug + '/')}</loc>\n    <lastmod>${today}</lastmod>\n    <changefreq>weekly</changefreq>\n    <priority>0.6</priority>\n  </url>`
  ));
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('\n')}\n</urlset>\n`;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log('Fetching CSV…');
  const res = await fetch(CONFIG.csvUrl);
  if (!res.ok) throw new Error('CSV fetch failed: HTTP ' + res.status);
  const text = await res.text();
  const rows = parseCsv(text);
  console.log('Parsed ' + rows.length + ' rows.');

  const today = todayStr();

  // Keep only published, upcoming, well-formed events.
  const kept = rows.filter(r =>
    r.Title && r.Date &&
    String(r.Status || 'Published').trim().toLowerCase() === 'published' &&
    /^\d{4}-\d{2}-\d{2}$/.test(r.Date.trim()) &&
    r.Date.trim() >= today);

  const droppedPast = rows.filter(r => r.Date && r.Date.trim() < today).length;
  console.log('Kept ' + kept.length + ' upcoming events (' + droppedPast + ' past events dropped).');

  // Build events, de-duplicating slugs.
  const used = new Map();
  const events = [];
  let collisions = 0;
  let slugMismatches = 0;

  for (const row of kept) {
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

    events.push({
      slug,
      favId: favId(row),
      title: row.Title,
      description: row.Description || '',
      category: row.Category || '',
      date: row.Date.trim(),
      startTime: (row.StartTime || '').trim(),
      endTime: (row.EndTime || '').trim(),
      venue: row.Venue || '',
      address: row.Address || '',
      lat: row.Lat,
      lng: row.Lng,
      sourceUrl: row.SourceURL || ''
    });
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

  if (CONFIG.dryRun) {
    console.log('\n--dry-run: nothing written. First 5 slugs:');
    events.slice(0, 5).forEach(ev => console.log('  /events/' + ev.slug + '/'));
    return;
  }

  // Rebuild the events directory from scratch so stale pages disappear.
  fs.rmSync(CONFIG.eventsDir, { recursive: true, force: true });
  fs.mkdirSync(CONFIG.eventsDir, { recursive: true });

  let written = 0;
  for (const ev of events) {
    const dir = path.join(CONFIG.eventsDir, ev.slug);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'index.html'), buildEventPage(ev), 'utf8');
    written++;
  }
  fs.writeFileSync(path.join(CONFIG.eventsDir, 'index.html'), buildEventsIndex(events), 'utf8');
  fs.writeFileSync(CONFIG.sitemapPath, buildSitemap(events), 'utf8');

  console.log('Wrote ' + written + ' event pages, events/index.html and sitemap.xml.');
}

main().catch(err => {
  console.error('FAILED: ' + err.message);
  process.exit(1);
});
