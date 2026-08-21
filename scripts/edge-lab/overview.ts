// SPDX-License-Identifier: AGPL-3.0-only
// Builds the self-contained HTML overview from a bench run: report.json plus
// the overlay renders, inlined.
//
//   node_modules/.bin/vite-node scripts/edge-lab/overview.ts <outDir> <verdict.html>
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const [outDir, verdictPath] = process.argv.slice(2)
const report = JSON.parse(readFileSync(join(outDir, 'report.json'), 'utf-8'))
const verdict = verdictPath ? readFileSync(verdictPath, 'utf-8') : ''
const img = (name: string) => `data:image/png;base64,${readFileSync(join(outDir, name)).toString('base64')}`
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;')
const n0 = (v: number) => v.toLocaleString('en-US', { maximumFractionDigits: 0 })
const f = (v: number, d = 2) => v.toFixed(d)

const SCAN_LABEL: Record<string, string> = {
  scan1: 'Scan 1 — protractor and eight inserts, 600 dpi, black lid',
  scan2: 'Scan 2 — eight inserts and a ruler, 1200 dpi, grey lid',
}

let body = ''
for (const [stem, scan] of Object.entries<any>(report)) {
  const methods = scan.methods as any[]
  const base = methods[0]
  body += `<section class="scan"><h2>${esc(SCAN_LABEL[stem] ?? stem)}</h2>
  <p class="meta">${scan.width} × ${scan.height} px · ${f(scan.pxPerMm, 1)} px/mm · features counted from 2 mm of length</p>
  <div class="tablewrap"><table class="metrics">
  <thead><tr><th>Method</th><th class="num">Time</th><th class="num">Chains</th><th class="num">Points</th><th class="num">Median chain</th><th class="num">Chains ≥ 2 mm</th><th class="num">Length in ≥ 2 mm chains</th></tr></thead><tbody>`
  for (const m of methods) {
    const ratio = base.chains ? m.chains / base.chains : 1
    body += `<tr><td><span class="mkey">${esc(m.title)}</span></td>
      <td class="num">${n0(m.ms)} ms</td>
      <td class="num">${n0(m.chains)} <span class="rel">${ratio < 1 ? '−' : '+'}${n0(Math.abs(1 - ratio) * 100)} %</span></td>
      <td class="num">${n0(m.points)}</td>
      <td class="num">${f(m.medianLenMm)} mm</td>
      <td class="num">${n0(m.featureChains)}</td>
      <td class="num"><span class="bar" style="--w:${(m.featureLenFrac * 100).toFixed(0)}%"></span>${n0(m.featureLenFrac * 100)} %</td></tr>`
  }
  body += `</tbody></table></div>
  <h3>Whole image</h3>
  <div class="strip">`
  for (const m of methods) body += `<figure><img loading="lazy" src="${img(m.overview)}" alt=""><figcaption>${esc(m.title)}</figcaption></figure>`
  body += `</div>`
  for (let r = 0; r < scan.rois.length; r++) {
    const roi = scan.rois[r]
    body += `<h3>Region: ${esc(roi.name)} <span class="kind">${roi.kind} · box ${roi.x1 - roi.x0} × ${roi.y1 - roi.y0} px</span></h3>
    <div class="tablewrap"><table class="metrics roi">
    <thead><tr><th>Method</th><th class="num">Chains in box</th><th class="num">Points</th><th class="num">Biggest chain</th><th class="num" colspan="3">Box-drag RANSAC fit (today's flow)</th><th class="num" colspan="3">Click-a-chain: clean ${roi.kind === 'line' ? 'lines' : 'arcs'} in box</th></tr>
    <tr class="sub"><th></th><th></th><th></th><th class="num">share</th><th class="num">inliers</th><th class="num">σ</th><th class="num">result</th><th class="num">count</th><th class="num">longest</th><th class="num">its σ · result</th></tr></thead><tbody>`
    for (const m of methods) {
      const s = m.rois[r]
      body += `<tr><td><span class="mkey">${esc(m.title)}</span></td><td class="num">${s.chains}</td><td class="num">${n0(s.points)}</td><td class="num">${n0(s.topShare * 100)} %</td>` +
        (s.fit ? `<td class="num">${n0(s.fit.inlierFrac * 100)} %</td><td class="num">${f(s.fit.sigmaPx)} px</td><td class="num">${esc(s.fit.value)}</td>` : `<td class="num muted" colspan="3">fit failed</td>`) +
        `<td class="num">${s.featureChains}</td>` +
        (s.best ? `<td class="num">${f(s.best.lenMm, 1)} mm</td><td class="num">${f(s.best.sigmaPx, 3)} px · ${esc(s.best.value)}</td>` : `<td class="num muted" colspan="2">none</td>`) + `</tr>`
    }
    body += `</tbody></table></div><div class="strip">`
    for (const m of methods) body += `<figure><img loading="lazy" src="${img(m.rois[r].image)}" alt=""><figcaption>${esc(m.title)}</figcaption></figure>`
    body += `</div>`
  }
  body += `<h3>Method notes</h3><dl class="notes">`
  for (const m of methods) body += `<dt>${esc(m.title)}</dt><dd>${esc(m.summary)}${m.note ? ` <span class="param">${esc(m.note)}</span>` : ''}</dd>`
  body += `</dl></section>`
}

