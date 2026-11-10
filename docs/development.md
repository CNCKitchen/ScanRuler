# Development

```bash
npm install
npm --prefix mcp ci # the agent server's dependencies: its tests and the agent browser checks
npm run dev       # local dev server
npm test          # unit tests + ballbar.stl and deviation acceptance tests
npm run build     # type-check + production build to dist/
npm run e2e:ci    # generated-fixture browser tests; run after building
```

The optional local fixtures are `ballbar.stl`, a real 3D scan of a ball bar used
by `tests/ballbar.test.ts`, and the pair `side bracket left.stl` /
`block-marius.stl` — a nominal part and a structured-light scan of it — used by
`tests/align.test.ts`. These scan files are not committed; their acceptance
tests report skips when the fixtures are absent. The latter pair is already
aligned in GOM, so
that test displaces the scan by random rigid transforms first; otherwise the
automatic match would never be asked a real question.

CI runs `npm ci`, the unit suite, the type-checked production build, and
`npm run e2e:ci` on pull requests and pushes to `main`. The browser checks
generate their own small fixtures: transactional imports, recovery and undo
history — and the checks a plugin in the tree lists in its `ci.json` — run
against a fresh development server; a separate smoke test imports a mesh,
saves its project, and reopens it against the built `dist/` app. The runner
starts and closes both servers on available local ports. An existing dev
server is not needed. It exits unsuccessfully if any suite fails.

Install Google Chrome to run these checks locally; `CHROME` overrides the
executable path when it is outside the usual Windows, macOS or Linux location.
CI uses the Chrome installation in GitHub's Ubuntu 24.04 runner image. Logs
land in `e2e-out/ci/`, with screenshots and page HTML on browser failures.
Failed CI runs retain that directory as the `browser-diagnostics` artifact
for seven days. The workflow has a 20-minute limit and cancels superseded
runs on the same branch. Deployment remains a separate Cloudflare workflow;
these checks do not configure branch protection or prevent deployment by
themselves.

A set of end-to-end smoke tests drives the real app in headless Chrome against
a running dev server:

```bash
node scripts/e2e-smoke.mjs      # element fitting on the ball bar
node scripts/e2e-paint.mjs      # hand-marked surface fitting + back-face tint
node scripts/e2e-deviation.mjs  # load, align, measure, split-screen picking
node scripts/e2e-local-fit.mjs  # window / brush / lasso marking + local fine fit
node scripts/e2e-align.mjs      # 3-2-1 datum alignment + STEP export round-trip
node scripts/e2e-auto-align.mjs # Auto-align: a block at an odd angle, then proposed the pose it is in
node scripts/e2e-align-symmetry.mjs # Use symmetry: a pose askew and off the middle, settled on the mirror plane
node scripts/e2e-crease.mjs     # sharp-edge shading: Auto / Always / Never, marking on a split mesh
node scripts/e2e-thickness.mjs  # measure wall thickness, scale, hover and pin
node scripts/e2e-step.mjs       # STEP reference geometry, measured end to end
node scripts/e2e-split.mjs      # side-by-side compare + the colour plot off
node scripts/e2e-pick-fit.mjs   # fit to view, stopping a fit, selecting what it fits on
node scripts/e2e-extend.mjs     # extending an element by field and by grip
node scripts/e2e-gdt.mjs        # GD&T tolerances and limits: rows, pins, the summary, a renamed datum
node scripts/e2e-flat.mjs       # 2D Measure: edges, fits, calibration, alignment, report
node scripts/e2e-spline.mjs     # 2D Measure: a spline through fit points, its handles, closed, in the SVG
node scripts/e2e-section.mjs    # a section through a ball, measured on the 2D sheet
```

`e2e-step.mjs` builds its own pair rather than shipping one, so the answer is
known before the app is started: the reference is a STEP cube and the scan is a
fine mesh of the *same* cube with one face raised 0.2 mm and another sunk
0.15 mm. A correct import has to read those two numbers back off the map — sign
included — and leave the other four faces flat. It does, to 66.6 % of the scan
inside ±0.1 mm, which is exactly four faces of six.

`e2e-pick-fit.mjs` builds that pair too, turned off the reference's frame so the
automatic search has real work to do, and checks the three ways out of a fit
gone wrong the way you would by eye as well: it zooms the models down to a speck
and checks **Fit to view** brings the silhouette back to the share of the frame
it started at, starts a fit and stops it part-way — then checks that no
alignment was left behind, that the panel says so rather than reporting a
failure, and that the *next* fit still runs, which is what proves the worker was
not left wedged — and finally selects surface in the picker with a window,
watches the tally and the magenta on the part follow it, and reads the point
count back out of the fit's own readout.

`e2e-split.mjs` builds the same pair, and checks the split view the way you would
by eye: both halves are photographed and reduced to the share of the frame the
part covers and where that silhouette sits in it. Two viewports in one pose have
to agree on both numbers, before and after a drag in either half and after a
zoom — which is a check no amount of asserting on camera matrices would give,
since the claim being made is about what is on the screen.

The pictures in the README are taken by `node scripts/readme-shots.mjs`
against a running dev server (`APP_URL`), from the local scan pair and
two saved projects (`MEASURE_PROJECT`, `THICKNESS_PROJECT`); it drives the
app through the agent commands and writes `docs/images/`.

