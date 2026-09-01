/**
 * Turn a position plus settings into the four sheets that get cut.
 *
 * Why Four
 * --------
 * A one-sheet build has to distinguish four things with two colors, and one of the four
 * combinations has nowhere to go: a piece the same color as the square it stands on can only
 * be drawn as an outline. On vinyl an outline is a closed ring a millimeter or so wide with
 * nothing holding it, and it will not survive weeding or transfer. Four sheets remove the
 * problem rather than working around it -- every shape on every sheet is solid, and a piece
 * is told from its square by the color of the vinyl it was cut from, not by a gap.
 *
 *   light   the light squares
 *   dark    the dark squares, plus the frame
 *   white   every white piece, solid
 *   black   every black piece, solid
 *
 * No Stacking
 * -----------
 * Heat transfer vinyl bonds to fabric and not to itself, so anything laid over another sheet
 * simply does not stick. There is no free overlap to hide registration error in, and every
 * square millimeter of the design belongs to exactly one sheet:
 *
 *   - the piece sheets are cut as drawn, and the outline of every piece is knocked back out
 *     of whichever square sheet it stands on, `gap` wider all round;
 *   - the two square sheets are exact complements. One is a continuous ground -- the frame,
 *     the grout lattice and its own 32 squares, all one decal -- and the other is whatever is
 *     left, which is 32 separate tiles unless `connect` is `interlock`.
 *
 * `gap` is the one tolerance in the design. Positive leaves a hairline of bare fabric around
 * every piece, which absorbs cutting error and reads as a deliberate outline; zero butts the
 * edges exactly; negative overlaps, which is wrong for HTV but correct for adhesive vinyl.
 */
import type { Ring, Region } from './types.js';
import type { Board } from './fen.js';
import { idx } from './fen.js';
import { GLYPH_BOX, SILHOUETTES } from './glyphs.gen.js';
import { difference, offset, union } from './clip.js';
import { boardOuter, cornerBridges, insetSquares, makeLayout, squareBox, squaresOfColor, weedBoxRing, type Layout } from './board.js';
import { bbox, signedArea, transformRegion, type Box } from './geom.js';

export type LayerId = 'light' | 'dark' | 'white' | 'black';
export type Connect = 'grout' | 'interlock' | 'none';

export const LAYER_IDS: readonly LayerId[] = ['light', 'dark', 'white', 'black'];
export const LAYER_NAMES: Record<LayerId, string> = {
  light: 'Light squares',
  dark: 'Dark squares',
  white: 'White pieces',
  black: 'Black pieces',
};

export type Settings = {
  squareSize: number;
  frameWidth: number;
  /**
   * Which color is the continuous ground: the sheet that carries the frame, the grout
   * lattice and its own squares as a single decal. The other color gets what is left.
   */
  ground: 'dark' | 'light';
  /**
   * `grout` shrinks the tile color's squares so the ground becomes one piece; the tiles stay
   * 32 separate decals, which is the right trade on HTV -- see `tileSheet`. `interlock` also
   * bridges the tiles diagonally so both sheets come off as one decal, at a visible cost.
   * `none` leaves both colors as exact squares meeting edge to edge.
   */
  connect: Connect;
  groutInset: number;
  /**
   * Width of the corner bridges. The tile sheet's narrowest point is `sqrt(2)*(width/2 -
   * groutInset)`, so this and the grout inset pull against each other: a wider inset makes
   * the ground stronger and the tiles weaker at the same bridge width.
   */
  bridgeWidth: number;
  /** Knockout clearance between a piece and the square sheet under it. */
  gap: number;
  /** 1.0 makes a piece exactly as wide as its square. */
  pieceScale: number;
  /** 0 disables the weeding box. */
  weedMargin: number;
  /** Global grow (+) or shrink (-) to compensate for a blade that over- or under-cuts. */
  grow: number;
  /**
   * Discard disconnected fragments below this area, in mm^2. Keep it under 3: the counters
   * the font draws inside a piece -- the king's two eyes, the knight's one -- survive the
   * knockout as islands of square color, and the knight's is only 3.8 mm^2. Dropping his
   * and keeping the king's 39.5 mm^2 ones looks like a bug, because it is one.
   */
  minScrapArea: number;
  /** Fill holes below this area, in mm^2. A sub-millimeter hole cannot be weeded out anyway. */
  minHoleArea: number;
  flipped: boolean;
  /** Preview only -- a DXF carries no color. `colorFabric` shows through every gap. */
  colorFabric: string;
  colorLight: string;
  colorDark: string;
  colorWhite: string;
  colorBlack: string;
};

