/**
 * Checks that matter before you waste a sheet of vinyl.
 *
 * The one that counts is minimum feature width. Nothing upstream stops the knight's muzzle
 * notch or the king's cross coming out at a third of a millimeter, and material that narrow
 * tears while it is being weeded rather than failing loudly at cut time.
 *
 * Connectivity is judged on the EROSION alone, never on the opening. Eroding by half the
 * minimum width pinches through anything narrower and splits the component, which is exactly
 * the question being asked. Dilating back would undo that: for a rectilinear shape a miterd
 * round trip is exactly invertible, and even with round joins two pieces that were eroded
 * apart are dilated back until they touch again and merge. The opening is used only to
 * decide which material to highlight, not to decide whether anything is broken.
 *
 * But thin material is not automatically a problem, and this is the distinction the report
 * turns on. A corner bridge pokes two small tips into the neighboring squares; those tips
 * are thin, yet they are attached to the bulk and will never tear. What actually ruins a cut
 * is a thin NECK -- material whose failure splits one decal into two -- or a whole decal
 * thinner than the threshold, which lifts with the waste. So the opening is compared
 * component by component: a component that survives as two has a neck, one that survives as
 * none falls off. Thin material that neither splits nor vanishes is reported as delicate and
 * highlighted, but it is not an error.
 */
import type { Poly, Region } from './types.js';
import { difference, intersect, offset, open } from './clip.js';
import { cutLength, regionArea, signedArea } from './geom.js';
import type { Composition, LayerId } from './compose.js';

/** One sheet of vinyl, checked on its own. Every sheet is cut and weeded separately. */
export type LayerReport = {
  id: LayerId;
  name: string;
  /** Separate pieces the carrier sheet has to hold in register on this sheet. */
  decals: number;
  holes: number;
  cutLengthMm: number;
  areaMm2: number;
  /** Material narrower than `minFeature`, for the preview to highlight. */
  thin: Region;
  /** Decals that a thin neck would split in two. */
  necks: number;
  /** Decals thinner than `minFeature` throughout, which will lift with the waste. */
  vanishing: number;
};

export type Report = {
  layers: LayerReport[];
  /** Across all four sheets. */
  totalDecals: number;
  totalHoles: number;
  totalCutMm: number;
  widthMm: number;
  heightMm: number;
  /** Union of every sheet's thin material, for a single preview overlay. */
  thin: Region;
  necks: number;
  vanishing: number;
  fitsMat: boolean;
  warnings: string[];
  notes: string[];
};

const areaOf = (p: Poly): number =>
  Math.abs(signedArea(p.outer)) - p.holes.reduce((a, h) => a + Math.abs(signedArea(h)), 0);

export type ThinAnalysis = { thin: Region; necks: number; vanishing: number };

export function analyzeThin(region: Region, minFeature: number): ThinAnalysis {
  if (minFeature <= 0 || !region.length) return { thin: [], necks: 0, vanishing: 0 };

  // Slivers below a quarter of a minimum-width square are offsetting noise -- chiefly the
  // bite a round join takes out of every convex corner -- rather than real features.
  const floor = 0.25 * minFeature * minFeature;

  const eroded = offset(region, -minFeature / 2);
  const thin = difference(region, open(region, minFeature / 2)).filter((p) => areaOf(p) >= floor);

  let necks = 0;
  let vanishing = 0;
  for (const comp of region) {
    // How many pieces is this decal left in once everything too thin is pinched through?
    const parts = intersect([comp], eroded).filter((p) => areaOf(p) >= floor);
    if (parts.length === 0) vanishing++;
    else if (parts.length > 1) necks += parts.length - 1;
  }
  return { thin, necks, vanishing };
}

export function validate(c: Composition, minFeature: number, matMm: number): Report {
  const widthMm = c.box.x1 - c.box.x0;
  const heightMm = c.box.y1 - c.box.y0;

  const layers: LayerReport[] = c.layers.map((l) => {
    const { thin, necks, vanishing } = analyzeThin(l.region, minFeature);
    return {
      id: l.id,
      name: l.name,
      decals: l.region.length,
      holes: l.region.reduce((a, p) => a + p.holes.length, 0),
      cutLengthMm: cutLength(l.region),
      areaMm2: regionArea(l.region),
      thin,
      necks,
      vanishing,
    };
  });

  const sum = (f: (l: LayerReport) => number): number => layers.reduce((a, l) => a + f(l), 0);
  const necks = sum((l) => l.necks);
  const vanishing = sum((l) => l.vanishing);
  const thin = layers.flatMap((l) => l.thin);

  const warnings: string[] = [];
  const notes: string[] = [];

  const fitsMat = widthMm <= matMm + 1e-6 && heightMm <= matMm + 1e-6;
  if (!fitsMat) {
    warnings.push(
      `Each sheet is ${widthMm.toFixed(1)} x ${heightMm.toFixed(1)} mm and does not fit the ${matMm.toFixed(0)} mm cutting area. Reduce the square size.`,
    );
  }
  for (const l of layers) {
    if (l.necks) {
      warnings.push(
        `${l.name}: ${l.necks} thin neck${l.necks === 1 ? '' : 's'} narrower than ${minFeature} mm. The vinyl will tear there while you weed it.`,
      );
    }
    if (l.vanishing) {
      warnings.push(
        `${l.name}: ${l.vanishing} piece${l.vanishing === 1 ? ' is' : 's are'} thinner than ${minFeature} mm throughout and will lift with the waste.`,
      );
    }
  }
  if (thin.length && !necks && !vanishing) {
    notes.push(
      `${thin.length} delicate spot${thin.length === 1 ? '' : 's'} under ${minFeature} mm, highlighted in the preview. They are attached to solid material, so they should survive weeding.`,
    );
  }

  const worst = layers.reduce((a, l) => (l.decals > a.decals ? l : a), layers[0]!);
  if (worst.decals > 20) {
    notes.push(`${worst.name} is ${worst.decals} separate pieces. The carrier sheet holds them in register, so this costs weeding attention rather than accuracy.`);
  }
  if (c.weedRing) {
    notes.push('All four sheets carry the same weeding box. Line those rectangles up and everything inside them lines up too.');
  }

  return {
    layers,
    totalDecals: sum((l) => l.decals),
    totalHoles: sum((l) => l.holes),
    totalCutMm: sum((l) => l.cutLengthMm) + (c.weedRing ? 4 * c.layers.length * widthMm : 0),
    widthMm,
    heightMm,
    thin,
    necks,
    vanishing,
    fitsMat,
    warnings,
    notes,
  };
}
