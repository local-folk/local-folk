#!/usr/bin/env node
/*
 * select-social-events.js
 *
 * Chooses which events go in each roundup and writes social-posts.json, the
 * input to generate-social-images.js.
 *
 * The rules, per the agreed specification:
 *
 *   Weekly  - Monday, covers Monday to Friday, one event per day, 5 maximum.
 *             Five weekdays means five lines; the cap is a ceiling, not a target.
 *   Weekend - Thursday, covers Friday to Saturday and Sunday, up to 6 events.
 *             One per day, then extra events on the days that have them.
 *
 * Selection is least-recently-posted-first, so no event repeats while others go
 * unmentioned. Events already recorded as Posted are excluded outright, which
 * also absorbs re-scrapes of the same source listing.
 *
 * Times are never consulted. An event qualifies on its date alone.
 *
 * The 8 recurring sessions are individually dated rows, so they compete like
 * anything else. Only one can land on a given day, which is what stops the
 * roundup filling with the same weekly session.
 *
 * Usage:
 *   node select-social-events.js              read the sheet, write social-posts.json
 *   node select-social-events.js --dry        report the choice, write nothing
 *   node select-social-events.js --record-only  record the current social-posts.json
 *                                           as posted, without re-selecting
 *   node select-social-events.js --from-file  read a local CSV instead of fetching
 *
 * Recording is a deliberate second step. Running selection again after
 * rendering would rotate to different events and leave the image and the
 * history disagreeing.
 */

'use strict';

const fs = require('fs');
const path = require('path');

// Identical to CONFIG.csvUrl in generate-events.js. Same Published tab.
const CSV_URL =
  'https://docs.google.com/spreadsheets/d/e/2PACX-1vRtJN8W8AwbpQfUMykoANi9RfW6XA8ghJ-F-vagUGkQ8Ep5PWTbyae6f45kLlCVEpwJS2Mg0U9eKdz4/pub?gid=514788102&single=true&output=csv';

const POSTED_LOG = path.join(__dirname, 'social', 'posted.json');
const OUTPUT = path.join(__dirname, 'social-posts.json');

const DAY_MS = 24 * 60 * 60 * 1000;

// Must stay identical to WEEKDAYS in generate-events.js.
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/* ------------------------------------------------------------------ *
 * Which post runs when
 * ------------------------------------------------------------------ */

// getUTCDay(): 0 = Sunday
const VARIANTS = {
  Weekly: {
    label: 'Weekly Roundup',
    runOn: 1,                 // Monday
    windowDays: [1, 2, 3, 4, 5],  // Monday to Friday
    maxEvents: 5,
    subtitle: 'Weekly Roundup'
  },
  Weekend: {
    label: 'Weekend Roundup',
    runOn: 4,                 // Thursday
    windowDays: [5, 6, 0],    // Friday, Saturday, Sunday
    maxEvents: 6,
    subtitle: 'Weekend Roundup'
  }
};

/* ------------------------------------------------------------------ *
 * CSV parsing - RFC4180-ish, matching generate-events.js
 * ------------------------------------------------------------------ */

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

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

  const header = rows[0].map((h) => h.trim());
  return rows
    .slice(1)
    .filter((r) => r.some((c) => String(c).trim() !== ''))
    .map((r) => {
      const obj = {};
      header.forEach((h, i) => { obj[h] = String(r[i] === undefined ? '' : r[i]).trim(); });
      return obj;
    });
}

function parseDate(dateStr) {
  const p = String(dateStr || '').split('-');
  if (p.length !== 3) return null;
  const d = new Date(Date.UTC(Number(p[0]), Number(p[1]) - 1, Number(p[2])));
  return isNaN(d.getTime()) ? null : d;
}

