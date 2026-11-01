// SPDX-License-Identifier: AGPL-3.0-only
// The Reverse engineer workspace outside React: the CAD kernel, brought up
// when the workspace is first entered or a command asks for it; the build
// that follows every change to the feature list; the bodies' meshes and
// their faces and edges as the last build left them; the STEP export, and
// the scan handed to the kernel for the live map; and the stop of a build
// that does not finish — the kernel let go and started again, the part
// built without the step it was at. The workspace's hook (useReverse)
// draws from it and the commands (reCommands.ts) work through it, so a
// button and a command run the same code — as the app's own session
// (src/app/session.ts) stands under the app's panels. Under a test it
// stands without a viewport, its kernel in the test's own thread.

import { fmtLen, fmtVol, type DisplayUnits } from '../../../src/core/units'
import type { Vec3 } from '../../../src/core/types'
import type { RefObject } from 'react'
import { exportStem } from '../../../src/app/exports'
import { commandHost } from '../../../src/commands/host'
import { useStore } from '../../../src/state/store'
import type { SceneManager } from '../../../src/viewer/SceneManager'
import type { BodyCheck, BuiltBody, FaceInfo, Overlap } from '../core/build'
import { meshBox } from '../core/buildTypes'
import type { EdgeJoin } from '../core/edgeLines'
import { deleteFaceGroup, edgeJoins } from '../core/faceGroup'
import { buildMeshFile, type MeshFile, type MeshFormat } from '../../../src/core/exportMesh'
import type { CompareDetail, PatchRequest } from '../core/compareDetail'
import { type BuildStep, type Feature, type ResolveContext, type SketchFeature, type SurfaceFeature } from '../core/features'
import { resolveFeatures } from '../core/resolve'
import type { KernelMesh, StepCheck, StepMend } from '../core/kernel'
import type { ScanSide, SparseField } from '../core/liveMap'
import { type BuildInPlay, ReClient } from '../core/reClient'
import { findRegions, type Region } from '../core/regions'
import type { Sketch } from '../core/sketch'
import { withStepsSaid } from '../core/stepWords'
import { kernelUnavailableReason } from '../core/wasmSupport'
import { bodyColor, featuresToBuild, useReverse } from '../state/reStore'
import { regionOf } from './reSurfaceRegion'

const message = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** How long builds stay held back (session.hold) after the last change
 *  that held them, at most. */
const HOLD_MS = 30_000

/** How long the kernel spends on the bodies' overlaps at a go, ms, before
 *  what else is waiting for it gets a turn — see Builder.overlaps. */
const OVERLAP_SLICE_MS = 100

/** How long a step of a build may be in play — or the kernel go unheard
 *  with no step in play — before a wait for the build (settled) stops it,
 *  ms. A wasm call cannot be interrupted: the stop lets the kernel go. */
export const BUILD_LIMIT_MS = 300_000

/** How long a step has been in play before what the session is busy with
 *  says how to stop it, ms. */
const STOP_SAID_MS = 30_000

/** What a stop of a build did — see the session's stop. */
export interface Stopped {
  /** The feature whose step was in play, suppressed: null when no step was,
   *  or when the build was of the list before a change since. */
  feature: { id: number; name: string } | null
  /** Its place in the list, 1 the first. */
  step?: number
  /** The kernel call it was in ("Splitting"), when one was heard. */
  call: string | null
  /** How long the step had been in play, ms — with none, how long the
   *  build had run. */
  ms: number
  /** The sentence that says it all. */
  message: string
}

/** The diagonal of a mesh's bounding box — what a pick's fingerprint is
 *  matched within (topo.ts matchTolerance). */
export function meshDiagonal(mesh: KernelMesh): number {
  const box = meshBox(mesh)
  return box ? Math.hypot(box.max[0] - box.min[0], box.max[1] - box.min[1], box.max[2] - box.min[2]) : 1
}

/** The STEP files the Imports among the steps name, by key — what the
 *  worker is handed with a build or a preview, each the first time. */
export function stepFilesFor(steps: readonly { kind: string; file?: unknown }[]): Map<string, string> {
  const stored = useReverse.getState().stepFiles
  const out = new Map<string, string>()
  // Own keys only: a key a project file gives may be `constructor` or the
  // like, which a plain object answers from its prototype.
  for (const s of steps) if (s.kind === 'import' && typeof s.file === 'string' && Object.hasOwn(stored, s.file)) out.set(s.file, stored[s.file])
  return out
}

