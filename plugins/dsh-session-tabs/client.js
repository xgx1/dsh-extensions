/**
 * dsh-session-tabs (adapted) — Client half for a dynamic Cordis Plugin.
 * Based on seekerwxy/dsh-session-tabs (MIT, (c) 2025 seekerwxy):
 * https://github.com/seekerwxy/dsh-session-tabs
 *
 * Adaptations for this DSH deployment:
 *  - close-last-tab: sessions.clear() -> workspaces.startSession()
 *
 * Usage: paste this function body as code.client in cordis_define.
 */
return {
  apply(ctx) {
    const slots = ctx.get('slots')
    if (slots === undefined) return

    const BAR_HEIGHT = 34

    const CSS = `
.dsh-tabs-bar{position:fixed;top:0;left:0;right:0;height:${BAR_HEIGHT}px;display:flex;align-items:center;gap:4px;padding:0 10px;box-sizing:border-box;background:var(--dsw-alias-bg-base,#f9fafb);border-bottom:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.08));z-index:1000;pointer-events:auto;overflow-x:auto;scrollbar-width:none;font-size:13px;line-height:20px}
.dsh-tabs-bar::-webkit-scrollbar{display:none}
.dsh-tabs-tab{display:inline-flex;align-items:center;gap:6px;height:24px;max-width:200px;padding:0 4px 0 10px;border:none;border-radius:7px;background:transparent;color:var(--dsw-alias-label-secondary,#61666b);cursor:pointer;white-space:nowrap;flex:none;font:inherit;user-select:none}
.dsh-tabs-tab:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06));color:var(--dsw-alias-label-primary,#0f1115)}
.dsh-tabs-tab[data-active]{background:var(--dsw-alias-bg-layer-1,#ffffff);color:var(--dsw-alias-label-primary,#0f1115);font-weight:500;box-shadow:inset 0 -2px 0 var(--dsw-alias-brand-primary,#3964fe)}
.dsh-tabs-title{overflow:hidden;text-overflow:ellipsis;min-width:0}
.dsh-tabs-dot{width:6px;height:6px;border-radius:50%;flex:none;background:var(--dsw-alias-state-warn-primary,#f7ad31)}
.dsh-tabs-dot[data-running]{background:var(--dsw-alias-brand-primary,#3964fe);animation:dsh-tabs-pulse 1.2s ease-in-out infinite}
.dsh-tabs-dot[data-completed]{background:var(--dsw-alias-state-success-primary,#12b76a)}
@keyframes dsh-tabs-pulse{0%,100%{opacity:1}50%{opacity:.3}}
@media (prefers-reduced-motion:reduce){.dsh-tabs-dot[data-running]{animation:none}}
.dsh-tabs-close{display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;margin:0 -2px 0 2px;padding:0;border:none;border-radius:4px;background:transparent;color:var(--dsw-alias-label-tertiary,#81858c);cursor:pointer;flex:none;font-size:12px;line-height:1}
.dsh-tabs-close:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06));color:var(--dsw-alias-label-primary,#0f1115)}
.dsh-tabs-new{display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;margin-left:2px;padding:0;border:none;border-radius:7px;background:transparent;color:var(--dsw-alias-label-secondary,#61666b);cursor:pointer;flex:none;font-size:16px;line-height:1}
.dsh-tabs-new:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06));color:var(--dsw-alias-label-primary,#0f1115)}
#root{padding-top:${BAR_HEIGHT}px;box-sizing:border-box}
`

    ctx.effect(() => styles.insert(CSS))

    function SessionTabs(props) {
      const { useSessions, sessions, workspaces } = props
      const snap = useSessions((s) => ({ current: s.current, byId: s.byId }))
      const current = snap.current
      const byId = snap.byId
      const [order, setOrder] = React.useState(() => (current === undefined ? [] : [current]))

      React.useEffect(() => {
        if (current === undefined) return
        setOrder((prev) => (prev.indexOf(current) >= 0 ? prev : prev.concat([current])))
      }, [current])

      const switchTab = (id) => {
        if (sessions !== undefined && id !== current) sessions.open(id)
      }

      const closeTab = (id) => {
        const next = order.filter((x) => x !== id)
        setOrder(next)
        if (id === current && sessions !== undefined) {
          if (next.length > 0) sessions.open(next[next.length - 1])
          else if (workspaces !== undefined) workspaces.startSession()
        }
      }

      const newTab = () => {
        if (workspaces !== undefined) workspaces.startSession()
      }

      const children = []
      for (const id of order) {
        const summary = byId[id]
        if (summary === undefined) continue
        const title = summary.displayTitle || id
        let dot = null
        if (summary.running === true) {
          dot = React.createElement('span', { className: 'dsh-tabs-dot', 'data-running': true })
        } else if (summary.pendingInteraction !== undefined) {
          dot = React.createElement('span', { className: 'dsh-tabs-dot', 'data-pending': true })
        } else if (summary.completed === true) {
          dot = React.createElement('span', { className: 'dsh-tabs-dot', 'data-completed': true })
        }
        children.push(React.createElement('div', {
          key: id,
          className: 'dsh-tabs-tab',
          'data-active': id === current ? true : undefined,
          onClick: () => switchTab(id),
          title,
        },
          dot,
          React.createElement('span', { className: 'dsh-tabs-title' }, title),
          React.createElement('button', {
            type: 'button',
            className: 'dsh-tabs-close',
            'aria-label': '关闭标签页',
            onClick: (e) => { e.stopPropagation(); closeTab(id) },
          }, '×'),
        ))
      }
      children.push(React.createElement('button', {
        key: '__new__',
        type: 'button',
        className: 'dsh-tabs-new',
        'aria-label': '新建会话',
        title: '新建会话',
        onClick: newTab,
      }, '+'))

      return React.createElement('div', { className: 'dsh-tabs-bar', 'data-dsh-tabs': true }, ...children)
    }

    ctx.effect(() => slots.inject('shell.overlay', () => slots.register(
      { name: 'shell.overlay', id: 'session-tabs', order: -50 },
      (props) => React.createElement(SessionTabs, {
        useSessions: props.useSessions,
        sessions: ctx.get('sessions'),
        workspaces: ctx.get('workspaces'),
      }),
    )))
  },
}
