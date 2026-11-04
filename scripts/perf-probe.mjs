// Perf probe: drives the app in a phone-sized, CPU-throttled Chrome and times
// every button the scenario taps — input-to-next-paint (Event Timing), time
// until the UI it should produce appears, long tasks after, and the hottest
// functions from a CPU profile of each tap.
//   node scripts/perf-probe.mjs        (APP_URL, THROTTLE, CHROME, HEADLESS)
import { writeFileSync, mkdirSync } from 'node:fs'
import puppeteer from 'puppeteer-core'
import { fileURLToPath } from 'node:url'

const APP_URL = process.env.APP_URL ?? 'http://localhost:5391/'
const THROTTLE = Number(process.env.THROTTLE ?? 4)
const CHROME = process.env.CHROME ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const SAMPLE = fileURLToPath(new URL('../public/samples/fridgeBracket_01-reduced.3mf', import.meta.url))
const OUT = fileURLToPath(new URL('../e2e-out/perf/', import.meta.url))
mkdirSync(OUT, { recursive: true })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: process.env.HEADLESS === '0' ? false : 'new',
  args: ['--no-sandbox', '--enable-gpu', '--ignore-gpu-blocklist', '--window-size=420,930'],
  protocolTimeout: 900_000,
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
  const P = (window.__perf = { events: [], longtasks: [], loafs: [] })
  // GPU-side work each tap sets off, which a desktop GPU hides and a phone's does not.
  const G = (window.__gl = { link: 0, upload: 0, ctx: 0 })
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

await page.goto(APP_URL, { waitUntil: 'networkidle0' })
await page.waitForSelector('.panel, .startpane', { timeout: 120_000 })
const cdp = await page.createCDPSession()
await cdp.send('Profiler.enable')
await cdp.send('Profiler.setSamplingInterval', { interval: 250 })
const gl = await page.evaluate(() => {
  const g = document.createElement('canvas').getContext('webgl2')
  const ext = g?.getExtension('WEBGL_debug_renderer_info')
  return ext ? g.getParameter(ext.UNMASKED_RENDERER_WEBGL) : 'n/a'
})
console.log('GPU:', gl, '| CPU throttle', THROTTLE + 'x', '| DPR', await page.evaluate(() => devicePixelRatio))
await cdp.send('Emulation.setCPUThrottlingRate', { rate: THROTTLE })

/** Self time per function from a CPU profile, the top `n`. */
function hot(profile, n = 8) {
  const byId = new Map(profile.nodes.map((nd) => [nd.id, nd]))
  const self = new Map()
  const dts = profile.timeDeltas
  for (let i = 0; i < profile.samples.length; i++) {
    const nd = byId.get(profile.samples[i])
    const cf = nd.callFrame
    if (cf.functionName === '(idle)' || cf.functionName === '(program)') continue
    const key = `${cf.functionName || '(anon)'} ${cf.url.replace(/^.*\/\/[^/]+/, '').replace(/\?.*$/, '')}:${cf.lineNumber + 1}`
    self.set(key, (self.get(key) ?? 0) + (dts[i] ?? 0) / 1000)
  }
  return [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => `${v.toFixed(0).padStart(5)}ms ${k}`)
}

const results = []
/** Tap `sel`, then measure. `appear`: selector (or fn source) whose arrival is
 *  the UI the tap should produce. */
