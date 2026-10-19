#!/usr/bin/env node
/*
 * generate-social-images.js
 *
 * Renders the roundup images for thekirn.co.uk social posts.
 *
 * Two variants only, per the agreed specification:
 *   Weekly  - Monday morning, up to 5 events, one per weekday
 *   Weekend - Thursday lunchtime, up to 6 events across Fri/Sat/Sun
 *
 * Both are 1080x1350 (4:5). One size for both platforms: Facebook does not
 * centre-crop in the feed and displays 4:5 larger than 16:9, and Instagram's
 * profile grid crops to 1:1 from the centre, which a mid-frame layout tolerates.
 *
 * Type is measured, not estimated. Every line is measured with the actual font
 * metrics so the layout can wrap long venue names and scale the body to fit,
 * rather than guessing at character widths.
 *
 * Usage:
 *   node generate-social-images.js            render from social-posts.json
 *   node generate-social-images.js --dry      write payloads, render nothing
 */

'use strict';

const fs = require('fs');
const path = require('path');
const opentype = require('opentype.js');
const sharp = require('sharp');

/* ------------------------------------------------------------------ *
 * Brand values, taken from index.html's CSS custom properties
 * ------------------------------------------------------------------ */

const COLOURS = {
  background: '#660000',   // --brand, matches the header and og-image
  gold: '#ffcc33',         // --type-btn-bg, the filter button colour
  cream: '#ffffea'         // --bg / --text, the event listing colour
};

// One layout, used by both variants.
/* ------------------------------------------------------------------ *
 * Background treatments - planning only
 * ------------------------------------------------------------------ *
 *
 * The damask backgrounds are readable but busy: the pattern sits at the same
 * scale and weight as the text, so ornament and letterforms compete. Contrast
 * analysis passes all of them (worst case 6.9:1), which is exactly why the
 * problem only shows up in a render rather than in a number.
 *
 * Two ways to push the pattern back, applied to the background only - the text
 * is never touched:
 *
 *   SCRIM  darkens the background by a fixed factor. Cheaper than editing the
 *          source files and reversible, but it shifts the hue toward black, so
 *          a red background goes muddy rather than staying red.
 *
 *   BLUR   softens the pattern's edges so it stops competing. Preserves the
 *          colour exactly, which is why the two are worth comparing separately
 *          rather than assumed to be interchangeable.
 *
 * Both values are here rather than hard-coded in the composite so they can be
 * tuned by eye against a real render.
 */
const BG_SCRIM = 0.62;   // brightness multiplier; 0.62 = 38% darker

/* Blur sigma, in pixels on the final 1080x1350 image.
 *
 * 14 was far too much - it turned the damask into an indistinct mottled wash
 * and lost the pattern entirely, which defeats the point of having patterned
 * backgrounds. 4 keeps the motif readable as a motif while taking the hard
 * edges off it, so it stops competing with the letterforms without looking
 * out of focus.
 *
 * Sigma is not linear in perception: 14 looks like a heavy gaussian, 4 looks
 * like a gentle softening. Worth re-rendering rather than halving.
 */
const BG_BLUR = 4;

/* The ways each background is rendered, so the treatment can be chosen on
 * evidence rather than taste.
 *
 * "plain" and "scrim" are retained so the combined result still has something
 * to be compared against. Blur-only was dropped: the scrim is what actually
 * moves the numbers, and blur-only left the pattern edges just soft enough to
 * still be busy rather than calm. Kept as its own entry if it is ever wanted.
 */
const TREATMENTS = [
  { key: 'plain', blur: 0, brightness: 1 },
  { key: 'scrim', blur: 0, brightness: BG_SCRIM },
  { key: 'both', blur: BG_BLUR, brightness: BG_SCRIM }
];

// Whether to protect the Instagram profile grid. See the note below - this has
// to be declared before LAYOUT, which reads it.
//
// FLIPPED TO FALSE on 13 October 2026, at the owner's instruction, after seeing
// a real published post. With it true the image had thick black borders and text
// too small to read comfortably in the feed - which is where a post is actually
// read. The only thing given up is a clean crop in the Instagram *profile* grid,
// which costs the top and bottom of the wordmark on a page most visitors never
// open. The feed matters more than the grid.
//
// To go back: set true. Nothing else needs changing.
const GRID_SAFE = false;

