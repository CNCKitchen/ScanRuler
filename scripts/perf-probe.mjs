// SPDX-License-Identifier: AGPL-3.0-only
// Perf probe v2: drives the app in a phone-sized, CPU-throttled Chrome and times
// every button the scenario taps — input-to-next-paint (Event Timing), long
// tasks after, GPU-side work (shader links, bytes uploaded, contexts created)
// and the hottest functions from a CPU profile of one extra, profiled tap.
//
//   node scripts/perf-probe.mjs
//
// Env:
//   APP_URL        the app (default http://localhost:5391/, the dev server)
//   THROTTLE       CPU slow-down, default 4
//   PERF_RUNS      repeats per tap, default 5. Toggle rows alternate on/off, tab
//                  rows go round the tab list; the median is reported. The
//                  profiler is OFF for these and one extra tap per row is
//                  profiled for the hot list. Rows that cannot repeat (a file
//                  load, a measurement) run once, profiled, and say n=1.
//   PERF_SCENARIO  `bare` (default) or `rich`: after the scan loads, fit 6
//                  elements, add 4 dimensions and a section, and pin 5
//                  deviation probes later, so what scales with project content
//                  is on the stage. Dev server only (it drives the in-page
//                  command registry through `/src/commands/registry.ts`).
//   PERF_ASSERT    1: exit 1 with a `BUDGET FAIL: <label>: <what>` line per
//                  breach. The lines print either way; `inpMs` budgets are only
//                  checked when PERF_RUNS >= 5.
//   SCAN           a scan to use instead of the sample (use >= 1M triangles when
//                  one is at hand); its size is printed.
//   DIST           where `vite build --sourcemap` wrote the production build
//                  (default <repo>/dist/): a production hot list is named by
//                  mapping each call frame through that build's source maps.
//   CHROME, HEADLESS=0 as before.
//
// Production target:  npx vite build --sourcemap && npx vite preview --port 5392 --strictPort
//                     APP_URL=http://localhost:5392/ node scripts/perf-probe.mjs
// Rich scenario:      npx vite --port 5391 --strictPort
//                     PERF_SCENARIO=rich node scripts/perf-probe.mjs
// GL counters are the same in dev and prod, so the GL budgets of the rich
// scenario are asserted on dev; INP budgets are the production target's.
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import puppeteer from 'puppeteer-core'

// Vite brings source-map-js along; it is not a dependency of ours, so it is
// reached through node_modules rather than package.json.
const { SourceMapConsumer } = createRequire(import.meta.url)('source-map-js')

const APP_URL = process.env.APP_URL ?? 'http://localhost:5391/'
const THROTTLE = Number(process.env.THROTTLE ?? 4)
const RUNS = Math.max(1, Number(process.env.PERF_RUNS ?? 5))
const SCENARIO = process.env.PERF_SCENARIO === 'rich' ? 'rich' : 'bare'
const ASSERT = process.env.PERF_ASSERT === '1'
const CHROME = process.env.CHROME ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const SAMPLE = process.env.SCAN ?? fileURLToPath(new URL('../public/samples/fridgeBracket_01-reduced.3mf', import.meta.url))
const DIST = process.env.DIST ?? fileURLToPath(new URL('../dist/', import.meta.url))
const OUT = fileURLToPath(new URL('../e2e-out/perf/', import.meta.url))
mkdirSync(OUT, { recursive: true })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const rich = SCENARIO === 'rich'

/** The row's own budget for this scenario: a number is the production bare
 *  target's, `{ bare, rich }` names both. */
let isDev = false
const inpBudget = (b) => (typeof b === 'number' ? (rich || isDev ? undefined : b) : rich ? b?.rich : isDev ? undefined : b?.bare)

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: process.env.HEADLESS === '0' ? false : 'new',
  args: ['--no-sandbox', '--enable-gpu', '--ignore-gpu-blocklist', '--window-size=420,930'],
  protocolTimeout: 1_800_000,
})
const page = await browser.newPage()
await page.emulate({
  viewport: { width: 412, height: 915, deviceScaleFactor: 2.625, isMobile: true, hasTouch: true },
  userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36',
})
const errors = []
page.on('pageerror', (e) => errors.push(e.message))
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
await page.evaluateOnNewDocument(() => {
  try {
    localStorage.setItem('scanruler.askstlunits', '0')
    localStorage.setItem('scanruler.beta', 'all')
    localStorage.setItem('scanruler.supportask', '0')
    localStorage.setItem('scanruler.agentdataok', '1')
  } catch {}
  const P = (window.__perf = { events: [], longtasks: [], loafs: [], seen: [] })
  // Event Timing says nothing about an event under 16 ms; this counts the trusted ones that
  // reached the page, so a tap that never landed is not mistaken for a very fast one.
  for (const t of ['click', 'keydown']) window.addEventListener(t, (e) => e.isTrusted && P.seen.push(performance.now()), true)
  // GPU-side work each tap sets off, which a desktop GPU hides and a phone's does not.
  const G = (window.__gl = { link: 0, upload: 0, ctx: 0, raf: 0 })
  for (const C of [WebGLRenderingContext, WebGL2RenderingContext]) {
    const p = C.prototype
    const link = p.linkProgram
    p.linkProgram = function (...a) { G.link++; return link.apply(this, a) }
    const bd = p.bufferData
    p.bufferData = function (t, d, ...r) { G.upload += typeof d === 'number' ? d : d?.byteLength ?? 0; return bd.call(this, t, d, ...r) }
    const bs = p.bufferSubData
    p.bufferSubData = function (t, o, d, ...r) { G.upload += r.length >= 2 ? r[1] * (d.BYTES_PER_ELEMENT ?? 1) : d?.byteLength ?? 0; return bs.call(this, t, o, d, ...r) }
  }
  const gc = HTMLCanvasElement.prototype.getContext
  HTMLCanvasElement.prototype.getContext = function (type, ...a) {
    if (/webgl/.test(type) && !this.__counted) { this.__counted = 1; G.ctx++ }
    return gc.call(this, type, ...a)
  }
  // Frame callbacks that actually ran: what an idle page should not be doing.
  const raf = window.requestAnimationFrame.bind(window)
  window.requestAnimationFrame = (cb) => raf((t) => { G.raf++; cb(t) })
  new PerformanceObserver((l) => {
    for (const e of l.getEntries())
      P.events.push({ name: e.name, start: e.startTime, ps: e.processingStart, pe: e.processingEnd, dur: e.duration })
  }).observe({ type: 'event', durationThreshold: 16, buffered: true })
  new PerformanceObserver((l) => {
    for (const e of l.getEntries()) P.longtasks.push({ start: e.startTime, dur: e.duration })
  }).observe({ type: 'longtask', buffered: true })
  try {
    new PerformanceObserver((l) => {
      for (const e of l.getEntries())
        P.loafs.push({
          start: e.startTime,
          dur: e.duration,
          block: e.blockingDuration,
          render: e.renderStart ? e.startTime + e.duration - e.renderStart : 0,
          style: e.styleAndLayoutStart ? e.startTime + e.duration - e.styleAndLayoutStart : 0,
          scripts: e.scripts.map((s) => ({ fn: s.sourceFunctionName, url: (s.sourceURL || '').replace(/^.*\/\/[^/]+/, ''), dur: s.duration, inv: s.invoker })),
        })
    }).observe({ type: 'long-animation-frame', buffered: true })
  } catch {}
})

