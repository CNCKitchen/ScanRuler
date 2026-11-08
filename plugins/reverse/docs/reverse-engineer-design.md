<!-- SPDX-License-Identifier: AGPL-3.0-only -->
# Reverse engineer workspace — design

Settled 2026-09-14 in a design interview. This is the agreed plan for the
fourth workspace; implementation follows it unless a decision below turns out
to be wrong in practice, in which case the decision is changed here first.

## Goal

Turn a scan into a **watertight solid body exported as STEP** that FreeCAD
and Fusion open as a solid, using the fitted elements, constructions and
sections the Elements workspace already produces, without building a full
parametric CAD. The name of the workspace is **Reverse engineer**.

## What the field does (research summary)

Every serious tool converges on one recipe: segment the mesh into regions,
fit primaries (planes, cylinders, cones) from regions that stop short of the
blends, intersect them to sharp edges, apply a CAD fillet whose radius is
*estimated from the mesh*, and check with a live deviation map. Nobody fits
fillets as measured surfaces for the final model. The workhorse for shape is
the **mesh sketch**: cut a section, auto-fit lines and arcs to the slice,
close the profile, extrude to a fitted plane.

| Tool | Approach | Kernel | Output |
| --- | --- | --- | --- |
| Geomagic Design X | Auto Segment regions → Mesh Sketch (section, Auto Sketch fits lines/arcs) → extrude/revolve; Extract primitive; fillet with *Estimate Radius from Mesh*; Accuracy Analyzer live deviation (patented) | own | history tree, LiveTransfer to CAD, STEP |
| QuickSurface | paint regions → primitives with parallel/perpendicular relations → interactive sections with constraint sketching → extrude/revolve → fillet by dragging an arrow with live deviation → Shell/Thicken | Parasolid since 2026 (replaced in-house modeller after a 12-month port) | STEP/IGES |
| Mesh2Surface (Rhino plug-in) | every parameter *Fit Driven / Zero / Custom / Other primitive*; symmetry plane by mirror overlap; extruded surface from pooled sections | Rhino | Rhino |
| Creaform VXmodel | entities only (plane, cylinder, sphere, cone, circle, slot, line, sections); no modelling | none | transfer to SolidWorks/Inventor |
| Fusion 360 | Face Groups → Convert Mesh (Prismatic) → ordinary fillet; Mesh Section Sketch + Fit Curves | own | body |
| PolyWorks Modeler, ZEISS RE, Artec Studio | primitives + sketches, hand to CAD or own sketcher | various | IGES/STEP |

Research: Kós/Martin/Várady 2000 (rolling-ball blend recovery), DeFillet
(TOG 2025), Mesh2Brep (TVCG 2025), Point2CAD (2023). Thin-wall literature
pairs opposing normals for thickness and mid-surface — the rule the Thickness
workspace already uses.

## Kernel

**occt-wasm** (npm `occt-wasm`, OCCT 8.0.1), pinned to an exact version.

- 4.7 MB brotli, loaded **lazily in a worker only when the workspace is
  entered**; the wasm is a separate file fetched by URL.
- Exposes by name everything needed: line/arc edges, wire, face, extrude,
  revolve, cut, fuse, common, fillet, chamfer, `shell(solid, facesToRemove,
  t)`, `meshShape()` with per-face triangle groups, `exportStep`/`importStep`.
  For the surface route (checked 2026-09-16 in `dist/index.d.ts`, 5.0.0):
  `halfSpace`, `split`, `intersectionCells`, `section`, `sew`,
  `sewAndSolidify`, `makeFaceOnSurface`, `healSolid`/`fixShape`,
  `filletVariable`, `thicken`, `loft`, `sweep*`, `draftPrism`,
  `linearPattern`/`circularPattern`, `bsplineSurface` (the typings say
  "from a grid of control points"; the facade shows it is
  `GeomAPI_PointsToBSplineSurface` — a surface *through* a regular grid of
  points, found 2026-09-18 building D2), `approximatePoints`,
  `projectPointOnFace`, `surfaceCurvature`. Not bound: any scattered
  point-cloud surface fit, GeomPlate.
- Requires WebAssembly tail calls: Chrome 114+, Safari 17.2+, Firefox 121+,
  Node 22+. Older browsers keep the rest of the app; the workspace says why
  it is unavailable.
- Behind a **small kernel adapter of our own** naming only the dozen
  operations used, so a breaking major (they come every few weeks) or a switch
  to `libcascade` (the maintained successor of opencascade.js, 8.2 MB) is
  contained in one file. `opencascade.js` itself is dead (no publish since
  2023). chili3d's build is not published as a package.
- Runs under Node, so kernel tests are in the normal vitest suite, loaded once
  per run.

Licence: OCCT is LGPL-2.1 with the Open CASCADE exception; the wrapper is
MIT/Apache-2.0. Obligations: a prominent notice that the product uses Open
CASCADE Technology, a pointer to OCCT and occt-wasm source, and publishing
any patches to OCCT itself. CONTRIBUTING.md §2 carries the carve-out for
runtime-loaded OCCT.

## Workspace

Fourth workspace beside Elements, Deviation and Thickness. Inputs are the
shared elements and sections; the panel holds the feature tools, the feature
list and the body list. The body is built in whatever frame the part is
currently in, so the workflow starts with the 3-2-1 alignment onto fitted
planes.

## Sketching

- **Reuse the 2D Measure sheet**, embedded in the Reverse engineer workspace
  when a sketch feature is open (the sheet is still visible in 2D Measure as
  today). No second sketcher in the 3D view.
- Sketch planes: sections, plane elements (incl. offset, midplane, symmetry
  plane), coordinate planes. **Not body faces** in v1.
- Slice chains are segmented into lines and arcs **automatically on request,
  per chain**, then fixed by hand (merge, split, refit).
- **Free geometry** (line, arc, circle, rectangle drawn by clicking, no slice
  behind it) is allowed beside fitted geometry, for the simple-CAD use and for
  features the scan missed.
- **One solver: constrained least squares.** Fitted segments keep their slice
  points as soft data; constraints and typed dimensions are hard equations;
  free geometry gets a weak "stay where drawn" term. Over-constraint is
  reported, not solved. A dimension that fights the scan shows as residual.
- Relations: coincident, horizontal, vertical, parallel, perpendicular,
  tangent, concentric, symmetric (about a sheet axis or a sketch line), fixed.
  Dimensions: length, distance, radius/diameter, angle. Not equal (later).
- Relations within the 2° Orient tolerance are inferred and shown, undoable.
- **Corners are inferred automatically**: segment ends within ~2 mm at part
  scale get coincident (+ tangent for arcs) constraints, segments are
  extended/trimmed to meet. A **Close** command walks a chain and bridges the
  remaining gaps. Fitted segments never meet by themselves: every fit stops
  short of the blend, sharp corners need the lines extended to their
  intersection, and the outer-skin trace of a thin wall must be closed across
  the wall's end.
- Per-corner control: **measured arc / sharp / typed radius**. Arcs along the
  extrusion extrude to cylindrical faces and a later shell offsets them.
- **Region picking like CAD**: the sketch is a planar graph; the extrude or
  revolve asks for its profiles and the user clicks the closed regions on
  the part, as in Fusion and Onshape — not in the sketch; an unpicked inner
  loop becomes a hole. A sketch with one region has it picked already.
- Workflow the tool guides towards on thin-walled parts: trace the **outer
  skin**, extrude, shell inward. A closed thin profile of both skins is not
  prevented.

## Features

All fit-driven with overrides, reusing the Assumed Ø / Orient mechanics and
their warnings when an override strays from the fit.

- **Extrude**: distance / to a fitted plane / a plane on each side /
  symmetric. **Revolve** about a line or cylinder axis.
- **Shell**: OCCT thick solid — pick the faces to remove on the body,
  inward only in v1, thickness suggested from the Thickness map's median
  under the removed faces.
- **Fillet / Chamfer**: picked edge sets, one radius (distance) per feature,
  tangent-chain propagation. Radius estimated from one section across the
  picked edge at its midpoint, arc fitted between the two faces, editable.
  If the estimate proves poor in practice, manual entry only.
- **Extract element**: fitted cylinder, cone, sphere, circle (its plane and
  centre) become bodies at their **fitted extents** — no automatic
  extension; the element's own Extend control sets reach; *through all* as
  an option. Planes serve as sketch planes, extrude limits and **cut by
  plane**.
- **Booleans**: every body-making feature chooses *New body / Join / Cut*;
  **explicit booleans** between named bodies as well (e.g. a fitted cylinder
  from Elements cutting a hole).
- **Mirror** a body about a plane element, joined — the payoff of the
  symmetry plane.
- **Bodies**: a body list with names and visibility like elements; export
  writes every visible body into one STEP via OCCT. Separate **Export body**
  button; the elements' own STEP export is unchanged (merging the two
  writers is later).
- **Surfaces** (decided in the phase D interview, 2026-09-18): a **Fit
  Surface** and a **Trim** are features in the same list, their results
  bodies marked `surface` — never Measure elements. A surface's region is
  a vertex set **of its own** on the feature, taking nothing from the
  elements' ownership and free to overlap a neighbour at a seam. "Expand
  by" is a **percentage of the region's extent, 35 %** to start. The
  trim's tolerance comes **from the scan's scatter** (three times what a
  section reads, between 0.05 and 0.5 mm; 0.3 mm with no section to read)
  at an overlap of one half, and a set that does not close leaves **a
  surface body of the kept faces**, its open edges lit and the remaining
  faces listed with toggles, until a surface closes it. The live map on
  a surface opens at the **same ±0.1 mm** as every feature's; the fit's
  RMS and largest residual are numbers beside it.

## Editing and rebuild

- Linear feature list, rows like element rows (edit / hide / delete), **no
  reorder**, **rollback** (later features suppressed while one is edited).
  Deleting an element or section a feature depends on is **blocked** like
  dependent elements are today.
- Picks on the body (edges, faces, boolean targets) are stored as
  **geometric fingerprints** (type, midpoint/centre, direction/normal,
  length) and re-found on rebuild; a feature **fails loudly** when its pick
  is lost, never silently drops it.
- **Rebuild on commit**, from the edited feature onward, busy overlay for
  anything over a moment. The feature being set up shows a **ghost**: the
  kernel builds its solid alone (no boolean) a few tens of milliseconds
  behind the last change, latest answer wins, and the viewport draws it
  see-through — red for a cut — with grips: an arrow on each face an
  extrude's distance sets, a ring about a revolve's axis. Dragging a grip
  writes the number; typing the number moves the grip.
- Features are saved in the project by reference; the body is rebuilt on
  load once the kernel arrives, so a project opens without waiting for it.
- Body drawn **translucent over the scan** by default; the view bar's scan
  visibility switch gives the opaque look.

## Feedback

**Live deviation map inside the workspace** — decided 2026-09-16, reversing
the 2026-09-15 decision below, after the QuickSurface study showed every
feature dialog there carrying an "Analysis 0.1 mm" check and the operator
steering by it. The patent exposure noted before is accepted. Definition:

