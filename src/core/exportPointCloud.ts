// SPDX-License-Identifier: AGPL-3.0-only
// The scan as a point cloud — every vertex with its normal, in the pose it
// is shown in — for the reverse-engineering tools that model over points
// rather than triangles. Two forms of the same list:
//
//   * PLY, binary little-endian: compact, and read by Geomagic, CloudCompare,
//     MeshLab, ReCap and most everything else. A vertex element only — no
//     faces — so a reader that wants a cloud gets a cloud, and one that would
//     have tried to build a mesh from the faces does not.
//   * XYZ text: one point per line, `x y z nx ny nz`, space-separated, in
//     millimetres. The universal fallback (ASC is the same file under another
//     extension); Autodesk ReCap turns either into an RCP for AutoCAD.
//
// Coordinates are millimetres, matching everything else here. A transform
// moves the points and turns the normals on the way out, the way the STL
// export applies the deviation workspace's best fit.

import { rigidApplyToPoints, rigidRotateVectors, type Rigid } from './deviation/rigid'

export type CloudFormat = 'ply' | 'xyz'

/** The points and normals in the pose to write: copied and moved when there
 *  is a transform, the caller's own arrays untouched either way. */
function posed(
  positions: Float32Array,
  normals: Float32Array | null,
  transform: Rigid | null,
): { xyz: Float32Array; nrm: Float32Array | null } {
  if (!transform) return { xyz: positions, nrm: normals }
  const xyz = new Float32Array(positions)
  rigidApplyToPoints(transform, xyz)
  let nrm: Float32Array | null = null
  if (normals) {
    nrm = new Float32Array(normals)
    rigidRotateVectors(transform, nrm)
  }
  return { xyz, nrm }
}

/** A PLY comment is one line of printable ASCII: anything else is dropped
 *  or replaced, since it is a note, not data. */
function plyComment(text: string): string {
  return text.replace(/[\r\n]+/g, ' ').replace(/[^\x20-\x7e]/g, '?').trim()
}

/** A binary little-endian PLY holding the vertices as a point cloud: xyz
 *  per vertex, with nx ny nz per vertex unless `normals` is null.
 *  `transform` is applied to every point and turned onto every normal on
 *  the way out; null exports the vertices as they stand. `comment` is one
 *  line for the header's comment. */
export function buildPointCloudPly(
  positions: Float32Array,
  normals: Float32Array | null,
  transform: Rigid | null,
  comment: string,
): ArrayBuffer {
  const count = Math.floor(positions.length / 3)
  const { xyz, nrm } = posed(positions, normals, transform)
  const lines = [
    'ply',
    'format binary_little_endian 1.0',
    `comment ${plyComment(comment)}`,
    `element vertex ${count}`,
    'property float x',
    'property float y',
    'property float z',
  ]
  if (nrm) lines.push('property float nx', 'property float ny', 'property float nz')
  lines.push('end_header')
  const header = new TextEncoder().encode(lines.join('\n') + '\n')
  const stride = nrm ? 24 : 12
  const buffer = new ArrayBuffer(header.length + count * stride)
  new Uint8Array(buffer).set(header)
  const view = new DataView(buffer)
  let at = header.length
  for (let i = 0; i < count; i++) {
    const j = i * 3
    view.setFloat32(at, xyz[j], true)
    view.setFloat32(at + 4, xyz[j + 1], true)
    view.setFloat32(at + 8, xyz[j + 2], true)
    if (nrm) {
      view.setFloat32(at + 12, nrm[j], true)
      view.setFloat32(at + 16, nrm[j + 1], true)
      view.setFloat32(at + 20, nrm[j + 2], true)
    }
    at += stride
  }
  return buffer
}

/** Lines encoded at a time: each piece's text stays far below the longest
 *  string a browser will make. */
const XYZ_PIECE = 1 << 16

/**
 * Build an XYZ text file: one point per line, `x y z` to a tenth of a micron
 * and, when normals are given, `nx ny nz` after them. Lines end in a plain
 * newline; every point-cloud reader takes that. Written as bytes a piece at
 * a time, not as one string: a scan of ten million points is past half a
 * gigabyte of text, more than a string can hold.
 */
export function buildPointCloudXyz(
  positions: Float32Array,
  normals: Float32Array | null,
  transform: Rigid | null,
): Uint8Array {
  const count = Math.floor(positions.length / 3)
  const { xyz, nrm } = posed(positions, normals, transform)
  const encoder = new TextEncoder()
  const pieces: Uint8Array[] = []
  let size = 0
  for (let from = 0; from < count; from += XYZ_PIECE) {
    const to = Math.min(count, from + XYZ_PIECE)
    let text = ''
    for (let i = from; i < to; i++) {
      const j = i * 3
      text += `${xyz[j].toFixed(4)} ${xyz[j + 1].toFixed(4)} ${xyz[j + 2].toFixed(4)}`
      if (nrm) text += ` ${nrm[j].toFixed(5)} ${nrm[j + 1].toFixed(5)} ${nrm[j + 2].toFixed(5)}`
      text += '\n'
    }
    const bytes = encoder.encode(text)
    pieces.push(bytes)
    size += bytes.length
  }
  const out = new Uint8Array(size)
  let at = 0
  for (const piece of pieces) {
    out.set(piece, at)
    at += piece.length
  }
  return out
}
