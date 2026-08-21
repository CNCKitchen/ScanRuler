# Edge lab

A test bed for the 2D Measure edge detector: candidate pipelines run side by
side on real flatbed scans, measured on what a line/circle/arc fit can use,
rendered as overlays, and written up as one HTML page. Nothing in here is
wired into the app.

```sh
# chains, metrics, overlay renders → <out>/report.json and PNGs
node_modules/.bin/vite-node scripts/edge-lab/bench.ts <out> <scan.png>…
# the HTML overview (optionally with a verdict fragment at the top)
node_modules/.bin/vite-node scripts/edge-lab/overview.ts <out> [verdict.html]
```

Scans are read by `png.ts` (8-bit PNG, no library); benchmark regions and the
pixels-per-mm of each scan are declared at the top of `bench.ts`. The scans
themselves are not in the repository.

| File | What |
|---|---|
| `core.ts` | the production Canny taken apart: blur, Sobel, thresholds, NMS, hysteresis, chain walk, subpixel |
| `methods.ts` | the candidates — Canny (baseline), chain statistics, Helmholtz/NFA validation, two-scale focusing, Edge Drawing + EDPF, Otsu and local-mean iso-contours, line/arc primitive segmentation |
| `bench.ts` | whole-image statistics, box-drag RANSAC fits and per-chain "clean feature" counts per region, overlay renders |
| `render.ts`, `png.ts` | overlay drawing and PNG I/O |
| `overview.ts` | the self-contained HTML report |

Findings from the first run (August 2026, a protractor with knurled inserts
at 600 dpi and the inserts with a ruler at 1200 dpi): the confetti is a
selection problem, not a localisation one. Chain statistics on the existing
Canny output — gap bridging, a minimum length in millimetres, a consistent
intensity step across the chain — cut the chain count by 68–82 % while
keeping every long feature point for point; splitting the survivors into
line/arc runs gives the representation a fit actually wants. NFA validation
keeps scanner texture (it is statistically real), two-scale focusing matches
the statistics at three times the cost, Edge Drawing loses low-contrast
silhouettes, and the silhouette contour wants a hybrid with gradient
localisation before it is usable.
