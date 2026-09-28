# Virtual caliper — research and implementation plan

Written 2026-09-23. Research into what other scan-inspection tools call a
virtual caliper, whether ScanRuler's Elements (3D measure) workspace wants
one, and how it would be built on what is already there. Nothing here is
built yet.

## 1. What the other tools have

**ZEISS INSPECT / GOM Inspect — "Caliper distance"** (Construct → Distance).
The best-documented model, and the one this plan follows. Two points are
Ctrl-clicked on opposite sides of the part, a **direction** is chosen (an
alignment axis or a construction's direction), and the software puts two
**disc calipers** — flat jaw faces of a chosen diameter, square to the
direction — onto the surface. Each disc settles on the outermost scan point
inside its footprint (the *tangential plane*, chosen **inner** or **outer**
so it takes the lowest or the highest points), and the distance between
the two jaw planes along the direction is the reading. Options are
min / max / middle for which extreme each side uses. Forum threads make
the distinction from the plain plane-to-plane distance explicit: the
Cartesian distance between two fitted planes depends on which plane is
measured from once they are not parallel, and averages the faces; the
caliper distance takes the extreme points along one direction, like the
tool on the bench. Users reach for it when two small pads sit far apart,
when faces are off the alignment axes, and when the report has to agree
with a hand check.

**Geomagic Control X — "Virtual Caliper".** A tool of the same name exists
(3D Systems tutorial videos "Geomagic Control X — Virtual Caliper Tool");
its text could not be fetched, so this is from memory rather than from a
source: the user picks the two surfaces and a direction, sets the jaw
geometry, and the tool reports what a physical caliper would read there,
outside or inside. Control X also lists thickness, bore depth, counterbore
and countersink dimensions beside it — the dimensions a drawing carries
that are not distances between fitted features.

**PolyWorks Inspector — "caliper gauges".** Part of the *soft gauging*
family since V8 (with flush & gap and airfoil gauges): a programmable jaw
geometry that "automatically measures linear dimensions" on a point cloud
or polygonal model, with the gauge's contact algorithm scriptable.

**Artec Studio.** Linear point-to-point (and polyline) distance, geodesic
distance over the surface, sections, distance maps. No jaw simulation:
a distance is between two clicked vertices.

**Revo Measure, MeshLab, Meshmixer, CloudCompare.** Fitted features and
GD&T (Revo Measure) or point-to-point rulers; nothing caliper-like.

**Research use.** "Virtual caliper" is also the name of an MPI-IS VR body
measurement project and of the landmark-to-landmark distances that
anthropometry studies take off face and limb scans to compare against
direct caliper anthropometry. Same idea — read off the scan what the
caliper would have read — different field.

## 2. What it is, in one sentence

A caliper reading is a **local, directional, two-point, maximum-material
measurement**: two flat jaws of finite width pressed square onto the part
at one spot, reading the extreme points under the jaws. ISO 14405-1 calls
the two-point size the default size specification for exactly this reason.
Everything ScanRuler measures today is the opposite: a Gaussian fit over a
whole patch, averaged, with the form read as a separate number.

## 3. Where ScanRuler already stands

- **Surface-to-surface range** on Point – Plane, Axis – Plane and
  Plane – Plane (`core/dimensions.ts`, `range`) is a *global* bracket: the
  min and max a caliper could find anywhere over the two whole patches.
  It cannot say what the caliper reads *here*, and it cannot bridge a
  caliper across a part that has no fittable faces.
- **Ø min / max** on spheres, cylinders and circles is the same global
  bracket for a diameter. The two-point diameter at a given angle and
  depth (ovality at 0° and 90°, a printed hole's mouth versus its middle)
  is not available.
- **Thickness** workspace: the *ray* method is a two-point outside caliper
  of zero jaw width along the surface normal, at every point, as a colour
  map — with the far-side facing test in `core/thickness/thickness.ts`.
  It is not pinnable as a dimension with a nominal and a tolerance, has no
  jaw footprint, and only measures through material (never across a slot).
- **Sections + 2D Measure**: a slice through the part, measured by hand on
  the sheet. That is the way to measure a section view, but it is several
  steps for "what is the width here".
- **Infrastructure that makes this cheap**: BVH raycasting on the main
  thread (`three-mesh-bvh`, `SceneManager.pick` returns point, normal and
  vertices), the brush footprint gathers vertices within a disc on the
  surface (`viewer/marking.ts`), the deviation/thickness hover readout
  reads a value under the cursor at pointer rate (`HoverReadout`,
  `readingAt` in `App.tsx`), the dimension machinery gives any type a row,
  a pin, a limit with verdict, a summary line, hide/show, edit and project
  save, and the extend grips show how to drag a handle on the part.

## 4. Verdict: worth building, as a dimension type

Yes, at moderate cost, for these uses:

1. **Agreeing with the bench.** The first thing anyone with a new scanner
   does is hold a caliper to the part and ask why the scan disagrees. Today
   the honest answer is "the scan reports a mean, the caliper a local
   maximum" — the tool should read the local maximum too, at the spot the
   caliper was put. ScanRuler is aimed at ball bars and artefacts; a
   virtual caliper against a gauge block or a certified pin is the
   plainest scanner check there is.
2. **3D prints** (the audience): outside width over layer ridges (wide
   jaws bridge the ridges and read the tops), elephant foot at the base
   versus mid-height, a warped thin wall whose local width differs from
   the plane-to-plane average, the two-point diameter of a printed hole at
   two angles (ovality).
3. **Inside dimensions**: slot and groove width at a chosen depth, a bore's
   two-point diameter at a chosen height — the inside jaws.
4. **Parts with no faces to fit**: organic, cast, sculpted, anatomical.
   A caliper needs only a spot and a direction.

Not a new workspace and not a separate list: a **`caliper` dimension type
in the distance group** of the Elements workspace, so it inherits the
editor, the DRO row, the pin, the nominal and tolerance, the summary, the
project file and the hide/edit/delete keys.

What it must be honest about: a maximum-material reading on a noisy scan
reads the noise. A scan with 20 µm sigma pushes each jaw out by two or
three sigma, so an outside width reads roughly 0.05–0.1 mm large, an
inside width small. The reading should be shown with the footprint's
spread and point count under it, and the docs should say a caliper on a
scan reads the scan's peaks the way a real one reads burrs.

## 5. The model

A caliper is:

- a **direction** `d` (unit vector, scan frame);
- a **mode**: `outside` (jaws close onto the part from outside) or
  `inside` (jaws open against the two walls of a gap);
- two **jaw anchors** `a`, `b`: points on the scan, one per side;
- a **jaw width** `w` in mm (the disc diameter; the brush Ø slider's
  sizing rule — starts scaled to the part — fits).

Measurement, per side: take the scan vertices within radius `w / 2` of the
line through the anchor along `d`, no further than `w` from the anchor
along `d` (so the footprint never reaches the far wall), whose normal
faces the jaw (`n · d` has the right sign for the side and mode). The jaw
plane sits at the extreme of `p · d` over those points — the highest
toward the jaw for `outside`, the lowest for `inside`. The reading is the
distance between the two jaw planes along `d`. Report beside it:

- the two **contact points** (drawn as where each jaw touches);
- the **footprint spread** per side (max − min of `p · d`, and the count),
  which is the local form under the jaw;
- the **mean-to-mean** distance of the two footprints, so the local
  average sits next to the local extreme and the difference is visible;
- a **squareness warning** when the footprint's own best-fit normal is
  more than a few degrees off `d` (the caliper is not square to the face),
  reusing `PARALLEL_WARN_DEG`;
- **too few points** warning when a footprint holds fewer than ~12
  vertices (jaw narrower than the scan resolution).

With `w → 0` this is the thickness ray method; the jaw width is what turns
a two-point ray into a caliper.

**Finding the far side by itself.** After the first pick, the second
anchor is found by casting from `a`: along `−n_a` through the material for
`outside` (exit where the surface faces away, the thickness far-side
test), along `+n_a` through the air for `inside` (hit where the surface
faces back). A click on the other side overrides the found anchor. This is
what lets the tool read *live under the cursor* before anything is
clicked.

**Direction sources**, in a dropdown, default first:

1. *Surface normal* — the normal at the first pick, with the second pick's
   normal averaged in (flipped to agree). How a caliper is held.
2. *Element* — a plane's normal, a cylinder's, cone's or line's axis, a
   circle's normal: the existing `refAxis` / `refPlane` reduction. Lets a
   bore's two-point diameter be taken square to its axis.
3. *X / Y / Z* — the scan's coordinate axes, as GOM does; useful after a
   datum alignment.
4. *Between the picks* — the chord from `a` to `b`, for two hand-picked
   points with nothing better.

## 6. Where the code goes

### 6.1 Core — `src/core/caliper.ts` (pure, tested)

```ts
export type CaliperMode = 'outside' | 'inside'
export type CaliperDirection =
  | { kind: 'normal' }
  | { kind: 'element'; id: number }
  | { kind: 'world'; axis: 'x' | 'y' | 'z' }
  | { kind: 'chord' }

export interface CaliperDef {
  mode: CaliperMode
  direction: CaliperDirection
  width: number
  a: Vec3; na: Vec3   // anchor and surface normal at it, scan frame
  b: Vec3; nb: Vec3
}

/** What the mesh has to answer; the viewport's BVH answers it live, a
 *  test answers it from a fixture. */
export interface CaliperSurface {
  /** Vertices (positions and normals) within `radius` of the segment
   *  from `from` to `to`. */
  pointsNear(from: Vec3, to: Vec3, radius: number): { positions: Float32Array; normals: Float32Array }
  /** First surface along a ray that faces as asked — the thickness
   *  far-side test, lifted out of core/thickness so both use one. */
  farSide(origin: Vec3, dir: Vec3, facing: 'away' | 'back', maxDistance: number): { point: Vec3; normal: Vec3 } | null
}

export function findFarSide(def, surface): Vec3 | null
export function measureCaliper(def: CaliperDef, dir: Vec3, surface: CaliperSurface): CaliperResult
export function caliperDirection(def, elements): Vec3 | null
```

`CaliperResult` carries `reading`, `contacts: [Vec3, Vec3]`, per-side
`{ spread, count, tilt }`, `meanDistance`, `warning?`, `invalid?` — the
same shape `DimensionValue` is built from.

Tests (`tests/caliper.test.ts`, synthetic meshes via `tests/fixtures.ts`):
a flat 10 mm wall reads 10.000 both ways; a wall with 0.1 mm ridges reads
the ridge tops with a wide jaw and the local surface with a narrow one; a
slot inside reads its narrowest; a single spike vertex moves the reading
by its height (documented, not hidden); a jaw 5° off square warns; a
footprint of three points warns; `findFarSide` through a wall and across a
slot; the world/element/normal direction resolution.

Refactor: lift the facing test and `shoot` from `core/thickness/thickness.ts`
into a shared helper both call, with the thickness tests as the guard.

### 6.2 Dimension integration

- `Dimension` gains `caliper?: CaliperDef`; the `caliper` type has an empty
  `slots` array and its own editor block (see 6.3). `stem: 'Caliper'`,
  group `'distance'`, unit mm.
- Evaluation: `evaluateDimensions` takes an optional `CaliperReader`
  alongside `SurfaceSource` — a callback resolving a `CaliperDef` to a
  `CaliperResult` off the viewport's scan (set up in `app/surfaces.ts` next
  to `surfaceSource`, so it shares the scene getter and the version
  bump). A missing reader (tests, a headless summary) reads as invalid,
  not as a crash.
- `DimensionValue` from the result: `value` = reading, `segment` =
  contacts (so the existing pair overlay draws the line and the pin),
  `range` = `[min, max]` of the extreme-to-extreme and mean-to-mean
  readings, `detail` = footprint spread and count per side, `warning`.
- `core/summary.ts`: print the mode, direction, jaw width, both contacts
  and both spreads under the value.
- Project: `manifest.ts` / `validation.ts` accept the `caliper` field
  (numbers, unit vectors, mode and direction enums); nothing is cached in
  the file — the caliper is re-measured off the scan on load like a
  section is re-cut.
- Datum alignment (`transform` request bakes into the buffer): carry
  anchors and normals with the part the way sections are carried
  (`transformCut`); `surfacesMoved()` already bumps the version that
  re-evaluates dimensions.
- `SphereAnchor`-style `anchor` stays untouched; `commitDimension` copies
  the `caliper` field like `limit` and `basic`.

### 6.3 Panel — `ui/DimensionSection.tsx`

In the type dropdown under Distance: **Caliper**. When it is the type, the
slot list is replaced by:

- **Mode**: Outside / Inside (segmented, like the Erase switch).
- **Direction**: Surface normal · an element (RefSelect over planes,
  cylinders, cones, lines, circles) · X · Y · Z · Between the picks.
- **Jaw width**: NumberField in mm, sized to the part at first like the
  brush Ø, remembered from one caliper to the next in `prefsStore`.
- **Jaw A / Jaw B**: two pick rows with "pick on scan"; B says *found
  automatically* until clicked by hand.
- The live preview DRO under it (`ValueWindow`, `VerdictNote`,
  `WarningNote`) exactly as for other types; `LimitFields` unchanged, so a
  nominal and tolerance can be typed.

`New dimension` currently requires a fitted element; a caliper needs
none, so the button is enabled whenever a scan is loaded and the empty
state hint changes accordingly. The hint ring (`usePulse`) gets a
`caliper` step only if the guided flow wants it — probably not in v1.

### 6.4 Viewport

- **Live reading**: while a caliper draft is open and no jaw is pinned, the
  hover runs `findFarSide` + `measureCaliper` at the cursor and shows the
  reading in the `HoverReadout` chip (same registration as the deviation
  and thickness readouts; a null reading mutes the chip). A click pins
  jaw A; a second click on the far side overrides jaw B.
- **Drawing** (`viewer/overlays.ts`): two thin discs (or square plates) of
  diameter `w`, square to `d`, at the two jaw planes, joined by a beam
  along `d`, in the dimension's colour, the value pin at the beam's middle
  — the pair overlay handles the line and pin today; the plates are new.
  Small dots at the contact points.
- **Grip** (v2): drag the beam along the surface and the caliper
  re-measures live, as the extend grips do; drag a plate's rim to change
  the width.

### 6.5 Docs and checks

README, *Dimensions*: a **Caliper** paragraph — what it reads, outside and
inside, the direction choices, the jaw width, and the paragraph on noise
(the scan's peaks are the caliper's burrs). Extend *Comparing with a 2D
slice* with the caliper as the third way to read a width. CHANGELOG
entry. An e2e script that loads the housing fixture, pins an outside
caliper across a wall and an inside one across a slot, reads both rows
and the summary, saves and reloads the project.

## 7. Order of work and effort

1. Core module with tests, thickness far-side refactor — one session.
2. Dimension type, reader, summary, persistence, alignment carry — half a
   session.
3. Panel editor, live hover reading, plates in the viewport — one session.
4. README, CHANGELOG, e2e, hints — half a session.
5. Grip dragging and width handle — later, after use.

## 8. Open points (decide while building, none blocks the start)

- Whether the reading on a noisy footprint should offer a percentile
  ("jaws on the 99th percentile") as an option. Start without; the spread
  under the value shows the problem.
- Whether a caliper on a cylinder along an element direction should also
  be offered as a **two-point diameter** row on the element itself. Start
  as a caliper; the Diameter dimension's Ø min / max already brackets it.
- Direction default when the two picks' normals disagree by more than
  ~20° (a caliper across a corner): warn and fall back to the chord.

## Sources

- ZEISS Qualityforum, "Cartesian vs Caliper Distance":
  https://qualityforum.zeiss.com/topic/7874-cartesian-vs-caliper-distance/
- ZEISS Qualityforum, "Caliper Distance Vs. Min/Max Coordinate":
  https://qualityforum.zeiss.com/topic/23009-caliper-distance-vs-minmax-coordinate/
- Capture 3D, GOM Inspect tutorial (outer disc caliper, two points and a direction):
  https://www.ded661.inmotionhosting.com/index.php/knowledge-center/blog/tritop-photogrammetry-inspection-in-the-free-gom-inspect-software
- ZEISS, material thickness in ZEISS INSPECT (normal-direction, opening angle):
  https://www.zeiss.com/metrology/us/explore/topics/calculate-material-thickness-in-zeiss-inspect.html
- 3D Systems, "Geomagic Control X — Virtual Caliper Tool" (video):
  https://www.youtube.com/watch?v=5wA2Lxwct7A and https://www.youtube.com/watch?v=t8wtO3AhF6s
- GoMeasure3D, What's new in Control X 2020 (thickness, bore depth, counterbore dimensions):
  https://gomeasure3d.com/blog/whats-new-with-geomagic-control-x-2020-with-video-demonstrations/
- InnovMetric, PolyWorks Inspector V8 soft gauging (caliper gauges):
  https://www.polyworks.com/en-us/about/news/polyworksinspectortm-v8-offer-advanced-gdt-and-soft-gauging-capabilities-point-cloud
- PolyWorks Inspector overview (virtual gauges: caliper, flush & gap, airfoil):
  https://www.polyworks.com/en-us/products/polyworks-inspector
- Artec Studio documentation, Additional Modes (linear and geodesic distance):
  https://docs.artec3d.com/as/18/en/additional_modes.html
- Revopoint Revo Measure: https://www.revopoint3d.com/products/revo-measure
- MPI-IS "Virtual Caliper" (VR body measurement): https://virtualcaliper.is.tue.mpg.de/
- Structured-light facial scanning versus direct caliper anthropometry:
  https://www.ncbi.nlm.nih.gov/pmc/articles/PMC11358891/
