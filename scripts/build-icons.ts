/**
 * App icons, drawn from the same glyph geometry the cutter uses.
 * Run: npx tsx scripts/build-icons.ts   (then convert to PNG, see package.json)
 */
import { writeFileSync } from 'node:fs';
import { SILHOUETTES, GLYPH_BOX } from '../src/core/glyphs.gen.js';
import { regionPathData } from '../src/core/svg.js';

const B = GLYPH_BOX;
const pad = B * 0.07;      // the glyph fills its box, so inset it to leave the board visible
const inner = B - 2 * pad;
const d = regionPathData(SILHOUETTES.n, B); // y-flip back to SVG's y-down
const svg =
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${B} ${B}" width="512" height="512">` +
  `<rect width="${B}" height="${B}" rx="${B * 0.16}" fill="#16181d"/>` +
  `<rect x="0" y="0" width="${B / 2}" height="${B / 2}" fill="#2a2f3a"/>` +
  `<rect x="${B / 2}" y="${B / 2}" width="${B / 2}" height="${B / 2}" fill="#2a2f3a"/>` +
  `<g transform="translate(${pad} ${pad}) scale(${inner / B})">` +
  `<path d="${d}" fill="#f4f5f8" fill-rule="evenodd"/></g>` +
  `</svg>`;
writeFileSync(new URL('../public/favicon.svg', import.meta.url), svg);
console.log('wrote public/favicon.svg');
