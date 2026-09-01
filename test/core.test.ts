import { describe, expect, it } from 'vitest';
import { DEFAULT_FEN, EMPTY_BOARD, START_FEN, idx, isLightSquare, parseFen, toFen } from '../src/core/fen.js';
import { difference, intersect, offset, open, union } from '../src/core/clip.js';
import { bbox, cutLength, rect, regionArea, signedArea, transformRegion } from '../src/core/geom.js';
import { boardOuter, cornerBridges, frameRing, groutedBoard, insetSquares, makeLayout, squaresOfColor } from '../src/core/board.js';
import { DEFAULTS, LAYER_IDS, compose, dropScraps, placeGlyph, type Composition, type LayerId, type Settings } from '../src/core/compose.js';
import { analyzeThin, validate } from '../src/core/validate.js';
import { calibrationSquareDxf, toDxf } from '../src/core/dxf.js';
import { SILHOUETTES } from '../src/core/glyphs.gen.js';

const fen = (text: string) => {
  const r = parseFen(text);
  if (!r.ok) throw new Error(r.error);
  return r.board;
};
const START = fen(START_FEN);
const KUBBEL = fen(DEFAULT_FEN);

/** The one sheet a test is talking about. */
const sheet = (c: Composition, id: LayerId) => c.layers.find((l) => l.id === id)!.region;

describe('fen', () => {
  it('round-trips the starting position', () => {
    expect(toFen(START)).toBe(START_FEN.split(' ')[0]);
  });

  it('puts a1 dark and h1 light, with a white rook on a1', () => {
    expect(isLightSquare(0, 0)).toBe(false);
    expect(isLightSquare(7, 0)).toBe(true);
    expect(START[idx(0, 0)]).toEqual({ type: 'r', color: 'w' });
    expect(START[idx(4, 7)]).toEqual({ type: 'k', color: 'b' });
  });

  it('accepts positions no chess engine would allow', () => {
    // No kings, nine pawns on a file, a pawn on the first rank. All legal *diagrams*.
    for (const fen of ['8/8/8/8/8/8/8/P7', 'pppppppp/pppppppp/8/8/8/8/8/8', '8/8/8/3Q4/8/8/8/8']) {
      expect(parseFen(fen).ok, fen).toBe(true);
    }
  });

  it('rejects malformed input with a useful message', () => {
    for (const fen of ['', 'rnbqkbnr/pppppppp', '9/8/8/8/8/8/8/8', 'rnbqkbnx/8/8/8/8/8/8/8']) {
      const r = parseFen(fen);
      expect(r.ok, fen).toBe(false);
      if (!r.ok) expect(r.error.length).toBeGreaterThan(0);
    }
  });

  it('treats an empty board as 8 empty ranks', () => {
    expect(toFen(EMPTY_BOARD)).toBe('8/8/8/8/8/8/8/8');
  });
});

