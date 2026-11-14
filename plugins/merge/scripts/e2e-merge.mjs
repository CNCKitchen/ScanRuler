// SPDX-License-Identifier: AGPL-3.0-only
// The Merge workspace end to end: two halves of a block, each a point cloud
// with normals, the second scanned in a frame of its own. Half A is opened as
// the scan through the start screen's file input, the Merge tab is taken,
// half B is opened as a layer through the panel's Open layer. Three point
// pairs lay it near its place — given through the agent command
// merge.align_pairs (the app's own command registry, as the agent bridge runs
// it): picking a pair is two clicks on points in the viewport, which a script
// can only aim through the camera, and the pairs only have to bring the layer
// near its place — then the panel's Refine settles it and Merge makes the two
// one cloud. Ctrl+Z brings half A back and the layer shown again; Ctrl+Y
// merges again. A plane fitted on the top face across the seam then reads
// the merge back: its flatness is the noise the halves were made with,
// nothing more. (The undo comes before the plane: fitting it opens 3D
// Measure, and leaving Merge puts its layers away for good.)
//
// The block is built here, not committed: 60 x 30 x 20 mm with a bore of
// radius 6 through it along z at the seam — without the bore, two halves of a
// plain box would slide along each other — every face a 0.5 mm grid, each
// point moved along its normal by uniform noise of ±NOISE. The halves are cut
// at x = 0 and overlap by 16 mm.
//
// Prereqs: dev server running (npm run dev), Chrome installed.
//   node plugins/merge/scripts/e2e-merge.mjs
// Env: CHROME (chrome.exe path), APP_URL, SHOT_DIR.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { check, click, fail, finish, launchApp, MOD, shotPath, sleep } from '../../../scripts/e2e-lib.mjs'

const SIZE = [60, 30, 20]
const BORE = 6
const STEP = 0.5
const OVERLAP = 16
/** Each point moved along its normal by a uniform draw from ±NOISE, mm. */
const NOISE = 0.01
/**
 * Flatness of the top face across the seam, mm. Perfectly laid, the face's
 * points lie within ±NOISE of z = 10, a span of 2 × NOISE = 0.02 (the fit
 * reads 0.0200 on a good merge). The rest is the alignment's: 0.02 more
 * allows the layer a tilt of 0.03 degrees over the 38 mm it reaches past the
 * seam, or a step of 0.02 mm at it; a layer left 0.1 degree askew would read
 * 0.07 or more.
 */
const FLATNESS_MAX = 2 * NOISE + 0.02

