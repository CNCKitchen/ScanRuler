// SPDX-License-Identifier: AGPL-3.0-only
// Wrap in the real app, driven by an agent: the wrap's own worker and its
// pool of tile workers, nested in it, as the page makes them. A box with a
// box inside it and a slot in its top narrower than the gap is opened from a
// file; mesh_wrap makes the wrap — one shell, the inner box dropped, the
// slot bridged — and again with another Grow by, which starts from the field
// kept; with Edges: Sharp, its edges and corners put back; mesh_apply_wrap
// makes it the edited copy, one undo step. With
// WRAP_FILE, a mesh of one's own is wrapped as well and the time it took
// printed.
//
// Prereqs: dev server running (npm run dev), Chrome, and the MCP server's
// dependencies (npm --prefix mcp ci).
//   node plugins/mesh-tools/scripts/e2e-agent-wrap.mjs
// Env: APP_URL, CHROME, OUT_DIR, WRAP_FILE (an STL), WRAP_GAP (mm, for it).
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { check, fail, finish, launchAgent, launchApp, repoFile } from '../../../scripts/e2e-lib.mjs'

if (!existsSync(repoFile('mcp/node_modules/@modelcontextprotocol/sdk/package.json'))) {
  console.error('FATAL: the MCP server has no dependencies yet — run npm --prefix mcp ci.')
  process.exit(1)
}
const { startAgent } = await import('../../../mcp/tests/client.js')

/** A box from `min` to `max`, `n` squares a side on every face, wound
 *  outward — as triangles of nine floats. */
function cuboid(min, max, n) {
  const tris = []
  const lerp = (k, t) => min[k] + t * (max[k] - min[k])
  for (const [axis, end, u, v] of [[2, 1, 0, 1], [2, 0, 1, 0], [0, 1, 1, 2], [0, 0, 2, 1], [1, 1, 2, 0], [1, 0, 0, 2]]) {
    const at = (i, j) => {
      const p = [0, 0, 0]
      p[axis] = end ? max[axis] : min[axis]
      p[u] = lerp(u, i / n)
      p[v] = lerp(v, j / n)
      return p
    }
    for (let i = 0; i < n; i++)
      for (let j = 0; j < n; j++) tris.push([at(i, j), at(i + 1, j), at(i + 1, j + 1)], [at(i, j), at(i + 1, j + 1), at(i, j + 1)])
  }
  return tris
}

/** Triangles as a binary STL. */
function stl(tris) {
  const out = Buffer.alloc(84 + 50 * tris.length)
  out.writeUInt32LE(tris.length, 80)
  tris.forEach((t, i) => t.flat().forEach((x, k) => out.writeFloatLE(x, 84 + 50 * i + 12 + 4 * k)))
  return out
}

// A plate with two blocks on it, 1 mm apart — a slot under the 2 mm gap —
// and a box inside the first block.
const GAP = 2
const plate = cuboid([0, 0, 0], [40, 20, 4], 8)
const left = cuboid([0, 0, 3], [15, 20, 12], 6)
const right = cuboid([16, 0, 3], [40, 20, 12], 6)
const inner = cuboid([4, 4, 5], [10, 10, 9], 4)
const scanDir = mkdtempSync(join(tmpdir(), 'scanruler-wrap-'))
const SCAN = join(scanDir, 'blocks.stl')
writeFileSync(SCAN, stl([...plate, ...left, ...right, ...inner]))

const { agent } = await launchAgent(startAgent)
const { call } = agent

async function ok(name, input, what) {
  const r = await call(name, input)
  if (r.error) fail(`${what ?? name}: ${r.text}`)
  return r
}

