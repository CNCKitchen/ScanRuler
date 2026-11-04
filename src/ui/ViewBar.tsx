// SPDX-License-Identifier: AGPL-3.0-only
// The ways of looking at the parts, in the bottom-left corner of the stage —
// the corner the instrument leaves free, with the colour scale down the right
// edge and the orientation gizmo bottom right. Every key here is a way of
// seeing rather than a setting of the measurement: nothing on it changes a
// number. One row, read from the left: what is on the stage, a key for each
// part — the scan, the reference, a workspace's own, the elements — that
// shows it or puts it away, with a menu over it for how it is drawn (see
// PartKey); at the side, the workspace's ways of colouring and comparing;
// last the section view, whose own row stands above while it is open. What
// is set once and left — the colour mode, the mouse controls — is in
// Settings instead.

import type { ReactNode } from 'react'
import type { Vec3 } from '../core/types'
import type { PluginRuntime } from '../plugins/api'
import { mapHeld, useDeviation } from '../state/deviationStore'
import { useSectionView } from '../state/sectionViewStore'
import { useShell } from '../state/shellStore'
import { useStore } from '../state/store'
import { Icon } from './icons'
import { anyChanged, PartKey, PartOption, type ViewSwitch } from './PartKey'
import { SectionViewKeys } from './SectionViewKeys'