- While a feature is being set up, its **ghost is compared to the scan**:
  the scan's vertices near the ghost are coloured by their signed distance
  to the ghost's mesh on the Deviation workspace's ramp, the rest of the
  scan stays as drawn. The editor box has a **range field** (default
  ±0.1 mm) and a switch to turn the map off. The machinery is the existing
  one — the nearest-point BVH with pseudonormal sign in
  `core/deviation/surface.ts`, `computeDeviation` on a vertex subset,
  `paintField` into `SceneManager.setFieldColors` — applied to the ghost's
  tessellation; nothing new is computed.
- Committed bodies: a **Deviation key** in the view bar colours the scan
  against all visible bodies the same way.
- **Compare in Deviation** stays for the report: it tessellates the visible
  bodies and installs them as the Deviation reference, labelled as such,
  with **identity alignment and no best fit run** — the body was built in
  the scan's frame. The user may still run a best fit there.

## Acceptance

`fridgeBracket.ply` (Revopoint scan, watertight, 175k vertices,
49 × 89 × 62 mm, not axis-aligned, walls 1.35 mm median with 1.2–1.5 mm
spread, all corners rounded, noisy: half the vertices see a 15° normal change
within 1 mm; a channel section whose web is inclined and jogs, with a hook).

End-to-end script in the style of `e2e-step.mjs`: align, sketch the outer
skin on a section, extrude between the end planes, shell inward, fillet,
export STEP, re-import through meshstep, require a **closed solid** and the
**median scan deviation within ±0.2 mm**. Manual check: FreeCAD and Fusion
open the file as one closed solid.

## Milestones

1. Kernel adapter in a worker; a hand-drawn rectangle extruded to a body;
   translucent preview; STEP export re-imported through meshstep in a unit
   test; the bracket acceptance script **written to fail**. — **Done
   2026-09-14.**
2. Fitted sketch on a section with the constrained solver, inferred corners
   and Close, region picking, extrude to fitted planes, revolve. — **Done
   2026-09-14**, with the per-feature New body / Join / Cut and the body
   list pulled forward from milestone 3 because they cost nothing once the
   booleans were in the adapter.
3. Shell, fillet and chamfer with estimated values, extracted elements,
   cut by plane, mirror, explicit booleans between named bodies, picks
   stored as fingerprints, rollback while editing, features saved in the
   project. — **Done 2026-09-16.**
4. Compare in Deviation; fillet and thickness estimates checked on the
   bracket; the bracket script passing at the ±0.2 mm bar. — **Done
   2026-09-17**, with the alignment nudge, symmetry as Mirror's default
   and the guided first project (phase C).
5. **Surface route, part one** (added 2026-09-16, see "Surface route"
   below): Fit Surface on a painted or click-grown region, automatic trim
   of a set of surfaces into a solid, fillet on the seams, the live map on
   every surface. — **Done 2026-09-18**, the torus fit pulled forward from
   milestone 6 (phase D).
6. **Surface route, part two**: Measure primitives as surfaces with Auto
   Constrain, curves drawn on the mesh, loft between curves,
   the four-sided patch with contact or tangent sides, curvature colouring
   on the scan.

## What the build taught (milestones 1–2)

Decisions that moved while building, recorded here as the plan says:

- **occt-wasm 5.0.0** is the pinned version (OCCT 8.0.1) — 5.7.1 since
  2026-10-13, the same OCCT: 5.0.0 built every two-shape boolean twice
  (the operation's constructor builds it, and `Build()` was called again),
  which 5.5.1 fixed, and every join and cut took twice as long. 5.15.0
  since 2026-11-03, for its rounds at a radius of their own on each edge
  in one call; 5.9.0 to 5.11 had measured extruded multi-span splines
  wrong. 5.15.0 integrates a freeform face's area, centroid and volume to
  about 1e-7 and its exact bounding box by subdivision, slowly: the kernel
  keeps each face's area and centroid by hash and each shape's volume by
  handle (ReKernel.faces, volumeOf), sizes go by the loose box
  (ReKernel.extent), and the page draws a body before its faces are read
  (Builder.buildDrawn, topologiesOf). The pin is
  exact on purpose, so a fix like that arrives only when someone bumps it:
  look at the wrapper's changelog now and then. The wasm is
  22 MB raw, 7 MB gzipped — not the 4.7 MB brotli the survey quoted; still
  fetched only on entering the workspace. Its `meshShape` normals are the
  surfaces' own but come out inward on faces a boolean reverses, so the
  adapter turns each face's to agree with its windings (`surfaceNormals`).
  Taking the windings' average instead, as it first did, shaded rounds in
  a sawtooth (2026-10-10). The package is imported dynamically inside the
  worker, which needs Vite's `worker.format: 'es'` (all our workers are
  module workers already).
- **Solver:** the hard equations are weighted 1e4 against soft data of
  1/σ, with the normal equations scaled to unit diagonal before every solve
  — without the scaling the pivot test took the stay-put terms for zeros.
  Redundancy is read off the constraint Gram matrix's eigenvalues at 1e-6
  of the largest; finite-difference noise sits at about 1e-7. A closed
  loop's regions are traced on vertices snapped at 2 µm, and the loop
  pieces handed to the kernel end on those shared vertices, so a
  coincidence solved to a micron still makes a closed wire.
- **Segmentation** is RDP at the chain's scatter, best-first merging of
  neighbouring runs while one line or arc explains them, a boundary
  refinement that slides each break to where the two pieces — each judged
  as its own kind — explain their points best, and the fit-to-edge's F test
  to tell a short line on a tight arc from a line. The tolerance is exposed
  as a field.
- **Sketcher UI:** the 2D Measure `FlatScene` is reused as-is for the stage
  (with a `label: false` flag on its element drawing and a shift flag on
  its picks); relations show as glyph notes on the sheet, dimensions as its
  callouts. Selection is click-to-toggle up to two pieces, no modifier
  needed. Symmetric in the panel is about the sheet's Y axis; the model
  takes any axis or a sketch line and the panel can grow into it.
- **Coordinate sketch planes** are offered through the part's centre, as
  the section editor offers them — at the origin they miss a part the
  scanner left anywhere else.
