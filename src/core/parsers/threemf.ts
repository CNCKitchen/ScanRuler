// SPDX-License-Identifier: AGPL-3.0-only
// 3MF, read as far as a scan needs it. A 3MF is a zip: a model in XML names
// its objects — a mesh of vertices and triangles, or components, each
// another object put in place by a transform — and its build puts objects
// in place in turn. The model says what unit its numbers are in, so the
// part comes in millimetres without the question an STL needs.
//
// What is read:
//  - the root model (named by _rels/.rels) and the models its components
//    and build items name by path (the production extension — Bambu Studio
//    and Orca keep every object in a file of its own under 3D/Objects/);
//  - every build item, its objects and components put in place, as one
//    mesh — the way an STL of several shells opens;
//  - colour, from colour groups, base materials' display colours and
//    textures (the materials extension), as a colour per vertex: the
//    vertex takes its first triangle's corner. A texture's image is decoded
//    on the main thread and comes in with the rest of a textured scan's
//    files (see objTexture);
//  - in a slicer's project, what the slicer marks as other than the part —
//    modifiers, support blockers and enforcers, negative volumes — left out,
//    as are objects the model itself types as support.
//
// Worker code has no DOMParser, so the XML is read by a small scanner of
// its own: tags and attributes, namespace prefixes dropped, which is all a
// 3MF model holds.

import { unzipSync, strFromU8 } from 'fflate'
import { checkTextSize } from './text'
import { ArchiveLimitError, limitedArchiveFilter, THREE_MF_LIMITS, type ArchiveLimits } from './archiveLimits'
import type { ParsedMesh } from '../types'
import { baseName, sampleTexture, type ObjCompanions, type TextureImage } from './objTexture'

/** What one millimetre is in each unit a 3MF may be in — what its
 *  coordinates are multiplied by. */
const MM_PER_UNIT: Record<string, number> = {
  micron: 0.001,
  millimeter: 1,
  centimeter: 10,
  inch: 25.4,
  foot: 304.8,
  meter: 1000,
}

/** The colour of a vertex no coloured corner reaches. */
const UNCOLOURED = 180

/** An affine transform as 3MF writes it: m00 m01 m02 m10 m11 m12 m20 m21
 *  m22 m30 m31 m32, row vectors — x' = x·m00 + y·m10 + z·m20 + m30. */
type Matrix = Float64Array

const IDENTITY: Matrix = Float64Array.of(1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0)

function parseMatrix(text: string | undefined): Matrix {
  if (!text) return IDENTITY
  const m = text.trim().split(/\s+/).map(Number)
  if (m.length !== 12 || !m.every(Number.isFinite)) throw new Error('Invalid 3MF transform.')
  return Float64Array.from(m)
}

/** `a` then `b`. */
function compose(a: Matrix, b: Matrix): Matrix {
  const out = new Float64Array(12)
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 3; c++) {
      out[r * 3 + c] = a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c] + (r === 3 ? b[9 + c] : 0)
    }
  }
  return out
}

const determinant = (m: Matrix) =>
  m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6]) + m[2] * (m[3] * m[7] - m[4] * m[6])

/** A property group: what a triangle's p1/p2/p3 index into. */
type Group =
  | { kind: 'colors'; rgb: number[] }
  | { kind: 'texture'; texture: string; uv: number[] }

interface MeshObject {
  vertices: number[]
  /** v1 v2 v3 of each triangle. */
  triangles: number[]
  /** Per triangle: its property group's id, null for none, and its three
   *  corners' indices into the group. */
  pid: (string | null)[]
  p: number[]
}

interface ModelObject {
  id: string
  type: string
  pid?: string
  pindex?: number
  mesh?: MeshObject
  components: { objectid: string; path?: string; transform: Matrix }[]
}

interface ModelFile {
  scale: number
  objects: Map<string, ModelObject>
  groups: Map<string, Group>
  /** Texture resources: id → the image's path in the package. */
  textures: Map<string, string>
  build: { objectid: string; path?: string; transform: Matrix }[]
}

/** A package path the way every reference is matched: no leading slash,
 *  lower case (package part names are not case-sensitive). */
const partName = (path: string) => path.replace(/^\/+/, '').toLowerCase()

