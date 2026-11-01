// SPDX-License-Identifier: AGPL-3.0-only
// End-to-end check of the body list as an assembly's browser, on the blank
// stage: a STEP file of three parts — Base, Shaft, Cap — imported; a
// component made from the list's key, named, and a part dragged into it;
// the pointer on a row lighting its body in the viewport, on a component's
// row every body in it; the cursor on a part in the viewport lighting its
// row, and on a part in a closed component that component's row; a click
// on a part naming it and its component over the readings, with Hide others,
// Show all and Hide; a right click's menu taking a part out of its
// component, and Ctrl+Z putting it back. Then several rows picked — Ctrl+click,
// Shift+click — lit in the viewport, dragged into a component together, and
// moved together: the Move opened from the keys under the list, a row
// clicked putting a body in and taking it out, a part clicked in the
// viewport putting it in.
//
// Prereqs: dev server running (npm run dev), Chrome installed.
//   node plugins/reverse/scripts/e2e-reverse-body-tree.mjs
// Env: CHROME (chrome.exe path), APP_URL, SHOT_DIR.
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { check, click, finish, launchApp, MOD, shotPath, sleep } from '../../../scripts/e2e-lib.mjs'
import { openReverse, reverseHelpers } from './lib.mjs'

// ---- the file: three parts side by side --------------------------------------------
const { OcctKernel } = await import('occt-wasm')
const occt = await OcctKernel.init()
const doc = occt.createXCAFDocument()
doc.addShape(occt.makeBox(30, 20, 8), { name: 'Base' })
doc.addShape(occt.translate(occt.makeBox(10, 10, 20), 40, 5, 0), { name: 'Shaft' })
doc.addShape(occt.translate(occt.makeBox(16, 16, 6), 60, 2, 0), { name: 'Cap' })
const stepText = doc.exportSTEP()
doc.close()
const dir = mkdtempSync(join(tmpdir(), 'scanruler-body-tree-'))
const stepPath = join(dir, 'assembly.step')
writeFileSync(stepPath, stepText)

const { browser, page, consoleErrors } = await launchApp({ width: 1600, height: 1000, protocolTimeout: 600_000 })
await openReverse(page)

const { re, screen } = reverseHelpers(page)
const bodies = () => re(() => window.__re.store.getState().bodies.map((b) => ({ id: b.id, name: b.name, visible: b.visible, box: b.box })))
const lit = () => re(() => [...window.__re.reScene().bodyPicks.lit()])
const rowOf = (name) => re((n) => [...document.querySelectorAll('[data-test=body-row]')].findIndex((r) => r.querySelector('[data-test=body-name]')?.textContent === n), name)
const rowClass = (name) => re((n) => [...document.querySelectorAll('[data-test=body-row]')].find((r) => r.querySelector('[data-test=body-name]')?.textContent === n)?.className ?? null, name)
/** Where a point of the part is on the screen. */
/** The middle of a body's top face, on the screen. */
const topOf = async (name) => {
  const b = (await bodies()).find((x) => x.name === name)
  return screen([(b.box.min[0] + b.box.max[0]) / 2, (b.box.min[1] + b.box.max[1]) / 2, b.box.max[2]])
}
/** An HTML5 drag from one element to another, as the browser raises it. */
const drag = (from, to) =>
  re(
    async (from, to) => {
      const source = document.querySelector(from)
      const target = document.querySelector(to)
      const data = new DataTransfer()
      const at = (el) => {
        const r = el.getBoundingClientRect()
        return { clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 }
      }
      source.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: data, ...at(source) }))
      await new Promise((r) => setTimeout(r, 60))
      target.dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer: data, ...at(target) }))
      target.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: data, ...at(target) }))
      await new Promise((r) => setTimeout(r, 60))
      target.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: data, ...at(target) }))
      target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: data, ...at(target) }))
      source.dispatchEvent(new DragEvent('dragend', { bubbles: true, cancelable: true, dataTransfer: data }))
    },
    from,
    to,
  )

// ---- the assembly imported ---------------------------------------------------------
await (await page.$('[data-test=feature-import-file]')).uploadFile(stepPath)
await page.waitForSelector('[data-test=import-editor]', { timeout: 10_000 })
await page.waitForFunction(() => window.__re.store.getState().preview.status === 'ok', { timeout: 60_000 })
await click(page, '[data-test=import-create]')
await page.waitForFunction(() => !window.__re.store.getState().building && window.__re.store.getState().bodies.length === 3, { timeout: 60_000 })
let st = await bodies()
check(JSON.stringify(st.map((b) => b.name)) === JSON.stringify(['Base', 'Shaft', 'Cap']), `three parts, named as the file names them (${st.map((b) => b.name)})`)
const id = Object.fromEntries(st.map((b) => [b.name, b.id]))

