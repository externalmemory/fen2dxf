/**
 * Derive solid cut silhouettes from the Chess font by James Kilfiger.
 *
 * Build-time only -- the app ships `src/core/glyphs.gen.ts` and never touches the font at
 * runtime. Run with `npm run glyphs`.
 *
 * The font draws each piece twice: uppercase P N B R Q K are the *outline* forms used for
 * white on a printed diagram, and lowercase p n b r q k are the *solid* forms used for
 * black. Only the solid forms are useful here. A vinyl cutter has no notion of fill, so an
 * outline form would come out as two hairline contours a fifth of a millimeter apart --
 * unweedable. Both piece colors are therefore cut from the same solid silhouette and told
 * apart by the color of the sheet they are cut from, which is the entire point of a
 * four-layer build.
 *
 * The one repair
 * --------------
 * In the solid queen the four crown balls are drawn as free-standing circles that clear the
 * spike tips by about 27 units, roughly a millimeter once a square is 33 mm. On a printed
 * diagram the outline stroke bridges that gap; in a filled silhouette nothing does, so the
 * balls come out as four loose discs to be tweezered into place. `bridgeBalls` widens each
 * spike into a tapered stem that meets its ball, which is both what the drawing means and
 * what makes the crown one weedable decal.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import opentype, { type Font } from 'opentype.js';
import type { Pt, Ring, Region } from '../src/core/types.js';
import { clean, difference, fromRings, intersect, offset, open, union } from '../src/core/clip.js';
import { bbox, rect, regionArea, signedArea, transformRegion } from '../src/core/geom.js';
import { analyzeThin } from '../src/core/validate.js';

/** The design box the app scales into a square. Glyphs are normalized to fill it exactly. */
const BOX = 1000;
/** Chord tolerance for flattening the CFF curves, in font units (1000/em). */
const FLATTEN_TOL = 0.25;

/** Minimum width of a welded queen stem, in font units. */
const STEM_WIDTH = 50;

/**
 * Radius applied to every sharp outside corner, in font units -- 0.34 mm at a 33 mm square.
 *
 * The base crescent of every piece, and the pawn's mound and the rook's band, end in cusps
 * that come to a literal point. Two things are wrong with a point. It is the thinnest feature
 * a shape can have, so on HTV the last fraction of a millimeter has almost no area to bond
 * with and can lift; and a drag knife cannot cut one anyway, because the blade trails the
 * pivot and swivels through the reversal, rounding the corner by roughly the blade offset.
 * Designing the radius means the file says what the machine was going to do regardless.
 *
 * The value is deliberately small. Rounding a cusp necessarily shortens it -- a fillet of
 * radius r at a wedge cuts back r/tan(half-angle), which is a long way when the wedge is
 * shallow -- so the crescents lose about 1 mm of length end to end at this setting and keep
 * their shape. Past about 22 units the pawn's mound stops being a crescent and becomes a
 * lozenge.
 */
const TIP_RADIUS = 12;

const FONT = new URL('../assets/font/chess.otf', import.meta.url);
const OUT = new URL('../src/core/glyphs.gen.ts', import.meta.url);

const TYPES = ['p', 'n', 'b', 'r', 'q', 'k'] as const;
type PieceType = (typeof TYPES)[number];

// --- font -> rings ----------------------------------------------------------

