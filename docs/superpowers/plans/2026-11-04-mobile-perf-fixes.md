# Mobile UI Responsiveness Fixes — Implementation Plan (rev 2, after review)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every tab and toggle paints its UI in the first frame after the tap on a phone, and no toggle pays shader compiles, scan-sized uploads or new WebGL contexts it does not need.

**Architecture:** Fix the measurement first (a project with real content, profiler-off timing, medians), then ship the evidence-backed wins (TopBar fold, unchanged-map skips, section-view compile, keep-alive viewports, BVH refit). Work whose payoff the first baseline could not show (overlay rebuilds, deferral, workers, React restructuring) is gated: each such task starts by adding its probe row and proceeds only if the row shows the cost. Battery and startup items come last.

**Tech Stack:** React 19.2, zustand 5, three.js 0.180, three-mesh-bvh 0.8.3, Vite 6, Vitest 3, puppeteer-core e2e.

**Spec:** `docs/superpowers/specs/2026-11-04-mobile-perf-findings.md` (F1–F20, baseline, and the *Review corrections* section — read it; several findings were downgraded).

## Global Constraints

- Every source file keeps `// SPDX-License-Identifier: AGPL-3.0-only`; new files get it too.
- Match the codebase's comment style: full-sentence comments explaining *why*, in the existing voice.
- No new runtime dependencies.
- Colours on screen after the tap must equal colours before the change (byte-identical buffers), except for one transient frame where Task 9 says so.
- Documented trade-offs that a task reverses are listed under **Owner decisions** and are not implemented until the owner agrees.
- The commands/agent API awaits `nextFrame()` (`src/commands/core/common.ts:162`) to see the stage follow the stores; anything deferred must be flushed by it.
- Vitest: `npx vitest run <file> --maxWorkers=8`. Typecheck: `npx tsc --noEmit`. Never two heavy builds/e2e at once.
- e2e: `npx vite --port 5391 --strictPort` in the background, then `APP_URL=http://localhost:5391/ node scripts/<name>.mjs`. `e2e:<name>` in this plan means `scripts/e2e-<name>.mjs` (or `plugins/*/scripts/e2e-<name>.mjs` for `reverse`, `mesh`), alias or not.
- Before any PR: `npm run build` must pass; state its output.

## Owner decisions (ask before implementing)

1. **Keep split view and 2D viewer WebGL contexts alive after first use** (reverses `App.tsx:1671-1673`). Recommended: yes — measured 1 context + 6.8 MB + 1 program per split open. Task 6.
2. **Keep the `deflect` attribute while in the deviation workspace** (+12 B/vertex; reverses `SceneManager.ts:2855-2859`). Recommended: yes. Task 10.
3. **Cap pixel ratio on touch screens** (sharpness change; `(pointer: coarse)` also matches touch laptops). Recommended: not as a perf fix — offer it as a setting. Not in this plan.

## Review Focus

1. Hidden tab: rAF does not fire; deferred work must complete and `nextFrame()` must flush it *after* its own frame resolves (Task 9 test).
2. A field buffer recomputed in place (same `Float32Array`) must not be served from a cache — caches key on store versions (Tasks 2, 3 tests).
3. Rapid repeated taps (map off→on within one frame, tab A→B→A): end state = last tap, painted once (Task 9 test).
4. Scan replaced / crease changed while a worker job or kept-alive viewport is pending: stale result dropped, never shown on the new geometry (Tasks 6, 10, 11 tests).
5. Projects with many elements, dimensions and sections, and scans ≥ 1M triangles — every gated task measures on the rich scenario, not only on the bare sample (Task 0).

---

## Phase A — Measure properly

### Task 0: Probe v2

**Files:** Modify `scripts/perf-probe.mjs` (add to git in this task).

