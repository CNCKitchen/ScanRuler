// SPDX-License-Identifier: AGPL-3.0-only
// What the Reverse engineer's commands take (reCommands.ts), as the JSON
// Schema an agent writes against. A feature goes in as the feature list
// stores it — core/features.ts, as a project file holds it — less its id,
// which the list gives it; what a person would point at is made writable:
// a feature, a sketch or a body by its name as well as its id, a face or
// an edge of a body by its place in reverse.body.describe as well as by its
// fingerprint, a sketch's region by a point inside it, a thread by its
// size. Everything else is the stored field under its stored name.
//
// What a tool lists is the small shape at the end (`featureInBrief`): the
// kinds, and the fields left open. The whole shape of every kind — tens of
// kilobytes, twenty levels deep with the sketch's pieces and relations —
// is held to when the command runs, and handed out kind by kind with an
// example by reverse.feature.schema. A client turns a tool with a schema
// that large down (see SCHEMA_BUDGET in src/commands/schema.ts).

import { anyObject, arr, bool, enumOf, int, num, obj, oneOf, str, vec3, type JsonSchema } from '../../../src/commands/schema'
import { SURFACE_MIN_REGION } from '../core/features'
import { NET_MAX, NET_MIN } from '../core/surfaceFit'
import { SURFACE_REGION_LIMIT, SURFACE_REGION_MAX } from './reSurfaceRegion'
import { INSERT_SIZES } from '../core/inserts'

const vec2 = (description: string): JsonSchema => arr(num(), description, { minItems: 2, maxItems: 2 })
const kind = (k: string): JsonSchema => enumOf([k])

/** The branches of a union of objects told apart by `kind`, each titled by
 *  it — what a refusal names them by. */
const byKind = (branches: JsonSchema[], description: string): JsonSchema =>
  oneOf(
    branches.map((b) => ({ ...b, title: String(b.properties?.kind?.enum?.[0] ?? b.title ?? 'object') })),
    description,
  )
const nullable = (schema: JsonSchema, description: string): JsonSchema => oneOf([schema, { type: 'null' }], description)
/** A box on the scan, in the frame the part is measured in now. */
const boxIn = obj({ min: vec3('The lowest corner, mm.'), max: vec3('The highest corner, mm.') }, ['min', 'max'], 'A box in the frame the part is measured in now.')

// ---- naming things ------------------------------------------------------------------

export const featureRef = (what = 'feature'): JsonSchema =>
  oneOf([num(`The ${what}’s id.`), str(`The ${what}’s name.`, { minLength: 1 })], `A ${what}, by id or by name.`)

export const bodyRef = oneOf(
  [num('The body’s id (its maker feature’s).'), str('Its name, or its maker feature’s name.', { minLength: 1 })],
  'A body, by id or name.',
)

const faceFingerprint: JsonSchema = {
  ...obj(
    {
      kind: enumOf(['plane', 'cylinder', 'cone', 'sphere', 'torus', 'other']),
      centroid: vec3('The face’s area-weighted centre, mm.'),
      dir: vec3('A plane’s outward normal; a cylinder’s, cone’s or torus’s axis.'),
      area: num(),
      radius: num(),
      center: vec3('A point on a round face’s axis.'),
      origin: num('The feature that first made the face.'),
    },
    ['kind', 'centroid', 'dir', 'area', 'origin'],
    'A face’s fingerprint, copied as reverse.body.describe or reverse.feature.list gives it.',
  ),
  title: 'fingerprint',
}

/** What faces and edges are asked for, of all a body has — the query
 *  reverse.body.describe takes as `where`, and a pick takes in place of
 *  an index: every face or edge that answers it. */
export const whereIn: JsonSchema = {
  ...obj(
    {
      box: obj({ min: vec3('The lowest corner, mm.'), max: vec3('The highest corner, mm.') }, ['min', 'max'], 'A face by its centroid, an edge by its middle, inside a box.'),
      near: obj({ at: vec3('A point, mm.'), radius: num('How far from it, mm.', { exclusiveMinimum: 0 }) }, ['at', 'radius'], 'A face by its centroid, an edge by its middle, within a radius of a point.'),
      through: obj({ at: vec3('A point on the edge, mm.'), within: num('How far the edge may pass from it, mm; 0.01 by default.', { exclusiveMinimum: 0 }) }, ['at'], 'An edge passing through a point, anywhere along it. Edges only.'),
      kind: str('A face’s kind — plane, cylinder, cone, sphere, torus — or an edge’s: line, circle, other.', { minLength: 1 }),
      between: arr(vec3('An outward normal, any length.'), 'Outward normals of the faces either side of an edge (one or two), or a face’s own normal, within withinDeg.', { minItems: 1, maxItems: 2 }),
      withinDeg: num('How far a normal may lean off those given, degrees; 10 by default.', { exclusiveMinimum: 0, maximum: 90 }),
      madeBy: featureRef(),
      minLength: num('An edge at least this long, mm.', { minimum: 0 }),
      maxLength: num('An edge at most this long, mm.', { minimum: 0 }),
      minArea: num('A face at least this large, mm².', { minimum: 0 }),
      maxArea: num('A face at most this large, mm².', { minimum: 0 }),
      radius: num('A round face’s or a circular edge’s radius, mm — within sizeWithin of it.', { exclusiveMinimum: 0 }),
      diameter: num('The same, as a diameter.', { exclusiveMinimum: 0 }),
      sizeWithin: num('mm either way of radius or diameter; 2 % of it, 0.05 at least, by default.', { exclusiveMinimum: 0 }),
      faces: arr(int('A face’s index in reverse.body.describe.', { minimum: 0 }), 'Face indices: for an edge, the faces either side of it (two: the edge between them; one: the edges round it); for a face, those faces.', { minItems: 1, maxItems: 2 }),
      loop: enumOf(['outer', 'inner'], 'With faces: [i] on a flat face — outer: its outside rim; inner: the edges round its holes.'),
      coaxial: obj({ at: vec3('A point on the axis, mm.'), dir: vec3('Its direction.'), within: num('mm the axis may stand off the line; 0.05 by default.', { exclusiveMinimum: 0 }) }, ['at', 'dir'], 'Round faces and circle edges on this axis (parallel within 1°, no seams): a bore, its rims and countersink.'),
      exclude: oneOf([arr(int(undefined, { minimum: 0 })), { type: 'object' }], 'Less these: their indices, or another query (as this one) — { madeBy: "Thread 1" }.'),
      optional: bool('As a pick: it may name nothing (picked lists it as missed) where it would fail the change otherwise.'),
      sharp: bool('Edges only: those whose faces meet at more than 1°, not tangent — a round’s seams left out, and a fitted profile’s that meets its faces a few tenths off tangent.'),
      sharpDeg: num('With sharp: the angle the faces must meet at, degrees; 1 by default. Given alone it asks sharp too.', { exclusiveMinimum: 0, maximum: 90 }),
      sides: { type: 'object', description: 'Edges between the faces of two features: { madeBy: ["Blade", "Dish"] }.' },
      where: { type: 'object', description: 'The same terms nested once more, taken as given here.' },
    },
    [],
    'A query: only the faces and edges that answer to all of these.',
  ),
  title: 'where',
}

export const facePick = oneOf(
  [int('The face’s index among the body’s faces in reverse.body.describe, as the bodies stand now.', { minimum: 0 }), faceFingerprint, whereIn],
  'A face of the body: its index in reverse.body.describe, its fingerprint, or a query (where, as reverse.body.describe takes it) standing for every face that answers it — at least one must. A feature stores the fingerprints and finds the faces again by them on every rebuild.',
)

const edgeFingerprint: JsonSchema = {
  ...obj(
    {
      kind: enumOf(['line', 'circle', 'other']),
      mid: vec3('The point halfway along the edge, mm.'),
      dir: vec3('A line’s direction; a circle’s axis.'),
      length: num(),
      radius: num(),
      faces: arr(obj({ kind: str(), dir: vec3('') }, ['kind', 'dir'])),
      origin: num(),
    },
    ['kind', 'mid', 'dir', 'length', 'faces', 'origin'],
    'An edge’s fingerprint, copied as reverse.body.describe or reverse.feature.list gives it.',
  ),
  title: 'fingerprint',
}

export const edgePick = oneOf(
  [int('The edge’s index in reverse.body.describe, as the bodies stand now.', { minimum: 0 }), edgeFingerprint, whereIn],
  'An edge of the body: its index in reverse.body.describe, a fingerprint, or a where query (every edge that answers it).',
)

/** Geometry already there, brought into a sketch: a body's edge, the
 *  outline of a body's face, or pieces of another sketch, each projected
 *  onto the sketch plane as a piece of this one — fixed where the part
 *  puts it, following its source on every rebuild (core/project.ts). */
const projectIn = arr(
  oneOf(
    [
      obj({ body: bodyRef, edge: edgePick }, ['body', 'edge'], 'An edge of a body — by a query, every edge that answers it.'),
      obj({ body: bodyRef, face: facePick }, ['body', 'face'], 'The outline of a face of a body: every edge round it.'),
      obj({ sketch: featureRef('sketch'), pieces: arr(int('A piece’s id in that sketch.'), 'Some of its pieces; every one when left out.', { minItems: 1 }) }, ['sketch'], 'The pieces of another sketch, seen on this plane.'),
    ],
    'What to project.',
  ),
  'Geometry projected into the sketch before anything is drawn: a body’s edge, the outline of a body’s face, or another sketch’s pieces, each a piece of this sketch fixed where the part puts it — there to close a profile with and to hang relations and dimensions on — and following its source when an earlier feature changes. The projected pieces come first, taking ids from 1 in the order given, and a fit lands on them (fit.share); the answer lists them (projected). An edge that is no line, arc or circle on this plane (a circle seen at a slant) is skipped and counted.',
  { minItems: 1 },
)

// ---- planes and axes ------------------------------------------------------------------

/** `up` on a plane: the sketch's u is then up × normal. */
const upIn = enumOf(['x', 'y', 'z'], 'The coordinate axis the sketch’s v runs up, as near as the plane lets it: u = up × normal, so a standing plane has that axis up whichever way its normal points. The plane’s own u by default.')

const worldPlane = obj(
  {
    kind: kind('world'),
    axis: enumOf(['x', 'y', 'z'], 'The axis the plane stands square to: z for the XY plane, x for YZ, y for XZ.'),
    offset: num('Where the plane lies along that axis, mm — 0, through the origin, by default.'),
    up: upIn,
  },
  ['kind', 'axis'],
  'A coordinate plane. The sketch’s u and v: on XY (axis z) u = X, v = Y; on YZ (axis x) u = Y, v = Z; on XZ (axis y) u = Z, v = X. The sheet’s zero is the part’s origin, projected onto the plane.',
)

const planeOffsetIn = num('mm the plane is moved along its normal — out of a face is positive; 0 by default.')

const radialPlane = obj(
  {
    kind: kind('radial'),
    axis: byKind(
      [
        obj({ kind: kind('element'), id: int('The element’s id.'), name: str('Or its name.', { minLength: 1 }) }, ['kind'], 'A line, cylinder, cone or circle element of 3D Measure, by id or name.'),
        obj({ kind: kind('world'), axis: enumOf(['x', 'y', 'z']) }, ['kind', 'axis'], 'A coordinate axis through the origin.'),
      ],
      'The axis the plane goes through.',
    ),
    angleDeg: num('Degrees about the axis: 0 is the coordinate axis next round (X about Z, Y about X, Z about Y), turning by the right hand — about Z, from +X towards +Y.'),
    offset: planeOffsetIn,
  },
  ['kind', 'axis', 'angleDeg'],
  'A plane through an axis, turned angleDeg about it — a half section of a turned part. u runs out along the radius, v up the axis (towards the + end of the coordinate axis it lies nearest), the normal u × v, at every angle; the sheet’s zero is on the axis, level with the part’s origin.',
)

/** A coordinate plane by name, as the rest of the app takes it. */
const planeName: JsonSchema = { ...str('A coordinate plane by name: "XY" (as { kind: "world", axis: "z" }), "YZ" (axis x), "XZ" or "ZX" (axis y) — any case, with or without " plane".', { minLength: 2 }), title: 'name' }

