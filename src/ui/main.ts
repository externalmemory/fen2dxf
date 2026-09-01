import './style.css';
import {
  DEFAULT_FEN, EMPTY_BOARD, RETI_FEN, START_FEN, idx, parseFen, squareName, toFen,
  type Board, type Piece, type PieceColor, type PieceType,
} from '../core/fen.js';
import { compose, DEFAULTS, type Composition, type LayerId, type Settings } from '../core/compose.js';
import { validate, type Report } from '../core/validate.js';
import { toSvg, type SvgLayer } from '../core/svg.js';
import { calibrationSquareDxf, toDxf } from '../core/dxf.js';
import { GLYPH_BOX, SILHOUETTES } from '../core/glyphs.gen.js';

/** Settings plus the knobs that affect checking, preview and export rather than geometry. */
type State = Settings & {
  minFeature: number;
  matMm: number;
  lwpolyline: boolean;
  cutLines: boolean;
  /** Which sheets the preview draws. Export and the report always cover all four. */
  showLight: boolean;
  showDark: boolean;
  showWhite: boolean;
  showBlack: boolean;
};

const DEFAULT_STATE: State = {
  ...DEFAULTS,
  minFeature: 1.0,
  // 11.5 in. The mat is 12 in square but the usable area is smaller; adjust to match
  // whatever your machine actually reaches.
  matMm: 292.1,
  lwpolyline: false,
  cutLines: false,
  showLight: true,
  showDark: true,
  showWhite: true,
  showBlack: true,
};

const STORE_KEY = 'fen2dxf.settings.v4';

let state: State = load();
let board: Board = EMPTY_BOARD;
let brush: Piece | null = { type: 'k', color: 'w' };

function load(): State {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return { ...DEFAULT_STATE };
    // Only keep keys we still recognize, so an old blob cannot resurrect a dead setting.
    const saved = JSON.parse(raw) as Partial<State>;
    const out = { ...DEFAULT_STATE };
    for (const k of Object.keys(DEFAULT_STATE) as (keyof State)[]) {
      if (saved[k] !== undefined && typeof saved[k] === typeof DEFAULT_STATE[k]) (out as never as Record<string, unknown>)[k] = saved[k];
    }
    return out;
  } catch {
    return { ...DEFAULT_STATE };
  }
}

function save(): void {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(state));
  } catch {
    /* private mode, quota, whatever -- the app works fine without persistence */
  }
}

// --- controls ---------------------------------------------------------------

type Base = { group: string; key: keyof State; label: string; hint?: string; when?: () => boolean };
type NumCtrl = Base & { kind: 'num'; min: number; max: number; step: number; unit: string };
type SegCtrl = Base & { kind: 'seg'; options: [string, string][] };
/** `toggle` names the boolean that shows or hides this sheet in the preview. */
type ColorCtrl = Base & { kind: 'color'; toggle?: keyof State };
type Ctrl = NumCtrl | SegCtrl | ColorCtrl;