/** One glyph's contours, flattened, in font units with y UP. */
function contoursOf(font: Font, ch: string): Ring[] {
  // getPath(x, y, size) with size == unitsPerEm and y == 0 gives font units mirrored about
  // the baseline, because SVG y runs down. Undo that mirror on the way out.
  const path = font.charToGlyph(ch).getPath(0, 0, font.unitsPerEm);
  const out: Ring[] = [];
  let cur: Pt[] = [];
  let x = 0, y = 0;

  const flush = (): void => {
    if (cur.length >= 3) out.push(cur);
    cur = [];
  };

  const cubic = (p0: Pt, p1: Pt, p2: Pt, p3: Pt, depth: number): void => {
    const dx = p3[0] - p0[0], dy = p3[1] - p0[1];
    const d1 = Math.abs((p1[0] - p3[0]) * dy - (p1[1] - p3[1]) * dx);
    const d2 = Math.abs((p2[0] - p3[0]) * dy - (p2[1] - p3[1]) * dx);
    if (depth > 18 || (d1 + d2) ** 2 <= FLATTEN_TOL * (dx * dx + dy * dy)) {
      cur.push(p3);
      return;
    }
    const mid = (a: Pt, b: Pt): Pt => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    const p01 = mid(p0, p1), p12 = mid(p1, p2), p23 = mid(p2, p3);
    const p012 = mid(p01, p12), p123 = mid(p12, p23);
    const m = mid(p012, p123);
    cubic(p0, p01, p012, m, depth + 1);
    cubic(m, p123, p23, p3, depth + 1);
  };

  for (const c of path.commands) {
    switch (c.type) {
      case 'M':
        flush();
        cur = [[c.x, c.y]];
        x = c.x; y = c.y;
        break;
      case 'L':
        cur.push([c.x, c.y]);
        x = c.x; y = c.y;
        break;
      case 'C':
        cubic([x, y], [c.x1, c.y1], [c.x2, c.y2], [c.x, c.y], 0);
        x = c.x; y = c.y;
        break;
      case 'Q': {
        const c1: Pt = [x + (2 / 3) * (c.x1 - x), y + (2 / 3) * (c.y1 - y)];
        const c2: Pt = [c.x + (2 / 3) * (c.x1 - c.x), c.y + (2 / 3) * (c.y1 - c.y)];
        cubic([x, y], c1, c2, [c.x, c.y], 0);
        x = c.x; y = c.y;
        break;
      }
      case 'Z':
        flush();
        break;
    }
  }
  flush();
  // Mirror back to y-up. Winding flips too, which `union` fixes.
  return out.map((r) => r.map(([px, py]) => [px, -py] as Pt));
}

// --- the queen repair -------------------------------------------------------

type Blob = { cx: number; cy: number; rx: number; ry: number };

/**
 * Is this contour a free-standing ellipse? The crown balls are 112 x 120 units, so a strict
 * circle test misses all four; what actually identifies them is that the contour fills
 * pi/4 of its own bounding box.
 */
function asBlob(ring: Ring): Blob | null {
  const b = bbox([{ outer: ring, holes: [] }]);
  const w = b.x1 - b.x0, h = b.y1 - b.y0;
  if (w <= 0 || h <= 0 || w / h > 1.25 || h / w > 1.25) return null;
  const a = Math.abs(signedArea(ring));
  if (Math.abs(a - (Math.PI / 4) * w * h) > 0.03 * a) return null;
  return { cx: (b.x0 + b.x1) / 2, cy: (b.y0 + b.y1) / 2, rx: w / 2, ry: h / 2 };
}

/** Nearest point to `p` anywhere on `ring`, sampled along its segments. */
function nearestOnRing(ring: Ring, p: Pt): { pt: Pt; d2: number } {
  let best: Pt = ring[0]!;
  let bestD2 = Infinity;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]!, b = ring[(i + 1) % ring.length]!;
    const vx = b[0] - a[0], vy = b[1] - a[1];
    const len2 = vx * vx + vy * vy;
    const t = len2 > 0 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * vx + (p[1] - a[1]) * vy) / len2)) : 0;
    const q: Pt = [a[0] + t * vx, a[1] + t * vy];
    const d2 = (q[0] - p[0]) ** 2 + (q[1] - p[1]) ** 2;
    if (d2 < bestD2) { bestD2 = d2; best = q; }
  }
  return { pt: best, d2: bestD2 };
}

/**
 * Weld every free-standing disc onto the nearest large component with a tapered stem.
 *
 * The far end of the stem is anchored in the target's EROSION, not on its outline, and that
 * is the whole trick. Two earlier shapes both failed, for the same underlying reason:
 *
 *   - the convex hull of the disc and the nearest outline point tapers to nothing exactly
 *     where it meets a needle-sharp spike, so the join is pinched to zero width;
 *   - a trapezoid pushed a fixed distance past that point is wide enough in itself, but the
 *     queen's spikes stay under a millimeter for another 150 units below the tip, so the
 *     weld simply moves the tear a little further down the spike.
 *
 * Eroding the target by half the stem width answers the question directly: what is left is
 * exactly the material already at least that wide. Running the stem to the nearest point of
 * *that* guarantees there is no cross-section anywhere between the ball and the solid body
 * of the crown narrower than the stem itself -- which is what widening a spike means.
 */