// ---- a component made, named, and a part dragged into it ---------------------------------
await click(page, '[data-test=body-folder-new]')
await page.waitForSelector('[data-test=body-folder-name-input]')
await page.keyboard.down(MOD)
await page.keyboard.press('a')
await page.keyboard.up(MOD)
await page.keyboard.type('Drive')
await page.keyboard.press('Enter')
await sleep(100)
check((await page.$eval('[data-test=body-folder-name]', (e) => e.textContent)) === 'Drive', 'the new component is named in its row')
await drag(`[data-test=body-row][data-body="${id.Shaft}"]`, '[data-test=body-folder]')
await sleep(150)
let folders = await re(() => window.__re.store.getState().bodyFolders)
check(folders.length === 1 && JSON.stringify(folders[0].bodies) === JSON.stringify([id.Shaft]), `Shaft dragged onto Drive is in it (${JSON.stringify(folders)})`)
const indent = await re((b) => getComputedStyle(document.querySelector(`[data-test=body-row][data-body="${b}"]`)).paddingLeft, id.Shaft)
check(indent === '15px', `and its row stands in under the component (${indent})`)
check((await rowOf('Shaft')) === 0, 'the component comes first, its part under it, the rest after')
await drag(`[data-test=body-row][data-body="${id.Cap}"]`, `[data-test=body-row][data-body="${id.Shaft}"]`)
await sleep(150)
folders = await re(() => window.__re.store.getState().bodyFolders)
check(folders[0].bodies.includes(id.Cap), 'a part dropped on a row inside the component goes into it too')

// ---- the list lights the viewport ----------------------------------------------------
await page.hover(`[data-test=body-row][data-body="${id.Base}"] [data-test=body-name]`)
await sleep(150)
check(JSON.stringify(await lit()) === JSON.stringify([id.Base]), `the pointer on Base's row lights Base in the viewport (${await lit()})`)
await page.screenshot({ path: shotPath('reverse-body-tree-row-hover.png') })
await page.hover('[data-test=body-folder] [data-test=body-folder-name]')
await sleep(150)
check(JSON.stringify((await lit()).sort()) === JSON.stringify([id.Shaft, id.Cap].sort()), `on the component's row, every body in it (${await lit()})`)
await page.mouse.move(800, 980)
await sleep(150)
check((await lit()).length === 0, 'off the list, nothing is lit')

// ---- the viewport lights the list ----------------------------------------------------
const baseTop = await topOf('Base')
await page.mouse.move(baseTop[0] - 4, baseTop[1] - 4)
await sleep(60)
await page.mouse.move(baseTop[0], baseTop[1])
await sleep(300)
const hover = await re(() => window.__re.store.getState().bodyHover)
check(hover?.from === 'view' && hover.ids[0] === id.Base, `the cursor on Base in the viewport says so (${JSON.stringify(hover)})`)
check(/\blit\b/.test(await rowClass('Base')), "and Base's row lights")
check((await lit()).length === 0, 'without lighting the whole body over the face under the cursor')
await page.screenshot({ path: shotPath('reverse-body-tree-view-hover.png') })

// A closed component's row stands for the part inside it.
await click(page, '[data-test=body-folder-fold]')
await sleep(100)
check((await page.$$('[data-test=body-row]')).length === 1, 'the closed component hides its rows')
const shaftTop = await topOf('Shaft')
await page.mouse.move(shaftTop[0] - 4, shaftTop[1] - 4)
await sleep(60)
await page.mouse.move(shaftTop[0], shaftTop[1])
await sleep(300)
check(/\blit\b/.test(await page.$eval('[data-test=body-folder]', (e) => e.className)), "the cursor on Shaft lights its closed component's row")
await click(page, '[data-test=body-folder-fold]')