function startOfUtcDay(d) {
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/** "12/10" - day and month only, as used on the images. */
function formatDayMonth(d) {
  const dd = ('0' + d.getUTCDate()).slice(-2);
  const mm = ('0' + (d.getUTCMonth() + 1)).slice(-2);
  return dd + '/' + mm;
}

/** "121026" - for the archive filename. */
function formatCompact(d) {
  const dd = ('0' + d.getUTCDate()).slice(-2);
  const mm = ('0' + (d.getUTCMonth() + 1)).slice(-2);
  const yy = ('0' + d.getUTCFullYear()).slice(-2);
  return dd + mm + yy;
}

/* ------------------------------------------------------------------ *
 * Posted history
 *
 * Records which EventIDs have appeared in a roundup, and when. This is what
 * makes rotation work: an event never posted sorts ahead of one posted last week.
 * ------------------------------------------------------------------ */

function loadPosted() {
  if (!fs.existsSync(POSTED_LOG)) return {};
  try {
    return JSON.parse(fs.readFileSync(POSTED_LOG, 'utf8'));
  } catch (err) {
    console.warn('Could not read ' + POSTED_LOG + ' (' + err.message + '). Treating as empty.');
    return {};
  }
}

function eventKey(e) {
  return e.EventID || [e.Date, e.Venue, e.Title].join('|');
}

/* ------------------------------------------------------------------ *
 * Ranking
 *
 * The owner asked for events to be chosen by how good they are, not merely by
 * which day they fall on. Two signals, combined:
 *
 *   1. Category - the owner's stated order. Folk Music leads, Spoken Word
 *      next, then crafts and dance, then markets, with Music Session
 *      deliberately last. Sessions are 111 of 234 rows, so without this they
 *      would dominate every post.
 *
 *   2. Venue size - the stand-in for "is this a big deal". The sheet carries no
 *      popularity signal, but venue capacity is a good proxy: the Mary Wallopers
 *      at the O2 City Hall outranks a pub session on the same night. Ratings
 *      are inferred, not data.
 *
 * score = category * 10 - venueSize, so a lower score is better. Multiplying by
 * 10 guarantees category always outranks size, which is the owner's intent: a
 * Spoken Word event at the O2 still beats a Folk Music event in a pub.
 * ------------------------------------------------------------------ */

const CATEGORY_RANK = {
  'Folk Music': 1,
  'Spoken Word': 2,
  'Heritage Workshop': 3,
  'Ceilidh / Social Dance': 3.5,
  'Traditional Dance': 3.5,
  'Market': 4,
  'Music Session': 5,
  'Other': 6
};

/* Venue capacity, 1 (small) to 5 (large). Inferred - the sheet has no capacity
   data. Extend this when a notable venue appears; unknown venues fall back
   to 2, which is a reasonable guess for a pub. */
const VENUE_SIZE = {
  'O2 City Hall': 5,
  "King's Hall": 5,
  'Gosforth Civic Theatre': 5,
  'Tyne Theatre & Opera House': 5,
  'Glasshouse': 5,
  'Cluny 2': 4,
  'The Cluny 2': 4,
  'The Cluny': 4,
  'Cobalt Studios': 3,
  'The Brewery': 3,
  'Newcastle Quayside': 3,
  'Tyneside Irish Centre': 3,
  'Benedictine Social Centre': 3,
  'Enigma Tap': 3,
  'Lubber Fiend': 3,
  'Jarrow Hall': 3,
  'Newcastle Cathedral': 3,
  'BALTIC': 3,
  'Boiler Shop': 3,
  'Tyneside Cinema': 3,
  'Gateshead Masonic Hall': 2,
  'Cumberland Arms': 2,
  'Bridge Hotel': 2,
  'Wheatsheaf, Felling': 2,
  'Monkseaton Arms': 2,
  'Ouseburn Trust': 2,
  'Central Bar': 2,
  'The Lit & Phil': 2,
  'St Marys By The Tyne': 2,
  'The Hearth Arts Centre': 2,
  'Live Theatre': 2,
  'Blackfriars Restaurant': 1,
  'The Common Room': 1
};

// Lowercased, diacritics stripped, punctuation to spaces. This is what makes the
// sheet's inconsistent venue spellings ("Cluny 2", "The Cluny 2", "The Cluny")
// resolve to the same rating instead of three different fallbacks.
const normVenue = (s) => String(s || '')
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, ' ')
  .trim();

