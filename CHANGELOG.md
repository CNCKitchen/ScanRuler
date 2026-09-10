# Changelog

What changed in ScanRuler, newest first. The number a build reports in the top
bar and the imprint is the entry it belongs to; the `.scanruler` projects it
saves carry the same number as `appVersion`. How a release is cut is in the
README under "Releases".

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