const CONTROLS: Ctrl[] = [
  { kind: 'color', group: 'grp-vinyl', key: 'colorFabric', label: 'Fabric', hint: 'The garment. Nothing is cut in this color: it is what shows through the gap around every piece and anywhere the four sheets do not reach.' },
  { kind: 'color', group: 'grp-vinyl', key: 'colorLight', label: 'Light squares', toggle: 'showLight' },
  { kind: 'color', group: 'grp-vinyl', key: 'colorDark', label: 'Dark squares', toggle: 'showDark' },
  { kind: 'color', group: 'grp-vinyl', key: 'colorWhite', label: 'White pieces', toggle: 'showWhite' },
  { kind: 'color', group: 'grp-vinyl', key: 'colorBlack', label: 'Black pieces', toggle: 'showBlack' },

  { kind: 'num', group: 'grp-board', key: 'squareSize', label: 'Square size', min: 15, max: 40, step: 0.5, unit: 'mm' },
  { kind: 'num', group: 'grp-board', key: 'frameWidth', label: 'Frame', min: 0, max: 15, step: 0.5, unit: 'mm', hint: 'A border in the dark color, around the board. It also welds the edge squares to something solid.' },
  { kind: 'seg', group: 'grp-board', key: 'ground', label: 'Continuous sheet', options: [['dark', 'Dark'], ['light', 'Light']],
    hint: 'The color that carries the frame, the lattice and its own squares as one decal. The other color gets exactly what is left over: the two sheets tile, they never overlap.' },
  { kind: 'seg', group: 'grp-board', key: 'connect', label: 'Square joins', options: [['grout', 'Grout'], ['interlock', 'Interlock'], ['none', 'Butt']],
    hint: 'Grout shrinks the squares of the tile color so the other color forms one continuous sheet; the tiles stay separate, which costs nothing on HTV because the carrier sheet holds them. Interlock also bridges the tiles diagonally into one decal, but a bridge has to intrude on the corners of the two squares it passes between, so it shows as a tile-colored square at 31 of the corners. Butt meets the squares edge to edge with no gap, which leaves both sheets relying on zero-width corner contacts.' },
  { kind: 'num', group: 'grp-board', key: 'groutInset', label: 'Grout width', min: 0.2, max: 2, step: 0.05, unit: 'mm', when: () => state.connect !== 'none',
    hint: 'How far the squares of the other color are shrunk. The narrowest point of the continuous sheet is 2·√2 times this, at the corner junctions.' },
  { kind: 'num', group: 'grp-board', key: 'bridgeWidth', label: 'Bridge width', min: 1.5, max: 6, step: 0.1, unit: 'mm', when: () => state.connect === 'interlock',
    hint: 'The narrowest point of the bridged sheet is √2·(half this − the grout width), so the two settings pull against each other. Bridges never weaken the continuous sheet: only the 18 unbridged corners set its minimum. Half this is also how far each bridge intrudes into the corner of a square of the other color.' },
  { kind: 'num', group: 'grp-board', key: 'gap', label: 'Gap around pieces', min: -0.5, max: 2, step: 0.05, unit: 'mm',
    hint: 'How far the square sheets are cut back from every piece. Heat transfer vinyl will not stick to itself, so this must not go below zero unless you are using adhesive vinyl, where a small overlap is the safer choice.' },
  { kind: 'num', group: 'grp-board', key: 'pieceScale', label: 'Piece size', min: 0.5, max: 1, step: 0.01, unit: 'x',
    hint: '1.00 makes a piece exactly as wide as its square.' },

  { kind: 'num', group: 'grp-cut', key: 'minFeature', label: 'Minimum feature width', min: 0.4, max: 3, step: 0.1, unit: 'mm',
    hint: 'Anything narrower is highlighted in the preview.' },
  { kind: 'num', group: 'grp-cut', key: 'matMm', label: 'Usable cut area', min: 150, max: 320, step: 0.1, unit: 'mm' },
  { kind: 'num', group: 'grp-cut', key: 'weedMargin', label: 'Weeding box margin', min: 0, max: 25, step: 1, unit: 'mm',
    hint: 'A rectangle cut outside the artwork on every sheet, so the waste peels off in one pull, and so the four sheets have a shared edge to line up against. 0 turns it off.' },
  { kind: 'num', group: 'grp-cut', key: 'minScrapArea', label: 'Discard fragments under', min: 0, max: 60, step: 1, unit: 'mm²',
    hint: 'Drops detached flecks too small to be worth positioning by hand.' },
  { kind: 'num', group: 'grp-cut', key: 'minHoleArea', label: 'Fill holes under', min: 0, max: 5, step: 0.1, unit: 'mm²' },
  { kind: 'num', group: 'grp-cut', key: 'grow', label: 'Blade compensation', min: -0.3, max: 0.3, step: 0.01, unit: 'mm',
    hint: 'Grows or shrinks every contour, to correct a blade that consistently over- or under-cuts.' },
  { kind: 'seg', group: 'grp-cut', key: 'cutLines', label: 'Draw as', options: [['false', 'Finished vinyl'], ['true', 'Cut lines']] },
  { kind: 'seg', group: 'grp-cut', key: 'lwpolyline', label: 'DXF flavor', options: [['false', 'R12 polyline'], ['true', 'R2000 lwpolyline']],
    hint: 'R12 is the safer choice and the one verified against the reference file.' },
];

const el = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const decimals = (step: number): number => (String(step).split('.')[1] ?? '').length;
const setState = (k: keyof State, v: unknown): void => { (state as never as Record<string, unknown>)[k as string] = v; };

