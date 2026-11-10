// SPDX-License-Identifier: AGPL-3.0-only
// A fit made with a guide opens again with the project: a plate with a bore,
// clicked at the bore's mouth, where a cylinder from the seed alone grows
// onto the flat face round it and is refused; element_fit given the axis
// finds the bore. The project is saved and opened again through the agent
// tools: the bore's surface is grown again with the same guide, so
// project_load answers with the session — no error, no warning — and the
// bore holds its radius.
//
// Prereqs: dev server running (npm run dev), Chrome, and the server's
// dependencies (npm --prefix mcp ci).
//   node scripts/e2e-agent-guide.mjs
// Env: APP_URL, CHROME, OUT_DIR.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { check, fail, finish, launchAgent, launchApp, OUT_DIR, repoFile } from './e2e-lib.mjs'

if (!existsSync(repoFile('mcp/node_modules/@modelcontextprotocol/sdk/package.json'))) {
  console.error('FATAL: the MCP server has no dependencies yet — run npm --prefix mcp ci.')
  process.exit(1)
}
const { startAgent } = await import('../mcp/tests/client.js')

/** A square plate `side` across and `t` thick about z = 0, a bore of radius
 *  `r` through it along z, a little radial noise on the bore's wall. */
function platedHoleStl(r, side, t) {
  let seed = 9
  const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648)
  const noise = () => (rand() + rand() + rand() - 1.5) * 0.004
  const PHI = 64
  const half = side / 2
  const edge = (ph) => half / Math.max(Math.abs(Math.cos(ph)), Math.abs(Math.sin(ph)))
  const ring = (rho, z) => Array.from({ length: PHI }, (_, j) => {
    const ph = (j / PHI) * 2 * Math.PI
    const d = typeof rho === 'function' ? rho(ph) : rho
    return [d * Math.cos(ph), d * Math.sin(ph), z]
  })
  const face = (z) => Array.from({ length: 11 }, (_, i) => ring((ph) => r + ((edge(ph) - r) * i) / 10, z))
  const wall = (rho, wobble) => Array.from({ length: 9 }, (_, i) => {
    const end = i === 0 || i === 8
    return ring((ph) => rho(ph) + (wobble && !end ? noise() : 0), -t / 2 + (t * i) / 8)
  })
  const facets = []
  const grid = (rows, flip) => {
    for (let i = 0; i + 1 < rows.length; i++)
      for (let j = 0; j < PHI; j++) {
        const j2 = (j + 1) % PHI
        const a = rows[i][j], b = rows[i + 1][j], c = rows[i + 1][j2], d = rows[i][j2]
        facets.push(...(flip ? [[a, c, b], [a, d, c]] : [[a, b, c], [a, c, d]]))
      }
  }
  grid(face(t / 2), false)
  grid(face(-t / 2), true)
  grid(wall(() => r, true), false)
  grid(wall(edge, false), true)
  const v = (p) => `vertex ${p[0]} ${p[1]} ${p[2]}`
  return `solid plate\n${facets.map((f) => `facet normal 0 0 0\nouter loop\n${f.map(v).join('\n')}\nendloop\nendfacet`).join('\n')}\nendsolid plate\n`
}

mkdirSync(OUT_DIR, { recursive: true })
const STL = join(OUT_DIR, 'guided-plate.stl')
writeFileSync(STL, platedHoleStl(3, 30, 6))

const { agent } = await launchAgent(startAgent)
const { call } = agent
const link = /(\S+#agent=\d+:[\w-]+)/.exec((await call('scanruler_status')).json?.howToConnect ?? '')?.[1]
const { browser, page, consoleErrors } = await launchApp({ url: link })
try {
  check((await call('scanruler_wait', { for: 'page', timeoutSeconds: 60 })).json?.connected === true, 'the page connected')
  const opened = await call('scan_open', { path: STL, units: 'mm' })
  check(opened.json?.scan?.vertices > 1000, `the plate is open (${opened.json?.scan?.vertices} vertices)${opened.error ? ` — ${opened.text}` : ''}`)

  // The bore's mouth: the seed lies between the wall and the face round it.
  const mouth = { point: [2.1213, 2.1213, 3] }
  const alone = await call('element_fit', { kind: 'cylinder', at: mouth })
  check(alone.error && /Couldn't fit a cylinder/.test(alone.text), `from the mouth alone the bore is refused (${alone.text.slice(0, 90)}…)`)
  const guided = await call('element_fit', { kind: 'cylinder', at: mouth, axis: [0, 0, 1], name: 'Bore' })
  const radius = guided.json?.element?.fit?.radius
  check(Math.abs(radius - 3) < 0.01, `given the axis it is the bore, R${radius?.toFixed(4)}${guided.error ? ` — ${guided.text}` : ''}`)

  const saved = await call('project_save', { path: OUT_DIR })
  const file = saved.json?.file?.path
  check(Boolean(file), `project_save wrote ${file ?? saved.text}`)
  const loaded = await call('project_load', { path: file, discard: true })
  check(!loaded.error, `project_load answers with the session${loaded.error ? ` — not ${loaded.text}` : ''}`)
  check(!loaded.json?.warning, `and no surface is missing${loaded.json?.warning ? ` — ${loaded.json.warning}` : ''}`)
  const bore = loaded.json?.elements?.find((e) => e.name === 'Bore')
  check(Math.abs(bore?.fit?.radius - 3) < 0.01, `the bore is back at R${bore?.fit?.radius?.toFixed(4)}`)
  const errorShown = await page.$eval('.error-text, [data-test=error]', (e) => e.textContent).catch(() => '')
  check(!errorShown, `the page shows no error${errorShown ? ` — ${errorShown}` : ''}`)
} catch (e) {
  fail(e instanceof Error ? e.message : String(e))
}
await finish(browser, consoleErrors)
await agent.close()