describe('clip', () => {
  const withHole = difference(rect(0, 0, 10, 10), rect(3, 3, 7, 7));

  it('models a hole as a hole, not a second component', () => {
    expect(withHole).toHaveLength(1);
    expect(withHole[0]!.holes).toHaveLength(1);
    expect(regionArea(withHole)).toBeCloseTo(84, 6);
  });

  it('grows the outer boundary and shrinks holes on a positive offset', () => {
    // 12x12 outer minus a 2x2 hole = 140, less the area rounded off four convex corners.
    // The rounding is drawn as an inscribed polygon, so the result sits just under the exact
    // 139.14 and just under the unrounded 140.
    const grown = regionArea(offset(withHole, 1));
    expect(grown).toBeGreaterThan(139);
    expect(grown).toBeLessThan(140);
    expect(bbox(offset(withHole, 1))).toMatchObject({ x0: -1, y0: -1, x1: 11, y1: 11 });
    expect(regionArea(offset(withHole, -1))).toBeGreaterThan(28);
    expect(regionArea(offset(withHole, -1))).toBeLessThan(29);
  });

  it('keeps outer rings counter-clockwise and holes clockwise', () => {
    expect(signedArea(withHole[0]!.outer)).toBeGreaterThan(0);
    expect(signedArea(withHole[0]!.holes[0]!)).toBeLessThan(0);
  });

  it('reports corner-touching squares as two components, because that is what they are', () => {
    expect(union(rect(0, 0, 10, 10), rect(10, 10, 20, 20))).toHaveLength(2);
  });

  it('erases features narrower than the opening radius and keeps wider ones', () => {
    expect(open(rect(0, 0, 20, 0.4), 0.5)).toHaveLength(0);
    expect(open(rect(0, 0, 20, 2), 0.5)).toHaveLength(1);
  });

  it('survives an empty region without throwing', () => {
    expect(union()).toEqual([]);
    expect(offset([], 1)).toEqual([]);
    expect(difference([], rect(0, 0, 1, 1))).toEqual([]);
    expect(intersect([], rect(0, 0, 1, 1))).toEqual([]);
  });
});

describe('geom', () => {
  it('restores winding when a transform mirrors the shape', () => {
    const r = rect(0, 0, 4, 2);
    expect(signedArea(transformRegion(r, 1, -1, 0, 0)[0]!.outer)).toBeGreaterThan(0);
  });

  it('measures perimeter as the distance the blade travels', () => {
    expect(cutLength(rect(0, 0, 10, 5))).toBeCloseTo(30, 6);
    expect(cutLength(difference(rect(0, 0, 10, 10), rect(3, 3, 7, 7)))).toBeCloseTo(40 + 16, 6);
  });
});

describe('board', () => {
  const L = makeLayout(33, 4);

  it('lays 32 squares of each color, each its own component', () => {
    expect(squaresOfColor(L, false)).toHaveLength(32);
    expect(squaresOfColor(L, true)).toHaveLength(32);
  });

  it('makes grout a single connected lattice', () => {
    const g = groutedBoard(L, false, 0.6);
    expect(g).toHaveLength(1);
    expect(g[0]!.holes).toHaveLength(32);
  });

  it('narrows to 2*sqrt(2)*inset at the diagonal junctions, and nowhere tighter', () => {
    // Two diagonally adjacent holes each stop `inset` short of the shared corner, so the
    // material between them measures 2*sqrt(2)*inset across. Everything else in the lattice
    // is backed by a whole square. This is what makes grout stronger than a bridge of the
    // same nominal width, and it is the number the default is chosen against.
    for (const inset of [0.4, 0.5, 0.6]) {
      const g = groutedBoard(L, false, inset);
      const narrowest = 2 * Math.SQRT2 * inset;
      expect(analyzeThin(g, narrowest * 0.9).necks, `inset ${inset} below`).toBe(0);
      // Severing every junction leaves the 32 squares loose: 31 splits.
      expect(analyzeThin(g, narrowest * 1.15).necks, `inset ${inset} above`).toBe(31);
    }
  });

  it('detects a severed rectilinear lattice, which a miterd opening would hide', () => {
    // Regression: erode-then-dilate with miterd joins is exactly invertible on rectilinear
    // shapes, so an opening-based check reconstructs the cut and reports it as sound.
    const g = groutedBoard(L, false, 0.3);
    expect(analyzeThin(g, 1.5).necks).toBe(31);
  });

  it('joins all 32 squares with bridges, and needs exactly 31 to do it', () => {
    expect(cornerBridges(L, false, 1, true)).toHaveLength(31);
    expect(cornerBridges(L, false, 1, false)).toHaveLength(49);
    expect(union(squaresOfColor(L, false), cornerBridges(L, false, 1, true))).toHaveLength(1);
    // Without bridges they stay 32 loose squares.
    expect(union(squaresOfColor(L, false))).toHaveLength(32);
  });

  it('draws the frame as a ring, not a filled square', () => {
    const f = frameRing(L);
    expect(f).toHaveLength(1);
    expect(f[0]!.holes).toHaveLength(1);
    expect(regionArea(f)).toBeCloseTo(L.totalSide ** 2 - L.boardSide ** 2, 6);
  });
});

