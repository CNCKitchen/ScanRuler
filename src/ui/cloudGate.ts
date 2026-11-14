// SPDX-License-Identifier: AGPL-3.0-only
// Whether a tool is off because the scan is a point cloud: the refusal to
// show as its tooltip while its button is disabled, else null. It asks the
// worker ops the tool reaches (core/capabilities.ts), so an op learning to
// take clouds frees its button with no edit here.
import type { WorkerRequest } from '../core/workerProtocol'
import { refusesOpsOnCloud } from '../core/capabilities'
import { useStore } from '../state/store'

export function useCloudRefusal(...ops: WorkerRequest['type'][]): string | null {
  const cloud = useStore((s) => s.scanIsCloud)
  return refusesOpsOnCloud(ops, cloud)
}
