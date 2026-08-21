// SPDX-License-Identifier: AGPL-3.0-only
// Runs every candidate detector on the real flatbed scans and measures what
// matters for element fitting: how much of the output is usable feature
// length, and what a box dragged over a real edge would hand the fit.
//
//   node_modules/.bin/vite-node scripts/edge-lab/bench.ts <outDir> <scan.png>…
import { mkdirSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { readPngGray, type Gray } from './png'
import { renderCrop, type Roi } from './render'
import { METHODS } from './methods'
import { EdgeIndex } from '../../src/core/flat/snap'
import { fitCirclePoints, fitCircleRegion, fitLinePoints, fitLineRegion } from '../../src/core/flat/fit'
import type { EdgeChains } from '../../src/core/flat/edges'

interface FitRoi extends Roi { kind: 'line' | 'circle' }

/** Benchmark regions, in image pixels — boxes a user would plausibly drag. */
const ROIS: Record<string, { pxPerMm: number; rois: FitRoi[] }> = {
  'scan1.png': {
    pxPerMm: 23.622,
    rois: [
      { name: 'hypotenuse', kind: 'line', x0: 150, y0: 700, x1: 450, y1: 1000 },
      { name: 'ruler-top', kind: 'line', x0: 1400, y0: 545, x1: 2200, y1: 595 },
      { name: 'insert-L', kind: 'circle', x0: 560, y0: 150, x1: 880, y1: 470 },
      { name: 'insert-S', kind: 'circle', x0: 2420, y0: 165, x1: 2555, y1: 300 },
      { name: 'protractor-arc', kind: 'circle', x0: 1000, y0: 1500, x1: 1500, y1: 1750 },
    ],
  },
  'scan2.png': {
    pxPerMm: 47.244,
    rois: [
      { name: 'insert-L', kind: 'circle', x0: 130, y0: 360, x1: 770, y1: 1000 },
      { name: 'insert-S', kind: 'circle', x0: 4290, y0: 320, x1: 4540, y1: 570 },
      { name: 'ruler-top', kind: 'line', x0: 600, y0: 1150, x1: 4000, y1: 1225 },
    ],
  },
}

interface RoiStats {
  roi: string; kind: string; chains: number; points: number; topShare: number
  fit: null | { inlierFrac: number; sigmaPx: number; sigmaUm: number; value: string }
  /** Chains in the box that on their own fit the feature kind cleanly
   *  (σ ≤ 0.5 px, ≥ 1 mm long) — what a click-to-select tool could offer. */
  featureChains: number
  best: null | { lenMm: number; sigmaPx: number; sigmaUm: number; value: string; points: number }
  image: string
}
interface MethodStats {
  key: string; title: string; summary: string; note?: string; ms: number
  chains: number; points: number; medianLenPx: number; medianLenMm: number
  featureChains: number; featureLenFrac: number; totalLenMm: number; featureLenMm: number
  overview: string; rois: RoiStats[]
}

const FEATURE_MM = 2

function chainLengths(e: EdgeChains): number[] {
  const out: number[] = []
  for (let c = 0; c + 1 < e.offsets.length; c++) {
    let l = 0
    for (let i = e.offsets[c]; i + 1 < e.offsets[c + 1]; i++) {
      l += Math.hypot(e.points[i * 2 + 2] - e.points[i * 2], e.points[i * 2 + 3] - e.points[i * 2 + 1])
    }
    out.push(l)
  }
  return out
}

function roiStats(e: EdgeChains, roi: FitRoi, pxPerMm: number): Omit<RoiStats, 'image'> {
  const index = new EdgeIndex(e)
  const pts = index.inBox(roi.x0, roi.y0, roi.x1, roi.y1)
  // Chains touching the box, and the biggest one's share of the points.
  const perChain = new Map<number, number>()
  for (let c = 0; c + 1 < e.offsets.length; c++) {
    let k = 0
    for (let i = e.offsets[c]; i < e.offsets[c + 1]; i++) {
      const x = e.points[i * 2], y = e.points[i * 2 + 1]
      if (x >= roi.x0 && x <= roi.x1 && y >= roi.y0 && y <= roi.y1) k++
    }
    if (k) perChain.set(c, k)
  }
  const top = Math.max(0, ...perChain.values())
  let fit: RoiStats['fit'] = null
  try {
    if (roi.kind === 'line') {
      const f = fitLineRegion(pts)
      const ang = (Math.atan2(f.dir[1], f.dir[0]) * 180) / Math.PI
      fit = { inlierFrac: f.usedPoints / pts.length, sigmaPx: f.sigma, sigmaUm: (f.sigma / pxPerMm) * 1000, value: `${ang.toFixed(3)}°` }
    } else {
      const f = fitCircleRegion(pts)
      fit = { inlierFrac: f.usedPoints / pts.length, sigmaPx: f.sigma, sigmaUm: (f.sigma / pxPerMm) * 1000, value: `⌀ ${((2 * f.radius) / pxPerMm).toFixed(3)} mm` }
    }
  } catch { fit = null }
  // Click-a-feature: every chain judged on its own.
  let featureChains = 0
  let best: RoiStats['best'] = null
  for (const [c] of perChain) {
    const own: [number, number][] = []
    for (let i = e.offsets[c]; i < e.offsets[c + 1]; i++) {
      const x = e.points[i * 2], y = e.points[i * 2 + 1]
      if (x >= roi.x0 && x <= roi.x1 && y >= roi.y0 && y <= roi.y1) own.push([x, y])
    }
    if (own.length < 12) continue
    let len = 0
    for (let i = 1; i < own.length; i++) len += Math.hypot(own[i][0] - own[i - 1][0], own[i][1] - own[i - 1][1])
    if (len < pxPerMm) continue
    try {
      let sigma: number, value: string
      if (roi.kind === 'line') {
        const f = fitLinePoints(own)
        sigma = f.sigma
        value = `${((Math.atan2(f.dir[1], f.dir[0]) * 180) / Math.PI).toFixed(3)}°`
      } else {
        const f = fitCirclePoints(own)
        sigma = f.sigma
        value = `⌀ ${((2 * f.radius) / pxPerMm).toFixed(3)} mm`
      }
      if (sigma > 0.5) continue
      featureChains++
      if (!best || len > best.lenMm * pxPerMm) best = { lenMm: len / pxPerMm, sigmaPx: sigma, sigmaUm: (sigma / pxPerMm) * 1000, value, points: own.length }
    } catch { /* degenerate chain */ }
  }
  return { roi: roi.name, kind: roi.kind, chains: perChain.size, points: pts.length, topShare: pts.length ? top / pts.length : 0, fit, featureChains, best }
}

const [outDir, ...files] = process.argv.slice(2)
mkdirSync(outDir, { recursive: true })
const report: Record<string, { width: number; height: number; pxPerMm: number; rois: FitRoi[]; methods: MethodStats[] }> = {}

for (const file of files) {
  const name = basename(file)
  const cfg = ROIS[name]
  if (!cfg) throw new Error(`no ROIs for ${name}`)
  const img: Gray = readPngGray(file)
  const stem = name.replace(/\.png$/, '')
  console.log(`\n== ${name} ${img.width}×${img.height} @ ${cfg.pxPerMm.toFixed(1)} px/mm`)
  const methods: MethodStats[] = []
  for (const m of METHODS) {
    const t0 = performance.now()
    const res = m.run({ gray: img.gray.slice(), width: img.width, height: img.height, pxPerMm: cfg.pxPerMm })
    const ms = performance.now() - t0
    const lens = chainLengths(res.chains).sort((a, b) => a - b)
    const total = lens.reduce((a, b) => a + b, 0)
    const feature = lens.filter((l) => l >= FEATURE_MM * cfg.pxPerMm)
    const featureLen = feature.reduce((a, b) => a + b, 0)
    const medianLenPx = lens.length ? lens[Math.floor(lens.length / 2)] : 0
    const overview = `${stem}-${m.key}-overview.png`
    renderCrop(img, { name: 'all', x0: 0, y0: 0, x1: img.width, y1: img.height }, res.chains, 0.25, join(outDir, overview), 0.5)
    const rois: RoiStats[] = cfg.rois.map((roi) => {
      const image = `${stem}-${m.key}-${roi.name}.png`
      const span = Math.max(roi.x1 - roi.x0, roi.y1 - roi.y0)
      const scale = span <= 340 ? 2 : span <= 700 ? 1 : 0.5
      renderCrop(img, roi, res.chains, scale, join(outDir, image))
      return { ...roiStats(res.chains, roi, cfg.pxPerMm), image }
    })
    const stats: MethodStats = {
      key: m.key, title: m.title, summary: m.summary, note: res.note, ms,
      chains: lens.length, points: res.chains.points.length / 2, medianLenPx, medianLenMm: medianLenPx / cfg.pxPerMm,
      featureChains: feature.length, featureLenFrac: total ? featureLen / total : 0,
      totalLenMm: total / cfg.pxPerMm, featureLenMm: featureLen / cfg.pxPerMm, overview, rois,
    }
    methods.push(stats)
    console.log(
      `${m.title.padEnd(42)} ${ms.toFixed(0).padStart(6)} ms  chains ${String(lens.length).padStart(6)}  pts ${String(stats.points).padStart(7)}` +
      `  med ${stats.medianLenMm.toFixed(2)} mm  ≥${FEATURE_MM}mm: ${String(feature.length).padStart(5)} chains, ${(stats.featureLenFrac * 100).toFixed(0)} % of length`,
    )
    for (const r of rois) {
      console.log(
        `    ${r.roi.padEnd(15)} chains ${String(r.chains).padStart(4)} pts ${String(r.points).padStart(6)} top ${(r.topShare * 100).toFixed(0).padStart(3)} %` +
        (r.fit ? `  box-fit inl ${(r.fit.inlierFrac * 100).toFixed(0).padStart(3)} % σ ${r.fit.sigmaPx.toFixed(2).padStart(6)} px ${r.fit.value.padEnd(12)}` : '  box-fit failed'.padEnd(40)) +
        `  clean chains ${String(r.featureChains).padStart(3)}` +
        (r.best ? `  best ${r.best.lenMm.toFixed(1).padStart(5)} mm σ ${r.best.sigmaPx.toFixed(3)} px ${r.best.value}` : '  best —'),
      )
    }
  }
  report[stem] = { width: img.width, height: img.height, pxPerMm: cfg.pxPerMm, rois: cfg.rois, methods }
}
writeFileSync(join(outDir, 'report.json'), JSON.stringify(report, null, 2))
