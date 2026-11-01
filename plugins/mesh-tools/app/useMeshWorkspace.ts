// SPDX-License-Identifier: AGPL-3.0-only
// The Mesh Tools workspace on screen: what each tool shows while it is in
// hand — the islands and the holes ringed on the part, the part shown cut
// where Cut's plane is, the solids on offer drawn for Boolean and Trim to
// scan, the break marked, the piece and its gap, the edited copy in the
// scan's place and its deviation — kept in step with the stores. The verbs
// themselves are the session's (meshToolsSession.ts), which the panel and
// the commands share; this hands the panel the session's, and a click on a
// hole's ring the hole it rings.
import { meshSceneOf } from '../viewer/meshScene'
import { useEffect, useRef } from 'react'
import { meshToolsOf } from '../core/meshClient'
import { summarizeCopyDeviation } from '../core/edit'
import { reductionScale } from '../core/reduce'
import { colormapById } from '../../../src/core/field/colormap'
import { usePrefs } from '../../../src/state/prefsStore'
import { fmtArea, fmtLen } from '../../../src/core/units'
import { cutPlaneOf } from '../core/cutPlane'
import { useStore } from '../../../src/state/store'
import { useShell } from '../../../src/state/shellStore'
import { useMark } from '../../../src/state/markStore'
import { TRIM_MARK_COLOR, useMeshTools } from '../state/meshStore'
import { editedCopy } from '../state/editedCopy'
import { offeredSolids, useSolids } from '../../../src/app/solids'
import { booleanSolids, elementSolidsKey } from './booleanSolids'
import type { EditRun, MeshToolsSession } from './meshToolsSession'

const message = (e: unknown) => (e instanceof Error ? e.message : String(e))

/**
 * Make a survey for the tool in hand: `ask` the worker, and hand what it
 * found to `done` while `current` still says it is wanted. A failure is
 * said, and kept as the survey's state — with only a toast, the panel would
 * go on showing it as still being made, with no way to ask again.
 */
export function runSurvey<T>(ask: () => Promise<T>, current: () => boolean, done: (found: T) => void | Promise<void>): Promise<void> {
  useMeshTools.getState().setSurveyFailed(null)
  return ask()
    .then((found) => {
      if (current()) return done(found)
    })
    .catch((e: unknown) => {
      if (!current()) return
      useMeshTools.getState().setSurveyFailed(message(e))
      useStore.getState().setError(message(e))
    })
}

