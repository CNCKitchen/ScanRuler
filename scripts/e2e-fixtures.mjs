// SPDX-License-Identifier: AGPL-3.0-only
// Generated scans the browser checks share — written to a temporary folder,
// so they need no scan file in the repository.
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Binary STL of triangles given as a flat list of corners, three a face. */
function stl(header, corners) {
  const buf = Buffer.alloc(84 + (corners.length / 3) * 50)
  buf.write(header, 0, 'ascii')
  buf.writeUInt32LE(corners.length / 3, 80)
  let at = 84
  for (let t = 0; t < corners.length; t += 3) {
    at += 12
    for (const p of [corners[t], corners[t + 1], corners[t + 2]]) {
      buf.writeFloatLE(p[0], at)
      buf.writeFloatLE(p[1], at + 4)
      buf.writeFloatLE(p[2], at + 8)
      at += 12
    }
    at += 2
  }
  return buf
}

/** The fillet ring: a quarter round of tube radius `r` between a flat top and
 *  a flat side, round a ring of radius `R` about Z — the shape of a fillet on
 *  a boss. Returns the STL's path. */
export function filletRingScan({ R = 25, r = 3, radial = 240, tube = 24 } = {}) {
  const tris = []
  const rows = []
  for (let j = -8; j <= tube + 8; j++) {
    const row = []
    for (let k = 0; k < radial; k++) {
      const a = (k / radial) * 2 * Math.PI
      if (j < 0) row.push([(R - (0 - j) * (r / 4)) * Math.cos(a), (R - (0 - j) * (r / 4)) * Math.sin(a), r])
      else if (j > tube) row.push([(R + r) * Math.cos(a), (R + r) * Math.sin(a), -(j - tube) * (r / 4)])
      else {
        const b = (Math.PI / 2) * (j / tube)
        const rho = R + r * Math.sin(b)
        row.push([rho * Math.cos(a), rho * Math.sin(a), r * Math.cos(b)])
      }
    }
    rows.push(row)
  }
  for (let j = 0; j + 1 < rows.length; j++) {
    for (let k = 0; k < radial; k++) {
      const k2 = (k + 1) % radial
      const a = rows[j][k], b = rows[j][k2], c = rows[j + 1][k2], d = rows[j + 1][k]
      tris.push(a, b, c, a, c, d)
    }
  }
  const path = join(mkdtempSync(join(tmpdir(), 'scanruler-torus-')), 'fillet-ring.stl')
  writeFileSync(path, stl('ScanRuler e2e fillet ring', tris))
  return path
}

/** Fit a torus in Measure from one click on the middle of the fillet ring's
 *  round, seen from the top, and create it. Returns whether the click gave a
 *  preview. Needs the app's development hook, window.__scanruler. */
export async function fitFilletTorus(page, { R = 25, r = 3 } = {}, { click, previewReady, sleep }) {
  await click(page, '[data-test=fit-torus]')
  const rect = await page.$eval('.viewslot canvas', (el) => {
    const b = el.getBoundingClientRect()
    return { left: b.x, top: b.y, w: b.width, h: b.height }
  })
  const screenOf = (p) =>
    page.evaluate(
      (p, rect) => {
        const cam = window.__scanruler.scene().viewport.camera
        cam.updateMatrixWorld()
        const v = cam.position.clone().set(p[0], p[1], p[2]).project(cam)
        return [rect.left + ((v.x + 1) / 2) * rect.w, rect.top + ((1 - v.y) / 2) * rect.h]
      },
      p,
      rect,
    )
  await page.evaluate(() => window.__scanruler.scene().viewFrom?.('top'))
  await sleep(800)
  // The middle of the round, on the side of the ring facing the camera.
  const mid = Math.PI / 4
  await page.mouse.click(...(await screenOf([(R + r * Math.sin(mid)) * Math.cos(0.4), (R + r * Math.sin(mid)) * Math.sin(0.4), r * Math.cos(mid)])))
  const ready = await previewReady(page)
  if (ready) {
    await click(page, '[data-test=create-element]')
    await sleep(500)
  }
  return ready
}

/** A ball bar without its bar: two balls of radius `r`, their centres
 *  `distance` apart along Y — what the agent check measures where the real
 *  scan (ballbar.stl) is not at hand. Returns the STL's path. */
export function ballPairScan({ distance = 148.64, r = 7.96, rings = 48, segments = 96 } = {}) {
  const tris = []
  for (const cy of [-distance / 2, distance / 2]) {
    const at = (i, k) => {
      const theta = (Math.PI * i) / rings
      const phi = (2 * Math.PI * k) / segments
      return [r * Math.sin(theta) * Math.cos(phi), cy + r * Math.cos(theta), r * Math.sin(theta) * Math.sin(phi)]
    }
    for (let i = 0; i < rings; i++) {
      for (let k = 0; k < segments; k++) {
        const a = at(i, k), b = at(i + 1, k), c = at(i + 1, k + 1), d = at(i, k + 1)
        if (i > 0) tris.push(a, d, c)
        if (i < rings - 1) tris.push(a, c, b)
      }
    }
  }
  const path = join(mkdtempSync(join(tmpdir(), 'scanruler-balls-')), 'ball-pair.stl')
  writeFileSync(path, stl('ScanRuler e2e ball pair', tris))
  return path
}
