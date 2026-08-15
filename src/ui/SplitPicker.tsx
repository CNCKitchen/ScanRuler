// SPDX-License-Identifier: AGPL-3.0-only
// Two viewports, two cameras, one list of corresponding points. Clicks
// alternate: a feature on the scan, then the same feature on the reference.

import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import { PickScene, type PickMarker } from '../viewer/PickScene'
import { schemeById } from '../viewer/navSchemes'
import { useStore } from '../state/store'
import { pairColor, useDeviation } from '../state/deviationStore'
import { absoluteOrientation } from '../core/deviation/absoluteOrientation'
import type { Vec3 } from '../core/types'

/** Below this the picked points are effectively on one line. */
const MIN_CONDITIONING = 0.02

function Half({
  title,
  subtitle,
  geometry,
  markers,
  active,
  onPick,
}: {
  title: string
  subtitle: string
  geometry: THREE.BufferGeometry
  markers: PickMarker[]
  active: boolean
  onPick: (p: Vec3) => void
}) {
  const holder = useRef<HTMLDivElement>(null)
  const sceneRef = useRef<PickScene | null>(null)
  const pickRef = useRef(onPick)
  pickRef.current = onPick

  // The same buttons as the main viewport: turning a part here to find a
  // feature is the same job as turning it there.
  const navScheme = useStore((s) => s.navScheme)

  useEffect(() => {
    const scene = new PickScene(holder.current!, geometry)
    scene.onPick = (p) => pickRef.current(p)
    scene.setNavScheme(schemeById(useStore.getState().navScheme))
    sceneRef.current = scene
    return () => {
      scene.dispose()
      sceneRef.current = null
    }
  }, [geometry])

  useEffect(() => {
    sceneRef.current?.setNavScheme(schemeById(navScheme))
  }, [navScheme])

  useEffect(() => {
    sceneRef.current?.setMarkers(markers)
  }, [markers])

  return (
    <div className={'splithalf' + (active ? ' active' : '')}>
      <div className="splithead">
        <b>{title}</b>
        <span>{subtitle}</span>
      </div>
      <div className="splitview" ref={holder} />
    </div>
  )
}

export function SplitPicker({
  scanGeometry,
  nominalGeometry,
  scanName,
  nominalName,
  onAlign,
  onCancel,
}: {
  scanGeometry: THREE.BufferGeometry
  nominalGeometry: THREE.BufferGeometry
  scanName: string
  nominalName: string
  onAlign: () => void
  onCancel: () => void
}) {
  const { pairs, pendingScan, addPickPoint, undoPair, clearPairs, alignStatus, alignMessage } =
    useDeviation()

  const scanMarkers: PickMarker[] = pairs.map((p, i) => ({
    point: p.scan,
    label: String(i + 1),
    color: pairColor(i),
  }))
  if (pendingScan) {
    scanMarkers.push({ point: pendingScan, label: String(pairs.length + 1), color: pairColor(pairs.length) })
  }
  const nominalMarkers: PickMarker[] = pairs.map((p, i) => ({
    point: p.nominal,
    label: String(i + 1),
    color: pairColor(i),
  }))

  const waitingFor = pendingScan ? 'nominal' : 'scan'
  const running = alignStatus === 'running'

  // Three points fix a pose only if they are not on one line — the rotation
  // about that line would be free. Solving as they are placed says so while
  // there is still something to do about it, rather than refusing the
  // alignment after the fact.
  const solved =
    pairs.length >= 3
      ? absoluteOrientation(pairs.map((p) => p.scan), pairs.map((p) => p.nominal))
      : null
  const degenerate = solved !== null && solved.conditioning < MIN_CONDITIONING
  const enough = pairs.length >= 3 && !degenerate

  return (
    <div className="splitpicker" data-test="split-picker">
      <div className="splitbody">
        <Half
          title="Scan"
          subtitle={scanName}
          geometry={scanGeometry}
          markers={scanMarkers}
          active={waitingFor === 'scan'}
          onPick={(p) => addPickPoint('scan', p)}
        />
        <Half
          title="Reference"
          subtitle={nominalName}
          geometry={nominalGeometry}
          markers={nominalMarkers}
          active={waitingFor === 'nominal'}
          onPick={(p) => addPickPoint('nominal', p)}
        />
      </div>

      <div className="splitbar">
        <div className="splitstep">
          <b>
            {waitingFor === 'scan'
              ? `Click point ${pairs.length + 1} on the scan`
              : `Now click the same feature on the reference`}
          </b>
          <span>
            {degenerate
              ? `${pairs.length} pairs, but they are nearly in a line — add one well away from it.`
              : enough
                ? `${pairs.length} pairs — enough to align. More improves the starting guess.`
                : `${pairs.length} of 3 pairs. Spread them out: three points in a line cannot fix a rotation.`}
          </span>
        </div>
        <div className="splitpins">
          {pairs.map((_, i) => (
            <span key={i} className="pinchip" style={{ background: pairColor(i) }}>
              {i + 1}
            </span>
          ))}
          {pendingScan && (
            <span className="pinchip half" style={{ borderColor: pairColor(pairs.length) }}>
              {pairs.length + 1}
            </span>
          )}
        </div>
        <div className="grow" />
        {alignMessage && alignStatus === 'failed' && (
          <span className="splitwarn">{alignMessage}</span>
        )}
        {solved && !degenerate && (
          <span className="splitfit">picked spread {solved.rms.toFixed(2)} mm</span>
        )}
        <button disabled={!pairs.length && !pendingScan} onClick={undoPair}>
          Undo
        </button>
        <button disabled={!pairs.length && !pendingScan} onClick={clearPairs}>
          Clear
        </button>
        <button onClick={onCancel}>Cancel</button>
        <button
          className="primary"
          data-test="split-align"
          disabled={!enough || running}
          onClick={onAlign}
        >
          {running ? (
            <>
              <span className="spinner" />
              Aligning…
            </>
          ) : (
            'Align from these points'
          )}
        </button>
      </div>
    </div>
  )
}