function buildControls(): void {
  for (const c of CONTROLS) {
    const host = el(c.group);
    const wrap = document.createElement('div');
    wrap.dataset['key'] = String(c.key);
    const id = `c-${String(c.key)}`;

    if (c.kind === 'num') {
      wrap.className = 'num';
      const value = state[c.key] as unknown as number;
      wrap.innerHTML =
        `<label for="${id}">${c.label}</label>` +
        `<output id="o-${String(c.key)}">${value.toFixed(decimals(c.step))} ${c.unit}</output>` +
        `<input id="${id}" type="range" min="${c.min}" max="${c.max}" step="${c.step}" value="${value}">` +
        (c.hint ? `<p class="hint">${c.hint}</p>` : '');
      host.append(wrap);
      const input = wrap.querySelector('input')!;
      input.addEventListener('input', () => {
        setState(c.key, Number(input.value));
        el(`o-${String(c.key)}`).textContent = `${Number(input.value).toFixed(decimals(c.step))} ${c.unit}`;
        onChange();
      });
    } else if (c.kind === 'color') {
      wrap.className = 'swatch';
      const tog = c.toggle;
      wrap.innerHTML =
        (tog
          ? `<input id="t-${String(tog)}" type="checkbox"${state[tog] ? ' checked' : ''} title="Show ${c.label.toLowerCase()} in the preview">`
          : '<span></span>') +
        `<input id="${id}" type="color" value="${String(state[c.key])}">` +
        `<label for="${id}">${c.label}</label>` +
        (c.hint ? `<p class="hint">${c.hint}</p>` : '');
      host.append(wrap);
      const swatch = wrap.querySelector<HTMLInputElement>('input[type="color"]')!;
      swatch.addEventListener('input', () => {
        setState(c.key, swatch.value);
        onChange();
      });
      if (tog) {
        const box = wrap.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
        box.addEventListener('change', () => {
          setState(tog, box.checked);
          onChange();
        });
      }
    } else {
      wrap.className = 'field';
      const name = `seg-${String(c.key)}`;
      const current = String(state[c.key]);
      wrap.innerHTML =
        `<span>${c.label}</span><div class="seg">` +
        c.options
          .map(
            ([v, lbl], i) =>
              `<input type="radio" name="${name}" id="${name}-${i}" value="${v}"${v === current ? ' checked' : ''}>` +
              `<label for="${name}-${i}">${lbl}</label>`,
          )
          .join('') +
        `</div>` +
        (c.hint ? `<p class="hint">${c.hint}</p>` : '');
      host.append(wrap);
      for (const input of wrap.querySelectorAll<HTMLInputElement>('input')) {
        input.addEventListener('change', () => {
          const v = input.value;
          setState(c.key, v === 'true' ? true : v === 'false' ? false : v);
          onChange();
        });
      }
    }
  }
}

function refreshControlVisibility(): void {
  for (const c of CONTROLS) {
    if (!c.when) continue;
    const wrap = el(c.group).querySelector<HTMLElement>(`[data-key="${String(c.key)}"]`);
    if (wrap) wrap.hidden = !c.when();
  }
}

// --- palette ----------------------------------------------------------------

function glyphSvg(type: PieceType, color: PieceColor): string {
  return toSvg({
    x0: 0, y0: 0, x1: GLYPH_BOX, y1: GLYPH_BOX,
    background: color === 'w' ? state.colorLight : state.colorDark,
    layers: [{ region: SILHOUETTES[type], fill: color === 'w' ? state.colorWhite : state.colorBlack }],
  });
}

function buildPalette(): void {
  const host = el('palette');
  host.innerHTML = '';
  const types: PieceType[] = ['k', 'q', 'r', 'b', 'n', 'p'];
  const key = (p: Piece | null): string => (p ? (p.color === 'w' ? p.type.toUpperCase() : p.type) : '');
  const make = (piece: Piece | null): HTMLButtonElement => {
    const b = document.createElement('button');
    b.type = 'button';
    if (piece) {
      b.innerHTML = glyphSvg(piece.type, piece.color);
      b.title = `${piece.color === 'w' ? 'White' : 'Black'} ${piece.type}`;
    } else {
      b.innerHTML = '<span class="erase">Erase</span>';
      b.title = 'Remove pieces';
    }
    b.dataset['piece'] = key(piece);
    b.setAttribute('aria-pressed', String(key(piece) === key(brush)));
    b.addEventListener('click', () => {
      brush = piece;
      for (const other of host.querySelectorAll('button')) other.setAttribute('aria-pressed', String(other === b));
    });
    return b;
  };
  for (const t of types) host.append(make({ type: t, color: 'w' }));
  host.append(make(null));
  for (const t of types) host.append(make({ type: t, color: 'b' }));
}

