// Tests for venue address, coordinate and link handling in appsscript.gs.
//
// Three behaviours are checked here, all of them things that had to be right
// before they were user-visible:
//
//   1. Approving an event fills address and coordinates from the Venue
//      Addresses tab, and never overwrites a value already on the event.
//   2. "The Cluny" and "The Cluny 2" are different venues and must not pick up
//      each other's website.
//   3. A real event link - Ticketmaster, Skiddle - is never replaced.
//
// Run:  node --test events-venues.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SOURCE = fs.readFileSync(path.join(__dirname, 'appsscript.gs'), 'utf8');

// Column positions in a Pending/Published row, which are plain arrays.
const COL = {
  ID: 0, TITLE: 1, DATE: 4, VENUE: 7, ADDRESS: 8,
  LAT: 9, LNG: 10, SOURCE_URL: 12, STATUS: 13
};


// ================================================================
// SANDBOX
// ================================================================

// A Venue Addresses tab fixture, written as [name, address, link, lat, lng].
function makeVenueSheet(rows, headings) {
  const cells = [];
  const head = headings || ['Venue Name', 'Full Address', 'Default Link',
    'Latitude', 'Longitude'];
  head.forEach((h, i) => { cells[i] = { 1: { v: h, set(v) { this.v = v; } } }; });
  // Keyed by ROW NUMBER, which is what getRange addresses. Keying by the first
  // value instead silently returns nothing for every read.
  rows.forEach((r, ri) => {
    r.forEach((v, i) => {
      if (!cells[i]) cells[i] = {};
      cells[i][ri + 2] = { v: v, set(x) { this.v = x; } };
    });
  });

  // Header plus one row per venue - not a function of the column count, which
  // is what getLastRow actually reports.
  const lastRow = 1 + rows.length;
  return {
    maxRows: lastRow + 10,
    getLastRow: () => lastRow,
    getRange: (r, c, nr, nc) => {
      const col = c - 1;
      const slot = cells[col] && cells[col][r];
      return {
        getValue: () => (slot ? slot.v : ''),
        getValues: () => {
          const out = [];
          for (let i = 0; i < (nr || 1); i++) {
            const line = [];
            for (let j = 0; j < (nc || 1); j++) {
              const s = cells[col + j] && cells[col + j][r + i];
              line.push(s ? s.v : '');
            }
            out.push(line);
          }
          return out;
        },
        setValue: (v) => {
          if (!cells[col]) cells[col] = {};
          cells[col][r] = { v: v, set(x) { this.v = x; } };
        },
        getValues: () => {
          const out = [];
          for (let i = 0; i < (nr || 1); i++) {
            const line = [];
            for (let j = 0; j < (nc || 1); j++) {
              const s = cells[col + j] && cells[col + j][r + i];
              line.push(s ? s.v : '');
            }
            out.push(line);
          }
          return out;
        },
        setValues: () => {},
        setNumberFormat: () => {}
      };
    },
    getName: () => 'Venue Addresses'
  };
}

// Apps Script stubs, plus a geocoder the test controls so no network is used.
function loadScript(opts) {
  opts = opts || {};
  const logs = [];
  const venueSheet = opts.venueSheet === null
    ? null
    : (opts.venueSheet || makeVenueSheet(opts.venues || []));

  const sheetByName = (name) => {
    if (name === 'Venue Addresses') return venueSheet;
    return null;
  };

  const sandbox = {
    Logger: { log: (...a) => logs.push(a.join(' ')) },
    Utilities: {
      sleep: () => {},
      getUuid: () => 'uuid',
      formatDate: () => '2026-10-13 06:30',
      getDay: () => 1
    },
    UrlFetchApp: {
      fetch: () => ({ getResponseCode: () => 500, getContentText: () => '{}' })
    },
    MailApp: { sendEmail: () => {} },
    SpreadsheetApp: {
      getActiveSpreadsheet: () => ({
        getSheetByName: sheetByName,
        getActiveSheet: () => null
      })
    },
    PropertiesService: { getScriptProperties: () => ({ getProperty: () => null }) },
    CacheService: { getScriptCache: () => ({ get: () => null, put: () => {} }) },
    ScriptApp: { getProjectTriggers: () => [], newTrigger: () => ({}) },
    HtmlService: { createHtmlOutput: () => ({ setTitle: () => ({}) }) },
    Date: Date
  };

  vm.createContext(sandbox);
  vm.runInContext(SOURCE + '\n;globalThis.__x = { applyVenueDetails_, ' +
    'applyVenueLink_, loadVenueRecords_, lookupVenueRecord_, ' +
    'normaliseVenueName_, ensureVenueAddressHeaders_ };',
  sandbox, { filename: 'appsscript.gs' });

  // Geocoder is injected so the tests decide what "found it" means, and so a
  // failing test is about the caching logic rather than about a live service.
  sandbox.geocodeAddress_ = opts.geocode || (() => null);

  return Object.assign(sandbox, { logs: logs, venueSheet: venueSheet });
}

