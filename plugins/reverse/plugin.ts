// SPDX-License-Identifier: AGPL-3.0-only
// The Reverse engineer workspace, as the app finds it: see
// src/plugins/api.ts for what each part of this is to the app.

import { registerBusy, registerCommands, registerMapReport, registerSectionLayers, registerSettle, registerSheetPlanes, registerStateSection, registerViewToggles, type ScanRulerPlugin } from '../../src/plugins/api'
import { onScan } from '../../src/app/scanEvents'
import { pick, registerHistory } from '../../src/state/historyStore'
import { registerProjectSection } from '../../src/app/projectSections'
import { reverseSection } from './app/projectSection'
import { useReversePlugin } from './app/useReversePlugin'
import { reverseKeyboard } from './app/keyboard'
import { ReverseNotices } from './ui/ReverseNotices'
import './ui/reverse.css'
import { evaluateParameters } from './core/parameters'
import { useReverse } from './state/reStore'
import { reverseCommands } from './app/reCommands'
import { registerReverseGuides } from './guides/guides'
import { settleHeld } from './app/reCommandCore'
import { bodiesLayer } from './app/reSectionLayer'
import { sketchPlanes } from './app/reSectionCommands'
import { useShell } from '../../src/state/shellStore'
import { afterStepOut } from './app/reCommandAnswers'
import { describeReverse } from './app/reReadout'
import { createReverseSession, installReverseSession, reverseSession } from './app/reSession'
import { ReClient } from './core/reClient'
import { playbackBusy } from './app/playback'
import { followPart, notesSection } from './app/notesSection'
import { notesBrief } from './app/reNoteCommands'
import { planBrief, planSection, watchPlan } from './app/rePlan'
import { askMap, forgetMapWait, mapWhyNow, settleMap } from './app/reMapRead'
import { sceneOf } from '../../src/commands/host'
import { usePrefs } from '../../src/state/prefsStore'
import { useNotes } from './state/noteStore'
import { reSceneOf } from './viewer/reScene'
import { redoNetwork, undoNetwork } from './state/reNetworkDraft'

/** The open Patch network's draft, if one is open. */
function networkOpen() {
  const d = useReverse.getState().featureDraft
  return d?.kind === 'network' ? d : null
}

/** Why a picture of the workspace has no body in it, for its answer
 *  (bodiesWhy) — read while none is shown: none built, the view bar's
 *  Bodies key off (the person's, or view.set's), or every body's eye shut —
 *  and what shows them. */
function bodiesWhy(): string | null {
  const s = useReverse.getState()
  if (s.bodies.length === 0) return 'none built — reverse.feature.list says what each feature made'
  const shut = s.bodies.every((b) => !b.visible) ? s.bodies.map((b) => b.id) : []
  if (s.bodiesHidden) return `view bar Bodies key off${shut.length > 0 ? `, eyes shut too: [${shut.join(', ')}]` : ''} — show: { bodies: true } shows them for the picture`
  if (shut.length > 0) return `eyes shut: [${shut.join(', ')}] — show: { bodies: true } opens them for the picture, reverse.body.set { visible: true } for good`
  return null
}

