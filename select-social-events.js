#!/usr/bin/env node
/*
 * select-social-events.js
 *
 * Chooses which events go in each roundup and writes social-posts.json, the
 * input to generate-social-images.js.
 *
 * The rules, per the agreed specification:
 *
 *   Weekly  - runs Monday, covers Monday to Friday, one event per day, 5 maximum.
 *             Five weekdays means five lines; the cap is a ceiling, not a target.
 *             A Sunday to Wednesday run covers that Monday to Friday; a
 *             Thursday to Saturday run covers the coming one (windowStartFor).
 *   Weekend - runs Friday, covers Friday to Sunday, up to 6 events.
 *             One per day, then extra events on the days that have them. A
 *             Thursday to Saturday run covers that weekend; a Sunday to
 *             Wednesday run covers the coming one.
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
    // CHANGED 13 October 2026: Thursday (4) -> Friday (5), at the owner's
    // request. The Weekend roundup is now built, emailed and posted on a Friday
    // rather than being built on Thursday and waiting over a day.
    runOn: 5,                 // Friday
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

/* Is this title specific enough to post on its own?
 *
 * Used only as a final tie-break, when two events score identically and neither
 * has been posted before. "Student Performances" names no performers and is a
 * generic listing; "Fresh Thursday // Right of Way + Raveloe" names two acts.
 * Between equals, the one naming who is playing is the better post.
 *
 * Deliberately conservative - it only rejects the obviously generic. Anything
 * unfamiliar is treated as specific, so this cannot quietly drop a good event.
 */
function namesPerformers_(title) {
  const t = String(title || '').trim();
  if (!t) return false;

  // Has a digit: "Singaround at 12:30", a date, a price.
  if (/\d/.test(t)) return true;

  // Two or more words, and not one of the generic listings.
  const generic = [
    /^student performances?$/i,
    /^performances?$/i,
    /^live music$/i,
    /^music$/i,
    /^gig$/i,
    /^festival$/i,
    /^open mic$/i,
    /^session$/i,
    /^singaround$/i,
    /^singaround \/ .+$/i
  ];
  if (generic.some((re) => re.test(t))) return false;

  // Capitalised words usually indicate proper nouns (band or artist names).
  const properNouns = (t.match(/\b[A-Z][a-z]+/g) || []).length;
  return properNouns >= 2;
}

/* ------------------------------------------------------------------ *
 * Rotation history and posts that never went out
 * ------------------------------------------------------------------ */

/* Which posts actually reached a platform?
 *
 * The queue file records every post that has been drafted, including drafts
 * that were never approved and never posted. But rotation history used to be
 * written at RENDER time, from social-posts.json - so simply generating a draft
 * consumed the events in it, whether or not anyone ever posted them.
 *
 * That is how "Fresh Thursday // Right of Way + Raveloe" ended up excluded from
 * the Monday 12 October roundup on the 9th: a draft had been rendered for it
 * and recorded, but no post was ever published, and rotation then treated it as
 * already-used.
 *
 * The fix is to reconcile history against what was really published rather
 * than against what was merely generated. social/queue.json is committed and
 * holds the Status the Apps Script publishes with, so it is the record of
 * truth.
 *
 * Returns true when the queue proves the post was published, or when there is no
 * record at all - a genuine first run, where being pessimistic would wipe real
 * history.
 */
function postWasPublished_(queue, postId) {
  if (!queue || !queue.posts || !queue.posts.length) return true; // no record yet
  const row = queue.posts.find((p) => p.PostID === postId);
  if (!row) return true; // not in the current queue; leave history alone
  return row.Status === 'Posted';
}

/* Drops rotation entries belonging to posts that were drafted but never
 * published, so the events in them become selectable again.
 *
 * Only entries OLDER than the newest published post are considered. Anything
 * more recent belongs to a post still in flight - generated this morning,
 * awaiting approval - and forgetting it would let the same events be selected
 * again for the very post that is waiting to be approved. */