function bridgeBalls(comps: Region, minWidth: number): { region: Region; welded: number } {
  const areas = comps.map((p) => Math.abs(signedArea(p.outer)));
  const big = Math.max(...areas);
  const half = minWidth / 2;
  // A little wider than the nominal minimum, so the check that follows has something to
  // find rather than landing exactly on the threshold.
  const tipHalf = half * 1.15;
  const stems: Region = [];
  let welded = 0;

  for (let i = 0; i < comps.length; i++) {
    if (areas[i]! > 0.25 * big) continue;
    const ball = asBlob(comps[i]!.outer);
    if (!ball) continue;

    // Nearest *large* component -- balls must not weld to each other.
    let target: { pt: Pt; d2: number } | null = null;
    for (let j = 0; j < comps.length; j++) {
      if (j === i || areas[j]! <= 0.25 * big) continue;
      for (const core of offset([comps[j]!], -tipHalf)) {
        const hit = nearestOnRing(core.outer, [ball.cx, ball.cy]);
        if (!target || hit.d2 < target.d2) target = hit;
      }
    }
    if (!target) continue;

    const ux = target.pt[0] - ball.cx, uy = target.pt[1] - ball.cy;
    const len = Math.hypot(ux, uy) || 1;
    const [dx, dy] = [ux / len, uy / len];
    const [nx, ny] = [-dy, dx]; // unit normal
    // Bury the end half a width deep, so the stem never merely kisses the core.
    const far: Pt = [ball.cx + dx * (len + half), ball.cy + dy * (len + half)];
    // Springing from the ball at most of its radius keeps the join looking grown rather
    // than glued, and it is the wide end of the taper, so it never sets the minimum.
    const ballHalf = Math.max(tipHalf, 0.72 * Math.min(ball.rx, ball.ry));
    stems.push({
      outer: [
        [ball.cx + nx * ballHalf, ball.cy + ny * ballHalf],
        [far[0] + nx * tipHalf, far[1] + ny * tipHalf],
        [far[0] - nx * tipHalf, far[1] - ny * tipHalf],
        [ball.cx - nx * ballHalf, ball.cy - ny * ballHalf],
      ],
      holes: [],
    });
    welded++;
  }
  return { region: union(comps, stems), welded };
}

/**
 * Put a cross on the king instead of the ball the font draws.
 *
 * The author left the orb plain deliberately -- the set is described as having no Christian
 * iconography -- which is a fine default and not what most people picture when they picture a
 * king. Swapping it is a request, not a correction.
 *
 * The ball is located rather than hard-coded. It hangs off a stem far narrower than itself,
 * so an erosion deep enough to pinch the stem through leaves the ball as a free-standing
 * fragment, and it is the topmost one. Everything else -- where to cut, how far down to bury
 * the new stem -- is measured off that fragment, so nothing here breaks if the glyph moves.
 *
 * The cross is built at the full `bar` width, including the arms. They could be drawn at the
 * stem's original 30 units, which is nearer to how a chess king is normally drawn and would
 * survive the cut -- an arm is a protrusion, attached along its whole root, not a neck. But
 * mixing a 1.1 mm arm with a 1.8 mm stem looks like a mistake rather than a choice, so the
 * whole cross is one weight.
 *
 * It also sits `bar/2` higher than the ball did. Left at the ball's height the arms pass the
 * crown's shoulders with about 1.3 mm of clearance measured perpendicular, which is a cramped
 * look and a mean sliver of waste to weed out. The lift roughly doubles it. The king ends up
 * the tallest piece in the set, which is correct, and still inside the box the six glyphs
 * share, so it does not rescale anything.
 */
function crossTheKing(comps: Region, bar: number): Region {
  const areas = comps.map((p) => Math.abs(signedArea(p.outer)));
  const crown = comps[areas.indexOf(Math.max(...areas))]!;
  const e = bar / 2;

  const frags = offset([crown], -e);
  if (frags.length < 2) return comps;
  const ball = frags.reduce((a, p) => (bbox([p]).y1 > bbox([a]).y1 ? p : a));
  const b = bbox([ball]);
  if (b.y1 < bbox([crown]).y1 - bar) return comps; // not the finial after all; leave it alone

  const top = bbox([crown]).y1 + bar / 2; // lifted clear of the crown's shoulders
  const cx = (b.x0 + b.x1) / 2;
  const bottom = b.y0 - e; // the true underside of the ball, where it swallows the stem

  // Cut the ball off. The box only has to clear the ball itself: at this height the crown's
  // two lobes are hundreds of units away on either side.
  const cut = rect(b.x0 - 1.5 * e, bottom, b.x1 + 1.5 * e, top + e);

  const armY = top - 1.6 * bar; // a Latin cross: the bar sits above center, so the foot is longest
  const cross = union(
    rect(cx - bar / 2, bottom - 2.5 * bar, cx + bar / 2, top), // buried well inside the crown
    rect(cx - 1.5 * bar, armY - bar / 2, cx + 1.5 * bar, armY + bar / 2),
  );
  return union(difference(comps, cut), cross);
}

