// SPDX-License-Identifier: AGPL-3.0-only
// An element's own colour as a text colour, panel-side.

import type { CSSProperties } from 'react'

/** The style for text in an element's colour, to go with the `tinted` class.
 *  The colour is handed to the stylesheet as `--tint` instead of being set as
 *  the colour itself, so that the dark chassis can lift it toward white before
 *  it is used as text — a palette tuned to hold on a light panel has tones
 *  that sink into a dark one (see `.tinted` in styles.css). Any other style
 *  the text needs rides along. */
export function tintStyle(color: string, more?: CSSProperties): CSSProperties {
  return { ...more, '--tint': color } as CSSProperties
}