export function ViewBar({
  partKeys,
  sideKeys,
  scanKey,
  hideModelKeys = false,
  viewDirection,
  stageCentre,
}: {
  /** A plugin's workspace's own parts, after the scan's key. */
  partKeys?: ReactNode
  /** And its own keys at the side, before the Section key. */
  sideKeys?: ReactNode
  /** And its hand on the scan's key — see PluginRuntime. */
  scanKey?: PluginRuntime['scanKey']
  /** No model on the stage: its keys go. */
  hideModelKeys?: boolean
  /** Which way the camera looks, in the scan's frame — the section view is
   *  laid square to it and opened toward it — and the middle of what is on
   *  the stage, which it is laid through. */
  viewDirection: () => Vec3
  stageCentre: () => Vec3
}) {
  const fileName = useStore((s) => s.fileName)
  const scanHidden = useStore((s) => s.scanHidden)
  const setScanHidden = useStore((s) => s.setScanHidden)
  const showBackfaces = useStore((s) => s.showBackfaces)
  const setShowBackfaces = useStore((s) => s.setShowBackfaces)
  const translucent = useStore((s) => s.translucent)
  const setTranslucent = useStore((s) => s.setTranslucent)
  const wireframe = useStore((s) => s.wireframe)
  const setWireframe = useStore((s) => s.setWireframe)
  const scanColors = useStore((s) => s.scanColors)
  const showScanColors = useStore((s) => s.showScanColors)
  const setShowScanColors = useStore((s) => s.setShowScanColors)
  const sectionOn = useSectionView((s) => s.on)
  // The elements as a whole, and their labels, are the measure workspace's
  // keys: elsewhere the overlays are the workspace's to show or put away,
  // and a switch that does nothing is worse than no switch.
  const elementsWorkspace = useShell((s) => s.workspace === 'elements')
  const elementsHidden = useStore((s) => s.elementsHidden)
  const setElementsHidden = useStore((s) => s.setElementsHidden)
  const hasMeasured = useStore((s) => s.elements.length > 0 || s.sections.length > 0)
  const showLabels = useStore((s) => s.showLabels)
  const setShowLabels = useStore((s) => s.setShowLabels)
  // How the deviation workspace is looked at, as against what it measures:
  // the two parts shown or put away, side by side instead of one inside the
  // other, and whether the map is painted on at all.
  const onDeviation = useShell((s) => s.workspace === 'deviation')
  const onReference = useDeviation((s) => s.source === 'reference')
  const showScan = useDeviation((s) => s.showScan)
  const setShowScan = useDeviation((s) => s.setShowScan)
  const showNominal = useDeviation((s) => s.showNominal)
  const setShowNominal = useDeviation((s) => s.setShowNominal)
  const nominalSeeThrough = useDeviation((s) => s.nominalSeeThrough)
  const setNominalSeeThrough = useDeviation((s) => s.setNominalSeeThrough)
  const nominalMesh = useDeviation((s) => s.nominalMesh)
  const setNominalMesh = useDeviation((s) => s.setNominalMesh)
  const nominalBackfaces = useDeviation((s) => s.nominalBackfaces)
  const setNominalBackfaces = useDeviation((s) => s.setNominalBackfaces)
  const split = useDeviation((s) => s.split)
  const setSplit = useDeviation((s) => s.setSplit)
  const showMap = useDeviation((s) => s.showMap)
  const setShowMap = useDeviation((s) => s.setShowMap)
  const mapOn = useDeviation((s) => s.mapOn)
  const setMapOn = useDeviation((s) => s.setMapOn)
  const referenceRunning = useDeviation((s) => s.referenceStatus === 'running')
  const nominalName = useDeviation((s) => s.nominalName)
  const nominalBusy = useDeviation((s) => s.nominalBusy)
  const hasMap = useDeviation(mapHeld)
  const nominalReady = Boolean(nominalName) && !nominalBusy
  // Nothing to stand a second viewport up with until both parts are in.
  const canSplit = Boolean(fileName) && nominalReady

  // The scan, shown or put away by the workspace that holds its key, by the
  // deviation workspace's own switch, or by the app's.
  const scanShown: ViewSwitch = scanKey?.shown ?? {
    ...(onDeviation ? { on: showScan, set: setShowScan } : { on: !scanHidden, set: (on: boolean) => setScanHidden(!on) }),
    disabled: fileName ? undefined : 'Load a scan first',
  }
  const scanSeeThrough: ViewSwitch = scanKey?.seeThrough ?? { on: translucent, set: setTranslucent, normal: false }
  const scanMesh: ViewSwitch = { on: wireframe, set: setWireframe, normal: false }
  const scanBackfaces: ViewSwitch = { on: showBackfaces, set: setShowBackfaces, normal: true }
  // Only a scan that came with colours has the switch.
  const scanColours: ViewSwitch = { on: showScanColors, set: setShowScanColors, normal: true }

  // Inside the scan the reference is a ghost, see-through its own way and
  // never tinted: how it is drawn is the menu's only while it is solid —
  // with the scan put away, or in the split view's viewport of its own.
  const ghosted = showScan && !split
  const whileSolid = ghosted
    ? 'While the scan is shown, the reference inside it is a ghost — put the scan away or split the view to set this'
    : undefined
  const referenceShown: ViewSwitch = {
    on: nominalReady && (split || showNominal),
    set: setShowNominal,
    disabled: !nominalReady
      ? 'Load the reference first'
      : split
        ? 'In the split view the reference has a viewport of its own'
        : undefined,
  }
  const referenceSeeThrough: ViewSwitch = { on: nominalSeeThrough, set: setNominalSeeThrough, disabled: whileSolid, normal: false }
  const referenceMesh: ViewSwitch = { on: nominalMesh, set: setNominalMesh, normal: false }
  const referenceBackfaces: ViewSwitch = { on: nominalBackfaces, set: setNominalBackfaces, disabled: whileSolid, normal: true }

  const elementsShown: ViewSwitch = {
    on: !elementsHidden,
    set: (on) => setElementsHidden(!on),
    disabled: hasMeasured ? undefined : 'Nothing measured yet — fit an element or cut a section and it shows here',
  }
  const labels: ViewSwitch = { on: showLabels, set: setShowLabels, normal: true }

  return (
    <div className="viewbar" data-test="view-bar">
      {!hideModelKeys && sectionOn && <SectionViewKeys viewDirection={viewDirection} />}
      <div className="viewrow">
        {/* What is on the stage. Not with the sheet alone on it. */}
        {!hideModelKeys && (
          <div className="keys" data-test="part-keys">
            <PartKey
              icon={<Icon name="scan" size={16} />}
              label="Scan"
              testId="toggle-scan"
              shown={scanShown}
              title="Show the scan, or put it away. How it is drawn is in the menu over the key"
              changed={anyChanged([scanSeeThrough, scanMesh, scanBackfaces, ...(scanColors ? [scanColours] : [])]) || Boolean(scanKey?.menuChanged)}
            >
              <PartOption
                icon={<Icon name="transparent" size={16} />}
                label="Transparent"
                testId="toggle-translucent"
                value={scanSeeThrough}
                title="Draw the scan transparent — what lies inside it, the fitted elements and the pinned readings show instead of hiding behind the surface in front of them"
              />
              <PartOption
                icon={<Icon name="mesh" size={16} />}
                label="Mesh"
                testId="toggle-wireframe"
                value={scanMesh}
                title="Draw the triangle edges on the scan, to see how fine it is and where it is patchy. The mesh comes up as you zoom in: from a distance the triangles are smaller than a pixel, and the edges fade out rather than turning the part black"
              />
              <PartOption
                icon={<Icon name="backfaces" size={16} />}
                label="Backfaces"
                testId="toggle-backfaces"
                value={scanBackfaces}
                title="Colour the far side of every triangle — holes in the scan and inverted normals stop looking like solid part"
              />
              {scanColors && (
                <PartOption
                  icon={<Icon name="scanColours" size={16} />}
                  label="Colours"
                  testId="toggle-scan-colours"
                  value={scanColours}
                  title="Show the scan in the colours it was captured in — its texture — or plain, in the stage's scan colour. Maps and tints are drawn over either"
                />
              )}
              {scanKey?.menu}
            </PartKey>
            {onDeviation && onReference && (
              <PartKey
                icon={<Icon name="model" size={16} />}
                label="Reference"
                testId="toggle-reference"
                shown={referenceShown}
                title="Show the reference, or put it away — inside the scan it is a ghost, solid with the scan put away, which is how it is checked to be the right part"
                changed={anyChanged([referenceSeeThrough, referenceMesh, referenceBackfaces])}
              >
                <PartOption
                  icon={<Icon name="transparent" size={16} />}
                  label="Transparent"
                  testId="toggle-reference-translucent"
                  value={referenceSeeThrough}
                  title="Draw the reference transparent while it is solid"
                />
                <PartOption
                  icon={<Icon name="mesh" size={16} />}
                  label="Mesh"
                  testId="toggle-reference-wireframe"
                  value={referenceMesh}
                  title="Draw the triangle edges on the reference — how finely the model was exported"
                />
                <PartOption
                  icon={<Icon name="backfaces" size={16} />}
                  label="Backfaces"
                  testId="toggle-reference-backfaces"
                  value={referenceBackfaces}
                  title="Colour the far side of every triangle of the reference while it is solid — holes and inverted normals in the model stop looking like solid part"
                />
              </PartKey>
            )}
            {partKeys}
            {elementsWorkspace && (
              <PartKey
                icon={<Icon name="elCylinder" size={16} />}
                label="Elements"
                testId="toggle-elements"
                shown={elementsShown}
                title="Show the elements, the dimensions and the sections on the part, or put them all away — each one's own eye in the list stays as it is"
                changed={anyChanged([labels])}
              >
                <PartOption
                  icon={<Icon name="labels" size={16} />}
                  label="Labels"
                  testId="toggle-labels"
                  value={labels}
                  title="Show the name tags and readouts on the part. The fitted elements, the sections and the dimension lines stay either way"
                />
              </PartKey>
            )}
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
                <Icon name="splitView" size={16} />
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
              <Icon name="colourPlot" size={16} />
              Colour plot
            </button>
            {onReference && (
              <button
                className={mapOn === 'reference' ? 'on' : undefined}
                data-test="toggle-map-on-reference"
                aria-pressed={mapOn === 'reference'}
                disabled={!hasMap}
                onClick={() => setMapOn(mapOn === 'reference' ? 'scan' : 'reference')}
                title={
                  hasMap
                    ? 'Paint the map on the reference instead of the scan: the reference coloured by its distance to the scan. It shows reference material the scan does not have, and grey where no scan stands behind the reference.'
                    : 'Nothing measured yet — the map on the reference comes with the map'
                }
              >
                <Icon name="colourPlot" size={16} />
                {referenceRunning ? 'On reference…' : 'On reference'}
              </button>
            )}
          </div>
        )}
        {sideKeys}
        {!hideModelKeys && (
          <div className="keys">
            <button
              className={sectionOn ? 'on' : undefined}
              data-test="toggle-section-view"
              aria-pressed={sectionOn}
              onClick={() => {
                const view = useSectionView.getState()
                if (view.on) view.close()
                else view.open(viewDirection(), stageCentre())
              }}
              title="Cut the parts open at a plane to look inside — the scan, the reference and everything measured on them. Closed parts are closed where they are cut; an open scan stays a shell. Slide the plane with the arrow, tilt it with the rings"
            >
              <Icon name="sectionView" size={16} />
              Section
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
