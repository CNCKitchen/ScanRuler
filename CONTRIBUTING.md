# Contributing

Thanks for your interest! Two ground rules keep this project sustainable —
please read them before opening a PR.

## 1. Contributor License Agreement (CLA)

This project is dual-licensed: open source under AGPL-3.0-only for everyone,
with commercial exceptions sold to companies that want to embed it in
proprietary software (see [COMMERCIAL.md](COMMERCIAL.md)). That model only
works if the project owner holds the licensing rights to the whole codebase.

Therefore every contribution requires agreeing to the CLA: you keep the
copyright to your contribution, but you grant the project owner a perpetual,
irrevocable, worldwide right to license your contribution under any terms,
including proprietary ones. By submitting a pull request you confirm:

> I have the right to submit this contribution, and I grant Stefan Hermann
> (CNC Kitchen) a perpetual, worldwide, non-exclusive, irrevocable,
> royalty-free license to use, modify, sublicense, and relicense my
> contribution under licenses of his choosing, including the AGPL-3.0-only
> and commercial licenses.

We're transparent about why: without this, a single outside patch would
legally block the commercial-exception model that funds development.

## 2. Dependency license policy (CRITICAL — checked on every PR)

The dual-licensing model collapses if the app ever contains third-party
copyleft code we don't own: we cannot sell a commercial exception covering
someone else's (A)GPL code. **Every new dependency — npm package or vendored
snippet — must be license-vetted before it lands.**

Allowed:

- MIT, Apache-2.0, BSD-2/3-Clause, ISC, 0BSD, Zlib, CC0-1.0, Unlicense,
  Unicode-3.0 / Unicode-DFS-2016, BlueOak-1.0.0
- MPL-2.0 (file-level copyleft — acceptable for commercial licensees)
- CC-BY-4.0 for **data-only** packages (today: `caniuse-lite`, pulled in by
  browserslist; it ships browser-support tables, no code we link)

**Never**, regardless of how useful:

- GPL (any version), LGPL (this is a bundled browser app — everything is
  statically linked by the bundler, so the LGPL's relinking exception buys us
  nothing), AGPL code we don't own, SSPL, BSL/FSL, "non-commercial" licenses
  (CC-BY-NC etc.), the JSON license, unlicensed/no-license code, and
  copy-pasted code of unknown origin (Stack Overflow snippets are CC BY-SA —
  do not paste them).

This applies to *algorithms lifted from source*, not just to `package.json`
entries. A best-fit or mesh routine transcribed out of an (A)GPL project —
PCL is BSD and fine, but CloudCompare, MeshLab and OpenSCAD are GPL — carries
that project's license into this one. Implement from the paper or the maths,
not from the other project's code, and say in the PR which you did.

If a copyleft component is ever genuinely needed, the options are: isolate it
behind a process/network boundary as an optional component, buy a commercial
license for it, or write our own. Ask first.

**The one AGPL dependency is our own.** [`meshstep`](https://github.com/CNCKitchen/meshStep)
— the STEP importer behind the CAD reference geometry — is AGPL-3.0-only, and
lands here under the fourth option above: we wrote it, so a commercial
exception for this app can cover it too. That is the whole of the exemption:
"AGPL code we don't own" above still means never. It is excluded by exact
version in the CI allowlist and pinned without a caret in `package.json`, so
upgrading it is a deliberate edit in both files — appropriate for the code
that decides how an exact CAD surface becomes triangles a measurement is taken
against.

Assets follow the same rule with one carve-out: the bundled fonts in
[public/fonts/](public/fonts/) are SIL OFL 1.1, which permits bundling with
software of any license as long as the font files keep their own license text
alongside them (they do — the `OFL-*.txt` files). New fonts, icons or sample
meshes need a license that allows commercial redistribution; keep the license
file next to the asset.

Checking: `npx license-checker --excludePrivatePackages --onlyAllow "…"`
(exact allowlist in the workflow). CI enforces it on every PR and push via
[.github/workflows/license-check.yml](.github/workflows/license-check.yml).
Run it locally before adding a dependency:

```bash
npx license-checker --excludePrivatePackages --summary
```

## Practicalities

- `npm test` must stay green. The unit tests compare fits against synthetic
  geometry with known dimensions and the acceptance tests against values
  measured in GOM Inspect — treat a loosened tolerance as a red flag, not as
  a fix.
- End-to-end smoke tests drive the real app in headless Chrome against a
  running dev server; run them for anything touching the UI or the worker:

  ```bash
  npm run dev &
  node scripts/e2e-smoke.mjs      # element fitting on the ball bar
  node scripts/e2e-deviation.mjs  # load, align, measure, split-screen picking
  node scripts/e2e-nav.mjs        # mouse orbit / pan / zoom, every scheme
  node scripts/e2e-touch.mjs      # tablet gestures, with touch emulation on
  ```

  A few generate their own part out of a STEP fixture and so need no scan file —
  `e2e-element-deviation.mjs` (deviation to a fitted element, checked against a
  cube of known size), `e2e-split.mjs` (the side-by-side compare view and the
  colour plot) and `e2e-extend.mjs` are the ones to reach for when the large test
  scans are not to hand.

- `npm run build` type-checks (`tsc --noEmit`) and builds. It must pass.
- Numerical work belongs in `src/core/` and must be testable without a
  browser: no Three.js scene objects, no DOM, in the fitting and deviation
  maths. That is what makes the acceptance tests possible.
- New source files carry the SPDX header as their first line:
  `// SPDX-License-Identifier: AGPL-3.0-only`
- Match the surrounding style: comments explain *why* a non-obvious approach
  was chosen (see the ones about scoring ICP candidates on all samples, or
  signing deviation by pseudonormal), not what the line does.