// ---- a click names the part, and hides it or the others ---------------------------------------
await page.mouse.click(shaftTop[0], shaftTop[1])
await page.waitForSelector('[data-test=chip-body]', { timeout: 5000 })
check((await page.$eval('[data-test=chip-body-name]', (e) => e.textContent)) === 'Shaft', 'the card names the part clicked')
check((await page.$eval('[data-test=chip-body-path]', (e) => e.textContent)) === 'in Drive', 'and the component it is in')
check(/\bpicked\b/.test(await rowClass('Shaft')), "and the part's row is marked")
await page.screenshot({ path: shotPath('reverse-body-tree-card.png') })
await click(page, '[data-test=chip-hide-others]')
st = await bodies()
check(st.every((b) => b.visible === (b.name === 'Shaft')), `Hide others leaves Shaft alone on show (${st.map((b) => `${b.name}:${b.visible}`)})`)
check((await page.$eval('[data-test=chip-hide-others]', (e) => e.textContent)) === 'Show all', 'and the key turns to Show all')
await page.screenshot({ path: shotPath('reverse-body-tree-isolated.png') })
await click(page, '[data-test=chip-hide-others]')
check((await bodies()).every((b) => b.visible), 'which shows them all again')
await click(page, '[data-test=chip-hide-body]')
st = await bodies()
check(!st.find((b) => b.name === 'Shaft').visible && st.filter((b) => b.visible).length === 2, 'Hide hides the part')
check(!(await page.$('[data-test=context-chips]')), 'and puts the card away')
// Shaft's own eye brings it back — the label's key would hide the other two.
await click(page, `[data-test=body-row][data-body="${id.Shaft}"] [data-test=body-visible]`)
check((await bodies()).every((b) => b.visible), 'its eye brings it back')

// ---- the menu, and Ctrl+Z ---------------------------------------------------------------------------
const capRow = await page.$(`[data-test=body-row][data-body="${id.Cap}"]`)
await capRow.click({ button: 'right' })
await page.waitForSelector('[data-test=body-menu]')
await click(page, '[data-test=body-menu-move-top]')
folders = await re(() => window.__re.store.getState().bodyFolders)
check(!folders[0].bodies.includes(id.Cap), "the menu's Move to the top of the list takes Cap out of Drive")
await page.keyboard.down(MOD)
await page.keyboard.press('z')
await page.keyboard.up(MOD)
await sleep(300)
folders = await re(() => window.__re.store.getState().bodyFolders)
check(folders[0]?.bodies.includes(id.Cap), `and Ctrl+Z puts it back (${JSON.stringify(folders)})`)
await page.screenshot({ path: shotPath('reverse-body-tree-end.png') })

// ---- several rows picked ----------------------------------------------------------------------------
const picks = () => re(() => window.__re.store.getState().listSelection)
const rowName = (body) => `[data-test=body-row][data-body="${body}"] [data-test=body-name]`
const ctrlClick = async (sel) => {
  await page.keyboard.down(MOD)
  await page.click(sel)
  await page.keyboard.up(MOD)
}
const shiftClick = async (sel) => {
  await page.keyboard.down('Shift')
  await page.click(sel)
  await page.keyboard.up('Shift')
}
await page.keyboard.press('Escape')
await sleep(100)
check((await picks()).bodies.length === 0 && !(await page.$('[data-test=body-selection]')), 'Escape lets the rows go')
// A second component to drag into.
await click(page, '[data-test=body-folder-new]')
await page.waitForSelector('[data-test=body-folder-name-input]')
await page.keyboard.down(MOD)
await page.keyboard.press('a')
await page.keyboard.up(MOD)
await page.keyboard.type('Frame')
await page.keyboard.press('Enter')
await sleep(100)
const frame = (await re(() => window.__re.store.getState().bodyFolders)).find((f) => f.name === 'Frame')?.id
check(frame !== undefined, 'a second component, Frame')

await page.click(rowName(id.Base))
await ctrlClick(rowName(id.Cap))
await sleep(100)
check(JSON.stringify((await picks()).bodies) === JSON.stringify([id.Base, id.Cap]), 'a click and a Ctrl+click pick two rows')
check((await page.$eval('[data-test=body-selection-words]', (e) => e.textContent)) === '2 bodies', 'the keys under the list say how many')
check(JSON.stringify(await lit()) === JSON.stringify([id.Base, id.Cap].sort((a, b) => a - b)), `and both are lit in the viewport (${await lit()})`)
check((await page.$$('[data-test=body-row].selected')).length === 2, 'and their rows are filled')
await page.screenshot({ path: shotPath('reverse-body-tree-picked.png') })
// Shift+click: every row from the last one clicked down to it.
await page.click(rowName(id.Shaft))
await shiftClick(rowName(id.Base))
await sleep(100)
const order = await re(() => [...document.querySelectorAll('[data-test=body-row]')].map((r) => Number(r.dataset.body)))
check(JSON.stringify((await picks()).bodies.sort()) === JSON.stringify([...order].sort()), `Shift+click picks the rows from Shaft to Base (${JSON.stringify(await picks())})`)
await page.click(rowName(id.Base))
await ctrlClick(rowName(id.Cap))
check((await picks()).bodies.length === 2, 'Ctrl+click puts Cap with Base again')