**Interfaces (produced):**
- `PERF_RUNS` (default 5): each measured tap is repeated (toggle taps alternate on/off) and the **median** INP and long-task max reported. Profiler **off** for these runs; one extra profiled run per tap supplies the hot list.
- Drop the "UI appears" column (its t0 includes CDP overhead).
- `budget: { links?, uploadMB?, contexts?, inpMs? }` per measure; `PERF_ASSERT=1` exits 1 with a `BUDGET FAIL: <label>: <what>` line per breach. `inpMs` budgets are set at baseline median − 30 % and only checked when `PERF_RUNS ≥ 5`.
- `PERF_SCENARIO=rich` (dev server only — imports `/src/commands/registry.ts` in `page.evaluate` and calls `runCommand`): after loading the sample, create 6 elements with `fit` (plane, cylinder, sphere ×2 at known vertices found via `runCommand('nearest', …)` / the `fit` input schema in `src/commands/core/element.ts:332`), 4 dimensions (`src/commands/core/dimension.ts`), 1 section (`src/commands/core/section.ts`), 5 deviation probes, then runs the same tap list. GL counters are identical in dev and prod, so GL budgets for this scenario are asserted on dev.
- `SCAN=<path>` overrides the sample (use a ≥ 1M-triangle scan when available; record its size in the output).
- Fix the Thickness map toggle row (`toggle-colormap` only exists in deviation — find the thickness view-bar key via `[data-test=part-keys]` and measure it), and add rows: thickness bands change, thickness histogram toggle, deviation range slider step, tolerance change, first show of the reference after switching tabs (load reference in Measure, then tap the Deviation tab).
- Prod hot lists need names: build the probe's prod target with `npx vite build --sourcemap` and map `callFrame` lines through the source map (`source-map-js` is already in `node_modules` via Vite; import it from there, no new dependency).

- [ ] **Step 1:** Implement; run bare + rich + prod. Save `e2e-out/perf-baseline-v2.txt`.
- [ ] **Step 2:** Record in the spec's baseline table the medians, and for the rich scenario the rows the gated tasks name (overlay rebuild on tab switch, `evaluateDimensions`, recovery long task after a toggle, element-map recompute, brush stroke upload).
- [ ] **Step 3: Commit** `perf: probe v2 — medians, rich project scenario, GL budgets`

---

## Phase B — Evidence-backed wins

### Task 1: TopBar fold only when its content changed (F7)

**Files:** Modify `src/ui/TopBar.tsx:111-130` (`useFit`).

**Interfaces:** `useFit(ref)` keeps running after every render but returns early when `signature(el) === last` where `signature(el) = el.textContent + '|' + el.childElementCount + '|' + el.className` (no layout read); the ResizeObserver and `document.fonts.ready` paths clear `last` and fit unconditionally.

- [ ] **Step 1:** `APP_URL=… node scripts/e2e-large-text.mjs` baseline → ALL PASS.
- [ ] **Step 2:** Implement.
- [ ] **Step 3:** `e2e-large-text` ALL PASS; probe: `Tab → workspace-reverse` median INP drops ≥ 80 ms vs Task 0 baseline; `fit.current` absent from the profiled hot lists of tab taps.
- [ ] **Step 4: Commit** `perf(topbar): fold fit only when the bar's content changed`

### Task 2: Skip unchanged map repaints and uploads (F2; review C2)

**Files:** Modify `src/app/useSceneSync.ts:789-827` (paint at `:807`), `src/viewer/SceneManager.ts:2774` (`setFieldColors`), `src/viewer/regionColors.ts` (`setFieldColors`). Test: `tests/regionColors.test.ts`, `tests/paintKey.test.ts` (new).

**Interfaces:**
- `shownField()` branches each return `version: number` (`mapVersion`, `elementVersion`, `referenceVersion`, `thickVersion`, `plugin.fieldVersion`).
- `paintKey(version: number, scale: FieldScale, colormapId: string): string` exported from `src/core/field/colormap.ts`.
- Effect keeps `painted = useRef(new WeakMap<Uint8Array, string>())`; when `painted.get(rgb) === key` it skips `paintField`.
- `RegionColors.setFieldColors(field)` returns `false` (nothing to upload) when `field === this.fieldColors && fieldPainted === true`, where `fieldPainted` is reset by any element/region/sparse change; `SceneManager.setFieldColors` uploads only on `true`. A repaint *into the same buffer* passes a new `repainted = true` flag: `setFieldColors(colors, repainted)`.
- **No LUT** (review: band edges would move; payoff small).

