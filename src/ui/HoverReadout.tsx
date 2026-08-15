// SPDX-License-Identifier: AGPL-3.0-only
// The reading under the cursor, following it — the deviation from the
// reference, or the wall thickness, depending on the workspace.
//
// It owns its own state and is fed through a registered callback rather than a
// prop, so a reading that changes every frame re-renders this label and
// nothing else — putting it in the app's state would re-render the whole
// workspace at pointer rate. The text arrives ready to draw: how a figure is
// written belongs to the map it came off, not to the label that shows it.

import { useEffect, useState } from 'react'

export interface HoverReading {
  text: string
  /** The cursor is on the part, but there is no measurement there. */
  muted: boolean
  x: number
  y: number
}

export function HoverReadout({
  register,
}: {
  register: (fn: ((reading: HoverReading | null) => void) | null) => void
}) {
  const [reading, setReading] = useState<HoverReading | null>(null)

  useEffect(() => {
    register(setReading)
    return () => register(null)
  }, [register])

  if (!reading) return null
  return (
    <div
      className={'hoverdev' + (reading.muted ? ' unmatched' : '')}
      data-test="hover-readout"
      style={{ left: reading.x + 16, top: reading.y + 16 }}
    >
      {reading.text}
    </div>
  )
}