// --- board editing ----------------------------------------------------------

function buildGrid(): void {
  const grid = el('grid');
  for (let r = 7; r >= 0; r--) {
    for (let f = 0; f < 8; f++) {
      const b = document.createElement('button');
      b.type = 'button';
      b.title = squareName(f, r);
      b.setAttribute('aria-label', squareName(f, r));
      const file = f, rank = r;
      b.addEventListener('click', () => {
        const next = board.slice();
        const at = state.flipped ? 63 - idx(file, rank) : idx(file, rank);
        const existing = next[at];
        // Clicking a square that already holds the brush piece clears it, so a single
        // click can both place and undo without switching to the erase tool.
        next[at] = !brush || (existing && existing.type === brush.type && existing.color === brush.color) ? null : brush;
        setBoard(next);
      });
      grid.append(b);
    }
  }
}

/** Put the clickable grid exactly over the board area of the rendered SVG. */
function layoutGrid(): void {
  const svg = document.querySelector<SVGSVGElement>('#svgwrap svg');
  const stage = el('stage');
  const grid = el('grid');
  if (!svg) { grid.style.display = 'none'; return; }
  const s = svg.getBoundingClientRect();
  const p = stage.getBoundingClientRect();
  const vb = svg.viewBox.baseVal;
  if (!vb.width || !vb.height || !s.width) { grid.style.display = 'none'; return; }
  const k = s.width / vb.width;
  const L = lastLayout;
  if (!L) return;
  // Design coordinates are y-up; the SVG mirrors them about the box, so the board's top
  // edge in SVG space is the mirror of its top edge in design space.
  const boardTopSvg = vb.y + vb.height - (L.origin + L.boardSide - vb.y);
  grid.style.display = 'grid';
  grid.style.left = `${s.left - p.left + (L.origin - vb.x) * k}px`;
  grid.style.top = `${s.top - p.top + (boardTopSvg - vb.y) * k}px`;
  grid.style.width = `${L.boardSide * k}px`;
  grid.style.height = `${L.boardSide * k}px`;
}

// --- render -----------------------------------------------------------------

let lastLayout: { origin: number; boardSide: number } | null = null;
let pending = 0;

function setBoard(next: Board): void {
  board = next;
  el<HTMLTextAreaElement>('fen').value = toFen(board);
  el('fenerr').hidden = true;
  syncUrl();
  onChange();
}

function syncUrl(): void {
  history.replaceState(null, '', `#fen=${encodeURIComponent(toFen(board))}`);
}

function onChange(): void {
  save();
  refreshControlVisibility();
  if (pending) cancelAnimationFrame(pending);
  pending = requestAnimationFrame(() => {
    pending = 0;
    render();
  });
}

const SHOWN: Record<LayerId, keyof State> = {
  light: 'showLight', dark: 'showDark', white: 'showWhite', black: 'showBlack',
};
const shown = (id: LayerId): boolean => state[SHOWN[id]] as boolean;

/** The sheets the preview draws, plus a delicate-feature overlay for those same sheets. */
function previewLayers(c: Composition, r: Report): SvgLayer[] {
  const layers: SvgLayer[] = c.layers.filter((l) => shown(l.id)).map((l) => ({ region: l.region, fill: l.color }));
  // Only flag what is on screen -- a warning marker floating over a hidden sheet is a puzzle.
  const thin = r.layers.filter((l) => shown(l.id)).flatMap((l) => l.thin);
  if (thin.length) layers.push({ region: thin, fill: '#ff2d55', opacity: 0.95 });
  return layers;
}

function render(): void {
  const c = compose(board, state);
  const r = validate(c, state.minFeature, state.matMm);
  lastLayout = { origin: c.layout.origin, boardSide: c.layout.boardSide };

  el('svgwrap').innerHTML = toSvg({
    ...c.box,
    background: state.colorFabric,
    layers: previewLayers(c, r),
    cutLines: state.cutLines,
    outlineRings: c.weedRing ? [c.weedRing] : [],
    outlineColor: '#e9edf2',
  });
  layoutGrid();

  const dropped = c.layers.reduce((a, l) => a + l.scrapsDropped, 0);
  const filled = c.layers.reduce((a, l) => a + l.holesFilled, 0);
  el('report').innerHTML =
    `<span>sheet <b>${r.widthMm.toFixed(1)} × ${r.heightMm.toFixed(1)} mm</b></span>` +
    `<span>pieces to weed <b>${r.totalDecals}</b></span>` +
    r.layers.map((l) => `<span class="tally">${l.name.toLowerCase()} <b>${l.decals}</b></span>`).join('') +
    `<span>cut path <b>${(r.totalCutMm / 1000).toFixed(2)} m</b></span>` +
    (dropped || filled ? `<span>removed <b>${dropped}</b> fragment${dropped === 1 ? '' : 's'}, filled <b>${filled}</b> hole${filled === 1 ? '' : 's'}</span>` : '') +
    r.warnings.map((w) => `<span class="msg warn">${w}</span>`).join('') +
    r.notes.map((w) => `<span class="msg note">${w}</span>`).join('');

  buildExports(c, r);
}