export const DEFAULTS: Settings = {
  squareSize: 33,
  frameWidth: 4,
  ground: 'dark',
  connect: 'grout',
  groutInset: 0.6,
  bridgeWidth: 3.2,
  gap: 0.25,
  pieceScale: 0.86,
  weedMargin: 5,
  grow: 0,
  minScrapArea: 2,
  minHoleArea: 1.0,
  flipped: false,
  colorFabric: '#2b3038',
  // The pair every Wikipedia chess diagram uses, taken from Chessboard480.svg on Commons.
  colorLight: '#ffce9e',
  colorDark: '#d18b47',
  colorWhite: '#fafaf7',
  colorBlack: '#15171a',
};

export type Layer = {
  id: LayerId;
  name: string;
  /** Preview color. Not written to the DXF, which has no notion of one. */
  color: string;
  region: Region;
  scrapsDropped: number;
  holesFilled: number;
};

export type Composition = {
  layout: Layout;
  /** Bottom sheet first: light, dark, white, black. Disjoint, so the order is presentational. */
  layers: Layer[];
  /**
   * Cut identically into every sheet. Besides letting the waste peel off in one pull, four
   * sheets sharing one exact rectangle is the whole registration scheme: line the boxes up
   * and everything inside them lines up too.
   */
  weedRing: Ring | null;
  box: Box;
  pieceCount: number;
};

/** Place a glyph into a square. The design box is scaled to fill the square. */
export function placeGlyph(L: Layout, type: keyof typeof SILHOUETTES, file: number, rank: number, scale: number): Region {
  const [x0, y0] = squareBox(L, file, rank);
  const k = (L.squareSize / GLYPH_BOX) * scale;
  const pad = (L.squareSize * (1 - scale)) / 2;
  return transformRegion(SILHOUETTES[type], k, k, x0 + pad, y0 + pad);
}

/**
 * Remove fragments and holes too small to be worth weeding. Returns the cleaned region
 * alongside counts, so the UI can say what it threw away rather than silently editing.
 */
export function dropScraps(region: Region, minArea: number, minHoleArea: number): {
  region: Region;
  dropped: number;
  filled: number;
} {
  let dropped = 0;
  let filled = 0;
  const out: Region = [];
  for (const p of region) {
    const outerArea = Math.abs(signedArea(p.outer));
    const holes = p.holes.filter((h) => {
      const keep = Math.abs(signedArea(h)) >= minHoleArea;
      if (!keep) filled++;
      return keep;
    });
    const net = outerArea - holes.reduce((a, h) => a + Math.abs(signedArea(h)), 0);
    if (net < minArea) {
      dropped++;
      continue;
    }
    out.push({ outer: p.outer, holes });
  }
  return { region: out, dropped, filled };
}

/**
 * The squares that are NOT the ground: the sheet that has to make do with what the ground
 * leaves it. Under `grout` that is 32 separate tiles.
 *
 * Why the Tiles Stay Loose
 * ------------------------
 * `interlock` bridges the tiles diagonally so they come off as a single decal instead, which
 * sounds strictly better and is not. Two squares of one color meet at a corner at exactly
 * zero width, so ANY connector between them of any positive width has to intrude into the
 * two squares of the other color that meet at the same point. The bridge is therefore
 * visible as a tile-colored square sitting between the corners of two ground squares, at 31
 * of the 49 interior vertices. There is no shape that avoids this -- a diagonal strip makes
 * the intrusion smaller but never removes it.
 *
 * And what it buys is worth less than it looks. The negative space you weed is identical
 * either way; the tiles being separate only matters if something has to hold them in
 * register, and heat transfer vinyl arrives on a tacky carrier sheet that does exactly that.
 * Interlock is solving a transfer-tape problem that HTV does not have. It stays available
 * because adhesive vinyl does have it.
 *
 * When it is used, the bridges must form a spanning TREE rather than covering all 49 interior
 * vertices. A tree does not separate the plane, so the ground -- which is the exact
 * complement -- survives as one piece too. Add the 18 extra bridges that close the cycles and
 * each cycle encircles a ground square and cuts it loose. That is not a tuning preference,
 * which is why `spanning` is not offered as a choice here.
 */
