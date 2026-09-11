# Changelog

What changed in ScanRuler, newest first. The number a build reports in the top
bar and the imprint is the entry it belongs to; the `.scanruler` projects it
saves carry the same number as `appVersion`. How a release is cut is in the
README under "Releases".

## Unreleased

- **Alignment** is what the 2D sheet's *Datum* is called now, and it does
  what the name says: the moment the +X pick lands, the sheet rolls square to
  the part — +X to the right of the screen — in place, keeping the zoom and
  what is under the eye, instead of leaving the scan lying as it was scanned
  with a tilted grid drawn over it. Rotate 90° turns the sheet on top of that,
  the loupe turns with it, and Export SVG writes the drawing aligned the same
  way, so a part aligned along a reference edge comes into CAD square. The
  report and the CSV call the frame the *aligned part frame*.
- **A section's sheet is not a white card any more.** The cut lies straight
  on the stage, in 2D Measure as in 3D; the plane it used to be drawn on is
  still there to click and to frame, only unseen. The alignment grid on a
  section rules the whole view rather than stopping at that plane's edge.
- **Settings** — a dialog of its own, opened with **⚙ Settings** in the top
  bar, for what is set once and left: the **interface** (whatever the
  operating system says, which is the default, or light or dark regardless),
  the **colour mode** the part is shown in (Studio grey / Scanner blue — what
  the status strip used to call *View*), the **mouse controls**, how heavy
  the **section cuts**, the **2D fitted curves** and the **2D edges** are
  drawn, and the **guided hints**. All of it is remembered per browser, and
  none of it is saved with a project.
- **Dark mode** — the whole chassis, the stage behind the part included, in
  every viewport: the split view's halves, the point picker and the 2D sheet
  go dark together. Nothing that carries a reading changes with it — the
  element tints, the deviation and thickness ramps and the axis colours are
  the same on both — and a dark chassis comes up dark, without a light flash
  first.
- **View bar** — the ways of looking at the part have moved off the status
  strip into the bottom-left corner of the stage, where there is room for
  words: **Transparent**, **Mesh** and **Backfaces** on the bottom row, and
  above them the workspace's own — **Labels** in 3D Measure, **Split view**
  and **Colour plot** in Surface Deviation. The support card stacks above the
  bar rather than over it.
- **Labels** is what the strip's *Overlays* has become: it puts away the name
  tags and readouts on the part and nothing else. The fitted elements, the
  sections and the dimension lines stay — hiding those is what the list's
  **Hide all** is for, and a switch that did the same thing twice over was one
  switch too many.
- **Line width** — how heavy a section's cut is drawn on the part, how heavy
  the curves fitted over a flatbed scan are, and how heavy the edge chains
  under them are, each a slider in Settings. The first two carry everything
  drawn beside them — the preview cut, the sheet's curves stood up in 3D, the
  callouts and pin marks in 2D — in proportion. The edges, which were a
  one-pixel hair whatever the screen, are drawn as proper lines now and can
  be made as heavy as the curves.
- The status strip is a status strip again: the lamp, what the tool is doing,
  the tally of what has been measured, and the imprint.

## 0.2.1 — 2026-09-10

- **3D Measure** — a section can be cut along the scan's **coordinate
  planes**: while a new section has nothing to cut across, the XY, YZ and XZ
  planes are offered through the part's centre as translucent sheets in the
  axis colours, and a click on one — or its entry in the **Cut along** box —
  takes it, the offset then being the plane's coordinate on that axis. And
  the arrow a section plane wears has become a **gizmo**: drag the arrow to
  slide the plane, drag one of the two rings to **tilt** it about one of the
  sheet's axes, through the point the gizmo sits on. A tilted plane is
  recorded with its tilt off what it was taken across, the box shows the
  angle, and **Square** turns it back.
- **2D Measure** — a **Spline** beside the other kinds: the free curve a CAD
  sketch draws through fit points, with the controls Fusion's fit-point
  spline has. Click the points in order (they snap to the edge like any
  pick), click on the curve to insert a point, drag a pin to move it, and
  drag the **tangent handle** at any point to bend the curve through it — a
  dragged tangent stays put while the rest re-solve around it for the
  smoothest curve, a click on the handle lets it go automatic again, and
  **Free tangents** frees them all. A click on the first point closes the
  curve on itself, as does **Closed curve**. It reads as its arc length, is
  drawn on a section's cut in 3D, and leaves the
  tool as a real spline: a path of cubic Béziers in the SVG, a cubic
  `B_SPLINE_CURVE_WITH_KNOTS` in the STEP file.
- **3D Measure** — what is measured on a section's sheet belongs to the
  section: the points, lines, circles and arcs fitted there in 2D Measure are
  drawn on the cut in the 3D view, in the section's colour and hidden with
  it, without readouts of their own — and **Export STEP** writes them in a
  wireframe group named after the section, as curves in the cutting plane.
  Cut a section through a bore, fit its circle on the sheet, and CAD gets a
  circle in space to sketch on. The section's row counts what was measured
  on it, and the export key is live for sections alone.
- **2D Measure** — **Export SVG** beside Export CSV: the sheet as a drawing at
  true scale, every detected edge chain as a polyline and every visible
  element as a native line, circle or arc, in layers, turned as the sheet is
  shown — for a CAD sketch to trace or a vector editor to pick apart.

## 0.2.0 — 2026-09-10

The first numbered release. Everything the app does at this point:

- **3D Measure** — spheres, cylinders, cones, planes and circles fitted to the
  scan, from picks or from surface marked by hand with window, brush and
  lasso; points, lines and planes constructed from them; distance and angle
  dimensions, an assumed dimension beside each measured one, and the GD&T form
  error of every fit. A plane or cylinder can be extended past what was
  measured, a cylinder fitted only inside its drawn span, and a section cut
  through the scan lands on the 2D sheet to be measured there. Guided 3-2-1
  datum alignment, and STEP export of the analytic geometry at measured or
  assumed size.
- **Surface Deviation** — the scan best-fitted to a nominal part loaded as a
  mesh or as a STEP file tessellated in the browser, with a local fine fit for
  one region; or the deviation from a single fitted element, optionally within
  a marked region. Colour plot over the part, pinned readings, and a
  side-by-side compare view whose two viewports move together.
- **Wall Thickness** — the part measured against itself, by ray or by sphere,
  with an opening angle for chamfers and ribs; hover readout and pins.
- **2D Measure** — a flatbed scan on a millimetre sheet: calibration with
  scanner profiles, automatic sub-pixel edge detection, snapped picks and
  edge-region fits, constructions, a two-pick datum, dimensions, counting and
  free-text notes, a report with CSV export. The sheet turns a quarter at a
  time from the datum group.
- **Projects** — the scan, the reference, the image and every measurement saved
  as one `.scanruler` file; maps are re-measured on load, so an improved
  algorithm improves an old project.
- **Viewer** — mouse schemes matching common CAD tools, tablet gestures,
  standard views on the number keys and the gizmo arrows, fit to view, colour
  schemes, transparent, mesh and backface modes, and guided hints that ring the
  control to press next.
- The app now reports its version — in the top bar, in the imprint, and in the
  projects it saves.

## 0.1.0 — August 2026

The unnumbered first release at scanruler.com: ball bars and other artefacts
measured by fitted elements, deviation from a nominal part, wall thickness,
and STEP export. Deployed from every push, so no single commit is 0.1.0; it
is everything before the first numbered release.
