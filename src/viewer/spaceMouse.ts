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
// Only the focused, visible page reads motion; other app windows and CAD
// applications must not move this page's camera in the background.
//
// Nothing is read until the browser reports a matching device, which it only
// does once the puck or a button has been touched on this page. For everyone
// without one the frame loop costs a single comparison.
//
// The browser hands over the device's raw axes, in the puck's own frame: x to
// the right, y towards the operator, z down; the turns about those three by
// the right hand. The 3Dconnexion driver's own settings (speed, reversed axes)
// never reach it, so the settings dialog has its own — see SpaceMouseTuning.
// Read as they come, the axes fly the camera; the puck moves the part, so a
// turn or slide of the cap is the camera's going the other way, and the
// operator's hand the part's. That is the 3Dconnexion default, and the one
// the reports from real pucks (issue #10) asked for.

/** One frame of puck motion, as the camera is to move. Each axis is in
 *  [-speed, speed] (see SpaceMouseTuning), 0 inside the deadzone. */
export interface SpaceMouseMotion {
  /** Seconds since the previous frame, capped so a stalled tab cannot fling the view. */
  dt: number
  /** Pan the camera along the screen's horizontal, positive to the right. */
  tx: number
  /** Zoom, positive in: the cap pulled towards the operator, the part with it. */
  ty: number
  /** Pan the camera along the screen's vertical, positive up. */
  tz: number
  /** Tilt: turn about the screen's horizontal. */
  rx: number
  /** Roll: turn about the line of sight. */
  ry: number
  /** Twist: turn about the screen's vertical. */
  rz: number
}

/** The six axes, in the order the browser reports them. */
export const SPACE_MOUSE_AXES = ['tx', 'ty', 'tz', 'rx', 'ry', 'rz'] as const
export type SpaceMouseAxisId = (typeof SPACE_MOUSE_AXES)[number]

/** What the operator has set: the driver's settings, which the browser never
 *  sees. */
export interface SpaceMouseTuning {
  /** Times the default speed, on every axis. */
  speed: number
  /** Axes that move the other way from the default. */
  reversed: readonly SpaceMouseAxisId[]
}

export const SPACE_MOUSE_SPEED_MIN = 0.25
export const SPACE_MOUSE_SPEED_MAX = 2
export const SPACE_MOUSE_SPEED_STEP = 0.05

/** A speed as typed or stored, or 1 when it is not one. */
export function spaceMouseSpeedOf(value: unknown): number {
  const n = Number(value)
  if (value === null || value === '' || !Number.isFinite(n)) return 1
  return Math.min(SPACE_MOUSE_SPEED_MAX, Math.max(SPACE_MOUSE_SPEED_MIN, n))
}

/** Reversed axes as stored, a comma-separated list; anything else dropped. */
export function spaceMouseReverseOf(value: string | null): SpaceMouseAxisId[] {
  const named = new Set((value ?? '').split(','))
  return SPACE_MOUSE_AXES.filter((a) => named.has(a))
}

/** How each raw axis reaches the camera: which slot, and which way. */
const RAW: Record<SpaceMouseAxisId, { at: number; sign: number }> = {
  tx: { at: 0, sign: -1 },
  ty: { at: 1, sign: 1 },
  tz: { at: 2, sign: 1 },
  rx: { at: 3, sign: -1 },
  ry: { at: 4, sign: 1 },
  rz: { at: 5, sign: 1 },
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
/** Each axis's factor, speed and direction together. */
let gain: Record<SpaceMouseAxisId, number> = { tx: -1, ty: 1, tz: 1, rx: -1, ry: 1, rz: 1 }
/** Told when a puck attaches or goes. */
const watchers = new Set<() => void>()

/** Apply the operator's speed and reversed axes. */
export function tuneSpaceMouse(t: SpaceMouseTuning): void {
  const g = { ...gain }
  for (const a of SPACE_MOUSE_AXES) g[a] = RAW[a].sign * t.speed * (t.reversed.includes(a) ? -1 : 1)
  gain = g
}

/** Be told whenever a puck attaches or goes; returns the unsubscribe. */
export function watchSpaceMouse(fn: () => void): () => void {
  watchers.add(fn)
  return () => watchers.delete(fn)
}

/** The attached puck's name as the browser gives it, null for none. */
let attachedId: string | null = null
export function spaceMouseName(): string | null {
  return attachedId
}

const changed = (): void => {
  for (const fn of watchers) fn()
}

const resetMotionClock = (): void => {
  lastRead = performance.now()
  lastActive = -Infinity
}

const pageActive = (): boolean => document.visibilityState === 'visible' && document.hasFocus()

/** Start watching for a puck. Called by every viewport; only the first call
 *  does anything. */
export function listenForSpaceMouse(): void {
  if (listening || typeof window === 'undefined' || !('getGamepads' in navigator)) return
  listening = true
  window.addEventListener('blur', resetMotionClock)
  window.addEventListener('focus', resetMotionClock)
  document.addEventListener('visibilitychange', resetMotionClock)
  const attach = (gp: Gamepad | null): void => {
    if (index !== -1 || !gp?.connected || !isSpaceMouse(gp.id)) return
    index = gp.index
    attachedId = gp.id
    lastRead = performance.now()
    console.info(`SpaceMouse connected: ${gp.id}`)
    changed()
  }
  window.addEventListener('gamepadconnected', (e) => attach(e.gamepad))
  // One that this page has already been shown, from before this ran.
  for (const gp of navigator.getGamepads()) attach(gp)
  window.addEventListener('gamepaddisconnected', (e) => {
    if (e.gamepad.index !== index) return
    index = -1
    attachedId = null
    // A second puck already on this page takes over.
    for (const gp of navigator.getGamepads()) attach(gp)
    if (index === -1) changed()
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
  if (!pageActive()) {
    resetMotionClock()
    return null
  }
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
  const read = (a: SpaceMouseAxisId): number => spaceMouseAxis(ax[RAW[a].at]) * gain[a] || 0
  const m: SpaceMouseMotion = {
    dt,
    tx: read('tx'),
    ty: read('ty'),
    tz: read('tz'),
    rx: read('rx'),
    ry: read('ry'),
    rz: read('rz'),
  }
  if (!m.tx && !m.ty && !m.tz && !m.rx && !m.ry && !m.rz) return null
  lastActive = now
  return m
}

/** Whether the puck moved in the last 100 ms. The 3Dconnexion driver can
 *  emulate wheel events while the puck is pushed, and a zoom towards the idle
 *  cursor on top of the puck's own makes the view jump, so the wheel is
 *  ignored meanwhile. Never true without a puck. */
export function spaceMouseBusy(): boolean {
  return pageActive() && performance.now() - lastActive < 100
}
