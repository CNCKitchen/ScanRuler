// SPDX-License-Identifier: AGPL-3.0-only
// Moving the part into a coordinate system of its own: the 3-2-1 alignment
// applied, the pose the scan suggests for itself (Auto-align), that pose
// settled on the part's mirror plane (Use symmetry), and the way back to scan
// coordinates. The Alignment group of the 3D Measure panel and the align.*
// commands both work through these.

import type { RefObject } from 'react'
import { describeRigid } from '../core/alignment'
import { ALIGN_SYMMETRY_MAX_RMS_MM, poseOfRigid, poseOnSymmetry } from '../core/alignSymmetry'
import { autoAlignPicks } from '../core/autoAlign'
import { rigidApply, rigidInvert, type Rigid } from '../core/deviation/rigid'
import { SYMMETRY_MAX_RMS_MM, SYMMETRY_MIN_MATCHED } from '../core/symmetry'
import type { Vec3 } from '../core/types'
import type { MeshWorkerClient } from '../core/workerClient'
import { useDeviation } from '../state/deviationStore'
import { historyAsync } from '../state/historyStore'
import { alignCenterOf, alignmentPreview, useStore } from '../state/store'
import { useThickness } from '../state/thicknessStore'
import type { ScanMaps } from '../plugins/api'
import type { SceneManager } from '../viewer/SceneManager'
import type { ImportQueue } from './importQueue'
import { surfacesMoved } from './surfaces'

export interface PartAlignmentDeps {
  clientRef: RefObject<MeshWorkerClient | null>
  sceneRef: RefObject<SceneManager | null>
  imports: ImportQueue
  maps: ScanMaps
  clearPreview: () => void
}

export type PartAlignment = ReturnType<typeof partAlignment>