/** The XML's five named entities and numeric ones. */
const unescapeXml = (s: string) =>
  s.indexOf('&') < 0
    ? s
    : s.replace(/&(#x[0-9a-f]+|#\d+|lt|gt|amp|quot|apos);/gi, (_, e: string) => {
        const k = e.toLowerCase()
        if (k[0] === '#') return String.fromCodePoint(k[1] === 'x' ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10))
        return ({ lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" } as Record<string, string>)[k]
      })

const localName = (name: string) => {
  const colon = name.indexOf(':')
  return colon < 0 ? name : name.slice(colon + 1)
}

/**
 * Every element of `text` in order: `open` with its local name and its
 * attributes (by local name, values unescaped; the map is reused from one
 * call to the next) and whether it closes itself, `close` at its end tag.
 * Comments, processing instructions and declarations are passed over.
 */
function scanXml(
  text: string,
  open: (name: string, attrs: Map<string, string>, selfClosing: boolean) => void,
  close: (name: string) => void,
): void {
  const attrs = new Map<string, string>()
  let at = text.indexOf('<')
  while (at >= 0 && at < text.length) {
    const next = text.charCodeAt(at + 1)
    if (next === 33 /* ! */) {
      const end = text.startsWith('<!--', at) ? text.indexOf('-->', at + 4) : text.startsWith('<![CDATA[', at) ? text.indexOf(']]>', at) : text.indexOf('>', at)
      if (end < 0) return
      at = text.indexOf('<', end + 1)
      continue
    }
    if (next === 63 /* ? */) {
      const end = text.indexOf('?>', at)
      if (end < 0) return
      at = text.indexOf('<', end + 2)
      continue
    }
    // The tag's end: the first '>' outside a quoted value.
    let end = at + 1
    let quote = 0
    for (; end < text.length; end++) {
      const ch = text.charCodeAt(end)
      if (quote) {
        if (ch === quote) quote = 0
      } else if (ch === 34 || ch === 39) quote = ch
      else if (ch === 62 /* > */) break
    }
    if (end >= text.length) return
    if (next === 47 /* / */) {
      close(localName(text.slice(at + 2, end).trim()))
    } else {
      const selfClosing = text.charCodeAt(end - 1) === 47
      const stop = selfClosing ? end - 1 : end
      let i = at + 1
      while (i < stop && !isSpace(text.charCodeAt(i))) i++
      const name = localName(text.slice(at + 1, i))
      attrs.clear()
      while (i < stop) {
        while (i < stop && isSpace(text.charCodeAt(i))) i++
        const nameStart = i
        while (i < stop && text.charCodeAt(i) !== 61 /* = */ && !isSpace(text.charCodeAt(i))) i++
        const attr = text.slice(nameStart, i)
        while (i < stop && isSpace(text.charCodeAt(i))) i++
        if (text.charCodeAt(i) !== 61) {
          i++
          continue
        }
        i++
        while (i < stop && isSpace(text.charCodeAt(i))) i++
        const q = text.charCodeAt(i)
        if (q !== 34 && q !== 39) break
        const valueEnd = text.indexOf(String.fromCharCode(q), i + 1)
        if (valueEnd < 0 || valueEnd > stop) break
        if (attr) attrs.set(localName(attr), unescapeXml(text.slice(i + 1, valueEnd)))
        i = valueEnd + 1
      }
      open(name, attrs, selfClosing)
      if (selfClosing) close(name)
    }
    at = text.indexOf('<', end + 1)
  }
}

const isSpace = (c: number) => c === 32 || c === 9 || c === 10 || c === 13

/** "#RRGGBB" or "#RRGGBBAA" as 0xRRGGBB, or -1. */
function parseColor(text: string | undefined): number {
  const m = text ? /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(text.trim()) : null
  return m ? parseInt(m[1], 16) : -1
}

const integer = (text: string | undefined): number => {
  const n = text === undefined ? NaN : Number(text)
  return Number.isInteger(n) ? n : -1
}

/** One model file of the package, read. `defaultScale` is the root model's,
 *  for a file that does not say its unit. */
function readModel(text: string, defaultScale: number): ModelFile {
  const model: ModelFile = { scale: defaultScale, objects: new Map(), groups: new Map(), textures: new Map(), build: [] }
  let object: ModelObject | null = null
  let mesh: MeshObject | null = null
  let group: Group | null = null
  // A triangle naming a group not read here — multiproperties, composite
  // materials — takes no colour from it.
  scanXml(
    text,
    (name, a) => {
      switch (name) {
        case 'model': {
          const unit = a.get('unit')
          if (unit !== undefined) {
            const scale = MM_PER_UNIT[unit.toLowerCase()]
            if (scale === undefined) throw new Error(`3MF unit "${unit}" is not one of micron, millimeter, centimeter, inch, foot or meter.`)
            model.scale = scale
          }
          break
        }
        case 'object': {
          const pindex = integer(a.get('pindex'))
          object = { id: a.get('id') ?? '', type: (a.get('type') ?? 'model').toLowerCase(), pid: a.get('pid'), pindex: pindex >= 0 ? pindex : undefined, components: [] }
          model.objects.set(object.id, object)
          break
        }
        case 'mesh':
          if (object) mesh = object.mesh = { vertices: [], triangles: [], pid: [], p: [] }
          break
        case 'vertex':
          if (mesh) {
            const x = Number(a.get('x'))
            const y = Number(a.get('y'))
            const z = Number(a.get('z'))
            if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) throw new Error('Invalid 3MF vertex.')
            mesh.vertices.push(x, y, z)
          }
          break
        case 'triangle':
          if (mesh) {
            const v1 = integer(a.get('v1'))
            const v2 = integer(a.get('v2'))
            const v3 = integer(a.get('v3'))
            const n = mesh.vertices.length / 3
            if (v1 < 0 || v2 < 0 || v3 < 0 || v1 >= n || v2 >= n || v3 >= n) throw new Error('Invalid 3MF triangle: a corner names no vertex.')
            mesh.triangles.push(v1, v2, v3)
            const pid = a.get('pid') ?? object?.pid
            const p1 = a.has('p1') ? integer(a.get('p1')) : (object?.pindex ?? -1)
            const p2 = a.has('p2') ? integer(a.get('p2')) : p1
            const p3 = a.has('p3') ? integer(a.get('p3')) : p1
            mesh.pid.push(pid === undefined || p1 < 0 ? null : pid)
            mesh.p.push(p1, p2, p3)
          }
          break
        case 'component':
          object?.components.push({ objectid: a.get('objectid') ?? '', path: a.get('path'), transform: parseMatrix(a.get('transform')) })
          break
        case 'item':
          model.build.push({ objectid: a.get('objectid') ?? '', path: a.get('path'), transform: parseMatrix(a.get('transform')) })
          break
        case 'basematerials':
        case 'colorgroup':
          group = { kind: 'colors', rgb: [] }
          model.groups.set(a.get('id') ?? '', group)
          break
        case 'base':
          if (group?.kind === 'colors') group.rgb.push(parseColor(a.get('displaycolor')))
          break
        case 'color':
          if (group?.kind === 'colors') group.rgb.push(parseColor(a.get('color')))
          break
        case 'texture2d':
          model.textures.set(a.get('id') ?? '', a.get('path') ?? '')
          break
        case 'texture2dgroup':
          group = { kind: 'texture', texture: a.get('texid') ?? '', uv: [] }
          model.groups.set(a.get('id') ?? '', group)
          break
        case 'tex2coord':
          if (group?.kind === 'texture') {
            const u = Number(a.get('u'))
            const v = Number(a.get('v'))
            group.uv.push(Number.isFinite(u) ? u : 0, Number.isFinite(v) ? v : 0)
          }
          break
      }
    },
    (name) => {
      if (name === 'object') object = null
      else if (name === 'mesh') mesh = null
      else if (name === 'basematerials' || name === 'colorgroup' || name === 'texture2dgroup') group = null
    },
  )
  return model
}

