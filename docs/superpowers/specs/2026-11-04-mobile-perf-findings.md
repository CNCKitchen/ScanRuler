# Mobile UI responsiveness — findings (spec for the fix plan)

Reported: on a phone, tapping **Surface Deviation** and several other toggles
takes a while before their UI appears.

## Method

`scripts/perf-probe.mjs` drives the app in Chrome emulating a Pixel-class phone
(412×915, DPR 2.625, touch), CPU throttled 4×, on the sample scan
(`public/samples/fridgeBracket_01-reduced.3mf`, 288k tris) with the same file as
reference. Per tap it records: Event Timing duration (INP), long tasks, Long
Animation Frame scripts, a CPU profile, and WebGL work (shader links, bytes
uploaded, contexts created). Runs: `vite` dev and `vite build` + `preview`.
GPU was a desktop RTX via ANGLE, so GPU cost is under-represented — the WebGL
counters are the proxy for what a phone GPU pays.

## Baseline (production build, 4× throttle)

### v1 — one run, the first (cold) tap of each row

| Action | INP ms | GL work in the tap |
|---|---|---|
| Section view on | 336 | 6 shader links |
| Tab → Reverse (plugin) | 232 | – (132 ms TopBar fold loop) |
| Split on | 128 | 1 new context, 6.8 MB, 1 link |
| Tab → 2D Measure | 120 | 1 new context |
| Tab → Deviation (map in hand) | 112 | 0.6 MB |
| Tab → Thickness (map in hand) | 104 | 0.6 MB |
| Tab → Deviation (scan only) | 96 | 0.6 MB |
| Map on reference | 56 (+175 ms task) | 2 links, 18.3 MB |
| Animate on | 32 (+104 ms task) | 1.7 MB |
| Animate off | 48 | 7.6 MB re-upload |
| Map on/off, source switch | 56–88 | 0.6 MB |
| Idle 3 s | – | 265 ms main-thread busy, rAF never stops |

Dev build is 2–3× worse (React 19 dev owner stacks).

### v2 — probe v2: median of 5 taps, profiler off

`scripts/perf-probe.mjs`, full output with hot lists and budget results in
`e2e-out/perf-baseline-v2.txt` (production bare, dev rich, dev bare). Scan: the
288k-triangle sample — no ≥ 1M-triangle scan was at hand (`SCAN=` overrides).
The production hot lists are named through `vite build --sourcemap`. "INP first
tap" is the cold tap of the five (programs compiled, buffers created, caches
empty); Event Timing is 8 ms-grained and reports nothing under 16 ms, so 0 and
16 mean "under the floor". The machine is shared: two identical passes differed
by up to ~1.7× (pass A of the same probe: Tab → Deviation scan only 64, Tab → 3D
Measure 64, Tab → Deviation map in hand 72, source → reference 72, section view
on 64), so compare before and after in one sitting.

What the medians say: the warm taps are cheap — a tab is 72–128 ms, most
toggles 24–80 ms — and what v1 measured was mostly the cold tap: section view
is 104 ms warm but 416 ms on its first tap (6 links), Tab → Reverse 96 warm but
232 first, Tab → 2D Measure 88 / 112 and Split on 104 / 144, each making a
context on every open (the budget `contexts: 0` counts taps after the first). The
GL work is the same on every tap: 0.6 MB of unchanged colours on every tab or map
tap, 7.6 MB when the animation stops, 2 links and 18.3 MB on the first map on the
reference. Idle 3 s: 437 animation-frame callbacks, 536 ms busy.

Production, bare scenario:

