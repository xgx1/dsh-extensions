/**
 * Conversation Layout preference store: a persisted two-field record exposed
 * as the settings row's slot store, so the row reads through `useStore` and
 * writes through the baked `set` action while every change mirrors to the
 * shared localStorage key the host boot script reads.
 */
import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-store'
import { loadPreference, savePreference, type LayoutPreference } from './persist.ts'

/** Declared write surface: one patch-merge action. */
type LayoutRowActions = {
  /** Merge a partial preference and persist the merged record. */
  set: (draft: LayoutPreference, patch: Partial<LayoutPreference>) => void
}

/**
 * Declare the layout store seeded from persisted storage.
 * @returns the store handle bound to the settings-row slot seat.
 */
export function createLayoutRowStore(): EngineStoreHandle<LayoutPreference, LayoutRowActions> {
  return defineStore({
    init: (): LayoutPreference => loadPreference(),
    actions: {
      set: (draft, patch) => {
        Object.assign(draft, patch)
        savePreference({ ...draft })
      },
    },
  })
}
