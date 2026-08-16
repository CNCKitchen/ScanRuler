// SPDX-License-Identifier: AGPL-3.0-only
// The DRO windows the panel reads its measurements in — big digits, small
// legend — shared so the draft preview, the dimension preview and the
// dimension rows all write their numbers the same way.

import type { DimensionValue } from '../core/dimensions'

/** Split a formatted measurement into digits and unit so the DRO window can
 *  set them apart the way an instrument does — big number, small legend. */
function splitValue(value: string): [string, string] {
  if (value.endsWith('°')) return [value.slice(0, -1), 'DEG']
  const cut = value.lastIndexOf(' ')
  return cut < 0 ? [value, ''] : [value.slice(0, cut), value.slice(cut + 1).toUpperCase()]
}

/** The digits and legend inside a DRO window — every window writes its
 *  measurement this way, so the split lives in one place. */
export function DroValue({ value, color }: { value: string; color?: string }) {
  const [num, unit] = splitValue(value)
  return (
    <>
      <b style={color ? { color } : undefined}>{num}</b>
      <span>{unit}</span>
    </>
  )
}

/** A DRO window carrying a dimension's value, or its alarm face when the
 *  measurement has none. The dimension preview and the dimension rows read
 *  identically by design, so they share it. */
export function ValueWindow({ value, testId }: { value: DimensionValue; testId: string }) {
  return value.invalid ? (
    <div className="dro-window alarm" data-test={testId}>
      <b>no value</b>
    </div>
  ) : (
    <div className="dro-window" data-test={testId}>
      <DroValue value={value.value!} />
    </div>
  )
}
