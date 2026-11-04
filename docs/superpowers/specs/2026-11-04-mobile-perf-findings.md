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
