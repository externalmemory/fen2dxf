/** A point in millimeters. y is UP (DXF convention), origin at the design's bottom-left. */
export type Pt = readonly [number, number];

/** A closed ring. The closing edge is implicit: the last point is NOT repeated. */
export type Ring = Pt[];

/** One connected filled component: an outer boundary with zero or more holes. */
export type Poly = { outer: Ring; holes: Ring[] };

/**
 * A set of disjoint filled components = everything cut from one sheet of vinyl.
 * `Region.length` is therefore the number of separate decals the carrier sheet must carry.
 */
export type Region = Poly[];
