// SPDX-License-Identifier: AGPL-3.0-only
// The ways of looking at the parts, in the bottom-left corner of the stage —
// the corner the instrument leaves free, with the colour scale down the right
// edge and the orientation gizmo bottom right. Every key here is a way of
// seeing rather than a setting of the measurement: nothing on it changes a
// number, and nothing on it is saved. The bottom row holds for every part in
// every viewport; the row above it is the workspace's own, and comes and goes
// with the workspace. What is set once and left — the colour mode, the mouse
// controls — is in Settings instead.

import { useDeviation } from '../state/deviationStore'
import { useShell } from '../state/shellStore'
import { useStore } from '../state/store'

export function ViewBar() {
  const showLabels = useStore((s) => s.showLabels)
  const setShowLabels = useStore((s) => s.setShowLabels)
  const showBackfaces = useStore((s) => s.showBackfaces)
  const setShowBackfaces = useStore((s) => s.setShowBackfaces)
  const translucent = useStore((s) => s.translucent)
  const setTranslucent = useStore((s) => s.setTranslucent)
  const wireframe = useStore((s) => s.wireframe)
  const setWireframe = useStore((s) => s.setWireframe)
  // The labels are the measure workspace's own: elsewhere the overlays are put
  // away whatever this says, and a switch that does nothing is worse than no
  // switch. Only the name tags and readouts answer to it — the elements
  // themselves are the list's to hide, and a second way of doing that would
  // have been the same switch twice.
  const elementsWorkspace = useShell((s) => s.workspace === 'elements')
  // How the deviation workspace is looked at, as against what it measures:
  // the two parts side by side instead of one inside the other, and whether
  // the map is painted on at all.
  const onDeviation = useShell((s) => s.workspace === 'deviation')
  const onReference = useDeviation((s) => s.source === 'reference')
  const split = useDeviation((s) => s.split)
  const setSplit = useDeviation((s) => s.setSplit)
  const showMap = useDeviation((s) => s.showMap)
  const setShowMap = useDeviation((s) => s.setShowMap)
  const nominalName = useDeviation((s) => s.nominalName)
  const nominalBusy = useDeviation((s) => s.nominalBusy)
  const hasMap = useDeviation((s) =>
    s.source === 'element' ? s.elementStatus === 'ready' : s.mapStatus === 'ready',
  )
  const fileName = useStore((s) => s.fileName)
  // Nothing to stand a second viewport up with until both parts are in.
  const canSplit = Boolean(fileName) && Boolean(nominalName) && !nominalBusy

  return (
    <div className="viewbar" data-test="view-bar">
      {elementsWorkspace && (
        <div className="keys">
          <button
            className={showLabels ? 'on' : undefined}
            data-test="toggle-labels"
            aria-pressed={showLabels}
            onClick={() => setShowLabels(!showLabels)}
            title="Show the name tags and readouts on the part. The fitted elements, the sections and the dimension lines stay either way — Hide all in the list is for those"
          >
            Labels
          </button>
        </div>
      )}
      {onDeviation && (
        <div className="keys">
          {onReference && (
            <button
              className={split ? 'on' : undefined}
              data-test="toggle-split"
              aria-pressed={split}
              disabled={!canSplit}
              onClick={() => setSplit(!split)}
              title={
                canSplit
                  ? 'Show the scan and the reference in two viewports that turn, pan and zoom together'
                  : 'Load both the scan and the reference to compare them side by side'
              }
            >
              Split view
            </button>
          )}
          <button
            className={showMap ? 'on' : undefined}
            data-test="toggle-colormap"
            aria-pressed={showMap}
            disabled={!hasMap}
            onClick={() => setShowMap(!showMap)}
            title={
              hasMap
                ? 'Paint the measured deviation onto the scan. Off leaves the bare surface — nothing measured is lost, and the figures, the readings and the pins all still report it.'
                : 'Nothing measured yet — the colour plot appears with the map'
            }
          >
            Colour plot
          </button>
        </div>
      )}
      {/* About the models, in every viewport that shows one, and never about
          what has been measured. */}
      <div className="keys">
        <button
          className={translucent ? 'on' : undefined}
          data-test="toggle-translucent"
          aria-pressed={translucent}
          onClick={() => setTranslucent(!translucent)}
          title="See through the parts — the reference inside the scan, the fitted elements and the pinned readings show instead of hiding behind the surface in front of them"
        >
          Transparent
        </button>
        <button
          className={wireframe ? 'on' : undefined}
          data-test="toggle-wireframe"
          aria-pressed={wireframe}
          onClick={() => setWireframe(!wireframe)}
          title="Draw the triangle edges on the parts, to see how fine the scan is and where it is patchy. The mesh comes up as you zoom in: from a distance the triangles are smaller than a pixel, and the edges fade out rather than turning the part black"
        >
          Mesh
        </button>
        <button
          className={showBackfaces ? 'on' : undefined}
          data-test="toggle-backfaces"
          aria-pressed={showBackfaces}
          onClick={() => setShowBackfaces(!showBackfaces)}
          title="Colour the far side of every triangle — holes in the scan and inverted normals stop looking like solid part"
        >
          Backfaces
        </button>
      </div>
    </div>
  )
}
