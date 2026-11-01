// SPDX-License-Identifier: AGPL-3.0-only
import { createContext, useContext, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

/** Editors keep ownership of their actions; the workspace supplies a footer
 *  outside the scrolling parameters so Commit and Cancel remain reachable. */
export const ToolActionsTarget = createContext<HTMLElement | null>(null)
export function ToolActions({ children, dock = true }: { children: ReactNode; dock?: boolean }) {
  const target = useContext(ToolActionsTarget)
  return target && dock ? createPortal(children, target) : <>{children}</>
}
