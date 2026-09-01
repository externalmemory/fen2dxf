/**
 * Hand-written typings for the slice of opentype.js the glyph builder uses.
 *
 * The published `@types/opentype.js` is still on 1.3 while the installed package is 2.x,
 * and the surface used here is four members wide. Declaring those four is more honest than
 * pulling in a version-skewed definition and trusting it.
 *
 * Build-time only: nothing in `src/` imports this module.
 */
declare module 'opentype.js' {
  /** One drawing command. Only the fields valid for `type` are populated. */
  export type PathCommand =
    | { type: 'M'; x: number; y: number }
    | { type: 'L'; x: number; y: number }
    | { type: 'C'; x1: number; y1: number; x2: number; y2: number; x: number; y: number }
    | { type: 'Q'; x1: number; y1: number; x: number; y: number }
    | { type: 'Z' };

  export interface Path {
    commands: PathCommand[];
    toPathData(decimals?: number): string;
  }

  export interface Glyph {
    name: string;
    unicode?: number;
    advanceWidth?: number;
    /** Outline placed with its origin at (x, y), scaled so one em is `fontSize` units. */
    getPath(x: number, y: number, fontSize: number): Path;
    getBoundingBox(): { x1: number; y1: number; x2: number; y2: number };
  }

  export interface Font {
    unitsPerEm: number;
    ascender: number;
    descender: number;
    names: Record<string, Record<string, Record<string, string>>>;
    glyphs: { length: number; get(index: number): Glyph };
    charToGlyph(ch: string): Glyph;
  }

  export function parse(buffer: ArrayBuffer, options?: unknown): Font;

  const opentype: { parse: typeof parse };
  export default opentype;
}