/**
 * Material that is both too thin AND load-bearing.
 *
 * The opening residue -- what a disc of the given width cannot reach -- contains two very
 * different things. Most of it is protrusions: the sharp horns of every base crescent, which
 * are thin but hang off solid material and will never tear. The rest is necks, which hold
 * one part of a decal to another. Only necks matter, and the two are told apart by counting
 * how many pieces of the shape a residue fragment touches: a protrusion touches one, a neck
 * bridges two.
 *
 * Those pieces are the components of the OPENING, one per surviving core component, not the
 * eroded core itself. The residue abuts the opening exactly; the core is another half-width
 * further in, so probing against it finds nothing touching anything.
 */
function neckMaterial(region: Region, minWidth: number): Region {
  const half = minWidth / 2;
  const core = offset(region, -half);
  if (core.length < 2) return [];
  const parts = core.map((c) => offset([c], half));
  const residue = difference(region, union(...parts));
  const eps = minWidth / 20; // the residue meets a part along a boundary, which has no area
  return residue.filter((piece) => {
    const probe = offset([piece], eps);
    let touched = 0;
    for (const part of parts) if (intersect(probe, part).length) touched++;
    return touched >= 2;
  });
}

/**
 * Widen every neck until nothing in the glyph splits at `minWidth`.
 *
 * The king needs this the way the queen needs `bridgeBalls`, and for a related reason: the
 * ball on his cross is joined by a stem that comes out at 1.07 mm on a 33 mm square, three
 * times narrower than the worst neck in any other piece, and under a millimeter as soon as
 * the squares drop below 31 mm. It is a hairline in the drawing that a printer renders
 * happily and a blade does not.
 *
 * The dilation is bisected rather than fixed. Growing the neck material by a flat half-width
 * would clear the threshold too, but by more than necessary, and this is somebody's drawing
 * -- the right amount to change it is the least that works.
 */
function thickenNecks(region: Region, minWidth: number): { region: Region; thickened: number; grew: number } {
  const necks = neckMaterial(region, minWidth);
  if (!necks.length) return { region, thickened: 0, grew: 0 };
  const sound = (r: Region): boolean => {
    const a = analyzeThin(r, minWidth);
    return a.necks === 0 && a.vanishing === 0;
  };
  const build = (d: number): Region => union(region, offset(necks, d));
  let lo = 0, hi = minWidth / 2;
  if (!sound(build(hi))) return { region: build(hi), thickened: necks.length, grew: hi };
  for (let i = 0; i < 14; i++) {
    const mid = (lo + hi) / 2;
    if (sound(build(mid))) hi = mid; else lo = mid;
  }
  return { region: build(hi), thickened: necks.length, grew: hi };
}

// --- build ------------------------------------------------------------------

const font = opentype.parse(readFileSync(FONT).buffer as ArrayBuffer);
if (font.unitsPerEm !== 1000) throw new Error(`expected a 1000-unit em, got ${font.unitsPerEm}`);

const raw: Record<string, Region> = {};
let welds = 0;
const repairs: string[] = [];
for (const t of TYPES) {
  let region = fromRings(contoursOf(font, t));
  if (t === 'q') {
    // 50 font units is 1.8 mm through the junction at the default 33 mm square and 0.86
    // piece scale -- comfortably clear of a 1 mm minimum feature width, with room for a
    // smaller board before it becomes the thing that fails.
    const r = bridgeBalls(region, STEM_WIDTH);
    region = r.region;
    welds += r.welded;
  }
  if (t === 'k') {
    const before = region.length;
    // 1.15x, the same margin the queen's stems use: built exactly on the threshold, the
    // cross is sound but sits on the boundary of every check that looks at it.
    region = crossTheKing(region, STEM_WIDTH * 1.15);
    repairs.push(`  k: ${region.length === before ? 'crossed the finial' : 'FAILED to cross the finial'}`);
  }
  const fix = thickenNecks(region, STEM_WIDTH);
  if (fix.thickened && fix.grew > 0.01) repairs.push(`  ${t}: widened ${fix.thickened} neck(s) by ${fix.grew.toFixed(1)} units`);
  // Last, so it also takes the corners off the cross and off anything the repairs added.
  // Opening is the whole operation: it is the union of every disc of this radius that fits
  // inside the glyph, which rounds outside corners by exactly the radius and leaves inside
  // ones alone. A fillet at a convex corner is the same circle.
  raw[t] = TIP_RADIUS > 0 ? open(fix.region, TIP_RADIUS) : fix.region;
}