// An event row on its way to Published.
function makeRow(overrides) {
  const row = [];
  for (let i = 0; i < 15; i++) row[i] = '';
  Object.assign(row, {
    1: 'Some Band',
    4: new Date('2026-10-16T19:00:00Z'),
    7: 'The Brewery',
    13: 'Approved'
  }, overrides || {});
  return row;
}

const cache = () => ({ geo: { done: 0, capped: false }, seen: {} });


// ================================================================
// ADDRESS
// ================================================================

test('address: a blank address is filled from the Venue Addresses tab', () => {
  const s = loadScript({
    venues: [['The Brewery', '11 Blandford Street, Newcastle NE1 3JA', '', '', '']]
  });
  const records = s.loadVenueRecords_();
  const row = makeRow();

  s.applyVenueDetails_(row, records, cache());

  assert.equal(row[COL.ADDRESS], '11 Blandford Street, Newcastle NE1 3JA');
});

test('address: an address already on the event is never overwritten', () => {
  const s = loadScript({
    venues: [['The Brewery', 'WRONG ADDRESS, Somewhere Else', '', '', '']]
  });
  const records = s.loadVenueRecords_();
  const row = makeRow({ 8: '11 Blandford Street, Newcastle NE1 3JA' });

  s.applyVenueDetails_(row, records, cache());

  assert.equal(row[COL.ADDRESS], '11 Blandford Street, Newcastle NE1 3JA',
    'a hand-corrected address on the event wins over the tab');
});

test('address: a leading "The" is ignored when matching', () => {
  const s = loadScript({
    venues: [['The Brewery', '11 Blandford Street, Newcastle', '', '', '']]
  });
  const records = s.loadVenueRecords_();
  const row = makeRow({ 7: 'Brewery' });

  s.applyVenueDetails_(row, records, cache());

  assert.equal(row[COL.ADDRESS], '11 Blandford Street, Newcastle');
});

test('address: a venue not on the tab leaves the row alone', () => {
  const s = loadScript({
    venues: [['Some Other Venue', '1 Elsewhere Street', '', '', '']]
  });
  const records = s.loadVenueRecords_();
  const row = makeRow({ 7: 'Completely New Place' });

  s.applyVenueDetails_(row, records, cache());

  assert.equal(row[COL.ADDRESS], '');
  assert.equal(row[COL.LAT], '');
});


// ================================================================
// COORDINATES
// ================================================================

test('coordinates: pinned venues fill the event without any lookup', () => {
  const s = loadScript({
    venues: [['The Brewery', '11 Blandford Street, Newcastle', '', 54.9783, -1.6178]],
    // Must never be called - the point is that a pinned venue is free.
    geocode: () => { throw new Error('should not geocode a pinned venue'); }
  });
  const records = s.loadVenueRecords_();
  const row = makeRow();

  s.applyVenueDetails_(row, records, cache());

  assert.equal(row[COL.LAT], 54.9783);
  assert.equal(row[COL.LNG], -1.6178);
});

test('coordinates: a venue with an address but no pin is geocoded once and cached', () => {
  const s = loadScript({
    venues: [['The Brewery', '11 Blandford Street, Newcastle', '', '', '']],
    geocode: () => ({ lat: 54.9783, lng: -1.6178 })
  });
  const records = s.loadVenueRecords_();
  const row = makeRow();

  s.applyVenueDetails_(row, records, cache());

  assert.equal(row[COL.LAT], 54.9783);
  // The whole point: written back to the tab, so tomorrow costs nothing.
  assert.equal(s.venueSheet.getRange(2, 4).getValue(), 54.9783);
  assert.equal(s.venueSheet.getRange(2, 5).getValue(), -1.6178);
});