/** What a slicer marks, in its own metadata, as other than the part:
 *  Bambu Studio and Orca by object (model_settings.config: a part whose
 *  subtype is not normal_part), PrusaSlicer by a run of an object's
 *  triangles (Slic3r_PE_model.config: a volume typed as a modifier,
 *  blocker, enforcer or negative volume). */
interface SlicerParts {
  objects: Set<string>
  triangles: Map<string, [number, number][]>
}

function readSlicerParts(files: Record<string, Uint8Array>): SlicerParts {
  const out: SlicerParts = { objects: new Set(), triangles: new Map() }
  const bambu = files[partName('Metadata/model_settings.config')]
  if (bambu) {
    scanXml(
      strFromU8(bambu),
      (name, a) => {
        if (name === 'part' && a.has('subtype') && a.get('subtype') !== 'normal_part') out.objects.add(a.get('id') ?? '')
      },
      () => {},
    )
  }
  const prusa = files[partName('Metadata/Slic3r_PE_model.config')]
  if (prusa) {
    let object = ''
    let volume: [number, number] | null = null
    let other = false
    scanXml(
      strFromU8(prusa),
      (name, a) => {
        if (name === 'object') object = a.get('id') ?? ''
        else if (name === 'volume') {
          volume = [integer(a.get('firstid')), integer(a.get('lastid'))]
          other = false
        } else if (name === 'metadata' && volume && a.get('type') === 'volume') {
          const key = a.get('key')
          const value = a.get('value') ?? ''
          if ((key === 'modifier' && value === '1') || (key === 'volume_type' && value !== 'ModelPart')) other = true
        }
      },
      (name) => {
        if (name === 'volume' && volume) {
          if (other && volume[0] >= 0 && volume[1] >= volume[0]) {
            const runs = out.triangles.get(object) ?? []
            runs.push(volume)
            out.triangles.set(object, runs)
          }
          volume = null
        }
      },
    )
  }
  return out
}