## Plugins

Workspaces can be added by plugins: `plugins/<id>/plugin.ts` beside `src/`,
found at build time and read through the interfaces in
[src/plugins/api.ts](../src/plugins/api.ts) — a workspace's tab, panel and stage,
its part of the project file, of the undo history, of the mesh worker and of
the 3D viewport, and its notices in the imprint. Reverse engineer and Mesh Tools
are built this way; [plugins/README.md](../plugins/README.md) has the rules and
the extension points. A build stands with any plugin or none, so nothing in
`src/` imports from one; `node scripts/check-plugin-boundary.mjs` checks
that. `?plugins=none` in the address runs a build with plugins as if it had
none.

### Keeping occt-wasm current

The Reverse engineer's kernel, `occt-wasm` (andymai/occt-wasm), is pinned to
an exact version and moves fast. Check it when cutting a release, and otherwise
about once a week:

```bash
npm view occt-wasm version                    # against the pin in package.json
npm install occt-wasm@<x.y.z> --save-exact    # keep it pinned, no caret
```

Read what changed in its releases on GitHub first. After a bump: `npm test`
— which runs the seeded parts of `plugins/reverse/tests/reFuzz.test.ts`
against their goldens: a seed that comes out otherwise (another volume, a
face more, a step that now fails) fails with what changed; when the change
is the new kernel's and meant, write the goldens anew with
`RE_FUZZ_BLESS="occt-wasm x.y.z → a.b.c: what changed" npx vitest run plugins/reverse/tests/reFuzz.test.ts`
and commit them — the build benchmark on saved projects for times and
outcomes
(`RE_BENCH="a.scanruler;b.scanruler" npx vitest run plugins/reverse/tests/reBench.test.ts`),
a Reverse engineer browser check, and an entry in `CHANGELOG.md` naming both
versions and what the new one changed for us, the goldens' note with it. A new
binding (a kernel operation we lacked) goes in
`plugins/reverse/core/kernel.ts` or the `kernel*.ts` files beside it.

## Releases

The version is the `version` field in `package.json` and nowhere else. The
build reads it into the app, which shows it in the caption under the ScanRuler
name in the top bar and in the imprint, and writes it into every `.scanruler`
project it saves as `appVersion`. Whether an older build can open a project is
decided by the file's own `schemaVersion` and the names in it, not by this
number: a build refuses a higher `schemaVersion`, and an element kind, way of
making an element or dimension type it does not know. When to raise
`PROJECT_SCHEMA` is in `src/core/project/manifest.ts`.

Numbers follow `major.minor.patch`: a patch release fixes, a minor one adds,
and a major one is for a change that stops earlier projects or exports from
opening. To cut one:

```bash
npm version minor --no-git-tag-version   # or patch / major: bumps package.json and the lockfile
UPDATE_MCP_COMMANDS=1 npx vitest run tests/mcpCommands.test.ts   # the server's command list carries the app's version
# describe it at the top of CHANGELOG.md
git add package.json package-lock.json CHANGELOG.md mcp/src/commands.json
git commit -m "chore: release v0.3.0"
git tag -a v0.3.0 -m "ScanRuler 0.3.0"
git push --follow-tags
```

The push builds and deploys the site (below), so the number on scanruler.com is
the one that was pushed. A plain `git push` leaves the tag behind, and so does
VS Code's **Sync Changes** unless `git.followTagsWhenSync` is on.

Each version tag on GitHub becomes a release, its notes the version's section
of `CHANGELOG.md` (`.github/workflows/release.yml`;
`node scripts/release-notes.mjs 0.3.0` prints them). Run that workflow by hand
to release a tag again or catch up on tags that have no release.

## Deploying to Cloudflare

The app is a static Vite build (`dist/`) served by a Cloudflare Worker with no
server code — `wrangler.jsonc` holds the whole configuration. Two ways to ship
it:

- **From your machine:** `npx wrangler login` once, then `npm run deploy`
  (builds, then uploads `dist/`).
- **On every push:** in the Cloudflare dashboard, create a Worker from this
  Git repository (Workers Builds). Set the build command to
  `npm test && npm run build` — the config file supplies the rest. Pushes to
  `main` then build and deploy automatically.

Either way the site lands on a `*.workers.dev` URL — the live deployment is at
<https://scanruler.com/> via a custom domain attached in the Worker's
settings.

**The file store** behind the short links (`/s/<name>`, see [Opening a file from a
link](manual.md#opening-a-file-from-a-link)) is any web address the app may read from — for the live site a
Cloudflare R2 bucket with public access on a custom domain, and a CORS rule
on the bucket allowing `GET` from the site's origin (and from
`http://localhost:5173` for development). The build is told where it is
through `VITE_FILES_URL` in `.env` next to `package.json`, which names the
live site's store; a `.env.local` beside it (not committed) or a build
variable in Workers Builds overrides it for another deployment. Without one
the app still opens `?open=` links; only the short form answers that the
build has no store. Files go into the bucket through the R2 page of
the Cloudflare dashboard, `wrangler r2 object put`, or any S3 client with an
R2 token; `node scripts/e2e-open-link.mjs` tries both forms against a dev
server (its header says how). The GitHub Actions workflow
(`.github/workflows/ci.yml`) still runs tests and a build on every push and
pull request, so a red suite is visible before Cloudflare ships it.
