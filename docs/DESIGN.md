# Design Notes

What the code does and why, including the things that only became apparent once it ran.
`README.md` covers the user-facing side; this is the record of the decisions.

## Shape of the Program

One geometry pipeline, two renderers. The SVG preview and the DXF writer consume the same
`Region`, so the preview *is* the cut file rather than a second drawing of it that can drift.

```
src/core/
  types.ts       Pt / Ring / Poly / Region -- millimeters, y up, holes explicit
  geom.ts        areas, lengths, bounding boxes, affine maps (no boolean ops)
  clip.ts        the only file that knows about Clipper
  fen.ts         rule-free FEN parser
  glyphs.gen.ts  GENERATED: solid silhouettes in a 1000x1000 box
  board.ts       squares, grout, bridges, frame, weeding box
  compose.ts     the four sheets
  validate.ts    minimum feature width, neck detection, decal counting, per sheet
  dxf.ts         R12 writer
  svg.ts         preview renderer, layers painted bottom-first
scripts/
  build-glyphs.ts  chess.otf -> glyphs.gen.ts, including the two repairs
  build-icons.ts   app icon, drawn from the same glyph data
```

`Region.length` is the number of separate decals the carrier sheet has to carry, which is why the
representation keeps components explicit instead of flattening to a soup of contours.

## Why Four Sheets

The one-sheet design had a structural flaw that no amount of tuning fixes. Writing C for the
vinyl being cut and S for the surface behind it, a piece on a square is one of four cases, and
the S-piece-on-S-square case has nothing to draw but an **outline**: a closed ring about a
millimeter wide with nothing holding it. It cuts fine and then fails at the weeding table.

Everything else in that design existed to service the other three cases: a clearance gap so a
C-piece did not vanish into a C-square, a scrap filter for the flecks the gap detached, a ring
thickness that had to be kept above the minimum feature width. All of it is gone. With four
colors every shape is solid.

## No Stacking

The first four-sheet version stacked: a solid light rectangle under everything, the dark sheet's
grout lattice reaching into every light square, pieces simply laid on top. Overlap was the
*point*: it meant a fraction of a millimeter of misregistration showed as overlap rather than
as a bare seam.

That is right for adhesive vinyl and wrong for **heat transfer vinyl**, which bonds to fabric
and not to itself. A sheet laid over another sheet does not stick. So there is no free overlap
anywhere, and the layout is a partition:

```
tiles   = one color's squares, shrunk by `groutInset`, bridged into one piece
ground  = boardOuter - tiles          <- picks up the frame and the lattice for free
light   = (ground or tiles) - knockout
dark    = (tiles or ground) - knockout
knockout = every piece silhouette, dilated by `gap`
```

Defining the ground as the literal complement is what makes this robust: there is no second
place where the boundary between the two square sheets is computed, so there is nothing to
drift. `compose` is shorter than the stacked version was.

**`gap` is the only tolerance in the design.** Positive leaves bare fabric around every piece;
zero butts exactly; negative overlaps, which is wrong here but correct for adhesive vinyl, so
the slider allows it.

**Piece counters fall out of the knockout for free.** Dilating a region shrinks its holes, so
the king's two eyes and the knight's one survive as islands of square color, inset from the
piece by exactly `gap`. That is what the drawing means, and it guarantees the counters contrast
with the piece: a fabric-colored eye would vanish on a white king on a white shirt. It also
forced `minScrapArea` down to 2 mm²: the knight's eye is 3.84 mm² and the king's are 39.52,
so the old 4 mm² floor dropped his and kept theirs, which looks exactly like a bug.

**The weeding box is the registration scheme.** It is cut identically into all four sheets, so
lining up four rectangles lines up everything inside them. That is why `compose` shifts every
sheet by the same `weedMargin` rather than each by its own bounding box. Since nothing overlaps,
the sheets can be pressed in any order.

A test intersects all six pairs of sheets and asserts zero shared area, because everything else
rests on that property.

