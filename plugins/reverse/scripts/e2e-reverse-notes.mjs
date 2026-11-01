// SPDX-License-Identifier: AGPL-3.0-only
// End-to-end check of the notes the person pins on the part for an agent: an
// MCP client starts scanruler-mcp, the app in headless Chrome is paired with
// it — which switches the agent connection on — a box-shaped scan is opened
// and a block modelled inside it through the tools. Then, as the person: the
// Note key, a click on the block's top face and a sentence typed into the
// box by the pin; two edges picked with Ctrl and a note made on them from
// the keys by the selection; a note on the scan above the block. As the
// agent: reverse_note_list finds the face and the edges by the indices
// reverse_body_describe gives, and the face nearest the note on the scan,
// session_state lists the open notes,
// a picture of the view (view_render) has the pins in it, and
// reverse_note_resolve answers a note — its row in the panel greyed with the
// answer under it; rebuilt taller, the block's top face is still found. The
// agent pins a question of its own on the top face (reverse_note_add), the
// person answers it in its box, and the agent reads the answer in
// session_state and closes the question. The agent fits a plane on the scan,
// which puts 3D Measure on screen: the pins stay on the part. Back in the
// workspace with the elements shown, a note placed on the plane drawn over
// the part lands on the part, not on the plane; and the agent opening the
// same scan again leaves the notes where they are. Two projects of the part,
// one saved with the notes and one without: each opened brings its own. A
// click on a pin's badge opens its note; Escape puts the Note key down; the
// view bar's Notes key puts the pins away and a note opened brings them back; the
// connection switched off in Settings takes the list and the pins away.
//
// Prereqs: dev server running (npm run dev), Chrome, and the server's
// dependencies (npm --prefix mcp ci).
//   node plugins/reverse/scripts/e2e-reverse-notes.mjs
// Env: APP_URL, CHROME, OUT_DIR.
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { check, fail, finish, launchAgent, launchApp, OUT_DIR, repoFile, shotPath, sleep } from '../../../scripts/e2e-lib.mjs'
import { reverseHelpers } from './lib.mjs'

if (!existsSync(repoFile('mcp/node_modules/@modelcontextprotocol/sdk/package.json'))) {
  console.error('FATAL: the MCP server has no dependencies yet — run npm --prefix mcp ci.')
  process.exit(1)
}
const { startAgent } = await import('../../../mcp/tests/client.js')

/** A box from `lo` to `hi` as a binary STL, each side a grid of `n` × `n`
 *  squares, its triangles facing out — the scan the block is modelled in, 4
 *  mm higher than the block, fine enough for a plane to be fitted on it. */
function boxStl(lo, hi, n = 12) {
  const tris = []
  // Each side: an axis it faces along, the side it is on, and two axes
  // across it, in the order that faces it out.
  for (const [axis, side, u, v] of [[0, 0, 2, 1], [0, 1, 1, 2], [1, 0, 0, 2], [1, 1, 2, 0], [2, 0, 1, 0], [2, 1, 0, 1]]) {
    const at = (i, j) => {
      const p = [0, 0, 0]
      p[axis] = side ? hi[axis] : lo[axis]
      p[u] = lo[u] + ((hi[u] - lo[u]) * i) / n
      p[v] = lo[v] + ((hi[v] - lo[v]) * j) / n
      return p
    }
    for (let i = 0; i < n; i++)
      for (let j = 0; j < n; j++) {
        tris.push([at(i, j), at(i + 1, j), at(i + 1, j + 1)], [at(i, j), at(i + 1, j + 1), at(i, j + 1)])
      }
  }
  const buf = Buffer.alloc(84 + tris.length * 50)
  buf.writeUInt32LE(tris.length, 80)
  tris.forEach((t, i) => {
    const o = 84 + i * 50
    t.forEach((p, k) => p.forEach((x, j) => buf.writeFloatLE(x, o + 12 + k * 12 + j * 4)))
  })
  return buf
}
const scanPath = join(mkdtempSync(join(tmpdir(), 'scanruler-notes-')), 'box-scan.stl')
writeFileSync(scanPath, boxStl([-2, -2, 0], [42, 22, 14]))

const { agent } = await launchAgent(startAgent)
const { call } = agent

/** A call that should succeed: its JSON, or a failure with what it said. */
async function ok(name, input, what) {
  const r = await call(name, input)
  if (r.error) fail(`${what ?? name}: ${r.text}`)
  return r
}

