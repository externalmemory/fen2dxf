/**
 * SVG renderer.
 *
 * This draws the exact same `Region` values the DXF writer consumes, so the on-screen
 * preview is the cut file rather than a second drawing of it. SVG's y axis points down, so
 * every coordinate is mirrored on the way out; nothing else differs.
 *
 * Layers are painted in the order given, bottom first, which is also the order the sheets
 * are applied to the surface. That makes the preview a genuine prediction of the finished
 * job, including the one thing worth predicting before buying vinyl: whether the four colors
 * actually tell each other apart.
 */
import type { Ring, Region } from './types.js';

export type SvgLayer = { region: Region; fill: string; opacity?: number };

export type SvgOptions = {
  /** Design box in millimetres. */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** Painted behind everything: the surface the vinyl goes onto. */
  background: string;
  /** Bottom first. */
  layers: SvgLayer[];
  /** Standalone contours drawn as hairlines only, never filled -- the weeding box. */
  outlineRings?: Ring[];
  outlineColor?: string;
  /** Render contours as hairlines instead of fills: what the blade actually traces. */
  cutLines?: boolean;
  /** Extra margin around the design box, in mm. */
  pad?: number;
};

function ringPath(ring: Ring, yFlip: number): string {
  if (ring.length < 2) return '';
  let d = `M${ring[0]![0].toFixed(3)} ${(yFlip - ring[0]![1]).toFixed(3)}`;
  for (let i = 1; i < ring.length; i++) d += `L${ring[i]![0].toFixed(3)} ${(yFlip - ring[i]![1]).toFixed(3)}`;
  return d + 'Z';
}

/** One `d` attribute covering the whole region. Holes rely on fill-rule="evenodd". */
export function regionPathData(region: Region, yFlip: number): string {
  const parts: string[] = [];
  for (const poly of region) {
    parts.push(ringPath(poly.outer, yFlip));
    for (const h of poly.holes) parts.push(ringPath(h, yFlip));
  }
  return parts.join('');
}

export function toSvg(o: SvgOptions): string {
  const pad = o.pad ?? 0;
  const x0 = o.x0 - pad, y0 = o.y0 - pad, x1 = o.x1 + pad, y1 = o.y1 + pad;
  const w = x1 - x0, h = y1 - y0;
  const yFlip = y0 + y1; // mirror about the box, so the result sits at x0..x1 / y0..y1 again

  const hair = Math.max(w, h) / 900;
  const body: string[] = [`<rect x="${x0}" y="${y0}" width="${w}" height="${h}" fill="${o.background}"/>`];

  for (const layer of o.layers) {
    const d = regionPathData(layer.region, yFlip);
    if (!d) continue;
    const op = layer.opacity !== undefined ? ` opacity="${layer.opacity}"` : '';
    body.push(
      o.cutLines
        ? `<path d="${d}" fill="none" stroke="${layer.fill}" stroke-width="${hair}"${op}/>`
        : `<path d="${d}" fill="${layer.fill}" fill-rule="evenodd"${op}/>`,
    );
  }

  const outline = o.outlineColor ?? '#888';
  for (const r of o.outlineRings ?? []) {
    body.push(
      `<path d="${ringPath(r, yFlip)}" fill="none" stroke="${outline}" stroke-width="${hair * 2}" ` +
        `stroke-dasharray="${hair * 8} ${hair * 6}"/>`,
    );
  }

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${x0} ${y0} ${w} ${h}" ` +
    `width="${w}mm" height="${h}mm">` +
    body.join('') +
    '</svg>'
  );
}