| Action | INP median | INP first tap | long task max | GL work (worst tap) |
|---|---|---|---|---|
| Open sample scan (single run) | – | – | 324 ms | 1 links, 7.6 MB |
| Tab → Surface Deviation (scan only) | 72 | 64 | 0 ms | 0.6 MB |
| Tab → Wall Thickness | 72 | 72 | 0 ms | 0.6 MB |
| Tab → 2D Measure | 88 | 112 | 55 ms | 0.6 MB, 1 new ctx |
| Tab → workspace-reverse (plugin) | 96 | 232 | 0 ms | 0.6 MB |
| Tab → workspace-mesh (plugin) | 72 | 80 | 0 ms | 0.6 MB |
| Tab → 3D Measure | 80 | 72 | 0 ms | 0.6 MB |
| Thickness: scan key off (view bar) | 40 | 32 | 0 ms | – |
| Thickness: scan key on (view bar) | 40 | 32 | 0 ms | – |
| Thickness: bands on (5 bands) | 64 | 88 | 50 ms | 0.6 MB |
| Thickness: bands off (continuous) | 64 | 64 | 51 ms | 0.6 MB |
| Thickness: histogram off | 40 | 48 | 0 ms | – |
| Thickness: histogram on | 40 | 40 | 0 ms | – |
| Tab → 3D Measure (reference loaded) | 80 | 80 | 0 ms | 0.6 MB |
| Tab → Surface Deviation (first show of the reference) | 72 | 72 | 0 ms | 0.6 MB |
| Deviation: map off | 48 | 56 | 0 ms | 0.6 MB |
| Deviation: map on | 64 | 80 | 0 ms | 0.6 MB |
| Deviation: split on | 104 | 144 | 51 ms | 1 links, 6.8 MB, 1 new ctx |
| Deviation: split off | 48 | 56 | 0 ms | – |
| Deviation: map on reference | 120 | 56 | 95 ms | 2 links, 18.3 MB |
| Deviation: map back on scan | 80 | 64 | 56 ms | 0.6 MB |
| Deviation: histogram off | 40 | 48 | 0 ms | – |
| Deviation: histogram on | 40 | 40 | 0 ms | – |
| Deviation: range slider step 1 | 56 | 16 | 0 ms | 0.6 MB |
| Deviation: range slider step 2 (back) | 64 | 64 | 52 ms | 0.6 MB |
| Deviation: tolerance change (0.05) | 56 | 64 | 50 ms | – |
| Deviation: tolerance change (0.08) | 64 | 64 | 0 ms | – |
| Deviation: animate on | 56 | 56 | 165 ms | 1.7 MB |
| Deviation: animate off | 72 | 48 | 0 ms | 7.6 MB |
| Deviation: volume show on | 48 | 48 | 0 ms | – |
| Deviation: volume show off | 48 | 48 | 0 ms | – |
| Deviation: source → element | 56 | 72 | 0 ms | 0.6 MB |
| Deviation: source → reference | 120 | 88 | 80 ms | 0.6 MB |
| Deviation: section view on | 104 | 416 | 0 ms | 6 links |
| Deviation: section view off | 56 | 56 | 0 ms | – |
| Tab → 3D Measure (maps in hand) | 88 | 112 | 56 ms | 0.6 MB |
| Tab → Surface Deviation (map in hand) | 120 | 120 | 80 ms | 0.6 MB |
| Tab → Wall Thickness (map in hand) | 128 | 136 | 98 ms | 0.6 MB |
| Tab → Surface Deviation (from thickness) | 112 | 96 | 77 ms | 0.6 MB |
| Settings open | 64 | 104 | 0 ms | – |
| Settings close | 24 | 32 | 0 ms | – |

Rich scenario (dev server; the GL counters are the same as production, INP is
2–3× production): the sample plus 7 elements (3 planes, 3 cylinders, 1 sphere
that the sample does not really have — it has no sphere, the fit took the best
R2–R40 candidate), 4 dimensions, 1 section and, in the deviation workspace, 5
pinned probes. The rows the gated tasks name:

