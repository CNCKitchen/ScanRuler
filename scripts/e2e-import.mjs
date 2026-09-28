// SPDX-License-Identifier: AGPL-3.0-only
// No external scan fixtures: exercises the real drop handler, workers, scene,
// project reader and project writer with generated meshes and images.
import { launchApp, check, fail, finish } from './e2e-lib.mjs'

const { browser, page, consoleErrors } = await launchApp()
page.on('dialog', (dialog) => dialog.accept())
try {
  const checks = await page.evaluate(async () => {
    const { useStore } = await import('/src/state/store.ts')
    const { useDeviation } = await import('/src/state/deviationStore.ts')
    const { useFlat } = await import('/src/state/flatStore.ts')
    const { useShell } = await import('/src/state/shellStore.ts')
    const { collectProject, emptySources } = await import('/src/app/project.ts')
    const { packProject, unpackProject } = await import('/src/core/project/archive.ts')
    const { SceneManager } = await import('/src/viewer/SceneManager.ts')
    const { MeshWorkerClient } = await import('/src/core/workerClient.ts')
    const results = []
    const record = (ok, name) => results.push({ ok: !!ok, name })
    const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
    let step = 0
    const wait = async (predicate) => {
      const currentStep = ++step
      for (let i = 0; i < 600; i++) {
        await pause(20)
        if (predicate()) return
      }
      throw new Error(`Import step ${currentStep} did not settle: ${JSON.stringify({ name: useStore.getState().fileName, busy: useStore.getState().busy, status: useStore.getState().statusText, error: useStore.getState().errorText, results })}`)
    }
    const drop = (file) => {
      const dataTransfer = new DataTransfer()
      dataTransfer.items.add(file)
      window.dispatchEvent(new DragEvent('drop', { dataTransfer, bubbles: true, cancelable: true }))
    }
    const aText = 'v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n'
    const bText = 'v 0 0 0\nv 1 0 0\nv 0 1 0\nv 1 1 0\nf 1 2 3\nf 2 4 3\n'
    const bytes = (text) => new TextEncoder().encode(text)
    const blank = collectProject(emptySources(), null, 'test').manifest
    const slow = new File([aText], 'slow-A.obj')
    const read = slow.arrayBuffer.bind(slow)
    slow.arrayBuffer = async () => { await pause(250); return read() }
    drop(slow)
    drop(new File([bText], 'fast-B.obj'))
    await wait(() => !useStore.getState().busy && useStore.getState().fileName === 'fast-B.obj')
    record(useStore.getState().triangleCount === 2, 'overlapping drops finish with B filename and B geometry')

    const point = { id: 90, kind: 'point', name: 'Keep this measurement', color: '#ff8800', source: { type: 'picked' }, status: 'done', visible: true,
      fit: { kind: 'point', center: [0, 0, 0], sigma: 0, usedPoints: 0, regionSize: 0 } }
    useStore.setState({ elements: [point], nextId: 91 })
    const beforeElements = useStore.getState().elements
    drop(new File(['not a mesh'], 'broken.obj'))
    await wait(() => !useStore.getState().busy && !!useStore.getState().errorText)
    record(useStore.getState().fileName === 'fast-B.obj' && useStore.getState().triangleCount === 2 && useStore.getState().elements === beforeElements,
      'failed scan import preserves filename, geometry counts and measurements')

    const beforeCancel = useStore.getState()
    const confirm = window.confirm
    window.confirm = () => false
    try {
      drop(new File([packProject(blank, [])], 'cancelled.scanruler'))
      await pause(100)
      record(useStore.getState() === beforeCancel, 'cancelling project replacement preserves state and status')
    } finally { window.confirm = confirm }

    const sources = { scan: { name: 'replacement.obj', bytes: bytes(aText) }, reference: null, image: null }
    const candidate = collectProject(sources, null, 'test')
    candidate.manifest.scan.fileName = 'replacement.obj'
    candidate.manifest.deviation.reference = { fileName: 'broken.obj', member: 'reference.obj' }
    candidate.members.push({ name: 'reference.obj', bytes: bytes('broken reference') })
    drop(new File([packProject(candidate.manifest, candidate.members)], 'broken-reference.scanruler'))
    await wait(() => !useStore.getState().busy && !!useStore.getState().errorText)
    record(useStore.getState().elements === beforeElements && useStore.getState().fileName === 'fast-B.obj' && useStore.getState().triangleCount === 2,
      'failure in a project reference does not install its already-prepared scan')

    candidate.manifest.deviation.reference = null
    candidate.manifest.flat.image = { fileName: 'broken.png', member: 'image.png' }
    candidate.members.push({ name: 'image.png', bytes: bytes('broken image') })
    drop(new File([packProject(candidate.manifest, candidate.members)], 'broken-image.scanruler'))
    await wait(() => !useStore.getState().busy && !!useStore.getState().errorText)
    record(useStore.getState().elements === beforeElements && useStore.getState().fileName === 'fast-B.obj',
      'failure decoding the last project member preserves the current session')

    // Fail scene preparation after worker parsing, before either can commit.
    const prepareMesh = SceneManager.prototype.prepareMesh
    SceneManager.prototype.prepareMesh = () => { throw new Error('test: cannot allocate replacement scene') }
    try {
      drop(new File([aText], 'scene-failure.obj'))
      await wait(() => !useStore.getState().busy && useStore.getState().errorText?.includes('cannot allocate'))
      record(useStore.getState().elements === beforeElements && useStore.getState().fileName === 'fast-B.obj',
        'scene preparation failure preserves measurements and the current scan')
    } finally { SceneManager.prototype.prepareMesh = prepareMesh }

    // Saving after the failed imports must still contain B's original bytes.
    let saved = null
    const createURL = URL.createObjectURL
    const clickAnchor = HTMLAnchorElement.prototype.click
    URL.createObjectURL = (blob) => { saved = blob; return createURL(blob) }
    HTMLAnchorElement.prototype.click = function () { if (!this.download) clickAnchor.call(this) }
    try {
      document.querySelector('[data-test="save-project"]').click()
      await wait(() => saved !== null && !useStore.getState().busy)
      const project = unpackProject(new Uint8Array(await saved.arrayBuffer()))
      record(project.manifest.scan.fileName === 'fast-B.obj' && new TextDecoder().decode(project.members.get(project.manifest.scan.member)) === bText,
        'saving after failure keeps the original bytes paired with their filename')
    } finally { URL.createObjectURL = createURL; HTMLAnchorElement.prototype.click = clickAnchor }

    // A valid aligned project must still measure and render in the saved frame.
    candidate.manifest.flat.image = null
    candidate.manifest.scan.appliedAlignment = { r: [1,0,0,0,1,0,0,0,1], t: [10,0,0] }
    drop(new File([packProject(candidate.manifest, candidate.members)], 'aligned.scanruler'))
    await wait(() => !useStore.getState().busy && useStore.getState().statusText.includes('Project opened'))
    record(useStore.getState().fileName === 'replacement.obj' && useStore.getState().triangleCount === 1 && useStore.getState().modelCenter[0] > 10,
      'a successful project commits its geometry and saved alignment')

    // A bad standalone reference must not clear the scan, either.
    useShell.getState().setWorkspace('deviation')
    drop(new File([bText], 'reference.obj'))
    await wait(() => !useStore.getState().busy && useDeviation.getState().nominalName === 'reference.obj')
    drop(new File(['bad STEP'], 'broken.step'))
    await wait(() => !useStore.getState().busy && !!useStore.getState().errorText)
    record(useStore.getState().fileName === 'replacement.obj' && useDeviation.getState().nominalName === 'reference.obj',
      'failed reference replacement preserves both models')

    const canvas = new OffscreenCanvas(16, 16)
    canvas.getContext('2d').fillRect(0, 0, 16, 16)
    const png = await canvas.convertToBlob({ type: 'image/png' })
    drop(new File([png], 'image.png'))
    await wait(() => !useStore.getState().busy && useFlat.getState().imageName === 'image.png')
    drop(new File(['bad image'], 'broken.png'))
    await wait(() => !useStore.getState().busy && !!useStore.getState().errorText)
    record(useFlat.getState().imageName === 'image.png' && useFlat.getState().imageWidth === 16,
      'failed image replacement preserves the decoded image')

    let workerAfterClear = null
    const commit = MeshWorkerClient.prototype.commitImport
    MeshWorkerClient.prototype.commitImport = async function (slots) {
      await commit.call(this, slots)
      if (slots.scan === null) workerAfterClear = await this.centroid().then(() => 'still loaded', () => 'empty')
    }
    try {
      drop(new File([packProject(blank, [])], 'empty.scanruler'))
      await wait(() => !useStore.getState().busy && useStore.getState().statusText.includes('empty.scanruler'))
      record(useStore.getState().fileName === null && useStore.getState().triangleCount === 0 && useDeviation.getState().nominalName === null && useFlat.getState().imageName === null && workerAfterClear === 'empty',
        'a project with absent members clears old scan, reference, image and worker geometry')
    } finally { MeshWorkerClient.prototype.commitImport = commit }

    // An STL asks what units it is in before it is read; the harness switched
    // the question off for every other script, so it goes on here by hand —
    // through the settings window, which reaches the app's own store whatever
    // module URL the dev server is serving it under; the preference is read
    // back from where it is remembered.
    const modal = () => document.querySelector('[data-test="units-modal"]')
    const press = (id) => document.querySelector(`[data-test="${id}"]`).click()
    const setAsk = async (on, units) => {
      press('open-settings')
      await wait(() => !!document.querySelector('[data-test="settings-modal"]'))
      const box = document.querySelector('[data-test="toggle-ask-stl-units"]')
      if (box.checked !== on) box.click()
      const select = document.querySelector('[data-test="stl-units"]')
      if (select.value !== units) {
        Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(select, units)
        select.dispatchEvent(new Event('change', { bubbles: true }))
      }
      press('settings-close')
      await wait(() => !document.querySelector('[data-test="settings-modal"]'))
    }
    const asks = () => localStorage.getItem('scanruler.askstlunits') !== '0'
    const assumed = () => localStorage.getItem('scanruler.stlunits') ?? 'mm'
    const stlBytes = (size) => {
      const buf = new ArrayBuffer(84 + 50)
      const dv = new DataView(buf)
      dv.setUint32(80, 1, true)
      let off = 84 + 12
      for (const v of [[0, 0, 0], [size, 0, 0], [0, size, 0]]) for (const c of v) { dv.setFloat32(off, c, true); off += 4 }
      return new Uint8Array(buf)
    }
    // Scaled by 25.4 the triangle's bounding box is centred at 12.7; in mm it would be 0.5.
    const inInches = () => useStore.getState().modelCenter[0] > 8 && useStore.getState().modelCenter[0] < 13
    try {
      await setAsk(true, 'mm')
      record(asks() && assumed() === 'mm', 'the settings window switches the units question on')
      drop(new File([stlBytes(1)], 'inches.stl'))
      await wait(() => !!modal())
      record(!useStore.getState().busy && useStore.getState().fileName === null,
        'an STL waits on the units question before anything is read')
      press('units-in')
      press('units-remember')
      press('units-open')
      await wait(() => !useStore.getState().busy && useStore.getState().fileName === 'inches.stl')
      record(inInches() && useStore.getState().statusText.includes('inches'),
        'the answer scales the part to millimetres and the status line says so')
      record(!asks() && assumed() === 'in', "Don't ask again remembers the answer for every STL")
      drop(new File([stlBytes(1)], 'second.stl'))
      await wait(() => !useStore.getState().busy && useStore.getState().fileName === 'second.stl')
      record(!modal() && inInches(), 'with the question off an STL is read in the remembered units without asking')

      await setAsk(true, 'in')
      drop(new File([stlBytes(1)], 'cancelled.stl'))
      await wait(() => !!modal())
      press('units-cancel')
      await pause(100)
      record(!modal() && useStore.getState().fileName === 'second.stl' && !useStore.getState().busy,
        'dismissing the question leaves the file unopened')

      // A project remembers the units its scan was read in and asks nothing.
      const inchProject = collectProject({ scan: { name: 'inch.stl', bytes: stlBytes(1), units: 'in' }, reference: null, image: null }, null, 'test')
      inchProject.manifest.scan.fileName = 'inch.stl'
      drop(new File([packProject(inchProject.manifest, inchProject.members)], 'inch.scanruler'))
      await wait(() => !useStore.getState().busy && useStore.getState().fileName === 'inch.stl')
      record(!modal() && inInches(), 'a project reads its STL in the units it was saved with, without asking')
    } finally {
      await setAsk(false, 'mm')
    }
    return results
  })
  for (const result of checks) check(result.ok, result.name)
} catch (e) {
  fail(e instanceof Error ? e.message : String(e))
} finally {
  await finish(browser, consoleErrors)
}
