// SPDX-License-Identifier: AGPL-3.0-only
// Real keyboard focus across the app's modal windows, including a warning
// nested above Settings. Nonmodal tool windows remain outside this contract.
import { launchApp, check, click, fail, finish, shotPath } from './e2e-lib.mjs'

const { browser, page, consoleErrors } = await launchApp({ agentDataOk: false })
const settings = '[data-test=settings-modal]'
const warning = '[data-test=agent-data-warning]'
const units = '[data-test=units-modal]'
const inside = (selector) => page.$eval(selector, (el) => el.contains(document.activeElement))
const activeIs = (selector) => page.$eval(selector, (el) => el === document.activeElement)
const turn = () => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))

async function tabEdges(selector, name) {
  const focusEdge = (last) => page.$eval(selector, (el, last) => {
    const controls = [...el.querySelectorAll('button, input, select, textarea, a[href], [tabindex]')]
      .filter((c) => c.tabIndex >= 0 && !c.disabled && c.getClientRects().length > 0)
    const target = last ? controls.at(-1) : controls[0]
    if (!target) throw new Error('No focusable control in the test dialog')
    target.focus()
  }, last)
  await focusEdge(true)
  await page.keyboard.press('Tab')
  check(await inside(selector), `${name}: Tab stays in the dialog after its last control`)
  await focusEdge(false)
  await page.keyboard.down('Shift')
  try { await page.keyboard.press('Tab') } finally { await page.keyboard.up('Shift') }
  check(await inside(selector), `${name}: Shift+Tab stays in the dialog before its first control`)
  await page.focus('[data-test=open-settings]')
  check(await inside(selector), `${name}: background controls cannot take focus`)
}

async function askUnits() {
  await page.evaluate(async () => {
    const { askMeshUnits } = await import('/src/state/unitsPromptStore.ts')
    window.__modalUnitsResult = 'pending'
    void askMeshUnits('keyboard.stl').then((value) => { window.__modalUnitsResult = value })
  })
  await page.waitForSelector(units)
  await turn()
}