export function useMeshWorkspace(session: MeshToolsSession) {
  const { clientRef, sceneRef, copyField, copyRgb, meshOfSolid, trimBodyOf } = session

  // The sharp-edge setting changed: the edited copy is split for it again as
  // the scan is — a bore cut into the scan drawn with its rim sharp — once
  // the setting has stood still a moment. Its marking and everything painted
  // on it carry across: they are keyed by its own vertices.
  const creaseMode = useStore((s) => s.creaseMode)
  const creaseAngle = useStore((s) => s.creaseAngle)
  const creaseSeen = useRef(`${creaseMode}:${creaseAngle}`)
  useEffect(() => {
    const key = `${creaseMode}:${creaseAngle}`
    if (key === creaseSeen.current) return
    creaseSeen.current = key
    if (!editedCopy.current) return
    let stale = false
    const timer = setTimeout(async () => {
      const client = meshToolsOf(clientRef.current!)
      const version = client.editedVersion
      try {
        const r = await client.recreaseEdited({ mode: creaseMode, angleDeg: creaseAngle })
        if (stale || !r || version !== client.editedVersion) return
        sceneRef.current?.resplitEdited(r.positions, r.indices, r.normals, r.wireSlots, r.copyOf)
      } catch {
        // The copy stays drawn as it was.
      }
    }, 250)
    return () => {
      stale = true
      clearTimeout(timer)
    }
  }, [creaseMode, creaseAngle, clientRef, sceneRef])

  // The islands are found, and marked on the part, while the tool is in
  // hand: again for each size typed, and for each version of the scan.
  const workspace = useShell((s) => s.workspace)
  const tool = useMeshTools((s) => s.tool)
  const pieceSize = useMeshTools((s) => s.pieceSize)
  const edits = useMeshTools((s) => s.edits)
  const fileName = useStore((s) => s.fileName)
  const triangleCount = useStore((s) => s.triangleCount)
  const appliedAlignment = useStore((s) => s.appliedAlignment)
  const copyVersion = useMeshTools((s) => s.copyVersion)
  const surveyAttempt = useMeshTools((s) => s.surveyAttempt)
  const surveying = workspace === 'mesh' && tool === 'islands' && fileName !== null && triangleCount > 0
  const islands = useRef<{ triangles: Float32Array; centres: Float32Array } | null>(null)
  useEffect(() => {
    if (!surveying) return
    const client = meshToolsOf(clientRef.current!)
    const scanVersion = client.scanVersion
    const editedVersion = client.editedVersion
    let stale = false
    useMeshTools.getState().setSurvey(null)
    void runSurvey(
      () => client.surveyIslands(pieceSize),
      () => !stale && scanVersion === client.scanVersion && editedVersion === client.editedVersion,
      ({ survey, triangles, centres }) => {
        islands.current = { triangles, centres }
        useMeshTools.getState().setSurvey({ ...survey, minSize: pieceSize })
      },
    )
    return () => {
      stale = true
    }
  }, [surveying, pieceSize, triangleCount, edits, copyVersion, appliedAlignment, surveyAttempt, clientRef])

  const surveyVersion = useMeshTools((s) => s.surveyVersion)
  useEffect(() => {
    const shown = surveying && useMeshTools.getState().survey !== null
    const marked = shown ? islands.current : null
    meshSceneOf(sceneRef.current)?.setIslands(marked?.triangles ?? null, marked?.centres ?? null)
  }, [surveying, surveyVersion, sceneRef])

  const offered = useSolids((s) => s.bySource)
  const measuredSolids = useStore((s) => elementSolidsKey(s.elements))
  const boolSolids = useMeshTools((s) => s.boolSolids)
  const boolOp = useMeshTools((s) => s.boolOp)
  const combining = workspace === 'mesh' && tool === 'boolean' && fileName !== null
  const trimSolid = useMeshTools((s) => s.trimSolid)
  const trimming = workspace === 'mesh' && tool === 'trim' && fileName !== null
  const pieceShown = useMeshTools((s) => trimming && s.trimMade !== null && s.trimView !== 'break')
  const gapShown = useMeshTools((s) => trimming && s.trimMade !== null && s.trimView === 'gap')
  // With no tool in hand the panel's parts list says what is shown: the
  // piece, and the bodies lent by other workspaces that it ticks.
  const listing = workspace === 'mesh' && tool === null && fileName !== null
  const pieceListed = useMeshTools((s) => listing && s.trimMade !== null && s.shownPiece)
  const listedBodies = useMeshTools((s) => (listing ? s.shownBodies.join('\n') : ''))
  // The solids on offer are drawn for Boolean, and for Trim to scan while the
  // break is looked at — not over the piece made of one; and those the list
  // shows, only to be looked at.
  const offering = combining ? 'boolean' : trimming && !pieceShown ? 'trim' : listedBodies !== '' ? 'list' : null
  // Nothing is in hand until it is clicked on the part or ticked in the
  // list (the tool opens empty — see setTool). One that goes is let go of;
  // not a step of the undo history.
  useEffect(() => {
    if (!combining && !trimming) return
    const solids = booleanSolids(offered)
    const held = useMeshTools.getState().boolSolids
    const keys = held.filter((key) => solids.some((s) => s.key === key))
    if (keys.length !== held.length) useMeshTools.setState({ boolSolids: keys })
    const trim = useMeshTools.getState().trimSolid
    if (trim !== null && !solids.some((s) => s.key === trim)) useMeshTools.setState({ trimSolid: null })
  }, [combining, trimming, offered, measuredSolids])

  // Every solid on offer drawn on the part while the tool is in hand — those
  // in hand in the colour of what the boolean will do with them, or the body
  // Trim to scan cuts in its teal, the others plain; a click puts one in
  // hand or takes it out again.
  const choiceOf = (by: 'boolean' | 'trim' | 'list') => {
    const m = useMeshTools.getState()
    return by === 'boolean'
      ? { keys: m.boolSolids, op: m.boolOp }
      : by === 'trim'
        ? { keys: m.trimSolid ? [m.trimSolid] : [], op: 'trim' as const }
        : { keys: [], op: 'subtract' as const }
  }
  useEffect(() => {
    const scene = sceneRef.current
    if (!scene || !offering) return
    const listed = listedBodies.split('\n')
    const solids = offering === 'list' ? offeredSolids(offered).filter((s) => listed.includes(s.key)) : booleanSolids(offered)
    const view = meshSceneOf(scene)
    view.onSolidPick =
      offering === 'list' ? null : (key) => (offering === 'boolean' ? useMeshTools.getState().toggleBoolSolid(key) : useMeshTools.getState().toggleTrimSolid(key))
    let stale = false
    Promise.all(
      solids.map((solid) =>
        meshOfSolid(solid).then(
          (mesh) => ({ key: solid.key, name: solid.name, mesh }),
          (e: unknown) => {
            if (!stale) useStore.getState().setError(`${solid.name} could not be meshed: ${message(e)}`)
            return null
          },
        ),
      ),
    ).then((meshed) => {
      if (stale) return
      // Copies: the scene carries what it draws through an alignment, and
      // the meshes kept here are the solids' own.
      const drawn = meshed.filter((m): m is NonNullable<typeof m> => m !== null).map((m) => ({ key: m.key, name: m.name, positions: m.mesh.positions.slice(), indices: m.mesh.indices }))
      const { keys, op } = choiceOf(offering)
      view.setBooleanSolids(drawn, keys, op)
    })
    return () => {
      stale = true
      view.onSolidPick = null
      view.setBooleanSolids([], [], 'subtract')
    }
    // Runs on the listed dependencies only, not on everything it reads.
  }, [offering, offered, measuredSolids, listedBodies, sceneRef])

  // Those in hand and the operation change only the colours.
  useEffect(() => {
    const scene = sceneRef.current
    if (!scene || !offering) return
    const { keys, op } = choiceOf(offering)
    meshSceneOf(scene).setBooleanChoice(keys, op)
    // Runs on the listed dependencies only, not on everything it reads.
  }, [offering, boolSolids, boolOp, trimSolid, sceneRef])

  // Whether the mesh is closed, which a boolean needs: looked at while the
  // tool is in hand, and again for each version of the mesh.
  useEffect(() => {
    if (!combining) return
    const client = meshToolsOf(clientRef.current!)
    const scanVersion = client.scanVersion
    const editedVersion = client.editedVersion
    let stale = false
    useMeshTools.getState().setBoolClosed(null)
    client
      .closedness()
      .then((c) => {
        if (!stale && scanVersion === client.scanVersion && editedVersion === client.editedVersion) useMeshTools.getState().setBoolClosed(c)
      })
      .catch(() => {
        // Said again by the boolean itself, with the reason.
      })
    return () => {
      stale = true
    }
  }, [combining, triangleCount, edits, copyVersion, clientRef])

  // The break, found for the body in hand and marked on the part to be put
  // right by hand: again for another body, another depth, Find again, and
  // each version of the mesh. A marking edited by hand is found over then —
  // the break it was put right on has changed.
  const trimDepth = useMeshTools((s) => s.trimDepth)
  const trimFinds = useMeshTools((s) => s.trimFinds)
  // The body's shape, not the list it is offered in: a marking put right by
  // hand stays while another body is rebuilt.
  const trimShape = trimSolid === null ? null : (booleanSolids(offered).find((s) => s.key === trimSolid)?.version ?? null)
  useEffect(() => {
    if (!trimming) return
    const scene = sceneRef.current
    const clearMarking = () => {
      scene?.clearPaint()
      useMark.getState().setCount(0)
    }
    const solid = trimSolid === null ? undefined : booleanSolids(offered).find((s) => s.key === trimSolid)
    if (!solid) {
      clearMarking()
      useMeshTools.getState().setTrimBreak(null, null)
      return
    }
    const client = meshToolsOf(clientRef.current!)
    const scanVersion = client.scanVersion
    const editedVersion = client.editedVersion
    let stale = false
    const current = () => !stale && scanVersion === client.scanVersion && editedVersion === client.editedVersion
    useMeshTools.getState().setTrimBreak(null, null)
    void (async () => {
      try {
        const body = await trimBodyOf(solid)
        if (!current()) return
        const { vertices, report } = await client.findBreak(body, trimDepth)
        if (!current()) return
        sceneRef.current?.setPaintedVertices(vertices, TRIM_MARK_COLOR)
        useMark.getState().setCount(vertices.length)
        useMeshTools.getState().setTrimBreak(report, null)
        useStore
          .getState()
          .setStatus(`The break where ${solid.name} reaches into the part is marked in teal — ${fmtArea(report.area, usePrefs.getState().units, 1)}. Put it right with the marking tools if it caught anything but the fracture, then trim.`)
      } catch (e) {
        if (!current()) return
        clearMarking()
        useMeshTools.getState().setTrimBreak(null, message(e))
        useStore.getState().setStatus('')
      }
    })()
    return () => {
      stale = true
    }
    // Runs on the listed dependencies only, not on everything it reads.
  }, [trimming, trimSolid, trimShape, trimDepth, trimFinds, triangleCount, edits, copyVersion, appliedAlignment, clientRef, sceneRef])

  // The piece shown while it is what is looked at, or the parts list shows
  // it, over the scan ghosted: the piece is what is solid, the scan a veil
  // that says where it meets it.
  const trimVersion = useMeshTools((s) => s.trimVersion)
  const pieceVisible = pieceShown || pieceListed
  useEffect(() => {
    const scene = sceneRef.current
    if (!scene) return
    meshSceneOf(scene).setTrimmedVisible(pieceVisible)
    if (!pieceVisible) return
    scene.setScanGhost(true)
    return () => scene.setScanGhost(false)
  }, [pieceVisible, trimVersion, sceneRef])

  // Its mating face coloured by the gap while that is asked for, in the
  // colours every map is painted in.
  const colormap = usePrefs((s) => s.colormap)
  useEffect(() => {
    const made = useMeshTools.getState().trimMade
    meshSceneOf(sceneRef.current)?.setTrimmedGap(gapShown && made ? { scale: reductionScale(made.gapRange), map: colormapById(colormap) } : null)
  }, [gapShown, trimVersion, colormap, sceneRef])

  // The rims are found, and marked on the part, while Fill holes is in hand
  // — again for each size typed, and for each version of the scan.
  const holeSize = useMeshTools((s) => s.holeSize)
  const sortingHoles = workspace === 'mesh' && tool === 'holes' && fileName !== null && triangleCount > 0
  const rims = useRef<{ holes: Float32Array; centres: Float32Array; open: Float32Array } | null>(null)
  useEffect(() => {
    if (!sortingHoles) return
    const client = meshToolsOf(clientRef.current!)
    const scanVersion = client.scanVersion
    const editedVersion = client.editedVersion
    let stale = false
    useMeshTools.getState().setHoleSurvey(null)
    void runSurvey(
      () => client.surveyHoles(holeSize),
      () => !stale && scanVersion === client.scanVersion && editedVersion === client.editedVersion,
      ({ survey, holes, centres, open }) => {
        rims.current = { holes, centres, open }
        useMeshTools.getState().setHoleSurvey({ ...survey, maxSize: holeSize })
      },
    )
    return () => {
      stale = true
    }
  }, [sortingHoles, holeSize, triangleCount, edits, copyVersion, appliedAlignment, surveyAttempt, clientRef])

  // What Shell will do with the mesh, looked at while it is in hand and again
  // for each version of the mesh: hollow it, closed; thicken it, open; or,
  // closed but for holes Fill holes would fill, ask for those first.
  const shelling = workspace === 'mesh' && tool === 'shell' && fileName !== null && triangleCount > 0
  useEffect(() => {
    if (!shelling) return
    const client = meshToolsOf(clientRef.current!)
    const scanVersion = client.scanVersion
    const editedVersion = client.editedVersion
    let stale = false
    const current = () => !stale && scanVersion === client.scanVersion && editedVersion === client.editedVersion
    useMeshTools.getState().setShellSurvey(null)
    void runSurvey(
      async () => {
        const c = await client.closedness()
        if (c.open === 0 || !current()) return { ...c, rims: 0, holes: 0 }
        const { survey } = await client.surveyHoles(holeSize)
        return { ...c, rims: survey.rims, holes: survey.holes }
      },
      current,
      (found) => useMeshTools.getState().setShellSurvey({ ...found, holeSize }),
    )
    return () => {
      stale = true
    }
  }, [shelling, holeSize, triangleCount, edits, copyVersion, surveyAttempt, clientRef])

  const holeSurveyVersion = useMeshTools((s) => s.holeSurveyVersion)
  useEffect(() => {
    const shown = sortingHoles && useMeshTools.getState().holeSurvey !== null
    const marked = shown ? rims.current : null
    meshSceneOf(sceneRef.current)?.setHoles(marked?.holes ?? null, marked?.centres ?? null, marked?.open ?? null)
  }, [sortingHoles, holeSurveyVersion, sceneRef])

  // While Cut is in hand the part is shown cut where the plane is, the side
  // that would go taken away and the cut closed with the cap the cut will
  // make — the worker's own, worked out on the scan as it stands, so the
  // part on screen is the cut as it will be, before it is made: closed where
  // it will close, open where the scan is open across the plane.
  const cutRef = useMeshTools((s) => s.cutRef)
  const cutOffset = useMeshTools((s) => s.cutOffset)
  const cutOffsetAuto = useMeshTools((s) => s.cutOffsetAuto)
  const cutKeep = useMeshTools((s) => s.cutKeep)
  const cutCap = useMeshTools((s) => s.cutCap)
  const elements = useStore((s) => s.elements)
  const modelCenter = useStore((s) => s.modelCenter)
  const cutting = workspace === 'mesh' && tool === 'cut' && fileName !== null
  useEffect(() => {
    const scene = sceneRef.current
    if (!scene || !cutting) return
    const plane = cutPlaneOf(cutRef, cutOffset, cutOffsetAuto, cutKeep, elements, modelCenter)
    if (!plane) return
    // The slice's own stencil cap closes whatever the eye looks through, which
    // on an open scan is not what the cut will close.
    scene.setSliceCapped(false)
    scene.setSlicePlane(plane.frame)
    return () => {
      scene.setSlicePlane(null)
      scene.setSliceCapped(true)
    }
  }, [cutting, cutRef, cutOffset, cutOffsetAuto, cutKeep, elements, modelCenter, fileName, sceneRef])

  // The cap is asked for a moment after the plane settles — an offset stepped
  // with the arrows asks once, not at every step — and it and what the panel
  // says of it stay until the next one lands, so neither flickers between.
  useEffect(() => {
    const scene = sceneRef.current
    if (!scene || !cutting) return
    const plane = cutPlaneOf(cutRef, cutOffset, cutOffsetAuto, cutKeep, elements, modelCenter)
    if (!plane) {
      meshSceneOf(scene).setCutCap(null, null)
      return
    }
    const client = meshToolsOf(clientRef.current!)
    const scanVersion = client.scanVersion
    const editedVersion = client.editedVersion
    let stale = false
    const timer = setTimeout(() => {
      client
        .cutPreview(plane.frame.origin, plane.frame.normal)
        .then((p) => {
          if (stale || scanVersion !== client.scanVersion || editedVersion !== client.editedVersion) return
          meshSceneOf(scene).setCutCap(cutCap ? p.cap : null, cutCap ? p.open : null)
          useMeshTools.getState().setCutPreview({ cuts: p.cuts, capped: p.capped, bridged: p.bridged, open: p.openStretches })
        })
        .catch(() => {
          // A preview that failed says nothing either way; the cut itself
          // reports what went wrong.
        })
    }, 80)
    return () => {
      stale = true
      clearTimeout(timer)
    }
  }, [cutting, cutRef, cutOffset, cutOffsetAuto, cutKeep, cutCap, elements, modelCenter, triangleCount, edits, copyVersion, appliedAlignment, clientRef, sceneRef])

  useEffect(() => {
    const scene = sceneRef.current
    if (!scene || !cutting) return
    useMeshTools.getState().setCutPreview(null)
    return () => {
      meshSceneOf(scene).setCutCap(null, null)
      useMeshTools.getState().setCutPreview(null)
    }
  }, [cutting, sceneRef])

  // ---- The edited copy -------------------------------------------------------------

  // Mesh Tools shows the copy in the scan's place; every other workspace the
  // scan it measures. Before anything is painted on either — the effects of
  // the scene's own sync run after these.
  const copyTriangles = useMeshTools((s) => s.copyTriangles)
  useEffect(() => {
    sceneRef.current?.showEdited(workspace === 'mesh' && copyTriangles !== null)
  }, [workspace, copyTriangles, copyVersion, sceneRef])

  // The copy against the scan in use, measured while it is asked for and
  // again for each version of either.
  const copyDeviation = useMeshTools((s) => s.copyDeviation)
  const measuringCopy = workspace === 'mesh' && copyDeviation && copyTriangles !== null
  useEffect(() => {
    const copy = editedCopy.current
    if (!measuringCopy || !copy) return
    const client = meshToolsOf(clientRef.current!)
    const editedVersion = client.editedVersion
    const scanVersion = client.scanVersion
    let stale = false
    useMeshTools.getState().setCopyDeviationStats(null)
    client
      .editedDeviation(copy.map)
      .then((values) => {
        if (stale || editedVersion !== client.editedVersion || scanVersion !== client.scanVersion) return
        copyField.current = values
        copyRgb.current = null
        const stats = summarizeCopyDeviation(values)
        useMeshTools.getState().setCopyDeviationStats(stats)
        const units = usePrefs.getState().units
        const added = stats.added > 0 ? `; ${((100 * stats.added) / values.length).toFixed(1)} % of it is surface an edit added` : ''
        useStore
          .getState()
          .setStatus(
            `The edited copy is within ${fmtLen(stats.maxAbs, units, 3)} of the scan in use, RMS ${fmtLen(stats.rms, units, 3)}${added}.`,
          )
      })
      .catch((e: unknown) => {
        if (!stale) useStore.getState().setError(e instanceof Error ? e.message : String(e))
      })
    return () => {
      stale = true
    }
  }, [measuringCopy, copyVersion, triangleCount, edits, clientRef, copyField, copyRgb])

  /** Close every hole under the size in the panel — or, given the number of
   *  one of the holes ringed on the part, that hole alone. */
  const fillScanHoles = (one?: number, run?: EditRun) => {
    if (one === undefined) return session.fillScanHoles(undefined, run)
    // A second click while the first hole is still being filled would find
    // its ring on a scan that is about to change.
    const centres = rims.current?.centres
    if (useMeshTools.getState().editing || !centres || one * 3 + 2 >= centres.length) return Promise.resolve(null)
    return session.fillScanHoles([centres[one * 3], centres[one * 3 + 1], centres[one * 3 + 2]], run)
  }

  return { ...session, fillScanHoles }
}
