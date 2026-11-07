<!-- SPDX-License-Identifier: AGPL-3.0-only -->

# Measuring a 3D scan (ScanRuler)

Guiding principle: **measure from reliable scan evidence, against datums the part actually uses, and never report a number finer than the scan can hold.**

A scan is a cloud of noisy samples of a surface. Every number you give rests on a fit, an alignment and a tolerance you chose; say which, so a person can repeat it. Numbers decide; pictures show where.

This guide is the workflow and the judgement. **measure-reference** has every command's shape (Command shapes), what each answer costs (Reply cost) and what each refusal means (Errors) — read one section of it when you need it: `guide_read { topic: "measure-reference", section: "Errors" }`.

## 0. Setup

- **Tools.** The tools are ScanRuler's commands with dots turned into underscores (`element_fit`). The server prefix can change mid-session; on "No such tool", load again by the new prefix. Load the tools you need by exact name; every tool loaded stays in context.
- **Session.** `scanruler_status` first:
  - `backend` "page" is a ScanRuler tab the person watches; "headless" runs without a scan or viewport, where measuring tools answer `unavailable` — measuring needs page mode.
  - `page.origin`: scanruler.com is the released build, localhost a development build. No page → `scanruler_open` (opens one paired, and waits); if still unconnected, pass on `howToConnect` and `scanruler_wait`.
  - `page.hidden: true` — the tab is in the background or the screen is locked. Commands still run; pictures and anything waiting on the screen are slower. Tell the person once to keep the site active in Chrome's Memory Saver.
  - `jobs` — the running changes and the newest few, each running, done or failed.
  - `serverTooOld` — the connector is older than the page needs (the page shows the person a banner with the steps); `server.latest` — a newer one is out, which the server takes up by itself at its next start. Tell the person once: quit the app completely and open it again — while this copy relays (`server.role: "relay"`), the app to quit is the other one, holding the connection. Change nothing on your own; when the person asks you to update it, change your app's scanruler setting to run `npx -y scanruler-mcp@latest`, and tell them to quit the app and open it again.
- **Read `session_state` before acting and after.** The scan's bounding box says where the part lies; the elements, dimensions and sections what is measured; the history what can be undone.
- **Every answer is in millimetres** (angles in degrees), whatever the screen shows. The person may have it in inches — `session_state` → `ui.units` says which — so a figure you point them to on screen reads there as mm ÷ 25.4.
- **The person can undo anything** you do in the viewport; every change is one undo step. Do not fight their edits — read the state again.
- **Keep the context small** (measure-reference, Reply cost): `limit` on point queries, renders at the default 800 px, `report_get` once at the end, short reasoning between steps.
- **Task list:** open and inspect → noise floor and tolerance → datums → fit and dimension → sections, deviation, thickness as asked → report and files.

## 1. Open and inspect

