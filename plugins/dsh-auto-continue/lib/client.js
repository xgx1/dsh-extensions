window.__ModuleLoader__.load({
	id: "dsh-auto-continue",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		//#region src/client/index.js
		/**
		 * dsh-auto-continue: after the DSH web GUI truncates an assistant turn at
		 * its output-token cap, automatically click the turn-tail "branch / continue"
		 * button so the model keeps writing until it finishes.
		 *
		 * Known limit: the DOM does not mark whether a tail ended because of
		 * max-tokens, so every clickable branch button is auto-clicked — not only
		 * truncation tails. shortcut: cannot distinguish max-tokens tails from
		 * user-invoked forks in the DOM, so non-truncation tails may also be
		 * clicked; upgrade by observing turn-max-tokens notice nodes if the
		 * conversation graph exposes them to clients.
		 */
		var processed = new Set()
		function isCopyButton(button) {
			var label = (button.getAttribute('aria-label') || '').toLowerCase()
			return /copy|\u590d\u5236/.test(label)
		}
		function branchButton(tail) {
			var buttons = tail.querySelectorAll('button[type="button"][aria-label]')
			for (var i = 0; i < buttons.length; i++) {
				var b = buttons[i]
				if (b.hasAttribute('aria-disabled') || b.hasAttribute('data-unavailable')) continue
				if (isCopyButton(b)) continue
				return b
			}
			return null
		}
		function scan() {
			document.querySelectorAll('[data-turn-tail]').forEach(function (tail) {
				var seq = tail.getAttribute('data-turn-tail')
				if (processed.has(seq)) return
				var btn = branchButton(tail)
				if (!btn) return
				processed.add(seq)
				btn.click()
			})
		}
		function apply(ctx) {
			var observer = new MutationObserver(scan)
			observer.observe(document.body, { childList: true, subtree: true })
			scan()
			ctx.effect(function () {
				observer.disconnect()
			})
		}
		//#endregion
		exports.apply = apply
		return module.exports
	}
})