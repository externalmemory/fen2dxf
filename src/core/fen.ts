/**
 * A deliberately rule-free FEN board parser.
 *
 * chess.js and friends reject positions a *diagram* tool must accept: no kings, nine pawns,
 * two dark-squared bishops, a pawn on the first rank. None of that is our business -- we are
 * drawing a picture, not validating a game. Only the board field is read; side to move,
 * castling, en passant and the clocks are parsed off and ignored.
 */
export type PieceType = 'p' | 'n' | 'b' | 'r' | 'q' | 'k';
export type PieceColor = 'w' | 'b';
export type Piece = { readonly type: PieceType; readonly color: PieceColor };

/** 64 squares, index = rank * 8 + file, where rank 0 is rank "1" and file 0 is file "a". */
export type Board = readonly (Piece | null)[];

export const EMPTY_BOARD: Board = Object.freeze(new Array(64).fill(null));

export const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

/**
 * Leonid Kubbel, *Schachmatny Listok* 1922. White to move and win: 1.Nc6!! blocks the
 * a-pawn, and after Kxc6 2.Bf6 Kd5 3.d3 a2 4.c4+ Kc5 5.Kb7! a1=Q 6.Be7 is mate. Eight men,
 * every one of them doing something -- a better default than the start position, which is a
 * wall of thirty-two pieces that says nothing about the board underneath it.
 */
export const DEFAULT_FEN = '1N6/8/K7/3k4/3p3B/p7/2PP4/8 w - - 0 1';

/**
 * Richard Reti, *Kagans Neueste Schachnachrichten* 1921. White to move and draw: the king
 * looks hopelessly outside the square of the h-pawn and too far from his own, and draws by
 * heading for both at once. 1.Kg7! h4 2.Kf6 Kb6 3.Ke5! Kxc6 4.Kf4 and the pawn is caught.
 * Four men, which makes it the cheapest thing this app can cut.
 */
export const RETI_FEN = '7K/8/k1P5/7p/8/8/8/8 w - - 0 1';

const TYPES = 'pnbrqk';

export function idx(file: number, rank: number): number {
  return rank * 8 + file;
}

/** True for the light-colored square. a1 (file 0, rank 0) is dark, h1 is light. */
export function isLightSquare(file: number, rank: number): boolean {
  return (file + rank) % 2 === 1;
}

export function squareName(file: number, rank: number): string {
  return String.fromCharCode(97 + file) + String(rank + 1);
}

export type ParseResult = { ok: true; board: Board } | { ok: false; error: string };

export function parseFen(fen: string): ParseResult {
  const trimmed = fen.trim();
  if (!trimmed) return { ok: false, error: 'Empty FEN' };
  const placement = trimmed.split(/\s+/)[0]!;
  const rows = placement.split('/');
  if (rows.length !== 8) return { ok: false, error: `Expected 8 ranks separated by "/", got ${rows.length}` };

  const board: (Piece | null)[] = new Array(64).fill(null);
  for (let r = 0; r < 8; r++) {
    // FEN lists rank 8 first, so row r describes rank 8-r, i.e. rank index 7-r.
    const rank = 7 - r;
    const row = rows[r]!;
    let file = 0;
    for (const ch of row) {
      if (ch >= '1' && ch <= '8') {
        file += ch.charCodeAt(0) - 48;
      } else {
        const lower = ch.toLowerCase() as PieceType;
        if (!TYPES.includes(lower)) {
          return { ok: false, error: `Rank ${rank + 1}: unexpected character "${ch}"` };
        }
        if (file > 7) return { ok: false, error: `Rank ${rank + 1} describes more than 8 squares` };
        board[idx(file, rank)] = { type: lower, color: ch === lower ? 'b' : 'w' };
        file += 1;
      }
    }
    if (file !== 8) return { ok: false, error: `Rank ${rank + 1} describes ${file} squares, expected 8` };
  }
  return { ok: true, board };
}

export function toFen(board: Board): string {
  const rows: string[] = [];
  for (let rank = 7; rank >= 0; rank--) {
    let row = '';
    let gap = 0;
    for (let file = 0; file < 8; file++) {
      const piece = board[idx(file, rank)];
      if (!piece) {
        gap += 1;
        continue;
      }
      if (gap) {
        row += String(gap);
        gap = 0;
      }
      row += piece.color === 'w' ? piece.type.toUpperCase() : piece.type;
    }
    if (gap) row += String(gap);
    rows.push(row);
  }
  return rows.join('/');
}

/** Board seen from Black's side: rank 1 at the top, file h on the left. */
export function flipBoard(board: Board): Board {
  return board.map((_, i) => board[63 - i]!);
}
