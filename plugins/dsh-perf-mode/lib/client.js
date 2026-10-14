window.__ModuleLoader__.load({
	id: "dsh-perf-mode",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		//#region src/client/index.js
		/**
		 * Global stylesheet that removes every animation, transition, and
		 * backdrop blur from the DSH web GUI.
		 *
		 * Why a stylesheet instead of editing components: the effects are spread
		 * across dozens of CSS modules, and the expensive parts are (a) the
		 * `--dsw-menu-backdrop-filter` token (blur(40px) saturate(150%)) read by
		 * every menu and popover, and (b) per-component `animation`/`transition`
		 * declarations. One global sheet removes all of them without touching
		 * dsh source. `scroll-behavior: auto` removes smooth scrolling, which is
		 * the remaining compositor animation.
		 */
		const STYLE = [
			'/* dsh-perf-mode: animations and transitions off */',
			'*, *::before, *::after {',
			'  animation: none !important;',
			'  transition: none !important;',
			'  scroll-behavior: auto !important;',
			'}',
			'/* dsh-perf-mode: backdrop blur off (token consumers and hardcoded rules) */',
			':root { --dsw-menu-backdrop-filter: none; }',
			'*, *::before, *::after {',
			'  backdrop-filter: none !important;',
			'  -webkit-backdrop-filter: none !important;',
			'}',
		].join('\n')
		/**
		 * Inject the stylesheet and remove it when the plugin unloads.
		 * @param ctx - client plugin context providing `effect`.
		 */
		function apply(ctx) {
			const style = document.createElement('style')
			style.dataset.dshPerfMode = ''
			style.textContent = STYLE
			document.head.append(style)
			ctx.effect(() => () => { style.remove() })
		}
		//#endregion
		exports.apply = apply;
		exports.STYLE = STYLE;
		return module.exports;
	}
});