## Why the Tiles Stay Loose

With no overlap, only one square sheet can be the continuous ground; the other gets what is
left, which is 32 separate tiles. Bridging them diagonally makes that one decal, and it was
briefly the default. It should not be, and the reason is not structural.

Two squares of one color meet at a corner at exactly zero width. So *any* connector between
them, of any shape and any positive width, must intrude on the two squares of the other color
that meet at the same point. That was already in these notes as the reason a corner bridge
"necessarily takes a matching bite out of the two substrate-colored squares", back when the bite
was invisible under an overlapping sheet. Once the sheets tile, the bite is the finished
artwork: a tile-colored square sitting between the corners of two ground squares, at 31 of the
49 interior vertices, about as wide as the grout gap. A diagonal strip instead of an
axis-aligned square shrinks the intrusion by roughly 5x in area but never removes it.

And the decal count it saves is worth less than it looks. The negative space you weed is
identical either way. The tiles being separate only matters if something has to hold them in
register, and heat transfer vinyl arrives on a tacky carrier sheet that does precisely that.
Interlock was solving a transfer-tape problem that this material does not have. It stays as an
option because adhesive vinyl does have it: the same users who want a negative `gap`.

A test probes a disc at each of the 49 interior vertices and asserts the ground owns every one.

## Bridges Must Form a Tree

Bridging works only if the bridges form a **spanning tree**: 31 of the 49 interior vertices.

The argument is topological. The two sheets are exact complements, so the ground is connected
iff the tile sheet does not separate the rectangle. A tree is simply connected and does not
separate the plane; add any of the 18 edges that close a cycle and the cycle encircles a ground
square and cuts it loose. Measured: 31 bridges give 1 decal and 1 decal; 49 give 1 and **19**,
which is 1 + 18 exactly. `cornerBridges` already had the union-find for the spanning set, built
for a different reason; here it is load-bearing rather than an option, so the choice is not
exposed.

Two formulas govern the widths, both confirmed at three insets and six bridge widths:

| sheet | narrowest point | at the defaults |
|---|---|---|
| ground | `2*sqrt(2)*inset` | 1.72 mm |
| tiles | `sqrt(2)*(bridgeWidth/2 - inset)` | 1.45 mm |

The surprise is that the ground's minimum does **not** depend on the bridge width at all, right
up to 5 mm bridges. A bridge removes material at the vertex it occupies, but the ground's
narrowest points are the 18 corner junctions the bridges do not touch. So the two settings are
independent, which is why they can both have sliders without one silently ruining the other.

The cost of all this is decal count. The starting position is 125 and Kubbel 1922 is 58, of
which 36 are the light tiles and most of the rest are pieces: these glyphs are drawn as separate
solids, so a pawn is a disc, a mound and a base arc. The report bar breaks the count down per
sheet so the number is never a surprise.

## Library Choices

**`clipper-lib`** (pure JS Clipper 6) behind a one-file adapter. Offsetting is not optional (grout,
blade compensation, glyph repair and the whole minimum-feature check are all offsets), which
rules out boolean-only libraries such as `polygon-clipping`. The pure-JS port was preferred over
a WASM build because the workload is tiny and an offline PWA does not need a `.wasm` in its
precache. Swapping to Clipper2 later means rewriting `clip.ts` and nothing else.

**`opentype.js`**, build-time only, to read the CFF outlines out of the font. The app ships
`glyphs.gen.ts` and never touches a font at runtime.

**No `chess.js`.** It rejects positions a diagram tool has to accept: no kings, nine pawns, two
dark-squared bishops. A 60-line parser with no rules is the correct dependency.

Integer scale is 1e4 (0.1 um). Design coordinates stay under ~310 mm, so integers stay under
3.1e6, far inside Clipper's safe range and far finer than any drag knife resolves.

## Deriving the Silhouettes

