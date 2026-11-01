// SPDX-License-Identifier: AGPL-3.0-only
// The platform's own name for the modifier that adds to a selection and
// carries the editor's shortcuts. Windows and Linux say Ctrl; macOS says
// Command, and there Ctrl is not a modifier the user reaches for at all —
// Ctrl+click is the system's right-click, which the browser delivers as a
// second button and never as a left click, so a pick bound to Ctrl alone
// cannot happen on a Mac. Everything that reads a modifier for a pick or
// prints one in a hint asks this module instead of naming Ctrl itself.

/** True on macOS, where the modifier is Command. Read once: the platform
 *  does not change under a running app. */
export const isMac =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent)

/** The modifier written the way this platform's users read it: "⌘" on a Mac,
 *  "Ctrl" elsewhere — for a hint that names a chord. */
export const modLabel = isMac ? '⌘' : 'Ctrl'

/** The modifier held for this event: Ctrl anywhere, Command on a Mac. A pick
 *  that adds or takes away asks this, never `ctrlKey` alone. */
export const modHeld = (e?: { ctrlKey?: boolean; metaKey?: boolean } | null): boolean =>
  !!(e && (e.ctrlKey || e.metaKey))
