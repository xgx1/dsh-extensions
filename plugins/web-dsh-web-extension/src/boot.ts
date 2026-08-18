/**
 * Host-rendered bootstrap for the browser's pre-plugin interval: the static
 * layout override stylesheet plus an inline script that reads the persisted
 * preference from localStorage and stamps the matching `<html>` data markers.
 * The client half only toggles those same markers later; every rule is gated
 * on them, so "off" is exactly the stock layout.
 */

/** Storage key shared with the browser-half preference store. */
export const STORAGE_KEY = 'dsh-web-extension'

/**
 * Override stylesheet. All rules target stable data attributes of the shipped
 * DOM (never hashed CSS-module classes) and are gated on the extension's own
 * `<html>` markers:
 * - `--dsh-chat-content-width` is declared on the conversation root (the
 *   `[data-phase]` div) at 748px; `div[data-phase]` (0,1,1) beats the module
 *   class (0,1,0), so the override wins on the same element.
 * - The composer card container centers via `align-items: center`; the
 *   `:has(> [data-composer-card])` seat isolates that container.
 * - The hero-phase composer column centers via `align-self: center`; the
 *   `[data-phase='hero']` prefix keeps the override out of the docked phase
 *   (where an elected takeover overlay can occupy the same first-child seat).
 */
export const LAYOUT_CSS = `
html[data-wde-wide] div[data-phase] {
  --dsh-chat-content-width: 100% !important;
}
html[data-wde-left] [data-composer-seat] div:has(> [data-composer-card]) {
  align-items: flex-start !important;
}
html[data-wde-left] [data-phase='hero'] [data-composer-seat] > :first-child {
  align-self: flex-start !important;
}
`.trim()

/** Inline script stamping the persisted markers before the shell mounts. */
export function buildBootScript(): string {
  return `<script>(() => {
  try {
    const raw = localStorage.getItem(${JSON.stringify(STORAGE_KEY)})
    const p = raw === null ? {} : JSON.parse(raw)
    if (p.wide !== false) document.documentElement.setAttribute('data-wde-wide', '')
    if (p.left !== false) document.documentElement.setAttribute('data-wde-left', '')
  } catch (e) { /* storage unavailable: extension defaults apply */ }
})()</script>`
}

/**
 * Insert the stylesheet after the opening head tag and the boot script after
 * the opening body tag (before the shell mount and module script). Head-less
 * fragments receive the stylesheet at the end; body-less fragments receive
 * the script at the end, where the HTML parser has already synthesized a body.
 * @param html - Raw application index HTML.
 * @returns HTML containing the extension bootstrap.
 */
export function injectBoot(html: string): string {
  const style = `<style data-plugin="web-dsh-web-extension">${LAYOUT_CSS}</style>`
  let out = html
  const head = /<head(?:\s[^>]*)?>/i.exec(out)
  if (head !== null) {
    const at = head.index + head[0].length
    out = `${out.slice(0, at)}${style}${out.slice(at)}`
  } else {
    out = `${style}${out}`
  }
  const body = /<body(?:\s[^>]*)?>/i.exec(out)
  if (body === null) return `${out}${buildBootScript()}`
  const at = body.index + body[0].length
  return `${out.slice(0, at)}${buildBootScript()}${out.slice(at)}`
}
