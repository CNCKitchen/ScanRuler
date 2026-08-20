// SPDX-License-Identifier: AGPL-3.0-only
// The 2D Measure faceplate: the scanned image, and what its scale rests on.
// Calibration, element creation and dimensions grow in here as the workspace
// does; the layout follows the other panels — one group per concern, top to
// bottom in the order the work happens.

import { IMAGE_ACCEPT, IMAGE_FORMATS } from '../core/formats'
import { useFlat } from '../state/flatStore'
import { InfoDot } from './InfoDot'
import { ModelSlot } from './ModelSlot'

export function FlatPanel({ onOpenImage }: { onOpenImage: (file: File) => void }) {
  const imageName = useFlat((s) => s.imageName)
  const imageWidth = useFlat((s) => s.imageWidth)
  const imageHeight = useFlat((s) => s.imageHeight)
  const imageBusy = useFlat((s) => s.imageBusy)
  const meta = useFlat((s) => s.metaPxPerMm)

  return (
    <aside className="panel">
      <div className="group">
        <div className="sec-head">
          Image
          <InfoDot title="The scan image">
            <p>
              A flatbed scan of the part — a <b>PNG</b> or <b>JPEG</b> straight from the scanner.
              Scan at the highest optical resolution you have; the pixels are the measurement.
            </p>
            <p>Drop it anywhere in the window. Nothing is uploaded.</p>
          </InfoDot>
        </div>
        <ModelSlot
          role="Image"
          name={imageName}
          detail={`${imageWidth.toLocaleString('en-US')} × ${imageHeight.toLocaleString('en-US')} px`}
          dotColor="#8b9099"
          busy={imageBusy}
          accept={IMAGE_ACCEPT}
          formats={IMAGE_FORMATS}
          onOpen={onOpenImage}
        />
        {!imageName && <p className="hint">Drop it anywhere in the window.</p>}
        {imageName && meta && (
          <p className="hint" data-test="flat-meta-scale">
            The file declares {(meta.x * 25.4).toFixed(0)} dpi —{' '}
            {(imageWidth / meta.x).toFixed(1)} × {(imageHeight / meta.y).toFixed(1)} mm. Nominal
            until calibrated.
          </p>
        )}
        {imageName && !meta && (
          <p className="hint" data-test="flat-meta-scale">
            The file declares no physical resolution — sizes are in pixels until calibrated.
          </p>
        )}
      </div>
    </aside>
  )
}