- [ ] **Step 1: Failing tests:** `paintKey` differs on version/scale/colormap changes only; `RegionColors.setFieldColors(sameField)` twice → second returns `false`; after `setHiddenRegions([1])` it returns `true`; `setFieldColors(sameField, true)` returns `true`.
- [ ] **Step 2:** FAIL → **Step 3:** implement → **Step 4:** PASS; `npm test`.
- [ ] **Step 5:** Probe: `Tab → Deviation (map in hand)`, `Tab → Thickness (map in hand)`, `map on`: `uploadMB: 0` budget green.
- [ ] **Step 6: Commit** `perf(map): skip repaint and upload when the map is unchanged`

### Task 3: Cached readout figures (F3)

**Files:** Create `src/core/field/readoutCache.ts`; modify `src/app/useSceneSync.ts:834-859` (histogram `:839`, `setReadout` `:841-843`). Test: `tests/readoutCache.test.ts`.

**Interfaces:**
- `cachedHistogram(values: Float32Array, version: number, low: number, high: number, validMin: number, validMax: number): FieldHistogram`
- `cachedDeviationStats(values: Float32Array, version: number, maxDistance: number, tolerance: number): DeviationStats`
- `cachedThicknessStats(values: Float32Array, version: number, limit: number | null): ThicknessStats`
- Memoised per `values` (WeakMap) on the other args. The effect calls `setReadout` only when either object differs from the store's.

- [ ] **Step 1: Failing tests:** same args → `toBe` same object; same array mutated in place + new version → recomputed, equal to a fresh `fieldHistogram`/`deviationStats`; range change leaves stats `toBe` previous.
- [ ] **Step 2–4:** FAIL → implement → PASS; `npm test`.
- [ ] **Step 5:** Probe: `source → reference`, `Tab → … (map in hand)` median INP not worse; range-slider row improves.
- [ ] **Step 6: Commit** `perf(readout): cache histogram and stats per map version`

### Task 4: Refit, don't rebuild, the BVH on rigid moves (F19, safe half)

**Files:** Modify `src/viewer/SceneManager.ts:2317-2329` (`applyTransform` and `this.other`), plus the same pattern at `:2598`, `:2719` if they are rigid. Test: `tests/bvhRefit.test.ts`.

**Interfaces:** after baking a rigid transform into positions: `geometry.boundsTree ? geometry.boundsTree.refit() : geometry.computeBoundsTree()`.

- [ ] **Step 1: Failing test** (node, three + three-mesh-bvh): build a BVH on a sphere mesh, apply a rotation+translation to positions, `refit()`; 1000 random rays give the same first hit (distance within 1e-6) as a freshly built tree. (Fails until the helper `refitAfterRigid(geometry)` exists in `src/viewer/bvh.ts`, new.)
- [ ] **Step 2–4:** FAIL → implement `refitAfterRigid(geometry: THREE.BufferGeometry): void` and use it → PASS.
- [ ] **Step 5:** `e2e:align`, `e2e:auto-align`, `e2e:align-after-deviation` PASS; probe: align-apply row long task max drops.
- [ ] **Step 6: Commit** `perf(bvh): refit after rigid moves instead of rebuilding`

### Task 5: Section view without compiles in the tap (F5)

**Files:** Modify `src/viewer/SceneManager.ts` (new `warmPrograms()`, `applySlice:1514`, cap creation `:1630-1640`), `src/viewer/sliceCap.ts:61` (`closedPartOf`), `src/core/workerProtocol.ts`/`meshWorker.ts`/`workerClient.ts` (closed shells). Test: `tests/closedShells.test.ts` (exists — extend).

**Interfaces:**
- `SceneManager.warmPrograms(): void` — scheduled with `requestIdleCallback` (fallback `setTimeout(…, 500)`) after scan load, nominal load and `setReferenceMap(non-null)`; cancelled by a token if the geometry changes. It builds a **throwaway** `THREE.Scene` holding: one 3-vertex mesh per material variant (clones of the scan / nominal / reference-map materials, `onBeforeCompile` copied by reference so the cache key matches) × clipping `[null, this.clipList]` × opacity `[1, SEE_THROUGH_OPACITY]`, plus one `SliceCap` built on the same tiny mesh. It then does a real `renderer.render(scene, camera)` with `setScissorTest(true)`, a 1×1 scissor and viewport, `renderer.localClippingEnabled` as in the live scene, then restores scissor/viewport and disposes **geometries only** (materials kept in `this.warmKeepers` so their programs stay referenced; released on scan dispose). Live materials are never mutated.
- Closed shells: `MeshWorkerClient.closedShells(which: 'scan' | 'nominal'): Promise<{ closed: Uint8Array; count: number }>`; `closedPartOf` gains `primeClosedPart(geometry, shells)` to fill its WeakMap cache from the worker result, requested right after load. `closedPartOf` keeps its synchronous fallback.

