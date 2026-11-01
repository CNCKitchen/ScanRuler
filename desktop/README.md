# ScanRuler Desktop

An Electron shell around the ScanRuler build in this repository: the app runs
from the local `dist/`, with no browser and no scanruler.com, paired with the
`scanruler-mcp` relay so agents reach the window you are looking at.

```bash
# in the repository root: npm ci && npm --prefix mcp ci && npm run build
cd desktop
npm install
npm start        # runs the app from the checkout
npm run dist     # packages release/win-unpacked/ScanRuler.exe
npm test         # dictionaries, smoke (isolation, threads, WebGL2, WebGPU), Creality watcher
node test/i18n.mjs       # the page stays translated as React redraws
node test/e2e-agent.mjs  # an MCP client reaches the page through the relay
```

Windows x64 only for now (`electron-builder --win dir`).

## What it adds

- **Graphics backend**: Help → Hardware picks the backend ANGLE translates WebGL
  to — DirectX 11 (default), DirectX 12, Vulkan or OpenGL — and shows the GPU,
  WebGPU, thread count, cross-origin isolation and WebNN. A change applies on
  restart; the window title names the API in use.
- **Language**: the ScanRuler page is translated at run time, node by node, from
  `i18n/<lang>.json`, and kept translated as React redraws; the source of the
  app is not touched. Shipped: Deutsch, Español, Français, Italiano, 日本語,
  Português (Brasil), 简体中文. The first language follows the OS; the Language
  menu changes it; the shell's own menu and Hardware panel follow. To add one,
  copy `i18n/_english-keys.json` to `i18n/<lang>.json` as `{key: translation}`
  with `_name`, `_menu` and `_hw` as in the others — `node test/dicts.mjs`
  checks it. Text drawn on canvas and numbers built at run time are not covered.
- **Creality Scan projects**: `project.obp` opens from the menu, the command
  line, drag and drop or the file picker, resolving to the project's
  `result/Mesh.ply` (or the newest session's `Fused.ply`). File → Watch Creality
  Scan folder… offers each new `Mesh.ply` the scanner software writes.
- **Agents on the open window**: the app starts the relay itself and writes
  `agent.json` (port and token) under its user-data folder; `scanruler-mcp.cmd`
  next to the exe joins that app, so Claude Code or Codex drive the window the
  user has open instead of a background copy:

  ```bash
  claude mcp add --scope user scanruler -- "<path>\release\win-unpacked\scanruler-mcp.cmd"
  codex mcp add scanruler -- "<path>\release\win-unpacked\scanruler-mcp.cmd"
  ```

- File associations for `.scanruler`, `.stl`, `.ply`, `.obj`, `.3mf`, `.step` and `.obp`.