const planeBranches: JsonSchema[] = [
  planeName,
  worldPlane,
  obj({ kind: kind('section'), id: int('A section of 3D Measure.'), name: str('Or its name.', { minLength: 1 }), offset: planeOffsetIn, up: upIn }, ['kind'], 'A section’s plane, by id or name.'),
  obj({ kind: kind('plane'), id: int('A plane element of 3D Measure.'), name: str('Or its name.', { minLength: 1 }), offset: planeOffsetIn, up: upIn }, ['kind'], 'A measured plane, by id or name. Its sketch counts from the part’s origin projected onto it, not the element’s centre, and the element’s own basisU/V may point the other way: the answer’s element gives its centre in [u, v].'),
  obj({ kind: kind('bodyFace'), body: bodyRef, face: facePick, offset: planeOffsetIn, up: upIn }, ['kind', 'body', 'face'], 'A flat face of a body; a sketch on it follows the face when an earlier feature moves it, standing off it by the offset. Its u and v: the coordinate axes flattened onto the face, as on the coordinate plane it is nearest to.'),
  radialPlane,
]

export const planeIn = byKind(planeBranches, 'A plane: a coordinate plane (by name, "XY", or as { kind: "world" }), a section, a measured plane, a flat face of a body, or a plane through an axis.')

const mirrorPlaneIn = byKind(
  [...planeBranches, obj({ kind: kind('face'), face: facePick }, ['kind', 'face'], 'A flat face of the body worked on.')],
  'The plane: a coordinate plane (by name, "XY", or as { kind: "world" }), a section, a measured plane, a flat face of a body, a plane through an axis — or, as { kind: "face" }, a flat face of the body worked on.',
)

const axisIn = byKind(
  [
    obj({ kind: kind('world'), axis: enumOf(['x', 'y', 'z']) }, ['kind', 'axis'], 'A coordinate axis through the origin.'),
    obj({ kind: kind('sketchLine'), entity: int('The line’s id in the sketch.') }, ['kind', 'entity'], 'A line of the sketch itself — a construction line is the usual axis.'),
    obj({ kind: kind('element'), id: int('A line, cylinder, cone or circle element of 3D Measure, by id.'), name: str('Or its name.', { minLength: 1 }) }, ['kind'], 'A measured element’s axis, by id or name.'),
  ],
  'What the revolve turns about.',
)

// ---- sketches --------------------------------------------------------------------------

// One string rather than an enum and a pattern: a and b are a spline's
// ends too, and the piece's own points are checked when the sketch is made.
const anchorAt = str(
  'Which point of the piece: a line’s, an arc’s or an open spline’s start (a) or end (b); an arc’s, a circle’s or a point’s centre (center); a spline’s fit point by its place among them, p1, p2, … (a closed spline’s run p0, p1, …).',
  { minLength: 1 },
)
const anchor = obj({ entity: int('The piece’s id.'), at: anchorAt }, ['entity', 'at'], 'A point of a piece.')
const datum = enumOf(['xy', 'yz', 'zx'], 'One of the part’s coordinate planes, by the line it cuts the sketch plane in.')
const line = obj({ line: int('A line’s id.') }, ['line'])
const curve = obj({ curve: int('An arc’s, a circle’s or a spline’s id.') }, ['curve'])
const toDatum = obj({ datum }, ['datum'])

const pieceCommon = {
  id: int('The piece’s id, unique in the sketch — pieces and relations (dimensions too) share one run of ids. Leave it out unless a relation in this call names it: a piece without one takes the next free id, which the answer lists (ids).', { minimum: 1 }),
  construction: bool('Drawn for construction only — an axis, a mirror line: no part of any region.'),
  fixed: bool('Locked where it is.'),
  projected: bool('Projected from a body’s edge or another sketch — as reverse.feature.list gives it back.'),
  source: anyObject('Where a projected piece was taken from — as reverse.feature.list gives it back.'),
}

const entityIn = byKind(
  [
    obj({ ...pieceCommon, kind: kind('line'), a: vec2('Its start, [u, v] mm.'), b: vec2('Its end, [u, v] mm.') }, ['kind', 'a', 'b']),
    obj(
      { ...pieceCommon, kind: kind('arc'), c: vec2('Its centre, [u, v] mm.'), r: num('Its radius, mm.', { exclusiveMinimum: 0 }), start: num('Where it starts, radians counter-clockwise from +u; anchor a is here.'), sweep: num('How far it runs counter-clockwise, radians; anchor b is at start + sweep.') },
      ['kind', 'c', 'r', 'start', 'sweep'],
    ),
    obj({ ...pieceCommon, kind: kind('circle'), c: vec2('Its centre, [u, v] mm.'), r: num('Its radius, mm.', { exclusiveMinimum: 0 }) }, ['kind', 'c', 'r']),
    obj(
      {
        ...pieceCommon,
        kind: kind('spline'),
        pts: arr(vec2(''), 'The fit points it runs through, in order, [u, v] mm — a smooth curve (C2) through every one; anchors a and b at the first and last, p1, p2, … between.', { minItems: 2 }),
        closed: bool('Round back to the first point, smooth there too (three points at least); its anchors are then p0, p1, ….'),
        startDir: num('The direction it leaves its first point, radians from +u — the solver’s while a tangent holds that end; left out, the end is natural.'),
        endDir: num('The direction it arrives at its last point, radians — as startDir.'),
      },
      ['kind', 'pts'],
      'A curve through fit points — a freeform outline, a blend no arc makes. It is held tangent to a line, an arc or another spline where one of its ends is coincident with that piece’s end; a point is held on it by pointOn { curve }. Fit one to the slice with fit.spline.',
    ),
    obj({ ...pieceCommon, kind: kind('point'), p: vec2('Where it is, [u, v] mm.') }, ['kind', 'p']),
  ],
  'A piece of the sketch, in sheet millimetres (u, v).',
)

const constraintCommon = {
  id: int('Its id; given one if left out.', { minimum: 1 }),
  inferred: bool('Added by the sketcher on its own — as reverse.feature.list gives it back.'),
  place: anyObject('Where its number is drawn — as reverse.feature.list gives it back.'),
}
const dimension = (unit: string) => ({
  value: num(`The dimension, ${unit}. Left out, it is what the expression comes to, or else what the pieces measure now.`),
  expr: str('An expression for it — a number with a unit, arithmetic, the model’s parameters by name (reverse.parameter.add): "l1", "d/2 + 0.5", "1 in". The dimension follows the parameters it reads.', { minLength: 1 }),
})
const pair = (k: string, what: string) => obj({ ...constraintCommon, kind: kind(k), a: int(), b: int() }, ['kind', 'a', 'b'], what)

const constraintIn = byKind(
  [
    obj({ ...constraintCommon, kind: kind('coincident'), p: anchor, q: anchor }, ['kind', 'p', 'q'], 'Two points in one place — what joins the ends of a chain.'),
    obj({ ...constraintCommon, kind: kind('horizontal'), entity: int('A line.') }, ['kind', 'entity'], 'A line along u.'),
    obj({ ...constraintCommon, kind: kind('vertical'), entity: int('A line.') }, ['kind', 'entity'], 'A line along v.'),
    pair('parallel', 'Two lines parallel.'),
    pair('perpendicular', 'Two lines square to each other.'),
    pair('tangent', 'A line tangent to an arc or a circle, or two of those tangent; a spline tangent to a line, an arc or a spline where an end of it is coincident with that piece’s end.'),
    pair('concentric', 'Two arcs or circles about one centre.'),
    pair('equal', 'Two lines of one length, or two arcs or circles of one radius.'),
    obj(
      { ...constraintCommon, kind: kind('pointOn'), p: anchor, on: oneOf([line, curve, toDatum]), bounded: bool('Keep the point within the piece — between a line’s ends, within an arc’s sweep — not on the line or circle it runs on past them: a T-junction that stays one when the piece is shortened. A fit’s junctions are held so (junctions).') },
      ['kind', 'p', 'on'],
      'A point held on a line, on a round piece’s rim, on a spline, or on a coordinate plane’s line.',
    ),
    obj({ ...constraintCommon, kind: kind('collinear'), line: int('A line.'), on: oneOf([line, toDatum]) }, ['kind', 'line', 'on'], 'A line lying along another line, or along a coordinate plane’s line.'),
    obj(
      { ...constraintCommon, kind: kind('symmetric'), p: anchor, q: anchor, about: oneOf([enumOf(['x', 'y'], 'The sheet’s own u (x) or v (y) axis.'), line, toDatum]) },
      ['kind', 'p', 'q', 'about'],
      'Two points mirror images across an axis.',
    ),
    obj({ ...constraintCommon, kind: kind('length'), entity: int('A line.'), ...dimension('mm') }, ['kind', 'entity'], 'A line’s length.'),
    obj(
      { ...constraintCommon, kind: kind('distance'), p: anchor, q: oneOf([anchor, line, toDatum], 'To another point, square to a line, or square to a coordinate plane’s line.'), ...dimension('mm') },
      ['kind', 'p', 'q'],
      'A distance from a point.',
    ),
    obj({ ...constraintCommon, kind: kind('radius'), entity: int('An arc or a circle.'), ...dimension('mm') }, ['kind', 'entity'], 'A radius — what an arc is dimensioned by.'),
    obj({ ...constraintCommon, kind: kind('diameter'), entity: int('A circle or an arc.'), ...dimension('mm') }, ['kind', 'entity'], 'A diameter — what a full circle is dimensioned by, as the panel’s Dimension tool gives it; the radius is held at half of it.'),
    obj({ ...constraintCommon, kind: kind('angle'), a: int('A line.'), b: int('A line.'), ...dimension('degrees, 0 to 180 as the lines’ directions read') }, ['kind', 'a', 'b'], 'The angle between two lines.'),
  ],
  'A relation or a dimension.',
)

const shapeCommon = {
  id: int('The id its first piece takes; the rest follow in a run (see the kind). Pieces and relations share one run of ids. Left out, the run starts after every id the sketch has or is given — pieces’ and relations’ alike.', { minimum: 1 }),
  fixed: bool('Lock its pieces where they are — a shape placed by coordinates, fully defined at once.'),
  construction: bool('Draw it for construction only.'),
  world: bool('Its points (center, from, to, points) are world [x, y, z] mm, each taken to the sketch’s [u, v] square to the plane — as reverse.plane.describe { point } reads one. Sizes, lengths and angles stay the sketch’s.'),
}

/** A point of a shape: [u, v] on the sheet, or [x, y, z] with world. */
const shapePoint = (description: string): JsonSchema => arr(num(), description, { minItems: 2, maxItems: 3 })

/** A shape's sizes by expressions: `slots` the fields it takes. A name
 *  given in place of one of `named` is refused with the way to write it
 *  (schema.ts names). */
const shapeExprs = (slots: string): JsonSchema =>
  anyObject(
    `Expressions for its sizes, by field: ${slots}. Each the parameters by name, arithmetic, units ("w", "d/2 + 0.5"): the shape is drawn at what it comes to, and held by a dimension of the sketch with that expression — the size follows the parameters on every rebuild, the number beside it may be left out. Not with fixed (that locks the pieces). Points take none: a world point lands on the sheet by a projection and a sketch's distances are unsigned, so no one dimension follows a coordinate — hold a point with a relation, distance { p, q: { datum }, expr }.`,
  )
const withNames = (schema: JsonSchema, slots: string[]): JsonSchema => ({ ...schema, names: { field: 'exprs', slots } })

/** The shapes a sketch takes besides single pieces, each drawn as the
 *  panel's tool draws it — its pieces, and the relations that hold it. */