- [ ] **Step 1: Failing test:** worker-side `closedShells` on the shared fixtures equals the main-thread result (extend `tests/closedShells.test.ts`).
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5:** Probe (prod, ≥ 3 s idle after load): `section view` `links: 0`, median INP ≤ 120 ms; `map on reference` `links: 0`.
- [ ] **Step 6:** `e2e:section`, `e2e:section-view`, `e2e:crease`, `e2e:section-shadow` PASS.
- [ ] **Step 7: Commit** `perf(section): warm programs at idle, closed shells in the worker`

### Task 6: Keep split and 2D viewports alive (F4) — *Owner decision 1*

**Files:** `src/App.tsx:1656-1695`, `src/ui/CompareView.tsx`, `src/ui/FlatViewer.tsx`, `src/viewer/orthoViewport.ts` (`resize`), `src/viewer/CompareScene.ts:1-10` (fix the comment: buffers are per context, the geometry is uploaded again).

**Interfaces:**
- `CompareView` and `FlatViewer` gain `active: boolean`; App renders them once `splitEverOpened` (reset when `nominalGeometry` identity changes) / `flatEverOpened`, hidden via the `hidden` attribute when inactive.
- `active=false` → `viewport.paused = true`; `OrthoViewport.resize()` ignores 0×0 sizes (keeps the last size) so a hidden container does not reallocate.
- On `active` false→true: `compare.linkTo(scene.viewLink())` again and the flat sync re-runs what `flatSync.onReady` does (`src/app/useFlatSceneSync.ts` — expose `resync(viewer)` and call it).
- Context count with everything open: main + split + flat + point-picker halves (2) + reverse plugin layers — count in Step 1 and record; must be ≤ 6.

- [ ] **Step 1:** Probe: second `split on` and second `Tab → 2D Measure` fail `contexts: 0` (confirm); log the context total.
- [ ] **Step 2:** Implement; dispose kept viewports when the scan or reference geometry is replaced.
- [ ] **Step 3:** Probe green; `e2e:split`, `e2e:flat`, `e2e:spline`, `e2e:pick-slot`, `e2e:pick-fit` PASS.
- [ ] **Step 4: Commit** `perf(viewports): keep split and 2D views alive after first use`

---

## Phase C — Gated on the rich-scenario baseline

Each task's Step 1 is: *read its row in `e2e-out/perf-baseline-v2.txt`; if the cost is under 16 ms median and 0 links / < 1 MB, mark the task skipped in this file with the number, commit, and move on.*

### Task 7: Overlay work only where it is shown (review C1, F11)

**Files:** `src/app/useSceneSync.ts:315-436`, `src/viewer/overlays.ts:279`, `src/viewer/sections.ts:162, 440`, `src/viewer/volumeLayer.ts:36`.

**Interfaces:**
- `evaluateDimensions` and the pairs/angles/tags arrays are computed only when `elementsWorkspace` (they are discarded otherwise).
- The overlay effect's dependency `elementsWorkspace` stays, but the effect returns early (no `updateOverlays`) when the computed `items`, the visibility flag and the (empty) dimension arrays equal the last ones passed (`lastOverlayInput` ref compared by element identity + style + muted).
- Material reuse: `Overlays` keeps `shellMaterials` across rebuilds keyed by element id, updating `color`/`opacity` in place; dispose only materials whose element is gone. Same pattern in `sections.ts` (line materials keyed by section id) and `volumeLayer.ts`.

- [ ] **Step 1:** Gate (rich row: tab switch with elements; map toggle with elements → links).
- [ ] **Step 2:** Implement. **Step 3:** rich probe: tab switch median INP improves; map toggle `links: 0`. `e2e:element-deviation`, `e2e:gdt`, `e2e:section-dimension`, `e2e:edit` PASS.
- [ ] **Step 4: Commit** `perf(overlays): skip unchanged rebuilds, reuse materials`

### Task 8: Narrow subscriptions; one hints ladder (F16; review C3)

