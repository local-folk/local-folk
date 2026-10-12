#!/usr/bin/env node
/*
 * build-captions.js
 *
 * Turns the selected events in social-posts.json into finished captions for
 * Facebook and Instagram, and writes them to social/drafts/ as markdown for
 * reading, plus social/queue.json as the machine-readable hand-off.
 *
 * Nothing is posted by this script. It produces the text and the queue entry;
 * approving and posting happen later, in Apps Script.
 *
 * queue.json is committed and deployed to thekirn.co.uk, which is how Apps
 * Script learns what the post says - it fetches the file over plain HTTP, so
 * no Google credentials are involved. The drafts above stay gitignored.
 *
 * The two captions are identical except for the closing line, because the
 * platforms genuinely differ there: Instagram captions cannot carry a
 * clickable link, so it says "Link in bio". Facebook can, so it says the URL.
 *
 * Instagram's native crossposting does NOT apply here. It is an app feature for
 * manual posts only - Meta's publishing API has no crosspost parameter - so each
 * platform gets its own API call with its own caption.
 *
 * Usage:
 *   node build-captions.js          write drafts to social/drafts/
 *   node build-captions.js --show   also print them to the terminal
 */

'use strict';

const fs = require('fs');
const path = require('path');

const INPUT = path.join(__dirname, 'social-posts.json');
const DRAFT_DIR = path.join(__dirname, 'social', 'drafts');

/* The queue file. COMMITTED and served from thekirn.co.uk, unlike the drafts
 * above, which are gitignored. That is the whole point: it is how Apps Script
 * learns what the post says. The script has no credentials of its own, so it
 * reads the queue over plain HTTP from the public site rather than needing a
 * service account or a token. */
const QUEUE_FILE = path.join(__dirname, 'social', 'queue.json');

/* Public base of the deployed site. Instagram fetches the image by URL, so it
 * has to be an absolute address on the live site, not a repo path. */
const SITE_URL = 'https://thekirn.co.uk';

/* When each variant is due to go out, in UTC, matching the Apps Script
 * triggers. These mirror SOCIAL_SLOTS in social.gs - the two have to agree,
 * because Apps Script reads ScheduledFor out of this file and refuses to post
 * early. */
const SLOTS = {
  Weekly: { dow: 1, hour: 7 },    // Monday 07:00
  Weekend: { dow: 4, hour: 12 }   // Thursday 12:00
};

/* Hashtags, in the order they appear. Changed 12 October 2026 to add
 * #sessions and move it after #folkmusic. */
const HASHTAGS = [
  '#newcastle',
  '#northeast',
  '#folk',
  '#folkmusic',
  '#sessions',
  '#crafts',
  '#markets',
  '#thekirn'
];

/* The line immediately above the link, on both platforms. Added 12 October
 * 2026. */
const SEE_FULL_LIST = 'See full list of events on the website.';

const FB_CLOSER = 'Link: thekirn.co.uk';
const IG_CLOSER = 'Link in bio.';

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN',
                'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

/* The header line: "// 12-16 OCT // WEEKLY ROUNDUP".
 *
 * The date span is the roundup's own window - first to last day covered - not
 * the run date, so a Monday post reads "12-16 OCT" rather than a single day.
 * Read off the events themselves, which is what the caption then lists, so the
 * span can never disagree with the days underneath it.
 *
 * Built from the event dates rather than the window arithmetic in
 * select-social-events.js: this script only has the selection to hand, and
 * deriving the span from the same rows the caption prints is the version that
 * cannot drift. A day with no events is simply not in the span, which is the
 * honest reading anyway.
 */
function header(post) {
  const dates = [];
  for (const row of post.rows || []) {
    for (const ev of row.events || []) {
      // row.day is "MONDAY - 12/10"
      const m = /(\d{2})\/(\d{2})\s*$/.exec(row.day || '');
      if (m) dates.push({ dd: Number(m[1]), mm: Number(m[2]) });
    }
  }

  let span = '';
  if (dates.length) {
    // Sort numerically, not lexically, so 09/10 sorts before 12/10.
    const sorted = dates.slice().sort((a, b) =>
      (a.mm - b.mm) || (a.dd - b.dd));
    const first = sorted[0];
    const last = sorted[sorted.length - 1];

    const pad = (n) => (n < 10 ? '0' + n : String(n));
    if (first.mm === last.mm) {
      span = pad(first.dd) + '-' + pad(last.dd) + ' ' + MONTHS[first.mm - 1];
    } else {
      span = pad(first.dd) + ' ' + MONTHS[first.mm - 1] +
             ' - ' + pad(last.dd) + ' ' + MONTHS[last.mm - 1];
    }
  }

  const label = (post.subtitle || post.variant || 'Roundup').toUpperCase();
  return span ? '// ' + span + ' // ' + label : '// ' + label;
}

function readInput() {
  if (!fs.existsSync(INPUT)) {
    console.log('No social-posts.json - nothing due today. Nothing to write.');
    return { posts: [] };
  }
  return JSON.parse(fs.readFileSync(INPUT, 'utf8'));
}

/* The body is the same on both platforms: header, then each day's events. */
function body(post) {
  const lines = [header(post), ''];

  for (const row of post.rows) {
    lines.push(row.day);
    for (const event of row.events) {
      if (typeof event === 'string') {
        lines.push(event);
      } else {
        if (event.title) lines.push(event.title);
        if (event.venue) lines.push(event.venue);
      }
    }
    lines.push('');
  }

  return lines.join('\n').trimEnd();
}