function buildExports(c: Composition, r: Report): void {
  const extraRings = c.weedRing ? [c.weedRing] : [];
  const slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const stamp = `${c.layout.squareSize}mm`;

  type Item = { label: string; sub: string; name: string; text: string; type: string; primary?: boolean };
  const items: Item[] = c.layers.map((l, i) => {
    const rep = r.layers[i]!;
    return {
      label: `${i + 1}. ${l.name}`,
      sub: `${rep.decals} piece${rep.decals === 1 ? '' : 's'} to weed · ${(rep.cutLengthMm / 1000).toFixed(2)} m`,
      name: `chess-${i + 1}-${slug(l.name)}-${stamp}.dxf`,
      text: toDxf(l.region, { lwpolyline: state.lwpolyline, extraRings }),
      type: 'application/dxf',
      primary: i === 0,
    };
  });

  items.push({
    label: 'Preview SVG',
    sub: 'all four sheets, in color',
    name: `chess-preview-${stamp}.svg`,
    text: toSvg({ ...c.box, background: state.colorFabric, layers: c.layers.map((l) => ({ region: l.region, fill: l.color })), outlineRings: extraRings }),
    type: 'image/svg+xml',
  });
  items.push({
    label: '100 mm calibration square',
    sub: 'cut once to confirm the scale',
    name: 'calibration-100mm.dxf',
    text: calibrationSquareDxf(100),
    type: 'application/dxf',
  });

  const host = el('exports');
  host.innerHTML = '';
  for (const it of items) {
    const b = document.createElement('button');
    b.type = 'button';
    if (it.primary) b.className = 'primary';
    b.innerHTML = `<span>${it.label}</span><em>${it.sub}</em>`;
    b.addEventListener('click', () => download(it.name, it.text, it.type));
    host.append(b);
  }
}

function download(name: string, text: string, type: string): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// --- wiring -----------------------------------------------------------------

function init(): void {
  buildControls();
  buildPalette();
  buildGrid();

  const fenBox = el<HTMLTextAreaElement>('fen');
  fenBox.addEventListener('input', () => {
    const res = parseFen(fenBox.value);
    const err = el('fenerr');
    if (res.ok) {
      board = res.board;
      err.hidden = true;
      syncUrl();
      onChange();
    } else {
      err.textContent = res.error;
      err.hidden = false;
    }
  });

  const setFen = (fen: string): void => {
    const res = parseFen(fen);
    if (res.ok) setBoard(res.board);
  };
  el('btn-study').addEventListener('click', () => setFen(DEFAULT_FEN));
  el('btn-reti').addEventListener('click', () => setFen(RETI_FEN));
  el('btn-start').addEventListener('click', () => setFen(START_FEN));
  el('btn-clear').addEventListener('click', () => setBoard(EMPTY_BOARD));
  el('btn-flip').addEventListener('click', () => {
    state.flipped = !state.flipped;
    onChange();
  });
  el('btn-copyfen').addEventListener('click', async () => {
    const btn = el('btn-copyfen');
    try {
      await navigator.clipboard.writeText(toFen(board));
      btn.textContent = 'Copied';
    } catch {
      btn.textContent = 'Copy failed';
    }
    setTimeout(() => (btn.textContent = 'Copy FEN'), 1200);
  });

  const hash = new URLSearchParams(location.hash.slice(1));
  const res = parseFen(hash.get('fen') ?? DEFAULT_FEN);
  board = res.ok ? res.board : EMPTY_BOARD;
  fenBox.value = toFen(board);

  addEventListener('resize', layoutGrid);
  new ResizeObserver(layoutGrid).observe(el('stage'));

  refreshControlVisibility();
  render();
}

init();