describe('compose', () => {
  const settings = (over: Partial<Settings> = {}): Settings => ({ ...DEFAULTS, ...over });

  it('emits exactly the four sheets, bottom first', () => {
    const c = compose(START, settings());
    expect(c.layers.map((l) => l.id)).toEqual([...LAYER_IDS]);
    expect(c.layers.map((l) => l.id)).toEqual(['light', 'dark', 'white', 'black']);
  });

  it('makes the ground one decal and the tiles 32, on an empty board', () => {
    const c = compose(EMPTY_BOARD, settings());
    expect(sheet(c, 'dark')).toHaveLength(1);
    expect(sheet(c, 'light')).toHaveLength(32);
    expect(sheet(c, 'white')).toHaveLength(0);
    expect(sheet(c, 'black')).toHaveLength(0);
  });

  it('never puts tile color where two ground squares meet at a corner', () => {
    // The complaint interlock earns and grout does not. Probe a small disc at each of the 49
    // interior vertices: under grout the ground owns every one of them outright.
    const c = compose(EMPTY_BOARD, settings());
    const L = c.layout;
    const tiles = sheet(c, 'light');
    for (let j = 1; j <= 7; j++) {
      for (let i = 1; i <= 7; i++) {
        const x = L.origin + i * L.squareSize;
        const y = L.origin + j * L.squareSize;
        const probe = offset([{ outer: [[x, y], [x + 0.01, y], [x + 0.01, y + 0.01], [x, y + 0.01]], holes: [] }], 0.4);
        expect(regionArea(intersect(probe, tiles)), `vertex ${i},${j}`).toBeCloseTo(0, 6);
      }
    }
  });

  it('tiles rather than stacks: no two sheets share any area', () => {
    // Heat transfer vinyl bonds to fabric and not to itself, so an overlap is not a safety
    // margin, it is a patch that will not stick. This is the property the whole layout turns
    // on, so it is checked exhaustively rather than at the boundaries anyone thought of.
    const c = compose(START, settings());
    for (let i = 0; i < c.layers.length; i++) {
      for (let j = i + 1; j < c.layers.length; j++) {
        const both = intersect(c.layers[i]!.region, c.layers[j]!.region);
        expect(regionArea(both), `${c.layers[i]!.id} vs ${c.layers[j]!.id}`).toBeCloseTo(0, 6);
      }
    }
  });

  it('covers the whole board between the two square sheets when nothing stands on it', () => {
    // The ground is defined as the exact complement of the tiles, so together they must be
    // the outer rectangle with nothing left over and nothing counted twice.
    const c = compose(EMPTY_BOARD, settings({ weedMargin: 0 }));
    const L = c.layout;
    const covered = union(sheet(c, 'light'), sheet(c, 'dark'));
    expect(regionArea(covered)).toBeCloseTo(L.totalSide ** 2, 4);
    expect(covered).toHaveLength(1);
  });

  it('knocks every piece out of the square sheet under it, gap and all', () => {
    const c = compose(START, settings());
    const pieces = union(sheet(c, 'white'), sheet(c, 'black'));
    const squares = union(sheet(c, 'light'), sheet(c, 'dark'));
    expect(regionArea(intersect(pieces, squares))).toBeCloseTo(0, 6);
    // ...and the hole is `gap` wider than the piece all round, so bare fabric shows between.
    const grown = offset(pieces, DEFAULTS.gap - 0.01);
    expect(regionArea(intersect(grown, squares))).toBeCloseTo(0, 6);
  });

  it('splits the pieces by color, not by the square they stand on', () => {
    const c = compose(START, settings());
    // Every piece type contributes the same silhouette to both piece sheets, so the two
    // are congruent: 8 pawns at 3 decals, 2 knights and 2 bishops at 2, 2 rooks at 3,
    // queen and king at 2 each.
    const expected = 8 * 3 + 2 * 2 + 2 * 2 + 2 * 3 + 2 + 2;
    expect(sheet(c, 'white')).toHaveLength(expected);
    expect(sheet(c, 'black')).toHaveLength(expected);
    expect(regionArea(sheet(c, 'white'))).toBeCloseTo(regionArea(sheet(c, 'black')), 4);
  });

  it('swaps which color is the continuous sheet without changing the total', () => {
    const dark = compose(EMPTY_BOARD, settings({ ground: 'dark' }));
    const light = compose(EMPTY_BOARD, settings({ ground: 'light' }));
    expect(regionArea(sheet(dark, 'dark'))).toBeCloseTo(regionArea(sheet(light, 'light')), 4);
    expect(regionArea(sheet(dark, 'light'))).toBeCloseTo(regionArea(sheet(light, 'dark')), 4);
  });

  it('keeps the counters inside a piece as islands of square color', () => {
    // The king's two eyes and the knight's one are holes in the glyph, so the knockout leaves
    // the square showing through them. The knight's is only 3.8 mm2, which is why
    // minScrapArea has to stay below it -- dropping his and keeping the king's looks like a
    // bug. A lone king on a dark square: the dark sheet is the ground plus two islands.
    const board = EMPTY_BOARD.slice();
    board[idx(0, 0)] = { type: 'k', color: 'w' }; // a1 is dark
    const c = compose(board, settings({ ground: 'dark' }));
    expect(sheet(c, 'dark')).toHaveLength(3);
    const islands = sheet(c, 'dark').filter((p) => Math.abs(signedArea(p.outer)) < 100);
    expect(islands).toHaveLength(2);
    for (const i of islands) expect(Math.abs(signedArea(i.outer))).toBeGreaterThan(DEFAULTS.minScrapArea);
  });

  it('gives every sheet the same weeding box and the same extents', () => {
    // Four sheets that share one rectangle are four sheets you can line up by eye.
    const c = compose(START, settings());
    expect(c.weedRing).not.toBeNull();
    const b = bbox([{ outer: c.weedRing!, holes: [] }]);
    expect(b.x0).toBeCloseTo(0, 9);
    expect(b.y0).toBeCloseTo(0, 9);
    for (const l of c.layers) {
      if (!l.region.length) continue;
      const lb = bbox(l.region);
      expect(lb.x0).toBeGreaterThanOrEqual(b.x0 - 1e-9);
      expect(lb.x1).toBeLessThanOrEqual(b.x1 + 1e-9);
    }
  });

  it('drops scraps and fills pinholes, and says how many', () => {
    const messy = union(rect(0, 0, 50, 50), rect(200, 200, 202, 202));
    const withPin = difference(messy, rect(10, 10, 10.5, 10.5));
    const r = dropScraps(withPin, 15, 1);
    expect(r.dropped).toBe(1); // the 4 mm^2 square
    expect(r.filled).toBe(1); // the 0.25 mm^2 pinhole
    expect(r.region).toHaveLength(1);
    expect(r.region[0]!.holes).toHaveLength(0);
  });

  it('scales the glyph to the square it is placed on', () => {
    const L = makeLayout(33, 4);
    const g = placeGlyph(L, 'k', 0, 0, 1);
    const b = bbox(g);
    expect(b.x0).toBeGreaterThanOrEqual(L.origin - 1e-6);
    expect(b.x1).toBeLessThanOrEqual(L.origin + 33 + 1e-6);
    expect(b.y1 - b.y0).toBeGreaterThan(20);
  });

  it('keeps the queen\'s crown balls welded to their spikes', () => {
    // The font draws them as four free-standing circles clearing the spike tips by about a
    // millimeter. Unrepaired that is a crown plus four loose discs; repaired it is two.
    expect(SILHOUETTES.q).toHaveLength(2);
  });

  it('keeps the eyes the font drew as holes rather than filling them in', () => {
    // Contours have to be resolved by their own winding. Treating each as its own outer
    // silently costs the king his eyes and the knight his.
    expect(SILHOUETTES.k[0]!.holes.length + SILHOUETTES.k[1]!.holes.length).toBe(2);
    expect(SILHOUETTES.n[0]!.holes.length + SILHOUETTES.n[1]!.holes.length).toBe(1);
  });
});

