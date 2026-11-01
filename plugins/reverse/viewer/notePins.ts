// SPDX-License-Identifier: AGPL-3.0-only
// The notes for an agent on the part (core/notes.ts), as pins in the 3D
// viewport: a dot where the note was pinned and, up and to the right of it,
// a round badge with the note's number — both drawn into the canvas, so a
// picture of the view (view.render) shows them to the agent — and the note's
// text beside the badge as a label for the person. A pin is held at its size
// in pixels, on the screen and in a picture alike, drawn over the part, and
// faint where the place it marks faces away. A layer of the SceneManager
// (src/viewer/sceneLayers.ts) ahead of the sketches, the measured elements
// and the bodies: a click on a badge opens its note, and while a note is
// being placed every click on the part is the layer's, so that what is
// drawn on the part — an element, a sketch, a plane — does not take it.

import * as THREE from 'three'
import { CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js'
import type { Vec3 } from '../../../src/core/types'
import type { SceneManager } from '../../../src/viewer/SceneManager'
import type { SceneLayer, SceneLayerHost } from '../../../src/viewer/sceneLayers'

/** A note as its pin shows it. */
export interface NotePinItem {
  id: number
  at: Vec3
  normal?: Vec3
  text: string
  done: boolean
  /** The agent's question: its badge blue. */
  agent: boolean
}

/** The badge's diameter and the dot's, px. */
const BADGE_PX = 24
const DOT_PX = 8
/** The badge's lower left corner stands off the dot by this share of its
 *  size, up and to the right. */
const BADGE_OFFSET = 0.25
/** How far a click may miss a badge and still take it, px. */
const PICK_SLACK_PX = 3

const BADGE_FILL = { open: '#f2a516', agent: '#1877c0', done: '#9aa1ab' }
const BADGE_LIT = '#ffffff'

/** A badge's picture: a disc with its number, amber for the person's note,
 *  blue for the agent's question, grey once handled, ringed white while
 *  lit. Drawn at four times its size on screen and kept, one per look. */
function badgeTexture(n: number, done: boolean, lit: boolean, agent: boolean): THREE.CanvasTexture {
  const size = BADGE_PX * 4
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = size
  const g = canvas.getContext('2d')!
  const r = size / 2
  g.beginPath()
  g.arc(r, r, r - 2, 0, Math.PI * 2)
  g.fillStyle = lit ? BADGE_LIT : '#1d2026'
  g.fill()
  g.beginPath()
  g.arc(r, r, r - (lit ? 10 : 7), 0, Math.PI * 2)
  g.fillStyle = done ? BADGE_FILL.done : agent ? BADGE_FILL.agent : BADGE_FILL.open
  g.fill()
  const label = String(n)
  g.fillStyle = agent && !done ? '#ffffff' : '#1d2026'
  g.font = `700 ${label.length > 2 ? 38 : label.length > 1 ? 46 : 54}px system-ui, sans-serif`
  g.textAlign = 'center'
  g.textBaseline = 'middle'
  g.fillText(label, r, r + 3)
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  return texture
}

/** The dot: dark with a white rim, to show on a light part and a dark one. */
export function dotTexture(): THREE.CanvasTexture {
  const size = 32
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = size
  const g = canvas.getContext('2d')!
  g.beginPath()
  g.arc(size / 2, size / 2, size / 2 - 1, 0, Math.PI * 2)
  g.fillStyle = '#ffffff'
  g.fill()
  g.beginPath()
  g.arc(size / 2, size / 2, size / 2 - 7, 0, Math.PI * 2)
  g.fillStyle = '#1d2026'
  g.fill()
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  return texture
}

export const spriteMaterial = (map: THREE.Texture) => new THREE.SpriteMaterial({ map, depthTest: false, depthWrite: false, transparent: true, toneMapped: false })

const drawn = new THREE.Vector2()
const spot = new THREE.Vector3()
const look = new THREE.Vector3()

/** Hold a sprite at `px()` pixels across in whatever it is drawn into —
 *  the canvas, or a picture of the view at a size of its own, which is
 *  drawn without the viewport's frame tick — by sizing it as it is drawn,
 *  from the camera's frustum and the size of the drawing. */
export function heldAt(sprite: THREE.Sprite, px: () => number): void {
  sprite.onBeforeRender = (renderer, _scene, camera) => {
    const h = renderer.getSize(drawn).y || 1
    const ortho = camera as THREE.OrthographicCamera
    const persp = camera as THREE.PerspectiveCamera
    // What the drawing's height spans where the sprite stands: the whole
    // frustum in parallel, the frustum at the sprite's distance in perspective.
    let span: number
    if (ortho.isOrthographicCamera) span = (ortho.top - ortho.bottom) / ortho.zoom
    else if (persp.isPerspectiveCamera) {
      const far = sprite.getWorldPosition(spot).sub(persp.position).dot(persp.getWorldDirection(look))
      span = 2 * Math.max(far, persp.near) * Math.tan(THREE.MathUtils.degToRad(persp.fov / 2))
    } else return
    sprite.scale.setScalar((px() * span) / h)
    sprite.updateMatrixWorld()
  }
}

interface Pin {
  item: NotePinItem
  badge: THREE.Sprite
  dot: THREE.Sprite
  label: CSS2DObject
  /** What the badge's picture was drawn for. */
  look: string
  lit: boolean
}

/** A badge's size on the screen, px — a little larger lit. */
const badgePx = (pin: Pin) => BADGE_PX * (pin.lit ? 1.15 : 1)

export class NotePins {
  private host: SceneLayerHost
  private group = new THREE.Group()
  private pins = new Map<number, Pin>()
  private dot = dotTexture()
  private lit: number | null = null
  private hovered: number | null = null
  private interactive = true
  private placing = false
  /** Whether the notes are in play (setPins), and whether a picture has
   *  put their pins away (setPutAway): shown when the one and not the
   *  other. */
  private inPlay = true
  private putAway = false
  private removeLayer: () => void

  /** A click on a badge: the note's id and where the click was. */
  onPinClick: ((id: number, clientX: number, clientY: number) => void) | null = null
  /** A click anywhere else while a note is being placed — see setPlacing. */
  onPlaceClick: ((clientX: number, clientY: number) => void) | null = null

  constructor(scene: SceneManager) {
    this.host = scene.layerHost()
    this.group.name = 'note-pins'
    this.host.partGroup.add(this.group)
    this.removeLayer = scene.addLayer(this.layer())
  }

  private layer(): SceneLayer {
    return {
      // Ahead of the sketches (20) and the bodies: a badge is drawn over
      // everything, so it takes the click where it is.
      order: 16,
      covers: true,
      click: (x, y) => {
        const id = this.interactive && this.group.visible ? this.pinAt(x, y) : null
        if (id !== null) this.onPinClick?.(id, x, y)
        else if (this.placing) this.onPlaceClick?.(x, y)
        return id !== null || this.placing
      },
      hover: (at, covered) => {
        const id = at && !covered && this.interactive && this.group.visible ? this.pinAt(at.x, at.y) : null
        if (id !== this.hovered) {
          this.hovered = id
          this.host.setCursor(id !== null ? 'pointer' : '')
          this.dress()
        }
        return id !== null
      },
      tick: () => this.fade(),
      dispose: () => {
        for (const [id, pin] of [...this.pins]) this.drop(pin, id)
        this.host.partGroup.remove(this.group)
        this.dot.dispose()
      },
    }
  }

  /** The pins for the notes; `shown` false puts them all away. */
  setPins(items: readonly NotePinItem[], shown: boolean): void {
    this.inPlay = shown
    this.group.visible = shown && !this.putAway
    const keep = new Set(items.map((i) => i.id))
    for (const [id, pin] of this.pins) if (!keep.has(id)) this.drop(pin, id)
    for (const item of items) {
      let pin = this.pins.get(item.id)
      if (!pin) {
        const badge = new THREE.Sprite(spriteMaterial(this.dot))
        badge.center.set(-BADGE_OFFSET, -BADGE_OFFSET)
        badge.renderOrder = 11
        const dot = new THREE.Sprite(spriteMaterial(this.dot))
        dot.renderOrder = 10
        const el = document.createElement('div')
        el.className = 'note-label'
        el.dataset.test = 'note-label'
        const label = new CSS2DObject(el)
        label.center.set(0, 0.5)
        this.group.add(dot, badge, label)
        const made: Pin = { item, badge, dot, label, look: '', lit: false }
        heldAt(badge, () => badgePx(made))
        heldAt(dot, () => DOT_PX)
        pin = made
        this.pins.set(item.id, pin)
      }
      pin.item = item
      for (const o of [pin.badge, pin.dot, pin.label]) o.position.set(item.at[0], item.at[1], item.at[2])
      const el = pin.label.element
      el.textContent = item.text
      el.title = item.text
      el.classList.toggle('done', item.done)
      el.classList.toggle('agent', item.agent)
    }
    this.dress()
    this.fade()
    this.host.requestHover()
    this.host.invalidate()
  }

  /** Put every pin away, or bring them back — a picture's show: { notes:
   *  false }, for a picture to hand over without them; the notes stay. */
  setPutAway(away: boolean): void {
    if (this.putAway === away) return
    this.putAway = away
    this.group.visible = this.inPlay && !away
    this.host.requestHover()
    this.host.invalidate()
  }

  /** Whether the pins are put away. */
  isPutAway(): boolean {
    return this.putAway
  }

  /** Light a note's pin — the one being written — or none. */
  setLit(id: number | null): void {
    if (this.lit === id) return
    this.lit = id
    this.dress()
    this.host.invalidate()
  }

  /** Whether every click on the part is the note being placed. */
  setPlacing(on: boolean): void {
    this.placing = on
  }

  /** Whether a badge takes a click — not while a feature is being set up,
   *  whose picks are on the part under it, nor in another workspace than
   *  the one the notes are written in. */
  setInteractive(on: boolean): void {
    if (this.interactive === on) return
    this.interactive = on
    if (!on && this.hovered !== null) {
      this.hovered = null
      this.dress()
    }
    this.host.requestHover()
  }

  /** The badges drawn for their notes, lit as their notes are lit. */
  private dress(): void {
    for (const [id, pin] of this.pins) {
      const lit = id === this.lit || id === this.hovered
      pin.lit = lit
      const look = `${pin.item.done}:${lit}:${pin.item.agent}`
      if (look !== pin.look) {
        const material = pin.badge.material
        if (material.map !== this.dot) material.map?.dispose()
        material.map = badgeTexture(id, pin.item.done, lit, pin.item.agent)
        material.needsUpdate = true
        pin.look = look
      }
      pin.label.element.classList.toggle('lit', lit)
    }
    this.host.invalidate()
  }

  /** Every pin faint where the place it marks faces away from the
   *  camera. */
  private fade(): void {
    const view = this.host.camera().getWorldDirection(new THREE.Vector3())
    const turn = new THREE.Matrix3().setFromMatrix4(this.host.partGroup.matrixWorld)
    const n = new THREE.Vector3()
    let changed = false
    for (const pin of this.pins.values()) {
      const away = pin.item.normal ? n.set(...pin.item.normal).applyMatrix3(turn).dot(view) > 0.05 : false
      const opacity = away ? 0.45 : 1
      if (pin.badge.material.opacity !== opacity) {
        pin.badge.material.opacity = pin.dot.material.opacity = opacity
        pin.label.element.classList.toggle('away', away)
        changed = true
      }
    }
    if (changed) this.host.invalidate()
  }

  /** A pin's badge centre on the screen, in client pixels. */
  private badgeCentre(pin: Pin): { x: number; y: number } {
    const p = pin.badge.getWorldPosition(new THREE.Vector3()).project(this.host.camera())
    const r = this.host.canvas.getBoundingClientRect()
    const off = (BADGE_OFFSET + 0.5) * badgePx(pin)
    return { x: r.left + ((p.x + 1) / 2) * r.width + off, y: r.top + ((1 - p.y) / 2) * r.height - off }
  }

  /** The note whose badge is under a client point — the one drawn last,
   *  on top, where two overlap. */
  private pinAt(clientX: number, clientY: number): number | null {
    let found: number | null = null
    for (const [id, pin] of this.pins) {
      const c = this.badgeCentre(pin)
      if (Math.hypot(clientX - c.x, clientY - c.y) <= badgePx(pin) / 2 + PICK_SLACK_PX) found = id
    }
    return found
  }

  private drop(pin: Pin, id: number): void {
    this.group.remove(pin.badge, pin.dot, pin.label)
    if (pin.badge.material.map !== this.dot) pin.badge.material.map?.dispose()
    pin.badge.material.dispose()
    pin.dot.material.dispose()
    this.pins.delete(id)
    if (this.hovered === id) this.hovered = null
  }

  /** Take the pins out of the viewport. */
  dispose(): void {
    this.removeLayer()
  }
}

const pinsOf = new WeakMap<SceneManager, NotePins>()

/** The note pins of a viewport — made on first use, one per viewport. */
export function notePinsOf(scene: SceneManager): NotePins {
  let pins = pinsOf.get(scene)
  if (!pins) {
    pins = new NotePins(scene)
    pinsOf.set(scene, pins)
  }
  return pins
}