async function measure(label, sel, { appear, settle = 2500, timeout = 60_000, optional = false, action } = {}) {
  if (!action) {
    const el = await page.$(sel)
    if (!el) {
      if (!optional) console.log(`SKIP ${label}: ${sel} not found`)
      return
    }
    // A control off-screen in a scrolling panel is scrolled to first, as a thumb would.
    await el.evaluate((e) => e.scrollIntoView({ block: 'center' }))
    await sleep(300)
  }
  const t0 = await page.evaluate((appear) => {
    window.__perf.appear = null
    if (appear) {
      const test = () => document.querySelector(appear)
      const done = () => {
        const t = performance.now()
        requestAnimationFrame(() => setTimeout(() => (window.__perf.appear = { dom: t, paint: performance.now() })))
      }
      if (test()) window.__perf.appear = { already: true }
      else {
        const mo = new MutationObserver(() => {
          if (test()) { mo.disconnect(); done() }
        })
        mo.observe(document.body, { childList: true, subtree: true, attributes: true })
      }
    }
    window.__gl0 = { ...window.__gl }
    return performance.now()
  }, appear ?? null)
  await cdp.send('Profiler.start')
  if (action) await action()
  else await page.tap(sel)
  const wall0 = Date.now()
  if (appear) {
    await page.waitForFunction(() => window.__perf.appear, { timeout, polling: 50 }).catch(() => {})
  }
  await sleep(settle)
  const { profile } = await cdp.send('Profiler.stop')
  const r = await page.evaluate((t0) => {
    const P = window.__perf
    const ev = P.events.filter((e) => e.start >= t0 - 5 && ['pointerdown', 'pointerup', 'click', 'touchstart', 'touchend', 'mousedown', 'mouseup'].includes(e.name))
    const lt = P.longtasks.filter((e) => e.start >= t0)
    const lo = P.loafs.filter((e) => e.start >= t0)
    const scripts = {}
    for (const f of lo) for (const s of f.scripts) {
      const k = `${s.inv} → ${s.fn || '?'} ${s.url}`
      scripts[k] = (scripts[k] ?? 0) + s.dur
    }
    const G = window.__gl, G0 = window.__gl0
    return {
      gl: `GL: ${G.link - G0.link} shader links, ${((G.upload - G0.upload) / 1048576).toFixed(1)} MB uploaded, ${G.ctx - G0.ctx} new contexts`,
      inp: ev.length ? Math.max(...ev.map((e) => e.dur)) : 0,
      handler: ev.length ? Math.max(...ev.map((e) => e.pe - e.ps)) : 0,
      appear: P.appear ? (P.appear.already ? 'already' : Math.round(P.appear.paint - t0)) : null,
      longTotal: Math.round(lt.reduce((s, e) => s + e.dur, 0)),
      longMax: Math.round(Math.max(0, ...lt.map((e) => e.dur))),
      longN: lt.length,
      loafRender: Math.round(lo.reduce((s, e) => s + e.render, 0)),
      loafStyle: Math.round(lo.reduce((s, e) => s + e.style, 0)),
      scripts: Object.entries(scripts).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k, v]) => `${Math.round(v)}ms ${k}`),
    }
  }, t0)
  r.label = label
  r.hot = hot(profile)
  results.push(r)
  console.log(
    `\n## ${label}\n  INP ${Math.round(r.inp)}ms (handler ${Math.round(r.handler)}ms) | UI appears ${r.appear ?? '-'}ms | long tasks ${r.longN} total ${r.longTotal}ms max ${r.longMax}ms | LoAF render ${r.loafRender}ms style/layout ${r.loafStyle}ms`,
  )
  console.log('  ' + r.gl)
  for (const s of r.scripts) console.log('   loaf:', s)
  for (const h of r.hot) console.log('   cpu:', h)
  void wall0
  return r
}

const shot = (n) => page.screenshot({ path: OUT + n + '.png' })

// ---- start: the sample scan ---------------------------------------------------
await shot('00-start')
await measure('Close support card', '[data-test=support-card] .sc-x', { settle: 800, optional: true })
await measure('Open sample scan (288k tris)', null, {
  action: async () => (await page.$('[data-test=start-scan] input[type=file], input[type=file]')).uploadFile(SAMPLE),
  appear: '.file-info', settle: 4000, timeout: 300_000,
})
await shot('01-loaded')

// ---- workspace tabs with only a scan -------------------------------------------
const tabs = await page.$$eval('[data-test^=workspace-]', (els) => els.map((e) => e.dataset.test))
console.log('\ntabs:', tabs.join(', '))
await measure('Tab → Surface Deviation (scan only)', '[data-test=workspace-deviation]', { appear: '[data-test=workspace-deviation][aria-selected=true]' })
await shot('02-deviation')
await measure('Tab → Wall Thickness', '[data-test=workspace-thickness]', { appear: '[data-test=measure-thickness]' })
await measure('Thickness: Measure', '[data-test=measure-thickness]', { appear: '[data-test=thickness-legend]', settle: 3000, timeout: 300_000 })
await shot('03-thickness')
await measure('Thickness: map off', '[data-test=toggle-colormap]', { settle: 1500 })
await measure('Thickness: map on', '[data-test=toggle-colormap]', { settle: 1500 })
await measure('Tab → 2D Measure', '[data-test=workspace-flat]', { appear: '[data-test=workspace-flat][aria-selected=true]' })
for (const t of tabs.filter((t) => !['workspace-elements', 'workspace-deviation', 'workspace-thickness', 'workspace-flat'].includes(t)))
  await measure(`Tab → ${t} (plugin)`, `[data-test=${t}]`, { appear: `[data-test=${t}][aria-selected=true]`, settle: 3000 })
