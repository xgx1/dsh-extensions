/**
 * General Settings row for the Conversation Layout preference: one row, two
 * selectors — content width (full/standard) and composer position
 * (left/centered). Inline styles keep the extension free of a CSS-module
 * build pipeline; token names come from the official design system.
 */
import { useState } from 'react'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { IconChevronDownOutline14, Menu } from '@deepseek-ai/dsh-client-ui-primitives'
import type { LayoutPreference } from './persist.ts'
import { NS, type WebDshKey } from './locales.ts'

/** Registration-side preference face. */
export interface LayoutRowInjected {
  hooks: {
    /** Persisted layout preference bound as usePreference. */
    preference: SnapshotStore<LayoutPreference>
  }
  /** Change one or both layout fields. */
  setPreference: (patch: Partial<LayoutPreference>) => void
}

/** Full Settings-row props. */
export type LayoutRowProps =
  PropsRuntime<'settings.general.item'>
  & PropsLocale<typeof NS>
  & InjectFace<LayoutRowInjected>

/** Content-width choices; labels resolve through the locale dictionary. */
const WIDTH_OPTIONS: readonly { id: 'wide' | 'standard'; label: WebDshKey }[] = [
  { id: 'wide', label: 'settings.layout.width.wide' },
  { id: 'standard', label: 'settings.layout.width.standard' },
]

/** Composer-position choices; labels resolve through the locale dictionary. */
const ALIGN_OPTIONS: readonly { id: 'left' | 'center'; label: WebDshKey }[] = [
  { id: 'left', label: 'settings.layout.composer.left' },
  { id: 'center', label: 'settings.layout.composer.center' },
]

/** Inline row styles (mirrors the official EnterBehaviorRow sheet). */
const styles: Record<string, React.CSSProperties> = {
  row: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '16px 0',
    borderBottom: '1px solid var(--dsw-alias-border-l2)',
  },
  rowText: {
    flex: 1,
    minWidth: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
    paddingRight: 48,
  },
  title: {
    fontSize: 14,
    lineHeight: '22px',
    color: 'var(--dsw-alias-label-primary)',
  },
  desc: {
    fontSize: 12,
    lineHeight: '18px',
    color: 'var(--dsw-alias-label-tertiary)',
  },
  selector: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 12,
    height: 36,
    padding: '0 14px',
    border: 'none',
    borderRadius: 18,
    background: 'var(--dsw-alias-bg-module-platform)',
    font: 'inherit',
    fontSize: 14,
    lineHeight: '22px',
    color: 'var(--dsw-alias-label-primary)',
    cursor: 'pointer',
  },
}

/**
 * Render the Conversation Layout preference row.
 * @param props - composed Settings slot props.
 * @returns the preference row.
 */
export function LayoutRow({ usePreference, setPreference, t }: LayoutRowProps) {
  const preference = usePreference(value => value)
  const [widthOpen, setWidthOpen] = useState(false)
  const [alignOpen, setAlignOpen] = useState(false)
  const widthLabel = preference.wide ? 'settings.layout.width.wide' : 'settings.layout.width.standard'
  const alignLabel = preference.left ? 'settings.layout.composer.left' : 'settings.layout.composer.center'

  return (
    <div style={styles.row} data-wde-row>
      <div style={styles.rowText}>
        <div style={styles.title}>{t('settings.layout.title')}</div>
        <div style={styles.desc}>{t('settings.layout.description')}</div>
      </div>
      <Menu
        open={widthOpen}
        onClose={() => { setWidthOpen(false) }}
        items={WIDTH_OPTIONS.map(option => ({ id: option.id, label: t(option.label) }))}
        selectedId={preference.wide ? 'wide' : 'standard'}
        onSelect={(id) => {
          setWidthOpen(false)
          setPreference({ wide: id === 'wide' })
        }}
        align="end"
        portal
        anchor={(
          <button
            type="button"
            style={styles.selector}
            aria-haspopup="menu"
            aria-expanded={widthOpen}
            onClick={() => { setWidthOpen(value => !value) }}
          >
            {t(widthLabel)}
            <IconChevronDownOutline14 />
          </button>
        )}
      />
      <Menu
        open={alignOpen}
        onClose={() => { setAlignOpen(false) }}
        items={ALIGN_OPTIONS.map(option => ({ id: option.id, label: t(option.label) }))}
        selectedId={preference.left ? 'left' : 'center'}
        onSelect={(id) => {
          setAlignOpen(false)
          setPreference({ left: id === 'left' })
        }}
        align="end"
        portal
        anchor={(
          <button
            type="button"
            style={styles.selector}
            aria-haspopup="menu"
            aria-expanded={alignOpen}
            onClick={() => { setAlignOpen(value => !value) }}
          >
            {t(alignLabel)}
            <IconChevronDownOutline14 />
          </button>
        )}
      />
    </div>
  )
}