const plugin: ScanRulerPlugin = {
  id: 'reverse',
  name: 'Reverse engineer',
  workspace: {
    id: 'reverse',
    label: 'Reverse engineer',
    title: 'Sketch on sections, extrude and revolve, and export a solid STEP body built over the scan',
    icon: 'extract',
    order: 10,
  },
  keyboard: reverseKeyboard,
  notices: ReverseNotices,
  install() {
    registerProjectSection(reverseSection)
    // The notes pinned on the part for an agent: saved with the project,
    // let go with the scan, moved with the part.
    registerProjectSection(notesSection)
    followPart()
    // The plan an agent sets for the part: saved with the project, let go
    // with the scan; the failures noted for the features removed after.
    registerProjectSection(planSection)
    watchPlan()
    // An agent's way in: the workspace's commands under reverse.*, its part
    // of the session's readout, and what its kernel is busy with — loading,
    // or building the bodies — so no command runs over it.
    registerCommands('reverse', reverseCommands)
    // How to go about it, for an agent — guide.read serves them.
    registerReverseGuides()
    // A batch's changes run deferred build once, at its end: what they held
    // back is built before any other command.
    registerSettle(settleHeld)
    // The notes on the part join it there, while there are any, and the
    // plan, once set.
    registerStateSection('reverse', () => {
      const notes = notesBrief()
      const plan = planBrief()
      return { ...describeReverse(), ...(notes ? { notes } : {}), ...(plan ? { plan } : {}) }
    }, afterStepOut)
    // What a picture may show or put away while the workspace is on
    // screen: the scan, as the view bar's Scan key does here; the map; the
    // bodies as a whole; the sketches — and, wherever they are drawn, the
    // notes' pins.
    const onReverse = () => useShell.getState().workspace === 'reverse'
    // What a picture of a section draws beside the scan: the bodies' cut,
    // the scan's gap read against it, and the sketches on the section.
    registerSectionLayers('reverse', [bodiesLayer])
    // And the sketches' planes it may lie on, each in the sketch's frame.
    registerSheetPlanes('reverse', sketchPlanes)
    // Which map a picture of the workspace shows, or why it shows none.
    registerMapReport('reverse', () => {
      const s = useReverse.getState()
      if (s.curvatureShown) return { map: { on: 'scan', reading: 'curvature' } }
      if (s.mapReport) return { map: { on: 'scan', against: s.mapReport.source, colormap: usePrefs.getState().colormap, range: s.mapReport.range } }
      if (!s.bodies.some((b) => b.visible)) return null
      if (!s.bodyMap) return { map: null, mapWhy: 'the map against the bodies is off — show: { map: true } puts it on for the picture' }
      return { map: null, mapWhy: mapWhyNow() }
    })
    registerViewToggles('reverse', [
      { key: 'scan', description: 'the scan under the bodies', applies: onReverse, shown: () => !useReverse.getState().scanHidden, show: (on) => useReverse.getState().setScanHidden(!on) },
      // The bodies as a whole go through the view bar's own key: put away
      // they are not drawn, and stay in the model and in the map — the
      // map on the scan alone. Shown again with every body's own eye shut,
      // the eyes open too, so that showing them shows something.
      {
        key: 'map',
        description: 'the deviation map on the scan, read against the bodies (the view bar’s Deviation key); a picture that asks for it waits for it to be read',
        applies: onReverse,
        shown: () => useReverse.getState().bodyMap,
        show: askMap,
        settle: settleMap,
        // The map on turns the curvature map off: both come back.
        save: () => ({ bodyMap: useReverse.getState().bodyMap, curvatureMap: useReverse.getState().curvatureMap }),
        restore: (saved) => {
          forgetMapWait()
          const was = saved as { bodyMap: boolean; curvatureMap: boolean }
          useReverse.getState().setCurvatureMap(was.curvatureMap)
          useReverse.getState().setBodyMap(was.bodyMap)
        },
      },
      {
        key: 'bodies',
        description: 'the bodies built (put away, the map stays on the scan; a picture with none in it says why under bodiesWhy)',
        applies: onReverse,
        shown: () => !useReverse.getState().bodiesHidden && useReverse.getState().bodies.some((b) => b.visible),
        show: (on) => {
          const s = useReverse.getState()
          s.setBodiesHidden(!on)
          if (on && !s.bodies.some((b) => b.visible)) s.setAllBodiesVisible(true)
        },
        // Put back as it was kept — the key, every body's eye and the
        // lasting list of bodies hidden (a thickened sheet's among them,
        // which show(true) with every eye shut empties) — not by
        // show(shown()): read off with every eye shut, that would put the
        // bodies away by the key, which the session never did.
        save: () => {
          const s = useReverse.getState()
          return { hidden: s.bodiesHidden, eyes: new Map(s.bodies.map((b) => [b.id, b.visible])), hiddenBodies: s.hiddenBodies }
        },
        restore: (saved) => {
          const was = saved as { hidden: boolean; eyes: Map<number, boolean>; hiddenBodies: number[] }
          useReverse.setState((s) => ({
            bodiesHidden: was.hidden,
            hiddenBodies: was.hiddenBodies,
            bodies: s.bodies.some((b) => was.eyes.has(b.id) && was.eyes.get(b.id) !== b.visible) ? s.bodies.map((b) => (was.eyes.has(b.id) ? { ...b, visible: was.eyes.get(b.id)! } : b)) : s.bodies,
          }))
        },
        why: bodiesWhy,
      },
      // On the stage alone: no sketch's eye is shut, so nothing of it is a
      // step of the history or goes with the project.
      {
        key: 'sketches',
        description: 'the sketches drawn on the part (put away on the stage alone — no sketch changes)',
        applies: onReverse,
        shown: () => {
          const scene = sceneOf()
          return scene ? reSceneOf(scene).sketchesShown() : true
        },
        show: (on) => {
          const scene = sceneOf()
          if (scene) reSceneOf(scene).setSketchesShown(on)
        },
      },
      // The pins are drawn in every workspace while the agent connection is
      // on; put away, the notes stay as they are.
      {
        key: 'notes',
        description: 'the pins of the notes on the part (put away, the notes stay)',
        applies: () => usePrefs.getState().agentLink,
        shown: () => useNotes.getState().pinsShown,
        show: (on) => useNotes.getState().setPinsShown(on),
      },
    ])
    // A build under way is stopped for a change that throws the work away
    // — a project or a scan opened with discard — and the next one held
    // till it has run.
    registerBusy('reverse', () => playbackBusy() ?? reverseSession()?.busy() ?? (useReverse.getState().kernelStatus === 'loading' ? 'the CAD kernel is loading' : null), [useReverse], async (done) => {
      await reverseSession()?.stop('discard', done)
    })
    registerHistory({
      sections: [
        {
          key: 'reverse',
          capture: () => pick(useReverse.getState(), ['features', 'rolledBack', 'nextFeatureId', 'nextOfKind', 'parameters', 'nextParameterId', 'bodyStyles', 'bodyFolders', 'scanSeeThrough', 'bodiesSeeThrough', 'elementsShown']),
          // The feature list as it was, built again; whatever the sketch had
          // of its own history, and whatever was selected, goes. The
          // parameters come back with it, their table read again.
          apply: (value) =>
            useReverse.setState((s) => {
              const v = value as Partial<typeof s>
              return { ...v, parameterTable: evaluateParameters(v.parameters ?? s.parameters), past: [], future: [], selection: null, buildVersion: s.buildVersion + 1 }
            }),
        },
      ],
      actions: [
        {
          store: useReverse,
          label: 'Reverse engineer',
          names: ['commitSketch', 'commitExtrude', 'commitRevolve', 'commitFeature', 'removeFeature', 'toggleFeatureVisible', 'setSuppressed', 'setKeyParameter', 'rollTo', 'setScanSeeThrough', 'setBodiesSeeThrough', 'setOverlapsShown', 'setElementsShown', 'extrudeFace', 'addParameter', 'setParameter', 'removeParameter', 'addBodyFolder', 'renameBodyFolder', 'removeBodyFolder', 'moveToBodyFolder'],
          labels: {
            commitSketch: 'finish sketch', commitExtrude: 'save extrusion', commitRevolve: 'save revolution',
            commitFeature: 'save feature', rollTo: 'move rollback bar', setKeyParameter: 'edit feature parameter',
            addParameter: 'add parameter', setParameter: 'edit parameter', removeParameter: 'remove parameter',
            setSuppressed: 'suppress or build features',
            addBodyFolder: 'new component', renameBodyFolder: 'rename component', removeBodyFolder: 'remove component', moveToBodyFolder: 'move into a component',
          },
        },
      ],
      // A kind merely in hand blocks nothing, as the sketch's tool in hand
      // does not; a box with work in it does, and so does a build — and a
      // playback, whose bar is not where the part ends.
      blocked: () => {
        const r = useReverse.getState()
        // A Patch network's box has an undo of its own (below), which the
        // keys walk while it is open.
        return r.building || r.playback !== null || !!(r.extrudeDraft || r.revolveDraft || (r.featureDraft && r.featureDraft.kind !== 'network'))
      },
      // An open sketch has a history of its own, which undo walks while the
      // sketch is open.
      local: {
        workspace: 'reverse',
        label: 'sketch edit',
        active: () => useReverse.getState().sketchDraft !== null,
        canUndo: () => (useReverse.getState().sketchDraft?.history.length ?? 0) > 0,
        canRedo: () => (useReverse.getState().sketchDraft?.future?.length ?? 0) > 0,
        undo: () => useReverse.getState().undoSketch(),
        redo: () => useReverse.getState().redoSketch(),
      },
      useWatch: () => {
        useReverse((s) => !!(s.building || s.playback || s.extrudeDraft || s.revolveDraft || s.featureDraft))
        return useReverse((s) => s.sketchDraft)
      },
    })
    // A Patch network's box keeps the network's edits as a history of its
    // own: undo and redo walk it while the box is open, and Save takes the
    // network into the feature list as one step.
    registerHistory({
      local: {
        workspace: 'reverse',
        label: 'network edit',
        active: () => useReverse.getState().featureDraft?.kind === 'network',
        canUndo: () => (networkOpen()?.history.length ?? 0) > 0,
        canRedo: () => (networkOpen()?.future.length ?? 0) > 0,
        undo: () => useReverse.getState().editNetwork(undoNetwork),
        redo: () => useReverse.getState().editNetwork(redoNetwork),
      },
      useWatch: () => useReverse((s) => (s.featureDraft?.kind === 'network' ? s.featureDraft.history.length * 1000 + s.featureDraft.future.length : -1)),
    })
    // Another version of the scan under the session: a Fit Surface's region
    // is vertices of the scan, carried onto the new numbering; and every
    // fitted surface is a region of the scan, so the bodies are built again.
    onScan({
      remapped: (remap) => {
        const surface = <T extends { kind: string }>(f: T): T =>
          f.kind === 'surface' ? { ...f, region: remap((f as unknown as { region: Uint32Array }).region) } : f
        useReverse.setState((s) => ({ features: s.features.map(surface), rolledBack: s.rolledBack.map(surface) }))
      },
      remeasure: async () => {
        const re = useReverse.getState()
        if (re.features.length + re.rolledBack.length > 0) useReverse.setState((s) => ({ buildVersion: s.buildVersion + 1 }))
      },
    })
  },
  usePlugin: useReversePlugin,
  // The app run without a browser (src/headless/engine.ts): the workspace's
  // session over the kernel in this thread, as the tests run it — the
  // commands marked headless (app/reCommands.ts) model through it, no scan
  // and no viewport.
  async headless() {
    // The kernel's service in this thread, loaded only here: the page builds
    // in its worker and never takes the builder onto its own thread.
    const { localKernel } = await import('./core/reLocal')
    const session = createReverseSession({ sceneRef: { current: null }, kernel: () => new ReClient(localKernel()) })
    const stops = [installReverseSession(session), session.watch()]
    await session.startKernel()
    return () => {
      for (const stop of stops.reverse()) stop()
      session.client()?.dispose()
    }
  },
}

export default plugin
