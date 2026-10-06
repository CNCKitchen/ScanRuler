// SPDX-License-Identifier: AGPL-3.0-only
// A 3Dconnexion SpaceMouse, read through the Gamepad API: no driver bridge and
// no permission prompt, only the device's own driver. Ported from BumpMesh
// (github.com/CNCKitchen/stlTexturizer), same axes, deadzone and device
// match, so the puck flies both tools alike. What the motion does to a camera
// is the navigator's business (OrthoNavigator.stepSpaceMouse); this file finds
// the device, reads it, and decides which viewport it is driving.
//
// One puck and several viewports: the main view, the reference half of the
// split view, the two halves of the point picker, the 2D sheet and the sheet
// laid over the 3D view. Each runs its own frame loop, and if each read the
// puck they would all move at once, and a linked pair would be pushed twice.
// So the puck drives one at a time. That is the viewport the mouse was last
// over, the way a hand on the mouse would pick it. Until the mouse has been
// over one, it is the viewport that opened last, which is the one about to be
// worked in. A viewport that is paused, hidden or closed lets go, and the next
// one in view that asks takes it.
//
// Nothing is read until the browser reports a matching device, which it only
// does once the puck or a button has been touched on this page. For everyone
// without one the frame loop costs a single comparison.

/** One frame of puck motion. Each axis is in [-1, 1], 0 inside the deadzone. */
export interface SpaceMouseMotion {
  /** Seconds since the previous frame, capped so a stalled tab cannot fling the view. */
  dt: number
  /** Pan along the screen's horizontal. */
  tx: number
  /** Push forward (positive) or pull back: zoom. */
  ty: number
  /** Pan along the screen's vertical. */
  tz: number
  /** Tilt: turn about the screen's horizontal. */
  rx: number
  /** Twist: turn about the screen's vertical. Roll (axis 4) is not read. */
  rz: number
}

const DEADZONE = 0.08

/** Chrome and Edge name the device in the id, or give its USB ids:
 *  3Dconnexion's own vendor id, and Logitech's for the older pucks sold
 *  under that name. */
const SPACE_MOUSE_ID =
  /3dconnexion|spacemouse|space ?navigator|space ?pilot|space ?explorer|vendor: (256f|046d) product: c6/i

export function isSpaceMouse(id: string): boolean {
  return SPACE_MOUSE_ID.test(id)
}

/** Remap |v| in [deadzone, 1] to [0, 1], so motion starts smoothly instead of
 *  jumping in at the deadzone's edge. */
export function spaceMouseAxis(v = 0): number {
  const a = Math.abs(v)
  return a < DEADZONE ? 0 : Math.sign(v) * Math.min(1, (a - DEADZONE) / (1 - DEADZONE))
}

/** The getGamepads() slot of the attached puck, -1 for none. */
let index = -1
let listening = false
/** performance.now() of the last frame with puck motion. */
let lastActive = -Infinity
/** performance.now() of the previous read, whichever viewport made it. */
let lastRead = 0
/** The viewport the puck is driving, null until one claims it. */
let driver: object | null = null

/** Start watching for a puck. Called by every viewport; only the first call
 *  does anything. */
export function listenForSpaceMouse(): void {
  if (listening || typeof window === 'undefined' || !('getGamepads' in navigator)) return
  listening = true
  const attach = (gp: Gamepad | null): void => {
    if (index !== -1 || !gp?.connected || !isSpaceMouse(gp.id)) return
    index = gp.index
    lastRead = performance.now()
    console.info(`SpaceMouse connected: ${gp.id}`)
  }
  window.addEventListener('gamepadconnected', (e) => attach(e.gamepad))
  // One that this page has already been shown, from before this ran.
  for (const gp of navigator.getGamepads()) attach(gp)
  window.addEventListener('gamepaddisconnected', (e) => {
    if (e.gamepad.index !== index) return
    index = -1
    // A second puck already on this page takes over.
    for (const gp of navigator.getGamepads()) attach(gp)
  })
}

/** Whether a puck is attached: the frame loop's one check. */
export function spaceMouseAttached(): boolean {
  return index !== -1
}

/** Point the puck at this viewport: the mouse is over it, or it has just
 *  opened. */
export function aimSpaceMouse(owner: object): void {
  driver = owner
}

/** This viewport is closing or pausing: if it has the puck, it lets go. */
export function releaseSpaceMouse(owner: object): void {
  if (driver === owner) driver = null
}

/**
 * This frame's puck motion for `owner`, or null when the puck is at rest or is
 * driving another viewport. `showing` is whether the owner is in view. One that
 * is not lets go of the puck, so that a view hidden behind another workspace
 * cannot keep it.
 */
export function readSpaceMouse(owner: object, showing: boolean): SpaceMouseMotion | null {
  if (!showing) {
    releaseSpaceMouse(owner)
    return null
  }
  driver ??= owner
  if (driver !== owner) return null
  const now = performance.now()
  const dt = Math.min((now - lastRead) / 1000, 0.1)
  lastRead = now
  const gp = navigator.getGamepads()[index]
  if (!gp?.connected || dt <= 0) return null
  const ax = gp.axes
  const m: SpaceMouseMotion = {
    dt,
    tx: spaceMouseAxis(ax[0]),
    ty: spaceMouseAxis(ax[1]),
    tz: spaceMouseAxis(ax[2]),
    rx: spaceMouseAxis(ax[3]),
    rz: spaceMouseAxis(ax[5]),
  }
  if (!m.tx && !m.ty && !m.tz && !m.rx && !m.rz) return null
  lastActive = now
  return m
}

/** Whether the puck moved in the last 100 ms. The 3Dconnexion driver can
 *  emulate wheel events while the puck is pushed, and a zoom towards the idle
 *  cursor on top of the puck's own makes the view jump, so the wheel is
 *  ignored meanwhile. Never true without a puck. */
export function spaceMouseBusy(): boolean {
  return performance.now() - lastActive < 100
}