await measure('Tab → 3D Measure', '[data-test=workspace-elements]', { appear: '[data-test=workspace-elements][aria-selected=true]' })
await shot('04-measure')

// ---- deviation against the same part as reference --------------------------------
await measure('Tab → Surface Deviation (again)', '[data-test=workspace-deviation]', { appear: '[data-test=workspace-deviation][aria-selected=true]' })
await measure('Deviation: load reference', null, {
  action: async () => (await page.$('[data-test=slot-reference] input[type=file]')).uploadFile(SAMPLE),
  appear: '[data-test=align-auto]:not([disabled])', settle: 2000, timeout: 300_000,
})
await measure('Deviation: Auto best fit → map', '[data-test=align-auto]', { appear: '[data-test=deviation-legend]', settle: 4000, timeout: 300_000 })
await shot('05-deviation-map')
await measure('Deviation: map off', '[data-test=toggle-colormap]', { settle: 1500 })
await measure('Deviation: map on', '[data-test=toggle-colormap]', { settle: 1500 })
await measure('Deviation: split on', '[data-test=toggle-split]', { settle: 3000 })
await shot('06-split')
await measure('Deviation: split off', '[data-test=toggle-split]', { settle: 2000 })
await measure('Deviation: map on reference', '[data-test=toggle-map-on-reference]', { settle: 4000, timeout: 300_000 })
await measure('Deviation: map back on scan', '[data-test=toggle-map-on-reference]', { settle: 2000 })
await measure('Deviation: histogram', '[data-test=deviation-histogram-toggle], [data-test$=histogram-toggle]', { settle: 1500, optional: true })
await measure('Deviation: animate on', '[data-test=animate-deformation]', { settle: 2500 })
await measure('Deviation: animate off', '[data-test=animate-deformation]', { settle: 1500 })
await measure('Deviation: volume measure', '[data-test=volume-measure]', { appear: '[data-test=volume-show]', settle: 3000, timeout: 300_000 })
await measure('Deviation: volume show', '[data-test=volume-show]', { settle: 2000 })
await measure('Deviation: source → element', '[data-test=source-element]', { settle: 2000 })
await measure('Deviation: source → reference', '[data-test=source-reference]', { settle: 2000 })
await measure('Deviation: section view', '[data-test=toggle-section-view]', { settle: 2000 })
await measure('Deviation: section view off', '[data-test=toggle-section-view]', { settle: 1500 })

// ---- switching with maps in hand ---------------------------------------------------
await measure('Tab → 3D Measure (maps in hand)', '[data-test=workspace-elements]', { appear: '[data-test=workspace-elements][aria-selected=true]' })
await measure('Tab → Surface Deviation (map in hand)', '[data-test=workspace-deviation]', { appear: '[data-test=deviation-legend]' })
await measure('Tab → Wall Thickness (map in hand)', '[data-test=workspace-thickness]', { appear: '[data-test=thickness-legend]' })
await measure('Tab → Surface Deviation (from thickness)', '[data-test=workspace-deviation]', { appear: '[data-test=deviation-legend]' })
await measure('Settings open', '[data-test=open-settings]', { appear: '[data-test=settings-modal]', settle: 1500 })
await measure('Settings close', '[data-test=settings-close]', { settle: 1000 })
await shot('07-end')

// ---- idle cost: what the page burns doing nothing ---------------------------------
const idle = await page.evaluate(async () => {
  const t0 = performance.now()
  let frames = 0
  await new Promise((res) => {
    const f = () => (performance.now() - t0 < 3000 ? (frames++, requestAnimationFrame(f)) : res())
    requestAnimationFrame(f)
  })
  return frames
})
await cdp.send('Profiler.start')
await sleep(3000)
const idleProfile = (await cdp.send('Profiler.stop')).profile
const idleBusy = idleProfile.timeDeltas.reduce((s, d, i) => {
  const nd = idleProfile.nodes.find((n) => n.id === idleProfile.samples[i])
  return nd.callFrame.functionName === '(idle)' ? s : s + d
}, 0) / 1000
console.log(`\n## Idle (3 s, nothing touched): ${idle} rAF frames, main thread busy ${idleBusy.toFixed(0)}ms`)
for (const h of hot(idleProfile, 6)) console.log('   cpu:', h)

writeFileSync(OUT + 'results.json', JSON.stringify(results, null, 2))
console.log('\nerrors:', errors.length ? errors.slice(0, 5) : 'none')
await browser.close()
