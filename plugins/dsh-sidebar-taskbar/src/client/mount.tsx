/**
 * DOM mounting: one React root rendered into a container inserted directly
 * above the official `sidebar.workspaces` slot (the workspace browser). The
 * root waits for the slot (the shell mounts asynchronously) and everything
 * is wrapped so a DOM failure degrades the task bar, never the GUI boot.
 */
import { createRoot, type Root } from 'react-dom/client'
import { TaskBar, type TaskBarSessions } from './TaskBar.tsx'

/** The official workspace-browser slot container (rendered with data-slot). */
const WORKSPACES_SELECTOR = '[data-slot="sidebar.workspaces"]'

/**
 * Mount the task bar above the workspace browser.
 * @param sessions - the sessions face for the bar.
 * @returns a disposer unmounting the tree and removing the anchor.
 */
export function mountTaskBar(sessions: TaskBarSessions): () => void {
  let root: Root | undefined
  let anchor: HTMLDivElement | undefined
  let disposed = false
  let observer: MutationObserver | undefined
  const tryFind = (): void => {
    if (disposed || anchor !== undefined) return
    const slot = document.querySelector<HTMLElement>(WORKSPACES_SELECTOR)
    if (slot === null || slot.parentElement === null) return
    anchor = document.createElement('div')
    anchor.setAttribute('data-dsh-taskbar-anchor', '')
    slot.parentElement.insertBefore(anchor, slot)
    root = createRoot(anchor)
    root.render(<TaskBar sessions={sessions} />)
  }
  observer = new MutationObserver(tryFind)
  observer.observe(document.body, { childList: true, subtree: true })
  tryFind()
  return () => {
    disposed = true
    observer?.disconnect()
    root?.unmount()
    anchor?.remove()
  }
}