describe('interlock', () => {
  const L = makeLayout(33, 4);
  const build = (inset: number, width: number, spanning: boolean) => {
    const tiles = union(insetSquares(L, true, inset), cornerBridges(L, true, width, spanning));
    return { tiles, ground: difference(boardOuter(L), tiles) };
  };
  /** The largest threshold this region survives with nothing severed: its narrowest neck. */
  const narrowest = (r: ReturnType<typeof build>['tiles']): number => {
    let lo = 0.05, hi = 8;
    for (let i = 0; i < 22; i++) {
      const mid = (lo + hi) / 2;
      const a = analyzeThin(r, mid);
      if (a.necks || a.vanishing) hi = mid; else lo = mid;
    }
    return lo;
  };

  it('makes both sheets one decal, but only with a spanning tree of bridges', () => {
    // This is the whole reason `cornerBridges` is called with spanning=true and the choice is
    // not offered. The two sheets are exact complements, so a tree of bridges -- which does
    // not separate the plane -- leaves the ground in one piece. Close the 18 cycles and each
    // one encircles a ground square and cuts it loose: 1 + 18 = 19.
    const tree = build(0.6, 3.2, true);
    expect(tree.tiles).toHaveLength(1);
    expect(tree.ground).toHaveLength(1);

    const all = build(0.6, 3.2, false);
    expect(all.tiles).toHaveLength(1);
    expect(all.ground).toHaveLength(19);
  });

  it('narrows the bridged sheet to sqrt(2)*(width/2 - inset)', () => {
    for (const [inset, width] of [[0.4, 2.8], [0.6, 3.2], [0.8, 4.0]] as const) {
      const predicted = Math.SQRT2 * (width / 2 - inset);
      expect(narrowest(build(inset, width, true).tiles), `${inset}/${width}`).toBeCloseTo(predicted, 1);
    }
  });

  it('narrows the continuous sheet to 2*sqrt(2)*inset, whatever the bridges do', () => {
    // The bridges never weaken the ground: its minimum is set by the 18 corner junctions
    // they do not touch, so it depends on the inset alone. That decoupling is what makes the
    // two settings tunable independently.
    for (const inset of [0.4, 0.6, 0.8]) {
      for (const width of [2.4, 4.0]) {
        expect(narrowest(build(inset, width, true).ground), `${inset}/${width}`).toBeCloseTo(2 * Math.SQRT2 * inset, 1);
      }
    }
  });
});

