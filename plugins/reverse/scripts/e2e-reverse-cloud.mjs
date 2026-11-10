// SPDX-License-Identifier: AGPL-3.0-only
// A gear from its point cloud, over MCP, in the browser: an agent opens a
// 15-tooth gear's cloud, models it in the Reverse engineer workspace
// (gearRecipe.mjs — the same steps the tests run headless), and finds the
// one step that needs a surface refused until it meshes the cloud.
// SCANRULER_REVO_DIR (or the Revo project at its usual place) adds the real
// gear's merged cloud.
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { check, fail, finish, launchAgent, launchApp, repoFile, shotPath, sleep } from '../../../scripts/e2e-lib.mjs'
import { buildGear } from './gearRecipe.mjs'

if (!existsSync(repoFile('mcp/node_modules/@modelcontextprotocol/sdk/package.json'))) {
  console.error('FATAL: the MCP server has no dependencies yet — run npm --prefix mcp ci.')
  process.exit(1)
}
const { startAgent } = await import('../../../mcp/tests/client.js')

/** A spur gear about z, as tests/cloudFixtures gearCloud makes one: straight
 *  trapezoid teeth, both faces, a bore, every normal out of the material. */
function gearPly({ teeth = 15, tip = 25, root = 21, width = 12, bore = 6, step = 0.4 } = {}) {
  const rows = []
  const radiusAt = (a) => {
    const period = (2 * Math.PI) / teeth
    const f = ((((a % period) + period) % period) / period)
    if (f < 0.1 || f >= 0.65) return root
    if (f < 0.25) return root + ((f - 0.1) / 0.15) * (tip - root)
    if (f < 0.5) return tip
    return tip - ((f - 0.5) / 0.15) * (tip - root)
  }
  const fine = Math.round((2 * Math.PI * tip) / (step / 4))
  const poly = Array.from({ length: fine }, (_, i) => {
    const a = (2 * Math.PI * i) / fine
    const r = radiusAt(a)
    return [r * Math.cos(a), r * Math.sin(a)]
  })
  const wall = []
  let last = null
  for (let i = 0; i < poly.length; i++) {
    const [ax, ay] = poly[i]
    const [bx, by] = poly[(i + 1) % poly.length]
    const len = Math.hypot(bx - ax, by - ay)
    if (last && Math.hypot(ax - last[0], ay - last[1]) < step) continue
    last = [ax, ay]
    wall.push([ax, ay, (by - ay) / len, -(bx - ax) / len])
  }
  const ticks = (size) => {
    const n = Math.max(1, Math.round(size / step))
    return Array.from({ length: n + 1 }, (_, i) => -size / 2 + (size * i) / n)
  }
  for (const z of ticks(width)) for (const [x, y, nx, ny] of wall) rows.push([x, y, z, nx, ny, 0])
  for (const s of [-1, 1])
    for (const x of ticks(2 * tip))
      for (const y of ticks(2 * tip)) {
        const r = Math.hypot(x, y)
        if (r > bore + step / 2 && r < radiusAt(Math.atan2(y, x)) - step / 2) rows.push([x, y, (s * width) / 2, 0, 0, s])
      }
  const around = Math.round((2 * Math.PI * bore) / step)
  for (const z of ticks(width))
    for (let j = 0; j < around; j++) {
      const a = (2 * Math.PI * j) / around
      rows.push([bore * Math.cos(a), bore * Math.sin(a), z, -Math.cos(a), -Math.sin(a), 0])
    }
  const head = Buffer.from(`ply\nformat binary_little_endian 1.0\nelement vertex ${rows.length}\n${['x', 'y', 'z', 'nx', 'ny', 'nz'].map((p) => `property float ${p}\n`).join('')}end_header\n`, 'latin1')
  const body = Buffer.alloc(rows.length * 24)
  rows.forEach((row, i) => row.forEach((v, c) => body.writeFloatLE(v, i * 24 + c * 4)))
  return Buffer.concat([head, body])
}

const dir = mkdtempSync(join(tmpdir(), 'scanruler-reverse-cloud-'))
const GEAR = join(dir, 'gear.ply')
writeFileSync(GEAR, gearPly())
const REVO = join(process.env.SCANRULER_REVO_DIR || 'C:/Users/Jozkah/AppData/Roaming/RevoMetro/Projects/Project09052026214810', 'data', '920a4e47-c165-45e6-80d6-2b5c7f46e81f', 'model_pointcloud.ply')

const { agent } = await launchAgent(startAgent)
const { call } = agent
/** A command over MCP, by its name with dots: its JSON, or it throws with what it said. */
const tool = async (name, input = {}) => {
  const r = await call(name.replace(/\./g, '_'), input)
  if (r.error) throw new Error(`${name}: ${r.text}`)
  return r.json
}

