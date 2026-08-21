// SPDX-License-Identifier: AGPL-3.0-only
// The one eye for a whole list: hides everything while anything is showing,
// shows everything once it is all hidden. Sits in the list's label row beside
// the count.

export function ShowAllButton({
  anyVisible,
  what,
  testId,
  onSet,
}: {
  anyVisible: boolean
  /** What the list holds, for the tooltip: "elements", "dimensions". */
  what: string
  testId?: string
  onSet: (visible: boolean) => void
}) {
  return (
    <button
      className="x eye all"
      data-test={testId}
      title={anyVisible ? `Hide all ${what} in the viewport` : `Show all ${what}`}
      onClick={() => onSet(!anyVisible)}
    >
      {anyVisible ? '◉ Hide all' : '○ Show all'}
    </button>
  )
}