The **Chess** font by James Kilfiger, public domain by its own copyright string. It draws each
piece twice: `P N B R Q K` are outline forms and `p n b r q k` are solid. **Only the solid forms
are used**: an outline form would cut as two hairline contours a fifth of a millimeter apart.
Both piece colors come from the same silhouette and are told apart by the sheet they are cut
from, which is the entire point of a four-sheet build.

All six glyphs share one transform, computed from the box that encloses every piece
(102..898 x 0..760 font units), so their relative sizes are the ones the font was drawn with.
Normalizing each glyph on its own would make the pawn as tall as the king.

### Four Changes in `build-glyphs.ts`

**The queen's crown balls** are four free-standing circles clearing the spike tips by about 27
font units. A printed diagram bridges that gap with the outline stroke; a filled silhouette does
not, so unrepaired the queen is a crown plus four loose 4 mm discs. Each is welded with a
tapered stem, and the shape of that stem took three attempts:

1. The convex hull of the disc and the nearest outline point tapers to nothing exactly where it
   meets a needle-sharp spike. The join is pinched to zero width.
2. A trapezoid pushed a fixed distance past that point is wide enough in itself, but the spikes
   stay under a millimeter for another 150 units below the tip, so the weld just moves the tear
   further down the spike. This one looked right and measured wrong: 1.0 mm, not the 2.3 mm the
   trapezoid's own width suggested.
3. Anchor the far end in the spike's **erosion**. Eroding by half the stem width leaves exactly
   the material already at least that wide, so running the stem to the nearest point of *that*
   guarantees no cross-section anywhere between ball and crown is narrower than the stem.

**The ball on the king's cross** is attached, but by a stem measuring 1.07 mm on a 33 mm square,
three times narrower than the worst neck in any other piece, and under a millimeter as soon as
the squares drop below 31 mm, which is inside the slider's range. `thickenNecks` widens it.

Finding it required separating necks from protrusions in the opening residue, which is mostly
harmless: the sharp horns of every base crescent are thin but hang off solid material. A residue
fragment is a neck iff it touches **two** components of the opening, and it has to be probed
against the *opening*, not the eroded core, which sits another half-width further in and touches
nothing. The dilation is then bisected rather than applied flat: this is somebody's drawing, and
the right amount to change it is the least that works. It came out at 10.7 units.

**The ball on the king's finial becomes a cross.** This one is a preference, not a defect: the
author left the orb plain on purpose, and a chess king normally wears a cross. It is the only
change here that alters the drawing rather than making it cuttable.

The ball is located rather than hard-coded, by the same trick the queen uses in reverse. It
hangs off a stem far narrower than itself, so an erosion deep enough to pinch the stem through
leaves the ball as a free-standing fragment, and it is the topmost one. Where to cut and how
far to bury the new stem are both measured off that fragment.

The arms are drawn at the full bar width rather than at the stem's original 30 units. Narrow
arms would survive the cut perfectly well (an arm is a protrusion, attached along its whole
root, not a neck, which is exactly the distinction `analyzeThin` exists to make), but a 1.1 mm
arm meeting a 1.8 mm stem looks like a mistake rather than a choice. The cross is also
*stronger* than what it replaced, because its vertical bar runs deep inside the crown where the
old stem was a stalk hanging off the top.

**Every sharp outside corner gets a 0.34 mm radius**, applied last so it also takes the corners
off the cross. Opening *is* the operation: it is the union of every disc of that radius that
fits inside the glyph, so it rounds outside corners by exactly the radius and leaves inside
ones alone. A fillet at a convex corner is the same circle, which is why a targeted
corner-by-corner fillet would be more code for the same answer.

Rounding a cusp necessarily shortens it: a fillet of radius r at a wedge cuts back
r/tan(half-angle), which is a long way when the wedge is shallow. So the radius is small and
the crescents lose about a millimeter end to end. Past about 22 units the pawn's mound stops
being a crescent and becomes a lozenge. At 12 it removes every delicate-feature flag the
checker used to raise on these glyphs, which is the tell that those flags were all cusps.

