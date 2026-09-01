import type { Pt, Ring, Poly, Region } from './types.js';

export type Box = { x0: number; y0: number; x1: number; y1: number };

/** Signed area of a ring. Positive = counter-clockwise in y-up coordinates. */
export function signedArea(ring: Ring): number {
  let a = 0;
  for (let i = 0, n = ring.length; i < n; i++) {
    const p = ring[i]!;
    const q = ring[(i + 1) % n]!;
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}

export function ringLength(ring: Ring): number {
  let len = 0;
  for (let i = 0, n = ring.length; i < n; i++) {
    const p = ring[i]!;
    const q = ring[(i + 1) % n]!;
    len += Math.hypot(q[0] - p[0], q[1] - p[1]);
  }
  return len;
}

/** Total length of every contour in the region — i.e. how far the blade travels cutting it. */
export function cutLength(region: Region): number {
  let len = 0;
  for (const poly of region) {
    len += ringLength(poly.outer);
    for (const h of poly.holes) len += ringLength(h);
  }
  return len;
}

export function regionArea(region: Region): number {
  let a = 0;
  for (const poly of region) {
    a += Math.abs(signedArea(poly.outer));
    for (const h of poly.holes) a -= Math.abs(signedArea(h));
  }
  return a;
}

export function rectRing(x0: number, y0: number, x1: number, y1: number): Ring {
  return [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
  ];
}

export function rect(x0: number, y0: number, x1: number, y1: number): Region {
  return [{ outer: rectRing(x0, y0, x1, y1), holes: [] }];
}

export const EMPTY_BOX: Box = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };

export function bbox(region: Region): Box {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const poly of region) {
    for (const [x, y] of poly.outer) {
      if (x < x0) x0 = x;
      if (y < y0) y0 = y;
      if (x > x1) x1 = x;
      if (y > y1) y1 = y;
    }
  }
  return { x0, y0, x1, y1 };
}

export function boxUnion(a: Box, b: Box): Box {
  return {
    x0: Math.min(a.x0, b.x0),
    y0: Math.min(a.y0, b.y0),
    x1: Math.max(a.x1, b.x1),
    y1: Math.max(a.y1, b.y1),
  };
}

export function isEmptyBox(b: Box): boolean {
  return !(b.x1 >= b.x0 && b.y1 >= b.y0);
}

/** Affine map (x,y) -> (sx*x + tx, sy*y + ty). */
export function transformRegion(region: Region, sx: number, sy: number, tx: number, ty: number): Region {
  const mapRing = (r: Ring): Ring => r.map(([x, y]) => [sx * x + tx, sy * y + ty] as Pt);
  const out = region.map((p): Poly => ({ outer: mapRing(p.outer), holes: p.holes.map(mapRing) }));
  // A negative determinant mirrors the shape, which flips every ring's winding.
  // Callers rely on outer rings being CCW, so restore it.
  if (sx * sy < 0) {
    for (const p of out) {
      p.outer.reverse();
      for (const h of p.holes) h.reverse();
    }
  }
  return out;
}

/** Every ring in the region, outers and holes alike. */
export function rings(region: Region): Ring[] {
  const out: Ring[] = [];
  for (const p of region) {
    out.push(p.outer);
    for (const h of p.holes) out.push(h);
  }
  return out;
}

export function roundRegion(region: Region, decimals = 4): Region {
  const f = 10 ** decimals;
  const r = (ring: Ring): Ring => ring.map(([x, y]) => [Math.round(x * f) / f, Math.round(y * f) / f] as Pt);
  return region.map((p) => ({ outer: r(p.outer), holes: p.holes.map(r) }));
}
