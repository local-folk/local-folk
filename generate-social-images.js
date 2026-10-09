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
const LAYOUT = {
  width: 1080,
  height: 1350,
  // The wordmark must sit inside the centre 1080x1080 square, because
  // Instagram's profile grid crops 4:5 to 1:1 from the middle - 135px is lost
  // off the top and 135px off the bottom. At y=72 the wordmark was sliced in
  // half in the grid view.
  wordTop: 148,
  wordSize: 88,
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
  footerSize: 40,
  // Sits above the grid crop's lower edge (1215px) so the footer survives the
  // 1:1 profile grid view.
  footerBottom: 178,
  // Side margin. Wide enough that a long title shrinks the type rather than
  // crowding the edge, since Instagram crops 4:5 to 1:1 in the profile grid.
  textMargin: 74,
  minGap: 46,          // breathing room between list and title / footer
  // A long event title shrinks the whole section rather than wrapping or running
  // off the edge, so the width constraint is allowed to win outright. hardFloor
  // is the point at which text stops being readable on a phone; below it the run
  // fails rather than producing a technically-valid but useless image.
  hardFloor: 0.55,
  maxScale: 1.18       // above this a quiet week reads as a billboard
};

const FOOTER = ['See full list of events at', 'thekirn.co.uk'];

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

function buildLayout(rows) {
  const maxTextWidth = LAYOUT.width - (2 * LAYOUT.textMargin);

  // Line height comes from the font's own vertical metrics, normalised by
  // unitsPerEm so it applies at any pixel size. Using raw font units here
  // against a pixel size is what made the first render overflow.
  const displayMetrics = loaded.display.font;
  const lineFactor = ((displayMetrics.ascender - displayMetrics.descender) / displayMetrics.unitsPerEm) * 1.02;

  // Ascent, as a fraction of font size. Text is positioned by its baseline, so
  // we need to know how far above the baseline the ink starts.
  const ascentFactor = displayMetrics.ascender / displayMetrics.unitsPerEm;

  const footerWidth = FOOTER.reduce((max, line) => Math.max(max, widthOf(line, LAYOUT.footerSize, 'display')), 0);
  const footerHeight = FOOTER.length * LAYOUT.footerSize * lineFactor;

  const wordBaseline = LAYOUT.wordTop + (LAYOUT.wordSize * ascentFactor);
  const wordBottom = LAYOUT.wordTop + (LAYOUT.wordSize * lineFactor);
  const footerTop = LAYOUT.height - LAYOUT.footerBottom - footerHeight;

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
  let widest = footerWidth;
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

  // Scale to fill the gap between wordmark and footer, bounded by height and
  // by the widest single line.
  const gap = footerTop - wordBottom;
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
    rows, footerWidth, footerHeight, longest,
    wordBaseline, wordBottom, footerTop,
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

function renderSvg(rows) {
  const L = buildLayout(rows);
  const parts = [];
  const centreX = LAYOUT.width / 2;

  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${LAYOUT.width}" height="${LAYOUT.height}" viewBox="0 0 ${LAYOUT.width} ${LAYOUT.height}">`);
  parts.push(`<rect width="${LAYOUT.width}" height="${LAYOUT.height}" fill="${COLOURS.background}"/>`);

  // All text is emitted as glyph outlines, so no @font-face is needed and the
  // renderer never has to resolve a font by name.

  // Wordmark, top centre, positioned by its baseline.
  parts.push(pathFor('The Kirn', LAYOUT.wordSize, 'display', centreX, L.wordBaseline, COLOURS.gold));

  // Event list, centred in the gap between the wordmark and the footer.
  let top = L.wordBottom + LAYOUT.minGap + Math.max(0, (L.available - L.bodyHeight * L.scale) / 2);

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

  // Footer, two centred lines.
  let fTop = LAYOUT.height - LAYOUT.footerBottom - L.footerHeight;
  for (const line of FOOTER) {
    parts.push(pathFor(line, LAYOUT.footerSize, 'display', centreX, fTop + (LAYOUT.footerSize * L.ascentFactor), COLOURS.cream));
    fTop += LAYOUT.footerSize * L.lineFactor;
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

/* Archive filenames, e.g. "Weekly 121026" -> "Weekly-121026.png". */
function archiveName(variant, dateLabel) {
  const clean = String(dateLabel).replace(/[^0-9A-Za-z]/g, '');
  return variant + '-' + clean + '.png';
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

    const { svg, layout } = renderSvg(rows);
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
      const payload = path.join(__dirname, 'social', 'preview-' + filename.replace(/\.png$/, '.svg'));
      fs.mkdirSync(path.dirname(payload), { recursive: true });
      fs.writeFileSync(payload, svg, 'utf8');
      console.log('      wrote ' + path.relative(__dirname, payload));
      continue;
    }

    await sharp(Buffer.from(svg, 'utf8'))
      .png({ compressionLevel: 9 })
      .toFile(target);

    console.log('      wrote ' + path.relative(__dirname, target));

    // Instagram's publishing API accepts JPEG only. The PNG above stays as the
    // archive master because it is lossless, and a JPEG copy is written
    // alongside for Meta to fetch by URL.
    const jpgTarget = target.replace(/\.png$/, '.jpg');
    await sharp(Buffer.from(svg, 'utf8'))
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

main().catch((err) => {
  console.error('Failed: ' + err.message);
  process.exitCode = 1;
});
