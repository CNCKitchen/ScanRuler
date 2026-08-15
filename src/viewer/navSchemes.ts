// SPDX-License-Identifier: AGPL-3.0-only
// Mouse control schemes emulating the navigation of popular CAD tools.
// A scheme maps pointer-button chords (a `buttons` bitmask + exact modifier
// state) to orbit / pan / drag-zoom; the viewer re-resolves the mapping at
// every button press/release, which is what makes chorded schemes (CATIA,
// FreeCAD: middle held, then a second button) fall out naturally.
//
// Shared with meshStep (github.com/CNCKitchen/meshStep) so that both tools
// navigate identically — one muscle memory across the whole toolchain.

export type NavAction = 'orbit' | 'pan' | 'zoom'

/** Pointer `buttons` bitmask values (MouseEvent.buttons). */
export const LMB = 1
export const RMB = 2
export const MMB = 4

export interface NavBinding {
  /** Exact `buttons` bitmask this binding fires on (chords OR the bits, e.g. MMB | LMB). */
  buttons: number
  /** Modifier state is matched exactly; omitted = must not be pressed. */
  shift?: boolean
  ctrl?: boolean
  alt?: boolean
  action: NavAction
}

export interface ControlScheme {
  id: string
  label: string
  bindings: NavBinding[]
  /** Scroll up zooms OUT — the SolidWorks / Autodesk-desktop / NX default. */
  wheelZoomsOut?: boolean
  /** CATIA: while MMB is held, a quick CLICK of a second button (instead of
   *  holding it, which orbits) flips the rest of the middle-drag to zoom. */
  catiaZoomTick?: boolean
  /** Short "how to move" line shown in the status strip. */
  hint: string
}

// Button/modifier assignments verified against each tool's official docs
// (Onshape/Dassault/Autodesk help pages, Prusa knowledge base, Tinkercad
// shortcut card, Blender manual, SketchUp quick-reference card, ...).
export const SCHEMES: ControlScheme[] = [
  {
    id: 'cnckitchen',
    label: 'CNC Kitchen',
    hint: 'left-drag orbit · right-drag pan · scroll zoom',
    bindings: [
      { buttons: LMB, action: 'orbit' },
      { buttons: RMB, action: 'pan' },
    ],
  },
  {
    id: 'fusion',
    label: 'Autodesk Fusion',
    wheelZoomsOut: true,
    hint: 'Shift+middle orbit · middle pan · scroll zoom (up = out)',
    bindings: [
      { buttons: MMB, shift: true, action: 'orbit' },
      { buttons: MMB, action: 'pan' },
      { buttons: MMB, shift: true, ctrl: true, action: 'zoom' },
    ],
  },
  {
    id: 'inventor',
    label: 'Autodesk Inventor',
    wheelZoomsOut: true,
    hint: 'Shift+middle orbit · middle pan · scroll zoom (up = out)',
    bindings: [
      { buttons: MMB, shift: true, action: 'orbit' },
      { buttons: MMB, action: 'pan' },
    ],
  },
  {
    id: 'bambu',
    label: 'Bambu Studio / Orca / Prusa',
    hint: 'left-drag orbit · right-drag pan · scroll zoom',
    bindings: [
      { buttons: LMB, action: 'orbit' },
      { buttons: RMB, action: 'pan' },
      { buttons: MMB, action: 'pan' },
    ],
  },
  {
    id: 'blender',
    label: 'Blender',
    hint: 'middle orbit · Shift+middle pan · scroll zoom',
    bindings: [
      { buttons: MMB, action: 'orbit' },
      { buttons: MMB, shift: true, action: 'pan' },
      { buttons: MMB, ctrl: true, action: 'zoom' },
    ],
  },
  {
    id: 'catia',
    label: 'CATIA',
    catiaZoomTick: true,
    hint: 'middle pan · middle+hold left/right orbit · middle+click left/right then drag zoom',
    bindings: [
      { buttons: MMB, action: 'pan' },
      { buttons: MMB | LMB, action: 'orbit' },
      { buttons: MMB | RMB, action: 'orbit' },
      { buttons: MMB, ctrl: true, action: 'zoom' },
    ],
  },
  {
    id: 'freecad',
    label: 'FreeCAD',
    hint: 'middle pan · middle+left orbit · scroll zoom',
    bindings: [
      { buttons: MMB, action: 'pan' },
      { buttons: MMB | LMB, action: 'orbit' },
      { buttons: MMB | RMB, action: 'orbit' },
    ],
  },
  {
    id: 'nx',
    label: 'Siemens NX',
    wheelZoomsOut: true,
    hint: 'middle orbit · Shift+middle pan · Ctrl+middle zoom · scroll (up = out)',
    bindings: [
      { buttons: MMB, action: 'orbit' },
      { buttons: MMB, shift: true, action: 'pan' },
      { buttons: MMB | RMB, action: 'pan' },
      { buttons: MMB, ctrl: true, action: 'zoom' },
      { buttons: MMB | LMB, action: 'zoom' },
    ],
  },
  {
    id: 'onshape',
    label: 'Onshape',
    hint: 'right-drag orbit · middle pan · scroll zoom',
    bindings: [
      { buttons: RMB, action: 'orbit' },
      { buttons: MMB, action: 'pan' },
      { buttons: RMB, ctrl: true, action: 'pan' },
    ],
  },
  {
    id: 'rhino',
    label: 'Rhino',
    hint: 'right-drag orbit · Shift+right pan · Ctrl+right zoom',
    bindings: [
      { buttons: RMB, action: 'orbit' },
      { buttons: RMB, shift: true, action: 'pan' },
      { buttons: RMB, ctrl: true, action: 'zoom' },
      { buttons: MMB, action: 'pan' },
    ],
  },
  {
    id: 'sketchup',
    label: 'SketchUp',
    hint: 'middle orbit · Shift+middle pan · scroll zoom',
    bindings: [
      { buttons: MMB, action: 'orbit' },
      { buttons: MMB, shift: true, action: 'pan' },
    ],
  },
  {
    id: 'solidedge',
    label: 'Solid Edge',
    hint: 'middle orbit · Shift+middle pan · Alt+middle zoom',
    bindings: [
      { buttons: MMB, action: 'orbit' },
      { buttons: MMB, shift: true, action: 'pan' },
      { buttons: MMB, alt: true, action: 'zoom' },
    ],
  },
  {
    id: 'solidworks',
    label: 'SolidWorks',
    wheelZoomsOut: true,
    hint: 'middle orbit · Ctrl+middle pan · Shift+middle zoom · scroll (up = out)',
    bindings: [
      { buttons: MMB, action: 'orbit' },
      { buttons: MMB, ctrl: true, action: 'pan' },
      { buttons: MMB, shift: true, action: 'zoom' },
    ],
  },
  {
    id: 'tinkercad',
    label: 'Tinkercad',
    hint: 'right-drag orbit · middle pan · scroll zoom',
    bindings: [
      { buttons: RMB, action: 'orbit' },
      { buttons: LMB, ctrl: true, action: 'orbit' },
      { buttons: MMB, action: 'pan' },
      { buttons: RMB, shift: true, action: 'pan' },
    ],
  },
]

/** The scheme with this id, or the default (CNC Kitchen) if it is unknown —
 *  a stale id in localStorage must not leave the viewport unnavigable. */
export function schemeById(id: string | null | undefined): ControlScheme {
  return SCHEMES.find((s) => s.id === id) ?? SCHEMES[0]
}
