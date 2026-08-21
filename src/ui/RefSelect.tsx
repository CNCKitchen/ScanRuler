// SPDX-License-Identifier: AGPL-3.0-only
// The fields the editors are assembled from: the reference-slot dropdown
// shared by constructions, dimensions and the alignment datums (in both
// workspaces), and the name field of whatever is being edited.

import { providesRole, type RefRole } from '../core/elements/refs'
import type { ElementKind } from '../core/types'
import type { Element } from '../state/store'

/** Elements that can fill a reference slot of one of the given roles, minus
 *  any that would close a loop (an edited element and its dependents). `kinds`
 *  narrows further, for slots that need one specific element kind. */
export function providersFor(
  roles: readonly RefRole[],
  elements: Element[],
  blocked?: ReadonlySet<number>,
  kinds?: readonly ElementKind[],
): Element[] {
  return elements.filter(
    (e) =>
      e.fit &&
      !blocked?.has(e.id) &&
      roles.some((role) => providesRole(e.kind, role)) &&
      (!kinds || kinds.includes(e.kind)),
  )
}

/** The name of the element or dimension being edited, changeable along with
 *  the rest of it. */
export function NameField({
  value,
  testId,
  onChange,
}: {
  value: string
  testId: string
  onChange: (name: string) => void
}) {
  return (
    <label className="field">
      <span>Name</span>
      <input type="text" data-test={testId} value={value} onChange={(e) => onChange(e.target.value)} />
    </label>
  )
}

/** One reference-slot dropdown, shared by constructions, dimensions and the
 *  alignment datums in both workspaces. The caller decides which elements
 *  are on offer (providersFor, for the 3D roles); the select only lists
 *  them. */
export function RefSelect({
  label,
  options,
  value,
  testId,
  picking,
  placeholder = 'Select…',
  onChange,
  onPickNew,
}: {
  label: string
  /** The elements that can fill this slot, in list order. */
  options: readonly { id: number; name: string }[]
  value: number | null
  testId?: string
  /** True while a pick on the scan is filling this slot. */
  picking?: boolean
  /** What the empty choice reads as — "Select…" for a slot that must be
   *  filled, something like "None" for an optional one. */
  placeholder?: string
  onChange: (id: number | null) => void
  /** Offered on point slots: create the point by clicking the scan. */
  onPickNew?: () => void
}) {
  return (
    <label className="field">
      <span>{label}</span>
      <select
        data-test={testId}
        value={picking ? '__pick__' : (value ?? '')}
        onChange={(e) => {
          if (e.target.value === '__pick__') onPickNew?.()
          else onChange(e.target.value === '' ? null : Number(e.target.value))
        }}
      >
        <option value="">{picking ? 'Picking — click the scan…' : placeholder}</option>
        {options.map((el) => (
          <option key={el.id} value={el.id}>
            {el.name}
          </option>
        ))}
        {onPickNew && <option value="__pick__">+ Pick point on scan…</option>}
      </select>
    </label>
  )
}
