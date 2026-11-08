// SPDX-License-Identifier: AGPL-3.0-only
// End-to-end test of parameters and expressions in the Reverse engineer
// workspace: a parameter added in the panel and named, one reading another,
// a sketch's width and an extrude's distance typed as expressions over
// them, the part following a change of a parameter, the expression shown in
// the box, on the sheet and on the grip's field, a number typed over a
// field letting its expression go, a refused expression saying why, a remove
// refused while something reads the parameter, and the project's part saved
// and read back with the parameters in it.
//
// Prereqs: dev server running (npm run dev), Chrome installed.
//   node plugins/reverse/scripts/e2e-reverse-parameters.mjs
// Env: CHROME (chrome.exe path), APP_URL, SHOT_DIR.
import { check, click, finish, launchApp, sleep } from '../../../scripts/e2e-lib.mjs'
import { reverseHelpers } from './lib.mjs'

const { browser, page, consoleErrors } = await launchApp({ width: 1600, height: 1000, protocolTimeout: 600_000 })
page.on('dialog', (dialog) => dialog.accept())
const { re } = reverseHelpers(page)
const state = () => re(() => {
  const s = window.__re.store.getState()
  return {
    parameters: s.parameters,
    readings: s.parameterTable.readings.map((r) => [r.name, r.value, r.error]),
    features: s.features.map((f) => ({ id: f.id, kind: f.kind, name: f.name, exprs: f.exprs ?? null, extent: f.extent ?? null, dims: f.kind === 'sketch' ? f.sketch.constraints.filter((c) => 'value' in c).map((c) => [c.id, c.value, c.expr ?? null]) : null })),
    bodies: s.bodies.map((b) => ({ id: b.id, volume: b.volume })),
    building: s.building,
    extrudeDraft: s.extrudeDraft ? { extent: s.extrudeDraft.extent, exprs: s.extrudeDraft.exprs ?? null } : null,
    sketchDims: s.sketchDraft ? s.sketchDraft.sketch.constraints.filter((c) => 'value' in c).map((c) => [c.id, c.value, c.expr ?? null]) : null,
    bottom: (() => {
      const sk = s.sketchDraft?.sketch ?? s.features.find((f) => f.kind === 'sketch')?.sketch
      const e = sk?.entities[0]
      return e && e.kind === 'line' ? Math.hypot(e.b[0] - e.a[0], e.b[1] - e.a[1]) : null
    })(),
  }
})
/** Wait until the predicate over the state holds. */
async function until(predicate, what, tries = 600) {
  for (let i = 0; i < tries; i++) {
    const s = await state()
    if (predicate(s)) return s
    await sleep(100)
  }
  throw new Error(`timed out: ${what}`)
}
/** Type over a field: focus it, select what is there, type and enter. The
 *  focus is given by script rather than by a click: the field offers the
 *  parameters' names as it is typed into, and Chrome's suggestion popup
 *  from the last typing can take a click for itself. */
async function typeOver(selector, text) {
  await re((sel) => {
    const el = document.querySelector(sel)
    if (!el) throw new Error(`no field ${sel}`)
    el.focus()
    el.select()
  }, selector)
  await page.keyboard.type(text)
  await page.keyboard.press('Enter')
  await sleep(150)
}
const fieldValue = (selector) => re((sel) => document.querySelector(sel)?.value ?? null, selector)
const fieldUnit = (selector) => re((sel) => document.querySelector(sel)?.parentElement?.querySelector('i')?.textContent ?? null, selector)
const text = (selector) => re((sel) => document.querySelector(sel)?.textContent ?? null, selector)

await page.click('[data-test=workspace-reverse]')
await page.waitForSelector('[data-test=kernel-status]')
await sleep(300)
await page.waitForFunction(() => window.__re.store.getState().kernelStatus === 'ready', { timeout: 180_000 })

// ---- the list -------------------------------------------------------------------------
check((await text('[data-test=parameter-count]')) === '0', 'the Parameters section opens with none')
await click(page, '[data-test=parameter-add]')
await page.waitForSelector('[data-test=parameter-row]')
// The new row's name is focused and selected: typing names it.
await page.keyboard.type('height')
await page.keyboard.press('Enter')
await sleep(150)
let s = await state()
check(s.parameters.length === 1 && s.parameters[0].name === 'height' && s.parameters[0].expression === '0', `Add makes a parameter, named as typed (${JSON.stringify(s.parameters)})`)
await typeOver('[data-param="1"] [data-test=parameter-expression]', '20')
s = await state()
check(s.readings[0][1] === 20 && (await text('[data-param="1"] [data-test=parameter-value]')) === '20 mm', `its expression typed, the row reads 20 mm (${JSON.stringify(s.readings)})`)
await click(page, '[data-test=parameter-add]')
await page.keyboard.type('width')
await page.keyboard.press('Enter')
await sleep(150)
const rows = await re(() => [...document.querySelectorAll('[data-test=parameter-row]')].map((r) => r.querySelector('[data-test=parameter-name]').value))
check(rows.join(',') === 'height,width', `two rows, in order (${rows.join(',')})`)
const widthRow = '[data-param="2"]'
await typeOver(`${widthRow} [data-test=parameter-expression]`, 'height * 2')
s = await state()
check(s.readings[1][1] === 40, `a parameter reads another: width = height * 2 = 40 (${JSON.stringify(s.readings)})`)