export function partAlignment({ clientRef, sceneRef, imports, maps, clearPreview }: PartAlignmentDeps) {
  /** Bake a datum alignment (or its inverse, on reset) into everything that
   *  carries scan coordinates: the worker's copy of the mesh, the displayed
   *  mesh and its BVH, and every element in the store. Vertex order never
   *  changes, so painted regions and fit seeds stay valid. A scan→reference
   *  best fit was measured in the old frame and is invalidated along with the
   *  deviation map on it. True when it went through. */
  const applyRigidToPart = (m: Rigid, reset = false) => imports.run(() => historyAsync('Align part', async () => {
    useStore.setState({ busy: true })
    try {
      clearPreview()
      useStore.getState().setStatus('Aligning part — rebuilding spatial index…')
      // Let the status paint before the synchronous BVH rebuild.
      await new Promise((r) => setTimeout(r, 30))
      await clientRef.current!.transform(m)
      // The real transform goes on and the preview of it comes off together.
      sceneRef.current?.applyTransform(m)
      sceneRef.current?.setAlignPreview(null)
      useStore.getState().applyAlignment(m)
      if (reset) useStore.getState().clearAppliedAlignment()
      // Thickness is invariant under a rigid move; its pins move with the scan.
      const moved = new Float64Array(3)
      useThickness.setState((s) => ({ probes: s.probes.map((probe) => {
        rigidApply(m, ...probe.point, moved)
        return { ...probe, point: [moved[0], moved[1], moved[2]] as Vec3 }
      }) }))
      surfacesMoved()
      maps.deviation.current = null
      maps.deviationRgb.current = null
      sceneRef.current?.setFieldColors(null)
      useDeviation.getState().clearAlign()
    } finally { useStore.setState({ busy: false }) }
  })).then(() => true).catch((error) => {
    useStore.getState().setError(error instanceof Error ? error.message : String(error))
    return false
  })

  /** Confirm alignment: the pose the editor holds, applied. */
  const applyAlignment = async (m: Rigid): Promise<boolean> => {
    const { rotationDeg, translation } = describeRigid(m)
    if (!await applyRigidToPart(m)) return false
    useStore
      .getState()
      .setStatus(
        `Part aligned — rotated ${rotationDeg.toFixed(2)}°, moved ${translation.toFixed(3)} mm. Elements and dimensions moved with it.`,
      )
    return true
  }

  /** Move part: six typed-in numbers, applied. */
  const applyManual = async (m: Rigid): Promise<boolean> => {
    const { rotationDeg, translation } = describeRigid(m)
    if (!await applyRigidToPart(m)) return false
    useStore
      .getState()
      .setStatus(
        `Part moved — rotated ${rotationDeg.toFixed(2)}°, moved ${translation.toFixed(3)} mm. Elements and dimensions moved with it.`,
      )
    return true
  }

  /** Back to the frame the scanner delivered the part in. */
  const resetAlignment = async (): Promise<boolean> => {
    const total = useStore.getState().appliedAlignment
    if (!total) return false
    if (!await applyRigidToPart(rigidInvert(total), true)) return false
    useStore.getState().setStatus('Alignment reset — the part is back in scan coordinates.')
    return true
  }

  /** Ask the worker what coordinate system the scan suggests and open the
   *  alignment editor on it: the slots filled, the pose previewed on the part,
   *  nothing applied. What the proposal rests on is said in the editor, so a
   *  guess reads as a guess. True when a proposal is open. */
  const proposeAutoAlign = async (): Promise<boolean> => {
    clearPreview()
    const s = useStore.getState()
    s.setError(null)
    s.setStatus('Auto-align — reading the part’s directions off the scan…')
    s.setWorking('READING…')
    try {
      const r = await clientRef.current!.autoAlign()
      const pct = (share: number) => `${Math.round(share * 100)} %`
      const stands = {
        'open-side': 'the side the scan is open on',
        face: 'its largest flat face',
        'axis-end': 'an end of its main axis',
        extent: 'its flattest side',
      }[r.base]
      const read =
        r.method === 'principal'
          ? 'The scan shows no face directions and no round walls, so this is the principal axes of its points — a guess.'
          : r.method === 'axis'
            ? `Read off the scan: the main axis from the round walls (${pct(r.wallShare)} of the surface)${
                r.onAxis ? ', zero on that axis' : ''
              }; ${pct(r.planeShare)} of the surface is faces square to the axes.`
            : `Read off the scan: ${pct(r.planeShare)} of the surface is faces square to these axes${
                r.wallShare >= 0.05 ? `, ${pct(r.wallShare)} more is wall running along them` : ''
              }.`
      const note = `${read} The part stands on ${stands}, its long side along X. Change a side or a direction below if it reads the part differently than you do.`
      useStore.getState().proposeAlignment(autoAlignPicks(r, 0.2 * useStore.getState().modelSize), note)
      useStore.getState().setStatus('Auto-align — check the previewed pose, then press Confirm alignment.')
      return true
    } catch (e) {
      useStore.getState().setStatus('')
      useStore.getState().setError(e instanceof Error ? e.message : 'Auto-align failed.')
      return false
    } finally {
      useStore.getState().setWorking(null)
    }
  }

  /** The pose being set up, settled on the part's symmetry plane: the plane
   *  a Measure symmetry plane gives, or the scan searched for its own; the
   *  pose the editor previews, or Auto-align's when it has none yet. It
   *  comes back as a proposal — picks, like Auto-align's — so every choice
   *  in it can still be changed and nothing moves until it is applied. True
   *  when a proposal is open. */
  const proposeSymmetry = async (): Promise<boolean> => {
    clearPreview()
    const s = useStore.getState()
    const client = clientRef.current
    if (!client || !s.fileName) return false
    s.setError(null)
    // Seconds of searching on a big scan, with nothing to show on the part
    // until the pose lands: the viewport says so meanwhile, as the symmetry
    // plane's own box does.
    s.setWorking('SEARCHING…')
    try {
      const ad = s.alignDraft
      const standing = ad ? alignmentPreview(ad, s.elements, s.modelSize, alignCenterOf(s)).preview : null
      let pose: { axes: [Vec3, Vec3, Vec3]; origin: Vec3 }
      if (standing) pose = poseOfRigid(standing.rigid)
      else {
        s.setStatus('Use symmetry — no pose set up yet, reading one off the scan first…')
        pose = await client.autoAlign()
      }
      const measured = [...s.elements].reverse().find((e) => e.fit?.kind === 'plane' && e.source.type === 'constructed' && e.source.method === 'plane-symmetry')
      let plane: { normal: Vec3; point: Vec3 }
      let from: string
      if (measured?.fit?.kind === 'plane') {
        plane = { normal: measured.fit.normal, point: measured.fit.center }
        from = measured.name
      } else {
        s.setStatus('Use symmetry — searching the scan for its mirror plane…')
        const r = await client.symmetry(null)
        if (!Number.isFinite(r.rms) || r.rms > ALIGN_SYMMETRY_MAX_RMS_MM || r.sampled === 0 || r.matched / r.sampled < SYMMETRY_MIN_MATCHED) {
          useStore.getState().setStatus('')
          useStore.getState().setError(`No symmetry plane found on the scan — the best mirror image stands ${Number.isFinite(r.rms) ? `${r.rms.toFixed(2)} mm` : 'far'} off it. The pose is left as it is.`)
          return false
        }
        plane = { normal: r.normal, point: r.point }
        from = `the scan’s mirror plane (σ ${r.rms.toFixed(3)} mm${r.rms > SYMMETRY_MAX_RMS_MM ? ', a loose match' : ''})`
      }
      const settled = poseOnSymmetry(pose.axes, pose.origin, plane)
      if (!settled) {
        useStore.getState().setError('The symmetry plane has no direction to settle the pose on.')
        return false
      }
      const names = ['YZ', 'XZ', 'XY']
      const note = `Settled on ${from}: it is the ${names[settled.axis]} plane now — ${'XYZ'[settled.axis]} turned ${settled.tiltDeg.toFixed(2)}° onto its normal, the zero point moved ${settled.shiftMm.toFixed(2)} mm onto it. The steps below are this pose as points; change a side or a direction if it reads the part differently than you do.`
      useStore.getState().proposeAlignment(autoAlignPicks(settled, 0.2 * useStore.getState().modelSize), note)
      useStore.getState().setStatus('Use symmetry — check the previewed pose, then press Confirm alignment.')
      return true
    } catch (e) {
      useStore.getState().setStatus('')
      useStore.getState().setError(e instanceof Error ? e.message : 'The symmetry search failed.')
      return false
    } finally {
      useStore.getState().setWorking(null)
    }
  }

  return { applyRigidToPart, applyAlignment, applyManual, resetAlignment, proposeAutoAlign, proposeSymmetry }
}
