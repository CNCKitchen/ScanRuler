# ScanRuler

Check a 3D scan against what it should have been — entirely in your browser.
Three workspaces share the loaded scan:

- **Elements** — pick features and get automatically fitted **spheres,
  cylinders and planes**, construct **points, lines and planes** from them,
  and create the **distance and angle dimensions** you actually need between
  them, the way metrology software like GOM Inspect does it. Aimed at ball
  bars and other calibrated artefacts. The measured elements can serve as
  datums for a **3-2-1 alignment** into the global coordinate system, and be
  **exported as a STEP file** of analytic geometry.
- **Deviation** — best-fit the scan onto a **nominal CAD part** and paint the
  difference over it as a colour map.
- **Thickness** — paint the **wall thickness of the part itself** over it, with
  no reference model and no alignment: load one file and measure.

**Everything runs locally.** Your scan files are processed in your browser and
never leave your computer.

## Elements: fitting and measuring features

### How to use it

1. **Open** your scan (STL, PLY, or OBJ — meshes only, units assumed mm), or
   drag & drop it anywhere in the window.
2. Press **Sphere**, **Cylinder** or **Plane**, then **click a point on that
   feature** in the 3D view. The tool automatically selects the surface around
   your click — the spherical patch without leaking onto the connecting rod,
   the cylinder wall without climbing onto its end faces, the flat face without
   crossing an edge — and marks it in the colour the element will get, with the
   fit itself shown as a neutral grey ghost. If the scan of that feature is
   broken into unconnected patches, click a point on each one — every pick
   feeds the same fit. Press **Create …** when the preview looks right (*Undo
   point* drops the last pick, *Cancel* or `Esc` discards). The finished
   element stays on screen in its own colour.
3. Press **New dimension**, pick the measurement type, and select the two
   elements to measure between. The value previews live; **Add dimension**
   keeps it. *Copy summary* puts everything on your clipboard.

Each fitted element reports its size and its **sigma** — the RMS deviation of
the scan from the ideal geometry, i.e. how round, how cylindrical or how flat
the scanned surface actually is. Cylinders also report the length and the arc
of wall the fit rests on, planes the size of the measured patch.

### Elements: fitted, picked and constructed

Elements don't have to come from the scan surface. Every element type offers a
choice of creation methods:

| Element | Created by |
| --- | --- |
| **Point** | pick on the scan surface · typed-in coordinates · midpoint of two points |
| **Line** | through two points · a cylinder's axis · intersection of two planes |
| **Plane** | fit to the scan · through three points · offset from a plane · midplane of two planes · typed-in normal + point |
| **Sphere, Cylinder** | fit to the scan |

Anywhere a *point* is asked for, a sphere stands in with its center; anywhere
an *axis* is asked for, a cylinder stands in with its axis — the standard
metrology reduction. Constructed elements re-evaluate automatically when a
source element is re-fitted, and deleting an element removes everything built
on it.

### Dimensions

Measurements are created deliberately, not generated for every pair — with a
handful of elements the all-pairs list explodes, and half of it (distances
between planes that will never be parallel, say) means nothing. Following
GOM Inspect / PC-DMIS conventions:

| Dimension | Value |
| --- | --- |
| Point – Point | center distance, with signed ΔX/ΔY/ΔZ components; between two spheres also surface gap (− radii) or outer span (+ radii) |
| Point – Axis | perpendicular distance to the axis |
| Point – Plane | perpendicular distance, **signed** along the outward plane normal |
| Axis – Axis | offset of near-parallel axes, or the distance at closest approach of skew axes |
| Axis – Plane | distance from the middle of a near-parallel axis, signed |
| Plane – Plane | distance between near-parallel planes, from the center of the first |
| Angle: Axis – Axis | 0–90° |
| Angle: Axis – Plane | angle to the surface, 0–90° |
| Angle: Plane – Plane | via outward normals, 0–180° (opposing faces read 180°) |

Fitted geometry is treated as **finite**: a plane is only the patch that was
measured, an axis only the section the fit rests on. A dimension that has to
extrapolate past that — a projection landing off the measured patch, skew axes
whose closest approach lies beyond the fitted sections — says so with a
warning, or refuses the value outright when it would be meaningless (planes
more than 3° from parallel have no distance; use an angle dimension instead).

### Aligning the part (3-2-1)

A scan arrives in whatever coordinates the scanner happened to use. **Align
part (3-2-1)** sets where X, Y, Z and the zero point sit on the part instead.
Three steps, each after the first optional:

1. **Level with** — a flat face, a cylinder, a line, **or 3 points picked
   straight on the scan**. Its direction is turned exactly onto the chosen
   axis (+Z by default) and levels the part.
2. **Rotate with** *(optional)* — a second direction (element or **2 picked
   points**) so the part cannot spin around the first axis.