| Action (dev server, rich project) | INP median | INP first tap | long task max | late long task (> 250 ms after the tap) | GL work (worst tap) |
|---|---|---|---|---|---|
| Tab → Surface Deviation (scan only) | 176 | 248 | 141 ms | 81 ms | 0.6 MB |
| Tab → 3D Measure | 336 | 432 | 228 ms | 130 ms | 5 links, 0.6 MB |
| Tab → workspace-reverse (plugin) | 312 | 544 | 202 ms | 106 ms | 5 links, 0.6 MB |
| Tab → 3D Measure (maps in hand) | 368 | 280 | 258 ms | 92 ms | 5 links, 0.6 MB |
| Tab → Surface Deviation (map in hand) | 376 | 304 | 303 ms | 0 ms | 1 links, 0.6 MB |
| Tab → Wall Thickness (map in hand) | 336 | 424 | 293 ms | 81 ms | 0.6 MB |
| Deviation: map off | 176 | 216 | 154 ms | 117 ms | 0.6 MB |
| Deviation: map on | 184 | 184 | 178 ms | 178 ms | 0.6 MB |
| Deviation: range slider step 1 | 240 | 32 | 225 ms | 84 ms | 0.6 MB |
| Deviation: tolerance change (0.05) | 248 | 264 | 233 ms | 93 ms | – |
| Deviation: source → element | 136 | 136 | 89 ms | 0 ms | 2 links, 0.6 MB |
| Deviation: change element target (A) | – (page-driven select) | 0 | 331 ms | 72 ms | 2 links, 0.6 MB |
| Deviation: change element target (B) | – (page-driven select) | 0 | 320 ms | 75 ms | 2 links, 0.6 MB |
| Deviation: element facing limit on | 312 | 312 | 285 ms | 64 ms | 0.6 MB |
| Deviation: element facing limit off | 264 | 264 | 237 ms | 74 ms | 0.6 MB |
| Deviation: section view on | 128 | 368 | 86 ms | 0 ms | 6 links |
| Brush stroke (20 moves, rich) | 152 | 152 | 130 ms | 0 ms | 3.1 MB |

- **Overlay rebuild on tab switch** (task 7): with the project, every switch
  into Measure (and the one to the Reverse tab) makes **5 shader links** (bare: 0) and the tap is 336 ms
  median against 80 in production and 128 on the dev server without the project. `updateOverlays` is 4 ms
  inclusive in the profiled tap, `evaluateDimensions` under 1 ms (4 dimensions) —
  the compile, not the evaluation, is what the project adds at this size.
- **`evaluateDimensions`**: under 1 ms inclusive on every row — nothing to save
  by skipping it at this project size.
- **Recovery long task after a toggle** (task 13): a long task starts more than
  250 ms after the tap on map off / map on — 117 / 178 ms median in the rich
  scenario (0 in production bare, 0–67 ms in dev bare); the 300 ms `inspect()` timer
  is the candidate, the profile does not isolate it.
- **Element-map recompute** (task 11): changing the element target is a
  331 / 320 ms long task with 2 links, the facing limit a 312 / 264 ms tap;
  `computeElementDeviation` 19 ms and `suggestRange` 5–10 ms inclusive in the
  profiled tap. The select is set by the page (a native picker cannot be
  driven), so the target rows have no INP.
- **Brush stroke upload** (task 16): 3.1 MB uploaded per 20-move stroke (706
  points marked), 152 ms median tap.

## Findings

F1 Click-path effects run before paint: zustand updates are SyncLane, a tap is a
discrete event, so every `useEffect` in `src/app/useSceneSync.ts` and
`src/app/useElementField.ts` runs before the browser paints.

F2 Full CPU recolour per view change: `useSceneSync.ts:789` → `paintField`
(`src/core/field/colormap.ts:103`) over every vertex on workspace/source/mapOn/
showMap/range/maxDistance/bands/colormap changes, even when the result is
identical to what is already in the buffer.

F3 Stats + histogram recomputed per view change: `useSceneSync.ts:834`
(`fieldHistogram`, `deviationStats`, 3 passes) then `setReadout` → second App
render.

F4 Split view and 2D viewer create a new WebGLRenderer per open
(`CompareView` → `CompareScene` → `OrthoViewport`, `orthoViewport.ts:207`;
`FlatViewer` mounts with its workspace, `App.tsx:1674`).

F5 Section view: first toggle compiles 6 programs (clipping changes program,
`SceneManager.ts:1514 applySlice`) and runs `closedShells` on the main thread
(`sliceCap.ts:61 closedPartOf`).

F6 Programs compile in the tap on first show: hidden nominal mesh, reference
map mesh, see-through variants. `setSurfaceOpacity` (`surfaceModes.ts:34`) sets
`needsUpdate` unconditionally.

F7 TopBar `useLayoutEffect(() => fit.current())` without deps
(`src/ui/TopBar.tsx:125`): up to 6 forced full-page layouts per App render.
Top hot function across taps; 132 ms on the Reverse tab.