test('coordinates: two events at one new venue geocode once, not twice', () => {
  let calls = 0;
  const s = loadScript({
    venues: [['The Brewery', '11 Blandford Street, Newcastle', '', '', '']],
    geocode: () => { calls++; return { lat: 54.9783, lng: -1.6178 }; }
  });
  const records = s.loadVenueRecords_();
  const shared = cache();

  s.applyVenueDetails_(makeRow(), records, shared);
  s.applyVenueDetails_(makeRow(), records, shared);

  assert.equal(calls, 1,
    'the second event at the same venue must reuse the cached pin');
});

test('coordinates: existing coordinates on the event are never overwritten', () => {
  const s = loadScript({
    venues: [['The Brewery', '11 Blandford Street, Newcastle', '', 1, 2]],
    geocode: () => ({ lat: 99, lng: 99 })
  });
  const records = s.loadVenueRecords_();
  const row = makeRow({ 9: 54.5, 10: -1.5 });

  s.applyVenueDetails_(row, records, cache());

  assert.equal(row[COL.LAT], 54.5);
  assert.equal(row[COL.LNG], -1.5);
});

test('coordinates: a rate-limited lookup does not throw and does not publish junk', () => {
  const s = loadScript({
    venues: [['The Brewery', '11 Blandford Street, Newcastle', '', '', '']],
    geocode: () => 'RATE_LIMITED'
  });
  const records = s.loadVenueRecords_();
  const row = makeRow();

  s.applyVenueDetails_(row, records, cache());

  assert.equal(row[COL.LAT], '', 'no half-written coordinates');
  assert.equal(row[COL.LNG], '');
});

test('coordinates: an un-geocodable venue is asked about only once per run', () => {
  let calls = 0;
  const s = loadScript({
    venues: [['Nowhere At All', 'No Such Street, Nowhere', '', '', '']],
    geocode: () => { calls++; return null; }
  });
  const records = s.loadVenueRecords_();
  const shared = cache();

  s.applyVenueDetails_(makeRow({ 7: 'Nowhere At All' }), records, shared);
  s.applyVenueDetails_(makeRow({ 7: 'Nowhere At All' }), records, shared);

  assert.equal(calls, 1);
});

test('coordinates: the per-run geocode cap is respected', () => {
  const venues = [];
  for (let i = 0; i < 10; i++) {
    venues.push(['Venue ' + i, 'Street ' + i + ', Newcastle', '', '', '']);
  }
  let calls = 0;
  const s = loadScript({
    venues: venues,
    geocode: () => { calls++; return { lat: 1, lng: 2 }; }
  });
  const records = s.loadVenueRecords_();
  const shared = cache();

  for (let i = 0; i < 10; i++) {
    s.applyVenueDetails_(makeRow({ 7: 'Venue ' + i }), records, shared);
  }

  assert.ok(calls <= 5,
    'a publish run must not geocode without limit; it asked ' + calls + ' times');
  assert.ok(calls > 0, 'but it should geocode some');
});


// ================================================================
// THE CLUNY PROBLEM
//
// "The Cluny" and "The Cluny 2" are separate venues next door to each other with
// different addresses. The old substring match gave The Cluny 2 The Cluny's
// website.
// ================================================================

test('cluny: "The Cluny 2" does not inherit "The Cluny"\'s website', () => {
  const links = { 'the cluny': 'https://thecluny.com', 'the cluny 2': 'https://cluny2.com' };
  const row = makeRow({ 7: 'The Cluny 2', 12: '' });

  loadScript({}).applyVenueLink_(row, links);

  assert.equal(row[COL.SOURCE_URL], 'https://cluny2.com',
    'the exact venue must win');
});

test('cluny: "The Cluny 2" with no entry of its own gets no link at all', () => {
  const links = { 'the cluny': 'https://thecluny.com' };
  const row = makeRow({ 7: 'The Cluny 2', 12: '' });

  loadScript({}).applyVenueLink_(row, links);

  assert.equal(row[COL.SOURCE_URL], '',
    'better no link than the wrong venue\'s link');
});

