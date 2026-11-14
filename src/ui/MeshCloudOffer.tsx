// SPDX-License-Identifier: AGPL-3.0-only
// Mesh this cloud, on the scan's card while the scan is a point cloud and a
// plugin offers a mesher (app/cloudMesher.ts). It asks first: the marks and
// selections made on the cloud's points go with it.
import { useState } from 'react'
import { useCloudMesher } from '../app/cloudMesher'
import { useStore } from '../state/store'

export const MESH_CLOUD_CONFIRM = 'Mesh this cloud? Marks and selections on the cloud are dropped; the fits are fitted again on the mesh. Ctrl+Z returns the cloud.'

export function MeshCloudOffer({ busy }: { busy: boolean }) {
  const mesher = useCloudMesher()
  const scanIsCloud = useStore((s) => s.scanIsCloud)
  const [asking, setAsking] = useState(false)
  if (!mesher || !scanIsCloud) return null
  if (!asking) {
    return (
      <div className="toolrow">
        <button
          data-test="mesh-cloud"
          disabled={busy}
          onClick={() => setAsking(true)}
          title="Make the point cloud a mesh, for the tools that need a surface — trimmed to the points, so an open scan stays open"
        >
          {mesher.label}
        </button>
      </div>
    )
  }
  return (
    <>
      <p className="hint" data-test="mesh-cloud-ask">{MESH_CLOUD_CONFIRM}</p>
      <div className="toolrow">
        <button
          data-test="mesh-cloud-confirm"
          disabled={busy}
          onClick={() => {
            setAsking(false)
            void mesher.mesh()
          }}
        >
          Mesh it
        </button>
        <button data-test="mesh-cloud-cancel" onClick={() => setAsking(false)}>
          Cancel
        </button>
      </div>
    </>
  )
}