function forgetUnpublishedPosts_(posted) {
  let queue;
  try {
    const q = path.join(__dirname, 'social', 'queue.json');
    if (!fs.existsSync(q)) return;
    queue = JSON.parse(fs.readFileSync(q, 'utf8'));
  } catch (err) {
    return;
  }

  const unpublished = (queue.posts || []).filter((p) => !postWasPublished_(queue, p.PostID));
  if (!unpublished.length) return;

  const drafts = unpublished.map((p) => {
    return String(p.EventIDs || '').split(',').map((s) => s.trim()).filter(Boolean);
  });
  const draftKeys = new Set([].concat.apply([], drafts));

  const newestPublished = (queue.posts || [])
    .filter((p) => postWasPublished_(queue, p.PostID))
    .map((p) => Date.parse(p.ScheduledFor))
    .filter((t) => !isNaN(t))
    .sort((a, b) => b - a)[0];

  let freed = 0;
  for (const key of draftKeys) {
    if (!posted[key]) continue;
    // Still leave anything at or after the newest published post alone.
    if (newestPublished && Date.parse(posted[key]) >= newestPublished) continue;
    delete posted[key];
    freed++;
  }

  if (!freed) return;

  fs.writeFileSync(POSTED_LOG, JSON.stringify(posted, null, 2) + '\n', 'utf8');
  console.log('Freed ' + freed + ' event(s) from draft(s) never published: ' +
    unpublished.map((p) => p.PostID).join(', '));
  console.log('Those events can be selected again.');
  console.log('');
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
  // LOWERED from 5 to 3 on 12 October 2026.
  //
  // King's Hall is a university concert hall, big but not a music venue in the
  // way the O2 or the Glasshouse are. Rated 5 it outranked a named folk act at
  // Cobalt Studios purely on room size, so the Thursday 15 October slot went to
  // a generic "Student Performances" listing instead of
  // "Fresh Thursday // Right of Way + Raveloe".
  //
  // 3 now matches the dedicated folk and community venues. Raise it if genuine
  // big-name bookings there warrant it.
  "King's Hall": 3,
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

  // CHANGED 12 October 2026: "Fresh Thursday // Right of Way + Raveloe" now
  // keeps its double slashes, because the owner puts them there to separate the
  // two named acts and they are part of the event's own naming. They used to be
  // rewritten to a hyphen here, which silently altered the event's name on the
  // image and in the caption.
  //
  // Pipes are still tidied, which is a different case - "Halloween Thoughts |
  // The Fairy..." is a scraping artefact rather than a name.

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
 * The Monday (weekly) or Friday (weekend) that anchors the roundup period.
 *
 * The period is used while at most half of it has passed. That keeps the dates
 * stable when a post is generated a day or two late, instead of sliding the
 * whole window forward:
 *
 *   Weekly  (Mon-Fri)  Sun-Wed -> that week's Monday-Friday
 *                      Thu-Sat -> the coming week's Monday-Friday
 *   Weekend (Fri-Sun)  Thu-Sat -> that weekend's Friday-Sunday
 *                      Sun-Wed -> the coming weekend's Friday-Sunday
 *
 * Sunday has no Monday in its own week, so "that week" starts the next day.
 * After that, the next occurrence wins.
 */
function windowStartFor(variant, today) {
  const firstDow = variant.windowDays[0];                       // Monday or Friday
  const lag = Math.floor((variant.windowDays.length - 1) / 2);  // 2 or 1
  const target = startOfUtcDay(today) - (lag * DAY_MS);
  const targetDow = new Date(target).getUTCDay();
  return new Date(target + (((firstDow - targetDow + 7) % 7) * DAY_MS));
}

/**
 * Pick events for one variant.
 *
 * The window is fixed by windowStartFor(): the whole Monday-Friday or
 * Friday-Sunday period, even when the post is generated partway through it.
 *
 * Events are only chosen from today onwards. A Tuesday run still promises
 * Monday-Friday, but Monday's events have gone and must not be posted as if
 * they were still to come.
 *
 * For each selectable day, candidates are ordered least-recently-posted first
 * and the first one wins. Extra weekend slots then go to days that still have
 * unposted candidates, working through the days in date order.
 */
function selectFor(variant, events, posted, now) {
  const today = new Date(startOfUtcDay(now));
  const windowStart = windowStartFor(variant, today);

  // The full window, past days included. The header prints all of it.
  const windowDates = [];
  for (let i = 0; i < variant.windowDays.length; i++) {
    windowDates.push(new Date(windowStart.getTime() + (i * DAY_MS)));
  }

  // But only today and later can be posted.
  const selectable = windowDates.filter((d) => d.getTime() >= today.getTime());

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
        // Final tie-break. Alphabetical was arbitrary - it made the choice
        // depend on the letter an event's title began with, so on 12 October
        // "Student Performances" beat "Fresh Thursday" purely because S > F.
        // Specific beats generic instead: an event naming its performers is a
        // better thing to post than "Student Performances", which names nobody.
        const aNamed = namesPerformers_(a.event.Title);
        const bNamed = namesPerformers_(b.event.Title);
        if (aNamed !== bNamed) return aNamed ? -1 : 1;
        return String(a.event.Title || '').localeCompare(String(b.event.Title || ''));
      });
  };

  // Every candidate per day, in ranked order - not just the ones picked.
  //
  // Added 13 October 2026. The owner asked to see what the post could have
  // contained as well as what it does contain, so the approval page can offer
  // alternatives. The chosen events were being thrown away here, along with
  // the reasoning behind them, so this keeps the whole field per day.
  const candidatesByDay = [];

  // Pass one: one event per day.
  for (const date of selectable) {
    const dateMs = date.getTime();
    const candidates = candidatesFor(dateMs);

    candidatesByDay.push({
      date: date.toISOString().slice(0, 10),
      day: WEEKDAYS[date.getUTCDay()],
      events: candidates.map(function (c) {
        return {
          eventId: c.key,
          title: tidyText(c.event.Title),
          venue: tidyText(c.event.Venue),
          category: c.event.Category,
          rank: c.rank,
          size: venueSize(c.event.Venue),
          lastPosted: c.lastPosted
        };
      })
    });

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

    for (const date of selectable) {
      if (picked.length >= variant.maxEvents) break;

      const dateMs = date.getTime();
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

  // The roundup's own window: every day it covers, whether or not an event was
  // chosen for that day and whether or not that day has already passed. The
  // header prints this, so a quiet Thursday cannot shorten "26-30 OCT" to
  // "26-28 OCT", and a Tuesday run still says Monday-Friday.
  const window = windowDates.map((d) => d.toISOString().slice(0, 10));

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

  return { grouped, trimmed, candidatesByDay, window };
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

  // Forget events from posts that never went out. See the note on
  // postWasPublished() below: rotation history has to mean "appeared in a
  // published post", or a draft nobody approved permanently pushes good events
  // down the list.
  forgetUnpublishedPosts_(posted);

  const posts = [];

  for (const name of Object.keys(VARIANTS)) {
    const variant = VARIANTS[name];

    // Which variants are due today.
    const isDue = dow === variant.runOn;
    if (!isDue && !process.argv.includes('--all')) {
      console.log('SKIP  ' + variant.label + ' - runs on ' + WEEKDAYS[variant.runOn] + 's.');
      continue;
    }

    const { grouped, trimmed, candidatesByDay, window } = selectFor(variant, rows, posted, now);

    if (grouped.length === 0) {
      console.log('SKIP  ' + variant.label + ' - no events in the window.');
      continue;
    }

    const first = trimmed[0].date;
    posts.push({
      variant: name,
      subtitle: variant.subtitle,
      dateLabel: formatCompact(first),
      // The dates the roundup covers, independent of which of them have an
      // event. The header must show the whole window, not just the busy days.
      window: window,
      rows: grouped,
      // The whole field per day, so the approval page can offer alternatives.
      // Populated 13 October 2026.
      candidatesByDay: candidatesByDay,
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

/* Run as a script (the workflow and npm scripts do). Requiring the module, as
 * the tests do, must not run a selection. */
if (require.main === module) {
  main().catch((err) => {
    console.error('Failed: ' + err.message);
    process.exitCode = 1;
  });
}

module.exports = { selectFor, VARIANTS };