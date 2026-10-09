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
  wordTop: 72,
  wordSize: 88,
  daySize: 48,
  itemSize: 46,
  itemGap: 12,
  dayGap: 20,
  blockGap: 32,
  footerSize: 40,
  footerBottom: 64,
  textMargin: 62,
  minGap: 46,          // breathing room between list and title / footer
  minScale: 0.55,      // below this we error rather than clip
  maxScale: 1.18       // above this a quiet week reads as a billboard
};

const FOOTER = ['See full list of events at', 'thekirn.co.uk'];

/* ------------------------------------------------------------------ *
 * Fonts
 *
 * Both are embedded in the SVG as base64. Nothing depends on a font being
 * installed on the runner, and no build-time download can fail.
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
      base64: buffer.toString('base64'),
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

/* Break on spaces so a line fits maxWidth. Always returns at least one line. */
function wrapText(text, size, fontKey, maxWidth) {
  if (!text) return [''];
  if (widthOf(text, size, fontKey) <= maxWidth) return [text];

  const words = String(text).split(/\s+/);
  const lines = [];
  let current = '';

  for (const word of words) {
    const candidate = current === '' ? word : current + ' ' + word;
    if (widthOf(candidate, size, fontKey) <= maxWidth || current === '') {
      current = candidate;
    } else {
      lines.push(current);
      current = word;
    }
  }
  if (current !== '') lines.push(current);
  return lines;
}

/* ------------------------------------------------------------------ *
 * SVG helpers
 * ------------------------------------------------------------------ */

function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function fontFaceCss() {
  return Object.keys(FONTS).map((key) => {
    const f = loaded[key];
    return `@font-face {
  font-family: '${f.spec.family}';
  src: url(data:font/ttf;base64,${f.base64}) format('truetype');
  font-weight: normal;
  font-style: normal;
}`;
  }).join('\n');
}

/* One centred line of text. */
function textLine(text, size, colour, y, fontKey, extra) {
  return `<text x="${LAYOUT.width / 2}" y="${y}" fill="${colour}" font-family="${FONTS[fontKey].family}" font-size="${size}" text-anchor="middle"${extra || ''}>${escapeXml(text)}</text>`;
}

/* ------------------------------------------------------------------ *
 * Layout
 *
 * Produces the list of positioned lines and the scale that was applied.
 * Kept separate from rendering so it can be tested without sharp.
 * ------------------------------------------------------------------ */

function buildLayout(rows) {
  const maxTextWidth = LAYOUT.width - (2 * LAYOUT.textMargin);

  // Measure the wordmark and footer at fixed size.
  //
  // Line height comes from the font's own vertical metrics, normalised by
  // unitsPerEm so it applies at any pixel size. Using raw font units here
  // against a pixel size is what made the first render overflow.
  const displayMetrics = loaded.display.font;
  const lineFactor = ((displayMetrics.ascender - displayMetrics.descender) / displayMetrics.unitsPerEm) * 1.02;
  const wordHeight = LAYOUT.wordSize * lineFactor;

  const footerLines = FOOTER.map((line) => {
    const w = widthOf(line, LAYOUT.footerSize, 'display');
    return { text: line, width: w };
  });
  const footerWidth = footerLines.reduce((max, l) => Math.max(max, l.width), 0);
  const footerHeight = footerLines.length * LAYOUT.footerSize * lineFactor;

  const titleBottom = LAYOUT.wordTop + wordHeight;
  const footerTop = LAYOUT.height - LAYOUT.footerBottom - footerHeight;

  // Wrap every line at base size and measure the block.
  const blocks = rows.map((row) => {
    const heading = wrapText(row.day, LAYOUT.daySize, 'heading', maxTextWidth);
    const events = [];
    for (const event of row.events) {
      const wrapped = wrapText(event, LAYOUT.itemSize, 'display', maxTextWidth);
      events.push(wrapped);
    }
    return { day: row.day, heading, events };
  });

  let bodyHeight = 0;
  let widest = footerWidth;
  for (const block of blocks) {
    for (const line of block.heading) {
      bodyHeight += LAYOUT.daySize * lineFactor;
      widest = Math.max(widest, widthOf(line, LAYOUT.daySize, 'heading'));
    }
    bodyHeight += LAYOUT.dayGap;
    for (const wrapped of block.events) {
      for (const line of wrapped) {
        bodyHeight += LAYOUT.itemSize * lineFactor;
        widest = Math.max(widest, widthOf(line, LAYOUT.itemSize, 'display'));
      }
      bodyHeight += LAYOUT.itemGap;
    }
    bodyHeight += LAYOUT.blockGap;
  }

  // Scale to fill the gap between title and footer, bounded by height and width.
  const gap = footerTop - titleBottom;
  const available = gap - (2 * LAYOUT.minGap);

  let scale = Math.min(available / bodyHeight, maxTextWidth / widest);
  let clipped = false;
  if (scale < LAYOUT.minScale) {
    clipped = true;
    scale = LAYOUT.minScale;
  }
  if (scale > LAYOUT.maxScale) scale = LAYOUT.maxScale;

  const daySize = LAYOUT.daySize * scale;
  const itemSize = LAYOUT.itemSize * scale;
  const dayGap = LAYOUT.dayGap * scale;
  const itemGap = LAYOUT.itemGap * scale;
  const blockGap = LAYOUT.blockGap * scale;

  return {
    scale, clipped, blocks, footerLines, lineFactor,
    titleBottom, footerTop, footerWidth, footerHeight,
    wordHeight,
    daySize, itemSize, dayGap, itemGap, blockGap,
    bodyHeight, maxTextWidth, available
  };
}

