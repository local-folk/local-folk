# Venue address, coordinates and event links

## What was wrong

Approving an event in the **Pending** tab ran exactly one thing:
`applyVenueLink_`, which fills the venue's **website** into column M. Nothing
touched:

- **Address** (column I)
- **Latitude / Longitude** (columns J, K)

So a hand-entered event arrived with a blank address and no map pin, and the
only way to get them was to run `backfillMissingCoordinates()` by hand, which
geocodes from the web one row at a time.

The **Venue Addresses** tab is maintained by hand and *does* hold the address —
but nothing ever read it back to fill an event. `addNewVenuesToAddressTab_`
writes the address into the tab and then stops.

## What changed — 13 October 2026

`appsscript.gs` only. Adding an event to the Pending tab is unchanged.

**Venue Addresses tab gains two columns:**

| | A | B | C | **D** | **E** |
|---|---|---|---|---|---|
| | Venue Name | Full Address | Default Link | **Latitude** | **Longitude** |

Columns A–C are untouched. The headings are added automatically and are only
ever filled where blank.

**On approving an event:**

1. **Address** is filled from column B — *only if the event's own address is
   blank*. A hand-entered or hand-corrected address always wins.
2. **Coordinates** are filled from columns D/E — again only if the event has
   none.
3. If a venue has an address but has never been pinned, it is **geocoded once**
   and written back to D/E. Every future event at that venue is then instant and
   free. A venue's position does not change, so this is the whole point.

**Rate limiting.** At most `MAX_VENUE_GEOCODES_PER_RUN` (5) new venues are
geocoded in one run, with a ~1.1s gap between requests, and the run stops
quietly if the service asks. Anything skipped is picked up next time. A rate
limit mid-run never writes half a coordinate — it writes nothing.

**One-off backfill.** `backfillVenueCoordinates()` fills D/E for venues you
already have. Run it once after adding the columns; after that nothing needs it,
because approving an event geocodes a new venue on its own.

## The Cluny bug

`applyVenueLink_` fell back to a **substring** match when a venue name was not
an exact match. **"The Cluny 2" contains "The Cluny"**, so The Cluny 2 — a
separate venue next door with a different address — was silently given The
Cluny's website.

The fallback now only matches when the name is followed by a comma, i.e. a
qualifier such as *"The Enigma Tap, Newcastle"*. `Cluny 2` no longer matches
`Cluny`; `Enigma Tap, Newcastle` still matches `Enigma Tap`.

**Better no link than the wrong venue's link.**

## Event URLs are safe

Checked, and unchanged in behaviour: a real event-specific link is **never**
replaced. `applyVenueLink_` only ever overwrites three things:

- an empty cell
- a `northumbriafolk.org.uk` link (every row from that source)
- a `thecrackmagazine.com/whatson` category page

Ticketmaster, Skiddle and any individual event page are left exactly as they
are. Six tests cover this.

## Tests

`events-venues.test.js` — 21 tests, part of `npm test` (90 total with the
social ones).

Coverage: address filled / not overwritten; "The" ignored; unknown venue leaves
the row alone; pinned venue needs no lookup; new venue geocoded once and cached;
two events at one venue geocode once; existing coordinates not overwritten;
rate-limit writes nothing; un-geocodable venue asked once per run; per-run cap;
the Cluny cases; the five link-safety cases; tab headings; text coordinates
read as numbers.

**One bug was found by these tests after the code was written**: the
"already tried this venue" cache used a truthiness check, so a venue that had
*failed* to geocode was looked up again for every event at it. Fixed to test
for presence.