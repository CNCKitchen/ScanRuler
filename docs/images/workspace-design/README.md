# Workspace design review screenshots

Captured from the implementation at `2e4552a`, based on upstream `5c1f2f9`,
with isolated headless Chrome profiles and the generated measurement block.
These are screenshots of the running app, not design mockups.

- `measure-edit.png`: desktop element editing with Project and tool panels.
- `guided-measurement.png`: the optional guide at the surface-fitting step.
- `dark-deviation.png`: Surface deviation using the shared dark shell.
- `phone-tools.png`: 390 × 844 layout with the active tool's action footer.

The measure/phone captures come from `scripts/e2e-measure-design.mjs`;
the guide/deviation captures come from `scripts/e2e-workspace-design.mjs`
against the production build. The scripts write fresh captures under `e2e-out/`.

The generated geometry is for practice and layout verification. These images
do not establish physical scanner accuracy or hardware compatibility.