/** A seeded uniform draw in [0, 1) (mulberry32), so every run builds the same block. */
function random(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const ticks = (size) => Array.from({ length: Math.round(size / STEP) + 1 }, (_, i) => -size / 2 + i * STEP)

/** The block as rows of x y z nx ny nz, noise already on. */
function blockRows() {
  const [sx, sy, sz] = SIZE
  const rand = random(82)
  const rows = []
  const add = (x, y, z, nx, ny, nz) => {
    const e = (2 * rand() - 1) * NOISE
    rows.push([x + e * nx, y + e * ny, z + e * nz, nx, ny, nz])
  }
  for (const s of [-1, 1]) {
    for (const y of ticks(sy)) for (const z of ticks(sz)) add((s * sx) / 2, y, z, s, 0, 0)
    for (const x of ticks(sx)) for (const z of ticks(sz)) add(x, (s * sy) / 2, z, 0, s, 0)
    for (const x of ticks(sx)) for (const y of ticks(sy)) if (Math.hypot(x, y) > BORE + STEP / 2) add(x, y, (s * sz) / 2, 0, 0, s)
  }
  // The bore: rings STEP apart, normals towards the axis.
  const around = Math.round((2 * Math.PI * BORE) / STEP)
  for (const z of ticks(sz)) {
    for (let a = 0; a < around; a++) {
      const t = (2 * Math.PI * a) / around
      add(BORE * Math.cos(t), BORE * Math.sin(t), z, -Math.cos(t), -Math.sin(t), 0)
    }
  }
  return rows
}

/** Half B's own frame: turned 8° about z and 4° about x, moved by MOVE. */
const MOVE = [6, -4, 3]
function turn(p) {
  const a = (8 * Math.PI) / 180, b = (4 * Math.PI) / 180
  const x1 = Math.cos(a) * p[0] - Math.sin(a) * p[1], y1 = Math.sin(a) * p[0] + Math.cos(a) * p[1], z1 = p[2]
  return [x1, Math.cos(b) * y1 - Math.sin(b) * z1, Math.sin(b) * y1 + Math.cos(b) * z1]
}
const toB = (p) => turn(p).map((v, k) => v + MOVE[k])

function ply(rows, header) {
  const head = Buffer.from(
    `ply\nformat binary_little_endian 1.0\ncomment ${header}\nelement vertex ${rows.length}\n` +
      ['x', 'y', 'z', 'nx', 'ny', 'nz'].map((p) => `property float ${p}\n`).join('') +
      'end_header\n',
    'latin1',
  )
  const body = Buffer.alloc(rows.length * 24)
  rows.forEach((row, i) => row.forEach((v, c) => body.writeFloatLE(v, i * 24 + c * 4)))
  return Buffer.concat([head, body])
}

const rows = blockRows()
const halfA = rows.filter((r) => r[0] <= OVERLAP / 2)
const halfB = rows.filter((r) => r[0] >= -OVERLAP / 2).map((r) => [...toB(r.slice(0, 3)), ...turn(r.slice(3))])
// The app first: a start that fails throws before the files are written,
// so nothing is left in the temp folder.
const { browser, page, consoleErrors } = await launchApp({ width: 1600, height: 1000, protocolTimeout: 300_000 })
const dir = mkdtempSync(join(tmpdir(), 'scanruler-merge-'))
const fileA = join(dir, 'half-a.ply')
const fileB = join(dir, 'half-b.ply')
try {
  writeFileSync(fileA, ply(halfA, 'ScanRuler e2e block, half A'))
  writeFileSync(fileB, ply(halfB, 'ScanRuler e2e block, half B'))
} catch (e) {
  // A full disk, say: the folder and the browser go before it says so.
  rmSync(dir, { recursive: true, force: true })
  await browser.close()
  throw e
}

/** The scan's store, the Merge store and the undo count, read in the page. */
const state = () =>
  page.evaluate(async () => {
    const { useStore } = await import('/src/state/store.ts')
    const { useMerge } = await import('/plugins/merge/state/mergeStore.ts')
    const { useHistory } = await import('/src/state/historyStore.ts')
    const s = useStore.getState()
    const m = useMerge.getState()
    return {
      fileName: s.fileName,
      status: s.statusText,
      steps: useHistory.getState().past.map((e) => e.label),
      points: s.vertexCount,
      cloud: s.scanIsCloud,
      elements: s.elements.length,
      merges: m.merges,
      running: m.running,
      selected: m.selected,
      layers: m.layers.map((l) => ({ id: l.id, name: l.name, visible: l.visible, last: l.last ?? null })),
    }
  })

const until = async (what, test, timeout = 120_000) => {
  const end = Date.now() + timeout
  for (;;) {
    const s = await state()
    if (test(s)) return s
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}: ${JSON.stringify(s)}`)
    await sleep(100)
  }
}

try {
  // ---- half A as the scan, then the Merge tab ------------------------------------
  await (await page.$('[data-test=start-scan] input[type=file]')).uploadFile(fileA)
  const opened = await until('half A to open', (s) => s.cloud && s.fileName === 'half-a.ply')
  const scanPoints = opened.points
  check(scanPoints > 10_000, `half A is the scan, a cloud of ${scanPoints} points`)
  await click(page, '[data-test=workspace-merge]')
  await page.waitForSelector('.merge-panel', { timeout: 30_000 })

  // ---- half B as a layer, through the panel ---------------------------------------
  const [chooser] = await Promise.all([page.waitForFileChooser({ timeout: 10_000 }), click(page, '[data-test=merge-open-layer]')])
  await chooser.accept([fileB])
  const withLayer = await until('half B to open as a layer', (s) => s.layers.length === 1 && s.running === null)
  const layer = withLayer.layers[0]
  check(layer.name === 'half-b.ply' && layer.visible, `half B is a layer, shown (${layer.name})`)
  check(withLayer.points === scanPoints && withLayer.fileName === 'half-a.ply', 'and the scan is still half A')
  await page.screenshot({ path: shotPath('merge-opened.png') })

  // ---- three pairs: a point on the layer and the same point on the scan ----------
  // Corners and an edge point inside the overlap, each "clicked" 0.3 mm out
  // on the layer, as a hand would.
  const picks = [[8, -15, 10], [-6, 15, 10], [4, -15, -10]]
  const jitter = [[0.3, -0.3, 0.3], [-0.3, 0.3, 0.3], [0.3, 0.3, -0.3]]
  const pairs = picks.map((p, k) => ({ layer: toB(p).map((v, a) => v + jitter[k][a]), target: p }))
  const paired = await page.evaluate(
    async (id, pairs) => {
      const { runCommand } = await import('/src/commands/registry.ts')
      try {
        return await runCommand('merge.align_pairs', { id, target: 'base', pairs })
      } catch (e) {
        return { error: e.message }
      }
    },
    layer.id,
    pairs,
  )
  console.log('align_pairs:', JSON.stringify(paired))
  check(!paired.error && paired.confident === true, `three pairs lay the layer on the scan, confident (rms ${paired.rms})`)

  // ---- Refine, through the panel ----------------------------------------------------
  // The pairs' own refine has settled it already, so this one barely moves
  // it; its step in the history says it ran to its end.
  await click(page, '[data-test=merge-refine]')
  const refined = await until('the refine to finish', (s) => s.running === null && s.steps.at(-1) === 'Merge: refine layer')
  const last = refined.layers[0].last
  console.log('refined:', refined.status)
  check(last?.confident === true && last.rms < 0.02, `Refine settles it: rms ${last?.rms?.toFixed(4)} mm, matched ${last?.matched?.toFixed(3)}`)

  // ---- Merge, through the panel -----------------------------------------------------
  await click(page, '[data-test=merge-run]')
  const merged = await until('the merge', (s) => s.merges === 1 && s.running === null)
  console.log('merged:', merged.status)
  check(merged.cloud && merged.points > scanPoints, `the scan is the merged cloud, more points than half A alone (${merged.points} against ${scanPoints})`)
  check(merged.layers.every((l) => !l.visible), 'and the layer is hidden')
  await page.screenshot({ path: shotPath('merge-merged.png') })

  // ---- Ctrl+Z, then Ctrl+Y ---------------------------------------------------------
  // Undone in the workspace: the layers are the workspace's and go for good
  // when it is left (as the plane's fit below leaves it for 3D Measure), so
  // the step back is taken here, then forward again.
  const keys = async (key) => {
    await page.mouse.move(5, 5)
    await page.keyboard.down(MOD)
    await page.keyboard.press(key)
    await page.keyboard.up(MOD)
  }
  await keys('z')
  const undone = await until('the merge to be undone', (s) => s.merges === 0 && s.running === null && s.points === scanPoints, 60_000)
  console.log('undone:', undone.status)
  check(undone.fileName === 'half-a.ply', `Ctrl+Z brings half A back (${undone.points} points)`)
  check(undone.layers.length === 1 && undone.layers[0].visible, 'and the layer is shown again')
  await page.screenshot({ path: shotPath('merge-undone.png') })
  await keys('y')
  const redone = await until('the merge to be redone', (s) => s.merges === 1 && s.running === null && s.points === merged.points, 60_000)
  check(redone.layers.length === 1 && !redone.layers[0].visible, `Ctrl+Y merges again (${redone.points} points), the layer hidden`)

  // ---- a plane on the top face, across the seam -------------------------------------
  const plane = await page.evaluate(async () => {
    const { listCommands, runCommand } = await import('/src/commands/registry.ts')
    // The page registers its core commands with the agent link on; here by hand.
    if (!listCommands().some((c) => c.name === 'element.fit')) (await import('/src/commands/core.ts')).registerCoreCommands()
    try {
      const out = await runCommand('element.fit', { kind: 'plane', at: { point: [0, 11, 10] } })
      return out
    } catch (e) {
      return { error: e.message }
    }
  })
  const fit = plane.element?.fit ?? plane.fit
  if (!fit) fail(`no plane was fitted on the top: ${JSON.stringify(plane).slice(0, 400)}`)
  else {
    // How far the patch reaches along x either side of its middle: past
    // what either half holds alone (each reaches 8 mm over the seam).
    const reach = fit.extentU * Math.abs(fit.basisU[0]) + fit.extentV * Math.abs(fit.basisV[0])
    const from = fit.center[0] - reach, to = fit.center[0] + reach
    console.log(`plane: normal ${fit.normal.map((v) => v.toFixed(5))}, centre ${fit.center.map((v) => v.toFixed(3))}, x ${from.toFixed(2)} to ${to.toFixed(2)}, used ${fit.usedPoints}, sigma ${fit.sigma?.toFixed(5)}, flatness ${fit.formError?.toFixed(5)} mm`)
    check(Math.abs(fit.normal[2]) > 0.9999 && Math.abs(Math.abs(fit.center[2]) - 10) < 0.01, 'the plane is the top face')
    check(from < -20 && to > 20, `it spans the seam: x from ${from.toFixed(1)} to ${to.toFixed(1)}`)
    check(typeof fit.formError === 'number' && fit.formError <= FLATNESS_MAX, `its flatness ${fit.formError?.toFixed(4)} mm is within ${FLATNESS_MAX.toFixed(3)} (noise ±${NOISE})`)
  }

} catch (e) {
  fail(`threw: ${e instanceof Error ? e.stack : String(e)}`)
} finally {
  // The folder goes even when closing the browser throws.
  try {
    await finish(browser, consoleErrors)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