const shapeIn = byKind(
  [
    obj(
      {
        ...shapeCommon,
        kind: kind('rectangle'),
        from: shapePoint('One corner, [u, v] mm.'),
        to: shapePoint('The opposite corner.'),
        center: shapePoint('Its centre, [u, v] mm — with size, in place of from and to. A construction point there, where its diagonals cross, holds it about the centre.'),
        size: vec2('Its width along u and its height along v, mm — with center.'),
        angleDeg: num('Turned counter-clockwise about its centre (or about from), degrees; 0 (the default) keeps the sides level and upright.'),
        radius: num('Round the four corners to this radius, mm — a rounded rectangle, each round dimensioned. Half the shorter side at most; at that it is drawn as a slot along the longer side (its pieces and roles a slot’s, sides and ends, one end’s radius dimensioned), a circle when the sides are equal.', { exclusiveMinimum: 0 }),
        exprs: shapeExprs('width (along u, unturned), height, radius — a width or height sets size, or moves to off from; with both, to or size may be left out'),
      },
      ['kind'],
      'Four sides, joined at the corners, level and upright (or parallel and square, turned). Its pieces: the four sides — bottom, right, top, left, as it lies unturned — then, about a centre, the two construction diagonals and the centre point; then, with a radius, the four rounds, from the corner where the first side ends.',
    ),
    obj(
      {
        ...shapeCommon,
        kind: kind('slot'),
        from: shapePoint('The centre of the round at one end, [u, v] mm.'),
        to: shapePoint('The centre of the round at the other end.'),
        center: shapePoint('Its centre, [u, v] mm — with length, in place of from and to.'),
        length: num('Centre to centre of the two rounds, mm — with center.', { exclusiveMinimum: 0 }),
        width: num('The width across, mm — the rounds’ diameter. Or exprs.width.', { exclusiveMinimum: 0 }),
        angleDeg: num('Turned counter-clockwise, degrees, with center; 0 (the default) runs it along u.'),
        exprs: shapeExprs('width, length — a length moves to along from → to, or sets it with center'),
      },
      ['kind'],
      'A slot: two straight sides and a half-round at each end, tangent where they meet and held equal. Its pieces: the side on the left going from → to, the round at to, the side back, the round at from.',
    ),
    obj(
      {
        ...shapeCommon,
        kind: kind('polygon'),
        center: shapePoint('Its centre, [u, v] mm.'),
        sides: int('How many sides, 3 and up.', { minimum: 3, maximum: 64 }),
        radius: num('The circle it is drawn about, mm: through the corners (inscribed), or touching the sides — half the width across flats (circumscribed).', { exclusiveMinimum: 0 }),
        fit: enumOf(['inscribed', 'circumscribed'], 'inscribed (the default): the corners on the circle; circumscribed: the sides touching it, as a hex nut is sized across flats.'),
        angleDeg: num('Where the first corner (inscribed) or the middle of the first side (circumscribed) lies, degrees counter-clockwise from +u; 0 by default.'),
        exprs: shapeExprs('radius — on the circle it is sized on'),
      },
      ['kind', 'center', 'sides'],
      'A regular polygon: equal sides, its corners on a construction circle. Its pieces: the sides, then the circle through the corners, then — circumscribed — the circle inside, touching them, the one its size is dimensioned on.',
    ),
    obj(
      {
        ...shapeCommon,
        kind: kind('polyline'),
        points: arr(shapePoint(''), 'The corners in order, [u, v] mm.', { minItems: 2 }),
        closed: bool('Join the last corner back to the first (the default false).'),
      },
      ['kind', 'points'],
      'Lines from corner to corner, joined at each. Its pieces: the lines, in order.',
    ),
    obj(
      {
        ...shapeCommon,
        kind: kind('ellipse'),
        center: shapePoint('Its centre, [u, v] mm.'),
        a: num('The half axis along u, as it lies unturned, mm.', { exclusiveMinimum: 0 }),
        b: num('The half axis along v, as it lies unturned, mm.', { exclusiveMinimum: 0 }),
        angleDeg: num('Turned counter-clockwise about its centre, degrees; 0 by default.'),
        points: int('How many fit points round it, evenly by the ellipse’s parameter; 16 by default. More lies closer.', { minimum: 4, maximum: 64 }),
      },
      ['kind', 'center', 'a', 'b'],
      'An ellipse as one closed spline through points on it — no exact ellipse: the answer’s ellipses gives how far it lies off a true one (deviationMm). Its piece: the spline.',
    ),
    obj(
      {
        ...shapeCommon,
        kind: kind('circle'),
        center: shapePoint('Its centre, [u, v] mm.'),
        radius: num('Its radius, mm. Or exprs.radius.', { exclusiveMinimum: 0 }),
        exprs: shapeExprs('radius'),
      },
      ['kind', 'center'],
      'A circle, as the piece is — placed by a world point (world) or sized by an expression (exprs.radius). Its piece: the circle.',
    ),
  ].map((s) => {
    // A name in place of a size an expression may drive: refused with the
    // way to write it.
    const k = String(s.properties?.kind?.enum?.[0])
    const named: Record<string, string[]> = { rectangle: ['radius'], slot: ['width', 'length'], polygon: ['radius'], circle: ['radius'] }
    return named[k] ? withNames(s, named[k]) : s
  }),
  'A shape drawn in one go.',
)

/** Copies of pieces already in the sketch. */
const patternIn = byKind(
  [
    obj(
      {
        kind: kind('rectangular'),
        pieces: arr(int(), 'The ids of the pieces to repeat — a shape’s included.', { minItems: 1 }),
        step: vec2('From one copy to the next, [du, dv] mm.'),
        count: int('How many along step, the originals counted.', { minimum: 1 }),
        step2: vec2('A second direction, for a grid.'),
        count2: int('How many along step2.', { minimum: 1 }),
      },
      ['kind', 'pieces', 'step', 'count'],
      'A row, or with step2 a grid.',
    ),
    obj(
      {
        kind: kind('circular'),
        pieces: arr(int(), 'The ids of the pieces to repeat.', { minItems: 1 }),
        center: vec2('The centre turned about, [u, v] mm.'),
        count: int('How many, the originals counted.', { minimum: 1 }),
        angleDeg: num('The angle spanned, degrees counter-clockwise; 360 (the default) spreads them evenly round.'),
      },
      ['kind', 'pieces', 'center', 'count'],
      'Round a centre.',
    ),
  ],
  'Repeat pieces: every copy a piece of its own, with the relations and dimensions the pieces have among themselves (what ties them to anything else stays with the originals). The copies take the next free ids; the answer lists them.',
)

/** A box a fit, an outline or a stack keeps to: min and max on the
 *  command's own sheet (its text names which), or world: { min, max } in
 *  the world — converted to that sheet when the command runs. */
export const withinIn = (description: string, extra: Record<string, JsonSchema> = {}): JsonSchema =>
  obj(
    {
      min: arr(num(), 'The low corner on the sheet, [u, v] mm.', { minItems: 2, maxItems: 3 }),
      max: arr(num(), 'The high corner, [u, v] mm.', { minItems: 2, maxItems: 3 }),
      world: obj({ min: vec3('[x, y, z] mm.'), max: vec3('[x, y, z] mm.') }, ['min', 'max'], 'The box in the world instead of min and max.'),
      ...extra,
    },
    [],
    description,
  )

/** One skin of a thin wall, or the points that face a way: what a fit, an
 *  outline or a stack of the scan's cut keeps to (src/core/section/skin.ts).
 *  Out of the material is the scan's triangles' way out. */
export const skinIn = enumOf(
  ['outer', 'inner'],
  'One skin of a thin wall, each run of it a chain of its own (run): outer — the skin the part shows; inner — the wall’s other side.',
)

export const facingIn = obj(
  {
    dir: vec2('A direction on the sheet, [u, v] — [0, 1] for the side facing +v.'),
    withinDeg: num('Degrees the way out may lean off dir; 60 by default.', { exclusiveMinimum: 0, maximum: 180 }),
  },
  ['dir'],
  'Only the points facing within withinDeg of dir, each run a chain of its own (run); with skin, both must pass.',
)

/** Lines and arcs fitted to the scan's outline on the sketch plane, as the
 *  panel's Fit all chains fits them — or to points typed in. */
