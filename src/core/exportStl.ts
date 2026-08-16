// SPDX-License-Identifier: AGPL-3.0-only
// Binary STL export of the scan as it currently sits — the mesh handed back in
// whatever frame the alignment tools have put it in, so it can be taken into
// the next tool already levelled, zeroed, or sitting on the reference.
//
// Binary rather than ASCII: a scan is hundreds of thousands of triangles, and
// the text form is roughly fifteen times the size for the same geometry and
// less precision. Coordinates are millimetres, matching everything else here.
//
// The format is 80 bytes of free-text header, a uint32 triangle count, then 50
// bytes per triangle — a facet normal and three vertices as little-endian
// float32, and a uint16 attribute word nobody agrees on, written as zero.

import { rigidApplyToPoints, type Rigid } from './deviation/rigid'

const HEADER_BYTES = 80
const TRIANGLE_BYTES = 50

/** The header must not begin with "solid": readers sniff for that word to tell
 *  the two forms apart, and a binary file that says it would be parsed as
 *  text. Truncated to fit, non-ASCII dropped — it is a comment, not data. */
function writeHeader(view: DataView, text: string): void {
  const ascii = text.replace(/[^\x20-\x7e]/g, '?').slice(0, HEADER_BYTES)
  for (let i = 0; i < ascii.length; i++) view.setUint8(i, ascii.charCodeAt(i))
}

/**
 * Build a binary STL from an indexed (or flat) triangle mesh.
 *
 * @param positions xyz per vertex.
 * @param indices   Three per triangle, or null when `positions` is already
 *                  laid out one triangle after another.
 * @param transform Applied to every vertex on the way out — the pose the scan
 *                  is being shown in but does not yet carry in its own
 *                  coordinates. Null exports the vertices as they stand.
 * @param header    Free text for the 80-byte header.
 */
export function buildBinaryStl(
  positions: Float32Array,
  indices: Uint32Array | Uint16Array | null,
  transform: Rigid | null,
  header: string,
): ArrayBuffer {
  const triangleCount = indices ? Math.floor(indices.length / 3) : Math.floor(positions.length / 9)

  // Transformed once per vertex rather than once per corner: a closed scan
  // shares each vertex across six triangles, so doing it here is a copy of the
  // positions against six times the arithmetic.
  let xyz = positions
  if (transform) {
    xyz = new Float32Array(positions)
    rigidApplyToPoints(transform, xyz)
  }

  const buffer = new ArrayBuffer(HEADER_BYTES + 4 + triangleCount * TRIANGLE_BYTES)
  const view = new DataView(buffer)
  writeHeader(view, header)
  view.setUint32(HEADER_BYTES, triangleCount, true)

  let at = HEADER_BYTES + 4
  for (let t = 0; t < triangleCount; t++) {
    const ia = (indices ? indices[t * 3] : t * 3) * 3
    const ib = (indices ? indices[t * 3 + 1] : t * 3 + 1) * 3
    const ic = (indices ? indices[t * 3 + 2] : t * 3 + 2) * 3
    const ax = xyz[ia]
    const ay = xyz[ia + 1]
    const az = xyz[ia + 2]
    const bx = xyz[ib]
    const by = xyz[ib + 1]
    const bz = xyz[ib + 2]
    const cx = xyz[ic]
    const cy = xyz[ic + 1]
    const cz = xyz[ic + 2]

    // Facet normal from the winding, so it stays consistent with the vertex
    // order even where the scan's own normals are noisy. A degenerate triangle
    // gets a zero normal, which the format allows and readers recompute.
    const ux = bx - ax
    const uy = by - ay
    const uz = bz - az
    const vx = cx - ax
    const vy = cy - ay
    const vz = cz - az
    let nx = uy * vz - uz * vy
    let ny = uz * vx - ux * vz
    let nz = ux * vy - uy * vx
    const len = Math.hypot(nx, ny, nz)
    if (len > 0) {
      nx /= len
      ny /= len
      nz /= len
    } else {
      nx = ny = nz = 0
    }

    view.setFloat32(at, nx, true)
    view.setFloat32(at + 4, ny, true)
    view.setFloat32(at + 8, nz, true)
    view.setFloat32(at + 12, ax, true)
    view.setFloat32(at + 16, ay, true)
    view.setFloat32(at + 20, az, true)
    view.setFloat32(at + 24, bx, true)
    view.setFloat32(at + 28, by, true)
    view.setFloat32(at + 32, bz, true)
    view.setFloat32(at + 36, cx, true)
    view.setFloat32(at + 40, cy, true)
    view.setFloat32(at + 44, cz, true)
    view.setUint16(at + 48, 0, true)
    at += TRIANGLE_BYTES
  }
  return buffer
}
