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
  datums for a guided **3-2-1 alignment** into the global coordinate system, and be
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

**First time here?** An amber ring pulses around the one control to press next
— open the scan, fit an element, measure between them — and moves on by itself
as each step is done. It is read off the state of the work rather than from a
script, so doing the steps out of order or undoing one keeps it honest, and it
never rings a control that cannot be pressed yet. A workspace stops hinting
once you have carried it through on two separate visits, so a reload always
gives them back to you the first time; **◉ HINTS** in the status strip switches
the guidance off outright, and switching it back on starts it over.

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
   element stays on screen in its own colour. `Enter` or a **middle click**
   does what the confirm button of the moment does — create or save an
   element, add a dimension, apply a calibration, align the part, run the fit
   or the first measurement — in every workspace, so the hand never has to
   leave the mouse.
3. Press **New dimension**, pick the measurement type, and select the two
   elements to measure between. The value previews live; **Add dimension**
   keeps it. *Copy summary* puts everything on your clipboard.
4. Nothing is final: the **✎** key on any element or dimension row re-opens it
   in the box it was made in — see [Changing what you have
   made](#changing-what-you-have-made).

Each fitted element reports its size and its **sigma** — the RMS deviation of
the scan from the ideal geometry, i.e. how round, how cylindrical or how flat
the scanned surface actually is — plus the **form error**, the peak-to-peak
deviation over the used points, which is the number GD&T calls flatness,
cylindricity, sphericity or circularity. Cylinders also report the length and
the arc of wall the fit rests on, planes the size of the measured patch.

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

### How the part is shown

**View** in the status strip picks what the part is made of and how it is lit,
and it is remembered per browser. The stage stays the same grey either way.

**Studio grey** is the default: a matt grey part, evenly lit — the quietest
thing to lay a coloured map or an element tint over.

**Scanner blue** is the one every handheld scanner's own software puts on
screen: a glossy blue part under a hard light. It is worth switching to whenever
you are looking at the *surface* rather than at a measurement. A tight specular
highlight travelling over the part is the best way there is to see the shape of
it, and tool marks, print layers, the faceting of a coarse mesh and the ripple
of a bad scan all show up in that highlight long before they show up in matt
shading. Every viewport follows — the reference half of the split view and both
halves of the point picker with it.

Nothing measured changes colour with the scheme. The element tints, the
deviation and thickness ramps and the grey a map paints where nothing was
measured are all exactly the same in both: a reading that shifted with the
lighting would be worth nothing. What does change is the reference *where it is
overlaid on the scan* — amber against a blue scan instead of blue against a grey
one, since its whole job there is to not look like the part underneath it.

Given a frame of its own it needs no such contrast, and is better without it: in
the split view and in both halves of the point picker the reference is the same
material as the scan, in the scheme's own bare-surface colour, so the only thing
that differs between the two pictures is the shape.

### Elements: fitted, picked and constructed

Elements don't have to come from the scan surface. Every element type offers a
choice of creation methods:

| Element | Created by |
| --- | --- |
| **Point** | pick on the scan surface · typed-in coordinates · midpoint of two points · intersection of a line/axis with a plane |
| **Line** | through two points · a cylinder's axis · intersection of two planes |
| **Plane** | fit to the scan · through three points · offset from a plane · midplane of two planes · typed-in normal + point |
| **Sphere, Cylinder** | fit to the scan |
| **Circle** | through **3 or more picked points** (three give the exact circle, more refine a best fit — a hole rim, a boss edge) · intersection of a plane with a cylinder or a sphere · typed-in diameter + normal + center |

Anywhere a *point* is asked for, a sphere or a circle stands in with its
center; anywhere an *axis* is asked for, a cylinder stands in with its axis —
the standard metrology reduction — and a circle offers its normal in the
dropdowns too, so a line through two circle centers or a 3-2-1 alignment off a
bore's rim needs nothing special. Constructed elements re-evaluate
automatically when a source element is re-fitted, and deleting an element
removes everything built on it.

The plane–cylinder intersection refuses a cylinder leaning more than 5°
against the plane: the section is then honestly an ellipse, and this tool does
not report an ellipse as a circle.

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

### The assumed dimension — what the feature was designed at

A hole that measures Ø 5.98 mm was almost certainly drawn at Ø 6 — and
sometimes what CAD should receive is that design value, not the scan's
verdict on this particular part. While a **sphere, cylinder or circle** is
being created or edited, an **Assumed Ø** field sits under the preview. It
starts **empty** — nothing is suggested, because a guessed design value would
reach CAD as if it had been decided. Type the drawing's value if you know it,
clear the field to take it back; a value far from the measurement (beyond
half a millimetre, or 5 % on large features) is flagged as a likely typo
rather than silently accepted, so a Ø 60 where a Ø 6 was meant cannot slip
through.

Like an extension, the assumed dimension is carried **beside** the fit, never
in it: every readout, dimension and deviation map keeps the measured
diameter. It is used in exactly one place — the STEP export writes an element
that was given one at its assumed Ø and every other element as measured —
and the copied summary reports it beside the measurement whenever the two
differ.

### Changing what you have made

Every list — elements, dimensions, in both workspaces — has a **Hide all /
Show all** key in its label row, for getting the viewport clear without
clicking eyes one by one.

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

### Aligning the part

A scan arrives in whatever coordinates the scanner happened to use. **Align
part** sets where X, Y, Z and the zero point sit on the part instead — the
classic 3-2-1 datum alignment, told as three steps in plain words. Opening
the editor puts the **datum stage** on screen: the three coordinate planes,
sized to the part and labelled with the axes, with the part centred between
them so you can see exactly where it is going.

1. **Set on a plane** — pick **3 points on one face** of the part (or use a
   measured plane or cylinder), then say which side of the part that face is:
   the *bottom* lands on the floor plane, a *front* on the front plane, and
   so on. The picked points remember which way the scanned surface faces, so
   the choice reads the same no matter the order you clicked in.
2. **Align with an axis** *(optional)* — **2 points along an edge** (or an
   element), and which way that edge should run (+X to the right, …), so the
   part cannot spin on its plane. The edge runs from your 1st point to your
   2nd.
3. **Move to zero point** *(optional)* — a point, a sphere center, or **1
   picked point** that becomes X0 Y0 Z0. A zero point on its own works too,
   when all you want is to move the origin.

The slots mix and match freely — a fitted plane for step 1, two picked points
for step 2, an existing point for zero all in one alignment. Whatever a step
fixes it also zeroes: a face set on the floor ends up at height 0, a cylinder
lands on the axis it runs along, and the zero point covers whatever is left —
as does the **first** alignment itself, which centres the part on the origin
along any coordinate still free. Fill the slots by clicking elements in the
3D view or picking points on the scan (they stay marked as *Plane 1…3, Axis
1…2, Zero* while you work). The part swings into the pose it would take as
soon as a step has what it needs, and again whenever you change a choice, so
the alignment is judged by looking at the part against the coordinate planes
rather than by applying it to find out — with the panel reading how far it
would rotate and move. Measured elements make the most accurate references —
each one averages the thousands of scan points behind its fit, where a picked
point is a single spot of scan noise.

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
hands CAD the elements in the datum system. A sphere, cylinder or circle that
was given an **Assumed Ø** when it was created goes out at that diameter;
positions, axes and everything without one are written as measured.

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

### Both parts, side by side

**◫ Split view** in the status strip puts the scan and the reference in two
viewports next to each other with one camera between them: turn, pan or zoom
either half and the other follows, whichever half the pointer is in. Because the
fit carries the scan into the reference's coordinates, both halves are showing
the same world — so a feature on the left sits exactly where its counterpart sits
on the right, and the only thing that differs between the two pictures is the
part.

The overlaid ghost stands down while the split is open: the reference has a half
of its own, and the ghost was only ever a way of getting two parts into one
frame. Everything the scan carries stays on the left — the map, the reading under
the cursor, the pinned readings, the marking tools. Nothing is picked or measured
on the reference half; it is the shape being compared against.

**Both halves are one material under one light** — the scheme's bare-surface
colour and finish on either side, rather than the ghost's contrasting blue. Two
pictures of the same part in the same grey leave the shape as the only difference
between them, which is the comparison you opened the view to make. Switch the
[colour plot](#the-colour-plot-off) off and it is exactly that; leave it on and
the map is the one thing marking the scan out from its nominal. Under **Scanner
blue** it is worth the look on its own: the highlight lies along the same edge in
both halves, scalloped into mesh facets on the scan and dead straight on the CAD
part beside it.

It does not wait for an alignment either. Opened on an unfitted pair it shows
each part where it actually is, which is how you check the reference is the part
you meant before spending a fit on it.

### The colour plot, off

**▩ Colour plot** in the status strip stops painting the map onto the scan and
leaves the bare surface. The scale goes with it — histogram, figures and all: it
is the key to colours that are no longer on the part, and being left with the
part is the whole point of switching them off. It is there for the times you want
the shape rather than the reading — the form of a face, a hole in the scan, the
marks a finish left — which is most of what the reference beside it is for.

Nothing measured is lost by not looking at it. The map is still measured
underneath, the reading under the cursor still reports it, pinned readings stay
pinned, and switching it back on brings the scale back reading exactly what it
read before — nothing is re-measured.

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
| **Range ±** | mm | Half-width of the colour scale. Defaults to the rounded 95th percentile of the absolute deviation, so a handful of outliers on a fixture edge cannot flatten the whole part to green — and never opens wider than **±1 mm** on its own, so a great many of them cannot either. A part that really is further out than that says so in the dark end caps; widen the scale by hand to read it. |
| **Bands** | — | Continuous jet, or quantised into bands when you want iso-deviation contours. |
| **Histogram** | — | The distribution, drawn beside the scale and sharing its axis, plus min / max / mean / RMS / sigma. |
| **Max search distance** | mm | How far a scan point may look for reference surface. Beyond it there is nothing to deviate from, so the surface is left plain grey and kept out of the statistics. Display only — it never affects the alignment, and moving it re-colours instantly. |
| **Tolerance ±** | mm | The band the *within ± x mm* figure under the scale counts. It does not change the colours. |
| **▩ Colour plot** | — | Whether the map is painted onto the scan at all (status strip). Off leaves the bare surface and takes the scale with it; the map stays measured, and the reading under the cursor and the pinned readings go on reporting it. |

The ramp is jet — blue through cyan, green, yellow to red — pinned so that
**zero is a saturated green**, with dark caps beyond each end so a reading that
is off-scale is never mistaken for one that is merely large.

Validated against the included test pair (`side bracket left.stl` as nominal,
`block-marius.stl` as the scan, 1.43 M triangles): the fit converges to
0.072 mm RMS, and a scan displaced by a random rotation and translation comes
back to within **0.9 µm** of the fit found in place.

## Deviation from a fitted element

Choose **Fitted element** under *Measure against* and every plane, cylinder and
sphere you measured in the Elements workspace appears on the part, each in its own
colour. **Click one on the model** — or pick it from the dropdown — and that is
the whole setup: **no reference file and no alignment**, because the element was
fitted on this scan and is already in its frame. There is no *Measure* button
either: the distance to a plane, a cylinder or a sphere is a handful of flops per
vertex, so the map is computed on the main thread and simply follows every change
to it.

The element **in use** is reduced to its outline, for two reasons. It lies exactly
on the surface being read, so a translucent body there would wash the colour the
reading is made of — and on a map the colour *is* the measurement. And an outline
is not something clicks resolve through, so a click on the map it covers still
pins a reading rather than re-selecting the element under it. The elements **on
offer** stay bodies, faded, because a body is what you can aim a click at.
*Show elements on the part* takes them all off for a clean screenshot, and with
them the clicking; an element hidden by its own eye in the Elements workspace
stays hidden here too.

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

And when the element's own bounds are still not selective enough, the
**measured region** can be narrowed by hand. *Measured region → Marked surface
only* brings out the same window / brush / lasso the fits are marked with; the
map, its statistics and the report then cover exactly the points you mark —
one pad, one land, one sector read against the element while the rest of the
surface stays out of the reading. The map follows the brush stroke by stroke,
the region survives the tools being put away *and* a change of element (so the
same patch can be read against several datums in a row), and *Everything the
element bounds* is one switch away. The report names the region and its point
count, so a restricted reading can never pass for a whole-face one.

| Control | Unit | What it does |
| --- | --- | --- |
| **Measure to** | — | The element the map is measured against. Choosing one measures it — as does clicking it on the part. |
| **Show elements on the part** | — | The candidates on the model, which is also what makes them clickable. |
| **Measured region** | — | Everything the element bounds, or only a surface marked by hand with the selection tools. |
| **Material side** | — | Which side of the element the material is on, detected from the scan. **Flip** inverts the whole map. |
| **Max search distance** | mm | How far off the element a point may be and still be measured. Display only, so it can be dialled either way with the map following immediately. How far the element reaches *sideways* is set by extending it. |
| **Surface must face the element** | ° | Leave out scan surface whose own normal points away from the element's — the far side of a wall, the back of a rib. |

Everything below that — the colour scale, the bands, the histogram, the tolerance
tally, hover readings and pinned ones, **Copy report** — is the same instrument
as for a reference part, because it is the same map.

Validated end-to-end against a generated 20 mm CAD cube
(`npm run e2e:element-deviation`): two planes fitted on two of its faces, chosen
and swapped by clicking them on the model, and the map on each reading the face as
flat to 0.000 mm, leaving the underside out while the facing filter is on, and
reporting it as exactly −20.000 mm with the filter off. The circle element and
the marked-region scope have their own script (`npm run e2e:circle`): a Ø 12
coordinate circle reading back exactly, three picks previewing a circle on the
cube's top face, and a marked window measuring only its own points — zero of
them while nothing is marked.

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

## 2D Measure: flatbed scans

Switch to the **2D Measure** workspace and drop in a flatbed scan of the part —
a PNG or JPEG, scanned face-down at the highest optical resolution you have.
The workspace measures it the way a measuring microscope would: fit points,
lines, circles and arcs to the part's edges, then measure between them. A
flatbed scanner is a surprisingly good comparator — the optics are telecentric
enough over the glass, and at 600 dpi one pixel is 42 µm with edges located to
a fraction of that.

Everything stays in this browser, like the rest of the tool. The workspace has
its own viewport: the scan lies on a millimetre sheet, y up, origin at the
bottom-left; orbit gestures pan (a sheet has no third dimension), scroll zooms
about the cursor.

### Scale, and the uncalibrated alarm

Every millimetre this workspace reports is pixels divided by a scale. Three
states, and the stage says which one you are in:

- **Nothing** — the file declares no resolution: sizes are in raw pixels.
- **Nominal** — the file's own dpi (PNG `pHYs`, JPEG JFIF) is used, and a loud
  **UNCALIBRATED** chip stays on the stage: scanner transports are off by real
  fractions of a percent, so the file's claim is a working value, not a
  measurement.
- **Calibrated** — you measured the scale off something true that was on the
  glass: two picks across a known distance, or three-plus picks around a circle
  of known diameter (a gauge pin, a coin). **Calibrate X and Y separately**
  handles the fact that the sensor axis and the transport axis err
  differently — it needs a reference laid along each axis in turn.

A measured calibration describes the scanner at one resolution, not the image:
save it as a named **scanner profile** (the one thing this app persists, in
localStorage) and apply it to every scan from that scanner. Every element's
source is recorded in image pixels, so recalibrating re-derives every fit and
dimension — nothing measured ever bakes in a stale scale.

### Edges, and the two ways to fit

On load the image is swept once for edges in a worker — Canny with automatic
thresholds, the surviving pixels linked into chains, every point refined to
subpixel by a parabola across the gradient (scanner optics blur an edge over a
few pixels, which is exactly what the parabola needs). The chains are then
judged as chains, because a real scan is full of edges no fit can use —
scanner banding, knurl texture, scratches, print: small breaks along one edge
are bridged, anything shorter than **1 mm** at the current scale is dropped,
and a chain has to keep one side brighter than the other all along its length.
That leaves a quarter to a third of the chains with every long edge intact,
point for point. They draw as a teal overlay with one sensitivity slider; on a
synthetic edge the recovery is better than a tenth of a pixel.

- **Through points** (the default): click the points yourself. Every click
  snaps to the nearest detected edge at subpixel — hold **Alt** to place the
  raw click — and a 4× loupe rides the cursor with a crosshair on the exact
  pixel. Every pin can be **dragged** afterwards, snapping as it goes, and the
  fit follows the drag.
- **From edge region**: drag a box over the edge, and every detected edge
  point inside it feeds the fit. Strays from neighbouring edges are voted out
  (LMedS consensus) before the least squares runs, so a sloppy drag over both
  sides of a bar still lands on the edge you meant. One drag is a complete
  measurement — when the detector has found the edge; where it has not, pick.

Points can also be constructed: the midpoint of two points, the center of a
circle, or the **intersection of two lines** — the corner two edges meet at,
which no scan images sharply and no click can hit.

Fits report σ and the peak-to-peak form error (straightness, circularity) like
every other fit in the tool. The panel is the 3D Measure workspace's panel with
the kinds swapped: the same kind buttons, the same draft box, and the same
element list with its **edit / hide / delete** keys — editing re-opens an
element with its pins (or its references) back on the sheet and writes the
result back under the same name and colour, so everything constructed or
dimensioned on it simply re-reads the new geometry. Dimensions get the same
row keys, and the same editor.

### Datum, dimensions, and what leaves the tool

**Set datum** gives the part its own frame: the first pick is the origin, the
second sets +X, both snapping to edges. While aiming, a millimetre grid pivots
live around the origin (the crop-tool feedback); it stays afterwards as a
toggleable overlay, spacing following the zoom on a 1-2-5 ladder. Coordinates
and line angles then read in the part's frame — distances and angles between
elements never change under a datum, which is the point of them.

**Dimensions** measure between elements: point–point and point–line distances,
the width between near-parallel lines (with the same fold-angle guards the 3D
dimensions apply), and line–line angles. They re-evaluate whenever an element
or the calibration moves.

**Copy report** puts the session on the clipboard; **Export CSV** writes the
elements and dimensions as raw numeric columns. Both open with the
traceability line — what the scale is, where it came from, and which frame
coordinates read in — because a figure without that line is how wrong numbers
get trusted.

The workspace's internals deliberately measure abstract 2D geometry, not
pixels: the scan image is one *source* of edge chains. A section cut through a
3D scan is the planned second source — the roadmap's section views will land
their polylines on this same sheet, already in millimetres, and everything
above (fits, constructions, datum, dimensions, report) applies unchanged.

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

A set of end-to-end smoke tests drives the real app in headless Chrome against
a running dev server:

```bash
node scripts/e2e-smoke.mjs      # element fitting on the ball bar
node scripts/e2e-paint.mjs      # hand-marked surface fitting + back-face tint
node scripts/e2e-deviation.mjs  # load, align, measure, split-screen picking
node scripts/e2e-local-fit.mjs  # window / brush / lasso marking + local fine fit
node scripts/e2e-align.mjs      # 3-2-1 datum alignment + STEP export round-trip
node scripts/e2e-thickness.mjs  # measure wall thickness, scale, hover and pin
node scripts/e2e-step.mjs       # STEP reference geometry, measured end to end
node scripts/e2e-split.mjs      # side-by-side compare + the colour plot off
node scripts/e2e-extend.mjs     # extending an element by field and by grip
node scripts/e2e-flat.mjs       # 2D Measure: edges, fits, calibration, datum, report
```

`e2e-step.mjs` builds its own pair rather than shipping one, so the answer is
known before the app is started: the reference is a STEP cube and the scan is a
fine mesh of the *same* cube with one face raised 0.2 mm and another sunk
0.15 mm. A correct import has to read those two numbers back off the map — sign
included — and leave the other four faces flat. It does, to 66.6 % of the scan
inside ±0.1 mm, which is exactly four faces of six.

`e2e-split.mjs` builds the same pair, and checks the split view the way you would
by eye: both halves are photographed and reduced to the share of the frame the
part covers and where that silhouette sits in it. Two viewports in one pose have
to agree on both numbers, before and after a drag in either half and after a
zoom — which is a check no amount of asserting on camera matrices would give,
since the claim being made is about what is on the screen.

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
- More element types: cones, slots
- Circles fitted to a marked surface, and datum-based GD&T (position, runout)
- Point-cloud (faceless PLY) support
- Export the coloured scan, and section views through the deviation map —
  landing their outlines on the 2D Measure sheet to be dimensioned there
- 2D Measure: slot and rectangle features, DXF export of the fitted geometry

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