const LAYOUT = {
  width: 1080,
  height: 1350,
  // The wordmark must sit inside the centre 1080x1080 square, because
  // Instagram's profile grid crops 4:5 to 1:1 from the middle - 135px is lost
  // off the top and 135px off the bottom. At y=72 the wordmark was sliced in
  // half in the grid view.
  wordTop: 140,
  // The frame is 1350px tall and every element in it is competing for the same
  // height, so these three numbers trade directly against each other.
  //
  // Measured across the whole grid on real data (scale = how large the event
  // list renders; below 0.55 the generator refuses to write the image):
  //
  //   word 96  sub 64  2 lines  scale 0.57   <- previous, subtitle too big
  //   word 88  sub 64  2 lines  scale 0.54   rejected
  //   word 64  sub 64  2 lines  scale 0.57   previous, wordmark too small
  //
  //   word 96  sub 46  2 lines  scale 0.61   <- chosen
  //   word 88  sub 46  2 lines  scale 0.62
  //
  // The wordmark is big again, the subtitle is clearly subordinate to it, and
  // the events are larger than before. Those three could not all be true at
  // 64/64.
  //
  // On ignoring the profile-grid crop entirely (see GRID_SAFE): events reach
  // scale 0.73, but the wordmark is sliced in half on the profile. Worth
  // flipping if the grid matters less than size in the feed.
  wordSize: 96,
  // Subtitle: "// 12-16 OCT //" then "WEEKLY ROUNDUP", two centred lines.
  // Deliberately smaller than the wordmark - it is information, not branding,
  // and at 88px it crowded out the events.
  subtitleSize: 46,
  subtitleGap: 16,
  // Gap between the two subtitle lines. Tighter than the gap to the event list,
  // so the pair reads as one block.
  subtitleLineGap: 6,
  daySize: 48,
  itemSize: 46,
  // Venue sits on its own line under the event title, slightly smaller.
  venueSize: 38,
  itemGap: 12,
  dayGap: 20,
  blockGap: 32,
  // Gap between a title and its venue. Tighter than the gap between separate
  // events, so the pair reads as one unit.
  titleVenueGap: 9,
  // Removed 12 October 2026: the "See full list of events at thekirn.co.uk"
  // footer. The caption already carries that line, and Instagram cannot make
  // it clickable anyway, so it was taking two lines of image for nothing.
  //
  // Bottom margin for the event list, and the top margin above the wordmark,
  // exist for ONE reason: Instagram's profile grid shows posts as 1:1 squares
  // cut from the centre of a 4:5 image, which discards 135px off the top and
  // 135px off the bottom. Between them these margins give up 20% of the frame.
  //
  // The owner's point that "the feed shows all of it anyway" is correct - in the
  // feed nothing is cropped. But the profile grid is the shop window: if the
  // wordmark is sliced in half there, that is what a visitor scrolling the
  // profile sees. So the margins stay by default.
  //
  // Setting GRID_SAFE to false fills the frame instead. The events grow from
  // scale 0.61 to about 0.73 - much more legible - and the wordmark is cut in
  // the profile grid. A deliberate trade, not an oversight.
  //
  // Both were verified by rendering the actual 1:1 centre crop and looking at
  // it, not by reasoning about it.

  // Top margin above the wordmark, and bottom margin below the last event.
  // Both are the minimum that keeps their content inside the grid crop when
  // GRID_SAFE is true, and near-flush with the frame when it is false.
  wordTop: GRID_SAFE ? 140 : 64,
  bottomEdge: GRID_SAFE ? 135 : 56,
  // Side margin. Was 74; the event list is height-constrained rather than
  // width-constrained, so this is free to tighten - it just gives long titles a
  // little more room before they have to shrink.
  textMargin: 60,
  minGap: 34,          // breathing room between list and subtitle
  // A long event title shrinks the whole section rather than wrapping or running
  // off the edge, so the width constraint is allowed to win outright. hardFloor
  // is the point at which text stops being readable on a phone; below it the run
  // fails rather than producing a technically-valid but useless image.
  hardFloor: 0.55,
  maxScale: 1.18       // above this a quiet week reads as a billboard
};

