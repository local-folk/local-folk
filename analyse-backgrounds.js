#!/usr/bin/env node
/*
 * analyse-backgrounds.js
 *
 * Reports whether each background in social/backgrounds/ is readable behind the
 * post's cream text and gold wordmark.
 *
 * Readability here is contrast, and the risk is specific: the text colours are
 * fixed by the brand (cream #ffffea, gold #ffcc33), so a background that is too
 * light - or has a light patch behind the text - washes them out. A dark
 * average is not sufficient on its own, because a photograph with a bright
 * highlight in the middle is unreadable in the text area even when its mean
 * looks fine.
 *
 * So each background is measured two ways:
 *
 *   1. Mean contrast, against the average colour.
 *   2. Worst-case contrast, against the lightest 5% of pixels. This is the one
 *      that catches a bright patch behind the text.
 *
 * Ratios are WCAG contrast ratios. 4.5:1 is the usual target for body text,
 * 3:1 for large text, and both are reported against.
 *
 * Local tool - not part of the published pipeline.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const CREAM = '#ffffea';   // event text
const GOLD = '#ffcc33';   // wordmark
const BG_DIR = path.join(__dirname, 'social', 'backgrounds');

// The region the text actually occupies, as a fraction of the frame. Only this
// part of the background matters; a bright patch in a corner nobody reads is
// harmless.
const TEXT_BAND = { top: 0.10, bottom: 0.92 };

function srgbToLinear(c) {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

function luminance([r, g, b]) {
  return 0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b);
}

function hexToRgb(hex) {
  const h = hex.replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

function contrast(a, b) {
  const la = luminance(a);
  const lb = luminance(b);
  const hi = Math.max(la, lb);
  const lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
}

/* Mean and worst-case (95th percentile lightness) of the text band. */
async function measure(file) {
  const img = sharp(path.join(BG_DIR, file));
  const meta = await img.metadata();
  const height = meta.height;

  const top = Math.floor(height * TEXT_BAND.top);
  const bandHeight = Math.max(1, Math.floor(height * (TEXT_BAND.bottom - TEXT_BAND.top)));
  const extract = sharp(path.join(BG_DIR, file)).extract({
    left: 0, top, width: meta.width, height: bandHeight
  });

  const { data, info } = await extract
    .resize(64, Math.max(1, Math.round(64 * bandHeight / meta.width)), { fit: 'fill' })
    .raw()
    .toBuffer({ resolveWithObject: true });

  const rs = [], gs = [], bs = [];
  for (let i = 0; i < data.length; i += info.channels) {
    rs.push(data[i]); gs.push(data[i + 1]); bs.push(data[i + 2]);
  }

  const mean = [0, 1, 2].map((i) => {
    const arr = [rs, gs, bs][i];
    return arr.reduce((a, b) => a + b, 0) / arr.length;
  });

  // Lightest 5%: the pixels most likely to swallow cream text.
  const lum = [];
  for (let i = 0; i < rs.length; i++) lum.push(luminance([rs[i], gs[i], bs[i]]));
  const sorted = lum.slice().sort((a, b) => a - b);
  const p95 = sorted[Math.floor(sorted.length * 0.95)] || 0;
  const p05 = sorted[Math.floor(sorted.length * 0.05)] || 0;
  // Convert that luminance back to a grey of the same lightness, for the ratio.
  const lightestGrey = p95 > 0.008855 ? 255 * (Math.pow(p95, 1 / 2.4) * 1.055 - 0.055) : 255 * p95 * 12.92;

  return {
    mean,
    lightestGrey,
    spread: p95 - p05,
    meta
  };
}

function verdict(c) {
  if (c >= 7) return 'excellent';
  if (c >= 4.5) return 'good';
  if (c >= 3) return 'large text only';
  if (c >= 2) return 'marginal';
  return 'unreadable';
}

