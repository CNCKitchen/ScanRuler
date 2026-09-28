// SPDX-License-Identifier: AGPL-3.0-only
// The plugins' parts of the mesh worker: every plugins/*/worker.ts, by a glob
// that matches nothing when the folder is absent — the one place in the
// worker allowed to name it (see scripts/check-plugin-boundary.mjs). Which
// plugins are in use is the main thread's to decide; a worker part of one
// that is not is simply never asked anything.

import type { WorkerPlugin } from './workerPluginApi'

const found = import.meta.glob<{ default: WorkerPlugin }>('/plugins/*/worker.ts', { eager: true })

export const workerPlugins: readonly WorkerPlugin[] = Object.values(found)
  .map((m) => m.default)
  .sort((a, b) => a.id.localeCompare(b.id))