/** The regions of the committed sketches, found once per sketch and kept
 *  by the sketch object itself — a commit replaces the object. */
class RegionCache {
  private byId = new Map<number, { sketch: Sketch; regions: Region[] }>()
  of(f: SketchFeature): Region[] {
    const hit = this.byId.get(f.id)
    if (hit && hit.sketch === f.sketch) return hit.regions
    const regions = findRegions(f.sketch)
    this.byId.set(f.id, { sketch: f.sketch, regions })
    return regions
  }
  clear(): void {
    this.byId.clear()
  }
}

/** Where the build stands: nothing to build, waiting on the kernel, under
 *  way, or landed for the feature list as it is now. */
export type BuildState = 'none' | 'waiting' | 'building' | 'built'

export type ReverseSession = ReturnType<typeof createReverseSession>

export function createReverseSession({
  sceneRef,
  kernel = () => new ReClient(),
  limitMs = BUILD_LIMIT_MS,
}: {
  sceneRef: RefObject<SceneManager | null>
  /** The kernel's client: the worker by default; under Node, one over the
   *  kernel in this thread (core/reLocal). */
  kernel?: () => ReClient
  /** How long a step may be in play before a wait for the build stops it,
   *  ms: BUILD_LIMIT_MS unless given. */
  limitMs?: number
}) {
  let client: ReClient | null = null
  let starting: Promise<void> | null = null
  /** Each body's mesh, and its faces and edges with their fingerprints —
   *  what a pick on the part resolves to, and what a feature stores. */
  const meshes = new Map<number, KernelMesh>()
  const topologies = new Map<number, BuiltBody['topology']>()
  const regions = new RegionCache()
  /** What the extracted bodies were last built from — see extractSources. */
  let extractedFrom = ''
  /** A build asked for and not yet started: several changes to the list in
   *  one go are one build. */
  let scheduled = false
  /** Builds the kernel has been asked for and has not answered. */
  let running = 0
  /** Of those, the ones asked of the kernel's client — what a stop lets go
   *  with it; the rest are the surfaces' regions read again. */
  let kernelBuilds = 0
  /** What each stop of a build said, in order — what a wait the stop fell
   *  in answers (settled). */
  const stopsSaid: string[] = []
  /** The stop under way, while one is. */
  let stopping: Promise<Stopped | null> | null = null
  /** The store's build version the last build that landed was made for. */
  let landed: number | null = null
  /** Builds held back while changes are made one after another, to build
   *  once after the last of them (see hold); the timer lets them go should
   *  nothing else — a caller gone before its last change. */
  let holding: ReturnType<typeof setTimeout> | null = null
  /** A build asked for while they were held. */
  let heldBack = false

  const resolveContext = (): ResolveContext => {
    const store = useStore.getState()
    return { sections: store.sections, elements: store.elements, modelCenter: store.modelCenter }
  }
  const regionsOf = (f: SketchFeature) => regions.of(f)

  /** What the extracted bodies are built from: their elements' fits,
   *  extensions and assumed diameters, a shadow's cut and whether it is in
   *  — so one refitted, extended, given a design size or taken again in
   *  Measure since is seen. */
  const extractSources = (): string => {
    const { elements, sections } = useStore.getState()
    return useReverse
      .getState()
      .features.filter((f) => f.kind === 'extract')
      .map((f) => {
        if (f.section !== undefined) {
          const sec = sections.find((x) => x.id === f.section)
          return JSON.stringify(['section', f.section, sec?.kind, sec?.cutKey, sec?.cut?.shadow !== undefined])
        }
        const e = elements.find((el) => el.id === f.element)
        return JSON.stringify([f.element, e?.fit, e?.extend, e?.assumed])
      })
      .join('|')
  }

  /** Bring the kernel up, once — what entering the workspace does. Resolves
   *  once it can build; rejects, saying why, when it cannot run here. */
  const startKernel = (): Promise<void> => {
    const re = useReverse.getState()
    if (re.kernelStatus === 'ready' && client) return Promise.resolve()
    if (re.kernelStatus === 'unavailable') return Promise.reject(new Error(re.kernelMessage ?? 'The CAD kernel is not available.'))
    if (starting) return starting
    const reason = kernelUnavailableReason()
    if (reason) {
      re.setKernel('unavailable', reason)
      return Promise.reject(new Error(reason))
    }
    return bringUp(client)
  }

  /** A kernel brought up in place of `before`, which is let go — taking
   *  over the steps it crashed on, which a fresh worker has not met. A
   *  kernel let go meanwhile in turn says nothing more. */
  const bringUp = (before: ReClient | null): Promise<void> => {
    useReverse.getState().setKernel('loading')
    before?.dispose()
    const next = kernel()
    for (const [key, why] of before?.crashed ?? []) next.crashed.set(key, why)
    next.onFailure = (why) => {
      if (client !== next) return
      useReverse.getState().failBuild(why)
      useReverse.getState().setKernel('unavailable', why)
    }
    client = next
    const up: Promise<void> = next
      .init()
      .then((version) => {
        if (client === next) useReverse.getState().setKernel('ready', null, version)
      })
      .catch((e) => {
        if (client !== next) return
        const why = `The CAD kernel could not be loaded: ${message(e)}`
        useReverse.getState().setKernel('unavailable', why)
        throw new Error(why)
      })
      .finally(() => {
        if (starting === up) starting = null
      })
    starting = up
    return up
  }

  /** Build the features as they stand — while one is reopened for editing,
   *  the part as it stood before it, rolled back to the feature as a CAD
   *  tree is. Only the latest build lands; one overtaken answers nothing. */
  const build = () => {
    const re = useReverse.getState()
    if (!client || re.kernelStatus !== 'ready') return
    const version = re.buildVersion
    if (re.features.length === 0) {
      meshes.clear()
      topologies.clear()
      re.finishBuild([], [])
      landed = version
      return
    }
    const built = featuresToBuild(re)
    // A surface whose box moved with the parameters: its points read again
    // in the box first, off the scan — the build follows, once they are in.
    const stale = built.filter((f): f is SurfaceFeature => f.kind === 'surface' && f.regionStale === true && f.regionBox !== undefined)
    if (stale.length > 0) {
      readRegionsAgain(stale)
      return
    }
    const steps = resolveFeatures(built, resolveContext(), regionsOf)
    extractedFrom = extractSources()
    // Sketches alone: nothing for the kernel to do, and nothing to wait on it
    // for. A first sketch once stood five minutes behind a kernel that did
    // not answer, and was then told it had failed.
    if (steps.length === 0) {
      meshes.clear()
      topologies.clear()
      // A build all the same, of no step: what a change answers says so.
      client.steps.builds++
      re.finishBuild([], [])
      landed = version
      return
    }
    const sketches = new Map(built.filter((f): f is SketchFeature => f.kind === 'sketch').map((f) => [f.id, f.sketch]))
    re.beginBuild()
    running++
    kernelBuilds++
    // A build of a kernel a stop let go answers nothing: the stop took it
    // off the count.
    const c = client
    c.build(steps, sketches, stepFilesFor(steps))
      .then((answer) => {
        if (c !== client) return
        // Not running any more before the store says what landed, so that
        // what waits on the store finds the session idle when it looks.
        running--
        kernelBuilds--
        if (!answer) return
        // A body the build left as it was comes back the very object it
        // was, so what the viewport made of its mesh stays.
        meshes.clear()
        topologies.clear()
        for (const b of answer.bodies) {
          meshes.set(b.id, b.mesh)
          topologies.set(b.id, b.topology)
        }
        landed = version
        useReverse.getState().finishBuild(
          withStepsSaid(answer.results, built),
          answer.bodies.map((b) => ({
            id: b.id,
            name: b.name,
            visible: true,
            volume: b.volume,
            faces: b.faces,
            closed: b.closed,
            triangles: b.triangles,
            surface: b.surface,
            ...(b.box ? { box: b.box } : {}),
            ...(b.label ? { label: b.label } : {}),
          })),
        )
      })
      .catch((e) => {
        if (c !== client) return
        running--
        kernelBuilds--
        landed = version
        useReverse.getState().failBuild(message(e))
      })
  }

  /** The surfaces' regions read again in their boxes, written into the
   *  list — not a step of its own: the change that moved the box is — and
   *  the build asked for again. One that cannot be read keeps its points
   *  and says why, and the build fails it. Counted as running, so what
   *  waits for the build waits for this too. */
  const readRegionsAgain = (stale: readonly SurfaceFeature[]) => {
    running++
    void Promise.all(
      stale.map(async (f) => {
        const box = JSON.stringify(f.regionBox)
        try {
          return { id: f.id, box, region: Uint32Array.from(await regionOf(f.regionBox!)) }
        } catch (e) {
          return { id: f.id, box, why: message(e) }
        }
      }),
    ).then((read) => {
      useReverse.setState((s) => {
        const patch = (f: Feature): Feature => {
          const r = f.kind === 'surface' ? read.find((x) => x.id === f.id && JSON.stringify(f.regionBox) === x.box) : undefined
          if (!r || f.kind !== 'surface') return f
          if ('why' in r) return { ...f, regionStale: r.why ?? 'the region could not be read' }
          const { regionStale: _stale, ...rest } = f
          void _stale
          return { ...rest, region: r.region! }
        }
        return { features: s.features.map(patch), rolledBack: s.rolledBack.map(patch), buildVersion: s.buildVersion + 1 }
      })
      running--
    })
  }

  const schedule = () => {
    if (holding) {
      heldBack = true
      return
    }
    if (scheduled) return
    scheduled = true
    queueMicrotask(() => {
      scheduled = false
      if (holding) heldBack = true
      else build()
    })
  }

  /** Hold builds back — the changes about to be made build once, when
   *  release is called, or settled; HOLD_MS after the last hold at the
   *  latest. */
  const hold = () => {
    if (holding) clearTimeout(holding)
    holding = setTimeout(release, HOLD_MS)
  }

  /** Let held builds go: the one asked for meanwhile starts. */
  const release = () => {
    if (!holding) return
    clearTimeout(holding)
    holding = null
    if (heldBack) {
      heldBack = false
      schedule()
    }
  }

  /** Keep the bodies built: a build after every change to the list, and
   *  once the kernel is up. The returned function stops it. */
  const watch = (): (() => void) => {
    const stop = useReverse.subscribe((s, prev) => {
      if (s.buildVersion === prev.buildVersion && s.kernelStatus === prev.kernelStatus) return
      if (holding) {
        heldBack = true
        return
      }
      // Marked at once, the build itself a moment later: what reads
      // `building` after the change — a box reopened on a feature, which
      // finds its picks on the part only once the part before it is built —
      // sees it, as it saw the effect this replaces.
      if (client && s.kernelStatus === 'ready' && !s.building) s.beginBuild()
      schedule()
    })
    schedule()
    return stop
  }

  const buildState = (): BuildState => {
    const re = useReverse.getState()
    if (scheduled || running > 0) return 'building'
    if (re.kernelStatus === 'ready' && landed === re.buildVersion) return 'built'
    return re.features.length === 0 && landed === null ? 'none' : 'waiting'
  }

  /** A step in play said: its feature's name, its place in the list and
   *  the kernel call it is in — "Flange plate (step 12, Splitting)". */
  const stepSaid = (step: BuildStep, call: string | null): string => {
    const features = useReverse.getState().features
    const at = features.findIndex((f) => f.id === step.id)
    const name = 'name' in step && typeof step.name === 'string' && step.name ? step.name : at >= 0 ? features[at].name : `Feature ${step.id}`
    const where = [...(at >= 0 ? [`step ${at + 1}`] : []), ...(call ? [call] : [])]
    return where.length > 0 ? `${name} (${where.join(', ')})` : name
  }

  /** What the build is at, as busy says it — the step in play, or with
   *  none the kernel call, and for how long; past STOP_SAID_MS, how to stop
   *  it. Empty when the kernel has told nothing of it. */
  const atSaid = (p: BuildInPlay | null): string => {
    const what = p?.step ? stepSaid(p.step, p.call) : (p?.call ?? null)
    if (!p || !what) return ''
    const stop = p.ms >= STOP_SAID_MS ? '; reverse.build.stop stops it and builds the part without it' : ''
    return `: ${what}, ${Math.round(p.ms / 1000)} s so far${stop}`
  }

  /** What the kernel is busy with that nothing may run over, or null. */
  const busy = (): string | null => {
    const re = useReverse.getState()
    if (re.kernelStatus === 'loading') return 'the CAD kernel is loading'
    if (scheduled || running > 0) return `the CAD kernel is building the bodies${atSaid(client?.playing() ?? null)}`
    return null
  }

  /** Stop the build the kernel is at: a wasm call cannot be interrupted, so
   *  the kernel is let go — its worker terminated, the helper kernels with
   *  it — and a new one started and handed the scan; the feature whose step
   *  was in play suppressed (the save keeps it out), and the part built
   *  again without it, once the scan is in. `why`: asked for (the stop
   *  command), at a wait's limit (settled), or before a change that throws
   *  the session's work away — which suppresses nothing, and holds the
   *  build till `done`. At the limit with no step in play the part is
   *  left unbuilt, its build failed saying so: built again unchanged it
   *  would hang the same way, and stop again at the next limit, for good.
   *  Null when no build is under way. Resolves once the new kernel is up,
   *  not when the part has built. */
  const stop = (why: 'asked' | 'limit' | 'discard', done?: Promise<unknown>): Promise<Stopped | null> => {
    if (stopping) return stopping
    const c = client
    const p = c?.playing() ?? null
    if (!c || !p) return Promise.resolve(null)
    const ran = async (): Promise<Stopped> => {
      const re = useReverse.getState()
      const step = p.step
      const at = step ? re.features.findIndex((f) => f.id === step.id) : -1
      const named = step && 'name' in step && typeof step.name === 'string' ? step.name : null
      // The feature in play as the list stands — none for a build of the
      // list before a change since, where the id may name another.
      const feature = at >= 0 && (named === null || re.features[at].name === named) ? re.features[at] : null
      const said = step ? stepSaid(step, p.call) : null
      const version = re.buildVersion
      // Let go: what it answers from now on is nobody's, and the builds
      // asked of it are off the count.
      client = null
      c.onFailure = null
      running -= kernelBuilds
      kernelBuilds = 0
      scanSent = null
      scanSending = null
      // The new kernel builds once it has the scan — held till then, and
      // for a change that throws the work away, till that is done.
      const held = holding !== null
      hold()
      const suppressed = why !== 'discard' && feature !== null ? feature : null
      if (suppressed) re.setSuppressed([suppressed.id], true)
      // The work is thrown away: nothing is building now.
      if (why === 'discard') useReverse.setState({ building: false })
      const s = Math.round(p.ms / 1000)
      const late = why === 'limit' ? `did not finish in ${s} s` : `was stopped after ${s} s`
      const lower = (t: string) => t.charAt(0).toLowerCase() + t.slice(1)
      const where = `${p.played ? 'after its last step' : 'before its first step'}${p.call ? ` (the kernel was ${lower(p.call)})` : ''}`
      // Stopped at the limit with nothing to leave out: not built again.
      const unbuilt = why === 'limit' && said === null
      const message =
        why === 'discard'
          ? `${said ?? 'The build'} ${late}, for the work it was building is being replaced; the CAD kernel was started again.`
          : unbuilt
            ? `The build ${late}, ${where}. No step was in play to suppress, so the CAD kernel was started again and the part left unbuilt, rather than built into the same hang. Undo the last change (history.undo), or change, suppress or remove the feature it made: any change builds the part again.`
            : said === null
              ? `The build ${late}, ${where}: no step was in play, so nothing was suppressed. The CAD kernel was started again and the part is building again; should it hang there again, a wait stops it at its limit and leaves the part unbuilt.`
              : feature === null
                ? `${said} ${late}: it was a build of the feature list before a change since. The CAD kernel was started again and the part built as the list stands — nothing was suppressed.`
                : `${said} ${late}: the CAD kernel was stopped and started again, and the part built without it — ${feature.name} is suppressed. Change it before you build it again (reverse.feature.update { feature: ${JSON.stringify(feature.name)}, set: { suppressed: false } }).`
      try {
        await bringUp(c)
        await syncScan().catch(() => 'none')
      } finally {
        // Left unbuilt: the build of the list as it stood failed, saying
        // why — unless a change came in meanwhile, which builds.
        if (unbuilt && useReverse.getState().buildVersion === version) {
          heldBack = false
          landed = version
          useReverse.getState().failBuild(message)
        }
        if (!held) {
          if (why === 'discard' && done) void done.finally(release)
          else release()
        }
      }
      if (why !== 'discard') stopsSaid.push(message)
      return { feature: suppressed ? { id: suppressed.id, name: suppressed.name } : null, ...(at >= 0 ? { step: at + 1 } : {}), call: p.call, ms: p.ms, message }
    }
    // Under way before any of it runs: a wait that looks at what it changes
    // sees it so.
    const under: Promise<Stopped> = Promise.resolve()
      .then(ran)
      .finally(() => {
        if (stopping === under) stopping = null
      })
    stopping = under
    return under
  }

  /** Until the features as they stand are built: the kernel up, no build
   *  waiting or running, and the last one landed for the list as it is now
   *  — builds held back let go first. Past `timeoutMs` (the session's
   *  limit unless given), a step in play as long — or a kernel as long
   *  unheard with no step in play — is stopped (stop), and the part built
   *  without it waited for, or left unbuilt where no step was in play:
   *  then, as when a stop asked for falls in the wait, it rejects with
   *  what the stop said. A build that goes on from
   *  step to step is waited for. Rejects, saying why, when the kernel
   *  cannot run, or nothing it does lands in time. */
  const settled = (timeoutMs = limitMs): Promise<void> =>
    new Promise((resolve, reject) => {
      release()
      let started = Date.now()
      const stopsBefore = stopsSaid.length
      let stopsSeen = stopsBefore
      let timer: ReturnType<typeof setTimeout> | undefined
      let done = false
      // Looked at again whenever the store changes — a build landing — which
      // a hidden tab's browser does not hold back as it does the timer; the
      // timer stays for the rest.
      const unwatch = useReverse.subscribe(() => check())
      const finish = (then: () => void) => {
        done = true
        clearTimeout(timer)
        unwatch()
        then()
      }
      const check = () => {
        if (done) return
        const re = useReverse.getState()
        if (re.kernelStatus === 'unavailable') {
          finish(() => reject(new Error(re.kernelMessage ?? 'The CAD kernel is not available.')))
          return
        }
        if (re.kernelStatus === 'ready' && !scheduled && running === 0 && landed === re.buildVersion && !stopping) {
          const said = stopsSaid.slice(stopsBefore)
          finish(said.length === 0 ? resolve : () => reject(new Error(said.join(' '))))
          return
        }
        // After a stop the part built again is waited for anew.
        if (stopsSaid.length !== stopsSeen) {
          stopsSeen = stopsSaid.length
          started = Date.now()
        }
        if (!stopping && Date.now() - started > timeoutMs) {
          const p = client?.playing() ?? null
          if (p && (p.step ? p.ms >= timeoutMs : p.quietMs >= timeoutMs && p.buildMs >= timeoutMs)) {
            stop('limit').then(
              () => check(),
              (e) => finish(() => reject(e instanceof Error ? e : new Error(String(e)))),
            )
            return
          }
          if (!p) {
            finish(() => reject(new Error(`The build did not finish in ${Math.round(timeoutMs / 1000)} s.`)))
            return
          }
        }
        clearTimeout(timer)
        timer = setTimeout(check, 20)
      }
      check()
    })

  // ---- the scan, for the live map -------------------------------------------------------
  // The viewport's vertices, every datum alignment baked in — the frame the
  // bodies are built in — handed over once per file and once more per
  // alignment.
  let scanSent: { fileName: string | null; triangles: number; alignment: unknown } | null = null
  let scanSending: Promise<void> | null = null

  /** The scan's vertices without a viewport to read them off — every one
   *  of them, from the mesh worker, in the frame the part is measured in
   *  now, with their normals; null with no scan, or no worker. */
  const scanFromWorker = async (): Promise<{ positions: Float32Array; normals: Float32Array } | null> => {
    const s = useStore.getState()
    if (!s.fileName || s.vertexCount === 0) return null
    let worker
    try {
      worker = commandHost().session.clientRef.current
    } catch {
      // No session installed yet — nothing to read the scan from.
      return null
    }
    if (!worker) return null
    const all = await worker.query({ min: [-Infinity, -Infinity, -Infinity], max: [Infinity, Infinity, Infinity], limit: s.vertexCount })
    return { positions: all.positions, normals: all.normals }
  }

  /** Give the kernel the scan as the viewport shows it — or, without a
   *  viewport, as the mesh worker holds it — if it has not got it already:
   *  'sent', 'same' when it had it, or 'none' — no kernel, no scan. */
  const syncScan = async (): Promise<'sent' | 'same' | 'none'> => {
    const scene = sceneRef.current
    if (!client || useReverse.getState().kernelStatus !== 'ready') return 'none'
    const s = useStore.getState()
    if (!scene && !s.fileName) return 'none'
    const now = { fileName: s.fileName, triangles: s.triangleCount, alignment: s.appliedAlignment }
    if (scanSent && scanSent.fileName === now.fileName && scanSent.triangles === now.triangles && scanSent.alignment === now.alignment) {
      if (scanSending) await scanSending
      return 'same'
    }
    scanSent = now
    const fromWorker = scene ? null : await scanFromWorker()
    const positions = scene ? scene.scanPositions() : (fromWorker?.positions ?? null)
    const sending = client.setScan(positions ? positions.slice() : null, null, scene ? scene.scanIndices() : null, fromWorker?.normals ?? null)
    scanSending = sending
    try {
      await sending
    } catch (e) {
      if (scanSent === now) scanSent = null
      throw e
    } finally {
      if (scanSending === sending) scanSending = null
    }
    return 'sent'
  }

  // ---- out of the kernel ------------------------------------------------------------------

  const requireClient = (): ReClient => {
    if (!client || useReverse.getState().kernelStatus !== 'ready') throw new Error('The CAD kernel is not running — open the Reverse engineer workspace once.')
    return client
  }

  /** The STEP file the panel's Export STEP writes of the given bodies —
   *  each a part under its name, in its colour — named after the scan the
   *  part was reversed from, or as the model it is. */
  const stepFile = async (bodyIds: number[], verify = false): Promise<{ name: string; text: string; check?: StepCheck; mended?: StepMend[] }> => {
    const bodies = useReverse.getState().bodies
    const labels = bodyIds.map((id) => {
      const b = bodies.find((x) => x.id === id)
      return { name: b?.name ?? `Body ${id}`, color: b?.color ?? bodyColor(id) }
    })
    const { text, check, mended } = await requireClient().exportStepChecked(bodyIds, labels, verify)
    return { name: `${exportStem('model')}-body.step`, text, ...(check ? { check } : {}), ...(mended ? { mended } : {}) }
  }

  /** How two bodies stand to each other — the gap between them, or the
   *  volume they share — and the line the status bar says it in, in
   *  `units`. */
  const clearance = async (a: number, b: number, units: DisplayUnits = 'mm'): Promise<{ gap: number; overlap: number; text: string }> => {
    const r = await requireClient().clearance(a, b)
    const name = (id: number) => useReverse.getState().bodies.find((x) => x.id === id)?.name ?? `Body ${id}`
    const text =
      r.gap > 0
        ? `${name(a)} and ${name(b)} stand ${fmtLen(r.gap, units)} apart at the closest.`
        : r.overlap > 1e-6
          ? `${name(a)} and ${name(b)} run into each other: ${fmtVol(r.overlap, units, 3)} in common.`
          : `${name(a)} and ${name(b)} touch, with no clearance and no overlap.`
    return { ...r, text }
  }

  /** Where the given bodies of the last build run into each other — see
   *  Builder.overlaps — asked a slice of the kernel's time at a go, so a
   *  build or a preview asked for meanwhile goes in between. Null once
   *  `stale` says the answer is not wanted any more, or a build has been
   *  asked for since. */
  const overlaps = async (bodyIds: number[], stale: () => boolean): Promise<Overlap[] | null> => {
    for (;;) {
      if (!client || stale()) return null
      const r = await client.overlaps(bodyIds, OVERLAP_SLICE_MS)
      if (!r || stale()) return null
      if (r.done) return r.overlaps
    }
  }

  /** The scan's signed distance to the given bodies, for the scan's
   *  vertices within reach of them — the live map's reading (core/liveMap). */
  const bodiesMap = async (bodyIds: number[], range: number): Promise<SparseField | null> => {
    const c = requireClient()
    await syncScan()
    return c.map('bodies', bodyIds, range)
  }

  /** The same in detail — each face's reading and the worst spots (see
   *  core/compareDetail) — for the commands' comparison. */
  const bodiesCompare = async (bodyIds: number[], range: number, spots: number, patches?: PatchRequest, within?: { min: Vec3; max: Vec3 }, far?: number, side?: Omit<ScanSide, 'normals'>): Promise<CompareDetail> => {
    const c = requireClient()
    await syncScan()
    return c.compare(bodyIds, range, spots, patches, within, far, side)
  }

  /** The given solid bodies meshed to the chord — what a printer takes —
   *  as one binary STL, or a 3MF with each body an object of its own under
   *  its name, and how many triangles it holds. */
  const meshFile = async (bodies: { id: number; name: string }[], chord: number, format: MeshFormat): Promise<(MeshFile & { name: string }) | null> => {
    const meshes = await requireClient().referenceMeshes(bodies.map((b) => b.id), chord)
    const parts = meshes.map((m, i) => ({ name: meshes.length === bodies.length ? bodies[i].name : `Body ${i + 1}`, positions: m.positions, indices: m.indices }))
    const file = buildMeshFile(format, parts, null, 'ScanRuler - bodies from Reverse engineer')
    return file && { ...file, name: `${exportStem('model')}-body.${file.extension}` }
  }

  /** A body looked over by the kernel — see Builder.check; with
   *  `roundTrip`, written as STEP and read back in memory too. */
  const checkBody = (bodyId: number, tinyArea: number, before?: number, roundTrip?: boolean | 'find'): Promise<BodyCheck | null> => requireClient().check(bodyId, tinyArea, before, roundTrip)

  /** A body as it stood before a feature — the feature's own picks name
   *  its faces and edges there — or null where the feature did not run
   *  on it. */
  const staged = (stepId: number, bodyId: number): Promise<{ mesh: KernelMesh; topology: BuiltBody['topology'] } | null> => requireClient().stage(stepId, bodyId)

  /** How each body's edges' faces meet, read off its mesh once. */
  const joinsByMesh = new WeakMap<KernelMesh, Map<number, EdgeJoin>>()
  /** The faces a click on a face of a body takes for a Delete face — the
   *  whole round, hole or boss it is part of (core/faceGroup) — or none
   *  where the body is not built. */
  const deleteFacesAt = (bodyId: number, faceHash: number, tangent: boolean): FaceInfo[] => {
    const topology = topologies.get(bodyId)
    const mesh = meshes.get(bodyId)
    if (!topology || !mesh) return []
    const joins = joinsByMesh.get(mesh) ?? edgeJoins(mesh, topology)
    joinsByMesh.set(mesh, joins)
    const byHash = new Map(topology.faces.map((f) => [f.hash, f]))
    return deleteFaceGroup(topology, faceHash, (e) => joins.get(e), tangent).flatMap((h) => byHash.get(h) ?? [])
  }

  return {
    sceneRef,
    /** The kernel's client once it has been started, else null. */
    client: () => client,
    startKernel,
    meshes,
    topologies,
    regionsOf,
    resolveContext,
    /** Whether an extracted body's element has changed since the last build. */
    extractsChanged: () => extractSources() !== extractedFrom,
    /** Everything built forgotten — the scan under the workspace changed. */
    clearBodies: () => {
      meshes.clear()
      topologies.clear()
      regions.clear()
    },
    watch,
    buildState,
    busy,
    settled,
    stop,
    /** The build the kernel is at, as its worker last told it — see
     *  ReClient.playing — or null. */
    playing: () => client?.playing() ?? null,
    hold,
    release,
    /** Whether builds are held back (hold). */
    held: () => holding !== null,
    syncScan,
    stepFile,
    meshFile,
    clearance,
    overlaps,
    bodiesMap,
    bodiesCompare,
    checkBody,
    staged,
    deleteFacesAt,
  }
}

// ---- the session in use ----------------------------------------------------------------

let installed: ReverseSession | null = null

/** Make `session` the one the commands work through; the returned function
 *  takes it away again. */
export function installReverseSession(session: ReverseSession): () => void {
  installed = session
  return () => {
    if (installed === session) installed = null
  }
}

/** The session in use, or null before the workspace has been set up. */
export const reverseSession = (): ReverseSession | null => installed

// ---- compare in Deviation ---------------------------------------------------------------
// The panel's Compare in Deviation runs through the app's own hooks — the
// reference opened, the map measured — which the workspace's React side
// holds; it lends the commands the action here.

let compareInDeviationHook: ((bodyIds?: number[]) => Promise<void>) | null = null

/** Lend the commands the panel's Compare in Deviation; the returned
 *  function takes it back. */
export function installCompareInDeviation(fn: (bodyIds?: number[]) => Promise<void>): () => void {
  compareInDeviationHook = fn
  return () => {
    if (compareInDeviationHook === fn) compareInDeviationHook = null
  }
}

/** The panel's Compare in Deviation, or null before the workspace has been
 *  set up. */
export const compareInDeviation = (): ((bodyIds?: number[]) => Promise<void>) | null => compareInDeviationHook