const link = /(\S+#agent=\d+:[\w-]+)/.exec((await call('scanruler_status')).json?.howToConnect ?? '')?.[1]
check(Boolean(link), 'the server hands out a pairing link')
const { browser, page, consoleErrors } = await launchApp({ url: link, protocolTimeout: 600_000 })
try {
  const waited = await call('scanruler_wait', { for: 'page', timeoutSeconds: 60 })
  check(waited.json?.connected === true, 'the page connected')

  // ---- the synthetic gear ------------------------------------------------------
  const opened = await tool('scan.open', { path: GEAR, discard: true })
  check(opened.scan?.triangles === 0 && opened.scan?.vertices > 10000, `scan_open: a cloud of ${opened.scan?.vertices} points`)
  await tool('workspace.set', { workspace: 'reverse' })
  await sleep(500)
  const tab = await page.$eval('[data-test="workspace-reverse"]', (el) => ({ disabled: el.disabled, title: el.title }))
  check(!tab.disabled, `the Reverse engineer tab is on for a cloud (${tab.title})`)
  const points = `${opened.scan.vertices.toLocaleString('en-US')} points`
  const card = await page.evaluate(() => document.querySelector('.panel')?.innerText ?? document.body.innerText)
  check(card.includes(points) && !card.includes('0 triangles'), `the workspace's scan card counts points: ${points}`)

  const g = await buildGear(tool, { log: (t) => console.log('  ', t) })
  check(g.teeth === 15, `15 teeth read: ${g.teeth}`)
  check(Math.abs(g.tip - 25) < 0.1 && Math.abs(g.root - 21) < 0.1 && Math.abs(g.bore - 6) < 0.1, `tip ${g.tip.toFixed(3)}, root ${g.root.toFixed(3)}, bore ${g.bore?.toFixed(3)} mm`)
  check(g.compare.share > 0.95 && g.compare.p95 < 0.2, `the model lies on the cloud: share ${g.compare.share}, p95 ${g.compare.p95} mm`)
  await page.waitForFunction(() => document.querySelectorAll('[data-test="feature-row"]').length >= 4, { timeout: 30_000 }).catch(() => {})
  const rows = await page.$$eval('[data-test="feature-row"]', (els) => els.map((e) => e.textContent.replace(/\s+/g, ' ').trim()))
  check(rows.length === 4 && rows[0].includes('Gear profile') && rows[3].includes('Bore'), `the feature tree in the panel: ${JSON.stringify(rows)}`)
  check((await page.$$('[data-test="feature-failed"]')).length === 0, 'no feature row says it failed')
  await page.screenshot({ path: shotPath('reverse-cloud-gear.png') })

  // ---- what needs a surface: refused, then meshed --------------------------------
  const refused = await call('reverse_body_volume_compare', {})
  check(refused.error && /Mesh this cloud/.test(refused.text), `reverse_body_volume_compare on the cloud names Mesh this cloud: ${refused.text.slice(0, 120)}`)
  const meshed = await tool('mesh.mesh_cloud', {})
  check(meshed.triangles > 10000, `mesh_mesh_cloud: ${meshed.triangles} triangles, ${meshed.cell} mm cells`)
  const volume = await call('reverse_body_volume_compare', {})
  check(!volume.error, `reverse_body_volume_compare runs on the mesh: ${volume.text.slice(0, 160)}`)

  // ---- the real gear, where its scans are here ------------------------------------
  if (existsSync(REVO)) {
    await tool('scan.open', { path: REVO, discard: true })
    await tool('reverse.feature.clear', {})
    const real = await buildGear(tool, { log: (t) => console.log('  ', t) })
    check(real.teeth === 16 && real.hub !== null, `the Revo gear: ${real.teeth} teeth, tip ${real.tip.toFixed(2)}, root ${real.root.toFixed(2)}, bore ${real.bore?.toFixed(2)}, hub ${real.hub?.toFixed(2)} mm`)
    check(real.compare.p50 < 0.15, `it lies on the Revo cloud: p50 ${real.compare.p50}, p95 ${real.compare.p95} mm`)
    await sleep(1500)
    await page.screenshot({ path: shotPath('reverse-cloud-revo-gear.png') })
  } else console.log('   (the Revo project is not here — its gear skipped)')
} catch (e) {
  fail(`threw: ${e instanceof Error ? e.stack : String(e)}`)
} finally {
  await finish(browser, consoleErrors)
  await agent.close()
  rmSync(dir, { recursive: true, force: true })
}