/** The root model's path, as _rels/.rels names it. */
function rootModelPath(files: Record<string, Uint8Array>): string {
  const rels = files[partName('_rels/.rels')]
  let target: string | null = null
  if (rels) {
    scanXml(
      strFromU8(rels),
      (name, a) => {
        if (target === null && name === 'Relationship' && /\/3dmodel$/i.test(a.get('Type') ?? '')) target = a.get('Target') ?? null
      },
      () => {},
    )
  }
  if (target !== null && files[partName(target)]) return partName(target)
  const fallback = partName('3D/3dmodel.model')
  if (files[fallback]) return fallback
  const any = Object.keys(files).find((k) => k.endsWith('.model'))
  if (!any) throw new Error('This 3MF holds no model.')
  return any
}

/** Object types that are not the part. */
const NOT_THE_PART = new Set(['support', 'solidsupport', 'other'])

/** Deeper than this, components are taken to name each other in a ring. */
const MAX_DEPTH = 32

/** How much the build may put in place. An object used twice as a component
 *  of one used twice, and so on down, is placed 2^depth times: thirty levels
 *  of a few bytes each would make a billion copies. Far past any real part. */
const MAX_PLACED = { objects: 1_000_000, vertices: 30_000_000 }

/** A model is XML whatever the zip makes of it: past the size text can be held
 *  at, about 7.5 million triangles at the 71 bytes a triangle ScanRuler writes. */
const THREEMF_INSTEAD = 'Export it as binary STL or binary PLY, which have no such limit.'

