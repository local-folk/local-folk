#!/usr/bin/env node
/*
 * apply-choices.js  (local step - not uploaded to the repository)
 *
 * Applies the owner's event choices, if any are waiting, to social-posts.json.
 *
 * THE CACHE, AND WHY THERE IS NO --wait IN THE WORKFLOW
 * ------------------------------------------------------
 * Google serves a published CSV with `Cache-Control: private, max-age=300`.
 * Apps Script saves the owner's choice and starts the rebuild about a second
 * apart, so the workflow was reading the sheet as it was BEFORE the owner
 * pressed Approve - no waiting choices, and a rebuild with the old events under
 * the old PostID. Nothing errored and no second email arrived.
 * (Observed 14 October 2026.)
 *
 * The fix is in Apps Script: requestRegeneration_ schedules the rebuild six
 * minutes out rather than firing it immediately, so this script always reads a
 * settled sheet. That was chosen over polling here because it costs only the
 * swaps that need it, and it needs no change to this repository.
 *
 * --wait still exists below for offline testing of a deliberately early read. It
 * is NOT used by generate-social-images.yml.
 *
 * WHY THIS EXISTS
 * ---------------
 * The approval page is a chooser: it lists every candidate event for every day
 * with the generated picks already ticked. If the owner changes something and
 * presses Approve, Apps Script saves the choice and triggers a rebuild. This is
 * the GitHub half of that round trip.
 *
 * The rebuild regenerates the post from scratch - selection, image, caption -
 * because the image has the events printed on it. A post published with the old
 * image and a new list would put words on Facebook that are not in the picture,
 * which is the one thing this whole design exists to prevent.
 *
 * WHERE THE CHOICES COME FROM
 * ---------------------------
 * A published Google Sheet, NOT the repository. Apps Script holds a
 * trigger-only GitHub token and cannot push, so the choices travel out of
 * Apps Script as a public sheet the workflow fetches. That keeps the token from
 * being able to alter anything - see SOCIAL-POST-CHOICES.md.
 *
 * The sheet has three columns:
 *   PostID | Requested | Picks
 * where Picks is a comma-separated list of event IDs, in date order.
 *
 * WHAT IT CHANGES
 * ---------------
 * For each post that has a waiting choice, both `rows` (what the renderer draws)
 * and `events` (what the caption lists) are replaced with the chosen events.
 * A post with no waiting choice is left exactly as selected, so the ordinary
 * Monday and Friday runs are unaffected.
 *
 * Usage:
 *   node apply-choices.js                  uses POST_CHOICES_URL from the env
 *   node apply-choices.js --from-file X    reads a saved CSV, for offline runs
 *   node apply-choices.js --wait 420       re-reads the sheet for up to 7 minutes,
 *                                         for rebuild runs only - see waitForChoices
 *   node apply-choices.js --dry            report what it would do, change nothing
 */

'use strict';

const fs = require('fs');
const path = require('path');

const INPUT = path.join(__dirname, 'social-posts.json');

// How long a waiting choice stays valid. Older than this it is ignored, so a
// choice left behind by an abandoned approval does not silently rewrite a post
// weeks later.
const MAX_AGE_HOURS = 72;

/* Minimal CSV reader for the published sheet.
 *
 * Google's published output is plain CSV, but event titles contain commas,
 * quotes and newlines, so this has to be a real parser rather than a split.
 */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else { inQuotes = false; }
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
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

// The waiting choices: { PostID: [eventId, ...] }
function readChoices(text, now) {
  const rows = parseCsv(text).filter((r) => r.length && String(r[0]).trim());
  if (!rows.length) return {};

  // Google publishes a CSV with a leading blank line sometimes; find the header
  // by the column names rather than trusting it to be row 1.
  const header = rows[0].map((h) => String(h).trim().toLowerCase());
  const idCol = header.indexOf('postid');
  const whenCol = header.indexOf('requested');
  const picksCol = header.indexOf('picks');
  if (idCol === -1 || picksCol === -1) {
    throw new Error('The choices sheet has no PostID/Picks columns. Expected ' +
      'headers: PostID, Requested, Picks. Got: ' + header.join(', '));
  }

  const out = {};
  rows.slice(1).forEach((r) => {
    const id = String(r[idCol] || '').trim();
    if (!id) return;

    if (whenCol !== -1) {
      const when = Date.parse(String(r[whenCol] || '').trim());
      if (!isNaN(when)) {
        const hours = (now - when) / 3600000;
        if (hours > MAX_AGE_HOURS) {
          console.log('Ignoring a choice for ' + id + ' - it is ' +
            Math.round(hours) + ' hours old.');
          return;
        }
      }
    }

    // Picks is the LAST column, and its value is a comma-separated list, so it
    // contains commas. If the sheet was published without the field quoted,
    // the list arrives spread across several columns - rejoining from Picks
    // onwards is what makes that work rather than silently keeping only the
    // first event, which is how a five-event post would quietly become a
    // one-event post.
    const picks = r.slice(picksCol).join(',').split(',')
      .map((s) => s.trim()).filter(Boolean);
    if (!picks.length) return;
    // Later rows for the same post replace earlier ones.
    out[id] = picks;
  });

  return out;
}