const link = /(\S+#agent=\d+:[\w-]+)/.exec((await call('scanruler_status')).json?.howToConnect ?? '')?.[1]
check(Boolean(link), `the server hands out a pairing link (${link})`)
const { browser, page, consoleErrors } = await launchApp({ url: link, width: 1500, height: 950, protocolTimeout: 300_000 })
try {
  const waited = await call('scanruler_wait', { for: 'page', timeoutSeconds: 60 })
  check(waited.json?.connected === true, 'the page connected')
  const tools = (await agent.client.listTools()).tools.map((t) => t.name)
  check(tools.includes('reverse_note_list') && tools.includes('reverse_note_resolve'), 'reverse_note_list and reverse_note_resolve are among the tools')

  const scan = await ok('scan_open', { path: scanPath, units: 'mm' })
  check(scan.json?.scan?.triangles === 1728, `scan_open: the box scan, ${scan.json?.scan?.triangles} triangles`)
  await ok('workspace_set', { workspace: 'reverse' })
  await page.waitForFunction(() => /ready/.test(document.querySelector('[data-test=kernel-status]')?.textContent ?? ''), { timeout: 180_000 })

  // ---- the block, through the tools ----------------------------------------------
  await ok('reverse_feature_add', {
    feature: {
      kind: 'sketch',
      name: 'Base',
      plane: { kind: 'world', axis: 'z' },
      sketch: {
        entities: [
          { id: 1, kind: 'line', a: [0, 0], b: [40, 0] },
          { id: 2, kind: 'line', a: [40, 0], b: [40, 20] },
          { id: 3, kind: 'line', a: [40, 20], b: [0, 20] },
          { id: 4, kind: 'line', a: [0, 20], b: [0, 0] },
        ],
        constraints: [
          { kind: 'coincident', p: { entity: 1, at: 'b' }, q: { entity: 2, at: 'a' } },
          { kind: 'coincident', p: { entity: 2, at: 'b' }, q: { entity: 3, at: 'a' } },
          { kind: 'coincident', p: { entity: 3, at: 'b' }, q: { entity: 4, at: 'a' } },
          { kind: 'coincident', p: { entity: 4, at: 'b' }, q: { entity: 1, at: 'a' } },
        ],
      },
    },
  })
  const made = await ok('reverse_feature_add', { feature: { kind: 'extrude', name: 'Block', sketchId: 'Base', extent: { kind: 'distance', from: 0, to: 10 }, op: 'new' } })
  const body = made.json?.bodies?.changed?.[0]
  check(body?.closed, `the block is built: ${body?.name}`)
  await ok('view_set', { view: 'iso', fit: true })
  const described = await ok('reverse_body_describe', { body: body?.id ?? 0 })
  const faces = described.json?.bodies?.[0]?.faceList ?? []
  const edges = described.json?.bodies?.[0]?.edgeList ?? []
  const top = faces.find((f) => f.kind === 'plane' && f.normal?.[2] === 1)
  const front = edges.find((e) => e.mid[1] === 0 && e.mid[2] === 10)
  const right = edges.find((e) => e.mid[0] === 40 && e.mid[2] === 10)
  check(top && front && right, `body_describe: the top face ${top?.index}, its front edge ${front?.index} and right edge ${right?.index}`)

  // ---- the person's notes ----------------------------------------------------------
  const { re, screen } = reverseHelpers(page)
  const notes = () => re(() => window.__reNotes.getState().notes.map((n) => ({ id: n.id, text: n.text, on: n.on.map((t) => t.kind), done: !!n.done, reply: n.reply ?? null })))
  check(Boolean(await page.$('[data-test=note-list]')), 'the panel has Notes for the agent while the connection is on')
  await page.click('[data-test=note-add]')
  await sleep(150)
  check((await page.$eval('[data-test=note-add]', (b) => b.getAttribute('aria-pressed'))) === 'true', 'the Note key is in hand')
  const [tx, ty] = await screen([12, 8, 10])
  await page.mouse.move(tx, ty)
  await sleep(200)
  await page.mouse.click(tx, ty)
  await page.waitForSelector('[data-test=note-card]', { timeout: 5000 }).catch(() => {})
  const head = await page.$eval('[data-test=note-card] .notecard-head', (e) => e.textContent).catch(() => null)
  check(head === '1on a flat face of Solid 1' || /flat face of/.test(head ?? ''), `a click on the top face opens the note's box: "${head}"`)
  await page.keyboard.type('Pocket Ø8, 3 deep, centred here')
  await page.screenshot({ path: shotPath('notes-1-typing.png') })
  await page.keyboard.press('Enter')
  await sleep(200)
  check(!(await page.$('[data-test=note-card]')), 'Enter keeps the note and shuts the box')
  let now = await notes()
  check(now.length === 1 && now[0].text === 'Pocket Ø8, 3 deep, centred here' && now[0].on.join() === 'face', `the note is on the face: ${JSON.stringify(now)}`)

  // Two edges picked with Ctrl, a note from the keys by the selection.
  const [fx, fy] = await screen(front.mid)
  const [rx, ry] = await screen(right.mid)
  await page.mouse.move(fx, fy)
  await sleep(200)
  await page.mouse.click(fx, fy)
  await sleep(250)
  await page.keyboard.down('Control')
  await page.mouse.move(rx, ry)
  await sleep(200)
  await page.mouse.click(rx, ry)
  await page.keyboard.up('Control')
  await page.waitForSelector('[data-test=chip-note]', { timeout: 5000 }).catch(() => {})
  check(Boolean(await page.$('[data-test=chip-note]')), 'the keys by a selection offer Note')
  await page.click('[data-test=chip-note]').catch(() => {})
  await page.waitForSelector('[data-test=note-card]', { timeout: 5000 }).catch(() => {})
  await page.keyboard.type('Fillet both R2')
  await page.click('[data-test=note-keep]').catch(() => {})
  await sleep(200)
  now = await notes()
  check(now.length === 2 && now[1].on.join() === 'edge,edge', `the second note is on the two edges: ${JSON.stringify(now[1])}`)

  // On the scan above the block, the bodies put away so the scan is what
  // the click meets.
  await ok('view_set', { show: { bodies: false } })
  await page.click('[data-test=note-add]')
  const [sx, sy] = await screen([30, 15, 14])
  await page.mouse.move(sx, sy)
  await sleep(200)
  await page.mouse.click(sx, sy)
  await page.waitForSelector('[data-test=note-card]', { timeout: 5000 }).catch(() => {})
  await page.keyboard.type('A boss up to the scan here')
  await page.keyboard.press('Enter')
  await sleep(200)
  await ok('view_set', { show: { bodies: true } })
  now = await notes()
  check(now.length === 3 && now[2].on.join() === 'scan', `the third note is on the scan: ${JSON.stringify(now[2])}`)
  const rows = await page.$$eval('[data-test=note-row]', (els) => els.map((e) => e.textContent.replace(/\s+/g, ' ').trim()))
  check(rows.length === 3 && /2 edges of Solid 1/.test(rows[1]) && /on the scan/.test(rows[2]), `the rows say what each is on: ${JSON.stringify(rows)}`)
  await page.screenshot({ path: shotPath('notes-2-pinned.png') })

  // ---- the agent reads them ------------------------------------------------------
  const listed = await ok('reverse_note_list', {})
  const [n1, n2, n3] = listed.json?.notes ?? []
  check(n1?.on?.[0]?.face?.index === top?.index && n1.on[0].face.madeBy?.name === 'Block', `reverse_note_list: note 1 on face ${n1?.on?.[0]?.face?.index}, made by ${n1?.on?.[0]?.face?.madeBy?.name}`)
  check(Math.abs((n1?.at?.[2] ?? 0) - 10) < 1e-3, `its pin on the top, z ${n1?.at?.[2]}`)
  const edgeIds = (n2?.on ?? []).map((o) => o.edge?.index).sort((a, b) => a - b)
  check(JSON.stringify(edgeIds) === JSON.stringify([front.index, right.index].sort((a, b) => a - b)), `note 2 on edges ${edgeIds}`)
  check(n3?.on?.[0]?.scan === true && n3.nearest?.face === top?.index && Math.abs(n3.nearest.distance - 4) < 0.05, `note 3 on the scan, ${n3?.nearest?.distance?.toFixed(3)} mm above face ${n3?.nearest?.face}`)
  const state = await ok('session_state', {})
  const brief = state.json?.plugins?.reverse?.notes
  check(brief?.open?.length === 3 && brief.done === 0 && brief.open[0].on[0].startsWith(`face ${top?.index} of`), `session_state lists the open notes: ${JSON.stringify(brief?.open?.map((o) => o.on))}`)

  // The pins are in the picture the agent gets: amber badges.
  const picture = await ok('view_render', { width: 800, height: 600, path: shotPath('notes-agent-view.png') })
  const amber = await page.evaluate(async (b64) => {
    const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
    const img = await createImageBitmap(new Blob([bin], { type: 'image/png' }))
    const c = new OffscreenCanvas(img.width, img.height)
    const g = c.getContext('2d')
    g.drawImage(img, 0, 0)
    const d = g.getImageData(0, 0, img.width, img.height).data
    let n = 0
    for (let i = 0; i < d.length; i += 4) if (Math.abs(d[i] - 242) < 14 && Math.abs(d[i + 1] - 165) < 14 && Math.abs(d[i + 2] - 22) < 20) n++
    return n
  }, picture.images?.[0]?.data ?? '')
  check(amber > 100, `view_render shows the pins: ${amber} amber pixels`)

  // ---- the agent answers -----------------------------------------------------------
  const answered = await ok('reverse_note_resolve', { note: 1, reply: 'Cut the pocket as Pocket 1.' })
  check(answered.json?.note?.done === true, 'reverse_note_resolve marks note 1 handled')
  await sleep(200)
  const row1 = await page.$eval('[data-test=note-row]', (e) => ({ done: e.classList.contains('done'), reply: e.querySelector('[data-test=note-row-reply]')?.textContent ?? null }))
  check(row1.done && row1.reply === 'Agent: Cut the pocket as Pocket 1.', `its row is greyed with the answer: ${JSON.stringify(row1)}`)
  check((await page.$eval('[data-test=note-count]', (e) => e.textContent)) === '2 open', 'the heading counts two open notes')
  const open = await ok('reverse_note_list', {})
  check(open.json?.notes?.map((x) => x.id).join() === '2,3', 'the open notes are notes 2 and 3')

  // Rebuilt taller, the top face is found again.
  await ok('reverse_feature_update', { feature: 'Block', set: { extent: { kind: 'distance', from: 0, to: 12 } } })
  const again = await ok('reverse_note_list', { note: 1 })
  check(again.json?.notes?.[0]?.on?.[0]?.face?.centroid?.[2] === 12, `the block 2 mm taller: note 1's face found at z ${again.json?.notes?.[0]?.on?.[0]?.face?.centroid?.[2]}`)

  // ---- the pins in the viewport ----------------------------------------------------
  await sleep(300)
  const badge = await re(() => {
    const pins = window.__re.scene()
    void pins
    const label = [...document.querySelectorAll('[data-test=note-label]')].find((e) => e.textContent.startsWith('Fillet'))
    const r = label?.getBoundingClientRect()
    return r ? [r.left - 22, r.top + r.height / 2] : null
  })
  if (badge) {
    await page.mouse.move(badge[0], badge[1])
    await sleep(200)
    await page.mouse.click(badge[0], badge[1])
    await page.waitForSelector('[data-test=note-card]', { timeout: 3000 }).catch(() => {})
  }
  const opened = await page.$eval('[data-test=note-text]', (e) => e.value).catch(() => null)
  check(opened === 'Fillet both R2', `a click on note 2's badge opens it: "${opened}"`)
  await page.screenshot({ path: shotPath('notes-3-pin-opened.png') })
  await page.keyboard.press('Escape')
  await sleep(150)
  check(!(await page.$('[data-test=note-card]')) && (await notes()).length === 3, 'Escape shuts the box and keeps the note')

  await page.click('[data-test=note-add]')
  await sleep(100)
  await page.mouse.move(700, 300)
  await page.keyboard.press('Escape')
  await sleep(100)
  check((await page.$eval('[data-test=note-add]', (b) => b.getAttribute('aria-pressed'))) === 'false', 'Escape puts the Note key down')
  check((await re(() => window.__re.measure.getState().statusText)) === '', 'and the status line no longer asks for a click')

  // ---- the agent's question ----------------------------------------------------------
  const asked = await ok('reverse_note_add', { text: 'Is the top the datum face? Assuming yes.', body: body?.name, faces: [top?.index] })
  const q = asked.json?.note
  check(q?.by === 'agent' && q.on?.[0]?.face?.index === top?.index, `reverse_note_add pins a question on face ${q?.on?.[0]?.face?.index}: note ${q?.id}`)
  await sleep(300)
  const askRow = await page.$$eval('[data-test=note-row]', (els) => {
    const r = els.find((e) => e.classList.contains('agent'))
    return r ? { text: r.textContent.replace(/\s+/g, ' ').trim(), badge: r.querySelector('.notebadge')?.className } : null
  })
  check(askRow && /The agent asks, on a flat face of Solid 1/.test(askRow.text) && /Click to answer/.test(askRow.text) && /agent/.test(askRow.badge), `its row in the panel asks to be answered: ${JSON.stringify(askRow)}`)
  check((await page.$eval('[data-test=note-count]', (e) => e.textContent)) === '2 open · 1 question', 'the heading counts the question beside the two open notes')
  // Scrolled to, as a person would, and clicked.
  await page.evaluate(() => [...document.querySelectorAll('[data-test=note-row]')].find((e) => e.classList.contains('agent'))?.scrollIntoView({ block: 'center' }))
  await sleep(150)
  const askAt = await page.evaluate(() => {
    const r = [...document.querySelectorAll('[data-test=note-row]')].find((e) => e.classList.contains('agent'))?.querySelector('[data-test=note-open]')?.getBoundingClientRect()
    return r ? [r.left + r.width / 2, r.top + r.height / 2] : null
  })
  if (askAt) await page.mouse.click(askAt[0], askAt[1])
  await page.waitForSelector('[data-test=note-card-question]', { timeout: 3000 }).catch(() => {})
  const question = await page.$eval('[data-test=note-card-question]', (e) => e.textContent).catch(() => null)
  check(question === 'Is the top the datum face? Assuming yes.', `the row opens the question's box: "${question}"`)
  await page.keyboard.type('No — the bottom is, it sits on the base plate.')
  const card = await page.$eval('[data-test=note-card]', (e) => {
    const r = e.getBoundingClientRect()
    return { top: r.top, bottom: r.bottom, height: window.innerHeight }
  })
  check(card.top >= 8 && card.bottom <= card.height - 8, `the box stands wholly in the window: ${JSON.stringify(card)}`)
  await page.screenshot({ path: shotPath('notes-5-answering.png') })
  await page.keyboard.press('Enter')
  await sleep(200)
  const after = await ok('session_state', {})
  const answeredNotes = after.json?.plugins?.reverse?.notes?.answered ?? []
  check(answeredNotes.length === 1 && answeredNotes[0].reply === 'No — the bottom is, it sits on the base plate.', `session_state hands the agent the answer: ${JSON.stringify(answeredNotes.map((a) => a.reply))}`)
  const closed = await ok('reverse_note_resolve', { note: q?.id })
  check(closed.json?.note?.done === true, 'reverse_note_resolve closes the question')
  await sleep(200)
  const closedRow = await page.$$eval('[data-test=note-row]', (els) => els.find((e) => e.classList.contains('agent'))?.className ?? '')
  check(/done/.test(closedRow), 'its row goes grey')

  // ---- the agent elsewhere, the elements shown, the scan opened again -------------------
  const visibleLabels = () => re(() => [...document.querySelectorAll('[data-test=note-label]')].filter((e) => e.style.display !== 'none' && getComputedStyle(e).display !== 'none').length)
  const before = await visibleLabels()
  const plane = await ok('element_fit', { kind: 'plane', at: { point: [30, 15, 14] } })
  await sleep(400)
  const where = await re(() => window.__re.measure.getState() && document.querySelector('[data-test=workspace-elements]')?.getAttribute('aria-selected'))
  const during = await visibleLabels()
  check(plane.json?.element && during === before && during > 0, `with 3D Measure on screen for the agent's fit (tab selected: ${where}) the pins stay: ${during} of ${before} labels`)
  await page.screenshot({ path: shotPath('notes-6-in-measure.png') })
  await ok('workspace_set', { workspace: 'reverse' })
  await sleep(300)
  if ((await page.$eval('[data-test=toggle-elements]', (b) => b.getAttribute('aria-pressed'))) !== 'true') await page.click('[data-test=toggle-elements]')
  await sleep(300)
  const notesBefore = (await notes()).length
  const [px, py] = await screen([20, 3, 14])
  // Without the Note key the same click takes the plane: it is under the
  // cursor.
  await page.mouse.move(px, py)
  await sleep(200)
  await page.mouse.click(px, py)
  await sleep(200)
  const plain = await re(() => window.__re.store.getState().selection?.kind ?? null)
  check(plain === 'element', `without the Note key that click takes the plane element (selection: ${plain})`)
  await page.keyboard.press('Escape')
  await page.click('[data-test=note-add]')
  await page.mouse.move(px, py)
  await sleep(200)
  await page.mouse.click(px, py)
  await page.waitForSelector('[data-test=note-card]', { timeout: 3000 }).catch(() => {})
  const selection = await re(() => window.__re.store.getState().selection?.kind ?? null)
  check(Boolean(await page.$('[data-test=note-card]')) && selection === null, `with the elements shown, a click on the plane drawn over the part pins a note (selection: ${selection})`)
  await page.keyboard.type('Over the plane element')
  await page.keyboard.press('Enter')
  await sleep(200)
  const placed = await notes()
  check(placed.length === notesBefore + 1 && ['face', 'scan'].includes(placed[placed.length - 1].on[0]), `the note is on the part under the plane: ${JSON.stringify(placed[placed.length - 1])}`)

  const reopened = await ok('scan_open', { path: scanPath, units: 'mm', discard: true })
  await sleep(500)
  const after2 = await notes()
  check(reopened.json?.scan?.triangles === 1728 && after2.length === placed.length, `the same scan opened again keeps the notes: ${after2.length} of ${placed.length}`)

  // ---- the view bar's Notes key ---------------------------------------------------------
  const labelsShown = () => re(() => [...document.querySelectorAll('[data-test=note-label]')].filter((e) => e.style.display !== 'none').length)
  const pinCount = await labelsShown()
  check(pinCount > 0 && Boolean(await page.$('[data-test=toggle-notes]')), `the view bar has a Notes key, with ${pinCount} pins on the part`)
  await page.click('[data-test=toggle-notes]')
  await sleep(300)
  check((await labelsShown()) === 0, 'the key puts the pins away')
  check((await notes()).length === after2.length, 'and the notes stay')
  await page.screenshot({ path: shotPath('notes-3-pins-away.png') })
  check((await ok('reverse_note_list', { all: true })).json?.notes?.length === after2.length, 'and the agent still reads them')
  await ok('view_render', { show: { notes: true }, width: 320 })
  await sleep(300)
  check((await labelsShown()) === 0, 'a picture that shows them puts them back as the person left them')
  await page.click('[data-test=toggle-notes]')
  await sleep(300)
  check((await labelsShown()) === pinCount, 'the key brings them back')
  await page.click('[data-test=toggle-notes]')
  await sleep(200)
  await page.click('[data-test=note-open]')
  await sleep(300)
  check((await labelsShown()) === pinCount, 'and so does opening a note')
  await page.keyboard.press('Escape')
  await sleep(200)

  // ---- two projects of the part --------------------------------------------------------
  // Saved under the scan's name, each in a folder of its own.
  const saveIn = async () => (await ok('project_save', { path: mkdtempSync(join(tmpdir(), 'scanruler-notes-project-')) })).json?.file?.path
  const withNotes = await saveIn()
  await re(() => window.__reNotes.getState().load([]))
  const without = await saveIn()
  const counts = []
  for (const file of [withNotes, without, withNotes]) {
    await ok('project_load', { path: file, discard: true })
    await sleep(300)
    counts.push((await notes()).length)
  }
  check(counts.join() === `${after2.length},0,${after2.length}`, `each project opened brings its own notes — with, without, with: ${counts.join(', ')}`)

  // ---- the connection switched off --------------------------------------------------
  await page.click('[data-test=open-settings]')
  await page.waitForSelector('[data-test=toggle-agent-link]')
  await page.click('[data-test=toggle-agent-link]')
  await page.click('[data-test=settings-close]')
  await sleep(300)
  const hidden = await re(() => ({ list: !!document.querySelector('[data-test=note-list]'), labels: [...document.querySelectorAll('[data-test=note-label]')].filter((e) => e.style.display !== 'none').length }))
  check(!hidden.list && hidden.labels === 0, `the connection off takes the list and the pins away: ${JSON.stringify(hidden)}`)
  check((await notes()).length === 5, 'the notes are kept')
  await page.screenshot({ path: shotPath('notes-4-off.png') })
} catch (e) {
  fail(`threw: ${e instanceof Error ? e.stack : String(e)}`)
} finally {
  console.log(`pictures in ${OUT_DIR}`)
  await agent.close?.()
  await finish(browser, consoleErrors)
}
