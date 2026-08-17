# ScanRuler by CNC Kitchen

**Use it live at <https://scanruler.stefan-755.workers.dev/>** — nothing to
install.

Check a 3D scan against what it should have been — entirely in your browser.
Three workspaces share the loaded scan:

- **Elements** — pick features and get automatically fitted **spheres,
  cylinders and planes**, construct **points, lines and planes** from them,
  and create the **distance and angle dimensions** you actually need between
  them, the way metrology software like GOM Inspect does it. Aimed at ball
  bars and other calibrated artefacts. The measured elements can serve as
  datums for a **3-2-1 alignment** into the global coordinate system, and be
  **exported as a STEP file** of analytic geometry.
- **Deviation** — paint how far the scan strays from what it should have been as
  a colour map over the part, measured either against a **nominal CAD part**
  (loaded as a mesh or as a **STEP file** tessellated in the browser, and
  best-fitted onto the scan) or against **one fitted element** — is this face
  flat, is this bore round, does this surface sit where the datum says.
- **Thickness** — paint the **wall thickness of the part itself** over it, with
  no reference model and no alignment: load one file and measure.

**Everything runs locally.** Your scan files are processed in your browser and
never leave your computer.

## Elements: fitting and measuring features

### How to use it

1. **Open** your scan (STL, PLY, or OBJ — meshes only, units assumed mm), or
   drag & drop it anywhere in the window. (CAD goes in the Deviation
   workspace's reference slot, which also takes STEP.)
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
4. Nothing is final: the **✎** key on any element or dimension row re-opens it
   in the box it was made in — see [Changing what you have
   made](#changing-what-you-have-made).

Each fitted element reports its size and its **sigma** — the RMS deviation of
the scan from the ideal geometry, i.e. how round, how cylindrical or how flat
the scanned surface actually is. Cylinders also report the length and the arc
of wall the fit rests on, planes the size of the measured patch.

### Marking the surface by hand

Automatic surface selection is right almost all of the time, and wrong exactly
where a scan is worst: a rounded edge that lets the region creep onto the next
face, a bore broken up by noise, a feature you deliberately want to measure on
one clean band rather than on everything the tool can reach.

Set **Surface** to *Marked by hand* in the element being created and the fit
takes what you mark, and nothing else. The tools are the same ones the
[local fine fit](#local-fine-fit) is marked with — **Navigate**, **Window**,
**Brush**, **Lasso**, the **Erase** switch, *Mark faces pointing away too* and
*Clear marking* — and they behave identically here: nothing is armed until you
pick a gesture, **left-drag marks and right-drag rubs out** while one is,
Shift-drag still orbits, and **Navigate** or `Esc` hands the plain drags back to
the camera without touching what is already marked. A second `Esc` discards the
element, the way it always has.

The **brush Ø** in millimetres sets how wide a brush stroke is — it starts sized
to the part. A ring on the surface under the cursor shows the footprint before
you commit to it, in the element's colour while marking and dark while rubbing
out. The marked surface wears the colour the element will get, the fit re-runs
each time you lift the button, and *Clear marking* starts over.

A gesture takes whole triangles — the ones it actually covers — so what lights
up is exactly what the fit is given. It never reaches through a thin wall or
around an edge either, unless you ask it to with *Mark faces pointing away too*.

Everything else is unchanged — the same Gaussian best fit, the same outlier
cut-off, the same reported sigma — so a hand-marked element and an automatic
one are the same measurement, differently aimed. Changing *Used points* re-fits
a hand-marked element on exactly the surface it was marked with.

Whichever tool you pick stays picked from one element to the next; switching
workspaces puts it back to **Navigate**, so a gesture is never holding the mouse
because of something you did somewhere else.

### Which way the surface faces

**Backfaces** in the status strip colours the far side of every triangle. A
scan is a surface, not a solid: where it has a hole, you are looking at the
inside of the wall behind it, and in plain grey that reads as part. Switched
on, it reads as a hole — which is also how an inverted normal gives itself
away.

### Elements: fitted, picked and constructed

Elements don't have to come from the scan surface. Every element type offers a
choice of creation methods:

| Element | Created by |
| --- | --- |
| **Point** | pick on the scan surface · typed-in coordinates · midpoint of two points · intersection of a line/axis with a plane |
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

### Extending a plane or a cylinder past what was measured

A fit is only as big as the surface it found: a plane stops at the edge of the
patch the scan covered, a cylinder at the ends of the band the fit rests on.
That is the right answer for a measurement and the wrong one for a datum you
are about to hand to CAD, where a face usually needs to reach past the part and
a bore needs to run through it.

While a cylinder or a plane is being created or edited, an **Extend** block
appears under the preview: **two millimetre fields for a cylinder** (one per
end) and **four for a plane** (one per edge, ±U and ±V — the patch's own two
axes). The same sides carry **grips in the viewport** — arrows on the ends of a
cylinder, bars along the edges of a plane — and dragging one types itself
straight into its field. **Make square** grows the shorter axis of a plane out
to the longer one, evenly on both sides so the patch keeps its middle; **Reset**
puts everything back on the measured surface. Negative values pull an edge back
in, as far as leaving the element a size at all.

Grips are grabbed with a plain left-drag; the camera steps aside for them the
way it does for the marking brush, and Shift-drag still orbits. While a marking
tool is armed both plain drags belong to it, so choose **Navigate** to reach the
grips.

**Nothing measured changes.** The extension is carried beside the fit, not in
it: the sigma, the reported patch size or fitted length, and the warning a
dimension gives when it leaves the measured surface all go on describing the
scan. What changes is the shape on screen and the shape in the STEP file — and
the summary notes what an extended element is *drawn* at, beside what it was
measured as.

### Changing what you have made

Every element and every dimension carries a **✎** key next to its hide and
delete keys. It re-opens the thing in the same box it was created in, with
everything it was built from already in place:

| Re-opening a… | brings back |
| --- | --- |
| fitted element | the points that were clicked on it — the fit re-runs and previews at once, so more picks or *Undo point* change the surface it rests on |
| hand-marked element | the marked surface itself, back on the part under the marking tools, ready to be added to or rubbed out |
| picked point | the point, so a click on the scan moves it |
| constructed element | its source elements and typed-in numbers, in their fields |
| dimension | its type, its two references and the sphere anchor |

The creation method can be changed on the way through — a plane fitted to the
scan can be re-made from three points — and the **Name** field renames it. What
comes out is the *same* element: same id, same colour, same place in the list.
Everything measured against it — dimensions, and constructions built on it —
re-reads the new geometry instead of being rebuilt, so correcting a bad fit
costs one edit rather than a rebuild of everything downstream. A construction
cannot be pointed at itself or at anything already built on it, so no loop can
be created. *Cancel* or `Esc` leaves the original untouched.

A dimension that changes group in the process — a distance turned into an angle
— takes the next name of the group it has become, unless you named it yourself.

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
or picking points on the scan (they stay marked as *Point 1, 2, 3* while you
work). The part swings into the pose it would take as soon as a slot has what
it needs, and again whenever you change the axis it points along, so the
alignment is judged by looking at the part rather than by applying it to find
out — with the panel reading how far it would rotate and move. Measured
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
AP214) as **analytic geometry, not tessellation**, in either of two forms —
**STEP as** beside the button picks which, and the choice is remembered.

**Solids & faces** (the default) hands CAD geometry it can build on:

| Element | Written as |
| --- | --- |
| **Plane** | a bounded planar **face** — an `ADVANCED_FACE` with four real edges, in an open shell — so it can be sketched on, offset and referenced |
| **Cylinder** | a **closed solid body**: the fitted wall, capped at both ends by flat lids |
| **Sphere** | a **closed solid ball**, two hemispheres meeting at an equator |
| **Line, Point** | a trimmed line and a point, as they always were |

Each body is its own named shape representation, tied to the part the way the
bodies of a multi-body file are, so the element names arrive in the CAD tree.

**Construction surfaces** is the older form, and still the honest one for
handing over datums: every element as a trimmed analytic surface or curve in a
single `GEOMETRIC_SET`, with no topology at all — planes as planar patches at
their extents, cylinders and spheres as trimmed surfaces at their fitted radii.
It is unmistakably reference geometry rather than a part, and the safer choice
for an importer that chokes on bodies.

Either way the size written is the size on screen, extensions included, and
coordinates are millimetres in the current frame — so aligning the part first
hands CAD the elements in the datum system.

The viewport uses a **parallel (orthographic) projection** so nothing is
foreshortened, and rotates freely around the model's bounding-box center with
no fixed up-axis — you can turn the part all the way over without hitting a
pole. Left-drag to rotate, right-drag to pan, scroll to zoom; the **XYZ gizmo**
in the bottom-right corner shows the current orientation. On a touch screen the
tablet gestures do the same three things — **one finger turns, two fingers pan
and pinch to zoom, a tap picks** — and with the marking brush armed the single
finger paints while two fingers still move the part.

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

## Deviation

The **Deviation** workspace paints how far the scan strays from what it should
have been over the part itself. **Measure against** at the top of the panel
decides what "should have been" means:

- **Reference model** — the whole nominal part, best-fitted onto the scan.
  Answers *is this the shape it was drawn as*.
- **Fitted element** — one plane, cylinder or sphere measured on this same scan
  in the Elements workspace. Answers *is this face flat, is this bore round,
  does this surface sit where the datum says*.

Both paint the same map, read through the same colour scale, with the same
statistics, pinned readings and report underneath. They differ only in what it
takes to get there — and both maps are kept, so switching between them loses
neither.

## Deviation from a nominal part

With **Reference model** chosen, an empty stage asks for the two models it needs,
each its own drop target — drag and drop works anywhere in the window, and
whichever slot is still empty takes the file. Once a part is on the stage the
prompt gets out of the way for good: whatever is still missing is asked for by
its row in the panel and a line above the model.

The scan is a mesh, as always. The reference takes a mesh too, or **a STEP file
straight from CAD** — see below.

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

### The reference straight from CAD

The nominal part is whatever the CAD system says it is, and exporting it to STL
first means choosing a tessellation in a dialog that has nothing to do with the
measurement. So the reference slot also takes **STEP** (`.step` / `.stp`,
ISO 10303-21, AP203 / AP214 / AP242): the file's exact surfaces are tessellated
here, in the browser, by [meshStep](https://github.com/CNCKitchen/meshStep).
Coordinates come out in millimetres whatever unit the file declares, so an
inch-native export needs no conversion beforehand.

How finely it is tessellated matters, because chord error is a systematic term
in every reading taken against a curved face. The tolerance is scaled to the
part — 0.01 mm on a 100 mm one, tighter on smaller — which puts it about a
tenth of what a good structured-light scanner resolves, so the conversion
disappears under the scan rather than being measured by it. The figure is
reported in the status strip and stays on the reference slot, since it is the
floor under everything the map says.

What it deliberately does *not* do is subdivide by length. Triangle count is
driven by curvature alone: a flat face is exact at two triangles however large
it is, and the usual size-adaptive default spends 238 510 triangles on a 20 mm
cube that 12 describe perfectly. A bracket arrives as a few thousand triangles
of exactly the right shape instead of a million of the same shape.

The conversion is audited, and the result is not taken on trust. A STEP file
whose faces come through with cracks or holes leaves the solid without a
reliable inside — and *inside* is where the sign of every deviation comes from
— so that is reported as an error against the reference, with the advice to
export a mesh from CAD instead. A file that only needed heuristic repair says
so more quietly, in the status strip.

A scan is never a B-rep, so the scan slot does not offer STEP and turns one
away by name if it is pushed at it; a STEP file dropped anywhere in the
Deviation workspace goes to the reference.

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

### Local fine fit

The global fit weighs every point of the scan alike, which is right until the
scan contains surface that is not the part — developer spray, print supports,
the riser it was scanned on, fixturing, geometry the reference simply does not
have. Those are fitted on purpose, they pull the whole alignment off, and no
number of passes shakes them loose.

**Local fine fit** is the second pass: mark the surface that really is the
part, and fit on that alone. It starts from the alignment already in hand and
only corrects it — it is not a way to find a pose from scratch, so run the
global fit first.

Four modes, one of which is always live:

| | |
|---|---|
| **Navigate** | Marking off. Orbit, pan and zoom exactly as everywhere else. This is what the tools open in and return to after a fit — what is already marked stays marked. |
| **Window** | Drag a rectangle. Everything inside it is marked — the fastest way to drop a riser or a whole scanned-in fixture. |
| **Brush** | Drag over the surface with a round brush of a set diameter, as in the Elements workspace. For working along an edge. |
| **Lasso** | Draw a free outline; everything it encloses is marked. For a patch of spray that follows no straight line. |

The three gestures are additive and all undone by the same gesture with the
right button (or with **Erase** switched on, or with Alt). A live gesture takes
both plain drags for as long as it is on, so **Navigate** — or `Esc`, or
clicking the live tool again — hands them straight back. Shift-drag orbits
while a gesture is live, and the middle button is untouched throughout.

`Esc` backs out one step at a time: the first press stands the gesture down and
returns the camera, the second closes the local fine fit and clears the
marking. Never both at once — `Esc` is the key you reach for to get the mouse
working again, and losing a marking to that would be a trap.

While the tools are out, the rest of the faceplate fades back: loading models,
the global fit and reading the map all belong to another step. It is a fade,
not a lock — anything there still works, and comes back to full strength under
the pointer.

**Mark faces pointing away too** decides whether a gesture reaches through the
part. Off — the default — only surface turned towards you is taken, so a window
over a closed part cannot quietly mark the far wall along with the near one.
On, the gesture goes straight through, which takes a whole rib or boss in one
sweep and is also the escape hatch for a scan whose normals are inverted. There
is no depth test behind this, only the facing test: that is how CAD selection
works everywhere, and it is why the switch exists.

**Max search distance** (1 mm by default) is a hard gate on the fit: a marked
point that finds no reference surface within it contributes nothing, and
counts against the pose exactly as a miss does. It is what stops a marked patch
from sliding onto a neighbouring feature that happens to fit it better. A
global fit already has the part within a few tenths, so a millimetre is
generous; raise it and the fine fit can find a different feature and settle
there instead. If nothing at all is in reach, the fit refuses rather than
answering.

A selection that faces essentially one way is flagged: a single flat patch
fixes the distance across itself and leaves the part free to slide along it and
to spin about its normal. Mark a second surface facing another way.

The marking excludes surface from the **fit**, never from the **reading** — the
map that follows is still measured over the whole scan, so the supports and the
spray are still coloured, just no longer voting on where the part sits.
**Back to the global fit** puts the whole-scan alignment back, exactly as it
was.

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

## Deviation from a fitted element

Choose **Fitted element** under *Measure against* and pick any plane, cylinder or
sphere you measured in the Elements workspace. That is the whole setup: **no
reference file and no alignment**, because the element was fitted on this scan
and is already in its frame. There is no *Measure* button either — the distance
to a plane, a cylinder or a sphere is a handful of flops per vertex, so the map
is computed on the main thread and simply follows every change to it.

A point and a line are not offered. The distance to them is unsigned, so there is
no zero for a scale that runs warm one way and cool the other.

Three things turn a raw closest distance into a measurement here.

**The region is the element as drawn.** A plane is infinite and a cylinder is an
endless tube; taken literally, a plane would paint a slab clean through the part.
So a vertex counts only where it falls within the element's own extent — which
is the extent the **grips** set, so extending a plane in the Elements workspace
grows the measured region with it. That is how a plane fitted on one pad becomes
a flatness map of the whole face it belongs to, and the outline drawn over the
map is exactly the boundary of what was measured.

**The sign follows the material, not the fit.** Positive deviation is always too
much material, so the tool has to know which side of the element the part is on.
It reads that off the **scan's own normals** around the element as you choose it,
because a fitted plane's normal points whichever way the fit happened to choose,
and inside a bore the material is on the *inner* side — where a raw radial
distance runs backwards. **Flip** turns it round when the detection is wrong.

**A surface facing the wrong way is not the surface being measured.** A plane
fitted on the top of a 10 mm plate reaches the underside of it, which lies
squarely inside the footprint and would be reported as ten millimetres of missing
material. **Surface must face the element** leaves it out, the same way the wall
thickness search steps over a surface that does not face back.

| Control | Unit | What it does |
| --- | --- | --- |
| **Measure to** | — | The element the map is measured against. Choosing one measures it. |
| **Material side** | — | Which side of the element the material is on, detected from the scan. **Flip** inverts the whole map. |
| **Max search distance** | mm | How far off the element a point may be and still be measured. Display only, so it can be dialled either way with the map following immediately. How far the element reaches *sideways* is set by extending it. |
| **Surface must face the element** | ° | Leave out scan surface whose own normal points away from the element's — the far side of a wall, the back of a rib. |

Everything below that — the colour scale, the bands, the histogram, the tolerance
tally, hover readings and pinned ones, **Copy report** — is the same instrument
as for a reference part, because it is the same map.

Validated end-to-end against a generated 20 mm CAD cube
(`npm run e2e:element-deviation`): a plane fitted on its top face maps the face
as flat to 0.000 mm, leaves the underside out while the facing filter is on, and
reports it as exactly −20.000 mm with the filter off.

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

Eight end-to-end smoke tests drive the real app in headless Chrome against a
running dev server:

```bash
node scripts/e2e-smoke.mjs      # element fitting on the ball bar
node scripts/e2e-paint.mjs      # hand-marked surface fitting + back-face tint
node scripts/e2e-deviation.mjs  # load, align, measure, split-screen picking
node scripts/e2e-local-fit.mjs  # window / brush / lasso marking + local fine fit
node scripts/e2e-align.mjs      # 3-2-1 datum alignment + STEP export round-trip
node scripts/e2e-thickness.mjs  # measure wall thickness, scale, hover and pin
node scripts/e2e-step.mjs       # STEP reference geometry, measured end to end
node scripts/e2e-extend.mjs     # extending an element by field and by grip
```

`e2e-step.mjs` builds its own pair rather than shipping one, so the answer is
known before the app is started: the reference is a STEP cube and the scan is a
fine mesh of the *same* cube with one face raised 0.2 mm and another sunk
0.15 mm. A correct import has to read those two numbers back off the map — sign
included — and leave the other four faces flat. It does, to 66.6 % of the scan
inside ±0.1 mm, which is exactly four faces of six.

## Deploying to Cloudflare

The app is a static Vite build (`dist/`) served by a Cloudflare Worker with no
server code — `wrangler.jsonc` holds the whole configuration. Two ways to ship
it:

- **From your machine:** `npx wrangler login` once, then `npm run deploy`
  (builds, then uploads `dist/`).
- **On every push:** in the Cloudflare dashboard, create a Worker from this
  Git repository (Workers Builds). Set the build command to
  `npm test && npm run build` — the config file supplies the rest. Pushes to
  `main` then build and deploy automatically.

Either way the site lands on a `*.workers.dev` URL — the live deployment is at
<https://scanruler.stefan-755.workers.dev/> — and a custom domain can be
attached in the Worker's settings if you have one. The GitHub Actions workflow
(`.github/workflows/ci.yml`) still runs tests and a build on every push and
pull request, so a red suite is visible before Cloudflare ships it.

## Roadmap

- More fit methods: Chebyshev (min-zone), min-circumscribed, max-inscribed
- More element types: cones, circles, slots
- Point-cloud (faceless PLY) support
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
[license-check.yml](.github/workflows/license-check.yml)). The STEP importer
[meshStep](https://github.com/CNCKitchen/meshStep) is AGPL, which the policy
otherwise forbids, and is in only because it is ours as well: a commercial
exception for this app covers it too.

The bundled fonts are third-party under SIL OFL 1.1 (license files alongside
them in [public/fonts/](public/fonts/)). The project name and the CNC Kitchen
name and logo are trademarks and not covered by the code license.

By [CNC Kitchen](https://www.cnckitchen.com).