/* Rewrites one post's events to the chosen list.
 *
 * `rows` is grouped by day and is what the renderer draws; `events` is flat and
 * is what the caption lists. Both have to move together or the image and the
 * words disagree - which is the exact failure this design exists to avoid.
 *
 * Events are looked up from candidatesByDay by ID, so the venue, title and date
 * all come from the same source the chooser displayed. A chosen ID that is not
 * in the candidate field is refused rather than half-applied.
 */
function applyToPost(post, picks) {
  const byId = {};
  const dayOf = {};
  (post.candidatesByDay || []).forEach((d) => {
    (d.events || []).forEach((e) => {
      byId[e.eventId] = e;
      dayOf[e.eventId] = d;
    });
  });

  const missing = picks.filter((id) => !byId[id]);
  if (missing.length) {
    throw new Error('Choice for ' + post.variant + ' names ' + missing.length +
      ' event(s) that are not candidates any more: ' + missing.join(', ') +
      '. Not applying a partial change - the list on the approval page is out ' +
      'of date.');
  }

  // Grouped, in the order given, which the chooser already put in date order.
  const grouped = [];
  picks.forEach((id) => {
    const e = byId[id];
    const d = dayOf[id];
    const day = String(d.day || '').toUpperCase() +
      ' - ' + String(d.date || '').slice(8, 10) + '/' + String(d.date || '').slice(5, 7);
    let bucket = grouped.find((g) => g.day === day);
    if (!bucket) { bucket = { day: day, events: [] }; grouped.push(bucket); }
    bucket.events.push({
      title: e.title,
      venue: e.venue,
      rank: e.rank,
      size: e.size,
      category: e.category
    });
  });

  post.rows = grouped;
  post.events = picks.map((id) => {
    const e = byId[id];
    const d = dayOf[id];
    return {
      eventId: id,
      date: d.date,
      title: e.title,
      venue: e.venue
    };
  });

  // The post's identity follows its first event, so a change that drops that
  // day produces a different PostID.
  const firstDay = dayOf[picks[0]];
  if (firstDay) {
    const d = firstDay.date;
    const dd = ('0' + d.slice(8, 10)).slice(-2);
    const mm = ('0' + d.slice(5, 7)).slice(-2);
    const yy = d.slice(2, 4);
    // ...plus a revision stamp, ALWAYS.
    //
    // This is not decoration. Apps Script keys "have I already drafted this?"
    // off PostID, so a rebuilt post that kept its original ID was silently
    // treated as already known and NO approval email was ever sent - the
    // rebuild happened, but the owner was never asked to approve it, and the
    // old image went out instead of the new one. Observed 13 October 2026:
    // the owner's choices were applied, the image was redrawn, and nothing
    // arrived in the inbox.
    //
    // Stamping the revision is what makes the rebuilt post a genuinely new
    // post, so it is drafted, emailed and approved on its own merits.
    const rev = Date.now().toString(36).slice(-5);
    post.dateLabel = dd + mm + yy + '-r' + rev;
    post.rebuilt = true;
  }

  return grouped;
}

async function fetchChoicesText() {
  const args = process.argv;
  const fileIdx = args.indexOf('--from-file');
  if (fileIdx !== -1) {
    return fs.readFileSync(args[fileIdx + 1], 'utf8');
  }

  const url = process.env.POST_CHOICES_URL;
  if (!url) {
    // Not an error. The ordinary Monday and Friday runs have no choices to
    // apply, and a missing URL there is simply nothing to do.
    return null;
  }
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error('Could not read the choices sheet: HTTP ' + res.status +
      '. Check the published URL in the POST_CHOICES_URL environment variable.');
  }
  return await res.text();
}

