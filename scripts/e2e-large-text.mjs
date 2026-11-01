// SPDX-License-Identifier: AGPL-3.0-only
// Text files past what a browser holds as one string (512 MiB), in real Chrome,
// with the time and the memory each took: generated OBJ, ASCII STL and ASCII PLY
// files open with every triangle, and a 3MF that large says it is too large. Far
// too heavy for CI: each file is written to a temporary folder and takes gigabytes
// of memory to open.
//
// Prereqs: a server running (npm run dev, or vite preview), Chrome.
//   node scripts/e2e-large-text.mjs [formats, default obj,stl,ply,3mf] [size in MiB, default 560]
// Env: APP_URL, CHROME.
import { execFileSync } from 'node:child_process'
import { createWriteStream, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import { Zip, ZipDeflate, strToU8 } from 'fflate'
import { check, fail, finish, launchApp, shotPath } from './e2e-lib.mjs'

const formats = (process.argv[2] ?? 'obj,stl,ply,3mf').split(',')
const targetBytes = Number(process.argv[3] ?? 560) * 1024 ** 2

/** Write what `lines` yields, keeping to the stream's pace. */
async function writeLines(path, lines) {
  const out = createWriteStream(path, { highWaterMark: 1 << 24 })
  let batch = []
  let size = 0
  for (const line of lines) {
    batch.push(line)
    size += line.length
    if (size > 1 << 22) {
      if (!out.write(batch.join(''))) await once(out, 'drain')
      batch = []
      size = 0
    }
  }
  out.write(batch.join(''))
  out.end()
  await once(out, 'finish')
}

/** A grid of squares as wide as it is long, lifted so no two corners agree. */
function gridSide(bytesPerTriangle) {
  return Math.ceil(Math.sqrt(targetBytes / bytesPerTriangle / 2))
}
const vertexAt = (i, j, n) => `${((i / n) * 2000).toFixed(4)} ${((j / n) * 2000).toFixed(4)} ${(Math.sin(i / 50) * Math.cos(j / 50) * 40).toFixed(4)}`

function* objLines(n) {
  for (let i = 0; i <= n; i++) for (let j = 0; j <= n; j++) yield `v ${vertexAt(i, j, n)}\n`
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const a = i * (n + 1) + j + 1
      const b = a + n + 1
      yield `f ${a} ${a + 1} ${b + 1}\nf ${a} ${b + 1} ${b}\n`
    }
  }
}

function* plyLines(n) {
  yield `ply\nformat ascii 1.0\nelement vertex ${(n + 1) * (n + 1)}\nproperty float x\nproperty float y\nproperty float z\nelement face ${2 * n * n}\nproperty list uchar int vertex_indices\nend_header\n`
  for (let i = 0; i <= n; i++) for (let j = 0; j <= n; j++) yield `${vertexAt(i, j, n)}\n`
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const a = i * (n + 1) + j
      const b = a + n + 1
      yield `3 ${a} ${a + 1} ${b + 1}\n3 ${a} ${b + 1} ${b}\n`
    }
  }
}

function* stlLines(n) {
  yield 'solid large\n'
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const a = vertexAt(i, j, n)
      const b = vertexAt(i, j + 1, n)
      const c = vertexAt(i + 1, j + 1, n)
      const d = vertexAt(i + 1, j, n)
      yield `facet normal 0 0 1\nouter loop\nvertex ${a}\nvertex ${b}\nvertex ${c}\nendloop\nendfacet\nfacet normal 0 0 1\nouter loop\nvertex ${a}\nvertex ${c}\nvertex ${d}\nendloop\nendfacet\n`
    }
  }
  yield 'endsolid large\n'
}

/** A 3MF whose model is `targetBytes` of XML, zipped as it is written. */
async function write3mf(path) {
  const out = createWriteStream(path)
  let failed = null
  const zip = new Zip((error, chunk) => {
    if (error) failed = error
    else out.write(chunk)
  })
  const part = (name, text) => {
    const f = new ZipDeflate(name, { level: 1 })
    zip.add(f)
    f.push(strToU8(text), true)
  }
  part('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/></Types>')
  part('_rels/.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>')
  const model = new ZipDeflate('3D/3dmodel.model', { level: 1 })
  zip.add(model)
  model.push(strToU8('<?xml version="1.0"?><model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources><object id="1" type="model"><mesh><vertices>'))
  const line = '<vertex x="3.30082" y="27.69411" z="-204.55783"/>\n'
  const block = strToU8(line.repeat(20_000))
  for (let done = 0; done < targetBytes; done += block.length) model.push(block)
  model.push(strToU8('</vertices><triangles><triangle v1="0" v2="1" v3="2"/></triangles></mesh></object></resources><build><item objectid="1"/></build></model>'), true)
  zip.end()
  out.end()
  await once(out, 'finish')
  if (failed) throw failed
}