- **A datum alignment** applied after sketching carries the sketch frames
  with the part (the delta of the store's cumulative alignment), and the
  features rebuild.
- **The first hands-on review** (2026-09-15) found the workflow far from a
  CAD program's: no rubber band while drawing, no preview of the body while
  setting an extrude up, regions picked inside the sketch, and the finished
  sketch invisible in the viewport. So: the drawing tools rubber-band to the
  cursor with a cross at a snap; the picked regions moved from the sketch
  feature onto the extrude and revolve, which pick them on the part; a
  committed sketch is drawn on the part in its plane (`viewer/sketchOverlay`,
  fat lines ahead of the depth buffer, since a mid-plane sketch lies inside
  the scan); and the feature editors show the kernel's ghost with grips
  (`core/re/preview` for the geometry, the `preview` request in the worker).
  The build steps changed with it: a sketch makes no step, an extrude or
  revolve step carries its own profiles.
- **The second review** the same day: "still feels like a bad CAD" — the
  workspace stood apart from the rest of the tool and the sketcher was
  static. So: the Measure elements and sections are drawn on the part here
  too (an Elements key in the view bar), every plane and axis list is a
  picker (`ui/RefPicker`) whose hovered option is shown on the part with its
  name (`SketchOverlay.setPlaneHint/setAxisHint`), the sheet has the 2D
  workspace's zoom-following grid, clicks snap to ends and centres, the
  zero, midpoints, axes, slice points, pieces and grid in that order with
  Alt for a raw pick (`core/re/snap`) and are held to whatever of the
  sketch's own they land on — an end, a body, an axis, the zero — by a
  coincident or point-on relation the store adds (`holdAt`), pieces
  are dragged with the Select tool through a soft pull in the solver
  (`PULL_WEIGHT` between stay-put and hard, so constraints hold while the
  point follows the hand; `core/re/drag` for the geometry), Align turns the
  frame under the sketch, closed regions are filled, Escape asks before a
  drawing is lost, the cursor says which tool is armed, and the bodies can
  be drawn opaque over the scan. Feature rows read type and plane.
- **The third review** (2026-09-15, after hands-on use): the sheet alone on
  the stage left the operator without the part, an extrude could only grow
  one way, Tab landed on the ⓘ dots, a middle click did nothing here, a
  line dragged by its body wandered along itself, and editing a sketch
  under an extrude failed the extrude with "no longer closed" — the region
  key hashed the centroid, so any move of the face was a new face. So: the
  sheet lies over the 3D viewport as a see-through layer while a sketch is
  open (`.viewslot.sketch`, a `transparent` FlatScene; a side-by-side
  split was tried first and rejected the same day as "not how CAD does
  it"), and the 3D camera follows the sheet (`FlatScene.onViewChange` →
  `SceneManager.followSheet`: face on to the plane, the sheet's centre
  point under the centre, the sheet's mm per pixel as the zoom, so a line
  on the sheet lies on the part; orbiting is locked to the plane while
  sketching, as after Fusion's Look At), the camera flies to the plane on
  opening (`OrthoViewport.animateLook`, a slerp of the camera quaternion
  written back as position + up so OrbitControls' per-frame lookAt
  reproduces it, the zoom eased on a log scale; `retarget` re-aims a
  flight under way rather than restarting it, so the sheet's first ticks
  do not snap ahead of the swing),
  the part is cut open at the plane with a material clip plane on the scan
  and closed with a stencil cap (`SceneManager.buildCap`: back faces count
  the stencil up, front faces down, a sheet on the plane drawn where the
  count is not zero; the renderer needs `stencil: true`),
  the bodies and the ghost (`SceneManager.setSlicePlane`, only where the
  plane crosses the scan's box — a plane beside the part would clip all or
  nothing; the Slice key), the draft's plane and pieces are drawn on the
  part (`DRAFT_SKETCH_ID` in the sketch overlay); the middle click and
  Enter share one readiness (`extrudeDraftReady`/`revolveDraftReady`,
  `reverseConfirmable` in the shortcuts); `flipExtrude` negates a distance
  extent; InfoDots and the × keys are `tabIndex={-1}`; a line body's drag
  delta is projected on its perpendicular unless Alt; and a region key is
  now matched as a fingerprint (`matchRegion`: exact key, then the same
  piece set, then the face the old centroid lies in sharing pieces, then
  the best piece overlap at ≥ ½), both when a feature resolves and — so
  the stored keys stay current — when an edited sketch is saved.
- **Drags** (2026-09-15, evening): a drag on a sketch of a real part
  stuttered because every pointer report ran a full Levenberg–Marquardt
  solve (~110 ms on 48 fitted pieces: each iteration is a dense solve
  over ~200 unknowns) plus the planar-graph region search (~30 ms). Now
  the App coalesces drag reports to one solve per animation frame at the
  hand's latest spot, the drag's solves are `quick` (four iterations, a
  looser stop, no redundancy count — the Gram matrix's eigenvalues cost as
  much as the solve; `SolveReport.iterations` now reports the true count) and
  leave the regions as they were, and the release runs the full solve and
  the region search. The solve itself got cheaper: the point residuals are
  plain arithmetic over flat arrays instead of the vector helpers' little
  arrays (most of the Jacobian's time), the perturbed copy of x is taken
  once per iteration, and the damped, unit-scaled normal equations go
  through Cholesky (`choleskySolve` in `fit/linalg`, elimination behind
  it): a quick step on 48 fitted pieces went from ~80 ms to ~25 ms. The
  other half of that bug was not the code: the
  long-running Vite dev server had missed the write of `solver.ts` and was
  serving a transform without the pull loop, so every browser drag landed
  halfway while the same code passed in vitest — `touch` the source tree
  (or restart the server) before trusting an e2e against it.
- **Phase A** (2026-09-15, evening) — the seams in the sketch → feature
  loop, as the plan below lists them. What moved while building: the
  sketch's exits collapsed to one (`commitSketch` on an empty sketch
  closes the box and makes nothing; `discardSketch` stays for the
  workspace's own housekeeping) and undo across features is a stack of
  `{features, nextFeatureId, nextOfKind}` snapshots taken by every commit,
  removal and toggle (`remember` in `reStore`), the counters travelling so
  a redone feature is the same feature; the sketch keeps its own history
  and Ctrl+Z inside it stays there. Ctrl replaced Alt for a raw pick only
  in the sketch — `FlatScene` reports both modifiers and the 2D workspace
  goes on reading Alt — and the sheet's press guard had to let Ctrl
  through or a Ctrl-drag of a piece could never start. The grid became a
  `gridSnap` preference (off) read by `snapFor`. Inferred H/V is
  `axisRelationOf` at 3° with an `inferred` mark on the constraint for the
  chip; a rectangle's sides carry the same mark. A sketch on a clicked face
  is a `fitted` PlaneRef carrying its frame (no element made; it moves
  with the part under an alignment), and its slice is cut 0.25 mm inside
  the face (`FACE_SLICE_INSET_MM`): on the face itself the cut would run
  through the face's own triangles. The plane's normal is turned to agree
  with the clicked surface's, so an extrude's positive distance grows out
  of the part. Nominal values are `core/re/nominal` (halves under 10 mm,
  whole above, radii to the half, angles to 5°, nothing offered within
  0.02). The grip field is a CSS2D label the grips class keeps apart from
  the grips it rebuilds on every change, read-only during the drag and
  focused on release. The chips are a fixed-positioned bar
  (`ui/ContextChips`) fed by `reStore.selection`, which the viewport sets
  from region, line and element picks whenever no editor is open — the
  regions and lines are armed as click targets in that state too, and the
  elements light under the cursor while they are on offer
  (`SceneManager.setElementHoverLights`).
- **The live deviation map** (C1, 2026-09-16): built as "Feedback" above
  defines it, with one placement decision made differently from the
  plan's note. The map runs in the **kernel worker**, not the mesh worker:
  the worker already holds the last ghost's tessellation (a copy, since
  the ghost's buffers are transferred to the viewport) and the bodies'
  shapes, so it needs only the scan's vertices — sent once per file and
  once more per datum alignment, as the viewport holds them with the
  alignment baked in — and the same code path serves the ghost and the
  committed bodies (`Builder.meshes` meshes the bodies again for the map,
  cheaper than keeping a second copy of every body between builds). The
  field is **sparse** (`core/re/liveMap`): only the vertices inside the
  ghost's box grown by ten ranges are read, and only those within ten
  ranges of its surface are painted; the rest keep their colour. The
  compositor gained a layer for it (`RegionColors.setSparseField`, above
  the element tints and below a fit's preview region, put back by every
  repaint underneath). The map is asked for 120 ms after the last ghost
  landed, latest answer wins, and the last map stays on the scan while the
  next ghost builds — lifting it per drag step flickered. The range and
  the switch are preferences (`prefsStore.liveMap`, `liveMapRange`); the
  bodies key is the view bar's, unsaved like the rest of it. What the map
  showed straight away on the cube fixture: an extrude typed half a
  millimetre short of the face wears the red cap on that face, half a
  millimetre past it the blue cap, and the count in the box says how many
  points fell out of range — the reading the acceptance script will steer
  the bracket's shell and fillets by.
- **Phase B, milestone 3** (2026-09-16): stable naming, picking on the
  body, and the features on it.
  - *What the kernel gives for naming* (B1, found out first as the plan
    asked): occt-wasm 5.0.0 binds `fuseWithHistory`, `cutWithHistory`,
    `intersectWithHistory`, `filletWithHistory`, `chamferWithHistory`,
    `shellWithHistory`, `mirrorWithHistory` and a few transforms, each
    taking the input faces' hashes and answering with the faces each old
    face **became** (`modified`, flat groups of old hash, count, new
    hashes; `generated` is not usable for faces). A face an operation
    leaves alone keeps its hash, also through `unifySameDomain`; a
    transform gives every face a new hash; a prism or a revolve has no
    history and needs none, its faces are all the step's. `meshShape`'s
    face groups and `wireframe`'s edge groups carry the same hashes,
    counted in **indices and floats**, not triangles and points — the
    one misread of the probe, caught when a body's top face picked as its
    front. `surfaceNormal` already returns the face's outward normal;
    `pointOnSurface` evaluates the underlying surface outside the face's
    own bounds, which is how a cylinder face's axis point is read (four
    points a quarter turn apart, averaged). So: the builder carries each
    face's **maker** by hash across every step through that history
    (`Builder.propagate`), and a pick is a **fingerprint** (`core/re/topo`:
    kind, centroid, outward normal or canonical axis, area, radius, maker)
    matched within a tolerance of a tenth of the body's diagonal, ten
    degrees and half the size, the maker a soft preference, each face
    taken once. An edge's fingerprint carries the kinds and directions of
    its two faces, which is what tells a top edge from the bottom one
    under it.
  - *Picking* (B2): the body's mesh, face by face from the kernel, names a
    face per triangle; edges are picked on screen within eight pixels of
    their polylines, drawn as fat lines only while edges are asked for;
    the face under the cursor lights as a mesh over the body's own
    triangles, the picked ones stay lit, bodies not in play are dimmed
    (`viewer/bodyPicks`). A body face takes a click when it is at least as
    near as the scan under the same cursor, since a body lies on the scan
    it was built from. With no box open the faces are click targets for a
    selection and the chips.
  - *The features* (B3): shell, fillet, chamfer, hole, extract, cut by
    plane, mirror, boolean, all as `BuildStep`s worked on the body by the
    builder with their picks re-found there. A shell with **no face
    opened is a closed hollow body** (settled 2026-09-17): the kernel's
    thick solid with nothing to remove hands back the core alone, so the
    adapter takes the body less its own inward offset, the cut tracked so
    the outer faces keep their makers and the inner ones are the shell's;
    a wall as thick as the body is refused by name. **OCCT rounds a tangent chain
    whether asked or not** — `BRepFilletAPI_MakeFillet` follows
    tangent-continuous edges on its own — so the plan's "unless toggled
    off" is not offered; the builder's own chain walk (`tangentChain`) only
    hands the kernel what it would take anyway. A boolean consumes the
    tool body. A hole's axis from a round face is the face's own axis
    point and direction. The **fillet radius off the scan**
    (`core/re/filletEstimate`): a section square to the edge at its middle
    through the mesh worker, the chain walked from the point nearest the
    corner both ways within reach (so a thin wall's far skin, inside both
    faces just as the round is, stays out), and the corner's **whole
    profile** — flat, arc tangent to both faces, flat, one unknown — fitted
    to every point by a search over the radius; a general circle through
    the round's points alone was tried first and thrown by the one flat
    point whose noise put it inside both faces, and a real scan puts only
    a handful of points on a small round anyway. A round must explain the
    points twice as well as a sharp corner to be reported; a chamfer's
    points leave most of the arc's span standing off it and are refused.
  - *Rollback while editing* (B4, the kernel's form): the builder keeps
    each body **as it stood before every feature on it** (`stages`, the
    shapes retained rather than released), a reopened feature is previewed
    on that stage and its picks re-found there, and the viewport draws the
    stage's mesh in place of the body's while the box is open, the picks
    lit on it after matching their fingerprints — the features after the
    edited one are suppressed on screen without a rebuild.
  - *The row's number* (B4): the key number of a feature's row is an
    input keyed on its value — typed over and left, `setKeyParameter`
    writes it (a distance extrude keeps its start and moves its end) and
    the features rebuild; the rollback marker the plan sketched is
    subsumed by the stage swap above, which shows the body before the
    edited feature without a control.
  - *The project file* (B5): `ReversePart` in the manifest — the features
    as they are (all plain data: sketches, fingerprints, plane and axis
    references by id), the two counters, the Opaque and Elements keys —
    written only when there are features, read into the store with a
    build asked for, which runs when the kernel is up; a project from
    before the workspace has no part and loads with it empty.
  - *The bracket passes* (B6, 2026-09-16, night): a closed solid at a
    **median of 0.065 mm** against the 0.2 mm bar. What it took was not
    the shell and the fillets but the **alignment** the script had
    skipped: in the scanner's frame the channel lies tilted, and a prism
    along Z left the scan by ten millimetres at the median; aligned by the
    scan's principal axes it was still 0.77 mm out, because the hook at
    one end pulls the principal axis 4.2° off the channel's — so the
    script bins the scan into slabs along that axis, drops the slabs the
    hook fattens, fits a line through the slab centroids and makes that
    line Z (`window.__re.alignTo`, the three steps a project's saved
    alignment takes on load). The slice at the middle is then one closed
    chain of both skins with every corner's round already an arc, its
    largest region extruded between the scan's ends. Two things the
    acceptance text assumed turned out not to hold on this part: the
    outer skin's envelope shelled would need the channel's mouth opened as
    well as its ends (the design allows the closed thin profile, which is
    what the slice gives), and the rims at the ends are cut sheet edges
    with no round for the estimate to find — and a wall of 1.35 mm has no
    room for a 1 mm one, which the kernel refused as an invalid solid. The
    shell and the fillet with its estimate are proven on the cube in
    e2e-reverse. §8's "bounds fallback" question is answered by the run:
    the ends from the aligned scan's bounds are enough.
- **B7, the cutter operations** (2026-09-16, night): what the probe of
  the kernel gave and what was built on it. `linearPattern` and
  `circularPattern` return a **compound of the copies**, the original
  among them, whether or not they touch; the adapter fuses them pairwise,
  so overlapping copies are one solid and separate ones a compound of
  solids, which `isClosedSolid` accepts as a body (the circular angle is
  radians at the kernel, degrees here). `loft` of the
  profiles' outer wires makes a valid solid, ruled or smooth. An open wire
  `extrude`s to a **shell** of faces — the sheet — which `split`s a box it
  crosses into two solids, and does nothing to one it does not cross
  (reported by name: the sheet has to cross the body from side to side).
  `draftPrism` on a wire fails, so a sheet has no draft; the extrude's
  draft is the kernel's `draftPrism` on the face, a positive angle
  narrowing the prism as it goes, which the adapter keeps as the part's
  own sense. The **split's cell test** runs in the kernel worker against
  the scan's own triangles (sent once with the positions; a
  `NominalSurface` built there once per scan, its sign never read — the
  scan is not watertight): each fragment is meshed coarsely, up to 1500
  of its triangle centroids asked for their distance to the scan, and the
  fragment kept when the share within the tolerance reaches the overlap;
  with no scan it keeps the largest. A sheet is a body with `surface`
  set — drawn, listed, split with, refused by the features that work on a
  solid, left out of the export. A sheet's faces are the sheet's own by
  hash; the split's kept fragments carry no history from the kernel, so
  their surviving faces keep their makers by hash and the cut faces are
  the split's.
- **Phase C's remainder** (2026-09-17): Compare in Deviation, the
  alignment nudge, symmetry as Mirror's default, the guided first project.
  - *Compare in Deviation* goes through the door every reference comes in
    by. The kernel worker meshes the visible solids afresh at a 0.01 mm
    chord and a 0.1 rad angle (`Builder.meshes(ids, chord)`, the
    `reference` request — the viewport's meshes follow the body's size up
    to a tenth of a millimetre, fine to look at and too coarse to measure
    against), the meshes are written as one binary STL
    (`core/re/compare.ts`) and handed to `openNominal` as a file named
    *Bodies from Reverse engineer.stl*. So the reference is welded on the
    way in — the kernel's mesh is per face, and the sign of a reading
    wants a closed mesh — it is drawn, split-viewed and reported as any
    other, and a saved project carries it as the file it is, with nothing
    new in the manifest. The alignment is a fourth `AlignSource`,
    `built`: the identity, with the panel and the report reading "none —
    built on this scan" where a fit's RMS would stand, because a row of
    zeros under *Fit deviation* reads as a perfect fit. Sheets are left
    out, as they are from the export: a surface has no inside.
  - *The map was not drawn on the sample part* — and had not been on any
    part with its sharp edges split for shading since that split went in:
    `RegionColors.setFieldColors` held the map to the colour buffer's whole
    length, which on such a part runs past the scan's vertices with the
    copies. The figures were right and the part stayed bare. The
    compositor now knows how many of its entries are the scan's own
    (`attach`/`rebind` take the count) and a map is that many readings;
    the scene already brings the copies level.
  - *Symmetry* needed no new search: `core/symmetry.ts` — mirror
    registration from the principal planes, written for Measure's
    symmetry-plane method — runs in the mesh worker already. What was
    added is the judgement and the conversion (`core/re/symmetryPlane.ts`:
    within 0.1 mm RMS, the line Measure calls a loose match beyond, over
    at least half the samples) and the default: a new Mirror box takes a
    symmetry plane already measured, else asks for the search and takes
    the answer when no plane was chosen in the meantime. The plane is a
    `fitted` PlaneRef with a label — no element made unless *Keep as a
    plane element* asks for one, which goes through Measure's own draft
    so the element re-opens there as its own. The answer is kept per scan
    and alignment. A fitted plane on a mirror or a cut now moves with the
    part under a datum alignment, as a sketch's does. On the sample the
    search returns the L's mid-plane to a nanometre, and a body modelled a
    tenth short mirrors about it into the full volume — the point of
    taking the plane from the scan and not from the body.
  - *The nudge* is a paragraph in the first sketch's box, shown while no
    alignment is applied and no feature exists; its key opens Measure's
    Align part with the sketch left open, which the alignment's delta then
    carries along with the part.
  - *The guide* reads its four steps off the workspace's state — an
    alignment applied, a sketch open, a sketch made, a body built — so it
    cannot run ahead of the operator or be left behind; an alignment
    passed over is struck through, not insisted on. It shows on the empty
    state and on the sample only. The sample (`core/re/samplePart.ts`) is
    made, not shipped: an L of millimetre cells whose boundary quads share
    vertices by their integer corner — watertight by construction, 8,384
    triangles — turned 14° about a skew axis so that Align has something
    to do. `scripts/e2e-reverse-guide.mjs` walks the whole of phase C on
    it.
- **Phase D, the surface route** (2026-09-18, after the interview — its
  answers are under "Features", *Surfaces*):
  - *D1, regions.* Two ways in, one mask: a click on the scan while the
    Fit Surface box is open floods from the hit vertex over every edge
    whose normals turn by less than the box's angle
    (`core/fit/regionGrow.ts` `floodByNormal`, the mesh worker's `flood`
    request — plain BFS on the vertex normals, nothing fitted or peeled,
    1° to start: one face of a tessellated part, a patch of a scan up to
    its first crease), Ctrl takes a flood away; or the marking tools,
    Measure's own (`MarkTools` in the box, a third marking session in
    `useSceneSync` beside the fit draft's and the fine fit's, armed with
    no gesture while the box is open so the region stays drawn). The
    region lives on the feature as a `Uint32Array`, shown in the marking
    layer while its box is open — `regionShown` in `useReverse` tells the
    store's writes from the tools' so neither echoes the other — and
    travels in the project as a plain list (`featureToJson`).
  - *D2, Fit Surface.* `core/re/surfaceFit.ts` as the study sketched it,
    with two things learned building it. **The kernel's `bsplineSurface`
    is not a surface from a control net**: it is
    `GeomAPI_PointsToBSplineSurface`, a C2 surface *through a regular grid
    of points* within a thousandth (read in the wrapper's facade source;
    the typings say "from a grid of control points"). So the fit's role is
    the smoothing of the scan's noise, and the fitted surface is sampled
    three times per net span (`gridOf`) and handed over as that grid; the
    kernel makes the exact B-rep face through it, one face per surface.
    **The thin-plate term was wrong for extrapolation**: penalising second
    differences prefers a plane, and with no data in the margin it
    flattened the reach — a 30 mm cylinder's margin was 0.7 mm off at its
    edge, where the surface has to meet its neighbour for the trim. The
    fairness term is the change of curvature instead — third *divided*
    differences of the net's heights over the Greville abscissae (divided,
    because a clamped net's end spacing is uneven and a plain difference
    bends a quadratic there), along u, along v and mixed — whose null
    space holds every quadratic, so a cylinder, a sphere or a saddle
    extrapolates as itself while noise and a net finer than its points are
    faired; the weight is the slider times the region's area squared,
    scaled so 0.01 moves a 30 mm cylinder through 2,400 points by microns
    and holds a 20 × 20 net over 121 noisy points to a fair plane. Auto's
    net wants the scan's noise, which the plane residual's spread is not
    on a curved patch (there it is the sag): a pilot fit on a 6 × 6 net
    reads the noise off its own residual first. The fit runs in the kernel
    worker, which holds the scan's vertices for the live map already, on
    the region's indices; the step carries indices, not points. The
    result is a body marked `surface`, its row reading the point count and
    the fit's σ, its box the fit's σ, worst residual and net.
  - *D3, automatic trim*, as the study's algorithm, in the builder
    (`trimOf`): a box round the scan grown a tenth (`trimBox`), split by
    every tool — a surface body's face, a sheet, a solid body's faces, a
    measured plane as a face across the box, a cylinder or a cone
    stretched along its axis to the box's diagonal (the cone no further
    than its apex), a sphere as itself (`trimPrimitive`) — every face the
    split makes taken once (`ReKernel.splitFaces`, deduplicated by hash:
    the fragments share them), sampled as the split's cell test samples a
    fragment (`onScanShare`, now shared by both) and kept when the share on
    the scan reaches the overlap; the kept faces sewn and made a solid by
    the kernel's `sewAndSolidify`, healed when it closed (`sewFaces`). A
    kept face has no history from the split, so its **maker is traced by
    where it lies**: its centroid within the tolerance of a surface body's
    tessellation names that surface's feature; the elements' faces are
    the trim's own. Not closed: the result is a body marked `surface`, the
    edges with one face reported as polylines (`TrimReport.openEdges`)
    and drawn red on the part (`BodyPicks.setOpenEdges`, ahead of the
    depth buffer whatever the pick mode) — for the preview while the box
    is open, for every visible trim body otherwise. What the L showed when
    one of its eight surfaces was left out: not one face missing but
    three — the neighbours the missing surface would have cut now reach
    over the gap and fall below the overlap — and twelve open edges round
    the hole; the box says how many faces lay on the scan and how many
    edges are open, and the red lines say where. The trim's tolerance is
    the interview's "from the scatter" read where it matters: three times
    the median σ of the surfaces in the set (`trimToleranceFor`, 0.05 to
    0.5 mm, 0.3 mm with no fitted surface among them), recomputed as the
    set changes until typed. The box's set — every surface body ticked to
    start, the solids and the measured elements offered — is the plan's
    remaining-faces list: a face is kept or not by its surface. The
    trim's result is a body like any other: D4 needed nothing beyond it —
    the guide's e2e fillets an edge of the trimmed L and takes off exactly
    (1 − π/4) r² l.
  - *D5, the torus* (`core/fit/torus.ts`, `fitTorusFromSeed.ts`, on the
    `ransacConsensus` + `clippedRefit` + `GrowSpec` scaffold as planned).
    The estimate rests on one fact: **every normal of a torus passes
    through its spine circle a tube radius away**, so for the right r the
    points moved along their normals by r lie on a circle, and a circle
    through them gives the axis, the centre and R at once. The tube radius
    is searched on a log scale with either sign (a concave fillet's spine
    lies against the normals), each candidate scored by median residual as
    the other shapes are. Two things the fillet mesh taught: the candidate
    circle is a least-squares fit, so its points must be the round's alone
    — a random pick among the first few hundred vertices of the patch in
    breadth-first order from the click, not a stride across the whole
    patch, which took the flats along — and each candidate is **polished
    on its own points** by a few Gauss–Newton steps before scoring, since
    the shift grid is coarse and a mesh's vertex normals are averaged; a
    raw circle sat a few percent off, and with it the consensus took the
    flats' first rows and the fit leaned on them (R 24.4 for 25, r 3.8 for
    3). Polished, the click on the round gives the torus to a nanometre
    and the region is exactly the round's rows. The refinement is damped
    Gauss–Newton over all seven parameters with a numerical Jacobian, the
    axis stepped by two tilts as the cone's is. A click on the flat beside
    a round used to succeed — the patch reaches the round and a torus that
    leans on the flat's first rows passes the residual test — so the seed
    itself must lie on the torus and face with it (`onIt`), within the
    grow's own 32°. The element: kind `torus` through kinds, refs (an axis
    provider; its tube radius as its reach), orient, the deviation field
    (the tube's outward direction from the nearest spine point), the
    summary, the overlays (a `TorusGeometry`), the STEP writer (a
    `TOROIDAL_SURFACE` trimmed in the surfaces style; in the solids style
    one face bounded by its two seams used each way — meshstep reads it
    back closed), the transform under an alignment, and Reverse's
    `Primitive` (a circle in a meridian plane turned about the axis), so
    it extracts as a ring and cuts a trim. `scripts/e2e-torus.mjs` fits a
    ring's quarter round from one click and extracts it.
- **The CAD-side round (2026-09-18)**, from a hands-on review: snap,
  draft, projection, the pulled face, and the look of the viewport.
  - *Snap is an edit of the history first, a direct edit only where there
    is none to make.* The first cut was a direct edit alone, on the
    argument that tracing a face to a sketch piece is hard and does
    nothing for a face a fillet made. The first part it met was a block
    with rounds: a flat face's outline stops at the rounds' tangent lines,
    so the moved face left a pad outward and a pocket inward with the
    rounds standing where they were, and a wall beside a wall not square
    to it left a sliver. No operation on one face's outline can know what
    its neighbours should do; the feature list does. And the trace is not
    hard: the builder already carries each face's maker through every
    boolean (B1), so `core/re/snapEdit.ts` reads `face.origin`, and for an
    extrude the face is a cap (normal along the sketch's: the From or the
    To it lies at moves), a wall (normal in the sketch plane: the line
    whose lifted ends lie in the face's plane, nearest the face's middle)
    or a round (axis along the normal: the circle or arc on that axis with
    that radius). A wall's line is translated and held on its new carrier
    for one solve by two point-to-line distances to a fixed helper line
    laid 10 mm beyond — not by fixing it, which would stop its ends
    sliding where a neighbour meets it at a slant, and not at distance
    zero, where the solver's |d| − value has a kink — then the helper is
    taken away. An unmet constraint means a dimension holds the wall, and
    the move falls back with that as its reason. The edit is an undo
    entry like any other, the region picks rekeyed as after a sketch
    edit. What remains a direct edit — **Move face**
    (`kernel.offsetFaceTracked`): a flat face's own handle extruded along
    its outward normal and joined (outward) or cut (inward) — the kernel
    merges the walls back into one face each through `unifySameDomain`, a
    box stays six faces — and a full cylinder resized by a tube between
    the two radii over the face's own length (read off the face's
    tessellation, a bounding box being too long on a tilted axis), or by
    the whole cylinder where a hole is bored out, nothing being in it to
    mind. A boss with a bore keeps its bore that way. It works on any face
    whatever made it, and its limits are said: walls square to a moved
    flat face (a drafted wall steps), a cylinder that goes the whole way
    round, the axis kept.
  - *The scan is read once.* The reading (`core/re/snapFace.ts`) is the
    offset along the **face's** normal to where the fitted plane crosses
    it through the face's middle — not the plane-to-point distance, which
    on a tilted scan face puts the body's face at the patch's height
    rather than the face's — and the feature stores the number. A rebuild
    that fitted the scan again would make every earlier edit a new fit
    and the feature list a function of where a click once landed. The
    box says what the move cannot take out: the tilt between the two
    faces, the distance between the two axes. Over 20° the click was on a
    neighbouring face and is refused.
  - *A leaning scan face is a draft, offered, not made* (2026-09-23). A
    moulded wall modelled square snaps to where the scan's plane crosses
    its middle and the tilt stays, said in the box. The reading now tells
    a lean from the fit's own scatter — the slope of a plane through n
    points spread over a length L with scatter σ is uncertain by
    σ·√(12/n)/L, and the tilt must clear four times that and 0.2° — and
    where it does, carries the Draft that would take it out: neutral
    plane through the moved middle (the offset already puts the scan's
    plane through it), its normal the fitted normal's part in the face
    (the way the scan dips into the body, which is the kernel's positive
    sense), the angle the tilt. Hinging through the middle rather than at
    the face's root keeps the move and the draft independent of each
    other and of which end is the root, which nothing in the scan says.
    The box offers it as a tick (`lean` on the Move face draft,
    `snapDraftOf`), off by default: a draft the operator did not ask for
    would put a feature in the list for every scan face a little askew.
    Ticked, Create makes the move as before and appends a Draft feature
    with a `fitted` neutral plane, in the same undo entry; the ghost is
    the moved face mesh turned about the hinge. Round faces get no offer:
    a cylinder's tilted axis is a tilted cylinder, not a cone.
  - *The kernel's draft has no neutral plane to give it.* occt-wasm's
    `draft(shape, face, angle, direction)` takes the plane through the
    world origin square to Z — whatever direction it is handed: a pull
    along Y fails with an empty message, one along X is refused by our own
    check (found 2026-09-23 when the snap's draft first hinged across a
    top face; before that every draft in the app had pulled along Z) — so
    a box from z = 5 drafts as if hinged at z = 0. It drafts one face a
    call and hands back a shape whose other faces have new hashes — five
    of a box's six. So the body is translated to put the neutral plane at
    the origin, turned to put the pull on +Z (`turnOntoZ`), and back, each next
    face is found on the result by kind, direction and nearest middle,
    and the builder traces makers by geometry (`geometricHistory`: the
    fingerprint match with the origin left out) since there is no history
    to ask. A cylinder drafted into a cone matches nothing and is the
    draft's own face. Positive is inward going into the body from a
    neutral *face* (pull = the face's inward normal), along the normal
    from a neutral *plane*.
  - *A projected piece is a fixed piece with a flag.* Associativity —
    the projection following the body through an edit — would need the
    sketch to hold fingerprints and the build to run before the sketch
    solves; the sketch solves on the main thread with no kernel. So a
    projection is taken once (`core/re/project.ts`) and the README says
    so. Since it is an ordinary entity, every relation, dimension, snap
    and region already works on it; `fixed` keeps the solver moving the
    drawn pieces to it. The Project tool's click cannot be a 3D pick —
    the sheet lies over the viewport and takes the pointer — so the
    candidates are projected to the sheet up front and hit-tested there,
    which is also what lights the one under the cursor. The camera under
    the sheet is orthographic and face on, so the edge seen is the edge
    hit.
  - *Sketch here used to open an empty sketch on the face*, its slice
    taken a hair inside; with the outline projected in, Finish on it now
    keeps a sketch (it is no longer empty), which the e2e had to learn.
  - *The pulled face is a sketch and an extrude*, not a new kind of
    feature: the list stays readable and editable with the tools there
    are. The sketch is made at once (its regions are needed for the ghost)
    and taken back, with its undo entry and its name, if the box is
    cancelled. The result follows the direction until it is chosen by
    hand.
  - *An edge and its faces are tessellated apart.* The kernel's wireframe
    and its mesh share no points along a curved edge, so the line's chords
    and the faces' chords cross, and with a depth-tested line the half of
    every other chord that lay under the surface was hidden: a fillet's
    rim in dashes ("are they drawn twice?"). A polygon offset is in depth
    units, thousands of which fit in a chord's sag on a 100 mm part. The
    lines are moved towards the camera in view space instead — a patched
    `LineMaterial` (`liftedLineMaterial`), four chords — which is exact
    for the orthographic camera and immaterial for a perspective one.
    *Replaced 2026-10-08:* lifted, the hidden edges just behind a rim
    showed through it — a Torx recess's walls ticked the head's top beside
    the opening. The kernel does put an edge's nodes once and both faces
    take them, so the lines are now the outlines of the faces' own
    triangles (`core/edgeLines.ts`): on the surface all along, the offset
    is all they need, and nothing is lifted.
  - *Extents that end on the part* (to a face, to next, to last) need the
    body in the extrude's own solid, which a preview never had: the ghost
    is the tool alone under a borrowed id. It now carries the feature's id,
    operation and target for these kinds, and a join or a cut keeps the
    body as it stood as a stage (as the features on a body do) so a
    reopened extrude is not measured against itself. To next is the first
    piece, along the way, of the long prism less the bodies (a boss) or of
    the prism within them (a cut); a first piece that still reaches the
    prism's far end was never stopped, and is refused.
  - *Edges.* Drawn always, depth-tested, 1.1 px, the faces behind them by
    a polygon offset of one; the lit ones depth-tested too, which is what
    "do not shine through" meant. A depth-tested line cannot be picked
    by the eye when hidden, so the pick tests the nearest candidates
    against the body meshes and takes the first that is seen (solid
    bodies only — through a see-through body everything is seen). The
    chain a fillet will run along is walked on the main thread from the
    end tangents the topology now carries (`EdgeInfo.ends`,
    `endTangents`): the polyline's chord tangents are out by half a
    chord's turn, more than the chain's 3°.
  - *A preview that stands in for the body.* A fillet's ghost lay inside
    the see-through body it would replace and could not be told from it.
    The preview of a feature on a body is that whole body, so it is drawn
    solid in the body's place with its own edges (`PreviewResult.edges`),
    the body's material made invisible rather than its mesh — a mesh out
    of sight is not ray-cast, and the edges and faces are still picked on
    it. A cut's tool is inside an opaque body and is drawn without the
    depth test.
- Fit all chains on a real slice (2026-09-19, the fridge bracket's section
  as the case):
  - *σ is not acceptance.* A run was a line if its σ was under the
    tolerance, and a side of five hundred points takes half a fillet on
    board without its σ moving: the round went missing, the side ran on
    past the corner, and Infer corners joined what was left. A piece is
    now also held by its worst stretch — the mean miss over five points in
    a row, which no length averages away — and by heading: the chain has
    to come into a piece and leave it along it. On the bracket's real
    rounds chain and arc agree within 10° at the ends; on a fillet with a
    stretch of side on board, or the riser of a step fitted as half a
    turn, they are 25° and more apart.
  - *One tolerance cannot serve a wall and a fillet.* Tight enough to keep
    a fillet apart from its sides, it chops a bowed wall into arcs of a
    hundred millimetres; loose enough for the wall, one arc swallows the
    end wall and both its fillets. An arc is held to the noise tolerance,
    a line to a wave tolerance of three of those at the default (the
    Detail slider: one to five), scaled down for a short line, and a
    shallow arc that bulges under three wave tolerances is the wall. The
    coarse end was nine at first and took every feature of two millimetres
    with it; five is where the bracket's hooks survive.
  - *Short pieces are asked about in clusters.* Asked stub by stub, a
    step's riser went because the scanner-rounded corner next to it
    happened to cross the side before. A cluster of short runs is judged
    against the long pieces either side: merged if they explain it,
    left out if they explain each other without it, dropped for their
    corner if they are two lines that cross beside it, kept as one line
    otherwise. Only two lines make a corner: a line and a round cross
    wherever their circles happen to, and what lies between those is the
    small blend of an S-bend more often than a blob.
  - *A tangency within a millimetre is sixty degrees.* The tangent test was
    half the corner gap, absolute; beside a round of two that held nearly
    anything tangent, and the solver bent the round off its points to make
    it so. It is an angle now (20°), floored at twice the scatter.
  - *An aligned line's points turn with it.* Left where they were, five
    hundred points a degree off pull against the horizontal at every
    solve, and the penalty solver leaves the corners a few microns open
    and reports the sketch unsolved. The points say where the side lies
    and how far it runs; the relation says at what angle. A fine fit of a
    wandering wall, aligned, is a row of level lines at different heights
    that cannot all meet: level and in line, they are merged.
  - Known limit: the noise tolerance has a floor of 0.6 of the median point
    spacing, so a chain thinned for export (the 2D DXF's) or a coarse CAD
    tessellation reads a millimetre step as wander. The sketch is fed the
    raw slice, where the spacing is the mesh's.
- The sketch after the review of 2026-09-19:
  - *A press must not select.* The sheet hands a press on a piece to the
    sketch as a possible drag and, let go where it landed, reports a click.
    The drag's start selected the piece, the click toggled it off: nothing
    could be selected. A drag now changes nothing until its first move.
  - *A click on the scan that opens a sketch is a mode nobody asked for.*
    Phase A's shortcut fired under every click meant to look at the part.
    Gone; a sketch is begun from the panel or from a body's face.
  - *Tools take what is clicked next.* Dimension (D) and the relations work
    on the selection or, with none, as a tool in hand; what two clicks
    dimension is decided in one place (`core/re/draw.ts`, dimensionFor).
    A new dimension's field takes the focus — the panel's row stands in
    for CAD's value box under the cursor.
  - *The chain and its arc.* A line's far end is the next line's start,
    taken from where the solver left it (a line made level has moved). The
    tangent arc is a drag from that end: the sheet lets the press through
    to the sketch there (setDragHover), the stage draws the arc, the store
    adds it with a join and a tangency. An arc is stored counter-clockwise,
    so one swung to the right has its anchor `a` at the far end.
  - *Contrast is three layers.* The lit cap seen face on came out near
    white and nothing read on it. The cap is flat now, one step off the
    stage; the slice is a hairline at the far end of the scale; the pieces
    are saturated, 2 px, with dots on their ends. Glyphs are off by
    default: a fitted profile has a join and a tangency at every corner.
  - *The box says less.* Prose went into tooltips and the InfoDot; a line
    shows only for an error, a wait, or what the tool wants next.
- Plain CAD and picks that read (2026-09-20, after a hands-on list):
  - *No scan is a state, not a second workspace.* `reStore.scanless` and a
    blank stage sized for a part of 100 mm (`SceneManager.startScanless`);
    everything that does not read the scan is live, a sketch asks for no
    slice, the guide and the alignment nudge stay away. The stage follows
    the bodies as they grow and re-frames the camera only when they outgrow
    what it last framed — a view that jumps at every feature is worse than
    one a little too wide. A scan loaded later joins the model instead of
    resetting it, so the project file had to carry features without a scan.
  - *What is picked says what it is* (`core/re/selectionInfo.ts`): plain
    data in, rows of text out, read off the bodies' own topology in the
    part's coordinates. Two picks read what lies between them; parallel is
    within a twentieth of a degree, which a modelled part is and a lofted
    or drafted one is not. A round edge's centre comes off three of its
    drawn points, the fingerprint carrying radius and axis but no centre.
    Corners are a pick of their own — the ends of the edges, within 10 px,
    not through a solid body.
  - *A window goes by its direction*, as in every CAD program: to the right
    what lies wholly inside, to the left what it touches, hidden edges
    too — a window is how one picks what one cannot click. It feeds the
    selection or the open Fillet, Chamfer, Shell or Draft.
  - *A shell past rounds no larger than its wall.* A round whose inner
    radius would be nothing has no inward offset, and the kernel's thick
    solid gives up on the whole body over it. The adapter takes those
    rounds off (`defeature`), shells the sharp body and cuts the result
    back to the body's own outside (`shellSharpInside`): round outside as
    modelled, sharp inside. It answers null — and the plain failure is
    reported — when anything of the outside would be lost: a pin thinner
    than the wall that went with the rounds is a feature lost, not a corner
    left sharp. The row says how many rounds it was (`FeatureResult.note`).
  - *A shell the thick solid gives up on for no reason it can name*
    (2026-09-23, the fridge bracket). `BRepOffsetAPI_MakeThickSolid` fails
    on a bar with a block on its end — nine flat faces, a valid body —
    for any two faces opened on opposite sides of the L-shaped step face
    where the block meets the bar, and for many threes whose pairs all
    pass, at every tolerance and wall. When the plain shell and the
    sharp-inside one both fail, the adapter makes the shell by hand
    (`shellByOffsetCut`): the body less its inward offset, then the wall
    over each opened face cut away — the face pushed in by the wall
    (`wallUnder`: an extrude for a plane, a thicken checked to lie in the
    body otherwise), less the walls under the closed faces sharing an edge
    with an opened one, so those reach the opened face's plane as a
    shell's walls do, and two opened faces sharing an edge lose the corner
    between them. The cut is tracked like the closed hollow body's. Where a
    closed face meets an opened one at an inside corner its wall keeps a
    foot a wall deep under the corner, which the thick solid would have
    opened; harmless, and not marked. The diagnosis (`diagnoseShell`) runs
    through the same call, so it only reports what none of the three ways
    can make.
  - *The part's planes in a sketch are traces, never stored*
    (`core/re/datums.ts`). A sheet's zero is wherever its plane's frame put
    it; what a drawing is dimensioned from are the part's XY, YZ and ZX
    planes. Each cuts the sketch plane in a line, and a dimension to it is
    a point's distance from that line (`distance` with `q: { datum }`).
    Worked out from the frame on every solve and every draw, they are right
    after an alignment, which moves the frame and leaves the planes.
  - *The save crash was not reproduced* (a 1.9 million triangle scan with a
    fitted sketch saves in the browser test). What could hang or exhaust a
    save is closed instead: the project worker's death or an unreadable
    answer fails the save with a message, a message that does not clone
    leaves no request waiting, a manifest past 2 MB is written compact.
- The sketch's dimensions as a drawing carries them (2026-09-20, from a
  picture of Onshape's):
  - *Two steps, because a drawing has two scales* (`core/re/dimLayout.ts`).
    `dimShape` reads the sketch in sheet millimetres — what is measured,
    where the number sits; `dimStrokes` makes lines and arrowheads for one
    zoom, arrows, gaps and overshoot being screen pixels. A zoom makes the
    strokes again and leaves the labels alone.
  - *Where a number was put is kept against what it measures*
    (`Constraint.place`, off and along), not in sheet coordinates, so it
    follows the pieces through a solve. A press that moves is a drag, one
    that does not is the click that opens the number for typing. A drag is
    one undo step and solves nothing.
  - *Fillet and Chamfer are drawing tools*, in the row with Line and Arc,
    not edits beside Delete. A chamfer (`filletCorner.ts`, chamferLines) is
    held by two dimensions, each end's distance to the other line — on a
    square corner both read the setback, and typing over one makes it
    uneven without a second kind of chamfer.
- Phase E, the parts that needed no interview (2026-09-21) — E3 and E1:
  - *The cotangent formula is only as good as its area.* A third of each
    triangle as a vertex's share read a ball 14 % too round wherever five
    triangles meet instead of six; the mixed Voronoi area (Meyer et al.,
    an obtuse triangle split by halves) reads it right to the third
    decimal. A sliver's cotangent is held to ±20 so one poor triangle is
    one among six.
  - *A scan's curvature is under its noise, and the noise cancels.* 0.02 mm
    of scatter on 0.3 mm edges reads ±0.4 /mm where a 2 mm round reads
    0.25 — but a vertex pushed out sits between neighbours pushed in, so
    four passes of neighbour averaging leave the shape. The rim of an open
    scan has no other side and is NaN, found by the adjacency's own
    oddity: a neighbour is listed once per shared triangle, twice inside
    the surface, so an inner vertex's neighbour ids cancel under
    exclusive-or.
  - *The scale is a percentile and the legend a radius.* Nine vertices in
    ten under the range spreads the flats and blends over the ramp and
    sends the sharp edges into the dark caps, which is where one wants
    them; a floor at the curvature of a round as large as the part keeps a
    block of flats from showing its noise. 0.18 /mm means nothing to the
    eye, *full colour at R 2.7 mm* does.
  - *The curvature is a full map, the live map a sparse one, and they
    cannot share the surface*: under a full map the compositor holds the
    sparse layer back. So a ghost with its live map lifts the curvature
    while it is up, and the key and the Deviation key put each other out.
    It is painted by the scene sync like the deviation and thickness maps
    — another writer of `setFieldColors` would have been undone by that
    effect's next run.
  - *Where a plane fitted in the workspace lives.* The plan said "a plane
    fitted in the workspace snaps"; the workspace had no such thing, only
    the freeform Fit surface and Measure's elements. It is a **Shape** on
    Fit surface: the same region, box, row, undo and project entry, and a
    body in the same list. Cone and sphere stay Measure's — a sphere has
    no direction to hold and both already enter a trim.
  - *The references are a direction each.* A plane's normal and a
    cylinder's axis against a reference plane's normal or a reference
    axis: `along` and `across` cover parallel, perpendicular, a bore
    square on a face and an axis lying in a plane, and only the words
    differ (`relationWords`). Along beats across; across one reference
    leaves a turn free, spent on the points (the smaller eigenvector of
    the covariance cut down to the plane square to the reference); across
    two it is their cross product, refused if that lands more than twice
    the tolerance from the fit.
  - *The fits are made in the builder, so the earlier surfaces are
    references only there.* `resolveFeatures` hands over the datum planes
    and the elements and the ids of the plane and cylinder surfaces before
    this one; the builder keeps what each came out as (`fitted`) and adds
    them. The same record is what a trim cuts with: the whole plane or
    cylinder, since two drawn patches need not reach each other over a
    corner the scan rounded off.
  - *A cylinder from points alone.* The kernel worker holds the scan's
    positions and no normals, so the axis cannot start from the normals'
    scatter as Measure's does. A patch of a cylinder has its axis near one
    of its three principal directions; each starts the geometric fit and
    the best is kept.
  - *Put on a reference axis, a partial round changes its radius*, by a
    share of how far the axis moved: over two thirds of a turn the mean
    distance from the new axis is not the old radius. The report's σ
    before and after is what says whether the coincidence was worth it.
  - *An element on the scan lost the click to the scan.* Found by reading
    why `e2e-element-deviation` had failed since 2026-09-17: a fitted
    plane's shell and the face it was fitted to are met by the pick ray at
    the same distance, and where the scan sorted first, "bare scan ends
    the search" ended it. A shell within the scan's scatter behind the hit
    is on the surface, not inside the part.
- The two acceptance parts of the surface route (2026-09-21), written as
  the plan had asked since B7 and D, and what writing them taught:
  - *A part that is its own scan.* The wheel cap has no fixture file: it
    is modelled on the blank stage, exported, meshed by meshStep and loaded
    back as the scan it is then reversed from. The model and the reversal
    share no feature — cut-out plugs one way, patterned sheets and a split
    the other — so the volumes agreeing to a hundredth says both are right.
  - *By area, or not at all.* The on-scan test sampled "triangle
    centroids", and the kernel meshes a flat face as two triangles however
    large. A window's plug is four walls on the scan (eight triangles) and
    a roof and a floor on nothing (four): 0.67 on, kept. Every unit test
    before had fragments that were wholly on or wholly off. The points are
    now spread by area — Halton points folded into each triangle, its
    share of about 1500 — and each carries its share of the triangle.
  - *A pattern of a sheet was the missing operation of the wheel cap.* The
    kernel's pattern hands back a compound; the adapter took its solids
    and fused them, and a sheet has none. A sheet's copies are left as the
    compound of their faces — cutters stand apart, there is nothing to fuse
    — and the builder lets a pattern, alone among the features on a body,
    through to a sheet.
  - *What the tools cut apart is not the part's.* A trim's kept faces are
    cells of the box the tools cut: the boss's wall came out in two halves
    because a side plane, carried across the whole box, crossed the
    cylinder's far side. `unifySameDomain` after the heal makes one face of
    the faces on one surface, which is what a Hole or a Snap face needs a
    cylinder to be. And with that a face cannot be traced to its surface
    by its centroid any more — a whole cylinder's is on its axis — so the
    trace is from a point on the face, a triangle's middle, with the
    chord's sag allowed for.
  - *The first reference names the relation.* With the surfaces fitted
    earlier among the references, ties are the rule: the top is as parallel
    to the bottom as to the XY plane the bottom was held to. The last one
    won, and the boss read *Perpendicular to Surface 7*. The first wins
    now, the list running from the part's planes to the elements to the
    surfaces; all the references sharing the held direction are kept
    (`same`), so the one the fit lies *on* is still found among them.
  - *Found by the way:* Export body STEP was drawn only under a loaded
    scan, so the blank stage's models could not leave the tool — the
    README had said they could since the day the blank stage came.
- Two open ends of the CAD-side round, closed (2026-09-21):
  - *A revolve's section is a sketch like an extrude's, turned.* A
    shoulder's plane cuts the sketch plane in the very line that made it,
    so the wall move works on it unchanged, its direction the face's
    normal read on the sheet. A cylinder about the axis is the line along
    the axis at its radius; "in radius" is away from the axis whichever
    side of it the section was drawn on, and a bore grows the same way a
    rim does. What tells a shoulder from the flat end of a part turn is
    the axis, and the axis may be a measured element — so the plan needs
    Measure's elements, which the Reverse store had never seen. They are
    kept there by the workspace (`elementRefs`) rather than passed by the
    box alone: Create decides inside the store, and a plan that read
    *sketch* in the box and fell back to *direct* on Create would be a lie
    told by the box.
  - *A silhouette is a level line, not a set of edges.* Taken as the mesh
    edges between a facing and an averted triangle it runs in a zigzag on
    anything but a cylinder. Taken as the zero of normal · view between
    the *vertex* normals it crosses each triangle in a straight segment
    and joins up smooth, needs no adjacency, and costs one pass over the
    round faces' triangles — the flat ones have one normal and none. It
    rides the edges' material, so the depth test, the clipping and the
    line width are the edges' own; it is made
    again at a fifth of a degree of turn, on the viewport's tick.
- A hands-on round, the evening of 2026-09-21:
  - *A debounce is the wrong tool under a hand.* The ghost was asked for
    40 ms after the last change to the draft, which reads as "a little
    behind" and is in fact "never, while the hand moves": a drag changes
    the draft every few milliseconds and each change put the question off
    again. What a drag wants is the opposite discipline — one request out,
    the newest state asked for the moment the answer lands, every answer
    drawn because every answer is newer than what is up — and, where the
    shape allows it, no kernel at all between answers: a straight extrude
    under new numbers is the last prism under an affine map, which is one
    matrix on the ghost's mesh. The drafted extrude takes the same map and
    is a little wrong at its far end until the kernel lands; nobody will
    see it. The numbers in the box and the deviation map are reported by
    the last answer only, or the map — dearer than the ghost — would run
    behind every frame of the drag in the same worker.
  - *The rollback bar is a second list, not a flag.* A cursor into
    `features` would have had to be honoured by the build, the previews,
    the pick defaults, the region cache, the chips, fourteen commit paths
    and every `features.find` in the panel. Taking the tail *out* of
    `features` (`rolledBack`) makes all of that right with no change: the
    store below the bar simply is the part as it stood. What has to know
    about the tail is short — the undo snapshot, a delete's dependents,
    the alignment that moves the sketches, the project file, the count
    that says the stage is in use.
  - *A default is a decision.* "The last body" as what a new solid joins
    was right until surfaces were bodies too; then it made the commonest
    next step after a Fit surface — an extrude — fail with a kernel's
    sentence. The fix is in three places on purpose: the default (last
    solid), the lists (solids alone), and the builder (by name, for the
    project that already holds such a feature).
  - *The card is for framing, the plane is for clicking.* The sketch's
    sheet was one mesh doing both, and its size was the slice's. A blank
    sheet now answers a click anywhere on its plane; the card keeps the
    framing and the grid's first patch.
  - *A relation nobody can find is not there.* Symmetric had an icon, a
    tooltip of nine words and an axis chosen by the code. The rule the
    fourth review gave — a line of text for what the tool wants next —
    is what it needed, with the third pick being the thing CAD users
    look for: the centre line.
  - *An extent read off a click is a number, not a reference* — the same
    choice as the snapped face's offset, for the same reason: a rebuild
    must not go back to the scan. The extent kinds that do refer (to a
    face, to next) stay what they were.
- Still open from that list: a projection that follows its body (the
  sketch would have to hold fingerprints and solve after the build), a
  moved cylinder that takes the scan's axis as well as its radius, To next
  against a face that is not flat where the profile only partly lands.
- Where a sketch's zero is (2026-09-22, from a survey of FreeCAD, Fusion,
  Onshape and SolidWorks — the CHANGELOG entry has the sources' findings):
  - *The four tools converged on one rule, and every complaint about
    sketch origins is a place a vendor had left it.* The sketch origin is
    the part's origin projected square onto the sketch plane, the sketch's
    X a coordinate axis flattened into it. FreeCAD's attacher does it in
    code, SolidWorks' red origin is the global one, Onshape's is "the
    world coordinate system's origin", Fusion made it the rule in November
    2023 after years of an offset plane's origin sitting at the face's
    centre. Ours had been the abandoned Fusion rule — a patch's centre and
    its bounding rectangle's axes — and nothing on the sheet said where
    the part's zero was. `sketchFrameOn` is the rule now, for every plane
    kind; the datum traces, the grid and the new origin dot all land on
    one point. What the survey did not settle, kept simple: the patch's
    own axes are never used, even on a face square to a coordinate plane
    — the axis rule gives the same answer there, and elsewhere a
    bounding rectangle is not a datum.
  - *A frame is stored with its sketch, so the rule changes nothing that
    was made.* Old sketches keep their sheets; new ones get the rule.
  - *The plane at zero and the plane through the centre are two offers,
    not a switch.* The first draft offered the coordinate planes at zero
    once the part was aligned, in place of the ones through the centre —
    and the guide's own workflow, a slice across the middle of the part
    fitted into a profile, lost the plane it needed: on an aligned part
    whose base sits on XY, the XY plane cuts the bottom face. So both are
    on offer with a scan, keyed by their offset (`worldPlaneKey`), and
    the planes at zero alone without one.
  - *A sketch on a face follows the face — the fingerprint machinery was
    already there.* The `bodyFace` PlaneRef keeps the face's fingerprint;
    the builder re-finds it on the body as it stands before each feature
    on the sketch (the same `findFaces` a To-face extent uses), takes the
    sketch frame on it by the rule and carries the lifted profiles by a
    frame-to-frame map (`frameMap`), so the main thread's lifting is
    untouched and the worker never needs the 2D sketch. The build hands
    the frame back (`FeatureResult.sketchFrame`) and the store keeps the
    sketch there without an undo step or a rebuild — the build just ran
    there. The match tolerance (a tenth of the body's diagonal) is the
    reach of the association: a face moved further is lost, the sketch
    stays, the row says so, and the model still builds — the fallback
    that FreeCAD's toponaming, Fusion's "sketch plane is lost" and
    SolidWorks' dangling plane do not have.
  - *An alignment after the pick must carry the fingerprint.* The frames
    were carried already; a fingerprint in the scanner's frame would not
    be found on the bodies rebuilt in the datum's (`transformFingerprint`,
    a plane's normal keeping its sign, an axis made canonical again). The
    other face and edge references in the feature list are still not
    carried under an alignment — the existing limitation, now written
    down.
  - Not done, on purpose: nothing holds a point to the origin (CAD's
    coincident-to-origin); a dimension to a datum trace is the way to fix
    a point here, and two of them fix it to the origin.
- Not yet: E2 — curves on the mesh, the loft between them, the four-sided
  patch — which waits for its design interview.
- **The fifth review** (2026-09-22, after modelling a real part with
  fillets, chamfers and a shell): editing an old feature showed the
  finished part, a pulled face was a copied sketch that stayed put when
  the face changed, fillets were lost after an earlier dimension moved,
  the tree was "super messy", and Coincident "felt different" from CAD.
  What was built, and what moved while building it:
  - *Rollback while editing is a partial build, not a kept stage.* The
    kernel had kept, per feature on a body, that one body as it stood
    before the feature (`Builder.stages`) and the app drew it in the
    body's place. That served fillets and shells and nothing else: an
    extrude's or a sketch's edit still showed the finished part, and the
    other bodies always did. Now `featuresToBuild` in the store hands the
    build the features before the edited one alone (opening an editor on
    an existing feature bumps `buildVersion`, and so does closing it
    without saving; a commit did already), so every body stands as it
    stood when the feature was made, the feature's ghost is drawn on
    that, and the rows after it are drawn set aside in the tree. One
    extra rebuild per edit, which the design's "rebuild on commit"
    already paid for. The `stage` request in the worker stays but nothing
    asks for it; the picks of a reopened fillet are re-found on the
    rolled-back build's topology once it lands (not before — the old
    body's hashes would name the wrong faces). The panel scrolls up to
    the editor box when one opens.
  - *A pulled face is the profile.* `ExtrudeFeature.face` (a
    `FaceProfile`: body and face fingerprint) in place of a sketch and
    regions; the builder finds the face on the body as it stands before
    the step, copies it out of the body (`ReKernel.faceCopy`, an
    `occt.copy` of the sub-shape) and sweeps it along its own outward
    normal, so holes and rounds an earlier feature put in the face go
    into the boss, and a face that is gone fails the pull by name. The
    `bodyFace` sketch route stays for *Sketch here*, whose outline is
    still a projected copy: to draw on, not to pull. Its `frame` follows
    the face; its pieces do not — the known remaining copy in the
    workspace.
  - *A second look for a moved pick.* The strict tolerance (a tenth of
    the diagonal in position, half in size) lost a boss's top face and
    side edges the moment the boss was pulled from 7 to 17 mm. When the
    strict look finds nothing, `matchFace`/`matchEdge` look again among
    the candidates the **same feature made** (`origin`), four times as
    far and with the size hardly counted (`relaxedTolerance`). Requiring
    the maker keeps the loud failure for a face that is truly gone.
  - *The tree is an icon and a name.* `ElementRow` takes an `icon` in
    the body's colour where the dot was, and a `title`; the reading
    (operation, distance, counts, plane) is the tooltip's, a failure a ⚠
    with its sentence underneath. The inline key field in the row
    (`RowKey`) went with it — the editor is the dial again, and it rolls
    the part back. Bodies are `Solid n` / `Shell n` by the order of the
    features that made them (`nameBodies`, in `finishBuild`), not the
    feature's name; the Extract feature is named Extract.
  - *Coincident as CAD picks it.* `relPickAt` (a `dimPickAt` that takes a
    circle's centre too) and `coincidentFor` in `core/re/draw`: point +
    point → `coincident`; point + line / rim / datum trace → the new
    `pointOn`; line + line / datum trace → the new `collinear` (both ends
    on the carrier); two round pieces or a round piece and a line say
    "use Tangent or Concentric". The relation stays in hand
    (`relPicks` on the draft, lit like the Dimension tool's first pick).
    With two pieces selected the key still joins nearest ends, two lines
    now collinear. The datum traces are click targets here as they are
    for a dimension. Both new kinds go through `constraintEntities`, so
    deleting a piece takes them along; `sharpenCorner` now filters by it
    too.
  - *Snapping to the axes.* `SnapContext.datums`, taken after the ends
    and the midpoint and before the slice at three quarters of the
    reach (`DATUM_REACH`), the point moved onto the trace's foot; the
    hold is a `pointOn` datum (`snapHold`, `holdAt` in the store) for
    the Line and Arc tools, the tangent arc and a dropped drag. A chain
    whose end lands on an axis runs on rather than arriving.
  - *Loose and constrained colours.* `SolveReport.underConstrained`:
    the constraint Jacobian's rows over the parameters of the pieces
    not held by themselves (fixed, projected, or fitted — the scan holds
    a fitted piece), brought to reduced row echelon form; a parameter is
    loose when its column has no pivot or its pivot's row reaches a
    column that has none. Free pieces draw `palette.free` while loose
    and `palette.constrained` (the sheet's ink) once pinned; the counts
    line reads "· n loose". A drag's quick steps keep the last full
    answer. The relation keys' tooltips are the names alone, the hint
    line says what Coincident wants next.

## Plan after the reviews (2026-09-15)

Settled after two hands-on reviews and two surveys of beginner CAD
workflows. Ordered by dependency and by how much beginner failure each item
removes; every phase ends green on `npm test`, `npm run build`,
`e2e-reverse` and, from phase B on, `e2e-bracket`.

**Phase A — close the seams in the sketch → feature loop.**
1. Sketch plane by clicking: click a scan face → the plane fitted through
   that patch (Measure's fit from a click) becomes the sketch plane; click
   a body face once a body exists. The picker stays as the fallback.
2. Extrude and Revolve offered the moment a region closes on the sheet:
   one click creates the sketch, picks the region, opens the editor with
   ghost and grips.
3. Escape leaves the tool only. Finish sketch is the one exit; Cancel and
   the create/discard prompt go; discard is Undo. Undo/redo across the
   feature list, not only inside the sketch.
4. Object-first chips on a viewport selection: region → Extrude, Revolve;
   cylinder or line element → Use as axis; body face → Sketch here (Shell,
   Fillet edges once they exist).
5. Nominal-value chips: every measured length, radius, distance and grip
   distance offers its rounded value, one click to take it.
6. A number field on the grip while it is dragged; typing overrides.
7. Sketch status in two states, needs input / solved, the solver's words
   (redundant, over-constrained) behind a tooltip. Relations inferred at
   draw time — H/V within a few degrees, coincident, tangent — shown as
   chips that can be switched off.
8. Grid snapping becomes a toggle, default off; the grid stays visual.

**Phase B — stable naming and the body features (milestone 3).**
1. Stable face/edge references: geometric fingerprint (type, centroid,
   normal or axis, size) plus the creating feature, combined with OCCT's
   Modified/Generated history where the adapter can expose it; re-found on
   every rebuild, a lost pick fails its feature loudly. Built before any
   feature that references body topology.
2. Face and edge picking in the 3D viewport with hover highlight, the
   unselectable dimmed, one faces/edges filter toggle.
3. Shell (thickness from the Thickness map's median), Fillet/Chamfer (radius
   estimated from a section across the picked edge, tangent-chain
   propagation), Hole (a cylinder element cut through), Extract element as
   body, Cut by plane, Mirror about a plane, Boolean between bodies.
4. Feature list as timeline: rollback marker, key parameter inline and
   editable, double-click to edit.
5. Features saved in the project file, rebuilt on load once the kernel is
   up.
6. `e2e-bracket` passes at ±0.2 mm.

**Phase C — verification and integration (milestone 4).**
1. Compare in Deviation as designed; a live scan→body distance readout in
   the panel without a colour plot was open for decision (patent stance)
   — settled 2026-09-16 as the full live map, see "Feedback".
2. An alignment nudge when the first sketch starts on an unaligned part;
   symmetry detection as the basis for Mirror.
3. Guided first project on the empty state; the scan always shown as a
   reference, never converted.

**Later.** Sketching in the 3D view normal to the plane (removes the sheet
seam), single-key verbs and a command palette, patterns.

**Decided the same day:** no live deviation inside the workspace (Compare
in Deviation stays the only path) — **reversed 2026-09-16**, see
"Feedback" above; Ctrl suppresses snapping, as in Fusion;
Cancel disappears from the sketch, Finish sketch is the one exit.

## Surface route (study of 2026-09-16)

Six QuickSurface Pro demo shorts — a connector, a Tesla frunk, a truck
wheel cap, a broken drive coupling, a fan base, a shoe heel — were read
frame by frame (they carry captions, three have a narration) against this
repository's modules and the kernel wrapper's typings, to decide whether
the surface-based way of working could be built here beside the sketch
route. **Verdict: yes, as a complement, not a replacement.** Two of the six
parts are built the way this workspace already works.

### What QuickSurface does, per part

- **Connector** (primitives only). *Extract primitives*: one click on a
  face, a flood fill by normal angle (a slider, 1.04° in the demo; also
  brush, lasso, rectangle, "select all connected triangles"), fit one of
  plane / cylinder / axis line / cone / sphere; a live map at 0.1 mm on the
  region. *Auto Constrain*: a new plane snaps parallel or perpendicular to
  the planes already made within a tilt tolerance of 0.5° and a coincidence
  tolerance of 1 mm; a dropdown forces a relation. About fifteen planes.
  *Fillet* between two surfaces before any solid exists: shape Circular,
  radius Auto (read off the mesh), "Add tangent edges" walks a chain and
  lists a radius per edge, live map on the strip. *Trim selected objects*:
  pick surfaces, "Apply Automatic Trimming" at a tolerance (0.8 mm) with an
  "Overlap with reference mesh" slider; the result is shown as coloured
  patches, "Multiple surfaces" until the set closes, then "Single Surface",
  then Solid in the tree; a visibility list of the remaining faces to toggle
  by hand. *Thicken* 1.1 mm into a solid, then ordinary CAD (sketch,
  extrude, cut, combine, pattern), a whole-part Compare, STEP.
- **Truck wheel cap** and **drive coupling** (prismatic, narrated). Align;
  cross-section sketch with *Fit entities* on the section points; revolve
  the main body, check deviation; sketch on a plane, **extrude it as an
  open trimming surface** with two depths and a **draft angle** (5.25°),
  live map on the sheet; fillet that surface against the mesh; **circular
  pattern** the cutters; **trim the main body with the cutters**; loft
  trimming surfaces between two sketches for the ribs; **shell** to
  uniform thickness (2.6 mm) with the map on the whole part; pattern the
  design features; fillets; the coupling adds extruded cuts, combine to one
  body, duplicate and extend surfaces, and a final Compare. This is the
  sketch route of this workspace, plus milestone 3 and a few operations.
- **Fan base** (freeform, narrated). *Fit Surface* on a region with the
  same selection tools: Method Refined, a **U × V control net count**
  (5 × 5, lockable, "Auto…"), degree with a "Max degree" check (4),
  **"Expand by" 40** to grow the surface past the selection, a **surface
  smoothness** slider, **"Surface orientation: Selection bounds"** — the
  frame the fit is parameterised over — and the 0.1 mm map. Several such
  surfaces cover base, boss and sides; then the 2D sketch, extrude with
  draft, fillets between neighbouring freeform surfaces ("adjust
  transitions"), trim to a single surface, shell.
- **Tesla frunk**. Four lines drawn on the mesh become a **four-sided
  patch** with *Contact* or *Tangent* at each side and tangent-direction
  handles at the corners; two 3D curves on the mesh become a **loft**
  strip; trim, mirror, export.
- **Shoe heel** (the Freeform module). 3D sketch curves snapped to the mesh
  with a **curvature colouring** on the scan to guide them; *Create
  Freeform surface* lays a **control cage** over the scan whose points snap
  to the nearest mesh point (Points/Edges, Closest Point, Set on Symmetry
  Plane); trim with a plane, fillet, export. A subdivision-style cage
  editor, not a fit.

Every dialog carries an "Analysis 0.1 mm" check: the live map is how the
operator steers, which is what reversed the feedback decision above.

### What is already here

| QuickSurface | Here | Gap |
| --- | --- | --- |
| Click and grow, paint a region | `viewer/marking.ts` (brush, window, lasso), `core/fit/regionGrow.ts` (grow by normal with rim peel) | a plain normal-angle flood fill with a slider |
| Fit plane, cylinder, cone, sphere | `core/fit/*` — LMedS candidates, clipped Gaussian refit, σ and form error | torus |
| Auto Constrain | `elements/orient.ts` (one-off align to a reference plane, 2°) | refit with a fixed normal or axis, snap within tolerances |
| Live map on a fitted surface | `core/deviation/elementField.ts` for plane, cylinder, sphere; the body path via `core/deviation/surface.ts` | cone and freeform branches, or always the tessellated path |
| Fillet with a fitted radius | kernel `fillet`, `filletVariable` | the radius estimate (milestone 3) |
| Trim surfaces into a solid | kernel `halfSpace`, `split` (BOPAlgo_Splitter, takes faces as tools), `intersectionCells` (BOPAlgo_CellsBuilder), `section`, `sew`, `sewAndSolidify`, `healSolid`, `fixShape` | the algorithm on our side |
| Thicken, shell, loft, sweep, patterns, mirror, draft | kernel `thicken`, `shell`, `loft`, `sweep*`, `linearPattern`, `circularPattern`, `mirror`, `draftPrism` | adapter widening |
| 3D curve on the mesh | picks on the part; kernel `approximatePoints`, `interpolatePointsWithTangents` | small |
| Fit Surface | nothing; kernel `bsplineSurface(points, rows, cols)` makes a surface through a regular grid (`GeomAPI_PointsToBSplineSurface`, as found building D2 — the study had read it as a net with no fit) | the fit through scattered noisy points, in TypeScript; its result sampled on a grid for the kernel |
| Control-cage freeform surface | nothing | not planned |
| Auto surfacing | nothing | not planned |

The kernel wrapper binds these by name; only the embind-bound set is
reachable, there is no raw OCCT class access. `libcascade` would not change
the picture.

### The two new algorithms

**Automatic trim.** Every surface in the set becomes a tool that reaches
past the scan: a plane a half-space, a cylinder, cone or sphere an
oversized primitive, a freeform surface the face itself expanded by its
margin. A box round the scan is `split` by the tools, which cuts space into
cells. A cell face is **kept when its sample points lie on the scan**
within the tolerance — the "overlap with reference mesh" rule, with the
scan's BVH in `core/deviation/surface.ts` giving the distance. The kept
faces are sewn, solidified and healed. If the shell does not close, the
feature reports "multiple surfaces" and lists the open edges, and the
operator adds a surface or toggles faces in the remaining-faces list, as in
QuickSurface. The same cell test with a single sheet is **split a body by
a surface, keep the side on the scan** — the wheel cap's cutters.

**Fit Surface.** The region's principal frame (`core/deviation/prealign.ts`
`principalFrame`) is the base plane; the points are projected to (u, v),
the bounds grown by the margin, and a tensor-product B-spline of degree 3
with a U × V control net is solved by **linear least squares** with a
thin-plate smoothing term whose weight is the smoothness slider. For the
net sizes in use (5 × 5 to 20 × 20) the dense Cholesky in `fit/linalg.ts`
is enough. The net goes to the kernel's `bsplineSurface`, and the face is
tessellated for the ghost and the live map. A four-sided patch is the same
fit parameterised over a Coons surface of its four boundary curves, with
tangency to a neighbour fixing the boundary rows of the net. A control net
count that is "Auto" comes from the region's extent over its scatter.

### What is not planned

The control-cage freeform surface (the heel) is a modelling tool, not a
fit, and UI-heavy; automatic patch layout is a research project. Neither is
on the milestone list.

## Repository

The workspace is `plugins/reverse/`; `plugins/README.md` says what a plugin
is and how it reaches the app.