**Files:** `src/ui/ThicknessPanel.tsx:32`, `src/ui/MarkTools.tsx:90`, `src/ui/SplitPicker.tsx:272`, `src/app/useHints.ts:22`.

**Interfaces:** bare `useX()` → `useX(useShallow((s) => ({ …fields read… })))`. `useLadder()` computed once in a `HintsProvider` context mounted in `App`; `usePulse(id)` → `useContext(LadderContext).active === id`.

- [ ] **Step 1:** Gate (rich: Deviation tab mount cost in profiled hot list).
- [ ] **Step 2:** Implement; `npx tsc --noEmit`, `npm test`, `e2e:thickness`, `e2e:local-fit`, `e2e:support-ask` PASS.
- [ ] **Step 3: Commit** `perf(ui): narrow subscriptions, compute the hint ladder once`

### Task 9: Post-paint scheduling for remaining scene work (F1)

**Depends on:** Tasks 2, 3, 7 (deferral moves work; those tasks remove it). Do this only if, after them, a tap row still shows a scene effect > 16 ms in its handler.

**Files:** Create `src/app/afterPaint.ts`; modify `src/app/useSceneSync.ts`, `src/commands/core/common.ts:162`. Test: `tests/afterPaint.test.ts`.

**Interfaces:**
- `afterPaint(key: string, job: () => void): void` — replaces a pending job with the same key; runs via `requestAnimationFrame(() => setTimeout(run, 0))`, or `setTimeout(run, 0)` when hidden / no rAF.
- `flushAfterPaint(): void`; `pendingAfterPaint(): number`.
- `nextFrame()` flushes **after** its rAF resolves (visible) or after `nextTask()` and before `pumpFrame()` (hidden) — so jobs scheduled by the effects of the commit that `nextFrame` is waiting on are included.
- Only effects that still measure > 16 ms are wrapped; each job reads its inputs at run time.

- [ ] **Step 1: Failing tests:** coalescing; hidden-document path; `nextFrame` resolves only after a job scheduled in a microtask after the call has run (simulate: call `nextFrame`, then `queueMicrotask(() => afterPaint('x', spy))`, await → `spy` called).
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5:** e2e one at a time: `e2e:deviation`, `e2e:element-deviation`, `e2e:thickness`, `e2e:split`, `e2e:agent`, `e2e:history` PASS. (Allowed visual change: the scan shows its previous colours for one frame after a tab tap.)
- [ ] **Step 6: Commit** `perf(scene): run remaining scene sync after the tap has painted`

### Task 10: Animation without re-upload; motion in the worker (F8) — *Owner decision 2*

**Files:** `src/viewer/SceneManager.ts:2847-2866`, `src/core/workerProtocol.ts`, `meshWorker.ts`, `workerClient.ts`, `src/app/useSceneSync.ts:994-1025`. Test: `tests/deflection.test.ts`.

**Interfaces:**
- `dropDeflection()` keeps the attribute and sets `uDeflect = 0`; `releaseDeflect` runs on scan replacement and from `setDeflectionHeld(false)`, called when the workspace leaves deviation.
- `MeshWorkerClient.deflection(values: Float32Array, directions: Int8Array, opts: { limit: number; maxDistance: number; smoothing: number }): Promise<Float32Array>` with a `scanToken`; stale replies reject `StaleScan` and are ignored.
- **Parity precondition (Step 1):** worker `graph.positions` for vertices `0..scanVertexCount-1` must equal `scene.scanPositions()` after load, crease and a datum transform (`meshWorker.ts:482-499`). If not equal, the request sends `positions` (copy) instead.

- [ ] **Step 1: Failing tests:** parity check on the ball-bar fixture (load → transform → compare); worker `deflectionVectors` equals main-thread call bitwise; stale token rejected.
- [ ] **Step 2–4:** FAIL → implement → PASS. **Step 5:** probe `animate off` `uploadMB ≤ 1`; `e2e:deviation` PASS.
- [ ] **Step 6: Commit** `perf(animate): keep the deflect buffer, compute motion in the worker`

### Task 11: Element-mode map in the worker (F12)

**Files:** `src/core/workerProtocol.ts`, `meshWorker.ts`, `workerClient.ts`, `src/app/useElementField.ts:98-137`, `src/state/deviationStore.ts`. Test: `tests/elementFieldWorker.test.ts`.