3. **Zero point** *(optional)* — a point, a sphere center, or **1 picked
   point** that becomes the origin.

The slots mix and match freely — a fitted plane for levelling, two picked
points for the rotation, an existing point for zero all in one alignment.
Whatever levels or rotates also sets its own zero: a levelling face ends up
at height 0, a cylinder lands on the axis it points along, and the zero point
covers whatever is left. Fill the slots by clicking elements in the 3D view
or picking points on the scan (they stay marked and labelled while you work),
with a live preview of how far the part would rotate and move. Measured
elements make the most accurate references — each one averages the thousands
of scan points behind its fit, where a picked point is a single spot of scan
noise.

**Move / rotate by numbers** does the same thing by hand: type how far to
move (mm) and turn (°) along the global axes. The part turns about the zero
point — about X, then Y, then Z — and moves after that. Useful for nudging a
part into a nicer pose, or for applying a known offset exactly.

Applying an alignment or a manual move transforms the scan **and everything
measured on it** — every element, dimension and typed-in coordinate moves
with the part, so a fitted sphere stays on its ball and every dimension keeps
its value. Re-fits after the alignment measure in the new frame. **Reset
alignment** undoes all of it at once and puts the part back exactly where the
scanner delivered it. (A scan-to-reference best fit from the Deviation
workspace was measured in the old frame and is cleared — realigning there
takes one click.)

### STEP export

**Export STEP** writes the created elements to a STEP file (ISO 10303-21,
AP214) as **analytic geometry, not tessellation**: planes as trimmed planar
patches at their measured extents, cylinders and spheres as trimmed analytic
surfaces at their fitted radii, lines as trimmed lines, points as points —
each carrying its element name. Coordinates are millimetres in the current
frame, so aligning the part first hands CAD the elements in the datum system.
The geometry is packaged as construction geometry (a `GEOMETRIC_SET`), the
form CAD packages import as reference surfaces and curves for remodelling.

The viewport uses a **parallel (orthographic) projection** so nothing is
foreshortened, and rotates freely around the model's bounding-box center with
no fixed up-axis — you can turn the part all the way over without hitting a
pole. Left-drag to rotate, right-drag to pan, scroll to zoom; the **XYZ gizmo**
in the bottom-right corner shows the current orientation.

Fitting uses a **Gaussian best-fit** (orthogonal least squares) with GOM-style
*used points* presets (all / 3σ / 2σ / 1σ, default 3σ). The initial estimate is
made robust with LMedS/RANSAC, and the point selection is a model-guided region
grow over the mesh surface with normal-direction checks — so a click anywhere
on a feature finds exactly that surface, even when it's fused to the rest of
the part. Spheres and planes are solved in closed form (algebraic fit refined
orthogonally, and the total-least-squares plane through the point cloud);
the cylinder's five degrees of freedom are solved by damped Gauss-Newton, from
a starting axis taken from the scatter of the surface normals.

Validated against GOM Inspect on a real structured-light scan: center distance
agrees within a micrometer (148.6398 mm vs 148.64 mm), with matching point
selections and fit sigma. The cylinder and plane fits are covered by unit tests
against synthetic geometry with known dimensions, since the included scan has
no such feature.

## Deviation from a nominal part

Switch to the **Deviation** workspace and it asks for the two models it needs,
in the viewport, each its own drop target — drag and drop works anywhere in the
window, and whichever slot is still empty takes the file.

Both parts are on the stage as soon as both are loaded, the reference drawn as
a translucent ghost over the scan. Press **Align automatically** and the scan
walks onto it pass by pass — the refinement streams its intermediate poses out
of the worker, which costs one matrix write per pass against tens of
milliseconds of closest-point queries.

**The reference never moves.** A nominal part is the datum a measurement is
taken *against*, so the alignment is applied to the scan and the world ends up
in the reference's coordinates. Everything measured on the scan — the deviation
map, pinned readings, and any elements fitted in the other workspace — rides
along with it, so a fitted sphere stays on the ball it was fitted to.

The map is measured as soon as the fit lands, and the reference stands down
once there is a map on the scan. Separate **Show reference** and **Show scan**
switches bring either back; with the scan switched off the reference turns
solid, which is how you check it is the right part — an aligned reference
otherwise lies inside a scan of nearly the same shape and loses the depth test
almost everywhere.

**Hover the part for the deviation under the cursor**, interpolated across the
triangle rather than snapped to a vertex, and **click to pin a reading** where
you want a number to stay.

### The best fit

The fit is **rigid — rotation and translation only, no scale**. That is
deliberate for a scanner accuracy tool: a scale error is one of the things you
are trying to see, and a 7-parameter fit would quietly absorb it.

