// SPDX-License-Identifier: AGPL-3.0-only
// End-to-end test of the element list's hover (issue 75): a hidden element
// is drawn, lit, while the pointer is over its row in 3D Measure's list,
// and put away again when it leaves — nothing about the element changed,
// no step of the history. And Reverse engineer's Export mesh row (issue
// 89): the resolution chosen is kept.
//
// Prereqs: dev server running (npm run dev), Chrome installed.
//   node scripts/e2e-peek.mjs
// Env: CHROME (chrome.exe path), APP_URL, SHOT_DIR.
import { check, finish, launchApp, loadScan, shotPath, sleep } from './e2e-lib.mjs'
import { notchedBlockScan } from './e2e-fixtures.mjs'

const { browser, page, consoleErrors } = await launchApp({ width: 1500, height: 950 })
await loadScan(page, notchedBlockScan())

// A plane on the block's top, fitted as the agent fits one.
const fitted = await page.evaluate(async () => {
  const { listCommands, runCommand } = await import('/src/commands/registry.ts')
  // The page registers its commands with the agent link on; here by hand.
  if (!listCommands().some((c) => c.name === 'element.fit')) (await import('/src/commands/core.ts')).registerCoreCommands()
  const out = await runCommand('element.fit', { kind: 'plane', at: { point: [20, 5, 20] } })
  return out.element?.id ?? out.id ?? null
})
check(typeof fitted === 'number', `a plane is fitted on the top (${fitted})`)
await sleep(400)

const store = () => page.evaluate(() => window.__scanruler.measure.getState())
const drawn = () => page.evaluate(() => window.__scanruler.scene().overlays.lastOverlayElements.map((e) => e.id))
check((await drawn()).includes(fitted), 'the plane is drawn')

await page.evaluate((id) => window.__scanruler.measure.getState().toggleElementVisible(id), fitted)
await sleep(300)
check(!(await drawn()).includes(fitted), 'hidden, it is not drawn')
const past = await page.evaluate(() => window.__scanruler.measure.getState().elements.length)

// The pointer onto its row, then off it.
const row = await page.$('[data-test=element-row]')
await row.hover()
await sleep(300)
check((await drawn()).includes(fitted), 'with the pointer over its row the hidden plane is drawn')
const lit = await page.evaluate(() => [...window.__scanruler.scene().overlays.highlightIds])
check(lit.includes(fitted), `and lit (${JSON.stringify(lit)})`)
await page.screenshot({ path: shotPath('peek-hover.png') })
await page.mouse.move(900, 500)
await sleep(300)
check(!(await drawn()).includes(fitted), 'the pointer gone, it is put away again')
const after = await store()
check(after.elements.find((e) => e.id === fitted)?.visible === false && after.elements.length === past && after.peek === null, 'and the element is as it was: hidden, nothing else changed')

// ---- Reverse engineer's Export mesh row -------------------------------------------------
await page.click('[data-test=workspace-reverse]')
await page.waitForSelector('[data-test=export-body-mesh-row]', { timeout: 30_000 })
check((await page.$('[data-test=export-body-mesh]')) !== null, 'Reverse engineer has an Export mesh key beside Export body STEP')
await page.click('[data-test=export-mesh-fine]')
await sleep(100)
const kept = await page.evaluate(() => localStorage.getItem('scanruler.meshresolution'))
const on = await page.$eval('[data-test=export-mesh-fine]', (el) => el.getAttribute('aria-checked'))
check(kept === 'fine' && on === 'true', `the resolution chosen is kept (${kept}, ${on})`)
await page.screenshot({ path: shotPath('reverse-export-mesh.png') })

await finish(browser, consoleErrors)