/* The subtitle, e.g. "// 12-16 OCT // WEEKLY ROUNDUP". Built by post-header.js,
 * the same module the caption uses, so the image and the post text cannot
 * disagree about the date range.
 *
 * SIZE, AND WHY IT IS NOT 88px
 * -----------------------------
 * The owner asked for the subtitle at the same size as the wordmark. That is
 * geometrically impossible with a five-event roundup, and the numbers are
 * worth recording so it is not retried:
 *
 *   "// 12-16 OCT // WEEKLY ROUNDUP" is 1473px wide at 88px, against 932px of
 *   usable width, so on one line it lands at about 59px.
 *
 *   Split across two lines both lines fit at 88px, but two lines of 88px eat
 *   the vertical space the events need: the body drops to scale 0.49, below
 *   the 0.55 legibility floor, and the generator refuses to write the image.
 *
 * Measured across every combination, on real data:
 *
 *   2 lines @88  scale 0.49  rejected    1 line @59  scale 0.62  works
 *   2 lines @72  scale 0.52  rejected    1 line @56  scale 0.63  works
 *   2 lines @64  scale 0.54  rejected    2 lines @64, wordmark 64  scale 0.57
 *
 * So the one-line form is chosen: it keeps the wordmark at its full 88px AND
 * leaves the event list at 0.62, which is better than the 0.59 the events ran
 * at before the subtitle existed. Legibility of the actual event list wins
 * over the decorative size of the header.
 *
 * If the subtitle is ever wanted at exactly the wordmark's size, both must
 * come down to about 64px - see SUBTITLE_EQUAL_SIZE below.
 */
/* The subtitle lines, built by post-header.js - the same module the caption
 * builder uses, so the image and the post text cannot disagree about the date.
 */
const { splitLines } = require('./post-header.js');

/* ------------------------------------------------------------------ *
 * Background rotation
 * ------------------------------------------------------------------ */

/* Picks the background for a post from social/backgrounds/.
 *
 * The files carry a numeric prefix, and that prefix IS the rotation order -
 * lock-backgrounds.js chose it so that consecutive numbers are the most
 * different pairs of colours available. So the order in which the files are
 * named is doing the work, and selecting the nth file by index preserves it.
 *
 * Selection is by ISO week number rather than a stored counter, so it needs no
 * state between runs and gives the same answer on any machine. Consecutive
 * weeks land on consecutive indexes, which is exactly the property the ordering
 * was built for.
 *
 * The Monday and Thursday posts of the same week therefore share a background,
 * which reads as deliberate - one look for the week - rather than as a bug.
 *
 * The backgrounds already have the scrim and blur baked in, so nothing is
 * applied here. Adding either again would darken them a second time.
 */
function pickBackground(date) {
  const dir = path.join(__dirname, 'social', 'backgrounds');
  if (!fs.existsSync(dir)) return null;

  const files = fs.readdirSync(dir)
    .filter((f) => /\.(png|jpe?g)$/i.test(f))
    .sort();

  if (!files.length) return null;

  const week = isoWeekNumber_(date || new Date());
  const chosen = files[week % files.length];

  // Guard the wrap: week 0 of the year must not pick a negative index.
  const idx = ((week % files.length) + files.length) % files.length;

  return { file: path.join(dir, files[idx]), name: files[idx], index: idx, total: files.length, week };
}

/* ISO 8601 week number, 1-53. The naive "day of year / 7" is wrong around
 * year boundaries, which is precisely when a rotation is most likely to be
 * looked at closely. */
function isoWeekNumber_(date) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNum = (d.getUTCDay() + 6) % 7;          // Monday = 0
  d.setUTCDate(d.getUTCDate() - dayNum + 3);      // Thursday of this week
  const isoYear = d.getUTCFullYear();
  const firstThursday = new Date(Date.UTC(isoYear, 0, 4));
  const firstDayNum = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDayNum + 3);
  return 1 + Math.round((d - firstThursday) / (7 * 24 * 3600 * 1000));
}

/* ------------------------------------------------------------------ *
 * Fonts
 *
 * Both are committed here and their glyph outlines are emitted as SVG paths, so
 * no font has to be installed on the runner and no build-time download can fail.
 *
 * IM Fell English has no italic cut, so the footer uses the regular one.
 * Day headings use EB Garamond because IM Fell English's old-style figures
 * render "12/10" with a short 1 that reads like "1o". EB Garamond is a
 * Palatino-lineage revival, so it sits naturally beside IM Fell English, and
 * it is OFL licensed so it may be committed to the repository.
 * ------------------------------------------------------------------ */

