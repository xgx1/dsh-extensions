window.__ModuleLoader__.load({
	id: "dsh-sidebar-taskbar",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react_dom_client = require("react-dom/client");
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");
		//#region src/client/tasks.ts
		/** True when the summary carries any signal the task bar should show. */
		function isActive(summary) {
			return summary.running || summary.pendingInteraction !== void 0 || summary.completed === true;
		}
		/** Sort one group: finished newest-first, live/waiting oldest-first. */
		function byUpdatedAt(rows, summaries, newestFirst) {
			return [...rows].sort((left, right) => {
				const a = summaries.get(left.id)?.updatedAt ?? 0;
				const b = summaries.get(right.id)?.updatedAt ?? 0;
				return newestFirst ? b - a : a - b;
			});
		}
		/**
		* Classify one session list snapshot into the three task-bar groups.
		* @param state - the sessions list snapshot.
		* @returns the three groups (each empty when nothing signals).
		*/
		function classifyTasks(state) {
			const done = [];
			const running = [];
			const waiting = [];
			const summaries = /* @__PURE__ */ new Map();
			for (const id of state.ids) {
				const summary = state.byId[id];
				if (summary === void 0 || !isActive(summary)) continue;
				summaries.set(id, summary);
				const row = {
					id,
					title: summary.displayTitle
				};
				if (summary.pendingInteraction !== void 0) waiting.push(row);
				else if (summary.running) running.push(row);
				else done.push(row);
			}
			return {
				done: byUpdatedAt(done, summaries, true),
				running: byUpdatedAt(running, summaries, false),
				waiting: byUpdatedAt(waiting, summaries, false)
			};
		}
		//#endregion
		//#region src/client/TaskBar.tsx
		/**
		* Sidebar task bar: three groups (finished-running green on top, running
		* red, waiting-for-reply amber) above the workspace browser. One row per
		* session, click to jump. Auto-hides while the sidebar is collapsed to the
		* narrow rail.
		*/
		/** Sidebar column width below which the rail is considered collapsed. */
		const COLLAPSED_WIDTH = 100;
		/** Group copy (product copy is Chinese). */
		const GROUP_LABELS = {
			done: "运行结束",
			running: "运行中",
			waiting: "等待回复"
		};
		/** Dot colors: green done, red running, amber waiting (official signal hues). */
		const DOT_COLORS = {
			done: "#22c55e",
			running: "#ef4444",
			waiting: "#f59e0b"
		};
		const styles = {
			bar: {
				display: "flex",
				flexDirection: "column",
				gap: 2,
				padding: "8px 12px 4px",
				borderBottom: "1px solid var(--dsw-alias-border-l2)",
				background: "var(--dsw-alias-bg-base)",
				minWidth: 0
			},
			groupTitle: {
				fontSize: 11,
				lineHeight: "16px",
				color: "var(--dsw-alias-label-tertiary)",
				paddingTop: 4
			},
			row: {
				display: "flex",
				alignItems: "center",
				gap: 8,
				width: "100%",
				minWidth: 0,
				padding: "3px 4px",
				border: "none",
				borderRadius: 6,
				background: "transparent",
				font: "inherit",
				fontSize: 13,
				lineHeight: "20px",
				color: "var(--dsw-alias-label-primary)",
				textAlign: "left",
				cursor: "pointer"
			},
			rowHover: { background: "var(--dsw-alias-interactive-bg-hover)" },
			dot: {
				flex: "none",
				width: 8,
				height: 8,
				borderRadius: "50%"
			},
			title: {
				flex: 1,
				minWidth: 0,
				overflow: "hidden",
				textOverflow: "ellipsis",
				whiteSpace: "nowrap"
			}
		};
		/** One group of rows. */
		function Group({ label, rows, color, onJump }) {
			if (rows.length === 0) return null;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				style: styles.groupTitle,
				children: label
			}), rows.map((row) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
				type: "button",
				style: styles.row,
				onClick: () => {
					onJump(row.id);
				},
				title: row.title,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { style: {
					...styles.dot,
					background: color
				} }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					style: styles.title,
					children: row.title
				})]
			}, row.id))] });
		}
		/**
		* Render the task bar from the live sessions snapshot.
		* @param props - the sessions face.
		* @returns the bar, or null when nothing signals or the sidebar is collapsed.
		*/
		function TaskBar({ sessions }) {
			const groups = classifyTasks((0, react.useSyncExternalStore)((callback) => sessions.list.subscribe(callback), () => sessions.list.getSnapshot()));
			const total = groups.done.length + groups.running.length + groups.waiting.length;
			const container = (0, react.useRef)(null);
			const [collapsed, setCollapsed] = (0, react.useState)(false);
			(0, react.useEffect)(() => {
				const el = container.current;
				const parent = el?.parentElement ?? null;
				if (el === null || parent === null) return;
				const update = () => {
					setCollapsed(parent.clientWidth < COLLAPSED_WIDTH);
				};
				update();
				const observer = new ResizeObserver(update);
				observer.observe(parent);
				return () => {
					observer.disconnect();
				};
			}, []);
			if (total === 0 || collapsed) return null;
			const jump = (id) => {
				sessions.open(id);
			};
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				ref: container,
				style: styles.bar,
				"data-dsh-taskbar": "",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Group, {
						label: GROUP_LABELS.done,
						rows: groups.done,
						color: DOT_COLORS.done,
						onJump: jump
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Group, {
						label: GROUP_LABELS.running,
						rows: groups.running,
						color: DOT_COLORS.running,
						onJump: jump
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Group, {
						label: GROUP_LABELS.waiting,
						rows: groups.waiting,
						color: DOT_COLORS.waiting,
						onJump: jump
					})
				]
			});
		}
		//#endregion
		//#region src/client/mount.tsx
		/**
		* DOM mounting: one React root rendered into a container inserted directly
		* above the official `sidebar.workspaces` slot (the workspace browser). The
		* root waits for the slot (the shell mounts asynchronously) and everything
		* is wrapped so a DOM failure degrades the task bar, never the GUI boot.
		*/
		/** The official workspace-browser slot container (rendered with data-slot). */
		const WORKSPACES_SELECTOR = "[data-slot=\"sidebar.workspaces\"]";
		/**
		* Mount the task bar above the workspace browser.
		* @param sessions - the sessions face for the bar.
		* @returns a disposer unmounting the tree and removing the anchor.
		*/
		function mountTaskBar(sessions) {
			let root;
			let anchor;
			let disposed = false;
			let observer;
			const tryFind = () => {
				if (disposed || anchor !== void 0) return;
				const slot = document.querySelector(WORKSPACES_SELECTOR);
				if (slot === null || slot.parentElement === null) return;
				anchor = document.createElement("div");
				anchor.setAttribute("data-dsh-taskbar-anchor", "");
				slot.parentElement.insertBefore(anchor, slot);
				root = (0, react_dom_client.createRoot)(anchor);
				root.render(/* @__PURE__ */ (0, react_jsx_runtime.jsx)(TaskBar, { sessions }));
			};
			observer = new MutationObserver(tryFind);
			observer.observe(document.body, {
				childList: true,
				subtree: true
			});
			tryFind();
			return () => {
				disposed = true;
				observer?.disconnect();
				root?.unmount();
				anchor?.remove();
			};
		}
		//#endregion
		//#region src/client/index.ts
		/** Required services: the sessions list + navigation. */
		const inject = ["sessions"];
		/**
		* Mount the browser half.
		* @param ctx - client root context.
		*/
		function apply(ctx) {
			ctx.effect(() => mountTaskBar({
				list: ctx.sessions.list,
				open: (id) => {
					ctx.sessions.open(id);
				}
			}), "dsh-sidebar-taskbar: mount");
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map