// Dragged together: one picked row dragged carries the other.
await drag(`[data-test=body-row][data-body="${id.Base}"]`, `[data-test=body-folder][data-folder="${frame}"]`)
await sleep(150)
folders = await re(() => window.__re.store.getState().bodyFolders)
const frameNow = folders.find((f) => f.id === frame)
check(frameNow?.bodies.includes(id.Base) && frameNow?.bodies.includes(id.Cap), `both picked rows dragged onto Frame are in it (${JSON.stringify(folders)})`)
check(!folders.find((f) => f.name === 'Drive').bodies.includes(id.Cap), 'Cap came out of Drive to go there')
check((await picks()).bodies.length === 2, 'and they stay picked')

// The right click on a picked row is for both.
await (await page.$(`[data-test=body-row][data-body="${id.Cap}"]`)).click({ button: 'right' })
await page.waitForSelector('[data-test=body-menu]')
check((await page.$eval('[data-test=body-menu] .re-menu-head', (e) => e.textContent)) === '2 bodies', 'the menu of a picked row is for every row picked')
check((await page.$eval('[data-test=body-menu-move-bodies]', (e) => e.textContent)) === 'Move 2 bodies', 'and offers to move them together')
await page.keyboard.press('Escape')
await sleep(100)

// ---- moved together ---------------------------------------------------------------------------
await click(page, '[data-test=body-selection-move]')
await page.waitForSelector('[data-test=move-body-editor]')
let draft = await re(() => window.__re.store.getState().featureDraft)
check(JSON.stringify([...draft.bodies].sort()) === JSON.stringify([id.Base, id.Cap].sort()), `Move opens on both picked bodies (${draft.bodies})`)
check((await page.$eval('[data-test=move-body-bodies]', (e) => e.textContent)).includes('Base, Cap'), 'and the box names them')
await page.click(rowName(id.Shaft))
await sleep(100)
draft = await re(() => window.__re.store.getState().featureDraft)
check(draft.bodies.includes(id.Shaft) && draft.bodies.length === 3, 'a click on a row puts its body into the Move')
await page.click(rowName(id.Shaft))
await sleep(100)
draft = await re(() => window.__re.store.getState().featureDraft)
check(!draft.bodies.includes(id.Shaft) && draft.bodies.length === 2, 'and a second click takes it out')
await page.screenshot({ path: shotPath('reverse-body-tree-move.png') })
// Cap's row clicked takes Cap out: the gizmo goes to Base's middle, clear
// of Shaft. Then, on the part, a click on Shaft puts it in.
await page.click(rowName(id.Cap))
await sleep(200)
draft = await re(() => window.__re.store.getState().featureDraft)
check(JSON.stringify(draft.bodies) === JSON.stringify([id.Base]), `a click on a row of the Move takes it out (${draft.bodies})`)
const shaftAt = await topOf('Shaft')
await page.mouse.move(shaftAt[0] - 4, shaftAt[1] - 4)
await sleep(60)
await page.mouse.move(shaftAt[0], shaftAt[1])
await sleep(300)
check((await re(() => window.__re.scene().grips.hoveredHandle)) == null, 'no grip of the gizmo is under the cursor on Shaft')
await page.mouse.click(shaftAt[0], shaftAt[1])
await sleep(200)
draft = await re(() => window.__re.store.getState().featureDraft)
check(draft.bodies.includes(id.Shaft) && draft.bodies.length === 2, `a click on Shaft on the part puts it into the Move too (${draft.bodies})`)
check(/\bselected\b/.test(await rowClass('Shaft')), "and its row says it is in")
await page.screenshot({ path: shotPath('reverse-body-tree-move.png') })
await page.keyboard.press('Escape')
await sleep(100)
check((await re(() => window.__re.store.getState().featureDraft)) === null, 'Escape closes the Move')

await finish(browser, consoleErrors)