const FONT_DIR = path.join(__dirname, 'fonts');

const FONTS = {
  display: {
    family: 'KirnDisplay',   // internal name, avoids collision with anything installed
    file: 'IMFellEnglish-Regular.ttf',
    licence: 'IM Fell English - SIL Open Font License 1.1'
  },
  heading: {
    family: 'KirnHeading',
    file: 'EBGaramond-Regular.ttf',
    licence: 'EB Garamond - SIL Open Font License 1.1'
  }
};

const loaded = {};

function loadFonts() {
  for (const key of Object.keys(FONTS)) {
    const spec = FONTS[key];
    const file = path.join(FONT_DIR, spec.file);
    if (!fs.existsSync(file)) {
      throw new Error(
        'Font file missing: ' + file + '\n' +
        'Both fonts are committed to the repo under fonts/. See the licence note in SOCIAL-POSTS-SPEC.md.'
      );
    }
    const buffer = fs.readFileSync(file);
    loaded[key] = {
      spec,
      font: opentype.parse(
        buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)
      )
    };
  }
}

/* ------------------------------------------------------------------ *
 * Text measurement
 * ------------------------------------------------------------------ */

function widthOf(text, size, fontKey) {
  if (!text) return 0;
  return loaded[fontKey].font.getAdvanceWidth(text, size);
}

/*
 * Text as vector paths, not as <text> elements.
 *
 * sharp bundles librsvg, which ignores @font-face with base64 data URIs and
 * silently falls back to a generic serif. Confirmed by rendering: a test string
 * intended as IM Fell English came out as DejaVu Serif. That is why the workflow
 * images looked wrong on the runner even though local PowerShell previews were
 * fine - System.Drawing had the fonts installed, librsvg does not.
 *
 * Emitting glyph outlines sidesteps the problem entirely: the letterforms are
 * in the SVG, so nothing has to be installed or resolved at render time. It also
 * makes output deterministic across machines, which matters for an archive.
 */
function pathFor(text, size, fontKey, centreX, baselineY, colour) {
  const font = loaded[fontKey].font;
  const x = centreX - (font.getAdvanceWidth(text, size) / 2);
  const path = font.getPath(text, x, baselineY, size);
  if (!path.commands.length) return '';
  return '<path d="' + path.toPathData(3) + '" fill="' + colour + '"/>';
}

/* ------------------------------------------------------------------ *
 * Layout
 *
 * Produces the list of positioned lines and the scale that was applied.
 * Kept separate from rendering so it can be tested without sharp.
 * ------------------------------------------------------------------ */