const html = `<title>Edge Lab</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+Condensed:wght@500;600&family=IBM+Plex+Sans:wght@400;500&family=IBM+Plex+Mono:wght@400;500&display=swap">
<style>
:root{--bg:#eef1f2;--panel:#f8f9fa;--ink:#1a2126;--ink2:#4c5a63;--line:#d3d9dd;--accent:#0e8a86;--accent-ink:#0b6b68;--warn:#b8741a;--bar:#bfe3e1;--img:#000}
@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){--bg:#151a1d;--panel:#1d2428;--ink:#e6ebee;--ink2:#9aa7af;--line:#2e383e;--accent:#3fc1bb;--accent-ink:#6fd6d1;--warn:#e0a04a;--bar:#1f4c4a;--img:#000}}
:root[data-theme="dark"]{--bg:#151a1d;--panel:#1d2428;--ink:#e6ebee;--ink2:#9aa7af;--line:#2e383e;--accent:#3fc1bb;--accent-ink:#6fd6d1;--warn:#e0a04a;--bar:#1f4c4a;--img:#000}
body{background:var(--bg);color:var(--ink);font:15px/1.55 "IBM Plex Sans",system-ui,sans-serif;margin:0;padding:0 1.5rem 4rem}
main{max-width:1280px;margin:0 auto}
h1,h2,h3{font-family:"IBM Plex Sans Condensed","IBM Plex Sans",system-ui,sans-serif;text-wrap:balance;margin:0}
h1{font-size:2.4rem;font-weight:600;letter-spacing:-.01em;padding-top:2.5rem}
h2{font-size:1.5rem;font-weight:600;margin-top:3rem;padding-top:1.5rem;border-top:2px solid var(--ink)}
h3{font-size:1.1rem;font-weight:600;margin-top:2rem;color:var(--accent-ink)}
.kind{font-family:"IBM Plex Mono",monospace;font-size:.8rem;font-weight:400;color:var(--ink2);margin-left:.5rem}
.lede{font-size:1.05rem;color:var(--ink2);max-width:68ch;margin:.5rem 0 0}
.meta{font-family:"IBM Plex Mono",monospace;font-size:.8rem;color:var(--ink2);margin:.3rem 0 1rem}
.verdict{background:var(--panel);border:1px solid var(--line);border-left:4px solid var(--accent);padding:1.25rem 1.5rem;margin-top:1.75rem;max-width:78ch}
.verdict h2{border:0;margin:0;padding:0;font-size:1.25rem}
.verdict p,.verdict li{max-width:70ch}
.verdict ol,.verdict ul{padding-left:1.3rem}
.verdict strong{color:var(--accent-ink)}
.tablewrap{overflow-x:auto;margin-top:.75rem}
table.metrics{border-collapse:collapse;width:100%;font-size:.86rem;font-variant-numeric:tabular-nums}
table.metrics th{font-family:"IBM Plex Mono",monospace;font-weight:500;font-size:.72rem;letter-spacing:.04em;text-transform:uppercase;color:var(--ink2);text-align:left;padding:.45rem .6rem;border-bottom:1px solid var(--line);white-space:nowrap}
table.metrics tr.sub th{text-transform:none;letter-spacing:0;padding-top:0;font-size:.7rem}
table.metrics td{padding:.4rem .6rem;border-bottom:1px solid var(--line);white-space:nowrap}
table.metrics tbody tr:first-child td{background:color-mix(in srgb,var(--warn) 10%,transparent)}
.num{text-align:right}
.mkey{font-weight:500}
.rel{font-family:"IBM Plex Mono",monospace;font-size:.72rem;color:var(--ink2);margin-left:.3rem}
.muted{color:var(--ink2)}
.bar{display:inline-block;width:60px;height:8px;background:var(--line);vertical-align:middle;margin-right:.5rem;position:relative}
.bar::after{content:"";position:absolute;inset:0;width:var(--w);background:var(--accent)}
.strip{display:flex;gap:.75rem;overflow-x:auto;padding:.5rem 0 1rem;scroll-snap-type:x proximity}
.strip figure{margin:0;flex:0 0 auto;scroll-snap-align:start}
.strip img{display:block;max-height:420px;max-width:min(640px,90vw);height:auto;background:var(--img);border:1px solid var(--line)}
.strip figcaption{font-family:"IBM Plex Mono",monospace;font-size:.72rem;color:var(--ink2);margin-top:.3rem}
dl.notes{display:grid;grid-template-columns:max-content 1fr;gap:.4rem 1.25rem;font-size:.9rem;margin-top:.75rem}
dl.notes dt{font-weight:500;white-space:nowrap}
dl.notes dd{margin:0;max-width:80ch}
.param{display:block;font-family:"IBM Plex Mono",monospace;font-size:.74rem;color:var(--ink2)}
.legend{font-size:.86rem;color:var(--ink2);max-width:78ch;margin-top:1rem}
.legend dt{font-weight:500;color:var(--ink)}
.legend dd{margin:0 0 .4rem}
@media (prefers-reduced-motion: no-preference){.strip{scroll-behavior:smooth}}
</style>
<main>
<h1>Edge Lab</h1>
<p class="lede">Eight ways of turning the two flatbed scans into edge chains, judged on what a line, circle or arc fit can use. Every row is the same image, the same regions and the same fit code; only the detector changes. Colours in the overlays change per chain, so a broken edge shows as a colour change.</p>
${verdict}
<dl class="legend">
<dt>Chains ≥ 2 mm / length share</dt><dd>How much of the detector's output is feature-sized. Confetti is everything below.</dd>
<dt>Box-drag RANSAC fit</dt><dd>Today's flow: every point in the box goes to the robust fit. σ is the RMS residual of the inliers; on a knurl or a scuffed edge a large σ is the part, not the detector.</dd>
<dt>Click-a-chain</dt><dd>Each chain judged alone: a clean chain fits the region's shape with σ ≤ 0.5 px over at least 1 mm. Count is how many such candidates a click-to-select tool would offer; longest is the best of them. Closed silhouette contours (F, F2) span the whole part and so never count — their strength is elsewhere.</dd>
<dt>Highlighted row</dt><dd>The current production detector.</dd>
</dl>
${body}
</main>
`
writeFileSync(join(outDir, 'edge-lab.html'), html)
console.log('wrote', join(outDir, 'edge-lab.html'), (html.length / 1e6).toFixed(1), 'MB')
