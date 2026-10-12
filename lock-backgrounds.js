/*
 * lock-backgrounds.js  (one-off, planning phase)
 *
 * Bakes the approved treatment (scrim + blur) into the background files
 * themselves, so the live renderer can just composite text onto them without
 * re-applying anything.
 *
 * It also renames them into a rotation order chosen to maximise colour
 * variation between neighbours, because two similar backgrounds in a row is the
 * thing that makes a rotation look like an accident.
 *
 * The originals are moved to social/backgrounds-originals/ rather than deleted,
 * so the treatment can be re-tuned later without going back to source images.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const W = 1080, H = 1350;
const SCRIM = 0.62;
const BLUR = 4;

const BG_DIR = path.join(__dirname, 'social', 'backgrounds');
const ORIG_DIR = path.join(__dirname, 'social', 'backgrounds-originals');
const TMP = path.join(__dirname, 'social', '.bg-lock-tmp');

// The design already in use. Kept in the rotation as a full member rather than
// a special case, so there is one code path and the brand colour still appears.
const SOLID = { name: 'Solid Maroon', colour: '#660000' };

/* --- colour maths, enough to rank backgrounds sensibly --- */

function srgbToLinear(c) {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

function rgbToLab([r, g, b]) {
  const R = srgbToLinear(r), G = srgbToLinear(g), B = srgbToLinear(b);
  // D65
  let x = (R * 0.4124 + G * 0.3576 + B * 0.1805) / 0.95047;
  let y = (R * 0.2126 + G * 0.7152 + B * 0.0722);
  let z = (R * 0.0193 + G * 0.1192 + B * 0.9505) / 1.08883;
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : (7.787 * t) + (16 / 116));
  x = f(x); y = f(y); z = f(z);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}

/* Distance tuned for the stated goal: variation in COLOUR between neighbours.
 *
 * Chroma (the a/b axes) is weighted well above lightness. Weighting them evenly
 * made the search prefer big light/dark jumps, which produced two near-identical
 * dark reds sitting next to each other - the total looked fine because the
 * other ten pairs were huge, but the one bad pair is exactly what makes a
 * rotation look like an accident.
 */
function dist(a, b) {
  const dl = a[0] - b[0];
  const dchroma = Math.hypot(a[1] - b[1], a[2] - b[2]);
  return Math.sqrt((dl * dl) * 0.55 + (dchroma * dchroma) * 2.4);
}

