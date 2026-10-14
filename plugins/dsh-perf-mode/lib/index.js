//#region src/index.ts
/**
 * Host loader entry for the browser-only performance plugin.
 *
 * The row must exist in the host composition because `ctx.clientModules`
 * discovers browser halves by scanning the host Loader's entries for packages
 * declaring `dsh.client`. It provides no host-side behavior.
 */
/** Provides no host-side behavior. */
function apply() {}
//#endregion
export { apply };