function buildLayout(rows, subtitle) {
  const maxTextWidth = LAYOUT.width - (2 * LAYOUT.textMargin);

  // Line height comes from the font's own vertical metrics, normalised by
  // unitsPerEm so it applies at any pixel size. Using raw font units here
  // against a pixel size is what made the first render overflow.
  const displayMetrics = loaded.display.font;
  const lineFactor = ((displayMetrics.ascender - displayMetrics.descender) / displayMetrics.unitsPerEm) * 1.02;

  // Ascent, as a fraction of font size. Text is positioned by its baseline, so
  // we need to know how far above the baseline the ink starts.
  const ascentFactor = displayMetrics.ascender / displayMetrics.unitsPerEm;

  const wordBaseline = LAYOUT.wordTop + (LAYOUT.wordSize * ascentFactor);
  const wordBottom = LAYOUT.wordTop + (LAYOUT.wordSize * lineFactor);

  // Subtitle sits under the wordmark, in the cream body colour rather than gold -
  // it is information, not branding. See the note at the top of this file for
  // why it cannot be 88px.
  //
  // EB Garamond, not the display face. IM Fell English has old-style figures,
  // which render "12-16" with a short 1 that reads like "1o" - the same reason
  // the day headings use EB Garamond. A date range is mostly digits, so it is
  // exactly the case that hurts most.
  const subLines = (subtitle && subtitle.length) ? subtitle : [];
  const fittedSub = [];

  subLines.forEach(function (line) {
    let size = LAYOUT.subtitleSize;
    let w = widthOf(line, size, 'heading');
    if (w > maxTextWidth) {
      size = size * (maxTextWidth / w);
      w = widthOf(line, size, 'heading');
    }
    fittedSub.push({ text: line, size: size, width: w });
  });

  const subtitleBaselines = [];
  let subCursor = wordBottom + LAYOUT.subtitleGap;
  fittedSub.forEach(function (line, i) {
    subtitleBaselines.push(subCursor + (line.size * ascentFactor));
    subCursor += line.size * lineFactor;
    if (i < fittedSub.length - 1) subCursor += LAYOUT.subtitleLineGap;
  });

  const subtitleBottom = fittedSub.length ? subCursor : wordBottom;

  // The list is bounded by the bottom safe edge rather than by a footer. That
  // keeps every event line inside the centre 1080x1080 square, so the Instagram
  // profile grid cannot crop an event off.
  const bottomEdge = LAYOUT.height - LAYOUT.bottomEdge;

  // Accepts either {title, venue} objects or plain strings, so an older
  // social-posts.json still renders rather than throwing.
  const linesOf = (event) => {
    if (typeof event === 'string') return [{ text: event, size: LAYOUT.itemSize, key: 'display', role: 'title' }];
    const out = [];
    if (event && event.title) out.push({ text: event.title, size: LAYOUT.itemSize, key: 'display', role: 'title' });
    if (event && event.venue) out.push({ text: event.venue, size: LAYOUT.venueSize, key: 'display', role: 'venue' });
    return out;
  };

  // Event lines are never wrapped. The owner's instruction is that a line
  // should shrink the whole section rather than break onto a second line, so
  // width is a constraint on the scale, never a reason to wrap.
  //
  // Seeded from the subtitle so a long header cannot be pushed off the edge by
  // a body that happens to be narrow.
  let widest = fittedSub.reduce((m, l) => Math.max(m, l.width), 0);
  let longest = '';
  for (const row of rows) {
    const dayW = widthOf(row.day, LAYOUT.daySize, 'heading');
    widest = Math.max(widest, dayW);
    if (dayW >= widthOf(longest, LAYOUT.itemSize, 'display')) longest = row.day;

    for (const event of row.events) {
      for (const line of linesOf(event)) {
        const w = widthOf(line.text, line.size, line.key);
        widest = Math.max(widest, w);
        if (w >= widthOf(longest, LAYOUT.itemSize, 'display')) longest = line.text;
      }
    }
  }

  let bodyHeight = 0;
  for (const row of rows) {
    bodyHeight += LAYOUT.daySize * lineFactor + LAYOUT.dayGap;
    for (const event of row.events) {
      const lines = linesOf(event);
      for (let i = 0; i < lines.length; i++) {
        bodyHeight += lines[i].size * lineFactor;
        bodyHeight += (i < lines.length - 1) ? LAYOUT.titleVenueGap : LAYOUT.itemGap;
      }
    }
    bodyHeight += LAYOUT.blockGap;
  }

  // Scale to fill the gap between the subtitle and the bottom safe edge, bounded
  // by height and by the widest single line.
  const gap = bottomEdge - subtitleBottom;
  const available = gap - (2 * LAYOUT.minGap);

  let scale = Math.min(available / bodyHeight, maxTextWidth / widest);
  let clipped = false;
  if (scale < LAYOUT.hardFloor) {
    // A single line is so long that even at the smallest readable size it will
    // not fit. Refuse rather than write an image with text off the edge.
    clipped = true;
    scale = LAYOUT.hardFloor;
  }
  if (scale > LAYOUT.maxScale) scale = LAYOUT.maxScale;

  // venueSize and titleVenueGap scale with everything else.
  const venueSize = LAYOUT.venueSize * scale;
  const titleVenueGap = LAYOUT.titleVenueGap * scale;

  return {
    scale, clipped, lineFactor, ascentFactor,
    rows, longest,
    wordBaseline, wordBottom,
    fittedSub, subtitleBaselines,
    bodyTop: subtitleBottom,
    daySize: LAYOUT.daySize * scale,
    itemSize: LAYOUT.itemSize * scale,
    venueSize, titleVenueGap, linesOf,
    dayGap: LAYOUT.dayGap * scale,
    itemGap: LAYOUT.itemGap * scale,
    blockGap: LAYOUT.blockGap * scale,
    bodyHeight, maxTextWidth, available, widest
  };
}

