// SPDX-License-Identifier: AGPL-3.0-only
// The agent connection end to end: an MCP client — the SDK's own, as Claude
// Code and the others use it — starts the scanruler-mcp server (mcp/), the
// app in headless Chrome is paired with it through the pairing link the
// server hands out, and the ball bar is measured through the tools alone:
// open the scan, read where it lies, fit a sphere in each end, measure the
// centre distance, get the report, export STEP, undo and redo, then what only
// the browser does — export STL and a point cloud, save the project and open
// it again. The person's
// side is checked too: the chip says connected, the elements and the
// dimension are in the panel, the undo key names the agent's step.
//
// The real ball bar (ballbar.stl at the repository root) where it is at
// hand, held to GOM Inspect's 148.64 mm; otherwise two generated balls the
// same distance apart, held to that exactly — so the check runs in CI.
//
// Prereqs: dev server running (npm run dev), Chrome, and the server's
// dependencies (npm --prefix mcp ci).
//   node scripts/e2e-agent.mjs
// Env: APP_URL, CHROME, STL, OUT_DIR.
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { APP_URL, OUT_DIR, check, fail, finish, launchApp, repoFile, requireFixture, sleep } from './e2e-lib.mjs'
import { ballPairScan } from './e2e-fixtures.mjs'

const REAL = repoFile('ballbar.stl')
const STL = process.env.STL ?? (existsSync(REAL) ? REAL : ballPairScan({ distance: 148.64 }))
requireFixture(STL)
// The real scan against the reference measurement; the generated pair
// against the distance it was made at.
const TOLERANCE = STL === REAL ? 0.05 : 0.01
console.log(`scan: ${STL}`)
if (!existsSync(repoFile('mcp/node_modules/@modelcontextprotocol/sdk/package.json'))) {
  console.error('FATAL: the MCP server has no dependencies yet — run npm --prefix mcp ci.')
  process.exit(1)
}
const { startAgent } = await import('../mcp/tests/client.js')

/** A port nothing listens on. */
const freePort = () =>
  new Promise((resolve, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address()
      probe.close(() => resolve(port))
    })
  })

const port = await freePort()
const token = `e2e-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`
const serverOptions = {
  args: ['--port', String(port), '--out', OUT_DIR, '--app', APP_URL],
  env: { SCANRULER_MCP_TOKEN: token, SCANRULER_MCP_CONFIG_DIR: mkdtempSync(join(tmpdir(), 'scanruler-mcp-')) },
}
const agent = await startAgent(serverOptions)
const { call } = agent