function tileSheet(L: Layout, light: boolean, s: Settings): Region {
  switch (s.connect) {
    case 'grout':
      return insetSquares(L, light, s.groutInset);
    case 'interlock':
      return union(insetSquares(L, light, s.groutInset), cornerBridges(L, light, s.bridgeWidth, true));
    default:
      return squaresOfColor(L, light);
  }
}

export function compose(board: Board, s: Settings): Composition {
  const L = makeLayout(s.squareSize, s.frameWidth);
  const view = s.flipped ? board.map((_, i) => board[63 - i]!) : board;

  // --- squares -------------------------------------------------------------
  // The ground is the exact complement of the tiles inside the outer rectangle, so it picks
  // up the frame for free and there is no overlap anywhere along the boundary between them.
  const groundIsLight = s.ground === 'light';
  const tiles = tileSheet(L, !groundIsLight, s);
  const ground = difference(boardOuter(L), tiles);

  // --- pieces --------------------------------------------------------------
  const whitePieces: Region[] = [];
  const blackPieces: Region[] = [];
  let pieceCount = 0;
  for (let rank = 0; rank < 8; rank++) {
    for (let file = 0; file < 8; file++) {
      const piece = view[idx(file, rank)];
      if (!piece) continue;
      pieceCount++;
      (piece.color === 'w' ? whitePieces : blackPieces).push(placeGlyph(L, piece.type, file, rank, s.pieceScale));
    }
  }

  // Every piece is knocked out of both square sheets. A piece only ever stands on one of
  // them, but subtracting from both costs nothing and copes with a piece scaled up far
  // enough to cross into the grout.
  const pieces = [...whitePieces, ...blackPieces];
  const knockOut = pieces.length ? offset(union(...pieces), s.gap) : [];
  const knock = (r: Region): Region => (knockOut.length ? difference(r, knockOut) : r);

  const raw: Record<LayerId, Region> = {
    light: knock(groundIsLight ? ground : tiles),
    dark: knock(groundIsLight ? tiles : ground),
    white: whitePieces.length ? union(...whitePieces) : [],
    black: blackPieces.length ? union(...blackPieces) : [],
  };

  const shift = s.weedMargin;
  const colors: Record<LayerId, string> = {
    light: s.colorLight, dark: s.colorDark, white: s.colorWhite, black: s.colorBlack,
  };

  const layers: Layer[] = LAYER_IDS.map((id) => {
    let region = raw[id];
    if (s.grow !== 0 && region.length) region = offset(region, s.grow);
    const cleaned = dropScraps(region, s.minScrapArea, s.minHoleArea);
    // The weeding box sits outside the artwork, which would otherwise push the design into
    // negative coordinates. Shift every sheet by the same amount so the exported extents
    // start at the origin, matching the reference file the DXF dialect came from -- and so
    // the four sheets stay in register with each other.
    const moved = shift > 0 ? transformRegion(cleaned.region, 1, 1, shift, shift) : cleaned.region;
    return { id, name: LAYER_NAMES[id], color: colors[id], region: moved, scrapsDropped: cleaned.dropped, holesFilled: cleaned.filled };
  });

  let weedRing = s.weedMargin > 0 ? weedBoxRing(L, s.weedMargin) : null;
  let box = s.weedMargin > 0
    ? { x0: -s.weedMargin, y0: -s.weedMargin, x1: L.totalSide + s.weedMargin, y1: L.totalSide + s.weedMargin }
    : bbox(layers.flatMap((l) => l.region));

  let layout = L;
  if (shift > 0) {
    if (weedRing) weedRing = weedRing.map(([x, y]) => [x + shift, y + shift] as const);
    box = { x0: box.x0 + shift, y0: box.y0 + shift, x1: box.x1 + shift, y1: box.y1 + shift };
    layout = { ...L, origin: L.origin + shift };
  }

  return { layout, layers, weedRing, box, pieceCount };
}
