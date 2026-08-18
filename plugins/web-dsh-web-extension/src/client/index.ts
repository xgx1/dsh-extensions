/**
 * web-dsh-web-extension — browser half: registers the Conversation Layout
 * settings row into the official General section, owns the persisted
 * preference store, and projects it onto the `<html>` data markers that gate
 * the host-injected override stylesheet.
 *
 * The Host half already stamped the markers at page load; this half keeps
 * them in sync when the user changes a preference, so the effect is
 * immediate and survives refresh (localStorage) and restart (boot script).
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls the settings-domain SlotMap merge (settings.general.item)
// and the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { LayoutRow, type LayoutRowInjected } from './LayoutRow.tsx'
import { NS, dictionaries, type WebDshKey } from './locales.ts'
import { applyMarkers, loadPreference, savePreference, type LayoutPreference } from './persist.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The Conversation Layout settings row's copy. */
    'web-dsh-extension': WebDshKey
  }
}

/** Required services: the slot registry and the locale dictionaries. */
export const inject = ['slots', 'locale']

/**
 * Mount the browser half.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, dictionaries), 'web-dsh-web-extension: dictionaries')

  // The preference store rides this fiber; the settings row binds it as a
  // hook, and the marker effect mirrors every change onto the document root.
  const preference = createSnapshotStore<LayoutPreference>(loadPreference())
  ctx.effect(() => {
    applyMarkers(preference.getSnapshot())
    return preference.subscribe(() => {
      applyMarkers(preference.getSnapshot())
    })
  }, 'web-dsh-web-extension: html markers')

  ctx.slots.inject('settings.general.item', () => ctx.slots.register({
    name: 'settings.general.item',
    id: 'web-dsh-layout',
    order: 30,
    locale: NS,
    inject: (): LayoutRowInjected => ({
      hooks: { preference },
      setPreference: (patch) => {
        const next = { ...preference.getSnapshot(), ...patch }
        preference.set(next)
        savePreference(next)
      },
    }),
  }, LayoutRow))
}
