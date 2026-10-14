'use strict';

/*
 * Tests for the GitHub half of the event chooser.
 *
 * Three separate bugs lived in this file's territory and none of them showed up
 * as an error: the owner's five ticked boxes arriving as one, the rebuilt post
 * keeping its PostID so no second email was sent, and the cross-day name
 * collision that silently dropped an event. Each was found by running the real
 * thing, not by reading the code. So these tests lean towards the failure modes
 * that are quiet - a sheet read too early, a partial CSV row, a day counter that
 * resets - rather than towards crash-level mistakes.
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const ac = require('./apply-choices.js');

const CSV_HEADER = 'PostID,Requested,Picks\n';

// A day of 2026-10-14, so the "72 hours too old" rule can be tested against it.
const NOW = Date.parse('2026-10-14T12:00:00Z');

// The timestamp shape Google actually published for the live sheet, captured
// 14 October 2026. Deliberately comma-free: a comma in an unquoted field would
// be the sheet's problem to quote, and hand-written test rows that contain one
// just test the writer, not the reader.
const WHEN = 'Wed Oct 14 2026 12:07:30 GMT+0100 (British Summer Time)';

function csv(rows) {
  return CSV_HEADER + rows.map((r) =>
    r.map((f) => (/[",\n]/.test(f) ? '"' + String(f).replace(/"/g, '""') + '"' : String(f)))
      .join(',')
  ).join('\n') + '\n';
}

// ================================================================
// READING THE SHEET
// ================================================================

test('reads PostID, Requested and Picks from the sheet', () => {
  const text = csv([
    ['Weekly-141026', WHEN, 'e1,e2,e3']
  ]);
  const got = ac.readChoices(text, NOW);
  assert.deepEqual(got['Weekly-141026'], ['e1', 'e2', 'e3']);
});

test('finds the columns by name, not by position', () => {
  // Sheets can gain columns. Keying off the header means an extra column is
  // harmless rather than silently shifting Picks out of the row.
  const text = 'PostID,Requested,Note,Picks\n' +
    'Weekly-141026,' + WHEN + ',hello,e1,e2\n';
  assert.deepEqual(ac.readChoices(text, NOW)['Weekly-141026'], ['e1', 'e2']);
});

test('a Picks list with commas in it survives the CSV round trip', () => {
  // The event IDs contain commas, so Picks is one quoted field holding a list.
  // A naive split would keep only the first event and turn a five-event post
  // into a one-event post - which is exactly what happened before.
  const text = CSV_HEADER +
    'Weekly-141026,' + WHEN + ',"e1,e2,e3,e4,e5"\n';
  assert.deepEqual(
    ac.readChoices(text, NOW)['Weekly-141026'],
    ['e1', 'e2', 'e3', 'e4', 'e5']
  );
});

test('an UNQUOTED picks list is rejoined rather than truncated', () => {
  // Google does not always quote it. The events still have to all arrive.
  const text = CSV_HEADER +
    'Weekly-141026,' + WHEN + ',e1,e2,e3,e4,e5\n';
  assert.deepEqual(
    ac.readChoices(text, NOW)['Weekly-141026'],
    ['e1', 'e2', 'e3', 'e4', 'e5']
  );
});

test('the live row published on 14 October 2026 parses as written', () => {
  // The actual line captured from the real sheet, so a change in how Google
  // formats the sheet is caught here rather than on a Monday morning.
  const text = CSV_HEADER + 'Weekly-141026,' + WHEN + ',' +
    '"2026-10-14|o2 city hall|the mary wallopers,' +
    '2026-10-15|cobalt studios|fresh thursday right of way"\n';
  assert.deepEqual(ac.readChoices(text, NOW)['Weekly-141026'], [
    '2026-10-14|o2 city hall|the mary wallopers',
    '2026-10-15|cobalt studios|fresh thursday right of way'
  ]);
});

test('a choice from four days ago is ignored', () => {
  const old = new Date(NOW - 96 * 3600 * 1000).toUTCString();
  const text = csv([['Weekly-141026', old, 'e1,e2']]);
  assert.deepEqual(ac.readChoices(text, NOW), {},
    'an abandoned approval must not rewrite a post weeks later');
});

test('a fresh choice is kept', () => {
  const recent = new Date(NOW - 2 * 3600 * 1000).toISOString();
  const text = csv([['Weekly-141026', recent, 'e1']]);
  assert.deepEqual(Object.keys(ac.readChoices(text, NOW)), ['Weekly-141026']);
});

test('an empty sheet is no choices, not an error', () => {
  // This is the state of a brand-new choices sheet, and it is what an ordinary
  // Monday run finds. It must not stop the build.
  assert.deepEqual(ac.readChoices('', NOW), {});
  assert.deepEqual(ac.readChoices('\n', NOW), {});
});

test('a sheet with headers but no rows is no choices', () => {
  assert.deepEqual(ac.readChoices(CSV_HEADER, NOW), {});
});

test('a later row replaces an earlier one for the same post', () => {
  const text = csv([
    ['Weekly-141026', WHEN, 'e1,e2'],
    ['Weekly-141026', WHEN, 'e3,e4,e5']
  ]);
  assert.deepEqual(ac.readChoices(text, NOW)['Weekly-141026'], ['e3', 'e4', 'e5'],
    'the newest choice wins');
});

test('a sheet with the wrong headers is refused loudly', () => {
  // Silence here would mean a post published with the wrong events.
  assert.throws(
    () => ac.readChoices('PostID,Notes\nWeekly-141026,hello\n', NOW),
    /no PostID\/Picks columns/
  );
});

test('two posts waiting at once are both read', () => {
  const text = csv([
    ['Weekly-141026', WHEN, 'e1,e2'],
    ['Weekend-161026', WHEN, 'e9,e10']
  ]);
  const got = ac.readChoices(text, NOW);
  assert.deepEqual(Object.keys(got).sort(), ['Weekend-161026', 'Weekly-141026']);
});

// ================================================================
// THE CACHE - the fourth quiet bug
// ================================================================

test('waiting for choices keeps re-reading until they appear', async () => {
  const when = new Date(NOW).toUTCString();
  const empty = CSV_HEADER;
  const full = csv([['Weekly-141026', when, 'e1,e2,e3']]);

  // Stands in for Google's five-minute cache: the first two reads return the
  // sheet as it was before the owner pressed Approve.
  const pages = [empty, empty, full];
  let reads = 0;
  const naps = [];

  global.fetch = async () => {
    const body = pages[Math.min(reads, pages.length - 1)];
    reads++;
    return { ok: true, status: 200, text: async () => body };
  };
  process.env.POST_CHOICES_URL = 'https://example.invalid/choices';

  const sleep = async (ms) => { naps.push(ms); };

  const got = await ac.waitForChoices(420000, sleep);

  assert.deepEqual(got['Weekly-141026'], ['e1', 'e2', 'e3']);
  assert.equal(reads, 3, 'it read three times: twice empty, then the real row');
  assert.equal(naps.length, 2);
  naps.forEach((ms) => assert.ok(ms > 0 && ms <= 30000,
    'each wait is a short nap, not the whole budget at once'));
});

test('waiting gives up cleanly rather than failing the build', async () => {
  // A timeout must leave the ordinary path untouched. A failed build emails
  // nothing, which is worse than a rebuild with the old events.
  global.fetch = async () => ({
    ok: true, status: 200, text: async () => CSV_HEADER
  });
  process.env.POST_CHOICES_URL = 'https://example.invalid/choices';

  let slept = 0;
  const got = await ac.waitForChoices(60000, async (ms) => { slept += ms; });

  assert.deepEqual(got, {});
  assert.ok(slept >= 60000, 'it used the budget it was given');
});

test('an unreadable sheet is a hard error, not a silent rebuild', async () => {
  global.fetch = async () => ({ ok: false, status: 401, text: async () => '' });
  process.env.POST_CHOICES_URL = 'https://example.invalid/choices';

  await assert.rejects(() => ac.waitForChoices(1000, async () => {}), /HTTP 401/,
    'a 401 means the sheet is not published, and must not be mistaken for ' +
    '"no choices to apply"');
});

test('no URL configured means nothing to wait for, immediately', async () => {
  delete process.env.POST_CHOICES_URL;
  let slept = 0;
  const got = await ac.waitForChoices(420000, async () => { slept++; });
  assert.deepEqual(got, {});
  assert.equal(slept, 0, 'it must not sit there for 7 minutes when there is no sheet');
});

// ================================================================
// APPLYING THE CHOICE
// ================================================================

function fixture() {
  return {
    variant: 'Weekly Roundup',
    dateLabel: '141026',
    events: [{ eventId: 'old1' }],
    rows: [{ day: 'TUESDAY', events: [{ title: 'old1' }] }],
    candidatesByDay: [
      {
        day: 'Tuesday', date: '2026-10-13',
        events: [
          { eventId: 'old1', title: 'Old Tuesday', venue: 'A', rank: 1, size: 'L' },
          { eventId: 'new1', title: 'New Tuesday', venue: 'B', rank: 2, size: 'M' }
        ]
      },
      {
        day: 'Wednesday', date: '2026-10-14',
        events: [
          { eventId: 'w1', title: 'Wed One', venue: 'C', rank: 1, size: 'S' },
          { eventId: 'w2', title: 'Wed Two', venue: 'D', rank: 3, size: 'L' }
        ]
      }
    ]
  };
}

test('applying a choice moves both the picture and the words together', () => {
  const post = fixture();
  ac.applyToPost(post, ['new1', 'w2']);

  assert.deepEqual(post.events.map((e) => e.title), ['New Tuesday', 'Wed Two'],
    'the caption must list exactly what the image shows');
  assert.deepEqual(post.rows.map((r) => r.events.map((e) => e.title)),
    [['New Tuesday'], ['Wed Two']]);
});

test('every day the owner chose keeps its own group', () => {
  // The boxIndex bug reset per day, so day two's boxes collided with day one's
  // and events vanished without a word. Grouping by day is what prevents it.
  const post = fixture();
  ac.applyToPost(post, ['new1', 'w1', 'w2']);
  assert.equal(post.rows.length, 2);
  assert.equal(post.rows[1].events.length, 2);
  assert.deepEqual(post.events.map((e) => e.title),
    ['New Tuesday', 'Wed One', 'Wed Two']);
});

test('the rebuilt post gets a new identity, so it is emailed as new', () => {
  // Without the revision stamp the PostID was unchanged, Apps Script treated
  // the rebuild as already known, and NO approval email was ever sent - the old
  // image went out instead of the new one. Observed 13 October 2026.
  const post = fixture();
  ac.applyToPost(post, ['w1', 'new1']);
  assert.match(post.dateLabel, /^\d{6}-r[0-9a-z]+$/,
    'the stamp is what makes the rebuild a genuinely different post');
  assert.equal(post.rebuilt, true);
});

test('a choice naming an event that no longer exists is refused whole', () => {
  // Half-applying would put words on the image that the image does not show.
  const post = fixture();
  assert.throws(() => ac.applyToPost(post, ['new1', 'ghost-event']),
    /not candidates any more/);
  assert.deepEqual(post.events.map((e) => e.eventId), ['old1'],
    'nothing at all should have changed');
});

test('candidates on the same day with the same box name both survive', () => {
  // The boxIndex bug reset per day, so day two's boxes collided with day one's
  // and events vanished without a word. Two picks on one day must stay two.
  const post = fixture();
  ac.applyToPost(post, ['w1', 'w2']);
  assert.equal(post.rows.length, 1, 'both picks were on the same day');
  assert.equal(post.rows[0].events.length, 2);
});