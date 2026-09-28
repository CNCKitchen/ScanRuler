// SPDX-License-Identifier: AGPL-3.0-only
// The torus element end to end: a generated ring — a quarter round between
// a flat top and a flat side, the shape of a fillet on a boss — is loaded as
// the scan, Torus is fitted from one click on the round in Measure, and the
// element reads its tube radius. Needs no scan file.
//
//   npm run dev &  node scripts/e2e-torus.mjs
import { check, click, finish, launchApp, loadScan, previewReady, shotPath, sleep } from './e2e-lib.mjs'
import { filletRingScan, fitFilletTorus } from './e2e-fixtures.mjs'

const R = 25, r = 3
const scanPath = filletRingScan({ R, r })

const { browser, page, consoleErrors } = await launchApp({ width: 1600, height: 1000, protocolTimeout: 600_000 })
await loadScan(page, scanPath, { inputSelector: '[data-test=start-scan] input[type=file]' })
await page.evaluate(() => document.querySelector('[data-test=support-card] button')?.click())

// ---- Torus from one click on the round ---------------------------------------------------
check((await page.$('[data-test=fit-torus]')) !== null, 'Torus is offered among the element kinds')
check(await fitFilletTorus(page, { R, r }, { click, previewReady, sleep }), 'a click on the round fits a torus')
const rowText = await page.$eval('[data-test=element-row]', (el) => el.textContent)
console.log('row:', rowText)
check(/R 3\.0\d\d mm/.test(rowText), `the torus row reads the tube radius (${rowText})`)
const fit = await page.evaluate(() => window.__scanruler.measure.getState().elements[0]?.fit ?? null)
console.log('fit:', JSON.stringify(fit && { R: fit.majorRadius, r: fit.minorRadius, axis: fit.axis, sigma: fit.sigma, tube: fit.tubeCoverage, spine: fit.spineCoverage }))
check(fit && Math.abs(fit.majorRadius - R) < 0.05 && Math.abs(fit.minorRadius - r) < 0.05 && Math.abs(Math.abs(fit.axis[2]) - 1) < 1e-3, 'with the ring’s radii and axis')
check(fit && fit.spineCoverage > 350 && fit.tubeCoverage < 120, 'over the whole ring and a quarter of the tube')
await page.screenshot({ path: shotPath('torus-element.png') })

await finish(browser, consoleErrors)