// A refused expression says why under the row and leaves the value standing.
await typeOver(`${widthRow} [data-test=parameter-expression]`, 'nothing + 1')
await page.waitForSelector('[data-test=parameter-error]')
check((await text('[data-test=parameter-error]')) === 'there is no parameter “nothing”', 'a name that is no parameter is refused, with why')
s = await state()
check(s.parameters[1].expression === 'height * 2' && s.readings[1][1] === 40, 'and the parameter keeps what it had')
await typeOver(`${widthRow} [data-test=parameter-expression]`, 'height * 2')
check((await re(() => document.querySelector('[data-test=parameter-error]'))) === null, 'typed right again, the refusal goes')

// ---- a sketch dimension ----------------------------------------------------------------
await re(() => {
  const frame = { origin: [0, 0, 0], normal: [0, 0, 1], basisU: [1, 0, 0], basisV: [0, 1, 0] }
  const r = () => window.__re.store.getState()
  r().startSketch({ kind: 'world', axis: 'z', offset: 0 }, frame)
  r().setSketchTool('rectangle')
  r().sketchClick([0, 0], 0.01, false, { off: true })
  r().sketchClick([10, 10], 0.01, false, { off: true })
  r().setSketchTool('select')
  r().sketchClick([5, 0], 0.5, false, { off: true })
  r().addDimension('length', 10)
})
await page.waitForSelector('[data-test=sketch-dimension-input]')
await sleep(200)
// The fresh dimension's field has the focus: typing goes into it.
await typeOver('[data-test=sketch-dimension-input]', 'width')
s = await state()
check(s.sketchDims.length === 1 && s.sketchDims[0][2] === 'width' && s.sketchDims[0][1] === 40 && Math.abs(s.bottom - 40) < 1e-6, `the width typed as the parameter: the dimension reads it and the line is 40 long (${JSON.stringify(s.sketchDims)}, ${s.bottom})`)
check((await fieldValue('[data-test=sketch-dimension-input]')) === 'width' && (await fieldUnit('[data-test=sketch-dimension-input]')) === '= 40 mm', 'the row shows the expression with the value it comes to')
check((await re(() => document.querySelector('[data-test^=flat-dimension-]')?.textContent ?? '')).startsWith('ƒ 40'), 'the number on the sheet wears an ƒ')
check((await re(() => document.querySelector('[data-test=sketch-nominal]'))) === null, 'no round number is offered beside an expression')
// A number typed over lets the parameter go.
await typeOver('[data-test=sketch-dimension-input]', '12')
s = await state()
check(s.sketchDims[0][2] === null && s.sketchDims[0][1] === 12, `a plain number unlinks the dimension (${JSON.stringify(s.sketchDims)})`)
await typeOver('[data-test=sketch-dimension-input]', 'width')
const sketchId = await re(() => window.__re.store.getState().commitSketch())
check(typeof sketchId === 'number', 'the sketch finishes')

// ---- an extrude ----------------------------------------------------------------------
await re((id) => window.__re.store.getState().startExtrude(id), sketchId)
await page.waitForSelector('[data-test=extrude-to]')
await typeOver('[data-test=extrude-to]', 'height + 5')
s = await state()
check(s.extrudeDraft && s.extrudeDraft.extent.to === 25 && s.extrudeDraft.exprs && s.extrudeDraft.exprs['extent.to'] === 'height + 5', `the extrude's To typed as an expression: 25 mm, kept beside (${JSON.stringify(s.extrudeDraft)})`)
check((await fieldValue('[data-test=extrude-to]')) === 'height + 5' && (await fieldUnit('[data-test=extrude-to]')) === '= 25 mm', 'the box shows the expression and its value')
// An expression of the wrong kind is refused in the field, the number standing.
await typeOver('[data-test=extrude-to]', 'height + 2 deg')
await page.waitForSelector('[data-test=extrude-to-error]')
check((await text('[data-test=extrude-to-error]')) === 'a length and an angle cannot be added', 'a length plus an angle is refused in the field, with why')
s = await state()
check(s.extrudeDraft.extent.to === 25 && s.extrudeDraft.exprs['extent.to'] === 'height + 5', 'and nothing changed')
await page.keyboard.press('Escape')
await sleep(100)
check((await re(() => document.querySelector('[data-test=extrude-to-error]'))) === null && (await fieldValue('[data-test=extrude-to]')) === 'height + 5', 'Escape puts the expression back')
// The grip's field in the viewport shows the expression too.
await re(() => window.__re.store.getState().setGripField('extrudeTo'))
await page.waitForSelector('[data-test=grip-field]')
check((await fieldValue('[data-test=grip-field]')) === 'height + 5', 'the grip field reads the expression')
await re(() => window.__re.store.getState().setGripField(null))
const extrudeId = await re(() => window.__re.store.getState().commitExtrude())
s = await until((x) => !x.building && x.bodies.length > 0, 'the extrude built')
const volume = (x) => x.bodies[0].volume
check(Math.abs(volume(s) - 40 * 10 * 25) < 1, `the body is 40 × 10 × 25 — only the bottom side is dimensioned (${volume(s)})`)
const extrudeRow = await re(() => [...document.querySelectorAll('[data-test=feature-row]')].map((r) => r.getAttribute('title')).find((t) => t && t.includes('Extrude')) ?? [...document.querySelectorAll('[data-test=feature-row]')].map((r) => r.getAttribute('title')).join(' | '))
check(typeof extrudeRow === 'string' && extrudeRow.includes('extent.to = height + 5'), `the row's tooltip reads the expression (${extrudeRow})`)

