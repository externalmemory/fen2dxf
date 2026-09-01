// Minimal hand-written typings for clipper-lib (the JS port of Clipper 6.4.2), which ships
// no types of its own. Only the surface src/core/clip.ts actually uses is declared.
// It is a CommonJS module whose named exports are not statically analysable, so it must be
// consumed as a default import -- hence `export =` over a namespace.
declare module 'clipper-lib' {
  namespace ClipperLib {
    interface IntPoint {
      X: number;
      Y: number;
    }
    type Path = IntPoint[];
    type Paths = Path[];

    const ClipType: { ctIntersection: 0; ctUnion: 1; ctDifference: 2; ctXor: 3 };
    const PolyType: { ptSubject: 0; ptClip: 1 };
    const PolyFillType: { pftEvenOdd: 0; pftNonZero: 1; pftPositive: 2; pftNegative: 3 };
    const JoinType: { jtSquare: 0; jtRound: 1; jtMiter: 2 };
    const EndType: { etOpenSquare: 0; etOpenRound: 1; etOpenButt: 2; etClosedLine: 3; etClosedPolygon: 4 };

    class PolyNode {
      m_polygon: Path;
      Childs(): PolyNode[];
      IsHole(): boolean;
    }
    class PolyTree extends PolyNode {
      Clear(): void;
    }
    class Clipper {
      constructor(initOptions?: number);
      AddPath(path: Path, polyType: number, closed: boolean): boolean;
      AddPaths(paths: Paths, polyType: number, closed: boolean): boolean;
      Execute(clipType: number, solution: PolyTree | Paths, subjFillType?: number, clipFillType?: number): boolean;
      static Area(path: Path): number;
      static Orientation(path: Path): boolean;
      static CleanPolygons(paths: Paths, distance?: number): Paths;
      static SimplifyPolygons(paths: Paths, fillType?: number): Paths;
    }
    class ClipperOffset {
      constructor(miterLimit?: number, arcTolerance?: number);
      Clear(): void;
      AddPath(path: Path, joinType: number, endType: number): void;
      AddPaths(paths: Paths, joinType: number, endType: number): void;
      Execute(solution: PolyTree | Paths, delta: number): void;
    }
  }
  export = ClipperLib;
}