export const fitIn = obj(
  {
    chains: oneOf(
      [
        enumOf(['all', 'largest']),
        arr(int('A chain’s index, as reverse.section.fit and section.get count them.', { minimum: 0 }), '', { minItems: 1 }),
        obj({ at: vec2('[u, v] mm in the sketch.') }, ['at'], 'The chain the point lies on (within three of its scatters), else the smallest closed chain round it, else the nearest chain. fitted says which (pickedBy: on, round or nearest), the chain’s area (0 open) and how many closed chains lie round the point (enclosing).'),
      ],
      'Which chains of the outline to fit: all (the default — a chain too short to fit is skipped, and fitted names it with its points and why), largest (the closed one of the most area, else the longest), the one a point lies on or inside ({ at }), or some by index (each must fit).',
    ),
    within: withinIn('Fit only what of each chain lies in this box — one wall, one curve; each run in it is fitted as a chain of its own (fitted gives its run). min and max are [u, v] mm in the sketch’s own frame (reverse.plane.describe gives it); or world: { min, max }, [x, y, z] mm.'),
    level: num('mm along the sketch’s normal from its plane (out of a face is positive): the scan is cut there and its outline laid on this sketch — on parallel planes u and v are the same. Another level of a stacked part goes into the one sketch so (reverse.sketch.edit { add: { fit: { level } } }), each region then extruded to its height. Left out, the cut is at the plane — a hair (0.25 mm) inside a face of a body or of the scan. fitted names each chain’s level.'),
    through: oneOf(
      [bool('true: seen through in the band about the plane (or level).'), obj({ depth: arr(num(), '[from, to], mm along the sketch’s normal from its plane (out of a face is positive).', { minItems: 2, maxItems: 2 }) }, ['depth'])],
      'A thin sheet seen through, square onto the plane, in place of the scan cut there — a stamped or bent sheet whose holes a cut parallel to it misses on its warp and beads: rays square to the plane meet the scan only within depth ([-1.5, 1.5] mm by default, about level where given), and the line between where they meet it and where they see through is traced — the sheet’s edge and every hole punched in it, each a closed chain, the largest first, its traced points the slice points. Cells are half the tolerance (0.2 by default), widened to keep 250000 (through.note; give within round the part to read finer). chains, within, closeGaps, detail, arcs, spline, share and accept work as on the cut; skin and facing are refused. fitted[].hole marks the holes; the answer’s through gives depth, cell, loops, holes and skipped (specks under three cells across, left out). Trap: depth must hold the whole sheet, warp and beads, and nothing behind it — a closed cage’s far wall in the band hides every hole, and sheet warped out of the band reads as a hole. A thick wall has no surface in the band: cut it instead.',
    ),
    draftDeg: num('With level: the taper the extrude from this sketch will have, degrees, signed as its own draftDeg — positive, the sides lean in going away from the sketch plane. The wall cut at level lies level·tan(draftDeg) inside where the taper starts at the plane, so each closed chain fitted is moved out by that many mm and the extrude lands on the wall; a chain inside another, a hole of its region, moves the other way. A pocket to cut goes in a fit of its own, without the chain round it. The extrude goes the way level lies. The answer’s draftOffset gives the mm and each chain; where a chain cannot move (a spline, a branch, one that closes up) nothing moves, and it says why and the number.', { minimum: -45, maximum: 45 }),
    share: num('mm: before the outline is cut into pieces, every slice point this near a piece the sketch already holds — drawn, fitted or projected — and running its way (within 5°) goes to that piece: that wall is drawn already, and is not fitted again. A fitted piece takes the points beside its own and the solve refits it on both levels (moved says how far); a drawn or projected one takes none. What is left is fitted as open runs, each end landing on the piece it reaches — on its end, or held on it within it (junctions). shared gives each piece’s points and how far off they lay — the run-out between levels. 0.1 by default; give the part’s tolerance: steps under it are one surface. 0 fits every wall again.', { minimum: 0 }),
    skin: skinIn,
    facing: facingIn,
    closeGaps: num('Join chain ends closer than this, mm, before anything else — the ends of two chains, or a chain’s own two ends — nearest first: a scan with holes cut into a closed outline. fitted names a chain by its lowest index, with joined (the chains it was made of) and bridged (gaps, largest). A chain fitted open says open: { ends (its pieces’ free ends, [u, v]), gap (mm between them), tryCloseGaps (a closeGaps about the gap, to fit it again closed — straight across the hole; left out for a run within or a side cut, open by asking) }.', { exclusiveMinimum: 0 }),
    detail: num('How fine the cut is: 0 (few, long pieces) to 1 (every small feature its own piece); 0.5 by default.', { minimum: 0, maximum: 1 }),
    arcs: int('Each chain as this many arcs end to end, in place of the cut — for a curve the cut makes otherwise: two tangent arcs of a near radius it takes for one, a long shallow curve it takes for lines. The breaks go where the arcs sit closest on the points; take tangent between them from the candidates. Give chains with it: the chain of the curve alone.', { minimum: 1, maximum: 8 }),
    spline: int('Each chain as one spline through this many fit points, in place of the cut — a freeform outline, a blend no run of arcs holds: the points start evenly along the chain (round it, closed) and the solver settles the curve onto the slice. Give chains with it, and more points where the outline bends more; fitted names the one piece.', { minimum: 2, maximum: 64 }),
    tolerance: num('Millimetres a piece may miss its points by; left out, the chain’s own scatter says.', { exclusiveMinimum: 0 }),
    alignAxes: bool('Lay lines that run nearly along the sheet’s axes exactly along them (within alignDegrees, 3 by default), and merge the pieces of one wall into one line; off by default.'),
    alignDegrees: num('', { minimum: 0.5, maximum: 10 }),
    joinCorners: bool('Join the pieces at the corners they make — a closed chain comes out a closed profile (the default true).'),
    accept: obj(
      {
        sigmas: num('Accept a candidate whose off is at most this many of its sigmas — 2 takes what the scan’s noise cannot tell from holding.', { exclusiveMinimum: 0 }),
        kinds: arr(enumOf(['horizontal', 'vertical', 'parallel', 'perpendicular', 'collinear', 'angle', 'equal', 'concentric', 'tangent', 'onDatum', 'symmetric']), 'Only these kinds of relation; every kind when left out.', { minItems: 1 }),
        maxMoveMm: num('The farthest a relation may move any piece from where the fit put it, mm — an arc measured at its ends and middle. By default 3 sigmas of the pieces it relates: each piece’s own residual on its points (its rms), floored at the chain’s point-to-point scatter, so a wavy fit moves further than the scatter alone allows; 0.01 at least.', { exclusiveMinimum: 0 }),
      },
      ['sigmas'],
      'Take the relations the fitted pieces nearly hold as the design’s, in the same call: each candidate (as reverse.sketch.candidates gives them) within sigmas of holding is added, nearest first, and the sketch solved; one the solve cannot meet with those before it is left (conflict), one they already imply (implied), and one that moves a piece past maxMoveMm (moved, with moves: { piece, mm, limitMm }) — one they imply in part is taken for the rest, its constraints saying which. Tangent, equal radius and angle are offered between neighbouring pieces only (joined, or ends within a few scatters). A fit whose chain crosses itself (fitted[].crosses) is refused accept. The answer’s accept lists accepted (with the constraint ids added — take one out with remove.constraints), left, each with why: sigmas, kind, conflict, implied or moved, and maxMoveMm (the largest limit a trial was held to); moved says how far the pieces went, and note — where every candidate of a kind was left moved — how far they went and the maxMoveMm that takes them, to weigh against T.',
    ),
    like: {
      ...featureRef('sketch'),
      description:
        'Fit the run like this sketch, a station already made — for the stations of a loft: the run (the longest the fit keeps; give skin, facing or within so it is the profile’s) cut into the same pieces in the same order, its fitted lines and arcs each fitted to its own points under that piece’s id; its drawn pieces (a line across the base) copied at the same [u, v], the run’s ends run on to meet them; its relations among them copied, and its dimensions on drawn pieces. It takes the place of the cut: detail, alignAxes and joinCorners do nothing; arcs and spline are refused. fitted[].like says whether the run was taken from its far end (reversed).',
    },
    points: oneOf(
      [arr(vec2('[u, v] mm in the sketch.'), 'One chain, in order.', { minItems: 2 }), arr(arr(vec2('[u, v] mm in the sketch.'), '', { minItems: 2 }), 'Several chains, each in order.', { minItems: 1 })],
      'Fit to these points in place of the scan — a profile read off a drawing’s table of points, no scan needed: [u, v] mm in the sketch’s own frame, one chain [[u, v], …] or several [[[u, v], …], …], each fitted as a chain of the cut is (arcs, spline, detail, alignAxes, joinCorners and accept as for it) on a smooth run through them, cut at tolerance (0.1 by default, a thousandth of the points’ span where that is more), and then settled on the points themselves, so seven points serve as well as a slice’s seven hundred. Corners typed as points come out rounded: draw a polyline (shapes) for them. An end within share of an end of a piece the sketch already has is joined to it — coincident, and tangent where the chain sets off within 20° of that piece’s way (two lines: collinear); junctions lists them. A free end whose point lies on a side of the box round the points (the last point at the largest u, a corner meeting the part’s flat side) and that the fit would carry past that side is held on its point running along it (fitted[].heldAlong). Per chain fitted gives the pieces (an arc’s r), maxDeviation and deviations ({ point, mm }, worst first) at the points given, and overshoot — how far the pieces run past the box round the points, past which side and where, false where they keep within it. chains, within, skin, facing, level, draftDeg, closeGaps, like and through read the scan and are refused with it.',
    ),
    closed: bool('With points: each chain a loop, its last point joined back to its first (a chain whose last point is its first closes so by itself).'),
  },
  [],
  'Fit lines and arcs to the scan’s outline on the plane first, with their slice points behind them — a section’s own chains for a sketch on a section, the scan cut at the plane otherwise, a thin sheet seen through it with through — or, with points, to points typed in (no scan needed): fit: { points: [[66.8, 0], [71.66, -0.06], [76.42, -1], [80.48, -3.63], [83.1, -7.68], [84.08, -12.44], [84.1, -17.31]], arcs: 3 } fits three tangent arcs to a drawing’s corner. The fitted pieces take ids from 1 — after the projected ones, where some are; entities, shapes and constraints given go on top of them, their ids clear of those, and may name them. The answer’s fitted lists each chain’s pieces by id and kind. reverse.section.fit reads the same pieces without making a sketch.',
)

export const sketchIn = obj(
  {
    fit: fitIn,
    project: oneOf([projectIn, bool('false: a sketch on a face of a body starts without the face’s outline.')], `${projectIn.description} A sketch on a face of a body (plane { kind: "bodyFace" }, no offset) starts with that face’s outline projected, as the panel’s does — listed first under projected, its ids clear of those the sketch names — and a fit lands on it; its regions then include the face round what is drawn, so pick the extrude’s regions by a point ({ at }). project: false leaves it out. A sketch on a shadow section (plane { kind: "section" } of a shadow) starts the same way with the shadow’s outline — its lines, arcs and circles as the shadow was read, ends held coincident and rounded corners tangent, ids clear of those the sketch names; project: false leaves it out.`),
    entities: arr(entityIn, 'The pieces.'),
    shapes: arr(shapeIn, 'Rectangles, rounded rectangles, slots, polygons, chains of lines, ellipses and circles, each drawn as one — their pieces join the sketch as if listed in entities, and constraints may name them. Sizes may follow parameters (exprs).'),
    constraints: arr(constraintIn, 'The relations and dimensions between them.'),
    patterns: arr(patternIn, 'Copies of pieces, made after the constraints are in.'),
    infer: bool('Add the relations a hand-drawn sketch would get (the default true): a coincidence where two ends meet, horizontal or vertical on a line lying exactly level or upright. false leaves the sketch with only what is given.'),
    inset: obj(
      {
        by: num('mm inward; negative moves it outward.'),
        of: { ...featureRef('sketch'), description: 'Another sketch’s profile in place of this one’s, at the same [u, v] — on its plane, its inner twin.' },
        keep: arr(int(), 'Pieces held where they lie, by id. By default the drawn pieces of a chain that has fitted ones too — the line it is closed with across the base, not a round drawn on it; none otherwise.'),
      },
      ['by'],
      'Last: every closed chain moved inward, each into its own inside — a thin shell’s inner station from its outer one, fitted pocket outlines against their draft; chains open among closed ones stay (inset.open), and inset.chains lists each chain’s pieces. A copy taken once: the sketch does not follow of when of changes later, and is edited as any other; reverse.feature.update { set: { sketch: { inset } } } takes it again in place — from of as it stands then, or, without of, this sketch’s own profile moved in further — the features on it keeping their picks. Each line moves along its normal into the profile, each arc about its centre (R − by where the profile lies on its centre’s side, R + by off it), and the corners meet again; kept pieces stay on their lines, their ends running on to meet the moved ones. Moved pieces let their slice points go, dimensions take what they now measure, and a relation the move breaks goes (inset.dropped). A circle takes R − by. Refused, by chain and with nothing moved, for an arc tighter than by, a piece that would turn inside out, or chains that would come to cross; and for a sketch of open chains alone.',
    ),
    nextId: int('Ignored — worked out from the ids.'),
  },
  [],
  'The sketch: pieces and shapes, and relations and dimensions naming them by id.',
)

/** What would filter a fit's chains by length or by being closed, were a
 *  sketch's fit the place for it. */
const CHAIN_FILTERS = ['minLength', 'maxLength', 'closedOnly', 'maxChains']

/** A refusal's lines with an unknown field directly under a sketch, its fit
 *  or another plain part of it saying the fields that part does have — and,
 *  for a filter of chains a fit has not, where it is: reverse.section.fit's,
 *  whose chains' indices fit.chains takes. */
export function sketchFieldsNamed(errors: readonly string[]): string[] {
  return errors.map((e) => {
    const m = /^input\.(?:(?:feature|set)\.sketch|add)((?:\.\w+)*)\.(\w+): not a known field(?: — the fields here: .*)?$/.exec(e)
    if (!m) return e
    let part: JsonSchema | undefined = sketchIn
    const path = m[1].split('.').filter(Boolean)
    for (const step of path) part = part?.properties?.[step]
    if (!part?.properties) return e
    const filter = path.join('.') === 'fit' && CHAIN_FILTERS.includes(m[2]) ? ` A fit keeps no chains by length: reverse.section.fit { ${CHAIN_FILTERS.join(', ')} } reads the same cut and lists the chains it keeps, by index; give those as fit.chains.` : ''
    return `${e.replace(/ — the fields here: .*$/, '')} — ${['sketch', ...path].join('.')} has ${Object.keys(part.properties).join(', ')}.${filter}`
  })
}

/** What reverse.sketch.edit adds: a sketch's fields, none required, and
 *  pieces whose id may be left out — given the next free ones, which the
 *  answer lists (ids) — or given one a relation of the sketch has, and
 *  renumbered (renumbered). */
export const sketchAddIn: JsonSchema = {
  ...partialOf(sketchIn),
  properties: {
    ...sketchIn.properties,
    entities: arr(
      entityIn,
      'The pieces. An id left out is given the next free one, in the order listed — the answer’s ids gives each new piece’s; a constraint in the same add names only the pieces given an id. A new piece given an id a relation or a dimension of the sketch has is given a free one, and the constraints, patterns and rounds of this add that name it follow it (renumbered: { "70": 161 }); one a piece of the sketch has is refused.',
    ),
  },
}

// ---- extents and profiles --------------------------------------------------------------

const regionsIn = oneOf(
  [
    enumOf(['all', 'largest'], 'Every closed region of the sketch, or the largest by area. Kept as given: an edit of the sketch takes the regions again as asked.'),
    arr(
      oneOf([
        str('A region’s key, as reverse.feature.list gives the sketch’s regions.', { minLength: 1 }),
        obj({ at: vec2('A point inside the region, [u, v] mm in the sketch.') }, ['at']),
        vec2('A point inside the region, [u, v] mm — as { at: [u, v] }.'),
      ]),
      'The regions, by key or by a point inside each ({ at: [u, v] }, or [u, v] alone) — the smallest region round the point, outside its holes. A list with a point in it is kept as given, and taken again when the sketch is edited; keys alone are matched again by their pieces, or by where they lay.',
      { minItems: 1 },
    ),
  ],
  'Which of the sketch’s closed regions are the profile. Left out: the sketch’s one region, when it has exactly one. An inner loop left unpicked is a hole.',
)