// ---- the parameter changed: the part follows -----------------------------------------
const built = await re(() => window.__re.store.getState().buildVersion)
await typeOver('[data-param="1"] [data-test=parameter-expression]', '30')
s = await until((x) => !x.building && x.bodies.length > 0 && Math.abs(volume(x) - 60 * 10 * 35) < 1, 'the part rebuilt at height 30')
check(s.readings[0][1] === 30 && s.readings[1][1] === 60, `height 30 makes width 60 (${JSON.stringify(s.readings)})`)
const sketch = s.features.find((f) => f.kind === 'sketch')
const extrude = s.features.find((f) => f.id === extrudeId)
check(sketch.dims[0][1] === 60 && Math.abs(s.bottom - 60) < 1e-6 && extrude.extent.to === 35, `the sketch is solved again at 60 and the extrude reaches 35 (${JSON.stringify(sketch.dims)}, ${s.bottom}, ${extrude.extent.to})`)
check((await re(() => window.__re.store.getState().buildVersion)) > built, 'the features were rebuilt')

// ---- pointed at, a parameter lights what it drives; a star lists it first (issue 21) ----
const litNow = () =>
  re(() => ({
    rows: [...document.querySelectorAll('[data-test=feature-row]')].filter((r) => r.classList.contains('sel')).map((r) => r.querySelector('.name')?.textContent),
    faces: window.__re.reScene().bodyPicks.pickedFaces.size,
  }))
await page.hover('[data-param="1"] [data-test=parameter-value]')
await sleep(300)
let lit = await litNow()
check(lit.rows.length === 2 && lit.faces === 6, `pointed at, height lights the sketch it sizes and the extrude it deepens, and the extrude's six faces (${JSON.stringify(lit)})`)
await page.mouse.move(1200, 500)
await sleep(300)
lit = await litNow()
check(lit.rows.length === 0 && lit.faces === 0, `and lets them go after (${JSON.stringify(lit)})`)
await click(page, '[data-param="2"] [data-test=parameter-pin]')
await sleep(200)
const order = await re(() => [...document.querySelectorAll('[data-test=parameter-row]')].map((r) => r.getAttribute('data-param')))
check(order[0] === '2' && (await re(() => window.__re.store.getState().parameters.find((p) => p.id === 2).pinned)) === true, `the star marks width important and lists it first (${order})`)
await page.mouse.move(1200, 500)
await click(page, '[data-param="2"] [data-test=parameter-pin]')
await sleep(200)

// ---- a remove refused, a rename written through --------------------------------------
await click(page, '[data-param="1"] [data-test=parameter-remove]')
await sleep(100)
const refused = await text('[data-test=parameter-error]')
check(refused !== null && refused.includes('width') && refused.includes('Extrude 1'), `removing height is refused, naming its readers (${refused})`)
await typeOver('[data-param="1"] [data-test=parameter-name]', 'tall')
s = await state()
check(s.parameters[0].name === 'tall' && s.parameters[1].expression === 'tall * 2' && s.features.find((f) => f.id === extrudeId).exprs['extent.to'] === 'tall + 5', `renamed to tall everywhere (${JSON.stringify(s.parameters)}, ${JSON.stringify(s.features[1].exprs)})`)
check((await fieldValue('[data-param="2"] [data-test=parameter-expression]')) === 'tall * 2', 'the other row shows the new name')

// ---- the project's part ---------------------------------------------------------------
const roundTrip = await re(async () => {
  const section = await import('/plugins/reverse/app/projectSection.ts')
  const part = JSON.parse(JSON.stringify(section.collectReversePart()))
  const r = () => window.__re.store.getState()
  r().reset()
  const empty = r().parameters.length
  section.applyReversePart(part)
  return { saved: part.parameters, empty, back: r().parameters, readings: r().parameterTable.readings.map((x) => [x.name, x.value]) }
})
check(roundTrip.saved.length === 2 && roundTrip.empty === 0 && roundTrip.back.length === 2 && roundTrip.readings[1][1] === 60, `the parameters save and come back (${JSON.stringify(roundTrip.readings)})`)
s = await until((x) => !x.building && x.bodies.length > 0, 'the part rebuilt from the file')
check(Math.abs(volume(s) - 60 * 10 * 35) < 1, `and the part is as it was (${volume(s)})`)

await finish(browser, consoleErrors)