F8 Animate off disposes the scan geometry (`SceneManager.ts:2860
releaseDeflect`) → 7.6 MB re-upload; animate on runs `deflectionVectors` /
`smoothInSpace` on the main thread.

F9 Render loop never idles (`orthoViewport.ts` `animate`), reading
`clientWidth/clientHeight` 4–5×/frame (`worldPerPixel`, `SceneManager` onTick)
→ forced layout after every DOM change; `spreadLabels` reads `offsetWidth` per
rendered frame.

F10 `App.tsx` is one component with ~60 store subscriptions plus
`useSceneSync`'s 85; nothing in `src/ui` is memoised; plugin hooks run each
render (`App.tsx:344`).

F11 Overlay rebuild disposes every material before the new ones render
(`overlays.ts:279`) → program released and recompiled; the deviation Map
toggle rebuilds overlays (`bareSurface`). Same in `sections.ts`, `volumeLayer.ts`.

F12 Element-mode deviation computed on the main thread
(`useElementField.ts:117 computeElementDeviation`, `suggestRange`).

F13 Recovery: view toggles schedule `inspect()` 300 ms later
(`useRecovery.ts:108`), which serialises the project.

F14 Renderer at DPR up to 2 with MSAA on phones (`orthoViewport.ts:209`).

F15 Main bundle 3.6 MB min / 1.16 MB gzip; plugins eager
(`src/plugins/registry.ts:14`), all panels eager.

F16 Whole-store subscriptions: `useThickness()` (`ThicknessPanel.tsx:32`),
`useMark()` (`MarkTools.tsx:90`), `useDeviation()` (`SplitPicker.tsx:272`);
`usePulse`/`useLadder` duplicated per instance (`src/app/useHints.ts:22`).

F17 CSS: `.pulse::after` animates `box-shadow` forever (`styles.css:446`),
`.busybar span` animates `width` (`styles.css:1828`).

F18 Whole-buffer uploads for partial changes: marking stroke
(`marking.ts:398`), volume hover (`volumeLayer.ts:65`).

F19 Main-thread BVH builds on load / nominal load / rigid transform
(`SceneManager.ts:924, 2263, 2317, 2329`) though the worker already builds one.

F20 Entering deviation does a wasted `repaintFromElements` pass
(`setHiddenRegions` runs before the field paint).

## Review corrections (independent review, code-checked)

- Measurement: the bare probe does **not** reproduce "takes a while" — prod
  tab taps are 64–128 ms; only Section view (~340) and the Reverse tab
  (~240) exceed 200 ms. The sample project had zero elements, dimensions,
  sections or probes, and only 288k triangles, so anything that scales with
  project content was not measured. n=1 per tap, profiler on during timing,
  and the "UI appears" column includes CDP overhead (~120–150 ms) — use
  INP/LoAF only. The Thickness map toggle was never measured (wrong selector).
- F1 confirmed (react-dom flushes passive effects for SyncLane commits), but
  effect work is a minority of the tab-tap handler; F7 is the largest part.
- F2, F3 overstated: real mechanism, small in the bare probe.
- F6 overstated: `needsUpdate` with an unchanged program state hits three's
  program cache; the cost is the *first* use of each variant only.
  `renderer.compile` never sets clipping state, so it cannot warm clipped
  variants; and the 6 Section-view links include the `SliceCap` materials
  created at toggle time.
- F9 overstated for tap latency (the layout read is layout paint needs anyway);
  real gain is idle battery. `plugins/reverse/viewer/reScene.ts` rides the
  viewport loop; `networkLayer.ts:1045` has its own rAF.
- F11 confirmed in mechanism, unmeasured (needs elements).
- F13 unsupported by the data (no late long task in any run).
- F17 overstated: `.busybar` is a width *transition*, not a loop.
- F19: `GenerateMeshBVHWorker` transfers (neuters) the live position/index
  buffers — unusable as is. `refit()` after a rigid move is valid and cheap.
- Missed: the overlay effect rebuilds every element overlay and runs
  `evaluateDimensions` on every workspace switch, then discards the result
  outside Measure (scales with project size); every tab/map tap re-uploads the
  0.6 MB colour buffer even when unchanged; DeviationPanel remounts per tab;
  first show of the reference after a tab switch was not exercised.
