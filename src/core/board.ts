/**
 * Board geometry: squares, the connectivity treatment that stops them falling apart,
 * the frame, and the weeding box. No pieces here.
 *
 * Design coordinates are millimeters with y up and the origin at the bottom-left of the
 * outermost edge of the frame, so nothing in the output is ever negative except the
 * weeding box, which deliberately sits outside everything.
 */
import type { Ring, Region } from './types.js';
import { rect, rectRing } from './geom.js';
import { difference, union } from './clip.js';
import { isLightSquare } from './fen.js';

export type Layout = {
  squareSize: number;
  frameWidth: number;
  /** Distance from the design origin to the board's bottom-left corner. */
  origin: number;
  boardSide: number;
  totalSide: number;
};

export function makeLayout(squareSize: number, frameWidth: number): Layout {
  const boardSide = 8 * squareSize;
  return {
    squareSize,
    frameWidth,
    origin: frameWidth,
    boardSide,
    totalSide: boardSide + 2 * frameWidth,
  };
}

/** Bottom-left / top-right of one square, in design coordinates. */
export function squareBox(L: Layout, file: number, rank: number): [number, number, number, number] {
  const x0 = L.origin + file * L.squareSize;
  const y0 = L.origin + rank * L.squareSize;
  return [x0, y0, x0 + L.squareSize, y0 + L.squareSize];
}

/** The 32 squares of one color, as 32 separate components -- they only touch at corners. */
export function squaresOfColor(L: Layout, light: boolean): Region {
  const cells: Region = [];
  for (let rank = 0; rank < 8; rank++) {
    for (let file = 0; file < 8; file++) {
      if (isLightSquare(file, rank) !== light) continue;
      const [x0, y0, x1, y1] = squareBox(L, file, rank);
      cells.push({ outer: rectRing(x0, y0, x1, y1), holes: [] });
    }
  }
  return cells;
}

/** The 32 squares of one color, each shrunk by `inset`, as 32 separate components. */
export function insetSquares(L: Layout, light: boolean, inset: number): Region {
  const cells: Region = [];
  for (let rank = 0; rank < 8; rank++) {
    for (let file = 0; file < 8; file++) {
      if (isLightSquare(file, rank) !== light) continue;
      const [x0, y0, x1, y1] = squareBox(L, file, rank);
      if (x1 - x0 <= 2 * inset) continue;
      cells.push({ outer: rectRing(x0 + inset, y0 + inset, x1 - inset, y1 - inset), holes: [] });
    }
  }
  return cells;
}

/**
 * Grout: start from a solid board and punch out the other color's squares, each shrunk by
 * `inset`. What is left is 32 squares joined by an `inset`-wide lattice, i.e. one rigid piece
 * instead of 32 loose ones. Its narrowest point is `2*sqrt(2)*inset`, at the corner junctions,
 * because a hole stops `inset` short of the shared corner in both axes.
 */
export function groutedBoard(L: Layout, cutIsLight: boolean, inset: number): Region {
  const board = rect(L.origin, L.origin, L.origin + L.boardSide, L.origin + L.boardSide);
  return difference(board, insetSquares(L, !cutIsLight, inset));
}

/**
 * Corner bridges: a small square centered on an interior lattice vertex, joining the two
 * cut-colored squares that meet there diagonally. It necessarily takes a matching bite out
 * of the two substrate-colored squares -- any connected path from one diagonal quadrant to
 * the other has to pass through the others, and a zero-width path cannot be cut.
 *
 * `spanning` keeps only the 31 bridges needed to make all 32 squares one component; `all`
 * uses every one of the 49 interior vertices, which is far more rigid.
 */
export function cornerBridges(L: Layout, cutIsLight: boolean, width: number, spanning: boolean): Region {
  const half = width / 2;
  // Union-find over the 32 cut squares, keyed by cell index.
  const parent = new Map<number, number>();
  const find = (a: number): number => {
    let r = a;
    while (parent.get(r) !== r) r = parent.get(r)!;
    while (parent.get(a) !== r) {
      const next = parent.get(a)!;
      parent.set(a, r);
      a = next;
    }
    return r;
  };
  const key = (f: number, r: number): number => r * 8 + f;
  for (let rank = 0; rank < 8; rank++)
    for (let file = 0; file < 8; file++)
      if (isLightSquare(file, rank) === cutIsLight) parent.set(key(file, rank), key(file, rank));

  const out: Region = [];
  for (let j = 1; j <= 7; j++) {
    for (let i = 1; i <= 7; i++) {
      // The four cells around vertex (i,j); exactly one diagonal pair is cut-colored.
      const diag: [number, number][] = isLightSquare(i, j) === cutIsLight
        ? [[i - 1, j - 1], [i, j]]
        : [[i, j - 1], [i - 1, j]];
      const a = key(diag[0]![0], diag[0]![1]);
      const b = key(diag[1]![0], diag[1]![1]);
      if (spanning) {
        const ra = find(a), rb = find(b);
        if (ra === rb) continue;
        parent.set(ra, rb);
      }
      const x = L.origin + i * L.squareSize;
      const y = L.origin + j * L.squareSize;
      out.push({ outer: rectRing(x - half, y - half, x + half, y + half), holes: [] });
    }
  }
  return out;
}

/** The frame, as a ring around the board. Also welds the edge squares to something solid. */
export function frameRing(L: Layout): Region {
  if (L.frameWidth <= 0) return [];
  return [
    {
      outer: rectRing(0, 0, L.totalSide, L.totalSide),
      holes: [rectRing(L.frameWidth, L.frameWidth, L.totalSide - L.frameWidth, L.totalSide - L.frameWidth).reverse()],
    },
  ];
}

/**
 * A single rectangle cut `margin` outside everything else, so the surrounding waste peels
 * off in one pull instead of being picked at. It is never unioned with the artwork -- it is
 * emitted as a bare contour.
 */
export function weedBoxRing(L: Layout, margin: number): Ring {
  return rectRing(-margin, -margin, L.totalSide + margin, L.totalSide + margin);
}

export function boardOuter(L: Layout): Region {
  return rect(0, 0, L.totalSide, L.totalSide);
}
