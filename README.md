# 3D Scan Evaluator

Evaluate the accuracy of your 3D scanner with a **ball bar** — entirely in your
browser. Load a scan (STL, PLY, or OBJ), pick each sphere, and get automatically
fitted sphere diameters and center-to-center distances, the same way metrology
software like GOM Inspect does it.

**Everything runs locally.** Your scan files are processed in your browser and
never leave your computer.

## How to use it

1. **Open** your scan (STL, PLY, or OBJ — meshes only, units assumed mm), or
   drag & drop it anywhere in the window.
2. Press **Create fitting sphere**, then **click a point on a sphere** in the 3D
   view. The tool automatically selects the spherical surface around your click
   (it will not leak onto the connecting rod or stand) and marks it in the
   colour the sphere will get, with the fit itself shown as a neutral grey
   ghost sphere. If the scan of that ball is broken into unconnected patches,
   click a point on each one — every pick feeds the same fit. Press **Create
   sphere** when the preview looks right (*Undo point* drops the last pick,
   *Cancel* or `Esc` discards). The finished sphere stays on screen in its own
   colour.
3. Repeat for the second ball, then read off the **sphere diameters** and the
   **center distance(s)** in the sidebar, and compare the distance against your
   ball bar's calibrated length. *Copy summary* puts the results on your
   clipboard.

The viewport uses a **parallel (orthographic) projection** so nothing is
foreshortened, and rotates freely around the model's bounding-box center with
no fixed up-axis — you can turn the part all the way over without hitting a
pole. Left-drag to rotate, right-drag to pan, scroll to zoom; the **XYZ gizmo**
in the bottom-right corner shows the current orientation.

Fitting uses a **Gaussian best-fit** (orthogonal least squares) with GOM-style
*used points* presets (all / 3σ / 2σ / 1σ, default 3σ). The initial estimate is
made robust with LMedS/RANSAC, and the point selection is a model-guided region
grow over the mesh surface with normal-direction checks — so a click anywhere
on a sphere finds exactly the spherical patch, even when it's fused to the rest
of the part.

Validated against GOM Inspect on a real structured-light scan: center distance
agrees within a micrometer (148.6398 mm vs 148.64 mm), with matching point
selections and fit sigma.

## Development

```bash
npm install
npm run dev       # local dev server
npm test          # unit tests + ballbar.stl acceptance test
npm run build     # type-check + production build to dist/
```

The repository includes `ballbar.stl`, a real 3D scan of a ball bar used by the
acceptance test in `tests/ballbar.test.ts`.

## Deploying to GitHub Pages

The included workflow (`.github/workflows/deploy.yml`) builds and deploys on
every push to `main`:

1. Create a GitHub repository named `3DScanEvaluator` (the Vite `base` path in
   `vite.config.ts` must match the repository name).
2. In the repository settings, under **Pages**, set the source to
   **GitHub Actions**.
3. Push. The site appears at `https://<user>.github.io/3DScanEvaluator/`.

## Roadmap

- More fit methods: Chebyshev (min-zone), min-circumscribed, max-inscribed
- More element types: cylinders, planes, cones, distances between them
- Point-cloud (faceless PLY) support

## License

MIT — by [CNC Kitchen](https://www.cnckitchen.com).