describe('validate', () => {
  it('calls a thin bar a vanishing component, not a neck', () => {
    const a = analyzeThin(rect(0, 0, 30, 0.5), 1);
    expect(a.vanishing).toBe(1);
    expect(a.necks).toBe(0);
  });

  it('calls a pinched dumbbell a neck', () => {
    const a = analyzeThin(union(rect(0, 0, 10, 10), rect(10, 4.7, 12, 5.3), rect(12, 0, 22, 10)), 1);
    expect(a.necks).toBe(1);
  });

  it('does not report a thin protrusion attached to bulk material', () => {
    // A tab sticking out of a solid block is thin, but nothing breaks if it tears.
    const a = analyzeThin(union(rect(0, 0, 20, 20), rect(20, 9.7, 24, 10.3)), 1);
    expect(a.necks).toBe(0);
    expect(a.vanishing).toBe(0);
  });

  it('warns when the design will not fit the mat', () => {
    const c = compose(START, { ...DEFAULTS, squareSize: 40 });
    const r = validate(c, 1, 292.1);
    expect(r.fitsMat).toBe(false);
    expect(r.warnings.join(' ')).toMatch(/does not fit/);
  });

  it('passes the shipped defaults cleanly, on the default position and the start position', () => {
    for (const board of [KUBBEL, START]) {
      const r = validate(compose(board, DEFAULTS), 1, 292.1);
      expect(r.necks).toBe(0);
      expect(r.vanishing).toBe(0);
      expect(r.fitsMat).toBe(true);
      expect(r.warnings).toEqual([]);
    }
  });

  it('reports the Kubbel study as 58 decals across the four sheets', () => {
    const r = validate(compose(KUBBEL, DEFAULTS), 1, 292.1);
    // light  = 32 grouted tiles, plus 2 eye islands under each of the 2 kings (both stand on
    //          light squares) = 32 + 4
    // dark   = the ground, plus the knight's 1 eye island = 1 + 1
    // white  = K N B P P (2+2+2+3+3), black = k p p (2+3+3)
    expect(r.layers.map((l) => l.decals)).toEqual([36, 2, 12, 8]);
    expect(r.totalDecals).toBe(58);
  });

  it('costs 31 decals to keep the corners of the ground clean', () => {
    // Interlock is one decal on the tile sheet instead of 32, and the whole price is that a
    // bridge shows as a tile-colored square between the corners of two ground squares.
    const grout = validate(compose(KUBBEL, DEFAULTS), 1, 292.1);
    const inter = validate(compose(KUBBEL, { ...DEFAULTS, connect: 'interlock' }), 1, 292.1);
    expect(grout.layers[0]!.decals - inter.layers[0]!.decals).toBe(31);
  });

  it('names the sheet a warning belongs to', () => {
    // A minimum feature wider than the ground's 2*sqrt(2)*0.3 = 0.85 mm severs the dark
    // sheet and nothing else. 18, not 31, because the frame is part of this sheet and holds
    // the 14 dark squares on the board's perimeter: only the interior ones come away.
    const r = validate(compose(KUBBEL, { ...DEFAULTS, groutInset: 0.3 }), 1.5, 292.1);
    expect(r.warnings.join(' ')).toMatch(/^Dark squares: 18 thin necks/);
    expect(r.layers.find((l) => l.id === 'dark')!.necks).toBe(18);
  });

  it('severs all 31 when there is no frame to hold the edge squares', () => {
    const r = validate(compose(KUBBEL, { ...DEFAULTS, groutInset: 0.3, frameWidth: 0 }), 1.5, 292.1);
    expect(r.layers.find((l) => l.id === 'dark')!.necks).toBe(31);
  });

  it('keeps every glyph free of necks at the default square size', () => {
    const L = makeLayout(DEFAULTS.squareSize, 0);
    for (const type of Object.keys(SILHOUETTES) as (keyof typeof SILHOUETTES)[]) {
      const a = analyzeThin(placeGlyph(L, type, 0, 0, DEFAULTS.pieceScale), 1);
      expect(a.necks, type).toBe(0);
      expect(a.vanishing, type).toBe(0);
    }
  });
});

