window.__ModuleLoader__.load({
	id: "dsh-dracula-theme",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		//#region src/client/index.js
		/**
		 * DSH Web GUI 的 Dracula 主题（Atom Dracula 最全功能版）。
		 *
		 * 机制：客户端主题服务 `ctx.theme`（@deepseek-ai/dsh-client-ui-theme）把
		 * 主题定义里的 tokens 作为**行内 CSS 变量写在 body 上**，所以
		 *
		 *   · 覆盖 `--dsw-alias-*`：直接换掉具名语义色（面、线、字、品牌、状态）；
		 *   · 覆盖 `--dsw-static-*`：换掉底层色阶，凡是用 var() 引用该色阶、而我们
		 *     没单独列出的别名会一起跟着变 —— 这是「一次改一大片」的关键；
		 *   · 覆盖 `--shiki-token-*`：DSH 代码块用的是 shiki 的 css-variables 主题，
		 *     这些变量定义在 body[data-ds-dark-theme] 上，行内变量优先级更高，于是
		 *     语法高亮也换成 Dracula 的配色。
		 *
		 * 官方主题 id（light/dark/system）不允许重复注册，本插件注册 id=`dracula`。
		 * 自定义 id 不会被写进用户设置（setTheme 只持久化官方三个值），所以每次
		 * 激活都重新选中一次；在设置 → 外观里切走只对当前这次页面会话有效，刷新即回来。
		 * 想彻底禁用：在侧边栏 Plugins 页关掉本插件行（或从 profile bundle 列表移除）。
		 */
		/** Atom Dracula 调色板（本插件唯一色源，换版本只改这里）。 */
		const PALETTE = {
			bg: "#282a36",
			bgDark: "#21222c",
			bgLight: "#343746",
			line: "#44475a",
			lineDark: "#6272a4",
			fg: "#f8f8f2",
			fgBright: "#ffffff",
			comment: "#6272a4",
			accent: "#bd93f9",
			accentHover: "#ff79c6",
			red: "#ff5555",
			green: "#50fa7b",
			yellow: "#f1fa8c",
			orange: "#ffb86c",
			pink: "#ff79c6",
			cyan: "#8be9fd",
		};
		/** 语义别名：具名色，直接决定面板、文字、按钮、状态长什么样。 */
		const ALIAS_TOKENS = {
			"--dsw-alias-bg-base": PALETTE.bg,
			"--dsw-alias-bg-layer-1": PALETTE.bgDark,
			"--dsw-alias-bg-layer-2": PALETTE.bgLight,
			"--dsw-alias-bg-layer-3": PALETTE.bgLight,
			"--dsw-alias-bg-overlay": PALETTE.bgDark,
			"--dsw-alias-bg-module-platform": PALETTE.bgLight,
			"--dsw-alias-bg-multi-select": PALETTE.line,
			"--dsw-specific-sidebar-fill": PALETTE.bgDark,
			"--dsw-specific-login-input": PALETTE.bgDark,
			"--dsw-specific-selector": PALETTE.bgLight,
			"--dsw-specific-tip": PALETTE.bgLight,
			"--dsw-specific-sidebar-nav-item-active-accent": PALETTE.line,
			"--dsw-alias-border-l1": PALETTE.line,
			"--dsw-alias-border-l2": PALETTE.lineDark,
			"--dsw-alias-label-primary": PALETTE.fg,
			"--dsw-alias-label-secondary": PALETTE.comment,
			"--dsw-alias-label-tertiary": PALETTE.comment,
			"--dsw-alias-label-caption": PALETTE.comment,
			"--dsw-alias-label-dimmed": PALETTE.lineDark,
			"--dsw-alias-label-primary-dimmed": PALETTE.fgBright,
			"--dsw-alias-label-primary-bluish": PALETTE.fg,
			"--dsw-alias-label-primary-foreground": PALETTE.bgDark,
			"--dsw-alias-label-primary-inverted": PALETTE.line,
			"--dsw-alias-brand-primary": PALETTE.accent,
			"--dsw-alias-brand-primary-invert": PALETTE.bg,
			"--dsw-alias-brand-primary-new-colorprimary-new-color": PALETTE.accent,
			"--dsw-alias-brand-text": PALETTE.accent,
			"--dsw-alias-link": PALETTE.accent,
			"--dsw-alias-state-error-primary": PALETTE.red,
			"--dsw-alias-state-success-primary": PALETTE.green,
			"--dsw-alias-state-warn-primary": PALETTE.yellow,
			"--dsw-alias-state-business-primary": PALETTE.pink,
			"--dsw-alias-button-primary-hover": PALETTE.accentHover,
			"--dsw-alias-button-floating-hover": PALETTE.bgLight,
			"--dsw-alias-interactive-bg-hover-solid": PALETTE.bgLight,
			"--dsw-alias-markdown-code-block": PALETTE.bgDark,
			"--dsw-alias-markdown-code-block-banner": PALETTE.bgLight,
			"--dsw-alias-markdown-code-segment-unselected": PALETTE.bgDark,
			"--dsw-alias-markdown-code-segment-selected": PALETTE.line,
			"--dsw-alias-markdown-citation": PALETTE.line,
		};
		/**
		 * 底层色阶：官方暗色别名全部由它 var() 拼出来（bg-base=bluish-950、
		 * sidebar-fill=bluish-900、bg-layer-1=875、layer-2=850、layer-3=800……）。
		 * 换掉色阶，等于把没单独列出的每一条别名一起换成 Dracula。
		 */
		const RAMP_TOKENS = {
			"--dsw-static-neutral-bluish-950": PALETTE.bg,
			"--dsw-static-neutral-bluish-900": PALETTE.bgDark,
			"--dsw-static-neutral-bluish-875": PALETTE.bgDark,
			"--dsw-static-neutral-bluish-850": PALETTE.bgLight,
			"--dsw-static-neutral-bluish-800": PALETTE.line,
			"--dsw-static-neutral-bluish-750": PALETTE.lineDark,
			"--dsw-static-neutral-bluish-700": PALETTE.line,
			"--dsw-static-neutral-bluish-600": PALETTE.comment,
			"--dsw-static-neutral-bluish-500": PALETTE.comment,
			"--dsw-static-neutral-bluish-400": PALETTE.comment,
			"--dsw-static-neutral-bluish-300": PALETTE.comment,
			"--dsw-static-neutral-bluish-200": "#f8f8f2",
			"--dsw-static-neutral-bluish-150": PALETTE.fgBright,
			"--dsw-static-neutral-bluish-100": PALETTE.fgBright,
			"--dsw-static-neutral-bluish-50": PALETTE.fg,
			"--dsw-static-neutral-bluish-1000": PALETTE.bgDark,
			"--dsw-static-neutral-850": PALETTE.line,
			"--dsw-static-neutral-800": PALETTE.line,
			// 暗色块里还用到的几条中性/语义色阶：滚动条与「三级」状态底色
			"--dsw-static-neutral-700": PALETTE.bgLight,
			"--dsw-static-neutral-600": PALETTE.line,
			"--dsw-static-neutral-550": PALETTE.lineDark,
			"--dsw-static-green-900": "#233a2e",
			"--dsw-static-amber-900": "#3a3524",
			"--dsw-static-deepseek-800": "#343746",
			"--dsw-static-red-400": PALETTE.red,
			"--dsw-static-red-500": PALETTE.red,
			"--dsw-static-green-400": PALETTE.green,
			"--dsw-static-green-500": PALETTE.green,
			"--dsw-static-amber-400": PALETTE.yellow,
			"--dsw-static-amber-500": PALETTE.yellow,
			"--dsw-static-amber-600": PALETTE.orange,
			"--dsw-static-blue-400": PALETTE.accent,
			"--dsw-static-blue-450": PALETTE.accent,
			"--dsw-static-blue-500": PALETTE.accent,
			"--dsw-static-deepseek-400": PALETTE.accent,
			"--dsw-static-deepseek-450": PALETTE.accent,
			"--dsw-static-deepseek-500": PALETTE.accentHover,
		};
		/** 语法高亮：shiki css-variables 主题的 token 变量（代码块、diff 预览同用）。 */
		const SHIKI_TOKENS = {
			"--shiki-foreground": PALETTE.fg,
			"--shiki-background": PALETTE.bgDark,
			"--shiki-token-constant": PALETTE.orange,
			"--shiki-token-string": PALETTE.green,
			"--shiki-token-string-expression": PALETTE.green,
			"--shiki-token-comment": PALETTE.comment,
			"--shiki-token-keyword": PALETTE.pink,
			"--shiki-token-parameter": PALETTE.orange,
			"--shiki-token-function": PALETTE.accent,
			"--shiki-token-punctuation": PALETTE.fg,
			"--shiki-token-link": PALETTE.cyan,
		};
		/** 注册给主题服务的完整 token 表（行内 CSS 变量，写在 body 上）。 */
		const TOKENS = Object.assign({}, ALIAS_TOKENS, RAMP_TOKENS, SHIKI_TOKENS);
		/** 主题 id：设置 → 外观 里显示的选择项。 */
		const THEME_ID = "dracula";
		/** 依赖：官方主题服务（提供 ctx.theme）。 */
		const inject = ["theme"];
		/**
		 * 注册主题并选中它。
		 * @param ctx - 客户端 cordis 上下文。
		 */
		function apply(ctx) {
			const theme = ctx.theme;
			ctx.effect(
				() => theme.register({ id: THEME_ID, colorScheme: "dark", tokens: TOKENS }),
				"dsh-dracula-theme: register dracula theme",
			);
			// 自定义 id 不被 theme-settings 接受（合法持久值只有 light/dark/system），所以 settings scope
			// 异步 adopt() 时会把偏好复位成 'system'，本次选中就白做了。挂到 theme/change 上收敛重选：
			// setTheme 在偏好已相等时直接 return，因此最多补写一次，不会死循环。装着插件时主题被钉死。
			const select = () => {
				if (theme.getTheme().preference === THEME_ID) return;
				// 本轮 theme/change 里不能同步 setTheme：publish() 会重入 emit，重入的内层先让
				// 后注册的监听者（ui-layout 的 ThemePresenter）写上 dracula token，外层继续派发
				// 时又拿旧快照（system/dark，token 表为空）把它擦掉 —— 症状是主题服务里
				// active=dracula、DOM 上却一个 token 都没有（2026-10-14 实况）。
				// 推迟一个微任务，等本轮派发结束再选。
				queueMicrotask(() => {
					if (theme.getTheme().preference !== THEME_ID) theme.setTheme(THEME_ID);
				});
			};
			ctx.effect(() => ctx.on("theme/change", select), "dsh-dracula-theme: keep dracula selected");
			select();
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		exports.TOKENS = TOKENS;
		exports.PALETTE = PALETTE;
		return module.exports;
	}
});