test('cluny: a comma-qualified name still matches the base venue', () => {
  // "The Enigma Tap, Newcastle" is the same venue as "The Enigma Tap".
  const links = { 'enigma tap': 'https://enigmatap.co.uk' };
  const row = makeRow({ 7: 'The Enigma Tap, Newcastle', 12: '' });

  loadScript({}).applyVenueLink_(row, links);

  assert.equal(row[COL.SOURCE_URL], 'https://enigmatap.co.uk',
    'a trailing qualifier after a comma is the same venue');
});


// ================================================================
// EXISTING EVENT LINKS MUST SURVIVE
// ================================================================

test('links: a real Ticketmaster link is never overwritten', () => {
  const links = { 'the brewery': 'https://thebrewery.com' };
  const row = makeRow({
    7: 'The Brewery',
    12: 'https://www.ticketmaster.co.uk/event/abc123'
  });

  loadScript({}).applyVenueLink_(row, links);

  assert.equal(row[COL.SOURCE_URL], 'https://www.ticketmaster.co.uk/event/abc123');
});

test('links: a real Skiddle link is never overwritten', () => {
  const links = { 'the brewery': 'https://thebrewery.com' };
  const row = makeRow({ 7: 'The Brewery', 12: 'https://www.skiddle.com/12345/' });

  loadScript({}).applyVenueLink_(row, links);

  assert.equal(row[COL.SOURCE_URL], 'https://www.skiddle.com/12345/');
});

test('links: an empty source URL takes the venue default', () => {
  const links = { 'the brewery': 'https://thebrewery.com' };
  const row = makeRow({ 7: 'The Brewery', 12: '' });

  loadScript({}).applyVenueLink_(row, links);

  assert.equal(row[COL.SOURCE_URL], 'https://thebrewery.com');
});

test('links: the Northumberland Folk Diary placeholder is replaced', () => {
  const links = { 'the brewery': 'https://thebrewery.com' };
  const row = makeRow({
    7: 'The Brewery',
    12: 'http://northumbriafolk.org.uk/index.html'
  });

  loadScript({}).applyVenueLink_(row, links);

  assert.equal(row[COL.SOURCE_URL], 'https://thebrewery.com');
});

test('links: a Crack Magazine category page is replaced', () => {
  const links = { 'the brewery': 'https://thebrewery.com' };
  const row = makeRow({
    7: 'The Brewery',
    12: 'https://www.thecrackmagazine.com/whatson?category=live'
  });

  loadScript({}).applyVenueLink_(row, links);

  assert.equal(row[COL.SOURCE_URL], 'https://thebrewery.com');
});


// ================================================================
// THE TAB ITSELF
// ================================================================

test('tab: Latitude and Longitude headings are added, existing ones untouched', () => {
  const s = loadScript({
    venues: [['The Brewery', '11 Blandford Street', 'https://thebrewery.com', '', '']],
    // Deliberately missing the two new headings.
    venueSheet: makeVenueSheet(
      [['The Brewery', '11 Blandford Street', 'https://thebrewery.com', '', '']],
      ['Venue Name', 'Full Address', 'Default Link']
    )
  });

  s.ensureVenueAddressHeaders_();

  assert.equal(s.venueSheet.getRange(1, 4).getValue(), 'Latitude');
  assert.equal(s.venueSheet.getRange(1, 5).getValue(), 'Longitude');
  assert.equal(s.venueSheet.getRange(1, 1).getValue(), 'Venue Name',
    'existing headings must not be rewritten');
});

test('tab: coordinates are read as numbers even when stored as text', () => {
  const s = loadScript({
    venues: [['The Brewery', '11 Blandford Street', '', '54.9783', '-1.6178']]
  });
  const record = s.lookupVenueRecord_(s.loadVenueRecords_(), 'The Brewery');

  assert.strictEqual(record.lat, 54.9783);
  assert.strictEqual(record.lng, -1.6178);
  assert.equal(typeof record.lat, 'number',
    'text coordinates would make the map marker land in the wrong place');
});