/* ------------------------------------------------------------------ *
 * Render
 * ------------------------------------------------------------------ */

function renderSvg(rows, subtitle, solidBackground) {
  const L = buildLayout(rows, subtitle);
  const parts = [];
  const centreX = LAYOUT.width / 2;

  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${LAYOUT.width}" height="${LAYOUT.height}" viewBox="0 0 ${LAYOUT.width} ${LAYOUT.height}">`);

  // Omitted when a background image is going to be composited underneath, so the
  // SVG carries only the text and the image shows through. The transparent
  // background is what lets that work.
  if (solidBackground !== false) {
    parts.push(`<rect width="${LAYOUT.width}" height="${LAYOUT.height}" fill="${COLOURS.background}"/>`);
  }

  // All text is emitted as glyph outlines, so no @font-face is needed and the
  // renderer never has to resolve a font by name.

  // Wordmark, top centre, positioned by its baseline.
  parts.push(pathFor('The Kirn', LAYOUT.wordSize, 'display', centreX, L.wordBaseline, COLOURS.gold));

  // Subtitle under it, two centred lines, in the cream body colour rather than
  // gold. Rendered in EB Garamond because IM Fell English's old-style figures
  // turn "12-16" into something that reads like "1z-16", and a date range is
  // mostly digits.
  for (let i = 0; i < L.fittedSub.length; i++) {
    const line = L.fittedSub[i];
    parts.push(pathFor(line.text, line.size, 'heading', centreX, L.subtitleBaselines[i], COLOURS.cream));
  }

  // Event list, centred in the gap between the subtitle and the bottom edge.
  let top = L.bodyTop + LAYOUT.minGap + Math.max(0, (L.available - L.bodyHeight * L.scale) / 2);

  for (const row of L.rows) {
    parts.push(pathFor(row.day, L.daySize, 'heading', centreX, top + (L.daySize * L.ascentFactor), COLOURS.cream));
    top += L.daySize * L.lineFactor + L.dayGap;

    for (const event of row.events) {
      const lines = L.linesOf(event);
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        // Explicit, rather than comparing sizes back to the base layout.
        const size = line.role === 'venue' ? L.venueSize : L.itemSize;
        parts.push(pathFor(line.text, size, line.key, centreX, top + (size * L.ascentFactor), COLOURS.cream));
        top += size * L.lineFactor;
        top += (i < lines.length - 1) ? L.titleVenueGap : L.itemGap;
      }
    }
    top += L.blockGap;
  }

  parts.push('</svg>');
  return { svg: parts.join('\n'), layout: L };
}

/* ------------------------------------------------------------------ *
 * Input
 *
 * Reads a small JSON file describing the posts to render. Keeping this as
 * data means the image generator does not need to know how events were
 * selected, and the selection step can be tested without rendering anything.
 * ------------------------------------------------------------------ */

function readInput() {
  const inputPath = path.join(__dirname, 'social-posts.json');
  if (!fs.existsSync(inputPath)) {
    // Not an error: selection only produces this file on Monday and Thursday.
    // A manual workflow run on any other weekday legitimately has nothing to
    // render, and should finish green rather than fail.
    console.log('No social-posts.json - nothing due today. Nothing to render.');
    return { posts: [] };
  }
  return JSON.parse(fs.readFileSync(inputPath, 'utf8'));
}

/* Archive filenames now come from the shared helper, because two
 * implementations of this rule is what broke rebuilt posts on 19 Oct 2026.
 * The renderer writes the file; build-captions.js has to name it identically
 * or ImageVariant points at a file that was never created. */
const { archiveName } = require('./archive-name.js');

/* ------------------------------------------------------------------ *
 * Background preview - planning only
 * ------------------------------------------------------------------ */

/* Renders every post against every background in social/backgrounds/, plus the
 * existing solid colour, so the options can be compared.
 *
 * The solid colour is included deliberately: it is the design that has been in
 * use, and any new background has to be judged against it rather than on its
 * own. It is rendered through the identical code path, so the comparison is
 * fair.
 */