/** How far from each edge a fitted round or chamfer is read. */
const fitReachIn = (what: 'round' | 'chamfer'): JsonSchema =>
  num(`With "fit": how far from each edge the scan is read, mm, as reverse.body.fillet_read takes it — it caps the ${what} read. Left out: 5 % of the part’s size, widened to 2× and 4× where a ${what} reads at the top of the search or not at all (fitted.reach then says the one that read). Not stored; a refit reads with it again.`, { exclusiveMinimum: 0 })

/** A number, or "fit": the scan's, fitted when the feature is made. */
const orFit = (n: JsonSchema, what: string): JsonSchema => oneOf([n, enumOf(['fit'], `fit: ${what} fitted to the scan — the answer's fitted gives the value, its sigma, the nominal and how many sigmas off.`)], (n as { description?: string }).description)

const extentIn = byKind(
  [
    obj({ kind: kind('distance'), from: num('mm along the sketch plane’s normal — or along direction — where the solid starts.'), to: num('mm where it ends; negative is behind the plane.') }, ['kind', 'from', 'to'], 'Between two offsets from the sketch plane.'),
    obj({ kind: kind('symmetric'), total: num('The whole length, half each side of the plane, mm.', { exclusiveMinimum: 0 }) }, ['kind', 'total']),
    obj({ kind: kind('toPlane'), from: num(), plane: planeIn }, ['kind', 'from', 'plane'], 'From an offset up to a plane.'),
    obj({ kind: kind('betweenPlanes'), a: planeIn, b: planeIn }, ['kind', 'a', 'b']),
    obj({ kind: kind('toFace'), from: num(), body: bodyRef, face: facePick }, ['kind', 'from', 'body', 'face'], 'Up to a face of a body: a flat one as its whole plane; a curved one — cylinder, cone, fitted surface — as the face it is, so a cut ends on it: sketch the region, cut up to the face, in place of a helper block cut by it and combined. Refused where the face does not lie under the whole profile, saying where.'),
    obj({ kind: kind('toBody'), from: num(), body: bodyRef, reverse: bool('Against the normal, where the body lies both ways.') }, ['kind', 'from', 'body'], 'Up to a body’s surface — a solid’s skin where the profile first meets it, or a sheet — the way the body lies from the sketch. Refused where the body does not lie under the whole profile.'),
    obj({ kind: kind('toNext'), from: num(), reverse: bool('Against the normal.') }, ['kind', 'from'], 'Until the profile first meets the body it joins or cuts.'),
    obj({ kind: kind('toLast'), from: num(), reverse: bool('Against the normal.') }, ['kind', 'from'], 'To the far end of that body — a cut through all.'),
    obj(
      { kind: kind('toScan'), from: num(), near: num('About where the end is, mm along the normal — the scan face nearest this; the farthest face capping the region (a cut: the nearest) when left out.'), reverse: bool('Against the normal.') },
      ['kind', 'from'],
      'To the scan: the end at the scan’s face capping the region, its offset fitted (stored as a distance; the answer’s fitted gives it with its sigma).',
    ),
  ],
  'How far the extrusion reaches along the sketch plane’s normal.',
)

const op = enumOf(['new', 'join', 'cut'], 'join (the default): one body with every solid it meets, a new body where it meets none; cut: out of every solid it meets; new: a body of its own.')

/** The fields each `exprs` schema names, by the schema: what a feature's
 *  `names` (core schema.ts) are made from below. */
const EXPR_SLOTS = new Map<JsonSchema, string[]>()

const exprsIn = (slots: string): JsonSchema => {
  const schema = anyObject(`Expressions driving the numbers, by field: ${slots}. Each an expression string — the parameters by name, arithmetic, units — and the number follows it; a number given for the same field without its expression lets the expression go.`)
  EXPR_SLOTS.set(schema, slots.split(' — ')[0].split(', '))
  return schema
}

const nameIn = str('The feature’s name (Extrude 2 when left out); unique across sketches and features.', { minLength: 1 })

/** A round's or a chamfer's body: a feature of several solids taken solid
 *  by solid. */
const solidsAsBody = (what: string) => `A body, by id or name. A feature that made several solids, by its id or name, with edges all queries: one ${what} per solid the query hits, named “<name> 1..n”, all or none in one undo step — the answer’s solids lists them and the solids left out, no edge answering.`

const targetIn = nullable(bodyRef, 'With op join or cut: join or cut this body alone, by id or name, not every solid it meets — a rib into one part of an assembly. null (reverse.feature.update) lets it go.')

// ---- the features ------------------------------------------------------------------------

