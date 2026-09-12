/**
 * web-dsh-web-extension — browser half: registers the Conversation Layout
 * settings row into the official General section and owns the persisted
 * preference store. The Host half already stamped the layout markers at page
 * load; the settings row keeps them in sync on change, so the effect is
 * immediate and survives refresh (localStorage) and restart (boot script).
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the SlotRegistry service merge (ctx.slots).
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls the settings-domain SlotMap merge (settings.general.item)
// and the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { LayoutRow } from './LayoutRow.tsx'
import { NS, dictionaries, type WebDshKey } from './locales.ts'
import { createLayoutRowStore } from './settings-store.ts'

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

  // The preference store rides the row's slot registration; its baked `set`
  // action persists every change, and the row mirrors each snapshot onto the
  // document-root markers that gate the host-injected override stylesheet.
  ctx.slots.inject('settings.general.item', () => ctx.slots.register({
    name: 'settings.general.item',
    id: 'web-dsh-layout',
    order: 30,
    store: createLayoutRowStore(),
    locale: NS,
  }, LayoutRow))
}