- `scan_open` with the full path. An STL carries no units: check the answer's bounding box. A 40 mm bracket reading 1.57 across was in inches; 40000 across, in micrometres — open it again with `units`. Opening replaces the session; it refuses over measurements unless `discard: true` (save first with `project_save`).
- **A photogrammetry scan has no true size** (Meshroom's `texturedMesh.obj`, any structure-from-motion mesh): `session_state` says `scan.noTrueSize` when one looks like it. Ask the person for one or more lengths taken on the real part with calipers — long ones, best between centres (hole to hole, ball to ball). Measure the same lengths on the scan (fits and `dimension_add`), then `scan_scale` with `references: [{ dimension, true }]` — `dryRun: true` first to see each reference's `offPct`; one far off the others is a bad fit or a typo. Scale before modelling: it refuses once a model or notes are built on the scan. Everything measured scales with it, and `scan.scaled` keeps the record for the report.
- **Look at the part** from iso, top, bottom and the sides with `view_render`. Note open rims (missing data, not holes), spikes, blobs in holes and stitching seams — none of them may carry a measurement.
- **Measure the noise floor.** `element_fit` a plane on the largest face that is clearly one flat surface; its form error (RMS) is σ_scan. Fit a cylinder in the best bore as well. **Nothing measured on this scan is trustworthy finer than about 3 σ_scan.** Write it down; it goes in the report.
- **Decide the tolerance** you judge against: the drawing's if the person has one, otherwise ask, otherwise a process value — machined 0.02–0.05 mm, moulded or die cast 0.05–0.1, cast, forged or printed 0.3–0.5. If the tolerance asked for is under 3 σ_scan, say the scan cannot decide it before measuring.

## 2. Datums and alignment

- **Coarse first:** `align_auto` puts the part on its base, long side along X.
- **Then datums from function**, with `align_datum`: the primary is the face that mates (the mounting face, a flange face, a turned part's axis) — not the largest plane. Secondary: an edge, a second face or a line through two hole axes. Origin: a hole axis, a corner, a sphere. Fit the datum elements first; each may be an element or points on the scan.
- **Symmetric parts:** `element_construct` with `plane-symmetry` finds the scan's own mirror plane without moving the part; its `symmetry.rms` is how asymmetric the part is. `align_symmetry` re-poses the part on it.
- **Cross-check** the frame with another face or bore: the angle between a fitted face and the axis it should lie on is the alignment's residual. Report it.
- Everything measured moves with the part; alignment is one undo step.

## 3. Fitting elements

- `element_fit` with a place on the scan: `{ point: [x, y, z] }` (the nearest vertex is taken) or `{ vertex: n }`. **Aim at the feature's middle**, not near an edge or a fillet — the fit grows its surface from there. A feature seen in patches (a bore interrupted by a slot) can take several places.
- **Outliers:** `sigma: 3` by default; 2 on noisy, threaded or knurled surfaces; 0 to keep every point. Record which.
- **Read every fit:** radius, form error, coverage and point count. A low point count or coverage means the seed sat on a small patch — move it. A form error far over σ_scan on a surface meant to be one shape means it is not one shape (a fillet caught, two faces read as one, wear).
- **Regions by hand:** `scan_query { box | near, normal }` returns the vertices facing a direction; `element_fit_marked` fits exactly those. Use it for a face the seeded fit leaks off, and take the whole face — a fit on one well-scanned patch can be off elsewhere.
- **Designed directions:** `orient: { to, relation }` holds a fitted element square to or in a reference plane, as designed; the measured fit is kept beside it. Use it only where the drawing says so, and report it.
- **Designed sizes:** `assumed` draws and exports a sphere, cylinder or circle at its nominal diameter; it is still reported as measured.
- **Known balls:** a precision sphere (a gauge ball, a ballbar's) whose diameter is known: fit it with `knownDiameter` — it holds the diameter and fits the centre alone, which keeps the centre right on a ball scanned only partly. Read `fit.held.freeDiameter` against it: a scan reading off by some µm moves a held centre by about as much towards the scanned side. On a ball scanned all round, the free fit is as good. Write down which was used.
- **Constructions:** `element_construct` — midplanes, offsets, intersections (line-plane-plane, point-line-plane), circles where a plane cuts a cylinder, planes from typed-in numbers. A section stands in any plane's slot as the plane it was cut on.
- **Points on the surface:** `scan_nearest` checks a place lies on the scan before fitting there.
- Batch runs of fits and point probes with `scanruler_batch`.

## 4. Dimensions and checks

- `dimension_add` with the elements as `refs`. Without `type` the type follows the elements (two planes: their distance; a plane and an axis: their distance; two spheres: centre distance). With `type`: distances and angles between points, axes and planes; `size-diameter`; form (`form-flatness`, `form-cylindricity`, `form-circularity`, `form-sphericity`); orientation (`orient-parallelism`, `orient-perpendicularity`, `orient-angularity` with a basic angle); location (`loc-coaxiality`). Reference.md lists the slots of each.
- **Limits:** `limit: { kind: "band", nominal, plus, minus }` for a size, `{ kind: "max", max }` for a tolerance zone. Every dimension then carries a pass or fail verdict. Change one later with `dimension_set_limit`; an angularity's basic angle with `dimension_set_basic`.
- **These are GD&T-like, not certified.** Form and orientation are read off fitted elements of a noisy scan: a flatness of 0.04 on a scan with σ 0.02 is mostly the scan. Say so in the report.
- **A verdict within 3 σ_scan of its limit is not a verdict** — call it inconclusive and say why.
- **Distances between features come from their fitted elements**, never from single picked points.

## 5. Sections and the 2D sheet

- `section_cut` across a coordinate plane ("XY", "YZ", "ZX" — `offset` is then the coordinate) or an element with a direction (`offset` along its normal). `section_get` returns the polylines in the section's own [u, v] and its plane frame; `space: "world"` gives [x, y, z].
- **A shadow** — `section_cut` with `kind: "shadow"` — is the whole scan projected along the plane's normal onto it: the part's widest outline, every indentation filled, where each cut through a notch is smaller. It is what a bin, a foam cutout or a pocket for the part is drawn from. The outline is read as lines and arcs to `tolerance` (0.1 mm by default) and lies between `play` and `play` + 2·`tolerance` outside the exact silhouette (`play` 1 mm by default; 0 for none, negative a press fit); where two lines meet turning by less than `smoothDeg` (30° by default, 0 for none) the corner is rounded by a tangent arc, so a faceted curve comes out smooth, and sharper corners stay sharp; the answer gives `loops`, `areaMm2` (holes taken off) and `outside` { min, max }, the band measured. The plane's direction decides what is seen; a shadow takes no `offset` and is drawn in the middle of the part. On the sheet it measures like a cut, and `export_dxf` and `export_svg` write the outline as LINE, ARC and CIRCLE, not a polyline. By default (`extrude: false` to keep it flat) it stands through the part's thickness as a block (`extent` gives its ends along the normal), which `export_step` with `style: "solids"` writes as a solid: a planar face at each end, a face per line or arc. A sheet seen edge-on casts no shadow.
- **Slice pockets, bosses and holes at several heights**: a shape round in one slice may be a turned rounded rectangle, and the change from slice to slice reveals draft, tilt and rounds.
- **The 2D sheet** measures a section (already in mm) or a flatbed image of a flat part:
  - an image: `flat_open_image`, then `flat_calibrate` against a known length — until then its scale is only what the file declares;
  - edges: `flat_detect_edges` (sensitivity 0–1), `flat_edges` to list the chains;
  - parts on an image: `flat_objects` (area, holes, Feret widths, axis);
  - elements: `flat_fit` — pick methods snap places to the nearest edge, seed methods grow along an edge, edge methods take whole chains or a box;
  - `flat_dimension_add` between 2D elements; `flat_set_alignment` for the report's frame; `flat_note_add` for a label;
  - teeth, knurls, gears: `flat_profile` counts the peaks of an outline round a centre or along an axis;
  - `flat_render` is a picture of the sheet with a grid in its units; its `map` turns a pixel back into a sheet place.
- `view_render` pictures only the 3D view; with the 2D workspace on screen use `flat_render`, or `workspace_set { workspace: "measure" }` to bring the 3D view back.

## 6. Deviation against a reference

- `deviation_open_reference` with the reference part's path (STEP, STL, PLY, OBJ or 3MF; `units` for those without). It replaces any reference there was.
- **Align:** `deviation_align`.
  - `mode: "auto"` finds the pose on its own — a best fit over the whole part. It spreads a real error over everything: a shifted bore makes the whole part read slightly off.
  - `mode: "points"` starts from three or more pairs of the same point on scan and reference, then refines — for symmetric parts where auto may pick a wrong turn.
  - `mode: "local"` refines on a marked surface only (`vertices` from `scan_query`) — fitting on the datum faces, the way the part is held. Prefer it when the person cares how the part sits on its datums.
  - Read the answer's RMS and points matched; report the mode.
- **Set the reading:** `deviation_settings { tolerance, range, maxDistance }` — range about 3 × tolerance; `maxDistance` large enough to reach real errors but under the wall thickness, so a point is not measured against the far wall. `facingDeg` limits which surface a point is measured against. A change of facing measures again; `deviation_measure` measures again under the alignment in hand.
- **Volume first: `deviation_volume`.** The scan and the reference compared as solids — how much material is wrong and where, which the surface map cannot say. `excess` is material the reference has and the part has not, `missing` the other way round; each region with its volume, depth, `shape` (`layer`: a face standing off, about `thickness` thick; `lump`: a boss, pocket or rib there or not) and box. A lump of more than a few mm³ is a feature missing or extra: name it before reading patches. `unsure` is where the scan does not say — never call it an error. It does not see anything thinner than `smallestSeen`; the patches stay the tool for fine offsets. Look at a region with `view_render { frame: region.box }`.
- **Then `deviation_hotspots`, not the colours.** Patches over tolerance, largest and farthest first, each with centre, box, area, mean and extreme, and side. Then **`far`** — read it every time: `far.inside` is scan deeper inside the reference than the search distance, where the reference has material the part has not (a hole, pocket or slot the reference lacks, or a gross misalignment); `far.outside` is the part standing off the reference (extra material, or scan spray). A map that reads clean within reach can still miss a whole feature; it shows in `far` and nowhere else.
- **Look at each patch** with `view_render { frame: patch.box }` and read the scan there with `scan_query { box }`.
- **Colours are the person's choice.** The colour map is a browser preference; read `settings.colormap` from `deviation_settings {}` before judging a picture, or set `colormap: "jet"` (blue inside, green on, red outside) and tell the person you changed it. On viridis the dark end is *inside*, not *bad*.
- **Against an element instead of a part:** `deviation_set_target` maps how far the scan strays from one of its own fitted elements — the form of a face or a bore made visible.
- **Classify every patch and far cluster:** a real deviation of the part; misalignment (patches of opposite sign on opposite sides, a twist); scan artefact (spikes, fill in holes, open rims); or process scatter within tolerance — count it once, don't chase it.

## 7. Wall thickness

- `thickness_settings` then `thickness_measure`. `method: "ray"` shoots along the inward normal to the far wall (`coneRays` takes the shortest of a cone — steadier on curved walls); `"sphere"` takes the largest sphere that fits — the true wall at corners and ribs. `maxThickness` just over the thickest wall expected; `normalDeviationDeg` rejects hits on a far wall that does not face back.
- `limit` is the thin-wall limit the statistics count under; `low` and `high` the colour scale.
- Read min, mean, sigma and the share under the limit. Thin readings along open rims and at the edge of missing data are the rays escaping — not thin walls. Check a thin patch with `view_render` and a `section_cut` through it before reporting it.

## 8. Pictures, report and files

- **Pictures:** `view_render` with `view`, `frame` and `show` (`{ scan: false }`, `{ labels: false }`), and `section` to cut the view open. Check at the default 800 px; for the deliverables `width: 1400` with `path` into the person's folder. Name the colour map and range beside every deviation picture.
- **Report:** `report_get` — `format: "json"` (structured: frame, alignment, fit method and outlier cut-off per element, every dimension with value, limit and verdict, sections, deviation, thickness and 2D results) or `format: "text"` with `workspace` (word for word what the panel's Copy report gives).
- **Files:** `project_save` (the whole session, reopened and re-measured), `project_rename` (the stem of every export), `export_step` (the fitted elements as analytic STEP), `export_stl` (the scan in its aligned pose, STL or 3MF), `export_cloud` (points with normals), `export_csv` (2D measurements), `export_dxf` and `export_svg` (the 2D sheet at true scale). Each writes to `path`.
- **Write-up:** what was measured, on which scan, in which frame (datums and residuals), σ_scan, the tolerance used and where it came from, every dimension with nominal, measured and verdict, deviation with its alignment mode and `far`, thickness with its method, every assumption (`orient`, `assumed`, sigma), and the pictures.

## 9. Batches, jobs and undo

- `scanruler_batch` runs many calls in one round trip — twenty `scan_nearest`, a row of `element_fit`, a set of dimensions. **It stands or falls whole:** stopped at the first refused call, with `rollback` (the default) it undoes what the calls before it changed and answers `failed: { index, tool, error }` and `undone` (the step labels taken back, newest first). Fix that call and send the batch again. `rollback: false` keeps what went through. `timings: true` adds each call's `ms` and the batch's total_ms — the way to find the slow step.
- **By hand across several calls:** `history_checkpoint` before, `history_restore { checkpoint }` to go back to it. `history_undo` takes one step back.
- **Jobs.** Every tool that changes the session takes `wait`. `wait: false` answers at once with `{ queued: true, job }` while the change runs on; `scanruler_wait { for: "job", job }` gives the answer. A batch takes `wait: false` too. The server keeps every change as a job, so a call that timed out on the client keeps running and its answer can be read: **never resend it** — find it in `scanruler_status` `jobs`. While a change runs, read-only tools such as `session_state` still answer.

## 10. Final reply

Short: the frame and σ_scan, the tolerance used, the headline results against it (pass, fail, inconclusive), deviation and thickness findings with their causes, the judgement calls, and the file list. Don't recap every step.

## Red flags

| Symptom | What it means | What to do |
|---|---|---|
| Scan size implausible (1.57 across for a 40 mm part) | Wrong units | `scan_open` again with `units` |
| Datum plane form error far over σ_scan | Not one flat face: a fillet or a second face caught, or a bowed part | Mark the face with `scan_query` + `element_fit_marked`; report a bow |
| Fit with low coverage or few points | The seed sat near an edge or on a small patch | Seed in the feature's middle; several places for a broken surface |
| Bore radius sensible, form error high | Threads, knurl, or scan stripes | `sigma: 2`; read it as a thread, not a size |
| A verdict within 3 σ_scan of its limit | The scan cannot decide it | Report inconclusive, with σ_scan |
| `deviation_align` RMS high | Wrong reference, wrong units, or a wrong turn on a symmetric part | Check units; `mode: "points"` with pairs |
| Patches of opposite sign on opposite sides | Misalignment, not the part | Align on datums (`mode: "local"`), measure again |
| `far.inside` high | The reference has material the part lacks — a missing hole or pocket — or the part sits far off | Look at each far patch; check the alignment |
| `far.outside` high | Extra material on the part, or scan spray | Look; class spray with evidence |
| Thin-wall share high along rims | Rays escaping at open boundaries | `normalDeviationDeg`, a `maxThickness` just over the wall, or `method: "sphere"`; check with a section |
| `section_cut` "misses the scan" | The offset is a coordinate on a coordinate plane, not a distance from the middle | Read the bounding box; give the coordinate |
| `view_render` refused: 2D workspace on screen | The 3D view is not drawn there | `flat_render`, or `workspace_set { workspace: "measure" }` |
| `flat_fit` pick refused: no edge within reach | The place is off the detected edges | `flat_detect_edges` at a higher sensitivity, a larger `reach`, or `snap: false` |
| A batch answers `failed` and `undone` | Stopped at a refused call; earlier changes taken back | Fix that call, send the whole batch again |
| A call times out on the client | Still running as a job | Never resend; `scanruler_status` `jobs`, then `scanruler_wait { for: "job", job }` |
| **busy** | A load, fit or measurement is under way, or the person is working | `scanruler_wait { for: "idle" }`, retry |
| **unavailable** | Headless server, or no page paired | Page mode; `scanruler_open` |
| `page.hidden: true` | Tab hidden or screen locked | Carry on; pictures slower; warn once about Memory Saver |
| "No such tool", **unknown_command** | Stale tool list or new prefix | Load the tools again; `scanruler_status` |
