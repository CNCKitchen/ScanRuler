// SPDX-License-Identifier: AGPL-3.0-only
// The fields the editors are assembled from: the reference-slot dropdown
// shared by constructions, dimensions and the alignment datums, and the name
// field of whatever is being edited.

import { providesRole, type RefRole } from '../core/elements/refs'
import type { Element } from '../state/store'

/** Elements that can fill a reference slot of one of the given roles, minus
 *  any that would close a loop (an edited element and its dependents). */
export function providersFor(
  roles: readonly RefRole[],
  elements: Element[],
  blocked?: ReadonlySet<number>,
): Element[] {
  return elements.filter(
    (e) => e.fit && !blocked?.has(e.id) && roles.some((role) => providesRole(e.kind, role)),
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
 *  alignment datums. */
export function RefSelect({
  label,
  roles,
  value,
  elements,
  blocked,
  testId,
  picking,
  onChange,
  onPickNew,
}: {
  label: string
  roles: readonly RefRole[]
  value: number | null
  elements: Element[]
  /** Elements this slot must not offer — see providersFor. */
  blocked?: ReadonlySet<number>
  testId?: string
  /** True while a pick on the scan is filling this slot. */
  picking?: boolean
  onChange: (id: number | null) => void
  /** Offered on point slots: create the point by clicking the scan. */
  onPickNew?: () => void
}) {
  const options = providersFor(roles, elements, blocked)
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
        <option value="">{picking ? 'Picking — click the scan…' : 'Select…'}</option>
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
