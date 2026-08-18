/**
 * Preference persistence for the layout extension: a two-field record stored
 * under one localStorage key (the same persistence style dsh-aionui-panel
 * uses), plus the DOM marker projection onto the `<html>` element.
 */

/** Durable preference record shared by the settings row and the markers. */
export interface LayoutPreference {
  /** Full-width conversation content (vs the stock 748px column). */
  wide: boolean
  /** Left-aligned composer (vs the stock centered card). */
  left: boolean
}

/** Storage key shared with the host-rendered boot script. */
export const STORAGE_KEY = 'dsh-web-extension'

/** Extension defaults: full width + left alignment, per the feature spec. */
export const DEFAULT_PREFERENCE: Readonly<LayoutPreference> = Object.freeze({
  wide: true,
  left: true,
})

/** Resolve one stored record field, falling back per-field to the default. */
function pick(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

/**
 * Read the persisted preference, tolerating missing or malformed storage.
 * @param storage - storage backend; defaults to localStorage when available.
 * @returns the resolved preference (per-field defaults applied).
 */
export function loadPreference(
  storage: Storage | undefined = typeof localStorage === 'undefined' ? undefined : localStorage,
): LayoutPreference {
  if (storage === undefined) return { ...DEFAULT_PREFERENCE }
  try {
    const raw = storage.getItem(STORAGE_KEY)
    if (raw === null) return { ...DEFAULT_PREFERENCE }
    const parsed: unknown = JSON.parse(raw)
    const record = (typeof parsed === 'object' && parsed !== null) ? parsed as Record<string, unknown> : {}
    return {
      wide: pick(record.wide, DEFAULT_PREFERENCE.wide),
      left: pick(record.left, DEFAULT_PREFERENCE.left),
    }
  } catch {
    // Malformed JSON or an unavailable store: keep the defaults.
    return { ...DEFAULT_PREFERENCE }
  }
}

/**
 * Persist one preference record.
 * @param preference - the record to store.
 * @param storage - storage backend; defaults to localStorage when available.
 */
export function savePreference(
  preference: LayoutPreference,
  storage: Storage | undefined = typeof localStorage === 'undefined' ? undefined : localStorage,
): void {
  if (storage === undefined) return
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(preference))
  } catch {
    // Quota/security denial: the in-memory store still carries the value.
  }
}

/** Minimal root contract the markers are projected onto (document root at runtime). */
export interface MarkerRoot {
  toggleAttribute(name: string, force: boolean): void
}

/**
 * Project one preference onto the document root markers that gate the
 * override stylesheet. Toggling an attribute off restores the stock layout.
 * @param preference - the record to project.
 * @param root - target element; defaults to the document root.
 */
export function applyMarkers(
  preference: LayoutPreference,
  root: MarkerRoot | undefined = typeof document === 'undefined' ? undefined : document.documentElement,
): void {
  if (root === undefined) return
  root.toggleAttribute('data-wde-wide', preference.wide)
  root.toggleAttribute('data-wde-left', preference.left)
}
