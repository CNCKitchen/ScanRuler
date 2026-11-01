// SPDX-License-Identifier: AGPL-3.0-only
/** An original, deterministic 30 × 20 × 12 mm inspection block. Dense planar
 *  triangles exercise the normal scan/fit pipeline, with no CAD dependency.
 *  This ideal geometry is a learning sample, not scanner-accuracy evidence. */
export function measurementSample(): string {
  // units-ok: OBJ source metadata declares the generated coordinates' fixed units.
  const lines = ['# ScanRuler measurement sample: 30 x 20 x 12 mm; ideal geometry']
  const faces = [
    { origin: [0,0,0], u: [0,20,0], v: [30,0,0] },
    { origin: [0,0,12], u: [30,0,0], v: [0,20,0] },
    { origin: [0,0,0], u: [30,0,0], v: [0,0,12] },
    { origin: [0,20,0], u: [0,0,12], v: [30,0,0] },
    { origin: [0,0,0], u: [0,0,12], v: [0,20,0] },
    { origin: [30,0,0], u: [0,20,0], v: [0,0,12] },
  ]
  const cells = 16, stride = cells + 1
  faces.forEach(({origin,u,v}, face) => {
    const base = face * stride * stride + 1
    for (let y = 0; y <= cells; y++) for (let x = 0; x <= cells; x++) {
      lines.push(`v ${origin.map((a,i) => a + u[i] * x / cells + v[i] * y / cells).join(' ')}`)
    }
    for (let y = 0; y < cells; y++) for (let x = 0; x < cells; x++) {
      const a = base + y * stride + x
      lines.push(`f ${a} ${a+1} ${a+stride}`, `f ${a+1} ${a+stride+1} ${a+stride}`)
    }
  })
  return lines.join('\n') + '\n'
}
