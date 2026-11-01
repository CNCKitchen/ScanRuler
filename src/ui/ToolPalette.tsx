// SPDX-License-Identifier: AGPL-3.0-only
import { Children, isValidElement, type ReactNode, type HTMLAttributes } from 'react'

/** Keep the same real controls and handlers in a short, stable shortlist.
 * Additional operations remain mounted for keyboard navigation and search. */
export function ToolPalette({ children, ...props }: HTMLAttributes<HTMLDivElement> & { children: ReactNode }) {
  const items = Children.toArray(children)
  const available = items.map((child, index) => isValidElement<{ disabled?: boolean }>(child) && !child.props.disabled ? index : -1).filter(i => i >= 0)
  const recommended = new Set((available.length ? available : items.map((_, i) => i)).slice(0, 4))
  return <div {...props} className="tool-palette">
    <div className="kindrow featurekeys">{items.filter((_, i) => recommended.has(i))}</div>
    {items.length > recommended.size && <details className="more-tools"><summary>More tools</summary>
      <p className="hint">Additional operations. Unavailable tools need compatible geometry or a completed current tool.</p>
      <div className="kindrow featurekeys">{items.filter((_, i) => !recommended.has(i))}</div>
    </details>}
  </div>
}
