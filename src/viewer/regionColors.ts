// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The vertex-colour compositor: who owns each vertex of the scan, and what
 * colour that leaves it.
 *
 * Pure bookkeeping over typed arrays — no three.js, no GPU. The layers, from
 * the bottom up: bare scan, element tints (owned regions, minus the hidden
 * ones), a measured field map when one is showing, the preview region of a
 * pending auto-fit, and the hand-painted marking on top of everything. The
 * caller owns the actual colour buffer (it is the mesh's colour attribute) and
 * is responsible for flagging it dirty after any call that touched it — every
 * mutator returns whether it did.
 */

export type Rgb = readonly [number, number, number]

export class RegionColors {
  /** The mesh's own colour buffer, three bytes per vertex — written in place. */
  private colors: Uint8Array | null = null
  private owner: Int32Array | null = null
  /** Colour each element paints its region with, so a preview can be lifted
   *  off again without repainting the whole mesh. */
  private elementColors = new Map<number, Rgb>()
  /** Elements whose surface tint is switched off. Ownership stays recorded,
   *  so showing one again is a repaint, not a re-fit. */
  private hiddenRegions = new Set<number>()
  /** When set, the scan wears the deviation map and element painting is held
   *  in reserve — the owner/colour bookkeeping stays live underneath, so
   *  switching back restores the measured elements without re-fitting. */
  private fieldColors: Uint8Array | null = null
  private previewRegion: Uint32Array | null = null
  private previewRgb: Rgb = [255, 255, 255]
  /** Hand-painted surface selection: one byte per vertex, vertex indices like
   *  everything else the fitter speaks. */
  private paintMask: Uint8Array | null = null
  private count = 0
  private paintRgb: Rgb = [0, 0, 0]

  constructor(private baseColor: Rgb) {}

  /** Whether a scan's buffers are attached — mirrors the life of the mesh. */
  get ready(): boolean {
    return this.owner !== null
  }

  /** How many vertices the marking currently covers. */
  get paintCount(): number {
    return this.count
  }

  /** Adopt a new scan's colour buffer. Ownership, tints and marking all start
   *  empty — nothing measured on the old scan means anything on this one. */
  attach(colors: Uint8Array): void {
    const vertexCount = colors.length / 3
    this.colors = colors
    this.owner = new Int32Array(vertexCount)
    this.elementColors.clear()
    this.hiddenRegions.clear()
    this.fieldColors = null
    this.previewRegion = null
    this.paintMask = new Uint8Array(vertexCount)
    this.count = 0
  }

  /** Drop everything with the mesh it belonged to. */
  detach(): void {
    this.colors = null
    this.owner = null
    this.elementColors.clear()
    this.hiddenRegions.clear()
    this.fieldColors = null
    this.previewRegion = null
    this.paintMask = null
    this.count = 0
  }

  /** What a vertex should be coloured when nothing is marked on it: the
   *  measured map where one is showing — marking surface for a fine fit is
   *  done on top of the deviation map, and rubbing it out has to give the
   *  reading back — otherwise its element's tint, otherwise bare scan. */
  baseColorOf(v: number): Rgb {
    const field = this.fieldColors
    if (field) return [field[v * 3], field[v * 3 + 1], field[v * 3 + 2]]
    const id = this.owner ? this.owner[v] : 0
    if (id > 0 && !this.hiddenRegions.has(id))
      return this.elementColors.get(id) ?? this.baseColor
    return this.baseColor
  }

  /** Give an element its region, tinted in its colour. Replaces whatever the
   *  element owned before. Returns whether the colour buffer changed. */
  applyRegion(elementId: number, rgb: Rgb, region: Uint32Array): boolean {
    if (!this.colors || !this.owner) return false
    const cleared = this.clearElement(elementId)
    this.elementColors.set(elementId, rgb)
    for (let i = 0; i < region.length; i++) this.owner[region[i]] = elementId
    // While a deviation map is on the surface it owns every vertex colour; the
    // ownership recorded above is enough to repaint on the way back. The same
    // goes for an element that is currently hidden.
    if (this.fieldColors || this.hiddenRegions.has(elementId)) return cleared
    const arr = this.colors
    for (let i = 0; i < region.length; i++) {
      const v = region[i]
      arr[v * 3] = rgb[0]
      arr[v * 3 + 1] = rgb[1]
      arr[v * 3 + 2] = rgb[2]
    }
    this.paintOverlays()
    return true
  }

  /** Take an element's region away and hand the surface back to bare scan. */
  clearElement(elementId: number): boolean {
    if (!this.colors || !this.owner) return false
    this.elementColors.delete(elementId)
    this.hiddenRegions.delete(elementId)
    const arr = this.colors
    const paint = this.fieldColors === null
    for (let v = 0; v < this.owner.length; v++) {
      if (this.owner[v] !== elementId) continue
      this.owner[v] = 0
      if (!paint) continue
      arr[v * 3] = this.baseColor[0]
      arr[v * 3 + 1] = this.baseColor[1]
      arr[v * 3 + 2] = this.baseColor[2]
    }
    if (!paint) return false
    this.paintOverlays()
    return true
  }

  clearAllRegions(): boolean {
    if (!this.colors || !this.owner) return false
    this.owner.fill(0)
    this.elementColors.clear()
    this.hiddenRegions.clear()
    this.previewRegion = null
    if (this.fieldColors) return false
    const arr = this.colors
    for (let v = 0; v < this.owner.length; v++) {
      arr[v * 3] = this.baseColor[0]
      arr[v * 3 + 1] = this.baseColor[1]
      arr[v * 3 + 2] = this.baseColor[2]
    }
    return true
  }

  /** Tint the surfaces a pending fit is using, in the colour the element will
   *  get once it is created. Unlike applyRegion this takes no ownership, so
   *  lifting the preview restores whatever was underneath. */
  setPreviewRegion(region: Uint32Array | null, rgb?: Rgb): boolean {
    if (!this.colors || !this.owner || this.fieldColors) return false
    if (rgb) this.previewRgb = rgb
    const arr = this.colors
    if (this.previewRegion) {
      for (let i = 0; i < this.previewRegion.length; i++) {
        const v = this.previewRegion[i]
        const c = this.baseColorOf(v)
        arr[v * 3] = c[0]
        arr[v * 3 + 1] = c[1]
        arr[v * 3 + 2] = c[2]
      }
    }
    this.previewRegion = region
    this.paintOverlays()
    return true
  }

  /** Paint the scan from a measured map — deviation, wall thickness — or pass
   *  null to hand the surface back to the element colours. Returns whether the
   *  colour buffer was there to paint. */
  setFieldColors(field: Uint8Array | null): boolean {
    this.fieldColors = field
    if (!this.colors) return false
    if (field && field.length === this.colors.length) {
      this.colors.set(field)
      // The marking sits above the map: re-scaling the colours must not rub
      // out the surface a fine fit is about to be run on.
      this.applyPaint()
    } else this.repaintFromElements()
    return true
  }

  /** Switch the surface tint of the given elements off (and everyone else's
   *  back on). Cheap enough to run on every visibility toggle. Returns whether
   *  the colour buffer changed — false includes "recorded, but a map owns the
   *  surface right now". */
  setHiddenRegions(ids: readonly number[]): boolean {
    const next = new Set(ids)
    if (next.size === this.hiddenRegions.size && ids.every((id) => this.hiddenRegions.has(id)))
      return false
    this.hiddenRegions = next
    if (!this.colors || this.fieldColors) return false
    this.repaintFromElements()
    return true
  }

  /** Rebuild every vertex's colour from the ownership records, then put the
   *  overlays back on top. */
  repaintFromElements(): void {
    if (!this.colors || !this.owner) return
    const arr = this.colors
    for (let v = 0; v < this.owner.length; v++) {
      const id = this.owner[v]
      const c = (!this.hiddenRegions.has(id) && this.elementColors.get(id)) || this.baseColor
      arr[v * 3] = c[0]
      arr[v * 3 + 1] = c[1]
      arr[v * 3 + 2] = c[2]
    }
    this.paintOverlays()
  }

  /** The element a vertex belongs to as far as picking is concerned: hidden
   *  elements and stale owners without a colour do not count. */
  visibleOwnerAt(v: number): number | null {
    const id = this.owner ? this.owner[v] : 0
    return id > 0 && !this.hiddenRegions.has(id) && this.elementColors.has(id) ? id : null
  }

  /** The two layers that sit above the element tints: the preview region of a
   *  pending auto-fit, and the surface marked by hand for one. */
  private paintOverlays(): void {
    const arr = this.colors
    if (!arr) return
    if (this.previewRegion) {
      for (let i = 0; i < this.previewRegion.length; i++) {
        const v = this.previewRegion[i]
        arr[v * 3] = this.previewRgb[0]
        arr[v * 3 + 1] = this.previewRgb[1]
        arr[v * 3 + 2] = this.previewRgb[2]
      }
    }
    this.applyPaint()
  }

  /** Re-lay the marking's tint over whatever was just painted under it. */
  applyPaint(): void {
    const mask = this.paintMask
    const arr = this.colors
    if (!mask || !arr || this.count === 0) return
    for (let v = 0; v < mask.length; v++) {
      if (!mask[v]) continue
      arr[v * 3] = this.paintRgb[0]
      arr[v * 3 + 1] = this.paintRgb[1]
      arr[v * 3 + 2] = this.paintRgb[2]
    }
  }

  // ---- the marking layer ---------------------------------------------------

  /** The colour the marking is laid down in. Returns whether it changed, so
   *  the brush can tell a recolour from a repeat. */
  setPaintColor(rgb: Rgb): boolean {
    const changed = rgb.some((c, i) => c !== this.paintRgb[i])
    this.paintRgb = rgb
    return changed
  }

  /** Make sure a mask exists for the attached scan — the brush can be armed
   *  before any stroke lands. */
  ensurePaintMask(): void {
    if (this.colors && !this.paintMask) {
      this.paintMask = new Uint8Array(this.colors.length / 3)
      this.count = 0
    }
  }

  /** Lay the marking on one vertex, or take it off, and put the right colour
   *  under it either way. The single place the mask and the count move
   *  together — every gesture goes through here. */
  markVertex(v: number, erase: boolean): void {
    const mask = this.paintMask
    const arr = this.colors
    if (!mask || !arr || mask[v] === (erase ? 0 : 1)) return
    mask[v] = erase ? 0 : 1
    this.count += erase ? -1 : 1
    const c = erase ? this.baseColorOf(v) : this.paintRgb
    const j = v * 3
    arr[j] = c[0]
    arr[j + 1] = c[1]
    arr[j + 2] = c[2]
  }

  /** The vertices marked so far, as the fitter wants them. */
  paintedVertices(): Uint32Array {
    const mask = this.paintMask
    if (!mask || this.count === 0) return new Uint32Array(0)
    const out = new Uint32Array(this.count)
    let w = 0
    for (let v = 0; v < mask.length && w < out.length; v++) if (mask[v]) out[w++] = v
    return w === out.length ? out : out.slice(0, w)
  }

  /** Put a marking back on the part wholesale — the surface an element was
   *  measured on, when that element is re-opened for editing. */
  setPaintedVertices(vertices: Uint32Array): boolean {
    if (!this.colors) return false
    const vertexCount = this.colors.length / 3
    if (!this.paintMask || this.paintMask.length !== vertexCount)
      this.paintMask = new Uint8Array(vertexCount)
    else this.paintMask.fill(0)
    let marked = 0
    for (let i = 0; i < vertices.length; i++) {
      const v = vertices[i]
      if (v >= vertexCount || this.paintMask[v]) continue
      this.paintMask[v] = 1
      marked++
    }
    this.count = marked
    this.applyPaint()
    return true
  }

  /** Rub out the whole marking and hand the surface back to whatever was
   *  underneath it. Returns whether the colour buffer changed. */
  clearPaint(): boolean {
    if (!this.paintMask || this.count === 0) {
      this.count = 0
      this.paintMask?.fill(0)
      return false
    }
    const mask = this.paintMask
    const arr = this.colors
    for (let v = 0; v < mask.length; v++) {
      if (!mask[v]) continue
      mask[v] = 0
      if (!arr) continue
      const c = this.baseColorOf(v)
      arr[v * 3] = c[0]
      arr[v * 3 + 1] = c[1]
      arr[v * 3 + 2] = c[2]
    }
    this.count = 0
    return true
  }
}