/**
 * One transform for all six glyphs, from the box that encloses every piece. Normalizing
 * each glyph on its own would make the pawn as tall as the king; a shared box preserves
 * the relative sizes the font was drawn with. The taller of the two dimensions decides the
 * scale, so `pieceScale = 1` means "exactly as wide (or tall) as the square".
 */
let common = bbox(Object.values(raw)[0]!);
for (const r of Object.values(raw)) {
  const b = bbox(r);
  common = { x0: Math.min(common.x0, b.x0), y0: Math.min(common.y0, b.y0), x1: Math.max(common.x1, b.x1), y1: Math.max(common.y1, b.y1) };
}
const k = BOX / Math.max(common.x1 - common.x0, common.y1 - common.y0);
const tx = -common.x0 * k + (BOX - (common.x1 - common.x0) * k) / 2;
const ty = -common.y0 * k + (BOX - (common.y1 - common.y0) * k) / 2;

const silhouettes: Record<string, Region> = {};
const stats: string[] = [];
for (const t of TYPES) {
  // `clip.ts` rounds arcs to 0.02 of whatever unit it is handed, which it documents as
  // millimeters -- but this script works in font units, where 0.02 is about 0.0007 mm and
  // generates a vertex every fraction of a degree. Simplify back to the chord error the rest
  // of the app actually uses: 0.5 of a design unit is 0.014 mm at a 33 mm square, still an
  // order of magnitude finer than the machine resolves.
  const region = clean(transformRegion(raw[t]!, k, k, tx, ty), 0.5);
  silhouettes[t] = region;
  const b = bbox(region);
  const verts = region.reduce((a, p) => a + p.outer.length + p.holes.reduce((c, h) => c + h.length, 0), 0);
  stats.push(
    `  ${t}: ${region.length} decal(s), ${region.reduce((a, p) => a + p.holes.length, 0)} hole(s), ` +
      `${verts} vertices, ${(b.x1 - b.x0).toFixed(0)}x${(b.y1 - b.y0).toFixed(0)} of ${BOX}, ` +
      `${((100 * regionArea(region)) / (BOX * BOX)).toFixed(1)}% ink`,
  );
}

const fmt = (r: Ring): string => '[' + r.map(([x, y]) => `[${+x.toFixed(2)},${+y.toFixed(2)}]`).join(',') + ']';
const fmtRegion = (reg: Region): string =>
  '[' + reg.map((p) => `{outer:${fmt(p.outer)},holes:[${p.holes.map(fmt).join(',')}]}`).join(',\n  ') + ']';

const header = `/* eslint-disable */
// GENERATED by scripts/build-glyphs.ts -- do not edit by hand. Run: npm run glyphs
//
// Solid cut silhouettes taken from the solid (lowercase) glyphs of the Chess font by
// James Kilfiger, which its own copyright string dedicates to the public domain. The four
// free-standing balls on the queen's crown are welded to their spikes; see the build script.
//
// Coordinates are font units scaled into a ${BOX}x${BOX} design box with y pointing UP. All six
// share one transform, so their relative sizes are the ones the font was drawn with.
import type { Region } from './types.js';
import type { PieceType } from './fen.js';

export const GLYPH_BOX = ${BOX};

export const SILHOUETTES: Record<PieceType, Region> = {
${TYPES.map((t) => `  ${t}: ${fmtRegion(silhouettes[t]!)},`).join('\n')}
};
`;

writeFileSync(OUT, header);
console.log('wrote', OUT.pathname);
console.log(`  common box ${common.x0.toFixed(0)},${common.y0.toFixed(0)} .. ${common.x1.toFixed(0)},${common.y1.toFixed(0)}  scale ${k.toFixed(4)}  ${welds} ball(s) welded`);
if (repairs.length) console.log(repairs.join('\n'));
console.log(stats.join('\n'));