/* Full caption. Identical on both platforms except the closing link line:
 *
 *   // 12-16 OCT // WEEKLY ROUNDUP
 *
 *   MONDAY - 12/10
 *   Anne Alderson
 *   Bridge Hotel
 *   ...
 *
 *   See full list of events on the website.
 *   Link: thekirn.co.uk
 *
 *   #newcastle ...
 *
 * The "See full list" line and the link are separate lines - the first is the
 * call to action, the second is the destination, and they differ by platform
 * because only Facebook can carry a clickable link. */
function captionFor(post, closer) {
  return [
    body(post),
    '',
    SEE_FULL_LIST,
    closer,
    '',
    HASHTAGS.join(' ')
  ].join('\n');
}

function slug(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/* ------------------------------------------------------------------ *
 * When this post is due
 * ------------------------------------------------------------------ */

/* The next occurrence of this variant's slot, strictly after `now`, in UTC.
 *
 * Strictly-after is what produces the review gap. The draft is built at
 * 03:17 UTC, so on a Monday morning the next Weekly slot is that same
 * morning at 07:00 - about four hours later, which is the window the
 * owner reads the email and presses Approve. Choosing "today at 07:00"
 * regardless would have been the same answer here, but choosing "the
 * next one" without the comparison would skip a week every time the
 * draft was built after its slot had passed.
 */
function nextSlot(variant, now) {
  const slot = SLOTS[variant];
  if (!slot) throw new Error('No slot defined for variant "' + variant + '".');

  const d = new Date(now.getTime());
  d.setUTCHours(slot.hour, 0, 0, 0);

  // getUTCDay(): 0 = Sunday. Walk forward to the right weekday.
  const delta = (slot.dow - d.getUTCDay() + 7) % 7;
  d.setUTCDate(d.getUTCDate() + delta);

  // If that instant has already passed, the slot is the following week.
  if (d.getTime() <= now.getTime()) {
    d.setUTCDate(d.getUTCDate() + 7);
  }
  return d;
}

function main() {
  const show = process.argv.includes('--show');
  const now = new Date();
  const input = readInput();
  const posts = Array.isArray(input.posts) ? input.posts : [];

  if (posts.length === 0) {
    console.log('Nothing to write.');
    return;
  }

  fs.mkdirSync(DRAFT_DIR, { recursive: true });

  const queue = [];

  for (const post of posts) {
    const name = post.variant + '-' + slug(post.dateLabel);
    const fb = captionFor(post, FB_CLOSER);
    const ig = captionFor(post, IG_CLOSER);

    const md = [
      '# ' + (post.subtitle || post.variant) + ' - ' + post.dateLabel,
      '',
      'Image: social/archive/' + name + '.png',
      'Instagram image (JPEG): social/archive/' + name + '.jpg',
      '',
      '## Facebook',
      '',
      '```',
      fb,
      '```',
      '',
      '## Instagram',
      '',
      '```',
      ig,
      '```',
      ''
    ].join('\n');

    const target = path.join(DRAFT_DIR, name + '.md');
    fs.writeFileSync(target, md, 'utf8');
    console.log('wrote ' + path.relative(__dirname, target));

    /* Everything Apps Script needs, and nothing it doesn't. It builds the
     * Social tab row from this, emails the captions and image for approval,
     * and later posts to both platforms.
     *
     * EventIDs go in because the spec derives last-posted dates from the
     * EventIDs and ScheduledFor columns of the Social tab, which is how
     * rotation avoids repeating an event. */
    const scheduled = nextSlot(post.variant, now);
    queue.push({
      PostID: name,
      PostType: post.subtitle || post.variant,
      Status: 'Draft',
      ScheduledFor: scheduled.toISOString(),
      EventIDs: (post.events || []).map(function (e) { return e.eventId; }).filter(Boolean).join(','),
      FBCaption: fb,
      IGCaption: ig,
      ImageVariant: name,
      ImageURL: SITE_URL + '/social/archive/' + name + '.png',
      EmailImageURL: SITE_URL + '/social/archive/' + name + '.jpg',
      FBPostID: '',
      IGPostID: '',
      Notes: ''
    });

    console.log('      due ' + scheduled.toISOString() +
      '  (' + queue[queue.length - 1].PostID + ')');

    if (show) {
      console.log('');
      console.log('--- FACEBOOK -------------------------------------');
      console.log(fb);
      console.log('');
      console.log('--- INSTAGRAM ------------------------------------');
      console.log(ig);
      console.log('');
    }
  }

  /* Overwritten rather than appended, so the file always describes the posts
   * about to go out and never a growing history. Apps Script keys off PostID,
   * so re-running with the same selection is idempotent.
   *
   * Written as UTF-8 without a BOM. The captions carry diacritics
   * ("An Crúiscín Làn'"), and a BOM here would become part of the first
   * PostID once Apps Script parsed it. */
  fs.writeFileSync(
    QUEUE_FILE,
    JSON.stringify({ generatedAt: now.toISOString(), posts: queue }, null, 2),
    'utf8'
  );
  console.log('wrote ' + path.relative(__dirname, QUEUE_FILE) +
    ' (' + queue.length + ' post(s) awaiting approval)');
}

main();
