import { describe, expect, it } from 'vitest'
import {
  DEFAULT_PREFERENCE, STORAGE_KEY, applyMarkers, loadPreference, savePreference,
} from '../src/client/persist.ts'

/** Minimal in-memory Storage implementation for the specs. */
function fakeStorage(initial: Record<string, string> = {}): Storage {
  const map = new Map(Object.entries(initial))
  return {
    get length() { return map.size },
    clear: () => { map.clear() },
    getItem: (key) => map.get(key) ?? null,
    key: (index) => [...map.keys()][index] ?? null,
    removeItem: (key) => { map.delete(key) },
    setItem: (key, value) => { map.set(key, String(value)) },
  }
}

describe('loadPreference', () => {
  it('returns the defaults when storage is unavailable', () => {
    expect(loadPreference(undefined)).toEqual({ ...DEFAULT_PREFERENCE })
  })

  it('returns the defaults when the key is absent', () => {
    expect(loadPreference(fakeStorage())).toEqual({ ...DEFAULT_PREFERENCE })
  })

  it('round-trips a stored record', () => {
    const storage = fakeStorage()
    savePreference({ wide: false, left: false }, storage)
    expect(loadPreference(storage)).toEqual({ wide: false, left: false })
  })

  it('recovers per-field defaults from a malformed record', () => {
    const storage = fakeStorage({ [STORAGE_KEY]: '{"wide":"yes","left":false}' })
    expect(loadPreference(storage)).toEqual({ wide: true, left: false })
  })

  it('falls back to the defaults on invalid JSON', () => {
    const storage = fakeStorage({ [STORAGE_KEY]: 'not json' })
    expect(loadPreference(storage)).toEqual({ ...DEFAULT_PREFERENCE })
  })

  it('falls back to the defaults on a non-object record', () => {
    const storage = fakeStorage({ [STORAGE_KEY]: '42' })
    expect(loadPreference(storage)).toEqual({ ...DEFAULT_PREFERENCE })
  })
})

describe('savePreference', () => {
  it('is a no-op without storage', () => {
    expect(() => savePreference({ ...DEFAULT_PREFERENCE }, undefined)).not.toThrow()
  })

  it('persists a partial update as a full record', () => {
    const storage = fakeStorage()
    savePreference({ wide: false, left: true }, storage)
    expect(JSON.parse(storage.getItem(STORAGE_KEY) ?? 'null')).toEqual({ wide: false, left: true })
  })
})

describe('applyMarkers', () => {
  const root = {
    attributes: new Map<string, string>(),
    toggleAttribute(name: string, force: boolean) {
      if (force) this.attributes.set(name, '')
      else this.attributes.delete(name)
    },
  }

  it('stamps both markers when the preference is enabled', () => {
    applyMarkers({ wide: true, left: true }, root)
    expect(root.attributes.has('data-wde-wide')).toBe(true)
    expect(root.attributes.has('data-wde-left')).toBe(true)
  })

  it('removes the markers when the preference is disabled', () => {
    applyMarkers({ wide: false, left: false }, root)
    expect(root.attributes.has('data-wde-wide')).toBe(false)
    expect(root.attributes.has('data-wde-left')).toBe(false)
  })

  it('is a no-op without a root element', () => {
    expect(() => applyMarkers({ ...DEFAULT_PREFERENCE }, undefined)).not.toThrow()
  })
})
