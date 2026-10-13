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

/* When each variant belongs to, in UTC.
 *
 * ScheduledFor is now a LABEL, not the thing that decides when a post goes out.
 * Since 12 October 2026 the publishing time comes from the 11:00 cutoff in
 * social.gs, and approval decides whether a post waits for the cutoff or goes
 * immediately. This file only records which roundup a post is, so the Social tab
 * reads sensibly.
 *
 * The hours here are therefore not the posting times and are not enforced
 * anywhere. The days are, though, and they must match VARIANTS.runOn in
 * select-social-events.js and DRAFT_DAYS in social.gs - if a post is built on a
 * Friday but labelled as a Thursday post, the email arrives on the wrong day.
 */
const SLOTS = {
  Weekly: { dow: 1, hour: 7 },    // Monday
  Weekend: { dow: 5, hour: 7 }    // Friday
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

/* The header line comes from post-header.js, which the image generator uses
 * too. The caption and the image must not be able to disagree about it. */
const { header } = require('./post-header.js');

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

/* When this post is "for" - the moment its first listed event happens.
 *
 * This used to be "the next slot after now", which was right while publishing
 * was driven by this field. It is not any more, and it produced a genuinely
 * wrong label: a manual run at 13:31 UTC on Monday 12 October was past the
 * Monday 07:00 slot, so the date rolled forward to Monday 19 October - while the
 * events, the caption and the image all still said 12-16 October. The email read
 * "Weekly Roundup (Mon 19 Oct, 08:00 UK time)" over a 12-16 October roundup.
 *
 * Deriving it from the events means the label can never contradict the content,
 * whichever day the workflow happens to run on.
 */
function scheduledFor(variant, post) {
  const slot = SLOTS[variant];
  if (!slot) throw new Error('No slot defined for variant "' + variant + '".');

  const events = (post && post.events) || [];
  if (!events.length) {
    throw new Error('Post "' + (post && post.variant) + '" has no events, ' +
      'so it has no date. Refusing to write a queue entry that would be ' +
      'labelled with a made-up date.');
  }

  // Events are already in date order from the selector. Take the first one, and
  // fall back to the rest if it somehow is not parseable.
  let dateStr = null;
  for (const e of events) {
    if (e && e.date && !isNaN(Date.parse(e.date))) {
      dateStr = e.date;
      break;
    }
  }
  if (!dateStr) {
    throw new Error('None of the events for "' + variant + '" has a readable ' +
      'date, so the post cannot be labelled.');
  }

  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCHours(slot.hour, 0, 0, 0);
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
    const scheduled = scheduledFor(post.variant, post);
    queue.push({
      PostID: name,
      PostType: post.subtitle || post.variant,
      Status: 'Draft',
      ScheduledFor: scheduled.toISOString(),
      EventIDs: (post.events || []).map(function (e) { return e.eventId; }).filter(Boolean).join(','),
      // Every candidate for every day, chosen or not. Added 13 October 2026 so
      // the approval page can show the whole field and let the owner swap an
      // event out. Apps Script reads this from the deployed queue file.
      //
      // Capped so a long week cannot make queue.json enormous: 12 per day is
      // far more than the owner would ever choose between, and anything beyond
      // that is a low-ranked event that would never win anyway.
      Candidates: (post.candidatesByDay || []).map(function (d) {
        return {
          date: d.date,
          day: d.day,
          events: (d.events || []).slice(0, 12).map(function (e) {
            return {
              id: e.eventId,
              title: e.title,
              venue: e.venue,
              category: e.category,
              rank: e.rank,
              size: e.size
            };
          })
        };
      }),
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