describe('dxf', () => {
  /** Minimal group-code reader, so the test checks the bytes rather than trusting a library. */
  function groups(dxf: string): [number, string][] {
    const lines = dxf.split('\n');
    const out: [number, string][] = [];
    for (let i = 0; i + 1 < lines.length; i += 2) out.push([Number(lines[i]), lines[i + 1]!]);
    return out;
  }

  function readPolylines(dxf: string): { closed: boolean; pts: [number, number][] }[] {
    const g = groups(dxf);
    const polys: { closed: boolean; pts: [number, number][] }[] = [];
    let cur: { closed: boolean; pts: [number, number][] } | null = null;
    let pendingX: number | null = null;
    let inVertex = false;
    for (const [code, value] of g) {
      if (code === 0) {
        if (value === 'POLYLINE') {
          cur = { closed: false, pts: [] };
          inVertex = false;
        } else if (value === 'VERTEX') {
          inVertex = true;
        } else if (value === 'SEQEND') {
          if (cur) polys.push(cur);
          cur = null;
          inVertex = false;
        }
      } else if (cur && code === 70 && !inVertex) {
        cur.closed = Number(value) === 1;
      } else if (cur && inVertex && code === 10) {
        pendingX = Number(value);
      } else if (cur && inVertex && code === 20 && pendingX !== null) {
        cur.pts.push([pendingX, Number(value)]);
        pendingX = null;
      }
    }
    return polys;
  }

  it('writes the R12 dialect that Silhouette Studio accepts', () => {
    const dxf = calibrationSquareDxf(100);
    expect(dxf).toContain('0\nSECTION\n2\nHEADER\n');
    expect(dxf).toContain('$ACADVER\n1\nAC1009\n');
    expect(dxf).toContain('$INSUNITS\n70\n4\n'); // millimeters
    expect(dxf).toContain('$MEASUREMENT\n70\n1\n');
    expect(dxf).toContain('0\nTABLE\n2\nLAYER\n');
    expect(dxf).toContain('0\nLAYER\n2\n0\n');
    expect(dxf.endsWith('0\nENDSEC\n0\nEOF\n')).toBe(true);
    // Nothing a cutter import is likely to choke on.
    for (const bad of ['SPLINE', 'ELLIPSE', 'INSERT', 'BLOCK', 'ARC\n']) expect(dxf).not.toContain(bad);
  });

  it('round-trips a calibration square at exactly 100 mm', () => {
    const polys = readPolylines(calibrationSquareDxf(100));
    expect(polys).toHaveLength(1);
    expect(polys[0]!.closed).toBe(true);
    expect(polys[0]!.pts).toHaveLength(4);
    const xs = polys[0]!.pts.map((p) => p[0]);
    const ys = polys[0]!.pts.map((p) => p[1]);
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(100, 6);
    expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(100, 6);
  });

  it('emits every ring of every component, closed, plus the weeding box', () => {
    const c = compose(START, DEFAULTS);
    for (const l of c.layers) {
      const rings = l.region.reduce((a, p) => a + 1 + p.holes.length, 0);
      const polys = readPolylines(toDxf(l.region, { extraRings: c.weedRing ? [c.weedRing] : [] }));
      expect(polys, l.name).toHaveLength(rings + 1);
      expect(polys.every((p) => p.closed), l.name).toBe(true);
      expect(polys.every((p) => p.pts.length >= 3), l.name).toBe(true);
    }
  });

  it('declares extents that actually contain the geometry', () => {
    const c = compose(START, DEFAULTS);
    const top = sheet(c, 'black');
    const dxf = toDxf(top);
    const b = bbox(top);
    const min = dxf.match(/\$EXTMIN\n10\n([-\d.]+)\n20\n([-\d.]+)/)!;
    const max = dxf.match(/\$EXTMAX\n10\n([-\d.]+)\n20\n([-\d.]+)/)!;
    expect(Number(min[1])).toBeCloseTo(b.x0, 4);
    expect(Number(min[2])).toBeCloseTo(b.y0, 4);
    expect(Number(max[1])).toBeCloseTo(b.x1, 4);
    expect(Number(max[2])).toBeCloseTo(b.y1, 4);
  });

  it('can emit R2000 lwpolylines instead', () => {
    const dxf = toDxf(rect(0, 0, 10, 10), { lwpolyline: true });
    expect(dxf).toContain('AC1015');
    expect(dxf).toContain('LWPOLYLINE');
    expect(dxf).toContain('90\n4\n70\n1\n');
  });
});