const NORMALISED_VENUE_SIZE = Object.keys(VENUE_SIZE).reduce((acc, key) => {
  acc[normVenue(key)] = VENUE_SIZE[key];
  return acc;
}, {});

function venueSize(venue) {
  const n = normVenue(venue);
  if (!n) return 2;

  if (NORMALISED_VENUE_SIZE[n] !== undefined) return NORMALISED_VENUE_SIZE[n];

  // Longest substring match, so "The Wheatsheaf, Felling" still finds its entry.
  let best = 2;
  let bestLen = 0;
  for (const key of Object.keys(NORMALISED_VENUE_SIZE)) {
    if (key.length > bestLen && n.includes(key)) {
      best = NORMALISED_VENUE_SIZE[key];
      bestLen = key.length;
    }
  }
  return best;
}

/* Lower is better. */
function rankOf(event) {
  const cat = CATEGORY_RANK[event.Category];
  const catRank = cat === undefined ? 6 : cat;
  return catRank * 10 - venueSize(event.Venue);
}

/* ------------------------------------------------------------------ *
 * Title clean-up
 *
 * Scraped titles carry their own punctuation: pipes used as separators, double
 * slashes, and the word "and" spelled out. On an image these read as noise, so
 * they are tidied to match the house style.
 *
 * Applied to the title and venue only, never to anything the pipeline needs.
 * EventID, Date and the rotation key come from the raw values, so cleaning the
 * display text cannot affect deduplication.
 * ------------------------------------------------------------------ */

function tidyText(value) {
  let s = String(value == null ? '' : value);

  // Double slashes become a hyphen: "Fresh Thursday // Right of Way" reads
  // better as "Fresh Thursday - Right of Way" than with the slashes left in.
  s = s.replace(/\s*\/\/\s*/g, ' - ');

  // Pipes become hyphens, matching the title-to-venue separator.
  s = s.replace(/\s*\|\s*/g, ' - ');

  // Whole-word "and" only. A bare replace would turn "Anderson" into "&erson".
  s = s.replace(/\band\b/g, '&');

  // Collapse runs of separators and spaces that the above leaves behind,
  // e.g. "A - - B", "A &  B", or a separator now stranded at an edge.
  s = s.replace(/\s*-\s*-\s*/g, ' - ');
  s = s.replace(/[ \t]{2,}/g, ' ');
  s = s.replace(/^\s*-\s*/, '');
  s = s.replace(/\s*-\s*$/, '');

  return s.replace(/\s+/g, ' ').trim();
}

/* ------------------------------------------------------------------ *
 * Selection
 * ------------------------------------------------------------------ */

/**
 * Pick events for one variant.
 *
 * For each day in the window, candidates are ordered least-recently-posted
 * first and the first one wins. Extra weekend slots then go to days that still
 * have unposted candidates, working through the days in date order.
 */
