/**
 * web-dsh-web-extension — host half: taps every index response so the layout
 * override stylesheet and the preference bootstrap reach the browser before
 * the shell mounts. The browser half (exports "./client") owns the settings
 * row and the live marker toggles.
 *
 * Zero dsh source changes: this package is a pure profile-bundle overlay on
 * the official web seam (`webServer.tapIndex`, the same one ui-theme uses).
 * @module web-dsh-web-extension
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { injectBoot } from './boot.ts'

/** Required services: the index-tap seam on the shared webserver. */
export const inject = ['webServer']

/**
 * Mount the index transform.
 * @param ctx - context carrying the webServer service.
 */
export function apply(ctx: Context): void {
  ctx.effect(
    () => ctx.webServer.tapIndex(html => injectBoot(html)),
    'web-dsh-web-extension: boot markers',
  )
}