**Interfaces:**
- `MeshWorkerClient.elementDeviation(target: ElementTarget, opts: { side: MaterialSide; maxNormalDeviation: number | null; subset: Uint32Array | null }): Promise<{ values: Float32Array; directions: Int8Array; suggestedRange: number }>`.
- **Normals parity:** render normals are crease-split, graph normals may not be; Step 1 compares. If they differ, send `normals` (copy of `scanArrays().normals`) with the request.
- The effect captures `restoring` and the input tuple at dispatch; sets `elementStatus = 'running'`; on reply, drops it if `previousInputs.current` changed, else `resolveElementMap(suggestedRange, restoring)`.
- Facing slider: requests coalesce (latest wins; an in-flight request's reply is dropped when a newer one exists).

- [ ] **Step 1:** Gate (rich row: target select / facing change) + failing parity tests.
- [ ] **Step 2–4:** implement → PASS. **Step 5:** `e2e:element-deviation`, `e2e:history` PASS.
- [ ] **Step 6: Commit** `perf(element-map): measure against an element in the worker`

### Task 12: Scene sync in a leaf component (F10, first half only)

**Files:** Create `src/app/SceneSync.tsx`; modify `src/App.tsx` (call site of `useSceneSync` `~1256` and `useElementField`).

**Interfaces:** `export const SceneSync = memo(function SceneSync(props: SceneSyncProps): null)` where `SceneSyncProps` = `Parameters<typeof useSceneSync>[0]` & the `useElementField` inputs; App passes only stable refs; `cancelDraft` and `plugin` via a ref holder (`pluginRef`, `cancelDraftRef`) so props never change identity.

Not in this plan (review: blast radius): memo-wrapping all panels, `PluginHost`, `DeviationLegend` split. Re-measure after this task and open a follow-up only if App renders still dominate.

- [ ] **Step 1:** Gate (dev React Profiler: App commit duration on map toggle; add `<Profiler>` in dev only).
- [ ] **Step 2:** Implement; `npx tsc --noEmit`, `npm test`, `e2e:deviation`, `e2e:element-deviation`, `e2e:reverse`, `e2e:mesh`, `e2e:agent` PASS.
- [ ] **Step 3: Commit** `perf(app): scene sync in a leaf component`

### Task 13: Recovery inspection at idle (F13)

**Files:** `src/app/useRecovery.ts:108-137`.

**Interfaces:** `scheduleInspect` → `requestIdleCallback(run, { timeout: 1000 })` (fallback `setTimeout(run, 300)`). View-only keys (`workspace`, `showMap`, `showHistogram`, `split`, `showScan`, `showNominal`) move to a watcher that sets `pending = true` only.

- [ ] **Step 1:** Gate (rich row: long task after map toggle). `e2e:recovery` baseline PASS, note its timing assumptions.
- [ ] **Step 2:** Implement; `e2e:recovery`, `e2e:project` PASS.
- [ ] **Step 3: Commit** `perf(recovery): inspect at idle, not after every view toggle`

---

## Phase D — Battery and startup (after B and C)

### Task 14: Idle render loops (F9)

**Files:** `src/viewer/orthoViewport.ts` (loop `~300-352`, `resize`, `worldPerPixel:408`), `src/viewer/SceneManager.ts` onTick `~462-480`, `src/viewer/labelSpread.ts`, `plugins/reverse/viewer/networkLayer.ts:1045`.

**Interfaces:**
- `OrthoViewport.size: { w; h }` set in `resize()`; `worldPerPixel()`, `frame()` and SceneManager's onTick read it.
- `OrthoViewport.wake()`; loop sleeps after 30 idle frames when `!needsRender && !flight && !spaceMouseAttached() && !opts.keepAwake?.()`.
- Wake sources (all must call `wake()`): `invalidate()`; canvas `pointerdown/pointermove/pointerup/wheel/touchstart/touchmove`; window `keydown/keyup`; `ResizeObserver`; `visibilitychange` → visible; `animateLook`; SpaceMouse connect; `CameraLink` (a leader's change wakes followers); prefs/theme changes (`setViewTheme`, `setNavScheme`). `keepAwake`: deflection playing, marking stroke pending, `clipDirty`, a pending region repaint.
- `spreadLabels` caches `offsetWidth/offsetHeight` per label in a `WeakMap<HTMLElement, { w; h; text }>` and re-reads only when `textContent` changed.

- [ ] **Step 1:** Probe idle row: rAF callbacks into app code per 3 s (count via a wrapped `requestAnimationFrame` in the probe) — target 0 after 1 s idle.
- [ ] **Step 2:** Implement. **Step 3:** e2e one at a time: `e2e:nav`, `e2e:spacemouse`, `e2e:touch`, `e2e:deviation`, `e2e:split`, `e2e:extend`, `e2e:paint`, `e2e:reverse` PASS.
- [ ] **Step 4: Commit** `perf(viewport): sleep when idle, no per-frame layout reads`

### Task 15: BVH build off the main thread on load (F19, second half)

**Files:** `src/core/meshWorker.ts`, `workerProtocol.ts`, `workerClient.ts`, `src/viewer/SceneManager.ts:924, 2263`.

**Interfaces:** not `GenerateMeshBVHWorker` (it transfers and neuters the live position/index buffers). The mesh worker builds `new MeshBVH(geometry, { indirect: true })` over the **same index the main geometry uses** (including crease copies — the load reply already carries `indices`), returns `MeshBVH.serialize(bvh, { cloneBuffers: false })` transferred; main does `geometry.boundsTree = MeshBVH.deserialize(data, geometry, { setIndex: false })`. Until it arrives, picks fall back to three's raycast; every direct `boundsTree` consumer (grep `boundsTree` under `src/`) checks presence.

- [ ] **Step 1: Failing test:** serialize in a worker-equivalent context, deserialize on a geometry with identical attributes → same raycast hits as `computeBoundsTree()` (ball-bar fixture).
- [ ] **Step 2–4:** implement → PASS. **Step 5:** `e2e:smoke`, `e2e:import`, `e2e:align`, `e2e:crease` PASS; probe open-scan long-task max ≤ 150 ms.
- [ ] **Step 6: Commit** `perf(bvh): build the scan's tree in the worker`

### Task 16: Partial uploads (F18) — gated

**Files:** `src/viewer/marking.ts:398`, `src/viewer/volumeLayer.ts:65-86`.

**Interfaces:** marking keeps a dirty-page bitmap (page = 4096 **elements** of the paint attribute's array); on drain, for each dirty run of pages `attr.addUpdateRange(pageStart * 4096, runLength * 4096)` (units: array elements, per three r180 `BufferAttribute.addUpdateRange(start, count)`), `needsUpdate = true`; three clears ranges after upload.

- [ ] **Step 1:** Gate (rich row: brush stroke upload MB per move).
- [ ] **Step 2:** Implement; `e2e:local-fit`, `e2e:paint` PASS.
- [ ] **Step 3: Commit** `perf(marking): upload only the touched pages`

### Task 17: CSS pulse on the compositor (F17) — low priority

**Files:** `src/styles.css:446-470` (`.pulse::after`, `@keyframes pulsering`).

**Interfaces:** the ring is a pseudo-element with a static border/box-shadow; the keyframes animate only `transform: scale()` and `opacity`. `.busybar` unchanged (it is a transition, not a loop).

- [ ] **Step 1:** Screenshots before/after (`e2e:sample` shots), compare by eye. **Step 2: Commit** `perf(css): pulse ring animates transform and opacity`

### Deferred (not in this plan)

- Lazy panels / plugin runtimes (F15): startup only, conflicts with plugin hooks the agent API and hints rely on. Revisit with a plugin-API design.
- Full App memoisation / `PluginHost` / `DeviationLegend` split: after Task 12's re-measure.
- Region lazy repaint + owner LUT (F20): ~5 ms.
- Mobile DPR cap: Owner decision 3.

## Task 18: Final verification

- [ ] `npm run build` → success (record output)
- [ ] `npm test -- --maxWorkers=8` → all pass
- [ ] `npm run e2e:ci` → ALL PASS
- [ ] `PERF_ASSERT=1 PERF_RUNS=5` probe: bare (prod) and rich (dev) → exit 0; before/after medians table in the PR body
- [ ] Owner real-device check: Chrome remote debugging on Android (or Safari Web Inspector on iPhone), Performance panel, tap Surface Deviation / Map / Split / Section — no task > 100 ms
