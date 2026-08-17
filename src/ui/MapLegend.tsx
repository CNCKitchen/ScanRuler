// SPDX-License-Identifier: AGPL-3.0-only
// The scale beside a map, read the way an inspection report reads it: the ramp
// itself, the values it stands for, and — on request — how much of the part
// actually sits at each of them.
//
// One instrument for every map the tool paints. Deviation and wall thickness
// differ only in what they hand it: the scale, how a number is written, and
// which figures belong under it.

import { legendGradient, type FieldScale } from '../core/field/colormap'
import type { FieldHistogram } from '../core/field/stats'

const TICKS = 9

/** One figure under the ramp. `wide` gives it the full width, for a pair of
 *  numbers that would not otherwise fit. */
export interface LegendStat {
  label: string
  value: string
  wide?: boolean
}

/** What the two ends of a signed scale mean, in words. The numbers alone say
 *  "+0.4" and "−0.4" and leave everyone to guess which way that is — so the
 *  scale spells it out, at the end it belongs to. */
export interface LegendEnds {
  high: string
  low: string
}

function rgb(c: readonly [number, number, number]): string {
  return `rgb(${c[0]},${c[1]},${c[2]})`
}

export function MapLegend({
  id,
  scale,
  unit,
  format,
  histogram,
  stats,
  showHistogram,
  zeroAt,
  ends,
}: {
  /** Names this legend's test hooks — one map's legend per workspace. */
  id: string
  scale: FieldScale
  unit: string
  format: (v: number) => string
  histogram: FieldHistogram | null
  stats: LegendStat[] | null
  showHistogram: boolean
  /** Value to call out on the scale — the nominal a map is read against, where
   *  it has one. */
  zeroAt?: number
  /** What each end of the ramp means. Omit on an unsigned map, where a large
   *  reading and a small one need no explaining. */
  ends?: LegendEnds
}) {
  const ticks = Array.from({ length: TICKS }, (_, i) => {
    const fraction = i / (TICKS - 1)
    return { value: scale.low + (scale.high - scale.low) * fraction, fraction }
  })

  return (
    <div className="devlegend" data-test={`${id}-legend`}>
      <div className="devlegend-unit">{unit}</div>
      {ends && (
        <div className="devlegend-end high" data-test={`${id}-end-high`}>
          <b>+</b> {ends.high}
        </div>
      )}
      <div className="devlegend-body">
        {showHistogram && histogram && (
          // Shares the ramp's vertical axis, so a bar sits at exactly the
          // height of the colour it is counting.
          <div className="devhist" data-test={`${id}-histogram`}>
            {Array.from(histogram.bins)
              .map((count, i) => ({ count, i }))
              .reverse()
              .map(({ count, i }) => (
                <div className="devhist-row" key={i}>
                  <span
                    style={{
                      width: histogram.peak ? `${(count / histogram.peak) * 100}%` : 0,
                    }}
                  />
                </div>
              ))}
          </div>
        )}
        <div className="devramp">
          <div
            className="devramp-cap"
            style={{ background: rgb(scale.capHigh) }}
            title="Beyond the top of the scale"
          />
          <div
            className="devramp-bar"
            style={{ background: legendGradient(scale.bands, scale.reversed) }}
          />
          <div
            className="devramp-cap"
            style={{ background: rgb(scale.capLow) }}
            title="Beyond the bottom of the scale"
          />
        </div>
        <div className="devticks">
          {ticks.map((t) => (
            <span
              key={t.fraction}
              className={
                zeroAt !== undefined && Math.abs(t.value - zeroAt) < 1e-9 ? 'zero' : undefined
              }
              style={{ bottom: `${t.fraction * 100}%` }}
            >
              {format(t.value)}
            </span>
          ))}
        </div>
      </div>
      {ends && (
        <div className="devlegend-end low" data-test={`${id}-end-low`}>
          <b>−</b> {ends.low}
        </div>
      )}

      {stats && (
        <div className="devstats" data-test={`${id}-stats`}>
          {stats.map((s) => (
            <div key={s.label} className={s.wide ? 'wide' : undefined}>
              <span>{s.label}</span>
              <b>{s.value}</b>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