async function previewBackgrounds_(posts) {
  const bgDir = path.join(__dirname, 'social', 'backgrounds');
  const outDir = path.join(__dirname, 'social', 'background-preview');

  if (!fs.existsSync(bgDir)) {
    console.log('No social/backgrounds/ folder - nothing to preview.');
    console.log('Create it and drop PNG or JPG images in.');
    return;
  }

  const files = fs.readdirSync(bgDir)
    .filter((f) => /\.(png|jpe?g|webp)$/i.test(f))
    .sort();

  if (!files.length) {
    console.log('social/backgrounds/ has no images. Nothing to preview.');
    return;
  }

  // Wiped each run, so a removed background does not leave a stale preview
  // behind to be mistaken for a current one.
  if (fs.existsSync(outDir)) fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });

  console.log('Background preview - ' + files.length + ' background(s) x ' +
    posts.length + ' post(s) x ' + TREATMENTS.length + ' treatment(s)');
  console.log('Writing to social/background-preview/ (the live archive is untouched)');
  console.log('');

  for (const post of posts) {
    const rows = post.rows || [];
    if (!rows.length) continue;

    const subtitle = splitLines(post);
    const name = archiveName(post.variant, post.dateLabel || '').replace(/\.png$/, '');

    // Two renders of the same layout: one opaque for the solid baseline, one
    // transparent so a background image can show through. An opaque SVG over an
    // image background simply paints over it, which is exactly the bug that
    // made every first attempt come out maroon.
    const solidRender = renderSvg(rows, subtitle, true);
    const overlayRender = renderSvg(rows, subtitle, false);

    if (solidRender.layout.clipped) {
      console.log('SKIP  ' + name + ' - the event list does not fit on this post.');
      continue;
    }

    // The existing design, rendered first and labelled as the baseline.
    const solid = path.join(outDir, name + '--00-solid-current.png');
    await sharp(Buffer.from(solidRender.svg, 'utf8'))
      .png({ compressionLevel: 9 })
      .toFile(solid);
    console.log('  00  solid ' + COLOURS.background + '   (the design in use now)');

    // One render per background per treatment, so scrim and blur can be judged
    // on their own merits rather than assumed to be interchangeable.
    for (const t of TREATMENTS) {
      const text = await sharp(Buffer.from(overlayRender.svg, 'utf8')).png().toBuffer();

      for (let i = 0; i < files.length; i++) {
        const f = files[i];
        const slug = f.replace(/\.[^.]+$/, '').replace(/[^A-Za-z0-9]+/g, '-');
        const target = path.join(outDir,
          name + '--' + t.key + '-' + String(i + 1).padStart(2, '0') + '-' + slug + '.png');

        try {
          // Resize first, then treat, so the blur radius is in final-image
          // pixels rather than the source's - otherwise a 542x678 background
          // gets a much softer blur than a 1536x1920 one and the comparison
          // stops being like-for-like.
          let bg = sharp(path.join(bgDir, f))
            .resize(LAYOUT.width, LAYOUT.height, { fit: 'cover', position: 'centre' });

          if (t.blur) bg = bg.blur(t.blur);
          if (t.brightness) bg = bg.modulate({ brightness: t.brightness });

          await bg
            .composite([{ input: text }])
            .png({ compressionLevel: 9 })
            .toFile(target);
        } catch (err) {
          console.log('  ' + t.key + '  ' + f + '  FAILED: ' + err.message);
        }
      }
      console.log('  ' + t.key.padEnd(6) + 'rendered ' + files.length + ' background(s)');
    }
  }

  console.log('');
  console.log('Preview images are in social/background-preview/.');
  console.log('Run "node analyse-backgrounds.js" for the readability report.');
}


/* ------------------------------------------------------------------ *
 * Main
 * ------------------------------------------------------------------ */

