# AGENTS.md

Notes for coding agents working in this repository. The longer versions are
[CONTRIBUTING.md](CONTRIBUTING.md), [docs/development.md](docs/development.md)
and [plugins/README.md](plugins/README.md); when they disagree with this file,
they win.

## What this is

ScanRuler is a browser app (React 19, Vite 6, TypeScript, Three.js) for
measuring 3D scans against CAD. It deploys as static assets on Cloudflare
(`wrangler.jsonc`, output in `dist/`). Heavy work runs in module Web Workers,
some of it in WebAssembly (`manifold-3d`, `occt-wasm`). `mcp/` is a separate
Node package: the MCP server that lets an agent drive a running app.

## Setup

Node 22 or newer.

```bash
npm ci
npm --prefix mcp ci
```

## Verify before you hand work back

These are what CI runs (`.github/workflows/ci.yml`), in order:

```bash
node scripts/check-plugin-boundary.mjs   # nothing outside plugins/ imports from it
node scripts/check-units.mjs             # on-screen lengths go through the display units
npm test                                 # vitest, unit + acceptance
npm --prefix mcp test                    # the MCP server's own tests
npm run build                            # tsc --noEmit, then vite build
npm run e2e:ci                           # headless-Chrome checks; needs Chrome and a build
```

Acceptance tests that need the large real scans (`ballbar.stl`, the
`side bracket left.stl` / `block-marius.stl` pair and others) are not in the
repo and report as skipped without them. That is expected; do not treat the
skips as failures, and do not loosen a tolerance to make a test pass.

`npm run dev` plus `node scripts/e2e-<name>.mjs` runs a single browser check
against the dev server; see docs/development.md for which ones need no scan.

## Rules the checks enforce

- **Plugin boundary.** Workspaces such as Reverse engineer and Mesh Tools live
  in `plugins/<id>/` and talk to the app only through
  `src/plugins/api.ts`. Nothing in `src/` may import from `plugins/`; only
  the registries (`src/plugins/registry.ts`, `src/core/workerPlugins.ts`)
  name it, by glob. A build must stand with any plugin or none.
- **Display units.** Lengths shown to the user go through `src/core/units.ts`
  (millimetres or inches). Do not write `mm` in UI text. A deliberate `mm`
  (an id, a stored field name) carries a `units-ok` comment saying why.
  The agent command API always answers in millimetres.
- **Dependency licenses.** Only permissive licenses (list in CONTRIBUTING.md
  section 2 and `.github/workflows/license-check.yml`). Never GPL, LGPL, or
  AGPL code we do not own; do not transcribe algorithms from such projects.
  Ask before adding any dependency.

## Style

- New source files start with `// SPDX-License-Identifier: AGPL-3.0-only`.
- Numerical code belongs in `src/core/` or a plugin's `core/` and must run
  without a browser: no DOM and no Three.js scene objects in fitting or
  deviation maths.
- Comments explain why a non-obvious approach was chosen, not what a line does.
  Match the surrounding code.
- User-visible changes get an entry at the top of `CHANGELOG.md`.
- The version lives only in `package.json`. When it changes, regenerate the
  MCP command list:
  `UPDATE_MCP_COMMANDS=1 npx vitest run tests/mcpCommands.test.ts`.