// ---- before the page -------------------------------------------------------
const { tools } = await agent.client.listTools()
const names = tools.map((t) => t.name)
check(['scanruler_status', 'scan_open', 'element_fit', 'dimension_add', 'report_get', 'history_undo'].every((n) => names.includes(n)), `tools listed before a page connects (${tools.length})`)
const before = await call('scanruler_status')
check(before.json?.connected === false, 'status: no page yet')
const link = /(\S+#agent=\d+:[\w-]+)/.exec(before.json?.howToConnect ?? '')?.[1]
check(Boolean(link) && link.includes(`#agent=${port}:${token}`), `status hands out the pairing link (${link})`)

// ---- pairing ------------------------------------------------------------------
const { browser, page, consoleErrors } = await launchApp({ url: link })
const waited = await call('scanruler_wait', { for: 'page', timeoutSeconds: 60 })
check(waited.json?.connected === true, `the page connected (${waited.json?.page?.version}, ${waited.json?.page?.commands} commands)`)
check(!(await page.evaluate(() => location.hash)), 'the pairing link is taken out of the address')
const chip = await page.$eval('[data-test=agent-chip]', (e) => e.textContent.trim()).catch(() => '')
check(/connected/.test(chip), `the chip says so: "${chip}"`)

// ---- the ball bar, through the tools ---------------------------------------------
const opened = await call('scan_open', { path: STL, units: 'mm' })
check(opened.json?.scan?.vertices > 1_000, `scan_open: ${opened.json?.scan?.vertices} vertices${opened.error ? ` — ${opened.text}` : ''}`)
await page.waitForFunction(() => /[1-9][\d,]* triangles/.test(document.querySelector('.file-info')?.textContent ?? ''), { timeout: 60_000 })

const state = await call('session_state')
const { min, max } = state.json?.scan?.bounds ?? { min: [0, 0, 0], max: [0, 0, 0] }
const span = [0, 1, 2].map((k) => max[k] - min[k])
const axis = span.indexOf(Math.max(...span))
const toward = (t) => [0, 1, 2].map((k) => (k === axis ? min[k] + t * span[k] : (min[k] + max[k]) / 2))

const balls = []
for (const t of [0.05, 0.95]) {
  const fitted = await call('element_fit', { kind: 'sphere', at: { point: toward(t) } })
  const el = fitted.json?.element
  balls.push(el)
  check(!fitted.error && Math.abs(2 * el.fit.radius - 15.92) < 0.1, `element_fit: ${el ? `${el.name} Ø ${(2 * el.fit.radius).toFixed(4)} mm, σ ${el.fit.sigma.toFixed(4)}` : fitted.text}`)
}

const dim = await call('dimension_add', { refs: balls.map((b) => b?.name) })
const value = dim.json?.dimension?.value
check(typeof value === 'number' && Math.abs(value - 148.64) < TOLERANCE, `dimension_add: centre distance ${value?.toFixed(4)} mm (expected 148.64 ± ${TOLERANCE})${dim.error ? ` — ${dim.text}` : ''}`)

// What the person sees.
await sleep(300)
const rows = await page.$$eval('[data-test="element-row"]', (els) => els.length)
check(rows === 2, `two elements in the panel (${rows})`)
const shown = await page.$$eval('[data-test="dimension-value"]', (els) => els.map((e) => e.textContent.replace(/\s+/g, ' ').trim()))
check(shown.length === 1 && shown[0].includes(value?.toFixed(3)), `the dimension in the panel: ${JSON.stringify(shown)}`)
const undoTitle = await page.$eval('[data-test="sketch-undo"]', (e) => e.title)
check(undoTitle.startsWith('Undo: Agent: add dimension'), `the undo key names the agent’s step: "${undoTitle}"`)

const json = await call('report_get', { format: 'json' })
check(json.json?.report?.dimensions?.[0]?.value === value, 'report_get json: the same value')
const text = await call('report_get', { format: 'text' })
check(text.json?.text?.includes('Center distance: ') && text.json.text.startsWith('ScanRuler — '), 'report_get text: the clipboard report')
console.log(text.json?.text ?? text.text)

// A second copy of the server on the same port, as Claude Desktop starts one
// for its chats and one for its other sessions: it sends its calls through
// the copy the tab is connected to.
const second = await startAgent({ ...serverOptions, stderr: 'ignore' })
let relayStatus = null
for (let i = 0; i < 100 && !(relayStatus?.server?.role === 'relay' && relayStatus.connected); i++) {
  await sleep(100)
  relayStatus = (await second.call('scanruler_status')).json
}
check(relayStatus?.server?.role === 'relay' && relayStatus.connected, `a second copy on the port relays through the first (role ${relayStatus?.server?.role})`)
const relayed = await second.call('report_get', { format: 'json' })
check(relayed.json?.report?.dimensions?.[0]?.value === value, 'report_get through the second copy: the same value')
await second.close()

const step = await call('export_step', {})
const stepFile = step.json?.file?.path
check(Boolean(stepFile) && existsSync(stepFile) && readFileSync(stepFile, 'utf8').startsWith('ISO-10303-21;'), `export_step wrote ${stepFile}`)

// ---- undo, redo -------------------------------------------------------------------
const undone = await call('history_undo')
check(undone.json?.undone === 'Agent: add dimension', `history_undo: ${undone.json?.undone ?? undone.text}`)
await sleep(200)
check((await page.$$('[data-test="dimension-row"]')).length === 0, 'the dimension is gone from the panel')
const redone = await call('history_redo')
check(redone.json?.redone === 'Agent: add dimension', `history_redo: ${redone.json?.redone ?? redone.text}`)

const refused = await call('element_fit', { kind: 'blob', at: { vertex: 0 } })
check(refused.error && refused.text.startsWith('invalid_input:'), `a malformed call is refused: ${refused.text.slice(0, 80)}`)

// ---- what only the page in a browser can do -------------------------------------
// The viewport's exports, and the project file through the project worker —
// last, since opening a project starts a new history.
const stl = await call('export_stl', { path: OUT_DIR })
check(stl.json?.file?.size > 1000 && existsSync(stl.json.file.path), `export_stl wrote ${stl.json?.file?.path ?? stl.text} (${stl.json?.file?.size} bytes)`)
const cloud = await call('export_cloud', { format: 'xyz', path: OUT_DIR })
check(Boolean(cloud.json?.file?.name?.endsWith('.xyz')) && readFileSync(cloud.json.file.path, 'utf8').split('\n').length > 1000, `export_cloud wrote ${cloud.json?.file?.name ?? cloud.text}`)
const saved = await call('project_save', { path: OUT_DIR })
const projectFile = saved.json?.file?.path
check(Boolean(projectFile) && readFileSync(projectFile).subarray(0, 2).toString() === 'PK', `project_save wrote ${projectFile ?? saved.text}`)
const unasked = await call('project_load', { path: projectFile })
check(unasked.error && unasked.text.startsWith('invalid_state:'), 'project_load refuses to drop the session’s work unasked')
const loaded = await call('project_load', { path: projectFile, discard: true })
const again = loaded.json?.dimensions?.[0]?.value
check(typeof again === 'number' && Math.abs(again - value) < 1e-6, `project_load: the dimension back at ${again?.toFixed(4)} mm${loaded.error ? ` — ${loaded.text}` : ''}`)

await page.screenshot({ path: join(OUT_DIR, 'e2e-agent.png') })
if (!balls.every(Boolean)) fail('both balls fitted')
// The page goes first: closing the server under it would have it log the
// connection it keeps trying again.
await finish(browser, consoleErrors)
await agent.close()