/** Each kind of feature as it is handed in. */
export const FEATURE_IN: Record<string, JsonSchema> = {
  sketch: obj(
    {
      kind: kind('sketch'),
      name: nameIn,
      plane: planeIn,
      sketch: sketchIn,
      offset: num('reverse.feature.update only: move the sketch to this offset of its plane — a coordinate plane’s coordinate.'),
      angleDeg: num('reverse.feature.update only, a sketch on a plane through an axis (radial): turn it to this angle about the axis, as offset moves a flat one — its pieces keep their [u, v] and the features on it follow.'),
      exprs: exprsIn('offset — the plane’s offset, a coordinate plane’s coordinate: the sketch follows the parameters it reads'),
    },
    ['kind', 'plane', 'sketch'],
    'A sketch on a plane.',
  ),
  extrude: obj(
    {
      kind: kind('extrude'),
      name: nameIn,
      sketchId: featureRef('sketch'),
      regions: regionsIn,
      face: obj({ body: bodyRef, face: facePick }, ['body', 'face'], 'Pull a flat face of a body instead of a sketch’s regions.'),
      extent: extentIn,
      draftDeg: num('Degrees the sides lean in as the solid goes away from the sketch plane; 0 (the default) for straight sides. The panel shows it as a taper the other way round.'),
      direction: oneOf(
        [vec3('The way the profile is swept, [x, y, z] in the part’s frame (made unit length): an oblique prism, its ends parallel to the sketch plane — a leaning boss without a tilted sketch plane. The extent’s offsets count along it; a taper leans the sides about it (the outline in the sketch plane then strays from the sketch by up to half its length along the lean × tan(lean) × tan(taper)). It has to leave the sketch plane by 1° at least.'), { type: 'null' }],
        'The sweep’s direction; left out, the sketch plane’s normal. null (reverse.feature.update) goes back to the normal.',
      ),
      op,
      target: targetIn,
      exprs: exprsIn('extent.from, extent.to, extent.total, draftDeg'),
    },
    ['kind', 'extent'],
    'A sketch’s regions — or a body’s flat face — extruded along the sketch plane’s normal, or along a direction of its own.',
  ),
  revolve: obj(
    {
      kind: kind('revolve'),
      name: nameIn,
      sketchId: featureRef('sketch'),
      regions: regionsIn,
      axis: axisIn,
      angleDeg: num('Degrees turned: 360 (the default) for a whole turn; with a pitch, any number of turns.', { exclusiveMinimum: 0 }),
      pitch: num('mm the profile climbs along the axis every turn — a coil or a spring; 0 or left out for a plain revolve. Negative climbs against the axis.'),
      leftHanded: bool('A coil turning the other way.'),
      op,
      target: targetIn,
      exprs: exprsIn('angleDeg, pitch, turns, height'),
    },
    ['kind', 'sketchId', 'axis'],
    'A sketch’s regions turned about an axis in the sketch plane, or coiled along it with a pitch.',
  ),
  thread: obj(
    {
      kind: kind('thread'),
      name: nameIn,
      body: bodyRef,
      face: facePick,
      standard: enumOf(['metric', 'unc', 'unf', 'print45'], 'The thread form and its sizes: ISO metric (the default), Unified coarse (UNC) or Unified fine (UNF) — the 60° profile of ISO 68-1 and ASME B1.1 — or print45, a form for 3D printing: 45° flanks, a flat crest and root a fifth of the pitch each, 0.3 × pitch deep, so printed with the axis upright nothing overhangs past 45° and it needs no supports. It mates only with itself. Its sizes are Ø3 to Ø64, the ISO metric diameters, at the pitch that cuts as deep as the ISO coarse thread (Ø10 × 2.75), or at the ISO coarse pitch.'),
      size: str('A size of the standard’s table, at its first pitch unless pitch is given: "M3", "M10" for metric (the coarse pitch), "1/4", "#10" for UNC and UNF, "Ø10" or "10" for print45 (the pitch as deep as the ISO coarse thread). Or a designation with its pitch: "M10x1", "M10×1", "1/4-20 UNC".', { minLength: 1 }),
      diameter: num('The major diameter, mm — in place of a size.', { exclusiveMinimum: 0 }),
      pitch: num('The pitch, mm.', { exclusiveMinimum: 0 }),
      leftHanded: bool(),
      length: nullable(num('', { exclusiveMinimum: 0 }), 'mm along the face; null or left out runs the whole face.'),
      start: num('With a length: mm in from the face’s far end along its axis where the thread starts.', { minimum: 0 }),
      flip: bool('Count the start from the face’s other end.'),
      offset: num('A clearance for printing, mm: every face of the thread moved into the material.'),
      chamfer: bool('A 45° chamfer where the thread runs out of the body.'),
      exprs: exprsIn('diameter, pitch, length, start, offset'),
    },
    ['kind', 'body', 'face'],
    'A screw thread cut on a full round face: a bolt’s on a boss, a nut’s in a bore. The face may be drawn any size: along the thread a bore is filled in or bored out to its minor diameter and a boss built up or turned down to its major, so a Ø5 hole takes M5, M4 or M6. Without a size or a diameter it takes the standard’s size for the face, as the panel does: a boss’s by its diameter, a bore drawn at a size’s diameter (Ø5) that size, any other bore by its tap drill.',
  ),
  shell: obj({ kind: kind('shell'), name: nameIn, body: bodyRef, faces: arr(facePick, 'The faces taken away to open it; none leaves it closed and hollow. A query is kept and run again at every rebuild.'), thickness: num('The wall, mm.', { exclusiveMinimum: 0 }), exprs: exprsIn('thickness') }, ['kind', 'body', 'thickness'], 'Hollow a body to a wall.'),
  fillet: obj(
    {
      kind: kind('fillet'),
      name: nameIn,
      body: { ...bodyRef, description: solidsAsBody('round') },
      edges: arr(
        oneOf(
          [
            edgePick,
            obj(
              {
                edge: edgePick,
                radius: oneOf(
                  [
                    arr(num('mm', { exclusiveMinimum: 0 }), 'The radius at the edge’s first end, as reverse.body.describe lists its ends, then at its other.', { minItems: 2, maxItems: 2 }),
                    enumOf(['fit'], 'fit: read along the edge off the scan (reverse.body.fillet_read’s stations and linear) — one radius at both ends where its places agree within two sigmas, the line from end to end where they spread past that but lie on one; refused where they follow neither. fitted.variable.<i>.radius says which, with law [start, end].'),
                  ],
                  'The radius at the edge’s first end, then at its other — or fit.',
                ),
              },
              ['edge', 'radius'],
              'An edge rounded at a radius running evenly from the first, at its first end, to the second — in one round with the plain edges. Several on one tangent chain give a radius that changes along it (R1.1 on the sides, R1.5 across the ends): equal where two meet, an edge of the chain not given running between the radii about it.',
            ),
          ],
          'An edge at radius, or { edge, radius: [start, end] } at a varying one.',
        ),
        'The edges — by index, by fingerprint, or by a query; { edge, radius: [r1, r2] } for one at a varying radius. A query is kept and run again at every rebuild — an outline redrawn with more sides rounds them all — the fingerprints of what it found its fallback.',
        { minItems: 1 },
      ),
      radius: orFit(num('mm — the edges given plainly; needed when there are any.', { exclusiveMinimum: 0 }), 'the radius each edge reads across, the median'),
      reach: fitReachIn('round'),
      chain: bool('Round the edges tangent to them too (the default). The kernel rounds a tangent chain as one in any case.'),
      skipFailing: bool('Round what the kernel can: a tangent chain it cannot round at the radius is left out — the result’s note says which and where — in place of the whole round failing. For many edges read off a mesh, a few of which may not take it.'),
      exprs: exprsIn('radius'),
    },
    ['kind', 'body', 'edges'],
    'Round edges, at one radius or at radii that change along a chain of edges.',
  ),
  chamfer: obj(
    {
      kind: kind('chamfer'),
      name: nameIn,
      body: { ...bodyRef, description: solidsAsBody('chamfer') },
      edges: arr(edgePick, 'The edges — by index, by fingerprint, or by a query, which is kept and run again at every rebuild.', { minItems: 1 }),
      distance: orFit(num('mm — on both faces; with a mode, on the reference face.', { exclusiveMinimum: 0 }), 'an even chamfer’s distance each edge reads across, the median'),
      reach: fitReachIn('chamfer'),
      mode: enumOf(['equal', 'twoDistances', 'distanceAngle'], 'equal (the default): distance on both faces. twoDistances: distance on each edge’s reference face, distance2 on the other. distanceAngle: distance on the reference face, the chamfer at angleDeg to it.'),
      distance2: num('twoDistances: mm on the face across from the reference.', { exclusiveMinimum: 0 }),
      angleDeg: num('distanceAngle: degrees between the chamfer and the reference face, under 90.', { exclusiveMinimum: 0 }),
      flip: bool('The other face of each edge is the reference. By default it is the face the most of the edges share — a rim’s top — or, where they share none, the kernel’s first.'),
      chain: bool('Bevel the edges tangent to them too (the default).'),
      skipFailing: bool('Bevel what the kernel can: a tangent chain it cannot bevel at the size is left out — the result’s note says which and where — in place of the whole chamfer failing.'),
      exprs: exprsIn('distance, distance2, angleDeg'),
    },
    ['kind', 'body', 'edges', 'distance'],
    'Bevel edges — by one distance, by two, or by a distance and an angle.',
  ),
  hole: obj(
    {
      kind: kind('hole'),
      name: nameIn,
      body: bodyRef,
      axis: oneOf([
        obj({ kind: kind('element'), id: int('A cylinder, circle or line element, by id.'), name: str('Or its name.', { minLength: 1 }) }, ['kind'], 'A measured element’s axis, by id or name.'),
        obj({ kind: kind('face'), face: facePick }, ['kind', 'face'], 'A cylindrical face of the body.'),
        obj({ kind: kind('point'), face: facePick, at: vec3('The point on the face it is drilled from; the face’s centre when left out.') }, ['kind', 'face'], 'A flat face of the body, drilled into square to it — a boss’s top at its centre.'),
      ]),
      radius: num('mm; the face’s or element’s own when left out.', { exclusiveMinimum: 0 }),
      depth: nullable(num('', { exclusiveMinimum: 0 }), 'mm each way along the axis from its point — into the body alone from a flat face; null or left out drills through everything.'),
      insert: enumOf(INSERT_SIZES.map((z) => z.label), 'Size it for a heat-set insert (CNC Kitchen’s): the hole’s diameter, and a millimetre deeper than the insert is long — in place of radius and depth.'),
      exprs: exprsIn('diameter, depth'),
    },
    ['kind', 'body', 'axis'],
    'A hole drilled along an axis, or into a flat face — sized for a heat-set insert if asked.',
  ),
  extract: obj({ kind: kind('extract'), name: nameIn, element: oneOf([int('The element’s id.'), str('The element’s name, whole, case aside.', { minLength: 1 })], 'A plane, cylinder, cone, sphere or torus element of 3D Measure, by id or name. Or section.'), section: oneOf([int('The section’s id.'), str('The section’s name, whole, case aside.', { minLength: 1 })], 'A shadow section (section.cut { kind: "shadow" }), by id or name: its outline — the lines and arcs it was read to, holes and all — stood up along its normal through the part’s thickness, the block it draws; the body follows the shadow when it is taken again. Or element.'), thickness: num('A plane’s slab, mm (2 by default). Not a shadow’s: it is as thick as the part.', { exclusiveMinimum: 0 }), op: enumOf(['new', 'join', 'cut'], 'new (the default), join or cut.'), exprs: exprsIn('thickness') }, ['kind'], 'A measured element, or a shadow section, as a body — element or section.'),
  cutPlane: obj({ kind: kind('cutPlane'), name: nameIn, body: bodyRef, plane: planeIn, keep: enumOf([1, -1], '1 keeps the side the plane’s normal points to, −1 the other.'), exprs: exprsIn('plane.offset — the plane’s offset, a coordinate plane’s coordinate: the cut follows the parameters it reads') }, ['kind', 'body', 'plane'], 'Cut a body at a plane.'),
  mirror: obj({ kind: kind('mirror'), name: nameIn, body: bodyRef, plane: mirrorPlaneIn, join: bool('Joined with the original (the default), or a body of its own.'), exprs: exprsIn('plane.offset — the plane’s offset, a coordinate plane’s coordinate; a face of the body has none') }, ['kind', 'body', 'plane'], 'Mirror a body.'),
  boolean: obj({ kind: kind('boolean'), name: nameIn, op: enumOf(['join', 'cut', 'intersect'], 'For a sheet as the body: intersect keeps the sheet inside a solid tool, cut keeps it outside, join sews it to a sheet tool where the two meet edge to edge.'), body: bodyRef, tool: oneOf([...bodyRef.oneOf!, arr(bodyRef, 'Several, each once.', { minItems: 1 })], 'A body by id or name, or a list of them: joined all at once, or cut or intersected by each in turn.'), keep: bool('Keep the tools as bodies of their own. With a sheet as the body, a solid tool stays a body whatever this says — one outline prism trims several sheets; a sheet joined goes into the result unless kept.') }, ['kind', 'op', 'body', 'tool'], 'Combine two bodies, or a body with several tools (tool: [a, b]). A feature that made several bodies — a new extrude of four tabs — named as body or tool takes every piece. A sheet (a fitted surface, a sheet) as the body is trimmed before it is thickened: intersected with an outline prism, its ends stand square to the wall once thickened; two sheets trimmed to each other (split, keep scan) are joined into one, and thicken as one wall.'),
  sheet: obj({ kind: kind('sheet'), name: nameIn, sketchId: featureRef('sketch'), from: num(), to: num(), exprs: exprsIn('from, to') }, ['kind', 'sketchId', 'from', 'to'], 'A sketch’s pieces extruded as a surface, to split a body with.'),
  split: obj(
    { kind: kind('split'), name: nameIn, body: bodyRef, tools: arr(bodyRef, 'The sheets or bodies cutting it.', { minItems: 1 }), keep: enumOf(['scan', 'largest', 'smallest', 'between'], 'Which pieces stay: those on the scan (the default; largest and smallest say nothing of the part), the largest, the smallest — by volume, a sheet’s by area — or between: those with a face on every tool, on one side of each — the wall between two fitted skins (tools: [outer, inner]), refused where the skins meet inside the body, and for a sheet.'), tolerance: num('mm', { exclusiveMinimum: 0 }), overlap: num('', { exclusiveMinimum: 0, maximum: 1 }), within: nullable(num('', { minimum: 0 }), 'mm. Cut within the freeform fitted surfaces’ regions: each trimmed to its region’s outline grown by this much before it cuts, the body outside the outlines left as it was — only what was fitted cuts, not the margin or the carrying on. For a band or a swage across a face the rest of the part keeps. Left out (null takes it off): the whole sheet, carried on to the body’s sides.'), exprs: exprsIn('tolerance, overlap') },
    ['kind', 'body', 'tools'],
    'Split a body with sheets or bodies. A fitted surface that stops short of the body’s sides is carried on to them for the cut — a plane as itself, a freeform along its slope at its edge — so its expandPct need not reach; result.offScan says how much of the cut face then lies off the scan past each fitted surface’s region ({ tool, max, area, at }), and a warning past tolerance — split within the region where it does. A sheet as the body is trimmed: its pieces kept as a body’s fragments are, and sewn into one sheet for Thicken — a skin fitted past the part’s edge loses its overshoot with keep scan. The faces kept stay their makers’.',
  ),
  loft: obj(
    {
      kind: kind('loft'),
      name: nameIn,
      sketches: arr(featureRef('sketch'), 'The sketches in order, each giving its largest region.', { minItems: 2 }),
      sections: arr(
        oneOf([planeIn, obj({ sketch: featureRef('sketch') }, ['sketch'], 'A sketch you have — the fit.like one, say.')]),
        'reverse.feature.add only, in place of sketches: the stations in order. A plane: the scan’s run there fitted as fit says, like fit.like, into a sketch named “<name> station k”, k counting sections from 1. Or { sketch }.',
        { minItems: 2 },
      ),
      fit: { ...fitIn, description: 'How each section given as a plane is fitted, as a sketch’s fit takes it: like is required — skin: "outer" (and within, to leave the rim out) keeps a thin shell’s form. accept is taken on each station.' },
      inner: num('reverse.feature.add only: also every station moved inward by this, mm (a sketch’s inset), into sketches “<name> inner k”, and a loft through them, “<name> inner” — a body of its own: a thin shell’s inside, to cut from the outer once that is joined to the rest.', { exclusiveMinimum: 0 }),
      ruled: bool('Straight between the profiles (the default) or smooth.'),
      op,
      target: targetIn,
      exprs: exprsIn('sections.<k>.offset, inner — sections.0.offset is the first station’s plane offset (k counts from 0, as sections and sketches list them), written onto that station’s sketch as its offset; inner is the inner stations’ wall, each moved in again from its station when it comes to another number. On reverse.feature.update they go to the loft’s sketches and its inner stations'),
    },
    ['kind'],
    'A solid through two or more sketches — or, in one call, through stations fitted to the scan on planes (sections, fit.like), and with inner, a second loft through each station moved in by the wall.',
  ),
  sweep: obj(
    {
      kind: kind('sweep'),
      name: nameIn,
      profile: { ...featureRef('sketch'), description: 'The sketch whose largest region is swept, by id or name — on a plane square to the path where it starts (within 1°).' },
      path: { ...featureRef('sketch'), description: 'The sketch whose one chain of lines and arcs, end to end, the profile follows — from the end nearest the profile — by id or name. Or route.' },
      route: obj(
        {
          points: arr(vec3('[x, y, z] mm in the part’s frame.'), 'The centreline’s corners in order: the two ends, and between them where the straights either side of each bend would meet. Repeated points and corners with no turn are passed over.', { minItems: 2 }),
          bendRadius: num('The radius of every bend on the centreline, mm. A bend that does not fit its straights is refused, saying the most it takes.', { exclusiveMinimum: 0 }),
          radii: arr(nullable(num('', { exclusiveMinimum: 0 }), 'A bend’s own radius, mm, or null for bendRadius.'), 'One per inner point, in order: bends of different radii.'),
        },
        ['points', 'bendRadius'],
        'A centreline in 3D in place of path, for bends in more than one plane — a bent tube: straight lines and tangent arcs, from the end nearest the profile. Its profile stands square to it at the start with the start on it, within 0.05 mm of the plane. It moves with the part and is edited here, by reverse.feature.update.',
      ),
      op,
      target: targetIn,
      exprs: exprsIn('route.bendRadius'),
    },
    ['kind', 'profile'],
    'A profile swept along a path — a bent bar, a handle, a rim that follows a curve; the section held square to the path. Give path, a sketch, or route, a centreline in 3D.',
  ),
  thicken: obj(
    {
      kind: kind('thicken'),
      name: nameIn,
      sheet: { ...bodyRef, description: 'The sheet or fitted surface made a solid, by id or name; it stays a body of its own, put out of view.' },
      thickness: num('The wall, mm.', { exclusiveMinimum: 0 }),
      side: enumOf(['in', 'out', 'both'], 'in (the default): against the sheet’s normal (reverse.body.describe gives a face’s dir); out: along it; both: half each way.'),
      op: enumOf(['new', 'join', 'cut'], 'new (the default): a body of its own; join or cut: with every solid it meets, or with target alone.'),
      target: targetIn,
      exprs: exprsIn('thickness'),
    },
    ['kind', 'sheet', 'thickness'],
    'A sheet made a solid of a thickness — a freeform thin shell’s wall from its one skin, where shell or offsetBody fails on a loft or a fitted surface. A face bending tighter than the thickness towards the side it grows to is named with the thickness it takes; the result says the wall reached along the sheet’s edge.',
  ),
  pattern: obj(
    {
      kind: kind('pattern'),
      name: nameIn,
      body: bodyRef,
      mode: enumOf(['circular', 'linear']),
      axis: axisIn,
      count: int('Copies in all, the body itself counted.', { minimum: 2 }),
      step: num('Circular: the whole angle the copies span, degrees. Linear: the spacing, mm.', { exclusiveMinimum: 0 }),
      axis2: nullable(axisIn, 'Linear only: a second direction the row is repeated along — a grid; null for none.'),
      count2: int('Rows along axis2, the first counted.', { minimum: 1 }),
      step2: num('The spacing along axis2, mm.', { exclusiveMinimum: 0 }),
      exprs: exprsIn('count, step, count2, step2'),
    },
    ['kind', 'body', 'mode', 'axis', 'count', 'step'],
    'Copies of a body about an axis or along it — or, linear with a second direction, in a grid. Copies apart from one another are bodies of their own.',
  ),
  draft: obj(
    {
      kind: kind('draft'),
      name: nameIn,
      body: bodyRef,
      neutral: mirrorPlaneIn,
      faces: arr(facePick, 'The faces leaned. A query is kept and run again at every rebuild.', { minItems: 1 }),
      angleDeg: orFit(num('Positive leans them in, away from the neutral plane; under 89.'), 'the lean of the scan inside each face’s outline, a plane fitted and fitted again to the points about it, the median — coverage says how much of each face’s height along the pull the scan spans, warned under 50 %'),
      groups: arr(
        obj({ faces: arr(facePick, 'The faces of this group.', { minItems: 1 }), angleDeg: orFit(num('This group’s angle; under 89.'), 'this group’s faces read as angleDeg’s are') }, ['faces', 'angleDeg']),
        'More faces, each group at an angle of its own, leaned after faces in the order given — walls drafted differently in one feature. A face that meets a face leaned before it at a tangent edge is leaned with it by the kernel: picked again at the same angle it is passed over (the result’s warning says so); at another angle it is refused.',
      ),
      exprs: exprsIn('angleDeg'),
    },
    ['kind', 'body', 'neutral', 'faces', 'angleDeg'],
    'Lean faces about a neutral plane.',
  ),
  offsetBody: obj(
    {
      kind: kind('offsetBody'),
      name: nameIn,
      body: bodyRef,
      distance: num('mm all round: out, or in with a negative one. Convex edges come out rounded.'),
      keep: bool('Leave the body as it was and make the offset a body of its own (the default true) — a keep-out, or a tool to cut a pocket with clearance (boolean cut, keep). false: the body becomes the offset.'),
      exprs: exprsIn('distance'),
    },
    ['kind', 'body', 'distance'],
    'Grow a body all round by a distance, or shrink it.',
  ),
  deleteFace: obj(
    {
      kind: kind('deleteFace'),
      name: nameIn,
      body: bodyRef,
      faces: arr(facePick, 'The faces taken off: every face of what is to go — a round’s, a hole’s, a boss’s. A query is kept and run again at every rebuild, unless whole.', { minItems: 1 }),
      whole: bool('Take each face given with the rest of what it is part of, as a click in the panel does: the faces on its own surface, a round’s chain run on smoothly from a round face, and the faces those close in — a blind hole’s floor, a boss’s top (default false).'),
    },
    ['kind', 'body', 'faces'],
    'Delete faces of a body, the faces round them run on to close the gap — a fillet, a chamfer, a hole or a boss taken out of a part.',
  ),
  moveFace: obj({ kind: kind('moveFace'), name: nameIn, body: bodyRef, faces: arr(facePick, 'Flat or cylindrical faces. A query is kept and run again at every rebuild.', { minItems: 1 }), offset: num('mm along a flat face’s outward normal, or added to a cylinder’s radius.'), exprs: exprsIn('offset') }, ['kind', 'body', 'faces', 'offset'], 'Move faces of a body.'),
  moveBody: obj(
    {
      kind: kind('moveBody'),
      name: nameIn,
      bodies: arr(bodyRef, 'The bodies moved together, by name or id.', { minItems: 1 }),
      translate: vec3('mm along X, Y and Z, after the turn; [0, 0, 0] by default.'),
      rotate: vec3('Degrees about X, then about Y, then about Z — each about the part’s own axis through the pivot, right-handed; [0, 0, 0] by default.'),
      pivot: vec3('What the turn is about; the middle of the bodies’ box by default.'),
      copy: bool('Leave the bodies where they are and move copies of them, bodies of their own (default false).'),
      exprs: exprsIn('translate.x, translate.y, translate.z, rotate.x, rotate.y, rotate.z'),
    },
    ['kind', 'bodies'],
    'Move and turn bodies — or copies of them — as one: an imported part put in place, a part copied beside itself.',
  ),
  import: obj({ kind: kind('import'), name: nameIn }, ['kind'], 'A STEP file brought in as bodies — made by reverse.import.step, which takes the file; feature.update renames it.'),
  surface: obj(
    {
      kind: kind('surface'),
      name: nameIn,
      region: oneOf(
        [
          arr(int('', { minimum: 0 }), 'The scan’s vertices, by number.', { minItems: SURFACE_MIN_REGION }),
          obj({ marked: bool('true: the points scan.query { mark: true }, element.fit { mark: true } or scan.segment { mark } left marked.') }, ['marked']),
          obj(
            {
              box: boxIn,
              normal: obj({ dir: vec3('Any length.'), withinDeg: num('30 by default.', { exclusiveMinimum: 0, maximum: 180 }) }, ['dir'], 'Only the vertices facing this way.'),
              exclude: arr(boxIn, 'Boxes whose vertices are left out — a boss, a rib, a hole’s rim.'),
              limit: int(`At most this many, spread evenly; ${SURFACE_REGION_LIMIT} by default.`, { minimum: SURFACE_MIN_REGION, maximum: SURFACE_REGION_MAX }),
            },
            ['box'],
          ),
        ],
        'The scan’s points the surface is fitted through: their numbers; { marked: true }; or { box, normal?, exclude?, limit? }, read off the scan as it is added — the feature keeps the points found.',
      ),
      fit: obj(
        {
          net: nullable(obj({ u: int('', { minimum: NET_MIN }), v: int('', { minimum: NET_MIN }) }, ['u', 'v']), `The control net, ${NET_MAX} × ${NET_MAX} at most; null (the default) chooses it from the region’s size and noise.`),
          degree: int('3 by default.', { minimum: 1, maximum: 5 }),
          expandPct: num('How far past the region the surface reaches, % of its extent; 35 by default.', { minimum: 0 }),
          smoothness: num('0.01 by default; more fairs a noisy region.', { minimum: 0 }),
          robust: bool('Fit, leave out the points standing far off it (past three robust sigmas), and fit again: a rib, a boss or a stray edge in the region does not pull the surface.'),
          normal: vec3('The height direction, any length — the way the region faces: the surface is fitted as heights along it. Left out: the region’s principal normal. Give it where a curved region leans (a hump), so that it stays one height over it; a region that bends round past about 70° from it (a shell over a shoulder) is no height field — split it, or loft through stations.'),
        },
        [],
        'The panel’s defaults where left out. The answer’s result.surface gives rms, max, the net and the worst points, and pastRegion { off, at }: how far the surface stands off the scan under it past its region — the margin, a hole in the region — the most and where, warned past 0.2 mm; a split by it carries that into the part (split within keeps to the region). A robust fit’s result.surface.strays, and a fit refused for running away result.strays, name the points that are not the surface’s: [{ points, box, offMm: [least, most], why }] — a second sheet over or under it along the height direction, or points the robust fit left out far off; give each box in region.exclude and fit again.',
      ),
      shape: enumOf(['freeform', 'plane', 'cylinder']),
      constrain: anyObject('A plane’s or a cylinder’s Auto Constrain — { mode: "auto" } by default.'),
      exprs: exprsIn('region.box.min.x, region.box.min.y, region.box.min.z, region.box.max.x, region.box.max.y, region.box.max.z — the box the region is read in (region: { box }): the points are read again in it when a parameter moves it'),
    },
    ['kind', 'region'],
    'A surface fitted through a region of the scan.',
  ),
  network: obj(
    {
      kind: kind('network'),
      name: nameIn,
      nodes: arr(
        obj({ id: int('Its id, which the curves name.'), at: vec3('On the scan, mm — taken onto it again at every build.'), on: anyObject('On a body: { body, edge, t } or { body, vertex, end }.'), corner: bool('A corner of the cells it bounds, or not, over the rule (the boundary turning more than 30° there).') }, ['id', 'at']),
        'The network’s points: the curves’ ends, by id.',
      ),
      curves: arr(
        obj(
          {
            id: int('Its id, unique among the curves.'),
            from: int('The node it starts at.'),
            to: int('The node it ends at.'),
            via: arr(vec3(''), 'The grips between its ends, in order; between two points the curve follows the scan.'),
            crease: bool('The patches either side meet at an angle; absent, tangent.'),
            along: anyObject('{ body, edge }: it runs along that body’s edge (an edge fingerprint).'),
            side: anyObject('{ body, face, mode: "contact" | "tangent" }: the patch beside it meets that body’s face (a face fingerprint).'),
          },
          ['id', 'from', 'to', 'via'],
        ),
        'The curves, each between two nodes through its grips.',
      ),
      cells: arr(obj({ seed: vec3('A point inside the region filled.'), centre: vec3('A cell of three, five or six sides split from here.'), corners: arr(int(''), 'The patch’s corners, node ids in order round it: its corners however little the boundary turns there.') }, ['seed']), 'The regions filled, each by a point inside it.'),
      spans: anyObject('A strip’s span count by the id of a curve in it, as text: { "4": 6 }; a strip with none is Auto.'),
      fit: obj({ smoothness: num('0.001 by default.', { minimum: 0 }), robust: bool('Fit again without the points past three sigmas.'), tolerance: num('mm, 0.01 by default: Auto gives a strip more spans only where a patch on it strays from the scan by more than this beyond its noise, and only while that helps.', { minimum: 0 }) }, [], 'How the patches are fitted.'),
    },
    ['kind', 'nodes', 'curves', 'cells'],
    'A Patch network: curves on the scan, the regions they close filled with B-spline patches fitted together, tangent across every curve not a crease — a fitted sheet, or a solid where it closes. Made, changed and read by reverse.network.create, edit and read, from points on the scan; here as reverse.feature.list stores it, which reverse.feature.add and update take as it is — update also its name, fit, visible and suppressed alone.',
  ),
  trim: obj(
    {
      kind: kind('trim'),
      name: nameIn,
      tools: arr(oneOf([obj({ kind: kind('body'), id: bodyRef }, ['kind', 'id']), obj({ kind: kind('element'), id: oneOf([int('The element’s id.'), str('The element’s name, whole, case aside.', { minLength: 1 })], 'A plane, cylinder, cone, sphere or torus element of 3D Measure, by id or name.') }, ['kind', 'id'])]), 'The surfaces and elements closing the solid.', { minItems: 1 }),
      tolerance: num('mm', { exclusiveMinimum: 0 }),
      overlap: num('', { exclusiveMinimum: 0, maximum: 1 }),
      exprs: exprsIn('tolerance, overlap'),
    },
    ['kind', 'tools'],
    'Close surfaces into a solid against the scan.',
  ),
}