const link = /(\S+#agent=\d+:[\w-]+)/.exec((await call('scanruler_status')).json?.howToConnect ?? '')?.[1]
check(Boolean(link), `the server hands out a pairing link (${link})`)
const { browser, page, consoleErrors } = await launchApp({ url: link, protocolTimeout: 600_000 })
try {
  const waited = await call('scanruler_wait', { for: 'page', timeoutSeconds: 60 })
  check(waited.json?.connected === true && waited.json.page.plugins.includes('mesh-tools'), 'the page connected with Mesh Tools')
  const names = (await agent.client.listTools()).tools.map((t) => t.name)
  check(names.includes('mesh_wrap') && names.includes('mesh_apply_wrap'), 'mesh_wrap and mesh_apply_wrap are listed')

  await ok('scan_open', { path: SCAN, discard: true })
  await ok('workspace_set', { workspace: 'mesh' })
  const workers = await page.evaluate(() => navigator.hardwareConcurrency)

  let t = Date.now()
  const first = await ok('mesh_wrap', { gap: GAP, edges: 'smooth' })
  const w = first.json?.wrap
  check(w?.status === 'ready' && w.shells === 1, `mesh_wrap: ${w?.shells} shell, ${w?.triangles} triangles, ${Date.now() - t} ms in the page (${workers} cores)`)
  // The box inside, and the faces of the blocks buried in the plate.
  check(w?.dropped >= inner.length, `the box inside dropped: ${w?.dropped} triangles, its ${inner.length} among them`)
  check(w?.bridgedArea > 0.5 * 20, `the slot bridged: ${w?.bridgedArea?.toFixed(1)} mm²`)
  // The part with the slot filled, less what the grid rounds at the edges.
  const solid = 40 * 20 * 12
  check(w && w.volume > solid - 100 && w.volume < solid + 5, `its volume: ${w?.volume?.toFixed(0)} mm³ of ${solid}`)
  const shown = await page.evaluate(() => document.body.innerText.includes('Wrap again'))
  check(shown, 'the panel shows the wrap on hand (Wrap again)')

  t = Date.now()
  const again = await ok('mesh_wrap', { gap: GAP, grow: 0.25, edges: 'smooth' })
  const kept = again.json?.wrap?.stages?.some((s) => s.stage === 'Kept from the wrap before')
  // Grown: about its area times the growth more — not snapped back onto the part.
  const grown = w.volume + 0.25 * w.area
  check(kept && Math.abs(again.json.wrap.volume - grown) < 0.01 * grown, `Grow by 0.25 from the field kept: ${again.json?.wrap?.volume?.toFixed(0)} mm³, about ${grown.toFixed(0)}, ${Date.now() - t} ms`)

  // Sharp: the blocks' edges and corners their own again.
  const sharp = await ok('mesh_wrap', { gap: GAP, grow: 0, edges: 'sharp' })
  const sw = sharp.json?.wrap
  check(sw?.sharpCorners > 0 && sw.sharpEdges > 0 && sw.triangles < w.triangles && Math.abs(sw.volume - w.volume) < 10, `Edges: Sharp: ${sw?.sharpEdges} edge points and ${sw?.sharpCorners} corners put back, ${sw?.triangles} triangles, ${sw?.volume?.toFixed(0)} mm³`)
  const sharpShown = await page.$eval('[data-test="wrap-sharp"]', (e) => e.textContent).catch(() => null)
  check(Boolean(sharpShown), `the panel says so: ${sharpShown}`)

  const applied = await ok('mesh_apply_wrap')
  check(applied.json?.mesh?.working === 'edited copy' && applied.json.mesh.open === 0, `mesh_apply_wrap: the edited copy, ${applied.json?.mesh?.triangles} triangles, closed`)
  const undone = await ok('history_undo')
  check(/wrap/i.test(undone.json?.undone ?? ''), `history_undo: ${undone.json?.undone}`)

  if (process.env.WRAP_FILE) {
    await ok('scan_open', { path: process.env.WRAP_FILE, discard: true })
    await ok('workspace_set', { workspace: 'mesh' })
    const gap = Number(process.env.WRAP_GAP ?? 2)
    for (const grow of [0, gap / 8]) {
      t = Date.now()
      const r = await ok('mesh_wrap', { gap, grow, edges: 'smooth' })
      const x = r.json?.wrap
      console.log(`  ${process.env.WRAP_FILE} at gap ${gap}, grow ${grow}: ${Date.now() - t} ms — ${x?.shells} shells, ${x?.triangles} triangles`)
      for (const s of x?.stages ?? []) console.log(`    ${s.stage.padEnd(28)} ${s.ms} ms`)
    }
  }
} catch (e) {
  fail(`unexpected: ${e?.stack ?? e}`)
}
await finish(browser, consoleErrors)
await agent.close()