try {
  await page.goto(APP_URL, { waitUntil: 'networkidle0' })
  await page.waitForSelector('.panel, .startpane', { timeout: 120_000 })
  isDev = await page.evaluate(() => fetch('/@vite/client').then((r) => r.text()).then((t) => /import.meta.hot|createHotContext/.test(t), () => false))
  if (rich && !isDev) {
    console.log('PERF_SCENARIO=rich needs the dev server (it imports /src/commands/registry.ts).')
    await browser.close()
    process.exit(2)
  }
  const cdp = await page.createCDPSession()
  await cdp.send('Profiler.enable')
  await cdp.send('Profiler.setSamplingInterval', { interval: 250 })
  const gl = await page.evaluate(() => {
    const g = document.createElement('canvas').getContext('webgl2')
    const ext = g?.getExtension('WEBGL_debug_renderer_info')
    return ext ? g.getParameter(ext.UNMASKED_RENDERER_WEBGL) : 'n/a'
  })
  console.log('GPU:', gl, '| CPU throttle', THROTTLE + 'x', '| DPR', await page.evaluate(() => devicePixelRatio))
  console.log(`target: ${isDev ? 'dev server' : 'production build'} ${APP_URL} | scenario: ${SCENARIO} | PERF_RUNS=${RUNS}${ASSERT ? ' | PERF_ASSERT=1' : ''}`)
  console.log(`scan: ${SAMPLE.replace(/^.*[\\/]/, '')}, ${(statSync(SAMPLE).size / 1048576).toFixed(1)} MB on disk`)
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: THROTTLE })

  // ---- naming functions: dev has real names, a production build gets them from its source map ----
  const consumers = new Map()
  /** The source map of a built file, or null (dev, a worker, a file with none). */
  function consumerFor(path) {
    if (!consumers.has(path)) {
      const file = DIST + path.replace(/^\//, '') + '.map'
      consumers.set(path, existsSync(file) ? new SourceMapConsumer(JSON.parse(readFileSync(file, 'utf8'))) : null)
    }
    return consumers.get(path)
  }
  const sourceLines = new Map()
  /** The name of the function that starts at an original position, read off the
   *  source text there: `name(`, `function name(`, or `name = () =>` / `name: () =>`. */
  function nameAt(c, at) {
    let lines = sourceLines.get(at.source)
    if (!lines) {
      lines = (c.sourceContentFor(at.source, true) ?? '').split('\n')
      sourceLines.set(at.source, lines)
    }
    const text = lines[at.line - 1] ?? ''
    const after = text.slice(at.column)
    const own = after.match(/^(?:async\s+)?(?:function\s*\*?\s*)?([A-Za-z_$][\w$]*)\s*(?:<[^>(]*>)?\(/)
    if (own && !/^(?:if|for|while|switch|catch|function|return)$/.test(own[1])) return own[1]
    const bound = text.slice(0, at.column).match(/([A-Za-z_$][\w$.]*)\s*[:=]\s*(?:async\s*)?$/)
    return bound ? bound[1] : null
  }
  const named = new Map()
  /** `{ name, src, line }` for a profile call frame. */
  function nameOf(cf) {
    const path = cf.url.replace(/^.*\/\/[^/]+/, '').replace(/\?.*$/, '')
    const key = `${path}|${cf.lineNumber}|${cf.columnNumber}|${cf.functionName}`
    let r = named.get(key)
    if (r) return r
    r = { name: cf.functionName || '(anon)', src: path, line: cf.lineNumber + 1 }
    const c = path.startsWith('/assets/') ? consumerFor(path) : null
    if (c) {
      const at = c.originalPositionFor({ line: cf.lineNumber + 1, column: cf.columnNumber })
      if (at.source) {
        // The mapping at a function's start names it only when the minifier renamed it; a method or a
        // property keeps its own name, so that is read off the original source at that spot.
        const name = at.name ?? nameAt(c, at)
        r = { name: name ?? `${cf.functionName || '(anon)'}~`, src: at.source.replace(/^(\.\.\/)+/, '').replace(/^.*?(node_modules\/)/, '$1'), line: at.line }
      }
    }
    named.set(key, r)
    return r
  }
  const where = (n) => `${n.name} ${n.src}:${n.line}`

  /** Self time per function from a CPU profile, the top `n`. */
  function hot(profile, n = 8) {
    const byId = new Map(profile.nodes.map((nd) => [nd.id, nd]))
    const self = new Map()
    const dts = profile.timeDeltas
    for (let i = 0; i < profile.samples.length; i++) {
      const cf = byId.get(profile.samples[i]).callFrame
      if (cf.functionName === '(idle)' || cf.functionName === '(program)') continue
      const key = where(nameOf(cf))
      self.set(key, (self.get(key) ?? 0) + (dts[i] ?? 0) / 1000)
    }
    return [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => `${v.toFixed(0).padStart(5)}ms ${k}`)
  }

  /** Functions the fix plan's gated tasks name, as inclusive time (the function
   *  and everything it called) from one profile, outermost call only. */
  const WATCH = [
    'evaluateDimensions', 'updateOverlays', 'computeElementDeviation', 'suggestRange', 'paintField',
    'fieldHistogram', 'deviationStats', 'repaintFromElements', 'setFieldColors', 'inspect',
    'closedPartOf', 'computeBoundsTree', 'deflectionVectors', 'smoothInSpace', 'releaseDeflect',
  ]
  function watched(profile) {
    const byId = new Map(profile.nodes.map((nd) => [nd.id, nd]))
    const selfMs = new Map()
    profile.samples.forEach((id, i) => selfMs.set(id, (selfMs.get(id) ?? 0) + (profile.timeDeltas[i] ?? 0) / 1000))
    const parent = new Map()
    for (const nd of profile.nodes) for (const c of nd.children ?? []) parent.set(c, nd.id)
    const total = new Map()
    const inclusive = (id) => {
      if (total.has(id)) return total.get(id)
      let t = selfMs.get(id) ?? 0
      for (const c of byId.get(id).children ?? []) t += inclusive(c)
      total.set(id, t)
      return t
    }
    const out = new Map()
    for (const nd of profile.nodes) {
      const nm = nameOf(nd.callFrame).name.replace(/~$/, '')
      if (!WATCH.includes(nm)) continue
      // Only the outermost call: a function reached again through itself is counted once.
      let p = parent.get(nd.id)
      let nested = false
      while (p !== undefined && !nested) {
        nested = nameOf(byId.get(p).callFrame).name.replace(/~$/, '') === nm
        p = parent.get(p)
      }
      if (!nested) out.set(nm, (out.get(nm) ?? 0) + inclusive(nd.id))
    }
    return [...out.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${v >= 1 ? v.toFixed(0) : '<1'}ms ${k}`)
  }

  // ---- taps ---------------------------------------------------------------------
  const median = (xs) => {
    if (!xs.length) return 0
    const s = [...xs].sort((a, b) => a - b)
    const m = s.length >> 1
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
  }
  const INPUT_EVENTS = ['pointerdown', 'pointerup', 'click', 'touchstart', 'touchend', 'mousedown', 'mouseup', 'keydown', 'keyup', 'input', 'change']

  /** The control a label names, for the number fields and selects that carry no
   *  test id. */
  const labelled = (text, tag) =>
    page.evaluateHandle(
      (text, tag) => [...document.querySelectorAll('label.field')].find((l) => l.querySelector('span')?.textContent.trim().startsWith(text))?.querySelector(tag) ?? null,
      text,
      tag,
    )

  /** One tap (or action) of a row, then its numbers. `profiled`: with the CPU
   *  profiler on, for the hot list; the timings of such a tap are not the row's. */
  async function once(row, profiled) {
    if (!row.action) {
      const el = await page.$(row.sel)
      if (!el) return null
      // A control off-screen in a scrolling panel is scrolled to first, as a thumb would.
      await el.evaluate((e) => e.scrollIntoView({ block: 'center' }))
      await sleep(300)
    } else if (row.before) await row.before()
    const t0 = await page.evaluate(() => {
      window.__gl0 = { ...window.__gl }
      return performance.now()
    })
    let profile = null
    if (profiled) await cdp.send('Profiler.start')
    try {
      if (row.action) await row.action()
      else await page.tap(row.sel)
      if (row.appear) await page.waitForFunction((sel) => document.querySelector(sel), { timeout: row.timeout ?? 60_000, polling: 100 }, row.appear).catch(() => {})
      await sleep(row.settle ?? 2000)
    } finally {
      // Stopped whatever happened above: a profiler left running would slow every timed tap after it.
      if (profiled) profile = (await cdp.send('Profiler.stop').catch(() => null))?.profile ?? null
    }
    const r = await page.evaluate((t0, names) => {
      const P = window.__perf
      const ev = P.events.filter((e) => e.start >= t0 - 5 && names.includes(e.name))
      const lt = P.longtasks.filter((e) => e.start >= t0)
      const lo = P.loafs.filter((e) => e.start >= t0)
      // Work that starts a good while after the tap's own handlers have finished:
      // a timer the tap set, such as the recovery checkpoint.
      const tapEnd = ev.length ? Math.max(...ev.map((e) => e.start + e.dur)) : t0 + 150
      const late = lt.filter((e) => e.start > tapEnd + 250)
      const scripts = {}
      for (const f of lo) for (const s of f.scripts) {
        const k = `${s.inv} → ${s.fn || '?'} ${s.url}`
        scripts[k] = (scripts[k] ?? 0) + s.dur
      }
      const G = window.__gl, G0 = window.__gl0
      return {
        seen: P.seen.filter((t) => t >= t0 - 5).length,
        link: G.link - G0.link,
        upload: (G.upload - G0.upload) / 1048576,
        ctx: G.ctx - G0.ctx,
        inp: ev.length ? Math.max(...ev.map((e) => e.dur)) : 0,
        handler: ev.length ? Math.max(...ev.map((e) => e.pe - e.ps)) : 0,
        longTotal: Math.round(lt.reduce((s, e) => s + e.dur, 0)),
        longMax: Math.round(Math.max(0, ...lt.map((e) => e.dur))),
        longN: lt.length,
        lateMax: Math.round(Math.max(0, ...late.map((e) => e.dur))),
        loafRender: Math.round(lo.reduce((s, e) => s + e.render, 0)),
        loafStyle: Math.round(lo.reduce((s, e) => s + e.style, 0)),
        scripts: Object.entries(scripts).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k, v]) => `${Math.round(v)}ms ${k}`),
      }
    }, t0, INPUT_EVENTS)
    if (profile) {
      r.hot = hot(profile)
      r.watch = watched(profile)
    }
    return r
  }

  const results = []
  const budgetFails = []
  const fmtMB = (x) => x.toFixed(1)

  /** Run rows `RUNS` times round (in order, so toggles alternate and tabs go
   *  round), then once more with the profiler on. `solo`: the rows cannot repeat,
   *  so they run once, profiled. A row is `{ label, sel | action, settle, appear,
   *  timeout, optional, budget }`; `budget` is `{ links, uploadMB, contexts,
   *  longMs, inpMs, steady }` — `steady` leaves the first tap out of the GL
   *  figures (a context or program made on first use is not the budget's to
   *  count), `inpMs` is the production target's median (or `{ bare, rich }`).
   *
   *  The GL budgets are the plan's own (links 0, uploadMB 0 or 1, contexts 0) and
   *  are expected to fail until their task lands; where the `inpMs` numbers come
   *  from is said above the first group of rows that carries them. */
  async function run(rows, { solo = false } = {}) {
    const live = rows.map((row) => ({ row, samples: [], prof: null, first: undefined, why: null }))
    const rounds = solo ? 0 : RUNS
    for (let k = 0; k < rounds; k++) {
      for (const x of live) {
        try {
          const s = await once(x.row, false)
          if (s) x.samples.push(s)
          else x.why = `${x.row.sel} not found`
          if (k === 0) x.first = s ?? null
        } catch (e) {
          x.why = `failed (run ${k + 1}): ${String(e.message).split('\n')[0]}`
          console.log(`FAILED ${x.row.label} (run ${k + 1}): ${String(e.message).split('\n')[0]}`)
          if (k === 0) x.first = null
        }
      }
    }
    for (const x of live) {
      try {
        const s = await once(x.row, true)
        if (!s) {
          x.why ??= `${x.row.sel} not found`
          continue
        }
        x.prof = s
        if (solo) {
          x.samples.push(s)
          x.first = s
        }
      } catch (e) {
        x.why ??= `failed (profiled): ${String(e.message).split('\n')[0]}`
        console.log(`FAILED ${x.row.label} (profiled): ${String(e.message).split('\n')[0]}`)
      }
    }
    for (const x of live) {
      if (x.samples.length) report(x.row, x.samples, x.prof, solo, x.first ?? null)
      else {
        if (!x.row.optional) console.log(`SKIP ${x.row.label}: ${x.why ?? 'no sample taken'}`)
        // A row with a budget that took no sample has not met it: a degraded run must not pass.
        const b = x.row.budget ?? {}
        if (!x.row.optional && Object.entries(b).some(([k, v]) => k !== 'steady' && v !== undefined)) budgetFails.push(`BUDGET FAIL: ${x.row.label}: row not measured (${x.why ?? 'no sample taken'})`)
      }
    }
  }

  function report(row, samples, prof, solo, first) {
    const n = samples.length
    const m = (f) => median(samples.map(f))
    // Every tap after run 1 (all of them when run 1 itself did not take).
    const later = first ? samples.filter((s) => s !== first) : samples
    const r = {
      label: row.label,
      n,
      solo,
      inp: m((s) => s.inp),
      inpFirst: first ? first.inp : null,
      seen: median(samples.map((s) => s.seen)),
      inpMin: Math.min(...samples.map((s) => s.inp)),
      inpMax: Math.max(...samples.map((s) => s.inp)),
      handler: m((s) => s.handler),
      longMax: m((s) => s.longMax),
      longMaxAny: Math.max(...samples.map((s) => s.longMax)),
      longTotal: m((s) => s.longTotal),
      lateMax: m((s) => s.lateMax),
      lateMaxAny: Math.max(...samples.map((s) => s.lateMax)),
      loafRender: m((s) => s.loafRender),
      loafStyle: m((s) => s.loafStyle),
      link: Math.max(...samples.map((s) => s.link)),
      upload: Math.max(...samples.map((s) => s.upload)),
      ctx: Math.max(...samples.map((s) => s.ctx)),
      first: first ? { link: first.link, upload: first.upload, ctx: first.ctx } : null,
      steady: later.length ? { link: Math.max(...later.map((s) => s.link)), upload: Math.max(...later.map((s) => s.upload)), ctx: Math.max(...later.map((s) => s.ctx)) } : null,
      hot: prof?.hot ?? [],
      watch: prof?.watch ?? [],
      scripts: (prof ?? first ?? samples[0]).scripts,
    }
    // ---- budgets ----
    const b = row.budget ?? {}
    const gl = b.steady ? r.steady : { link: r.link, upload: r.upload, ctx: r.ctx }
    const breaches = []
    if (gl) {
      if (b.links !== undefined && gl.link > b.links) breaches.push(`${gl.link} shader links, budget ${b.links}${b.steady ? ' (after the first tap)' : ''}`)
      if (b.uploadMB !== undefined && gl.upload > b.uploadMB + 0.05) breaches.push(`${fmtMB(gl.upload)} MB uploaded, budget ${b.uploadMB}${b.steady ? ' (after the first tap)' : ''}`)
      if (b.contexts !== undefined && gl.ctx > b.contexts) breaches.push(`${gl.ctx} new WebGL contexts, budget ${b.contexts}${b.steady ? ' (after the first tap)' : ''}`)
    } else if (b.steady && (b.links !== undefined || b.uploadMB !== undefined || b.contexts !== undefined)) {
      console.log(`  (budget on ${row.label}: after-the-first-tap figures need PERF_RUNS >= 2 — not checked)`)
      r.unchecked = true
    }
    if (b.longMs !== undefined && r.longMaxAny > b.longMs) breaches.push(`long task max ${r.longMaxAny} ms, budget ${b.longMs}`)
    const inpB = inpBudget(b.inpMs)
    if (inpB !== undefined && RUNS >= 5 && !solo && r.inp > inpB) breaches.push(`median INP ${Math.round(r.inp)} ms, budget ${inpB}`)
    if (inpB !== undefined && RUNS >= 5 && !solo && r.inp === 0 && r.seen === 0) breaches.push('no input event reached the page, so no INP was measured')
    if (inpB !== undefined && RUNS < 5 && !solo) r.unchecked = true
    r.budget = { ...b, inpMs: inpB }
    r.breaches = breaches
    for (const x of breaches) budgetFails.push(`BUDGET FAIL: ${row.label}: ${x}`)
    results.push(r)
    // ---- print ----
    const spread = n > 1 ? ` (min ${Math.round(r.inpMin)}, max ${Math.round(r.inpMax)}, first ${r.inpFirst === null ? 'n/a (run 1 failed)' : Math.round(r.inpFirst)})` : ''
    console.log(`\n## ${row.label}  [${solo ? 'n=1, single profiled run' : `n=${n}, median; profiled run separate`}]`)
    console.log(`  INP ${Math.round(r.inp)}ms${spread} (handler ${Math.round(r.handler)}ms) | long tasks: max ${r.longMax}ms (worst ${r.longMaxAny}ms), total ${r.longTotal}ms | late long task (>250ms after the tap) ${r.lateMax}ms (worst ${r.lateMaxAny}ms) | LoAF render ${r.loafRender}ms style/layout ${r.loafStyle}ms`)
    console.log(`  GL (worst tap): ${r.link} shader links, ${fmtMB(r.upload)} MB uploaded, ${r.ctx} new contexts | first tap: ${r.first ? `${r.first.link} links, ${fmtMB(r.first.upload)} MB, ${r.first.ctx} ctx` : 'n/a (run 1 failed)'}`)
    const bs = Object.entries({ ...b, inpMs: inpB }).filter(([, v]) => v !== undefined && v !== false).map(([k, v]) => `${k} ${v === true ? 'yes' : v}`)
    if (bs.length) console.log(`  budget: ${bs.join(', ')} -> ${breaches.length ? 'FAIL' : 'ok'}`)
    for (const s of r.scripts) console.log('   loaf:', s)
    for (const h of r.hot) console.log('   cpu:', h)
    if (prof) console.log('   watched (inclusive):', r.watch.length ? r.watch.join(', ') : 'none sampled', ['evaluateDimensions', 'updateOverlays', 'computeElementDeviation'].filter((w) => !r.watch.some((x) => x.endsWith(' ' + w))).map((w) => `| ${w}: not sampled`).join(' '))
  }

  const shot = (n) => page.screenshot({ path: OUT + n + '.png' })
  const tab = (id) => `[data-test=${id}]`
  /** A tab row. */
  const tabRow = (label, id, extra = {}) => ({ label, sel: tab(id), settle: 1500, ...extra })

  // ---- driving the in-page command registry (dev server, rich scenario) ---------------
  /** Run an in-page snippet with `runCommand` at hand; the registry is the one the
   *  app's agent bridge uses, its core commands registered on demand. */
  const inApp = (body) =>
    page.evaluate(
      `(async () => {
        const { runCommand } = await import('/src/commands/registry.ts')
        await (await import('/src/commands/core.ts')).registerCoreCommands()
        ${body}
      })()`,
    )

  /** Six elements, four dimensions and a section on the loaded scan — what a
   *  working session holds and the bare sample lacks. The sample has no sphere
   *  (a sphere fit on it comes back as a junk R190 or refuses), so the elements
   *  are the planes and cylinders it does have; the answer says what came to be. */
  async function buildRichProject() {
    return inApp(`
      const log = []
      const tryRun = async (what, name, input) => {
        try { return await runCommand(name, input) } catch (e) { log.push(what + ' refused: ' + String(e.message).slice(0, 90)); return null }
      }
      const seg = await runCommand('scan.segment', { limit: 130 })
      const ids = { plane: [], cylinder: [], sphere: [] }
      // Planes from the three largest flat regions that are not curved.
      for (const r of seg.regions.filter((r) => !r.curved).slice(0, 3)) {
        const e = await tryRun('plane', 'element.fit', { kind: 'plane', at: { point: r.point } })
        if (e) ids.plane.push(e.element.id)
      }
      // Cylinders from the surfaces the segmentation says are one curved face cut into strips.
      for (const run of seg.curvedRuns.slice(0, 3)) {
        await runCommand('scan.segment', { limit: 130, mark: run.regions })
        const e = await tryRun('cylinder', 'element.fit_marked', { kind: 'cylinder', marked: true })
        if (e) ids.cylinder.push(e.element.id)
      }
      // Spheres, if the scan has any: seeded on the curved regions, a radius a part would have.
      for (const r of seg.regions.filter((r) => r.curved).slice(0, 4)) {
        if (ids.sphere.length >= 2) break
        for (const side of ['outside', 'inside']) {
          const e = await tryRun('sphere', 'element.fit', { kind: 'sphere', at: { point: r.point }, side, radius: { min: 2, max: 40 } })
          if (e) { ids.sphere.push(e.element.id); break }
        }
      }
      const dims = []
      const e = [...ids.plane, ...ids.cylinder, ...ids.sphere]
      const [p0, p1, p2] = ids.plane, [c0, c1, c2] = ids.cylinder
      // Pairs the scan's own features make a dimension of: planes at an angle refuse a distance, so
      // each pair is tried and the first four that take are kept.
      const pairs = [[p0, p1], [c0, c1], [p0, c0], [p1, p2], [p0, p2], [c0, c2], [p1, c1], [p2, c2], [e[0], e[e.length - 1]]]
      for (const [a, b] of pairs) {
        if (dims.length >= 4) break
        if (a === undefined || b === undefined || a === b) continue
        const d = await tryRun('dimension', 'dimension.add', { refs: [a, b] })
        if (d) dims.push(d.dimension.id ?? true)
      }
      let section = null
      const across = [[ids.plane[0], 3], ['XZ', 0], ['XY', 0], ['YZ', 0]]
      for (const [a, offset] of across) {
        if (a === undefined) continue
        const s = await tryRun('section', 'section.cut', { across: a, offset })
        if (s) { section = s.section; break }
      }
      return { elements: ids, dimensions: dims.length, section: section ? 'cut' : 'none', log }
    `)
  }

  /** Pin deviation probes on the part, up to five: a pinned reading is project
   *  content that is drawn, labelled and re-drawn on every tab and map change. A
   *  new reference, source or map side clears them, so each group tops them up. */
  async function ensureProbes() {
    if (!rich) return
    const pinned = await page.evaluate(`(async () => {
      const { useDeviation } = await import('/src/state/deviationStore.ts')
      const { runCommand } = await import('/src/commands/registry.ts')
      const have = useDeviation.getState().probes.length
      if (have >= 5) return have
      await (await import('/src/commands/core.ts')).registerCoreCommands()
      const q = await runCommand('scan.query', { box: { min: [-1e4, -1e4, -1e4], max: [1e4, 1e4, 1e4] }, limit: 40 })
      const stride = Math.max(1, Math.floor(q.points.length / 5))
      for (let i = have; i < 5; i++) useDeviation.getState().addProbe(q.points[Math.min(q.points.length - 1, i * stride)], 0.02 * (i - 2))
      return useDeviation.getState().probes.length
    })()`)
    probesPinned = Math.min(probesPinned, pinned)
  }
  /** The fewest probes any group had on the stage (rich scenario). */
  let probesPinned = Infinity

  // ---- start: the scan ------------------------------------------------------------
  await shot('00-start')
  await run([{ label: 'Close support card', sel: '[data-test=support-card] .sc-x', settle: 800, optional: true }], { solo: true })
  await run(
    [{
      label: 'Open sample scan',
      action: async () => (await page.$('[data-test=start-scan] input[type=file], input[type=file]')).uploadFile(SAMPLE),
      appear: '.file-info', settle: 4000, timeout: 300_000,
      // Plan task 15: the load's main-thread BVH build goes to the worker.
      budget: { longMs: 150 },
    }],
    { solo: true },
  )
  const fileInfo = await page.$eval('.file-info', (el) => el.textContent.replace(/\s+/g, ' ').trim())
  console.log('\nloaded:', fileInfo)
  await shot('01-loaded')
  if (rich) {
    const made = await buildRichProject()
    console.log('rich project:', JSON.stringify(made))
    const elementCount = Object.values(made.elements).reduce((n, ids) => n + ids.length, 0)
    if (elementCount < 6) budgetFails.push(`BUDGET FAIL: rich scenario: ${elementCount} elements made, 6 wanted`)
    if (made.dimensions < 4) budgetFails.push(`BUDGET FAIL: rich scenario: ${made.dimensions} dimensions made, 4 wanted`)
    if (made.section !== 'cut') budgetFails.push('BUDGET FAIL: rich scenario: no section was cut')
    await sleep(1500)
    await shot('01b-rich')
  }

  // ---- workspace tabs: the scan (and, rich, its project) only ---------------------------
  const tabs = await page.$$eval('[data-test^=workspace-]', (els) => els.map((e) => e.dataset.test))
  console.log('\ntabs:', tabs.join(', '))
  const PLUGIN_TABS = tabs.filter((t) => !['workspace-elements', 'workspace-deviation', 'workspace-thickness', 'workspace-flat'].includes(t))
  await run([
    // The `inpMs` budgets, here and below: round(0.7 × median) of the SAVED baseline in
    // e2e-out/perf-baseline-v2.txt (and the spec's v2 table) — `bare` from its production section,
    // `rich` from its dev rich section — for the rows the fix plan's tasks target. A budget set this
    // way is breached by the baseline itself: it is the target, and on this shared machine an
    // advisory one (compare BASE and HEAD in one sitting), though under PERF_ASSERT=1 its
    // breach still sets exit 1 like any other. The GL budgets are the hard gate.
    tabRow('Tab → Surface Deviation (scan only)', 'workspace-deviation', { budget: { inpMs: { bare: 50, rich: 123 } } }),
    tabRow('Tab → Wall Thickness', 'workspace-thickness', { budget: { inpMs: { bare: 50, rich: 106 } } }),
    tabRow('Tab → 2D Measure', 'workspace-flat', {
      settle: 2000,
      // Plan task 6: the 2D viewer is kept alive after its first open, so no later tap makes a context.
      budget: { contexts: 0, steady: true, inpMs: { bare: 62, rich: 185 } },
    }),
    ...PLUGIN_TABS.map((t) => tabRow(`Tab → ${t} (plugin)`, t, { settle: 3000, budget: t === 'workspace-reverse' ? { inpMs: { bare: 67, rich: 218 }, links: 0 } : undefined })),
    tabRow('Tab → 3D Measure', 'workspace-elements', { budget: { inpMs: { bare: 56, rich: 235 }, links: 0 } }),
  ])
  await shot('04-measure')

  // ---- thickness ----------------------------------------------------------------------
  await page.tap(tab('workspace-thickness'))
  await sleep(1500)
  await run([{ label: 'Thickness: Measure', sel: '[data-test=measure-thickness]', appear: '[data-test=thickness-legend]', settle: 3000, timeout: 300_000 }], { solo: true })
  await shot('03-thickness')
  // The thickness map has no key of its own on the view bar; the Scan key in
  // [data-test=part-keys] is the one the view bar has here, and it hides the
  // scan the map is painted on.
  const bandsSelect = async (dir) => {
    const el = await labelled('Bands', 'select')
    await el.asElement().focus()
    await page.keyboard.press(dir)
  }
  await run([
    { label: 'Thickness: scan key off (view bar)', sel: '[data-test=part-keys] [data-test=toggle-scan]', settle: 1500 },
    { label: 'Thickness: scan key on (view bar)', sel: '[data-test=part-keys] [data-test=toggle-scan]', settle: 1500 },
  ])
  await run([
    { label: 'Thickness: bands on (5 bands)', action: () => bandsSelect('ArrowDown'), before: async () => (await labelled('Bands', 'select')).asElement()?.evaluate((e) => e.scrollIntoView({ block: 'center' })), settle: 1500 },
    { label: 'Thickness: bands off (continuous)', action: () => bandsSelect('ArrowUp'), before: async () => (await labelled('Bands', 'select')).asElement()?.evaluate((e) => e.scrollIntoView({ block: 'center' })), settle: 1500 },
  ])
  await run([
    { label: 'Thickness: histogram off', sel: '[data-test=toggle-thickness-histogram]', settle: 1500 },
    { label: 'Thickness: histogram on', sel: '[data-test=toggle-thickness-histogram]', settle: 1500 },
  ])

  // ---- deviation against the same part as reference --------------------------------
  await page.tap(tab('workspace-deviation'))
  await sleep(1500)
  await run([{
    label: 'Deviation: load reference',
    action: async () => (await page.$('[data-test=slot-reference] input[type=file]')).uploadFile(SAMPLE),
    appear: '[data-test=align-auto]:not([disabled])', settle: 2000, timeout: 300_000,
  }], { solo: true })
  // The reference is loaded and has been shown only where it was loaded: the first
  // time it is shown again after a tab switch is the second row's FIRST tap — its
  // median is the warm switch, only "INP first" is the first show.
  await run([
    tabRow('Tab → 3D Measure (reference loaded)', 'workspace-elements', { budget: { inpMs: { bare: 56, rich: 213 }, links: 0 } }),
    tabRow('Tab → Surface Deviation (after reference load; INP first = the first show)', 'workspace-deviation', { settle: 3000 }),
  ])
  await run([{ label: 'Deviation: Auto best fit → map', sel: '[data-test=align-auto]', appear: '[data-test=deviation-legend]', settle: 4000, timeout: 300_000 }], { solo: true })
  await shot('05-deviation-map')
  await ensureProbes()
  await run([
    { label: 'Deviation: map off', sel: '[data-test=toggle-colormap]', settle: 1500, budget: { links: 0 } },
    // Plan task 2: a colour buffer that did not change is not uploaded again.
    // The picture changes here (bare to map), so one colour upload is the floor (ruling R9).
    { label: 'Deviation: map on', sel: '[data-test=toggle-colormap]', settle: 1500, budget: { links: 0, uploadMB: 0.7 } },
  ])
  await ensureProbes()
  await run([
    // Plan task 6: the split view's second viewport is kept after its first open, so no later tap
    // makes a context, links a program or uploads the reference again.
    { label: 'Deviation: split on', sel: '[data-test=toggle-split]', settle: 3000, budget: { links: 0, uploadMB: 0, contexts: 0, steady: true, inpMs: { bare: 73, rich: 190 } } },
    { label: 'Deviation: split off', sel: '[data-test=toggle-split]', settle: 2000 },
  ])
  await shot('06-split')
  await ensureProbes()
  await run([
    // Plan task 5: its programs are warm by the time anyone taps it.
    { label: 'Deviation: map on reference', sel: '[data-test=toggle-map-on-reference]', settle: 4000, timeout: 300_000, budget: { links: 0 } },
    { label: 'Deviation: map back on scan', sel: '[data-test=toggle-map-on-reference]', settle: 2000 },
  ])
  await ensureProbes()
  await run([
    { label: 'Deviation: histogram off', sel: '[data-test=toggle-histogram]', settle: 1500 },
    { label: 'Deviation: histogram on', sel: '[data-test=toggle-histogram]', settle: 1500 },
  ])
  const rangeStep = (dir) => async () => {
    const el = await page.$('[data-test=range-slider]')
    await el.focus()
    await page.keyboard.press(dir)
  }
  const toleranceTo = (v) => async () => {
    const el = (await labelled('Tolerance', 'input')).asElement()
    await el.tap()
    await page.keyboard.down('Control')
    await page.keyboard.press('a')
    await page.keyboard.up('Control')
    await page.keyboard.type(String(v))
    await page.keyboard.press('Enter')
  }
  const scrollTo = (sel) => async () => (await page.$(sel))?.evaluate((e) => e.scrollIntoView({ block: 'center' }))
  // Which way the first step goes: into the track, whichever end the range sits at.
  const towardsMiddle = await page.$eval('[data-test=range-slider]', (e) => (Number(e.value) < (Number(e.min) + Number(e.max)) / 2 ? ['ArrowRight', 'ArrowLeft'] : ['ArrowLeft', 'ArrowRight']))
  await run([
    // The slider's key steps: one notch of the log scale is one repaint of the map and its figures.
    { label: 'Deviation: range slider step 1', action: rangeStep(towardsMiddle[0]), before: scrollTo('[data-test=range-slider]'), settle: 1500, budget: { inpMs: { bare: 39, rich: 168 } } },
    { label: 'Deviation: range slider step 2 (back)', action: rangeStep(towardsMiddle[1]), before: scrollTo('[data-test=range-slider]'), settle: 1500, budget: { inpMs: { bare: 45, rich: 179 } } },
  ])
  const tolField = () => labelled('Tolerance', 'input').then((h) => h.asElement()?.evaluate((e) => e.scrollIntoView({ block: 'center' })))
  await run([
    { label: 'Deviation: tolerance change (0.05)', action: toleranceTo(0.05), before: tolField, settle: 1500 },
    { label: 'Deviation: tolerance change (0.08)', action: toleranceTo(0.08), before: tolField, settle: 1500 },
  ])
  await ensureProbes()
  await run([
    { label: 'Deviation: animate on', sel: '[data-test=animate-deformation]', settle: 2500 },
    // Plan task 10: the deflect buffer is kept, so stopping the animation uploads next to nothing.
    { label: 'Deviation: animate off', sel: '[data-test=animate-deformation]', settle: 1500, budget: { uploadMB: 1 } },
  ])
  await run([{ label: 'Deviation: volume measure', sel: '[data-test=volume-measure]', appear: '[data-test=volume-show]', settle: 3000, timeout: 300_000 }], { solo: true })
  await run([
    { label: 'Deviation: volume show on', sel: '[data-test=volume-show]', settle: 2000 },
    { label: 'Deviation: volume show off', sel: '[data-test=volume-show]', settle: 1500 },
  ])
  await ensureProbes()
  await run([
    { label: 'Deviation: source → element', sel: '[data-test=source-element]', settle: 2000, budget: { links: 0 } },
    { label: 'Deviation: source → reference', sel: '[data-test=source-reference]', settle: 2000, budget: { inpMs: { bare: 84, rich: 157 } } },
  ])
  if (rich) {
    // Against one of the project's own elements: the map is computed on the main
    // thread (plan task 11), which the bare sample, with no elements, cannot show.
    await page.tap('[data-test=source-element]')
    await sleep(1500)
    const options = await page.$$eval('[data-test=target-select] option', (os) => os.map((o) => o.value).filter(Boolean))
    console.log('element targets:', options.length)
    if (options.length < 2) budgetFails.push(`BUDGET FAIL: rich scenario: ${options.length} element-target options, 2 wanted (the element-map rows were not run)`)
    if (options.length >= 2) {
      const pick = (v) => async () => page.select('[data-test=target-select]', v)
      await run([{ label: 'Deviation: choose element target (first map)', action: pick(options[0]), settle: 4000, timeout: 120_000 }], { solo: true })
      // The select is set by the page (a native picker cannot be driven), so these two have no INP:
      // the long task and the hot list carry the cost.
      await run([
        { label: 'Deviation: change element target (A)', action: pick(options[1]), settle: 4000, budget: { links: 0 } },
        { label: 'Deviation: change element target (B)', action: pick(options[0]), settle: 4000, budget: { links: 0 } },
      ])
      await run([
        { label: 'Deviation: element facing limit on', sel: '[data-test=toggle-facing]', settle: 4000, budget: { inpMs: { rich: 218 } } },
        { label: 'Deviation: element facing limit off', sel: '[data-test=toggle-facing]', settle: 4000, budget: { inpMs: { rich: 185 } } },
      ])
    }
    await page.tap('[data-test=source-reference]')
    await sleep(1500)
  }
  await run([
    // Plan task 5: the first tap used to compile six programs. The plan also asks for a median of
    // 120 ms, which the warm median (104) nearly meets already, so the baseline rule stands instead —
    // the cold first tap (416 ms) is the table's "INP first" column.
    { label: 'Deviation: section view on', sel: '[data-test=toggle-section-view]', settle: 2000, budget: { links: 0, inpMs: { bare: 73, rich: 90 } } },
    { label: 'Deviation: section view off', sel: '[data-test=toggle-section-view]', settle: 1500 },
  ])

  // ---- switching with maps in hand ---------------------------------------------------
  await ensureProbes()
  await run([
    tabRow('Tab → 3D Measure (maps in hand)', 'workspace-elements', { budget: { inpMs: { bare: 62, rich: 258 }, links: 0 } }),
    // Plan task 2: a map already painted is not uploaded again on the way in.
    tabRow('Tab → Surface Deviation (map in hand)', 'workspace-deviation', { budget: { uploadMB: 0, inpMs: { bare: 84, rich: 263 }, links: 0 } }),
    // Bare to the thickness map: one colour upload is the floor (ruling R9).
    tabRow('Tab → Wall Thickness (map in hand)', 'workspace-thickness', { budget: { uploadMB: 0.7, inpMs: { bare: 90, rich: 235 } } }),
    tabRow('Tab → Surface Deviation (from thickness)', 'workspace-deviation', { budget: { inpMs: { bare: 78, rich: 252 }, links: 0 } }),
  ])
  await run([
    { label: 'Settings open', sel: '[data-test=open-settings]', settle: 1500 },
    { label: 'Settings close', sel: '[data-test=settings-close]', settle: 1000 },
  ])

  // ---- rich: a brush stroke, the marking path's per-move upload --------------------------
  if (rich) {
    await page.tap(tab('workspace-elements'))
    await sleep(1500)
    try {
      await page.tap('[data-test=fit-sphere]')
      await page.waitForSelector('[data-test=draft-select-mode]', { timeout: 10_000 })
      await page.select('[data-test=draft-select-mode]', 'paint')
      await page.waitForSelector('[data-test=mark-gestures]', { timeout: 10_000 })
      await page.tap('[data-test=mark-brush]')
      await sleep(500)
      const rect = await page.$eval('.viewport canvas', (el) => {
        const r = el.getBoundingClientRect()
        return { x: r.x, y: r.y, w: r.width, h: r.height }
      })
      // Sweep a slow horizontal stroke through the middle of the viewport, where the part is.
      const stroke = async () => {
        const y = rect.y + rect.h * 0.5
        await page.mouse.move(rect.x + rect.w * 0.3, y)
        await page.mouse.down()
        for (let i = 0; i <= 20; i++) {
          await page.mouse.move(rect.x + rect.w * (0.3 + 0.02 * i), y + Math.sin(i / 3) * 6)
          await sleep(16)
        }
        await page.mouse.up()
      }
      await run([{ label: 'Brush stroke (20 moves, rich)', action: stroke, settle: 1500 }])
      const marked = await page.$eval('[data-test=paint-count]', (e) => e.textContent.trim()).catch(() => 'n/a')
      console.log('marked after the strokes:', marked)
      await page.keyboard.press('Escape')
      await page.keyboard.press('Escape')
      await sleep(500)
    } catch (e) {
      console.log('SKIP brush stroke:', String(e.message).split('\n')[0])
    }
  }
  await shot('07-end')

  if (rich && probesPinned < 5) budgetFails.push(`BUDGET FAIL: rich scenario: ${probesPinned === Infinity ? 'no' : probesPinned} deviation probes pinned, 5 wanted`)

  // ---- idle cost: what the page burns doing nothing ---------------------------------
  // A second's grace first: a viewport winds its loop down over a few dozen
  // frames after the last thing that moved, and those frames are the end of
  // the last tap, not idling. After that an idle page runs no frame callback
  // at all — a phone's battery pays for every one.
  await sleep(1000)
  await page.evaluate(() => (window.__idle0 = window.__gl.raf))
  await cdp.send('Profiler.start')
  await sleep(3000)
  const idleProfile = (await cdp.send('Profiler.stop')).profile
  const idleRaf = await page.evaluate(() => window.__gl.raf - window.__idle0)
  const idleBusy = idleProfile.timeDeltas.reduce((s, d, i) => {
    const nd = idleProfile.nodes.find((n) => n.id === idleProfile.samples[i])
    return nd.callFrame.functionName === '(idle)' ? s : s + d
  }, 0) / 1000
  console.log(`\n## Idle (3 s after 1 s idle, nothing touched): ${idleRaf} animation-frame callbacks ran, main thread busy ${idleBusy.toFixed(0)}ms`)
  for (const h of hot(idleProfile, 6)) console.log('   cpu:', h)
  if (idleRaf > 0) budgetFails.push(`BUDGET FAIL: idle: ${idleRaf} frame callbacks in 3 s, 0 wanted`)

  // ---- summary --------------------------------------------------------------------------
  console.log(`\n## Summary — ${isDev ? 'dev' : 'production'}, ${SCENARIO}, PERF_RUNS=${RUNS}, ${THROTTLE}x throttle, ${fileInfo}`)
  console.log('| Row | n | INP median ms | INP first ms | long max ms | late long ms | links | upload MB | new ctx | budget |')
  console.log('|---|---|---|---|---|---|---|---|---|---|')
  for (const r of results) {
    const b = Object.entries(r.budget).filter(([, v]) => v !== undefined && v !== false).map(([k, v]) => `${k}${v === true ? '' : '=' + v}`).join(' ')
    console.log(`| ${r.label} | ${r.solo ? '1*' : r.n} | ${Math.round(r.inp)} | ${r.inpFirst === null ? 'n/a' : Math.round(r.inpFirst)} | ${r.longMax} | ${r.lateMax} | ${r.link} | ${fmtMB(r.upload)} | ${r.ctx} | ${b ? (r.breaches.length ? 'FAIL ' : r.unchecked ? 'unchecked ' : 'ok ') + b : ''} |`)
  }
  console.log('(* a row that cannot repeat: one profiled run. INP 0 = under the 16 ms Event Timing floor, or an action driven by the page rather than a tap.)')
  console.log(`idle: ${idleRaf} frame callbacks / 3 s, main thread busy ${idleBusy.toFixed(0)}ms`)
  writeFileSync(OUT + `results-${SCENARIO}-${isDev ? 'dev' : 'prod'}.json`, JSON.stringify(results, null, 2))
  console.log('\nerrors:', errors.length ? errors.slice(0, 5) : 'none')
  console.log(budgetFails.length ? `\n${budgetFails.length} budget breach${budgetFails.length > 1 ? 'es' : ''}:\n${budgetFails.join('\n')}` : '\nno budget breaches')
  if (ASSERT && budgetFails.length) process.exitCode = 1
} finally {
  await browser.close()
}