/** Each kind as an agent's call is checked against it — titled, so a
 *  refusal says which kind it was held to. */
// A name given for a number a feature drives by an expression is refused
// with the way to write it — exprs: { radius: "r" } — not as a number
// missing.
for (const schema of Object.values(FEATURE_IN)) {
  const exprs = schema.properties?.exprs
  const slots = exprs && EXPR_SLOTS.get(exprs)
  if (slots) schema.names = { field: 'exprs', slots }
}

export const featureOf = (k: string): JsonSchema => ({ ...FEATURE_IN[k], title: k })

export const FEATURE_KINDS = Object.keys(FEATURE_IN)

/** The parts the kinds share, by the names reverse.feature.schema hands
 *  them out under. */
const SHARED: Record<string, JsonSchema> = {
  plane: planeIn,
  face: facePick,
  edge: edgePick,
  where: whereIn,
  faceFingerprint,
  edgeFingerprint,
  body: bodyRef,
  feature: featureRef(),
  sketchRef: featureRef('sketch'),
  point: anchor,
  pieceId: pieceCommon.id,
  construction: pieceCommon.construction,
  fixed: pieceCommon.fixed,
  projected: pieceCommon.projected,
  source: pieceCommon.source,
  relationId: constraintCommon.id,
  inferred: constraintCommon.inferred,
  place: constraintCommon.place,
  expr: dimension('mm').expr,
  up: upIn,
  planeOffset: planeOffsetIn,
}

