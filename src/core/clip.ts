/**
 * The only file that knows about Clipper.
 *
 * Everything downstream works in millimetres on `Region`; this module converts to Clipper's
 * integer coordinates and back. Swapping in Clipper2/WASM later means rewriting this file only.
 *
 * Scale is 1e4, i.e. 0.1 um. Design coordinates stay under ~310 mm, so integers stay under
 * 3.1e6 -- far inside Clipper's safe range, and far finer than any drag knife can resolve.
 */
import ClipperLib from 'clipper-lib';
import type { Pt, Ring, Poly, Region } from './types.js';

const { Clipper, ClipperOffset, ClipType, EndType, JoinType, PolyFillType, PolyType, PolyTree } = ClipperLib;
type Path = ClipperLib.Path;
type Paths = ClipperLib.Paths;
type PolyNode = ClipperLib.PolyNode;
type PolyTreeT = ClipperLib.PolyTree;
import { signedArea } from './geom.js';

export const SCALE = 1e4;

/** Chord tolerance for the polygons Clipper generates when rounding a join, in mm. */
const ARC_TOLERANCE_MM = 0.02;
const MITER_LIMIT = 2.0;

export const Join = { round: JoinType.jtRound, miter: JoinType.jtMiter, square: JoinType.jtSquare } as const;
export type JoinStyle = (typeof Join)[keyof typeof Join];

function ringToPath(ring: Ring, wantCcw: boolean): Path {
  const ccw = signedArea(ring) >= 0;
  const src = ccw === wantCcw ? ring : [...ring].reverse();
  return src.map(([x, y]) => ({ X: Math.round(x * SCALE), Y: Math.round(y * SCALE) }));
}

/** Region -> Clipper paths, with outers CCW and holes CW so pftNonZero sees holes as holes. */
export function toPaths(region: Region): Paths {
  const paths: Paths = [];
  for (const poly of region) {
    if (poly.outer.length >= 3) paths.push(ringToPath(poly.outer, true));
    for (const h of poly.holes) if (h.length >= 3) paths.push(ringToPath(h, false));
  }
  return paths;
}

function pathToRing(path: Path): Ring {
  return path.map((p) => [p.X / SCALE, p.Y / SCALE] as Pt);
}

/**
 * Flatten a PolyTree into Region. Clipper nests holes inside outers and outers inside holes
 * (an island in a lake), so this recurses: a hole's children are new top-level components.
 */
function fromPolyTree(tree: PolyTreeT): Region {
  const out: Region = [];
  const visitOuter = (node: PolyNode): void => {
    const poly: Poly = { outer: pathToRing(node.m_polygon), holes: [] };
    for (const child of node.Childs()) {
      // Direct children of an outer are always holes.
      poly.holes.push(pathToRing(child.m_polygon));
      // Anything nested inside that hole is a separate connected component.
      for (const grand of child.Childs()) visitOuter(grand);
    }
    if (poly.outer.length >= 3) out.push(poly);
  };
  for (const child of tree.Childs()) visitOuter(child);
  return out;
}

function execute(clipType: number, subject: Paths, clip: Paths): Region {
  const c = new Clipper();
  if (subject.length) c.AddPaths(subject, PolyType.ptSubject, true);
  if (clip.length) c.AddPaths(clip, PolyType.ptClip, true);
  const tree = new PolyTree();
  c.Execute(clipType, tree, PolyFillType.pftNonZero, PolyFillType.pftNonZero);
  return fromPolyTree(tree);
}

/** Union of any number of regions. Also the canonical way to normalise one region. */
export function union(...regions: Region[]): Region {
  const paths: Paths = [];
  for (const r of regions) paths.push(...toPaths(r));
  if (!paths.length) return [];
  return execute(ClipType.ctUnion, paths, []);
}

/**
 * Resolve a flat list of contours into a Region using each contour's OWN winding, the way a
 * non-zero fill rule reads a font glyph or an SVG path.
 *
 * `union` cannot do this: it takes `Poly` values, where nesting is already decided, and
 * forces every outer counter-clockwise. Handing it a glyph's contours as separate one-ring
 * components therefore reverses the holes and fills them in -- which quietly costs the king
 * his eyes and the knight his. Anything that starts life as raw contours has to come through
 * here instead.
 */
export function fromRings(contours: Ring[]): Region {
  const paths: Paths = [];
  for (const r of contours) {
    if (r.length >= 3) paths.push(r.map(([x, y]) => ({ X: Math.round(x * SCALE), Y: Math.round(y * SCALE) })));
  }
  if (!paths.length) return [];
  return execute(ClipType.ctUnion, paths, []);
}

export function difference(a: Region, b: Region): Region {
  if (!a.length) return [];
  if (!b.length) return union(a);
  return execute(ClipType.ctDifference, toPaths(a), toPaths(b));
}

export function intersect(a: Region, b: Region): Region {
  if (!a.length || !b.length) return [];
  return execute(ClipType.ctIntersection, toPaths(a), toPaths(b));
}

/**
 * Grow (delta > 0) or shrink (delta < 0) a region by `deltaMm`, measured perpendicular to
 * every edge. Shrinking to nothing yields an empty region, which is exactly what the
 * minimum-feature check relies on.
 */
export function offset(region: Region, deltaMm: number, join: JoinStyle = Join.round): Region {
  if (!region.length) return [];
  if (deltaMm === 0) return union(region);
  const co = new ClipperOffset(MITER_LIMIT, ARC_TOLERANCE_MM * SCALE);
  co.AddPaths(toPaths(region), join, EndType.etClosedPolygon);
  const tree = new PolyTree();
  co.Execute(tree, deltaMm * SCALE);
  return fromPolyTree(tree);
}

/**
 * Morphological opening: erode then dilate. Removes anything thinner than 2*radius.
 *
 * Round joins are not a stylistic choice here -- they are the definition. Opening means
 * sweeping a disc through the shape, and only a round join approximates a disc. Mitred joins
 * make the round trip *exactly invertible* for any rectilinear shape, so an opening built
 * from them reconstructs whatever it just removed and reports that nothing is thin.
 */
export function open(region: Region, radiusMm: number, join: JoinStyle = Join.round): Region {
  if (radiusMm <= 0) return union(region);
  return offset(offset(region, -radiusMm, join), radiusMm, join);
}

/** Drop vertices closer together than `distMm`. Shrinks output files with no visible effect. */
export function clean(region: Region, distMm = 0.005): Region {
  if (!region.length) return [];
  const cleaned = Clipper.CleanPolygons(toPaths(region), distMm * SCALE);
  return execute(ClipType.ctUnion, cleaned.filter((p) => p.length >= 3), []);
}