/* ------------------------------------------------------------------ *
 * Render
 * ------------------------------------------------------------------ */

function renderSvg(rows) {
  const L = buildLayout(rows);
  const parts = [];

  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${LAYOUT.width}" height="${LAYOUT.height}" viewBox="0 0 ${LAYOUT.width} ${LAYOUT.height}">`);
  parts.push('<style>');
  parts.push(fontFaceCss());
  parts.push('text { paint-order: stroke; }');
  parts.push('</style>');
  parts.push(`<rect width="${LAYOUT.width}" height="${LAYOUT.height}" fill="${COLOURS.background}"/>`);

  // Wordmark, top centre.
  parts.push(textLine('The Kirn', LAYOUT.wordSize, COLOURS.gold, LAYOUT.wordTop, 'display',
    ' dominant-baseline="hanging"'));

  // Event list, centred in the gap between the wordmark and the footer.
  let y = L.titleBottom + LAYOUT.minGap + Math.max(0, (L.available - L.bodyHeight * L.scale) / 2);

  for (const block of L.blocks) {
    for (const line of block.heading) {
      parts.push(textLine(line, L.daySize, COLOURS.cream, y, 'heading', ' dominant-baseline="hanging"'));
      y += L.daySize * L.lineFactor;
    }
    y += L.dayGap;
    for (const wrapped of block.events) {
      for (const line of wrapped) {
        parts.push(textLine(line, L.itemSize, COLOURS.cream, y, 'display', ' dominant-baseline="hanging"'));
        y += L.itemSize * L.lineFactor;
      }
      y += L.itemGap;
    }
    y += L.blockGap;
  }

  // Footer, two centred lines.
  let fy = LAYOUT.height - LAYOUT.footerBottom - L.footerHeight;
  for (const line of L.footerLines) {
    parts.push(textLine(line.text, LAYOUT.footerSize, COLOURS.cream, fy, 'display', ' dominant-baseline="hanging"'));
    fy += LAYOUT.footerSize * L.lineFactor;
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
    throw new Error(
      'No social-posts.json found.\n' +
      'Expected shape: { "posts": [ { "variant": "Weekly", "rows": [ { "day": "MONDAY - 12/10", "events": ["..."] } ] } ] }'
    );
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
    console.log('No posts to render.');
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
      console.log('CLIP  ' + filename + ' - will not fit at minimum scale. Reduce the event count.');
    } else {
      console.log('OK    ' + filename + '  scale=' + layout.scale.toFixed(2) +
        '  events=' + rows.reduce((n, r) => n + r.events.length, 0));
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