function selectFor(variant, events, posted, now) {
  const today = new Date(startOfUtcDay(now));
  const todayDow = today.getUTCDay();

  // The window opens on the next occurrence of each weekday, so a Monday run
  // looks at this week and a Thursday run looks at the coming weekend.
  // Window resolution.
  //
  // The window is the next occurrence of each weekday in the roundup's list,
  // so a Monday run covers Monday to Friday of the current week (0 to +4 days)
  // and a Thursday run covers Friday to Sunday (+1 to +3 days).
  //
  // Consequence worth knowing: the Monday post is generated at 03:17 UTC on the
  // Monday itself, so its earliest event is the same day and it never reaches
  // beyond Friday of that week. The weekend post, running Thursday, picks up the
  // Friday that the weekly post also listed. Rotation handles the overlap -
  // see section 3 of the spec.
  const offsets = [];
  for (const dow of variant.windowDays) {
    const delta = (dow - todayDow + 7) % 7;
    offsets.push({ dow, offset: delta });
  }
  offsets.sort((a, b) => a.offset - b.offset);

  const picked = [];
  const usedKeys = new Set();

  const candidatesFor = (dateMs) => {
    return events
      .filter((e) => {
        const d = parseDate(e.Date);
        return d && startOfUtcDay(d) === dateMs;
      })
      .map((e) => {
        const key = eventKey(e);
        const last = posted[key];
        return {
          event: e,
          key,
          rank: rankOf(e),
          lastPosted: last || null,
          recency: last ? Date.parse(last) : 0
        };
      })
      .filter((c) => !usedKeys.has(c.key))
      .sort((a, b) => {
        // Rank first: category, then venue size.
        if (a.rank !== b.rank) return a.rank - b.rank;
        // Rotation only breaks ties within the same rank, so two similarly
        // prominent gigs alternate instead of the same one repeating weekly,
        // while a genuinely bigger event still wins outright.
        if (a.lastPosted === null && b.lastPosted !== null) return -1;
        if (b.lastPosted === null && a.lastPosted !== null) return 1;
        if (a.recency !== b.recency) return a.recency - b.recency;
        return String(a.event.Title || '').localeCompare(String(b.event.Title || ''));
      });
  };

  // Pass one: one event per day.
  for (const { dow, offset } of offsets) {
    const dateMs = today.getTime() + (offset * DAY_MS);
    const candidates = candidatesFor(dateMs);
    if (candidates.length === 0) continue;

    const chosen = candidates[0];
    usedKeys.add(chosen.key);
    picked.push({
      date: new Date(dateMs),
      event: chosen.event,
      key: chosen.key,
      rank: chosen.rank,
      size: venueSize(chosen.event.Venue)
    });
  }

  // Two passes. Pass one gives every day one event. Pass two sweeps the window
  // again, so a day that had three events can take a second. Without the sweep
  // the weekend would stop at one event per day (3) instead of the agreed 6.
  for (let pass = 0; pass < 2; pass++) {
    let swept = false;

    for (const { offset } of offsets) {
      if (picked.length >= variant.maxEvents) break;

      const dateMs = today.getTime() + (offset * DAY_MS);
      const candidates = candidatesFor(dateMs);
      if (candidates.length === 0) continue;

      const chosen = candidates[0];
      usedKeys.add(chosen.key);
      picked.push({
        date: new Date(dateMs),
        event: chosen.event,
        key: chosen.key,
        rank: chosen.rank,
        size: venueSize(chosen.event.Venue)
      });
      swept = true;
    }

    if (picked.length >= variant.maxEvents) break;
    if (!swept) break;
  }

  // Trim to the cap, keeping date order.
  picked.sort((a, b) => a.date - b.date);
  const trimmed = picked.slice(0, variant.maxEvents);

  // Group by day, skipping days with nothing.
  const grouped = [];
  for (const item of trimmed) {
    const heading = WEEKDAYS[item.date.getUTCDay()].toUpperCase() + ' - ' + formatDayMonth(item.date);
    // Title and venue stay separate so the image can put the venue on its own
    // line underneath. Tidied independently, which also shortens the widest
    // line the renderer has to fit.
    const entry = {
      title: tidyText(item.event.Title),
      venue: tidyText(item.event.Venue),
      // Kept alongside for the console report, so it is clear why an event
      // was chosen. Not used by the renderer.
      rank: item.rank,
      size: item.size,
      category: item.event.Category
    };

    let bucket = grouped.find((g) => g.day === heading);
    if (!bucket) {
      bucket = { day: heading, events: [] };
      grouped.push(bucket);
    }
    bucket.events.push(entry);
  }

  return { grouped, trimmed };
}

/* ------------------------------------------------------------------ *
 * Main
 * ------------------------------------------------------------------ */