(async () => {
  if (!fs.existsSync(BG_DIR)) {
    console.log('No social/backgrounds/ folder.');
    process.exit(0);
  }

  const files = fs.readdirSync(BG_DIR)
    .filter((f) => /\.(png|jpe?g|webp)$/i.test(f))
    .sort();

  if (!files.length) {
    console.log('No images in social/backgrounds/.');
    process.exit(0);
  }

  const cream = hexToRgb(CREAM);
  const gold = hexToRgb(GOLD);

  // The solid colour in use today, as the baseline every background is judged
  // against.
  const solid = hexToRgb('#660000');
  const solidCream = contrast(cream, solid);
  const solidGold = contrast(gold, solid);
  const solidWorst = contrast(cream, [solidCream, solid, solidGold][0] && [255, 255, 255]);

  console.log('Text colours: cream ' + CREAM + ' (events), gold ' + GOLD + ' (wordmark)');
  console.log('Baseline - the solid colour in use now (#660000):');
  console.log('  cream on maroon   ' + solidCream.toFixed(2) + ':1  ' + verdict(solidCream));
  console.log('  gold  on maroon   ' + solidGold.toFixed(2) + ':1  ' + verdict(solidGold));
  console.log('');
  console.log('(' + files.length + ' backgrounds, measured across the text band only - the');
  console.log('top 10% to bottom 92% of the frame, which is where the text sits)');
  console.log('');

  const header = 'background'.padEnd(18) + 'size'.padEnd(11) + 'mean colour'.padEnd(16) +
    'cream'.padEnd(10) + 'worst'.padEnd(10) + 'gold'.padEnd(10) + 'verdict';
  console.log(header);
  console.log('-'.repeat(header.length));

  const results = [];
  for (const f of files) {
    try {
      const m = await measure(f);
      const cMean = contrast(cream, m.mean);
      const cWorst = contrast(cream, [m.lightestGrey, m.lightestGrey, m.lightestGrey]);
      const cGold = contrast(gold, m.mean);
      const v = verdict(cWorst);
      results.push({ f, cMean, cWorst, cGold, v, spread: m.spread });
      console.log(
        f.padEnd(18) +
        (m.meta.width + 'x' + m.meta.height).padEnd(11) +
        ('rgb(' + m.mean.map((v) => Math.round(v)).join(',') + ')').padEnd(16) +
        (cMean.toFixed(1) + ':1').padEnd(10) +
        (cWorst.toFixed(1) + ':1').padEnd(10) +
        (cGold.toFixed(1) + ':1').padEnd(10) +
        v
      );
    } catch (err) {
      console.log(f.padEnd(18) + 'FAILED: ' + err.message);
    }
  }

  console.log('');
  const bad = results.filter((r) => r.cWorst < 4.5);
  const marginal = results.filter((r) => r.cWorst >= 2 && r.cWorst < 4.5);
  const busy = results.filter((r) => r.spread > 0.15);

  if (bad.length) {
    console.log('Below the 4.5:1 body-text target:');
    bad.forEach((r) => console.log('  ' + r.f + '  worst ' + r.cWorst.toFixed(1) + ':1 - darken it or add a scrim'));
  }
  if (marginal.length) {
    console.log('');
    console.log('Readable, but only just (2:1 - 4.5:1). Fine for the large wordmark,');
    console.log('risky for the smaller event lines:');
    marginal.forEach((r) => console.log('  ' + r.f + '  worst ' + r.cWorst.toFixed(1) + ':1'));
  }
  if (busy.length) {
    console.log('');
    console.log('High contrast variation within the image, which reads as busy behind text:');
    busy.forEach((r) => console.log('  ' + r.f + '  spread ' + r.spread.toFixed(2)));
  }
  if (!bad.length && !busy.length) {
    console.log('All backgrounds clear the 4.5:1 target.');
  }

  await analysePreviews_(cream, gold);
})();


/* Measures the rendered previews rather than the source files, because what
 * matters is the finished image: how light the worst patch behind the text is,
 * and how much the pattern still varies at the scale of a letter.
 *
 * "busyness" is the standard deviation of pixel luminance across the text band.
 * A solid background scores 0. High contrast means the ornament is competing
 * with the letterforms - which is the complaint that contrast ratios cannot
 * express, since a busy pattern can be perfectly readable.
 */