(async () => {
  if (!fs.existsSync(BG_DIR)) { console.log('No backgrounds folder.'); return; }

  /* Idempotence, because the obvious way to break this is to run it twice.
   *
   * The treatment is baked into the output files, so reading the output as
   * input would apply the scrim and blur a second time - quietly darkening
   * every background on each run. The untouched originals are therefore the
   * source of truth once they exist, and are captured on the first run.
   *
   * social/backgrounds/ is always treated as pure output and cleared before it
   * is rewritten.
   */
  fs.mkdirSync(ORIG_DIR, { recursive: true });
  let originals = fs.readdirSync(ORIG_DIR).filter((f) => /\.(png|jpe?g)$/i.test(f));

  if (!originals.length) {
    const current = fs.readdirSync(BG_DIR).filter((f) => /\.(png|jpe?g)$/i.test(f));
    if (!current.length) { console.log('No background images found.'); return; }
    current.forEach((f) => fs.copyFileSync(path.join(BG_DIR, f), path.join(ORIG_DIR, f)));
    originals = current;
    console.log('Captured ' + originals.length + ' original(s) in social/backgrounds-originals/');
    console.log('');
  } else {
    console.log('Reading ' + originals.length + ' original(s) - output from any previous run is ignored.');
    console.log('');
  }

  const sources = originals.slice().sort();

  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });

  // 1. Bake the treatment into each background, text-free.
  const items = [];

  for (const f of sources) {
    const out = path.join(TMP, f.replace(/\.[^.]+$/, '.png'));
    await sharp(path.join(ORIG_DIR, f))
      .resize(W, H, { fit: 'cover', position: 'centre' })
      .blur(BLUR)
      .modulate({ brightness: SCRIM })
      .png({ compressionLevel: 9 })
      .toFile(out);

    // Step by the real channel count. Some of these PNGs carry an alpha
    // channel, and assuming 3 would read the alpha byte as a colour channel -
    // producing a mean full of nonsense, and NaN distances that silently
    // collapse the ordering search.
    const { data, info } = await sharp(out).resize(32, 40, { fit: 'fill' })
      .raw().toBuffer({ resolveWithObject: true });
    const ch = info.channels;
    let r = 0, g = 0, b = 0, n = 0;
    for (let i = 0; i + 2 < data.length; i += ch) { r += data[i]; g += data[i + 1]; b += data[i + 2]; n++; }
    const mean = [r / n, g / n, b / n];
    items.push({ label: f.replace(/\.[^.]+$/, ''), file: out, lab: rgbToLab(mean), mean });
  }

  const solidOut = path.join(TMP, 'solid-maroon.png');
  await sharp({ create: { width: W, height: H, channels: 3, background: SOLID.colour } })
    .png().toFile(solidOut);
  items.push({
    label: SOLID.name, file: solidOut,
    lab: rgbToLab([102, 0, 0]), mean: [102, 0, 0]
  });

  // 2. Order for maximum neighbour difference, as a closed cycle.
  //
  // The objective is to MAXIMISE THE SMALLEST neighbour gap, not to minimise the
  // total and not to minimise the largest one.
  //
  // Summing rewards a cycle with ten spectacular jumps and one dud - and the
  // dud is exactly what you notice when the posts come out, because two similar
  // backgrounds a fortnight apart looks like a mistake. Minimising the largest
  // gap is just as wrong: that evens the gaps out instead of making them all
  // large.
  //
  // So this is a maximin (bottleneck) problem: raise the floor on the weakest
  // link, then use the total only to break ties. Greedy nearest-neighbour from
  // every start gives a floor to work from, then 2-opt keeps reversing
  // segments while that improves it. Eleven items, so it is cheap.
  const edge = (i, j) => dist(items[i].lab, items[j].lab);

  function score(tour) {
    let min = Infinity, sum = 0;
    for (let i = 0; i < tour.length; i++) {
      const d = edge(tour[i], tour[(i + 1) % tour.length]);
      if (!Number.isFinite(d)) return { min: -Infinity, sum: Infinity };
      if (d < min) min = d;
      sum += d;
    }
    return { min, sum };
  }

  const better = (a, b) =>
    a.min > b.min + 0.01 ||
    (Math.abs(a.min - b.min) < 0.01 && a.sum > b.sum + 0.01);

  let best = null;
  for (let start = 0; start < items.length; start++) {
    const seen = new Set([start]);
    const tour = [start];
    while (tour.length < items.length) {
      const cur = tour[tour.length - 1];
      let nearest = -1, bestD = Infinity;
      for (let i = 0; i < items.length; i++) {
        if (seen.has(i)) continue;
        const d = edge(cur, i);
        if (Number.isFinite(d) && d < bestD) { bestD = d; nearest = i; }
      }
      if (nearest === -1) {
        throw new Error('Could not order the backgrounds: a colour reading came out ' +
          'as NaN for "' + items[cur].label + '". Check every background is a real image.');
      }
      tour.push(nearest);
      seen.add(nearest);
    }

    // 2-opt. Reversing a segment changes only the two edges at its ends.
    let improved = true, guard = 0;
    while (improved && guard++ < 200) {
      improved = false;
      for (let a = 0; a < tour.length - 1; a++) {
        for (let b = a + 1; b < tour.length; b++) {
          const cand = tour.slice(0, a)
            .concat(tour.slice(a, b + 1).reverse(), tour.slice(b + 1));
          if (better(score(cand), score(tour))) {
            tour.length = 0;
            tour.push.apply(tour, cand);
            improved = true;
          }
        }
      }
    }

    const s = score(tour);
    if (!best || better(s, best.score)) best = { tour: tour.slice(), score: s };
  }

  const ordered = best.tour.map((i) => items[i]);

  console.log('Rotation order (neighbours are the most different pairs):');
  console.log('');
  ordered.forEach((it, i) => {
    const n = String(i + 1).padStart(2, '0');
    const next = ordered[(i + 1) % ordered.length];
    const d = dist(it.lab, next.lab);
    console.log('  ' + n + '  ' + it.label.padEnd(16) +
      'rgb(' + it.mean.map((v) => Math.round(v)).join(',') + ')'.padEnd(20) +
      '-> ' + String(i + 1 === ordered.length ? 1 : i + 2).padStart(2, '0') +
      ' ' + next.label.padEnd(16) + 'distance ' + d.toFixed(1));
  });

  // Report the tightest pair, so a weak pairing is visible rather than assumed.
  let worst = Infinity, worstPair = '';
  ordered.forEach((it, i) => {
    const next = ordered[(i + 1) % ordered.length];
    const d = dist(it.lab, next.lab);
    if (d < worst) { worst = d; worstPair = it.label + ' / ' + next.label; }
  });
  console.log('');
  console.log('Closest pair in the cycle: ' + worstPair + '  (distance ' + worst.toFixed(1) + ')');
  console.log('Mean neighbour distance:   ' +
    (ordered.reduce((a, it, i) => a + dist(it.lab, ordered[(i + 1) % ordered.length].lab), 0) /
      ordered.length).toFixed(1));

  // 3. Write the locked set. The originals already live in ORIG_DIR by this point.
  for (const f of fs.readdirSync(BG_DIR)) fs.rmSync(path.join(BG_DIR, f), { force: true });

  ordered.forEach((it, i) => {
    const n = String(i + 1).padStart(2, '0');
    const dest = path.join(BG_DIR, n + '-' + it.label.replace(/[^A-Za-z0-9]+/g, '-') + '.png');
    fs.copyFileSync(it.file, dest);
    console.log('wrote social/backgrounds/' + path.basename(dest));
  });

  fs.rmSync(TMP, { recursive: true, force: true });
  console.log('');
  console.log('Originals preserved in social/backgrounds-originals/');
})();