/* Reads the sheet, then keeps re-reading it until the choices turn up.
 *
 * GOOGLE CACHES THE PUBLISHED CSV FOR UP TO FIVE MINUTES.
 * Measured on the live choices sheet on 14 October 2026:
 * `Cache-Control: private, max-age=300`.
 *
 * That matters because Apps Script writes the owner's choice and dispatches the
 * rebuild within about a second of each other. The workflow then fetched the
 * sheet roughly ten seconds later and was served the version from BEFORE the
 * owner pressed Approve - no waiting choices, so the rebuild ran with the old
 * events and the old PostID, no second email was sent, and nothing in the log
 * looked wrong. Observed 14 October 2026.
 *
 * A cache-busting query parameter is not an option: Google answers HTTP 400 to
 * an unrecognised one on a published URL. So the fix is to wait the cache out.
 *
 * `sleep` is injectable so the behaviour can be tested without real waiting.
 * Timeouts are NOT failures - if the choices never appear the run continues
 * exactly as it would have before, because a rebuild with the owner's old
 * events is still better than a failed build that emails nothing at all.
 */
const CACHE_TTL_MS = 300000;
const POLL_EVERY_MS = 30000;

async function waitForChoices(budgetMs, sleep) {
  const nap = sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const deadline = Date.now() + budgetMs;
  let waited = 0;

  for (;;) {
    const text = await fetchChoicesText();
    if (text === null) return {};           // no URL configured - nothing to wait for
    const choices = readChoices(text, Date.now());
    if (Object.keys(choices).length) return choices;

    if (waited >= budgetMs) return {};
    const remaining = Math.min(POLL_EVERY_MS, budgetMs - waited, deadline - Date.now());
    console.log('No waiting choices yet. Google caches the published sheet for ' +
      '5 minutes, and the rebuild was dispatched moments after the owner saved ' +
      'their choice, so an early read sees the sheet as it was before they ' +
      'pressed Approve. Waiting ' + Math.round(remaining / 1000) + 's (' +
      Math.round(waited / 1000) + 's of ' + Math.round(budgetMs / 1000) + 's used).');
    await nap(remaining);
    waited += remaining;
  }
}

async function main() {
  const dry = process.argv.includes('--dry');
  const now = Date.now();

  const waitIdx = process.argv.indexOf('--wait');
  const waitSeconds = waitIdx === -1 ? 0 : (parseInt(process.argv[waitIdx + 1], 10) || 0);
  const waitMs = waitSeconds * 1000;

  let choices;
  if (waitMs > 0) {
    console.log('Rebuild run - the owner has just saved a choice, so the sheet ' +
      'is read repeatedly for up to ' + waitSeconds + 's.');
    choices = await waitForChoices(waitMs);
  } else {
    const text = await fetchChoicesText();
    if (text === null) {
      console.log('No POST_CHOICES_URL set - no choices to apply. Normal run.');
      return;
    }
    choices = readChoices(text, now);
  }

  const ids = Object.keys(choices);
  if (!ids.length) {
    console.log('No waiting event choices. Normal run.');
    return;
  }

  console.log('Found ' + ids.length + ' waiting choice(s): ' + ids.join(', '));

  if (!fs.existsSync(INPUT)) {
    console.log('No social-posts.json - nothing selected to change.');
    return;
  }

  const data = JSON.parse(fs.readFileSync(INPUT, 'utf8'));
  const posts = Array.isArray(data.posts) ? data.posts : [];

  // Match on PostID first. Failing that, match on the variant, because a
  // PostID is derived from the first event's date and can therefore change
  // when the owner swaps that day's event.
  let applied = 0;
  posts.forEach((post) => {
    const slug = post.variant + '-' + post.dateLabel;
    let picks = choices[post.PostID || slug] || choices[post.variant];
    if (!picks) return;

    const grouped = applyToPost(post, picks);
    applied++;
    console.log('Applied the owner\'s choices to ' + (post.PostID || slug) +
      ': ' + picks.length + ' event(s).');
    grouped.forEach((g) => {
      g.events.forEach((e) => console.log('      ' + g.day + '  ' + e.title));
    });
  });

  if (!applied) {
    console.log('No selected post matched a waiting choice - leaving it alone.');
    console.log('  Selected: ' + posts.map((p) => p.variant + '-' + p.dateLabel).join(', '));
    console.log('  Waiting : ' + ids.join(', '));
    return;
  }

  if (dry) {
    console.log('Dry run - social-posts.json not changed.');
    return;
  }

  fs.writeFileSync(INPUT, JSON.stringify(data, null, 2) + '\n', 'utf8');
  console.log('Wrote social-posts.json with the owner\'s choices.');
}

// Guarded so the tests can require the functions without running a build.
if (require.main === module) {
  main().catch((err) => {
    console.error('apply-choices failed: ' + err.message);
    // A non-zero exit fails the workflow step, so the owner is not emailed an
    // approval for an image that was built from the wrong events.
    process.exitCode = 1;
  });
}

module.exports = {
  parseCsv,
  readChoices,
  applyToPost,
  waitForChoices,
  CACHE_TTL_MS,
  POLL_EVERY_MS
};