/** The memory of Chrome and everything it started, as Windows counts it, bytes. */
function chromeMemory(root) {
  if (process.platform !== 'win32') return null
  const script = `$all = Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,WorkingSetSize,PrivatePageCount; $ids = @{ ${root} = 1 }; do { $n = $ids.Count; foreach ($p in $all) { if ($ids.ContainsKey([int]$p.ParentProcessId)) { $ids[[int]$p.ProcessId] = 1 } } } while ($ids.Count -ne $n); $w = 0; $v = 0; foreach ($p in $all) { if ($ids.ContainsKey([int]$p.ProcessId)) { $w += $p.WorkingSetSize; $v += $p.PrivatePageCount } }; "$w $v"`
  try {
    const [working, priv] = execFileSync('powershell', ['-NoProfile', '-Command', script], { encoding: 'utf8', windowsHide: true }).trim().split(' ').map(Number)
    return { working, priv }
  } catch {
    return null
  }
}

const gb = (b) => `${(b / 1024 ** 3).toFixed(2)} GB`
const folder = mkdtempSync(join(tmpdir(), 'scanruler-large-'))
const results = []
let opened = null
try {
  for (const format of formats) {
    const path = join(folder, `large.${format}`)
    const started = Date.now()
    let triangles = null
    if (format === 'obj') {
      const n = gridSide(38)
      triangles = 2 * n * n
      await writeLines(path, objLines(n))
    } else if (format === 'ply') {
      const n = gridSide(34)
      triangles = 2 * n * n
      await writeLines(path, plyLines(n))
    } else if (format === 'stl') {
      const n = gridSide(145)
      triangles = 2 * n * n
      await writeLines(path, stlLines(n))
    } else await write3mf(path)
    const bytes = statSync(path).size
    console.log(`${format}: wrote ${gb(bytes)} in ${Math.round((Date.now() - started) / 1000)} s${triangles ? `, ${triangles.toLocaleString('en-US')} triangles` : ''}`)

    // A browser of its own for each, so what one held does not count for the next.
    opened = await launchApp({ protocolTimeout: 3_600_000 })
    const { browser, page } = opened
    const root = browser.process()?.pid
    await page.waitForSelector('[data-test=start-pane]')
    const idle = chromeMemory(root)
    const input = await page.$('input[type=file]')
    const t0 = Date.now()
    let peak = idle
    const poll = setInterval(() => {
      const m = chromeMemory(root)
      if (m && (!peak || m.priv > peak.priv)) peak = m
    }, 1000)
    await input.uploadFile(path)
    const handle = await page.waitForFunction(
      () => {
        const info = document.querySelector('.file-info')?.textContent ?? ''
        if (/[1-9][\d,]* triangles/.test(info)) return { info }
        const error = document.querySelector('[data-test=error-banner], .errorbanner, .error, [role=alert]')?.textContent
        if (error) return { error }
        const body = document.body.textContent ?? ''
        const said = /too large[^.]*\.[^.]*\.|no faces|no triangles|out of memory/i.exec(body)
        return said ? { error: said[0] } : false
      },
      { timeout: 1_800_000, polling: 500 },
    )
    const end = await handle.jsonValue()
    const seconds = (Date.now() - t0) / 1000
    // Opened means ready to work on, and drawn: as a save would have it.
    if (end.info) await page.waitForFunction(() => !document.querySelector('[data-test="save-project"]').disabled, { timeout: 600_000 })
    const settled = (Date.now() - t0) / 1000
    clearInterval(poll)
    if (end.info) await page.screenshot({ path: shotPath(`large-${format}.png`) })
    console.log(`${format}: ready to work on after ${settled.toFixed(1)} s`)
    results.push({ format, bytes, seconds, peak, idle, end, triangles })
    console.log(`${format}: ${seconds.toFixed(1)} s, peak private ${peak ? gb(peak.priv) : '?'}, working set ${peak ? gb(peak.working) : '?'}; ${JSON.stringify(end)}`)

    if (format === '3mf') {
      check(/too large/.test(end.error ?? ''), `a 3MF of ${gb(bytes)} (zipped) says it is too large: ${end.error}`)
    } else {
      const got = Number(/([\d,]+) triangles/.exec(end.info ?? '')?.[1]?.replace(/,/g, ''))
      check(bytes > 512 * 1024 ** 2 || process.argv[3], `the ${format} is over 512 MiB: ${gb(bytes)}`)
      check(got === triangles, `the ${format} opens with every triangle: ${end.info ?? end.error}`)
    }
    rmSync(path, { force: true })
    await finish(browser, opened.consoleErrors)
    opened = null
  }
} catch (e) {
  fail(`threw: ${e instanceof Error ? e.stack : String(e)}`)
} finally {
  rmSync(folder, { recursive: true, force: true })
  console.log(JSON.stringify(results, null, 1))
  if (opened) await opened.browser.close()
}