async function loadCsv() {
  if (process.argv.includes('--from-file')) {
    const local = path.join(__dirname, 'published.csv');
    if (!fs.existsSync(local)) {
      throw new Error('--from-file given but ' + local + ' does not exist.');
    }
    return fs.readFileSync(local, 'utf8');
  }
  const res = await fetch(CSV_URL);
  if (!res.ok) {
    throw new Error('Sheet fetch failed: HTTP ' + res.status + '. Use --from-file with a saved CSV.');
  }
  return res.text();
}

async function main() {
  const dry = process.argv.includes('--dry');
  const recordOnly = process.argv.includes('--record-only');
  const now = new Date();
  const dow = now.getUTCDay();

  console.log('Today: ' + now.toISOString().slice(0, 10) + ' (' + WEEKDAYS[dow] + ', UTC)');
  console.log('');

  const csv = await loadCsv();
  const rows = parseCsv(csv);
  console.log('Read ' + rows.length + ' rows from the Published tab.');
  console.log('');

  const posted = loadPosted();
  console.log('History: ' + Object.keys(posted).length + ' event(s) previously posted.');
  console.log('');

  // --record-only: read back what the earlier step chose and record it, rather
  // than re-running selection. Re-running would rotate away from the very
  // events just rendered.
  if (recordOnly) {
    if (!fs.existsSync(OUTPUT)) {
      console.log('No social-posts.json, so nothing to record.');
      return;
    }
    const chosen = JSON.parse(fs.readFileSync(OUTPUT, 'utf8'));
    const stamp = now.toISOString();
    let n = 0;
    for (const post of chosen.posts || []) {
      for (const ev of post.events || []) {
        posted[ev.eventId] = stamp;
        n++;
      }
    }
    fs.mkdirSync(path.dirname(POSTED_LOG), { recursive: true });
    fs.writeFileSync(POSTED_LOG, JSON.stringify(posted, null, 2) + '\n', 'utf8');
    console.log('Recorded ' + n + ' event(s) from this run. History now ' +
      Object.keys(posted).length + ' entries.');
    return;
  }

  const posts = [];

  for (const name of Object.keys(VARIANTS)) {
    const variant = VARIANTS[name];

    // Which variants are due today.
    const isDue = dow === variant.runOn;
    if (!isDue && !process.argv.includes('--all')) {
      console.log('SKIP  ' + variant.label + ' - runs on ' + WEEKDAYS[variant.runOn] + 's.');
      continue;
    }

    const { grouped, trimmed } = selectFor(variant, rows, posted, now);

    if (grouped.length === 0) {
      console.log('SKIP  ' + variant.label + ' - no events in the window.');
      continue;
    }

    const first = trimmed[0].date;
    posts.push({
      variant: name,
      subtitle: variant.subtitle,
      dateLabel: formatCompact(first),
      rows: grouped,
      events: trimmed.map((t) => ({
        eventId: t.key,
        date: t.date.toISOString().slice(0, 10),
        title: t.event.Title || '',
        venue: t.event.Venue || ''
      }))
    });

    console.log('OK    ' + variant.label + ' - ' + trimmed.length + ' event(s), cap ' + variant.maxEvents);
    for (const g of grouped) {
      for (const e of g.events) {
        const combined = [e.title, e.venue].filter(Boolean).join(' - ');
        const meta = 'rank ' + e.rank.toFixed(1) + '  size ' + e.size + '  ' + e.category;
        console.log('        ' + g.day + '  ' + combined);
        console.log('                 ' + meta);
      }
    }
    console.log('');
  }

  if (posts.length === 0) {
    console.log('Nothing due today. Nothing written.');
    return;
  }

  if (dry) {
    console.log('Dry run. Nothing written.');
    return;
  }

  fs.writeFileSync(OUTPUT, JSON.stringify({ posts }, null, 2) + '\n', 'utf8');
  console.log('Wrote ' + path.relative(__dirname, OUTPUT));

  // Recording is a separate step (--record-only) so that selection is never
  // re-run after rendering, which would rotate to different events.
  console.log('Now run:  npm run images');
  console.log('Then:     node select-social-events.js --record-only');
}

main().catch((err) => {
  console.error('Failed: ' + err.message);
  process.exitCode = 1;
});
