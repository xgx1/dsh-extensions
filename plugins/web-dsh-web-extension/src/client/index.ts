/**
 * Browser loader entry for the reserved web-dsh-web-extension row.
 *
 * No behavior: the layout preference moved into dsh itself. The empty client
 * bundle keeps the `./client` export the `dsh.client` declaration requires, so
 * the roster row stays valid without contributing UI, styles, or a settings row.
 */

/** Provides no browser-side behavior. */
export function apply(): void {}