/** The shared parts by the names reverse.feature.schema { def } takes. */
export const SHARED_NAMES = Object.keys(SHARED)

export const sharedPart = (name: string): JsonSchema | undefined => SHARED[name]

/** How large a shared part may be, spelled out, and still be given below
 *  the part asked for; past it — a plane, a face or an edge pick, the where
 *  query — it is named by its $ref alone, and asked for on its own. */
export const REF_PAST = 1000

/** What a shared part costs as reverse.feature.schema { def } answers it. */
const refChars = new Map<string, number>()

function charsOfShared(name: string): number {
  let n = refChars.get(name)
  if (n === undefined) {
    n = JSON.stringify(handOut(SHARED[name]).schema).length
    refChars.set(name, n)
  }
  return n
}

/** A shared part named in refs: what it costs, and what it is. */
export interface RefOut {
  chars: number
  what: string
}

/**
 * A schema as it is handed out to be read: each shared part it holds more
 * than once given once, under `$defs`, and named by a `$ref` wherever it
 * comes — an extrude holds a plane three times and a face pick five, each
 * with the where query in it, which spelled out made it 35 kB. A small part
 * named once stays where it is. A large one (past REF_PAST) below the part
 * handed out is not given at all, once or often: it is named by its $ref,
 * and `refs` lists it with its size and what it is, to be asked for on its
 * own (reverse.feature.schema { def }) — a sketch's plane spelled out held a
 * face pick and the where query in it, 12 k for the 4 k a plane is. The
 * shape a command holds its input to stays whole; this is the copy an agent
 * reads.
 */
export function handOut(schema: JsonSchema): { schema: Record<string, unknown>; refs: Record<string, RefOut> } {
  const shared = SHARED
  const names = new Map(Object.entries(shared).map(([name, s]) => [JSON.stringify(s), name]))
  const defs: Record<string, unknown> = {}
  const factor = (v: unknown, root = false): unknown => {
    if (v === null || typeof v !== 'object') return v
    const name = root ? undefined : names.get(JSON.stringify(v))
    if (name) {
      if (!(name in defs)) {
        defs[name] = null
        defs[name] = factor(shared[name], true)
      }
      return { $ref: `#/$defs/${name}` }
    }
    return Array.isArray(v) ? v.map((x) => factor(x)) : Object.fromEntries(Object.entries(v).map(([k, x]) => [k, factor(x)]))
  }
  let body = factor(schema, true) as Record<string, unknown>
  // The large parts are named, not given — what they hold with them.
  const large = new Set(Object.keys(defs).filter((name) => charsOfShared(name) > REF_PAST))
  for (const name of large) delete defs[name]
  // A part named only once is put back where it is named — a fingerprint
  // only the face pick holds is read there — and one named nowhere now (in
  // a large part only) goes.
  const uses = new Map<string, number>()
  const tally = (v: unknown) => {
    if (v === null || typeof v !== 'object') return
    const ref = (v as { $ref?: unknown }).$ref
    if (typeof ref === 'string') uses.set(ref, (uses.get(ref) ?? 0) + 1)
    for (const x of Object.values(v)) tally(x)
  }
  for (;;) {
    uses.clear()
    tally(body)
    tally(defs)
    const unused = Object.keys(defs).filter((name) => !uses.has(`#/$defs/${name}`))
    for (const name of unused) delete defs[name]
    const once = Object.keys(defs).find((name) => uses.get(`#/$defs/${name}`) === 1)
    if (!once) {
      if (unused.length > 0) continue
      break
    }
    const def = defs[once]
    delete defs[once]
    const put = (v: unknown): unknown =>
      v === null || typeof v !== 'object'
        ? v
        : (v as { $ref?: unknown }).$ref === `#/$defs/${once}`
          ? def
          : Array.isArray(v)
            ? v.map(put)
            : Object.fromEntries(Object.entries(v).map(([k, x]) => [k, put(x)]))
    body = put(body) as Record<string, unknown>
    for (const name of Object.keys(defs)) defs[name] = put(defs[name])
  }
  const refs = Object.fromEntries(
    [...large].filter((name) => uses.has(`#/$defs/${name}`)).map((name) => [name, { chars: charsOfShared(name), what: firstSentence(shared[name].description) }]),
  )
  return { schema: Object.keys(defs).length > 0 ? { ...body, $defs: defs } : body, refs }
}

/** A description's first sentence, as refs lists a part by. */
function firstSentence(text: string | undefined): string {
  const t = text ?? ''
  const end = t.search(/[.:;—](\s|$)/)
  return end > 0 ? t.slice(0, end).trim() : t
}

/** What feature.add lists: the kind and its name, the kind's other fields
 *  left open — checked against the kind's whole shape (featureOf) when the
 *  command runs, and given with an example by reverse.feature.schema. */
export const featureInBrief: JsonSchema = {
  type: 'object',
  description:
    'The feature as reverse.feature.list shows one, less its id: kind, an optional name and the kind’s fields (reverse.feature.schema { kind } gives them with an example). The usual: sketch { plane, sketch: { fit?, entities, shapes, constraints } }, extrude { sketchId, extent, op? }, revolve { sketchId, axis, op? }, thread { body, face, size }, fillet { body, edges, radius }, chamfer { body, edges, distance }, shell { body, faces, thickness }, hole { body, axis, radius?, depth? }.',
  properties: {
    kind: enumOf(FEATURE_KINDS, 'What the feature is.'),
    name: nameIn,
  },
  required: ['kind'],
  additionalProperties: true,
}

/** A worked example of the commonest kinds, as feature.add takes them —
 *  what reverse.feature.schema hands out beside the shape. Each is held to
 *  its kind's schema by the tests. */
export const FEATURE_EXAMPLES: Record<string, Record<string, unknown>> = {
  sketch: {
    kind: 'sketch',
    name: 'Pin profile',
    plane: { kind: 'world', axis: 'x' },
    sketch: {
      shapes: [{ kind: 'rectangle', id: 1, from: [0, 0], to: [1.5, 10] }],
      constraints: [
        { kind: 'collinear', line: 4, on: { datum: 'zx' } },
        { kind: 'collinear', line: 1, on: { datum: 'xy' } },
        { kind: 'length', entity: 1, value: 1.5 },
        { kind: 'length', entity: 2, expr: 'l1' },
      ],
    },
  },
  extrude: { kind: 'extrude', name: 'Plate', sketchId: 'Plate outline', regions: 'all', extent: { kind: 'distance', from: 0, to: 5 }, op: 'new', exprs: { 'extent.to': 'thickness' } },
  revolve: { kind: 'revolve', sketchId: 'Pin profile', axis: { kind: 'sketchLine', entity: 4 }, angleDeg: 360, op: 'new' },
  thread: { kind: 'thread', body: 'Solid 1', face: 1, size: 'M3', chamfer: true },
  fillet: { kind: 'fillet', body: 'Solid 1', edges: [4], radius: 0.5 },
  chamfer: { kind: 'chamfer', body: 'Solid 1', edges: [0], distance: 0.3 },
  shell: { kind: 'shell', body: 'Solid 1', faces: [2], thickness: 1.2 },
  hole: { kind: 'hole', body: 'Solid 1', axis: { kind: 'point', face: 5 }, insert: 'M3' },
  thicken: { kind: 'thicken', name: 'Flange', sheet: 'Flange skin', thickness: 1.8, side: 'in' },
  loft: {
    kind: 'loft',
    name: 'Wing',
    sections: [{ sketch: 'Wing 1' }, ...[20, 40, 60].map((offset) => ({ kind: 'world', axis: 'z', offset }))],
    fit: { like: 'Wing 1', skin: 'outer', within: { min: [-80, -13], max: [80, 60] } },
    inner: 2,
    ruled: false,
  },
}

/** What each example shows, read with it. */
export const EXAMPLE_NOTES: Record<string, string> = {
  sketch: 'Half a pin’s profile on the YZ plane (u = Y, v = Z): a rectangle, its sides 1 to 4 the bottom, right, top and left, joined and held level and upright as drawn; the left side on the Z axis (collinear with the XZ plane’s line), the bottom on the XY plane, the radius 1.5 mm and the length the parameter l1 — fully defined. Revolve it about side 4. A grid of holes would be one circle and a pattern: patterns: [{ kind: "rectangular", pieces: [5], step: [10, 0], count: 4 }].',
  extrude: 'Every closed region of the sketch "Plate outline", 0 to 5 mm along its normal as a body of its own, the 5 driven by the parameter "thickness".',
  revolve: 'The sketch above turned a whole turn about its line 4, the Z axis. Give pitch to coil it instead.',
  thread: 'An M3 thread on face 1 of Solid 1 — a round face reverse.body.describe lists as a cylinder of Ø3, side boss — the whole face long, chamfered where it runs out.',
  fillet: 'Edge 4 of Solid 1, by its index in reverse.body.describe, rounded 0.5 mm, and the edges tangent to it with it.',
  chamfer: 'Edge 0 of Solid 1 bevelled 0.3 mm.',
  shell: 'Solid 1 hollowed to a 1.2 mm wall, open at its face 2.',
  thicken: 'The fitted surface “Flange skin” made a 1.8 mm wall against its normal — inward, where the skin was fitted to the part’s outside — as a body of its own. Trim the skin first — a boolean intersect with the outline prism, or a split keeping what lies on the scan — so the wall’s ends stand square to it. With an outer and an inner skin both fitted, split a block by tools [outer, inner] with keep "between" instead.',
  loft: 'A moulded wing lofted smooth through four stations: “Wing 1”, its outer skin fitted on the plane z = 0 and closed by a line across the ends of its walls, and the scan’s outer skin at z = 20, 40 and 60 (the rim below v = −13 left out) fitted like it — the same lines and arcs in the same order, tangent where it is, its base line copied — into “Wing station 2” to “Wing station 4”. With inner, every station moved in by the 2 mm wall, its base line kept, into “Wing inner 1” to “Wing inner 4”, lofted into “Wing inner”, a body of its own to cut from the wing.',
  hole: 'A hole for an M3 heat-set insert — Ø4.0, 6.7 deep — drilled into Solid 1’s flat face 5 at its centre, as on a standoff’s top. For a plain hole along a round face: axis { kind: "face", face }, radius, depth (null: through).',
}

/** A kind's fields, none of them required — what an update may set. */
export function partialOf(schema: JsonSchema): JsonSchema {
  const { required: _required, ...rest } = schema
  void _required
  return rest
}

export const parameterKind = enumOf(['length', 'angle', 'integer', 'number'], 'What the parameter is: a length in mm (the default), an angle in degrees, a whole number, or a plain number.')
