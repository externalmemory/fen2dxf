/**
 * DXF writer.
 *
 * The dialect here is not a guess: it was copied group code by group code from a file already
 * known to import correctly into Silhouette Studio for the Cameo 5 Alpha, and the output was
 * checked back against that file byte for byte through the header, the tables and the first
 * entity. That reference is no longer in the repo, so treat the list below as the record of
 * what it said. Deviating from it is the fastest way to break the one thing known to work:
 *
 *   - R12 (AC1009), but with $INSUNITS=4 (mm) and $MEASUREMENT=1 written anyway. Those
 *     header variables post-date R12; Studio reads them, older parsers skip them.
 *   - A minimal TABLES/LAYER section declaring only layer "0", and every entity on layer "0".
 *     Named layers would have to be declared here too, and buy nothing: a cutter cuts every
 *     contour identically, and color separation is already handled by emitting separate files.
 *   - Closed POLYLINE (66=1 vertices-follow, 70=1 closed) + VERTEX + SEQEND.
 *   - No SPLINE, ELLIPSE, ARC, BLOCK or INSERT. Every curve is flattened before it gets here.
 *
 * Coordinates are millimetres with y up, which is already how `Region` is defined.
 */
import type { Ring, Region } from './types.js';
import { bbox, boxUnion, isEmptyBox, rings } from './geom.js';

export type DxfOptions = {
  /** AC1015 + LWPOLYLINE instead of R12 POLYLINE. Smaller, but less universally accepted. */
  lwpolyline?: boolean;
  /** Extra standalone contours (the weeding box) appended verbatim, outside all boolean ops. */
  extraRings?: Ring[];
};

const f = (n: number): string => n.toFixed(6);

function polyline(ring: Ring, lw: boolean): string {
  if (ring.length < 2) return '';
  if (lw) {
    let s = `0\nLWPOLYLINE\n8\n0\n100\nAcDbEntity\n100\nAcDbPolyline\n90\n${ring.length}\n70\n1\n`;
    for (const [x, y] of ring) s += `10\n${f(x)}\n20\n${f(y)}\n`;
    return s;
  }
  let s = '0\nPOLYLINE\n8\n0\n66\n1\n70\n1\n10\n0.0\n20\n0.0\n30\n0.0\n';
  for (const [x, y] of ring) s += `0\nVERTEX\n8\n0\n10\n${f(x)}\n20\n${f(y)}\n30\n0.0\n`;
  s += '0\nSEQEND\n8\n0\n';
  return s;
}

export function toDxf(region: Region, opts: DxfOptions = {}): string {
  const lw = opts.lwpolyline ?? false;
  const extra = opts.extraRings ?? [];
  const all = [...rings(region), ...extra];

  let box = bbox(region);
  if (extra.length) box = boxUnion(box, bbox(extra.map((r) => ({ outer: r, holes: [] }))));
  if (isEmptyBox(box)) box = { x0: 0, y0: 0, x1: 0, y1: 0 };

  let s = '';
  s += '0\nSECTION\n2\nHEADER\n';
  s += `9\n$ACADVER\n1\n${lw ? 'AC1015' : 'AC1009'}\n`;
  s += '9\n$INSUNITS\n70\n4\n';
  s += '9\n$MEASUREMENT\n70\n1\n';
  s += `9\n$EXTMIN\n10\n${f(box.x0)}\n20\n${f(box.y0)}\n30\n0.0\n`;
  s += `9\n$EXTMAX\n10\n${f(box.x1)}\n20\n${f(box.y1)}\n30\n0.0\n`;
  s += '0\nENDSEC\n';

  s += '0\nSECTION\n2\nTABLES\n';
  s += '0\nTABLE\n2\nLAYER\n70\n1\n';
  s += '0\nLAYER\n2\n0\n70\n0\n62\n7\n6\nCONTINUOUS\n';
  s += '0\nENDTAB\n';
  s += '0\nENDSEC\n';

  s += '0\nSECTION\n2\nENTITIES\n';
  for (const ring of all) s += polyline(ring, lw);
  s += '0\nENDSEC\n0\nEOF\n';
  return s;
}

/**
 * A bare 100 mm square. Import it once, measure what Studio thinks it is, and the unit
 * question is settled forever.
 */
export function calibrationSquareDxf(sizeMm = 100): string {
  return toDxf([{ outer: [[0, 0], [sizeMm, 0], [sizeMm, sizeMm], [0, sizeMm]], holes: [] }]);
}