export function parse3MF(buffer: ArrayBuffer, onProgress?: (text: string) => void, companions?: ObjCompanions, limits: ArchiveLimits = THREE_MF_LIMITS): ParsedMesh {
  onProgress?.('Reading 3MF…')
  let zipped: Record<string, Uint8Array>
  try {
    zipped = unzipSync(new Uint8Array(buffer), { filter: limitedArchiveFilter((f) => /\.(model|rels|config)$/i.test(f.name), limits) })
  } catch (error) {
    if (error instanceof ArchiveLimitError) throw error
    throw new Error('This 3MF could not be unzipped — the file is damaged or not a 3MF.')
  }
  const files: Record<string, Uint8Array> = {}
  for (const [name, bytes] of Object.entries(zipped)) files[partName(name)] = bytes

  const rootPath = rootModelPath(files)
  const models = new Map<string, ModelFile>()
  checkTextSize(files[rootPath].byteLength, 'This 3MF', THREEMF_INSTEAD)
  const root = readModel(strFromU8(files[rootPath]), 1)
  models.set(rootPath, root)
  const modelAt = (path: string | undefined): ModelFile => {
    if (!path) return root
    const key = partName(path)
    let m = models.get(key)
    if (!m) {
      const bytes = files[key]
      if (!bytes) throw new Error(`This 3MF names ${path}, which it does not hold.`)
      checkTextSize(bytes.byteLength, 'This 3MF', THREEMF_INSTEAD)
      m = readModel(strFromU8(bytes), root.scale)
      models.set(key, m)
    }
    return m
  }
  const slicer = readSlicerParts(files)

  const positions: number[] = []
  const indices: number[] = []
  // Per vertex written, its colour (0xRRGGBB) once a corner gives it one.
  const vertexColor: number[] = []
  const textures = new Map<string, TextureImage | null>()
  const missing = new Set<string>()
  const applied = new Set<string>()
  const images = new Map((companions?.images ?? []).map((img) => [partName(img.name), img]))
  const imagesByBase = new Map((companions?.images ?? []).map((img) => [baseName(img.name), img]))
  const imageFor = (path: string): TextureImage | null => {
    let img = textures.get(path)
    if (img === undefined) {
      img = images.get(partName(path)) ?? imagesByBase.get(baseName(path)) ?? null
      textures.set(path, img)
      if (img) applied.add(img.name.split('/').pop()!)
      else missing.add(path.split('/').pop()!)
    }
    return img
  }
  const rgbOut = new Uint8Array(3)

  let placed = 0
  const place = (model: ModelFile, id: string, transform: Matrix, depth: number) => {
    if (depth > MAX_DEPTH) throw new Error('This 3MF\'s components name each other in a ring.')
    if (++placed > MAX_PLACED.objects) throw new Error('This 3MF places more objects than ScanRuler can open.')
    const object = model.objects.get(id)
    if (!object) throw new Error(`This 3MF names object ${id}, which it does not hold.`)
    if (NOT_THE_PART.has(object.type) || slicer.objects.has(id)) return
    // A component without a path names an object of its own file.
    for (const c of object.components) place(c.path ? modelAt(c.path) : model, c.objectid, compose(c.transform, transform), depth + 1)
    const mesh = object.mesh
    if (!mesh) return
    if (positions.length / 3 + mesh.vertices.length / 3 > MAX_PLACED.vertices) throw new Error('This 3MF places more geometry than ScanRuler can open.')
    const m = transform
    const s = model.scale
    const base = positions.length / 3
    const v = mesh.vertices
    for (let i = 0; i < v.length; i += 3) {
      positions.push(
        (v[i] * m[0] + v[i + 1] * m[3] + v[i + 2] * m[6] + m[9]) * s,
        (v[i] * m[1] + v[i + 1] * m[4] + v[i + 2] * m[7] + m[10]) * s,
        (v[i] * m[2] + v[i + 1] * m[5] + v[i + 2] * m[8] + m[11]) * s,
      )
      vertexColor.push(-1)
    }
    // A mirroring transform turns the triangles inside out; turned back.
    const flip = determinant(m) < 0
    const skip = slicer.triangles.get(id) ?? []
    const t = mesh.triangles
    for (let k = 0; k < t.length / 3; k++) {
      if (skip.some(([a, b]) => k >= a && k <= b)) continue
      const a = base + t[k * 3]
      const b = base + t[k * 3 + (flip ? 2 : 1)]
      const c = base + t[k * 3 + (flip ? 1 : 2)]
      indices.push(a, b, c)
      const pid = mesh.pid[k]
      const g = pid === null ? undefined : model.groups.get(pid)
      if (!g) continue
      for (let corner = 0; corner < 3; corner++) {
        const vertex = base + t[k * 3 + corner]
        if (vertexColor[vertex] >= 0) continue
        const p = mesh.p[k * 3 + corner]
        if (g.kind === 'colors') {
          const rgb = g.rgb[p]
          if (rgb !== undefined && rgb >= 0) vertexColor[vertex] = rgb
        } else {
          const path = model.textures.get(g.texture)
          const img = path ? imageFor(path) : null
          if (img && p >= 0 && p * 2 + 1 < g.uv.length) {
            sampleTexture(img, g.uv[p * 2], g.uv[p * 2 + 1], rgbOut, 0)
            vertexColor[vertex] = (rgbOut[0] << 16) | (rgbOut[1] << 8) | rgbOut[2]
          }
        }
      }
    }
  }

  onProgress?.('Placing the 3MF\'s objects…')
  for (const item of root.build) place(modelAt(item.path), item.objectid, item.transform, 0)
  if (indices.length === 0) throw new Error('This 3MF holds no triangles of a part — point clouds and support-only files are not supported.')

  const mesh: ParsedMesh = { kind: 'indexed', positions: Float32Array.from(positions), indices: Uint32Array.from(indices) }
  // Colour only when it says something: a texture, or more than one colour
  // — a CAD system's single display colour is not the part's.
  const distinct = new Set(vertexColor.filter((c) => c >= 0))
  if (applied.size > 0 || distinct.size > 1) {
    const colors = new Uint8Array(vertexColor.length * 3)
    for (let i = 0; i < vertexColor.length; i++) {
      const c = vertexColor[i]
      colors[i * 3] = c >= 0 ? c >> 16 : UNCOLOURED
      colors[i * 3 + 1] = c >= 0 ? (c >> 8) & 0xff : UNCOLOURED
      colors[i * 3 + 2] = c >= 0 ? c & 0xff : UNCOLOURED
    }
    mesh.colors = colors
  }
  if (applied.size > 0) mesh.texture = { kind: 'applied', images: [...applied] }
  else if (missing.size > 0) mesh.texture = { kind: 'missing', files: [...missing] }
  return mesh
}