async function main() {
  const dry = process.argv.includes('--dry');
  loadFonts();

  const input = readInput();
  const posts = Array.isArray(input.posts) ? input.posts : [];

  if (posts.length === 0) {
    console.log('Nothing to render.');
    return;
  }

  // --backgrounds is a planning aid: it renders every post against every image
  // in social/backgrounds/ so the options can be compared side by side.
  //
  // It writes to social/background-preview/ and never touches social/archive/,
  // so it cannot affect what gets published or what the queue file points at.
  if (process.argv.includes('--backgrounds')) {
    await previewBackgrounds_(posts);
    return;
  }

  const archiveDir = path.join(__dirname, 'social', 'archive');
  fs.mkdirSync(archiveDir, { recursive: true });

  console.log('Rendering ' + posts.length + ' post(s)' + (dry ? ' (dry run)' : ''));
  console.log('Fonts: ' + Object.keys(FONTS).map((k) => FONTS[k].licence).join(' | '));
  console.log('');

  let failures = 0;

  for (const post of posts) {
    const rows = post.rows || [];
    if (rows.length === 0) {
      console.log('SKIP  ' + post.variant + ' - no rows');
      continue;
    }

    // Background chosen by ISO week, so each week rotates to the next colour.
    // A missing or unreadable backgrounds folder is not fatal: the post simply
    // renders on the brand's solid maroon, which is what it has always done.
    const background = pickBackground(new Date());
    if (background) {
      console.log('      background: ' + background.name +
        '  (week ' + background.week + ', ' + (background.index + 1) + '/' + background.total + ')');
    }

    const { svg, layout } = renderSvg(rows, splitLines(post), !background);
    const filename = archiveName(post.variant, post.dateLabel || '');
    const target = path.join(archiveDir, filename);

    if (layout.clipped) {
      failures++;
      // Do not write the image. A clipped image has text running off the edge,
      // which is worse than no image at all - the archive would look complete
      // while containing something unusable.
      console.log('FAIL  ' + filename + ' - a line is too long to fit at a readable size.');
      console.log('      Longest line: "' + layout.longest + '"');
      console.log('      Needs scale ' + (layout.maxTextWidth / layout.widest).toFixed(2) +
        ', floor is ' + LAYOUT.hardFloor + '.');
      console.log('      Shorten the title in the sheet, or reduce the event count.');
      continue;
    } else {
      console.log('OK    ' + filename + '  scale=' + layout.scale.toFixed(2) +
        '  events=' + rows.reduce((n, r) => n + r.events.length, 0) +
        '  width=' + Math.round(layout.widest) + '/' + layout.maxTextWidth);
    }

    if (dry) {
      // Previews go in social-preview/ at the project root, not in social/.
      // social/ is committed and deployed to the website, so dropping scratch
      // SVGs in there put files on the public site for no reason.
      const payload = path.join(__dirname, 'social-preview',
        filename.replace(/\.png$/, '.svg'));
      fs.mkdirSync(path.dirname(payload), { recursive: true });
      fs.writeFileSync(payload, svg, 'utf8');
      console.log('      wrote ' + path.relative(__dirname, payload));
      continue;
    }

    // The background is the BASE of the image and the text goes on top.
    //
    // The text layer must have a transparent background, or it becomes an
    // opaque white rectangle that hides the background completely - which is
    // what an earlier version did, rendering the post with invisible cream text
    // on white. That is why renderSvg was called with solidBackground=false:
    // the SVG then carries no <rect> at all.
    const textLayer = background
      ? await sharp(Buffer.from(svg, 'utf8')).png().toBuffer()
      : null;

    const compose = (pipeline) => background
      ? sharp(background.file).composite([{ input: textLayer }])
      : pipeline;

    await compose(sharp(Buffer.from(svg, 'utf8')))
      .png({ compressionLevel: 9 })
      .toFile(target);

    console.log('      wrote ' + path.relative(__dirname, target));

    // Instagram's publishing API accepts JPEG only. The PNG above stays as the
    // archive master because it is lossless, and a JPEG copy is written
    // alongside for Meta to fetch by URL.
    const jpgTarget = target.replace(/\.png$/, '.jpg');
    await compose(sharp(Buffer.from(svg, 'utf8')))
      .jpeg({ quality: 92, chromaSubsampling: '4:4:4' })
      .toFile(jpgTarget);

    console.log('      wrote ' + path.relative(__dirname, jpgTarget) + '  (for Instagram)');
  }

  console.log('');
  if (failures > 0) {
    console.log(failures + ' image(s) would clip. Nothing above should be published.');
    process.exitCode = 1;
  }
}

/* Exported so the layout can be rendered in isolation - by the background
 * comparison sheet, and by tests - without running the whole pipeline. Guarded
 * by require.main so running the script from the command line is unaffected. */
module.exports = {
  renderSvg, buildLayout, splitLines, pickBackground, isoWeekNumber_,
  loadFonts, LAYOUT, COLOURS
};

if (require.main === module) {
  main().catch((err) => {
    console.error('Failed: ' + err.message);
    process.exitCode = 1;
  });
}