try {
  await page.evaluate(async () => {
    const { useStore } = await import('/src/state/store.ts')
    useStore.getState().startDraft('plane')
    useStore.getState().setDraftPicks([[1, 2, 3]])
    window.__modalDraft = useStore.getState().draft
  })
  await click(page, '[data-test=open-settings]')
  await page.waitForSelector(settings)
  await turn()
  check(await inside(settings), 'Settings receives focus when opened')
  await page.screenshot({ path: shotPath('modal-settings.png') })
  await tabEdges(settings, 'Settings')

  await click(page, '[data-test=toggle-agent-link]')
  await page.waitForSelector(warning)
  await turn()
  check(await inside(warning), 'the nested agent warning receives focus')
  await tabEdges(warning, 'Agent warning')
  await page.focus('[data-test=toggle-agent-link]')
  check(await inside(warning), 'the underlying Settings dialog is also inactive')
  await page.keyboard.press('Escape')
  await page.waitForSelector(warning, { hidden: true })
  check(!!(await page.$(settings)), 'Escape closes only the top dialog')
  check(await activeIs('[data-test=toggle-agent-link]'), 'nested dismissal restores focus to its Settings control')
  await page.keyboard.press('Escape')
  await page.waitForSelector(settings, { hidden: true })
  check(await activeIs('[data-test=open-settings]'), 'Settings restores focus to its opener')
  check(await page.evaluate(async () => (await import('/src/state/store.ts')).useStore.getState().draft === window.__modalDraft),
    'closing nested dialogs leaves the underlying picked draft unchanged')

  await askUnits()
  check(await inside(units), 'the units question receives focus')
  await tabEdges(units, 'Units')
  await page.focus('[data-test=units-cancel]')
  await page.keyboard.press('Enter')
  await page.waitForSelector(units, { hidden: true })
  check(await page.evaluate(() => window.__modalUnitsResult === null), 'Enter on Cancel cancels the units question')
  await askUnits()
  await page.focus('[data-test=units-in]')
  await page.keyboard.press('Enter')
  check(await page.evaluate(() => window.__modalUnitsResult === 'pending'), 'Enter on a unit selects it without opening the file')
  check(await page.$eval('[data-test=units-in]', (el) => el.getAttribute('aria-checked') === 'true'), 'the focused unit is selected')
  await page.focus('[data-test=units-open]')
  await page.keyboard.press('Enter')
  await page.waitForSelector(units, { hidden: true })
  check(await page.evaluate(() => window.__modalUnitsResult === 'in'), 'Enter on Open answers with the selected units')

  await click(page, '.stripimprint')
  await page.waitForSelector('.modal.imprint')
  await turn()
  check(await inside('.modal.imprint'), 'Imprint receives focus')
  await tabEdges('.modal.imprint', 'Imprint')
  await page.keyboard.press('Escape')
  await page.waitForSelector('.modal.imprint', { hidden: true })
  check(await activeIs('.stripimprint'), 'Imprint restores focus to its opener')

  await page.focus('[data-test=open-settings]')
  await page.evaluate(async () => {
    const { usePrefs } = await import('/src/state/prefsStore.ts')
    const { useSupportAsk } = await import('/src/state/supportAskStore.ts')
    usePrefs.setState({ supportCard: true, supportAsk: true, supportAskOffUntil: 0 })
    useSupportAsk.getState().ask()
  })
  await page.waitForSelector('[data-test=support-ask]')
  await turn()
  check(await inside('[data-test=support-ask]'), 'the support dialog receives focus')
  await tabEdges('[data-test=support-ask]', 'Support')
  await page.keyboard.press('Escape')
  await page.waitForSelector('[data-test=support-ask]', { hidden: true })
  check(await activeIs('[data-test=open-settings]'), 'the support dialog restores prior focus')
  check(await page.evaluate(async () => (await import('/src/state/store.ts')).useStore.getState().draft === window.__modalDraft),
    'all modal interactions preserve the underlying draft')

  await click(page, '.panel .infodot')
  await page.waitForSelector('.infocard')
  await askUnits()
  await page.keyboard.press('Escape')
  await page.waitForSelector(units, { hidden: true })
  check(!!(await page.$('.infocard')), 'Escape in a modal leaves a background help popover open')
  await page.keyboard.press('Escape')
  await page.waitForSelector('.infocard', { hidden: true })
  check(await page.evaluate(async () => (await import('/src/state/store.ts')).useStore.getState().draft === window.__modalDraft),
    'the help popover still owns Escape after the modal closes')

  await page.evaluate(async () => {
    const { useStore } = await import('/src/state/store.ts')
    useStore.getState().cancelDraft()
    const dataTransfer = new DataTransfer()
    dataTransfer.items.add(new File(['v 0 0 0\nv 10 0 0\nv 0 10 0\nf 1 2 3\n'], 'modal-menu.obj'))
    window.dispatchEvent(new DragEvent('drop', { dataTransfer, bubbles: true, cancelable: true }))
  })
  await page.waitForFunction(() => /[1-9][\d,]* triangles/.test(document.querySelector('.file-info')?.textContent ?? ''))
  await click(page, '[data-test=export-mesh]')
  await page.waitForSelector('[data-test=export-mesh-stl]')
  await askUnits()
  await page.keyboard.press('Escape')
  await page.waitForSelector(units, { hidden: true })
  check(await page.$eval('[data-test=export-mesh]', (el) => el.getAttribute('aria-expanded') === 'true'), 'Escape in a modal leaves a background export menu open')
  await page.keyboard.press('Escape')
  await page.waitForSelector('[data-test=export-mesh-stl]', { hidden: true })
  check(true, 'the export menu still owns Escape after the modal closes')
} catch (e) { fail(e.stack ?? String(e)) }
finally { await finish(browser, consoleErrors) }