Alignment is a point-to-plane **ICP** with adaptive outlier rejection, and the
increment is taken about the centroid of the correspondences so the solve stays
conditioned on a part sitting far from the origin. The starting pose is picked
by trying candidates and keeping whichever actually fits: the identity, which
is right whenever both files already share a frame, plus the 24 rotations that
map the scan's principal axes onto the nominal's. All 24 are needed, not just
the four sign flips, because a nearly cubic part has nearly equal principal
moments and a *partial* scan of it can rank its axes differently from the whole
part — no amount of sign flipping recovers that, the axes have to be permuted.

Candidates are scored on the mean distance from **every** sample to the
surface, capped so outliers cannot dominate. Scoring only the pairs that
survive outlier rejection — the obvious thing — is actively wrong: the cut-off
is a multiple of the median, so a pose that slides until only a well-fitting
patch still corresponds scores *better* on fewer pairs, and the fit walks off
the part chasing it.

If the automatic match fails or reports itself ambiguous, press **Align by
picking points…** for a split screen with the scan on one side and the
reference on the other, each freely rotatable. Clicks alternate — a feature on
the scan, the same feature on the reference — and three pairs are enough. The
picks only fix a coarse pose, solved in closed form by Horn's absolute
orientation, and ICP does the rest, so they only have to be roughly right.
Points that land nearly in a line are rejected as you place them: the rotation
about that line would be unconstrained.

### The map

Deviation is the **signed distance from each scan vertex to the nearest point
on the nominal surface**, positive where the scan sits outside the reference.
The scan is queried against the nominal and never the other way round, because
only the nominal is watertight and so only that direction has a well-defined
inside.

The sign comes from an **angle-weighted pseudonormal** of whichever feature the
closest point actually landed on — face, edge or vertex — not from the nearest
triangle's own normal. Against a CAD part full of sharp pockets and bores a
scanned surface projects onto those seams constantly, and signing by the face
normal speckles every edge of the map with false inside/outside flips.

Reading the map:

| Control | Unit | What it does |
| --- | --- | --- |
| **Range ±** | mm | Half-width of the colour scale. Defaults to the rounded 95th percentile of the absolute deviation, so a handful of outliers on a fixture edge cannot flatten the whole part to green. |
| **Bands** | — | Continuous jet, or quantised into bands when you want iso-deviation contours. |
| **Histogram** | — | The distribution, drawn beside the scale and sharing its axis, plus min / max / mean / RMS / sigma. |
| **Max search distance** | mm | How far a scan point may look for reference surface. Beyond it there is nothing to deviate from, so the surface is left plain grey and kept out of the statistics. Display only — it never affects the alignment, and moving it re-colours instantly. |
| **Tolerance ±** | mm | The band the *within ± x mm* figure under the scale counts. It does not change the colours. |

The ramp is jet — blue through cyan, green, yellow to red — pinned so that
**zero is a saturated green**, with dark caps beyond each end so a reading that
is off-scale is never mistaken for one that is merely large.

Validated against the included test pair (`side bracket left.stl` as nominal,
`block-marius.stl` as the scan, 1.43 M triangles): the fit converges to
0.072 mm RMS, and a scan displaced by a random rotation and translation comes
back to within **0.9 µm** of the fit found in place.

## Wall thickness

Switch to the **Thickness** workspace, load a part, and press **Measure wall
thickness**. There is no reference model and no alignment — the measurement is
of the part against itself.

### The two methods

**Ray** — from every vertex a ray is fired straight into the material along the
inward surface normal, and how far it travels before it comes out the far side
is the wall thickness there. Exact wherever the two faces of a wall are
parallel; a little long where they are not, by 1/cos of the angle between them.
It runs at roughly 150 000 vertices per second — under five seconds for a
1.4 M-triangle scan.

An **opening angle** spreads a cone of rays around the normal and takes the
shortest, which finds the narrow way across a chamfer or a tapered rib.

**Sphere** — a sphere is placed halfway along that ray and grown until it
touches. It can never read longer than the ray and usually reads shorter,
because it is not tied to the ray's direction: it finds a wedge square across,
and at the corner of a block it reports the block rather than the long diagonal
the blended normal points down. One extra closest-point query per vertex.

It is deliberately *not* the largest sphere tangent to the surface at the point.
On a mesh from CAD nearly every vertex sits on a sharp edge, and no sphere of
any size touches an edge from inside without poking out of it, so that
definition collapses to nothing over most of the part — measured, on the
included bracket, at a mean of 3.3 mm against the ray's 16.3 mm. Centring the
sphere on the crossing has no such degeneracy and gives 7.7 mm.

### What counts as the far side

Both faces of every triangle count as an exit. A scan is not reliably wound, and
a far wall whose winding disagrees with the near one would otherwise be
invisible to the ray looking for it.

