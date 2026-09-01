# Piece Artwork

`chess.otf` is the **Chess** font by **James Kilfiger**, version 1.1, built with FontForge
in 2010 and distributed at <https://www.1001fonts.com/chess-font.html>.

Its own `name` table carries the license:

> Created by James Kilfiger with FontForge 2.0 (http://fontforge.sf.net)
> Dedicated to Public domain

So nothing this app exports is encumbered. That is a deliberate improvement on the previous
artwork, the Cburnett SVGs, which are CC BY-SA 3.0: a share-alike license propagates into
every DXF the app writes, which is a strange thing to hand somebody who just wanted to cut a
chessboard.

## What Is Used

The font draws each piece twice. `P N B R Q K` are outline forms, for white pieces on a
printed diagram; `p n b r q k` are solid forms, for black. **Only the solid forms are used.**
A cutter has no notion of fill, so an outline form would come out as two hairline contours a
fifth of a millimeter apart, which cannot be weeded. Both piece colors are therefore cut
from the same solid silhouette and told apart by the color of the sheet.

The `U+E040`–`U+E05C` range holds board-square variants with the piece composited onto a
light or dark background. Those are unused too: this app builds its own squares, because it
needs the grout lattice that keeps them in one piece.

## Changes

`scripts/build-glyphs.ts` makes four changes, all recorded there in full. The first two are
repairs, the third is a preference, the fourth is for the machine.

1. **The queen's four crown balls** are drawn as free-standing circles clearing the spike
   tips by about 27 font units. On a printed diagram the outline stroke bridges that gap;
   in a filled silhouette nothing does, so they would cut as four loose 4 mm discs. Each is
   welded to its spike with a tapered stem anchored in the spike's *erosion*, so no
   cross-section along the join is narrower than the stem itself.

2. **The ball on the king's cross** is attached, but by a stem that measures 1.07 mm on a
   33 mm square, three times narrower than the worst neck in any other piece, and under a
   millimeter as soon as the squares drop below 31 mm. It is widened to 1.82 mm, by the
   smallest dilation that clears the threshold.

3. **The ball on the king's finial becomes a cross.** The author left it a plain orb on
   purpose (the set is described as having no Christian iconography), which is a fine default
   and not what most people picture when they picture a king. This one is a preference, not a
   defect, and it is the only change here that alters the drawing rather than making it
   cuttable. It also happens to make the king stronger: the cross's vertical bar is buried
   deep inside the crown, where the old stem was a stalk, so the narrowest neck goes from
   1.82 mm to 2.58 mm.

4. **Every sharp outside corner gets a 0.34 mm radius.** The base crescent of each piece, and
   the pawn's mound and the rook's band, end in cusps that come to a literal point. A point is
   the thinnest feature a shape can have, so on HTV the last fraction of a millimeter has
   almost no area to bond with; and a drag knife cannot cut one anyway, because the blade
   trails the pivot and swivels through the reversal. Rounding a cusp necessarily shortens it,
   so the value is small: the crescents lose about a millimeter end to end and keep their
   shape. It removes every delicate-feature flag the checker used to raise on these glyphs.

After all four, every piece survives down to a 13 mm square at a 1 mm minimum feature width,
and none of them raises a warning at the shipped defaults.