async function analysePreviews_(cream, gold) {
  const dir = path.join(__dirname, 'social', 'background-preview');
  if (!fs.existsSync(dir)) return;

  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.png'));
  const groups = {};
  files.forEach((f) => {
    const m = /--(plain|blur|scrim|both|solid-current)-/.exec(f);
    if (!m) return;
    const slug = f.replace(/^.*?--(?:plain|blur|scrim|both|solid-current)-/, '').replace(/-\d+-/, '').replace(/\.png$/, '');
    const g = slug + '|' + m[1];
    (groups[g] = groups[g] || []).push(f);
  });

  const keys = Object.keys(groups).sort();
  if (!keys.length) return;

  console.log('');
  console.log('=== Rendered previews: contrast and busyness ===');
  console.log('busyness = luminance variation across the text band. Lower is calmer.');
  console.log('solid #660000 scores 0.00 by definition.');
  console.log('');

  const header = 'background'.padEnd(16) + 'treatment'.padEnd(9) + 'worst'.padEnd(9) +
    'detail'.padEnd(9) + 'vs plain';
  console.log(header);
  console.log('-'.repeat(header.length));

  const plainDetail = {};
  for (const k of keys) {
    const [slug, treatment] = k.split('|');
    const f = groups[k][0];
    let stats;
    try {
      stats = await measureFile_(path.join(dir, f));
    } catch (err) {
      continue;
    }
    const worst = contrast(cream, [stats.lightest, stats.lightest, stats.lightest]);
    if (treatment === 'plain') plainDetail[slug] = stats.detail;
    const base = plainDetail[slug];
    const delta = (treatment !== 'plain' && base) ?
      (((stats.detail - base) / base) * 100).toFixed(0) + '%' : '';

    console.log(
      slug.padEnd(16) + treatment.padEnd(9) +
      (worst.toFixed(1) + ':1').padEnd(9) +
      stats.detail.toFixed(4).padEnd(9) + (delta ? ' ' + delta : '')
    );
  }
}

async function measureFile_(file) {
  const meta = await sharp(file).metadata();
  const height = meta.height;
  const top = Math.floor(height * TEXT_BAND.top);
  const bandHeight = Math.max(1, Math.floor(height * (TEXT_BAND.bottom - TEXT_BAND.top)));

  const { data, info } = await sharp(file).extract({
    left: 0, top, width: meta.width, height: bandHeight
  }).resize(48, Math.max(1, Math.round(48 * bandHeight / meta.width)), { fit: 'fill' })
    .raw().toBuffer({ resolveWithObject: true });

  const lum = [];
  for (let i = 0; i < data.length; i += info.channels) {
    lum.push(luminance([data[i], data[i + 1], data[i + 2]]));
  }

  const mean = lum.reduce((a, b) => a + b, 0) / lum.length;
  const variance = lum.reduce((a, b) => a + (b - mean) * (b - mean), 0) / lum.length;
  const sorted = lum.slice().sort((a, b) => a - b);
  const p95 = sorted[Math.floor(sorted.length * 0.95)] || 0;

  // Detail: mean absolute luminance difference between neighbouring pixels.
  //
  // This is the metric that actually tracks "does the pattern compete with the
  // letters". Overall variance does not - blurring a damask leaves its light
  // and dark areas in the same places, so variance barely moves, even though
  // the image becomes obviously calmer. Edge density is what the eye reads as
  // detail competing with type, and blur crushes it.
  const w = info.width, h = info.height;
  let grad = 0, count = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w - 1; x++) {
      grad += Math.abs(lum[y * w + x + 1] - lum[y * w + x]);
      count++;
    }
  }

  return {
    mean: [mean, mean, mean],
    lightest: p95 > 0.008855 ? 255 * (Math.pow(p95, 1 / 2.4) * 1.055 - 0.055) : 255 * p95 * 12.92,
    busyness: Math.sqrt(variance),
    detail: count ? grad / count : 0
  };
}