A surface nearly edge-on to the ray, though, is not the other side of a wall —
it is a rib the ray is running alongside, or the rim of an open scan. **Max.
deviation of normals** is how far from squarely facing the ray a surface may be
and still count; anything flatter is stepped over and the search goes on behind
it. At the default 60° it also stops a 30° cone escaping sideways through a
convex edge, which is why those two defaults belong together.

**A ray with nothing behind it inside the search limit is left unmeasured** —
bare grey, and out of the statistics. On a closed part that is almost nothing;
on a scan of one side only, it is most of the part, and the readings you do get
are the distance across the body rather than across a wall. Wall thickness is
only meaningful on a surface that has a back to it.

### Reading the map

| Control | Unit | What it does |
| --- | --- | --- |
| **Method** | — | Ray along the normal, or the sphere across what it crossed. |
| **Max. thickness** | mm | The search stops here, and a point with nothing behind it inside the distance is left unmeasured. Defaults to a fifth of the part's bounding-box diagonal, rounded; tighten it to just past the wall you care about. |
| **Rays** / **Max. opening angle** | — / ° | The cone: how many rays, and how far off the normal they may look. |
| **Max. deviation of normals** | ° | How far the surface a ray lands on may be from facing it, before it is stepped over as not-a-wall. |
| **Thin end** / **Thick end** | mm | The two ends of the colour scale. They default to the 2nd and 95th percentile of the part, rounded — a thickness distribution has a long tail to the right, and letting it set the scale flattens every wall onto one colour. |
| **Bands** | — | Continuous, or quantised into iso-thickness bands. |
| **Histogram** | — | The distribution beside the scale, sharing its axis, plus min / max / mean / sigma. |
| **Thinner than** | mm | The wall the *under x mm* figure under the scale counts. It does not change the colours — set the thin end of the scale to it if you want the map itself to call it out. |

Everything down to **Max. deviation of normals** shapes the search, so changing
it means measuring again; everything below it is display, and takes effect as
you turn it.

The ramp is the same jet as the deviation map but **reversed: red is thin, blue
is thick**. Thickness has no signed zero to sit in the middle, and the end that
needs to shout is the thin one.

## Development

```bash
npm install
npm run dev       # local dev server
npm test          # unit tests + ballbar.stl and deviation acceptance tests
npm run build     # type-check + production build to dist/
```

The repository includes `ballbar.stl`, a real 3D scan of a ball bar used by the
acceptance test in `tests/ballbar.test.ts`, and the pair `side bracket
left.stl` / `block-marius.stl` — a nominal part and a structured-light scan of
it — used by `tests/align.test.ts`. Both files are already aligned in GOM, so
that test displaces the scan by random rigid transforms first; otherwise the
automatic match would never be asked a real question.

Four end-to-end smoke tests drive the real app in headless Chrome against a
running dev server:

```bash
node scripts/e2e-smoke.mjs      # element fitting on the ball bar
node scripts/e2e-deviation.mjs  # load, align, measure, split-screen picking
node scripts/e2e-align.mjs      # 3-2-1 datum alignment + STEP export round-trip
node scripts/e2e-thickness.mjs  # measure wall thickness, scale, hover and pin
```

## Deploying to GitHub Pages

The included workflow (`.github/workflows/deploy.yml`) builds and deploys on
every push to `main`:

1. Create a GitHub repository named `ScanRuler` (the Vite `base` path in
   `vite.config.ts` must match the repository name).
2. In the repository settings, under **Pages**, set the source to
   **GitHub Actions**.
3. Push. The site appears at `https://<user>.github.io/ScanRuler/`.

## Roadmap

- More fit methods: Chebyshev (min-zone), min-circumscribed, max-inscribed
- More element types: cones, circles, slots
- Point-cloud (faceless PLY) support
- Local best fit: align on selected datum surfaces rather than the whole part
- Export the coloured scan, and section views through the deviation map

## License

**AGPL-3.0-only** — see [LICENSE](LICENSE). Free to use, modify, self-host,
and redistribute; if you distribute it or offer it over a network — and a
browser app on any web server is offering it over a network — your version's
complete source must be available under the same terms.

Want it inside closed-source software, or hosted without publishing your
changes? **Commercial exceptions are available** — see
[COMMERCIAL.md](COMMERCIAL.md). Contributions require the CLA in
[CONTRIBUTING.md](CONTRIBUTING.md), which also documents the strict dependency
license policy (no third-party copyleft in the app — it would break the
dual-licensing model; enforced in CI by
[license-check.yml](.github/workflows/license-check.yml)).

The bundled fonts are third-party under SIL OFL 1.1 (license files alongside
them in [public/fonts/](public/fonts/)). The project name and the CNC Kitchen
name and logo are trademarks and not covered by the code license.

By [CNC Kitchen](https://www.cnckitchen.com).
