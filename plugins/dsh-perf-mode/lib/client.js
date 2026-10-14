window.__ModuleLoader__.load({
	id: "dsh-perf-mode",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		//#region src/client/index.js
		/**
		 * Global stylesheet that removes the GUI's animated and translucent
		 * presentation without editing any component.
		 *
		 * Three families are spread across dozens of CSS modules, so one global
		 * sheet is smaller and more complete than per-component edits:
		 *
		 * - animation/transition/scroll-behavior: every element and pseudo-element.
		 * - backdrop blur: the `--dsw-menu-backdrop-filter` token (blur(40px)
		 *   saturate(150%)) plus the handful of rules that hardcode a blur.
		 * - translucent surfaces: menus and popovers fill with a see-through
		 *   color and rely on the blur behind them. Each is redefined as its own
		 *   composite over the theme's opaque base, `color-mix(<fill> <alpha>%,
		 *   <base>)`, so the result is the same color with no transparency.
		 */
		const STYLE = [
			'/* dsh-perf-mode: animation, transition, and smooth scrolling off */',
			'*, *::before, *::after {',
			'  animation: none !important;',
			'  transition: none !important;',
			'  scroll-behavior: auto !important;',
			'}',
			'/* dsh-perf-mode: backdrop blur off, token consumers and hardcoded rules */',
			':root { --dsw-menu-backdrop-filter: none; }',
			'*, *::before, *::after {',
			'  backdrop-filter: none !important;',
			'  -webkit-backdrop-filter: none !important;',
			'}',
			'/* dsh-perf-mode: menu surfaces composite over the opaque base instead of showing through */',
			'html body {',
			'  --dsw-menu-surface-fill: color-mix(in srgb, rgb(248 249 250) 58%, var(--dsw-alias-bg-base));',
			'  --dsw-alias-menu-group-header-fill: color-mix(in srgb, rgb(248 249 250) 94%, var(--dsw-alias-bg-base));',
			'  --dsw-alias-button-tool-bar-fill: color-mix(in srgb, rgb(84 85 87) 50%, var(--dsw-alias-bg-base));',
			'  --dsw-alias-button-tool-bar-fill-invisible: color-mix(in srgb, rgb(31 31 31) 36%, var(--dsw-alias-bg-base));',
			'  --dsw-alias-button-tool-bar-hover: color-mix(in srgb, rgb(84 85 87) 60%, var(--dsw-alias-bg-base));',
			'}',
			'html body[data-ds-dark-theme] {',
			'  --dsw-menu-surface-fill: color-mix(in srgb, rgb(67 69 74) 45%, var(--dsw-alias-bg-base));',
			'  --dsw-alias-menu-group-header-fill: color-mix(in srgb, rgb(48 49 54) 94%, var(--dsw-alias-bg-base));',
			'  --dsw-alias-button-tool-bar-fill: color-mix(in srgb, rgb(84 85 87) 50%, var(--dsw-alias-bg-base));',
			'  --dsw-alias-button-tool-bar-fill-invisible: color-mix(in srgb, rgb(31 31 31) 36%, var(--dsw-alias-bg-base));',
			'  --dsw-alias-button-tool-bar-hover: color-mix(in srgb, rgb(84 85 87) 60%, var(--dsw-alias-bg-base));',
			'}',
		].join('\n')
		/**
		 * Force every scripted scroll and element animation to its end state:
		 * stylesheets cannot reach `element.animate` or `{ behavior: 'smooth' }`.
		 */
		function installScriptOverrides() {
			const animate = Element.prototype.animate
			Element.prototype.animate = function (keyframes, options) {
				const zeroed = typeof options === 'number' || options === undefined
					? { duration: 0 }
					: { ...options, duration: 0, delay: 0, endDelay: 0 }
				return animate.call(this, keyframes, zeroed)
			}
			const patched = new Map()
			for (const method of ['scrollIntoView', 'scrollTo', 'scrollBy']) {
				const native = Element.prototype[method]
				if (typeof native !== 'function') continue
				patched.set(method, native)
				Element.prototype[method] = function (arg, rest) {
					const instant = arg !== null && typeof arg === 'object' && 'behavior' in arg
						? { ...arg, behavior: 'auto' }
						: arg
					return native.call(this, instant, rest)
				}
			}
			return () => {
				Element.prototype.animate = animate
				for (const [method, native] of patched) Element.prototype[method] = native
			}
		}
		/**
		 * Inject the stylesheet and the script overrides; `ctx.effect` removes both
		 * when the plugin unloads.
		 * @param ctx - client plugin context providing `effect`.
		 */
		function apply(ctx) {
			const style = document.createElement('style')
			style.dataset.dshPerfMode = ''
			style.textContent = STYLE
			document.head.append(style)
			const restore = installScriptOverrides()
			ctx.effect(() => () => {
				style.remove()
				restore()
			})
		}
		//#endregion
		exports.apply = apply;
		exports.STYLE = STYLE;
		return module.exports;
	}
});