One trap here: `clip.ts` rounds arcs to 0.02 of whatever unit it is handed and documents that
as millimeters, but this script works in font units, where 0.02 is 0.0007 mm. The opening came
back with a vertex every fraction of a degree and tripled the size of `glyphs.gen.ts`. The fix
is to simplify afterwards to the chord error the rest of the app actually uses.

Result, at a 33 mm square and 0.86 piece scale, narrowest neck per piece:

| p | n | b | r | q | k |
|---|---|---|---|---|---|
| 3.15 mm | 4.18 mm | 4.18 mm | 4.18 mm | 4.18 mm | 2.58 mm |

The king is still the binding constraint, but he reaches 1 mm at a 12.8 mm square, against
30.8 mm for the unrepaired stem, and 18.2 mm for the thickened one. Comfortably outside the
useful range in every case, and at the shipped defaults no piece raises a flag of any kind.

### The Hole-Winding Bug

Font contours are resolved by a non-zero fill rule, and `union` cannot do that: it takes `Poly`
values, where nesting is already decided, and forces every outer counter-clockwise. Handing it a
glyph's contours as separate one-ring components reverses the holes and fills them in. The
symptom was silent and specific: the king lost both eyes and the knight lost his. `clip.ts`
grew `fromRings` for anything that starts life as raw contours.

## Tuning

**Grout narrows to `2*sqrt(2)*inset`.** Two diagonally adjacent holes each stop `inset` short of
the shared corner in both axes, so the material between them measures `2*sqrt(2)*inset` across;
everywhere else the lattice is backed by a whole square. At the 0.6 mm default that is 1.70 mm,
comfortably above a 1 mm minimum feature. The test asserts the relationship at three insets
rather than hard-coding one number.

**Corner bridges need about 1.2 mm** to clear a 1 mm threshold, against grout's 0.6 mm setting
for a 1.7 mm neck, because a bridge carries load through a single point. The default is 1.4 mm,
and grout remains the default mode.

**The frame changes what a severed lattice costs.** It is part of the dark sheet, so it holds
the 14 dark squares on the board's perimeter. Under-width grout therefore orphans 18 squares,
not 31. Both numbers are asserted.

**`pieceScale` defaults to 0.86.** At 1.0 a piece is exactly as wide as its square, which is
honest but leaves nothing of the square around it once the knockout has taken its `gap`. At
0.86 the thinnest ring of square color left around a piece is about 1.5 mm, on a tile square
where the grout has already taken 0.6 mm. Push the scale much past 0.9 and the checker starts
reporting severed tiles, which is the correct answer rather than a limit worth hard-coding.

## The Bug Worth Remembering

The minimum-feature check originally used a morphological opening with **miterd** joins, chosen
so that square corners came back exactly instead of being reported as defects. But erode-then-
dilate with miterd joins is *exactly invertible* for any rectilinear shape. The grout lattice is
rectilinear, so the check reconstructed every connection it had just severed and reported a
lattice cut into 32 pieces as perfectly sound.

Connectivity is now judged on the **erosion** alone, which is the question actually being asked,
and joins are round, which is what "opening" means: sweeping a disc through the shape. The
convex-corner slivers that motivated mitring are about 0.05 mm², far below the 0.25 mm² noise
floor, so they never mattered. There is a regression test.

## Deferred

- **Welding a piece's own parts together.** A pawn is three decals because the font draws a
  disc, a mound and a base arc with gaps between them; the gaps are the drawing. Bridging them
  would cut the starting position from 86 decals to about 32, at the cost of altering every
  piece. Not the same thing as welding pieces to the board, which was explicitly declined.
- **Coordinate labels** (a–h, 1–8). Every glyph is another loose decal, and the counters in
  `a b d e g o p q` make them fragile.
- **Nesting several boards on one mat.**
- **Letting the fabric be the light squares.** On a garment already the right color, the light
  sheet is redundant: three sheets, one less press, and 31 fewer bridges to weed. Not built
  because four sheets is what was asked for, but it is a two-line change to `compose`.
