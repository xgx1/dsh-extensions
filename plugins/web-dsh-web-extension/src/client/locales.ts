/**
 * Copy for the Conversation Layout settings row. Product copy is Chinese;
 * the English dictionary mirrors it for the built-in fallback.
 */

export const zh = {
  'settings.layout.title': '对话布局',
  'settings.layout.description': '对话内容宽度与输入框位置',
  'settings.layout.width.wide': '铺满',
  'settings.layout.width.standard': '标准',
  'settings.layout.composer.left': '左对齐',
  'settings.layout.composer.center': '居中',
} as const

export const en: Record<WebDshKey, string> = {
  'settings.layout.title': 'Conversation Layout',
  'settings.layout.description': 'Conversation content width and composer position',
  'settings.layout.width.wide': 'Full width',
  'settings.layout.width.standard': 'Standard',
  'settings.layout.composer.left': 'Left',
  'settings.layout.composer.center': 'Centered',
}

/** Copy key union (the zh dictionary is the key source of truth). */
export type WebDshKey = keyof typeof zh

/** Locale namespace owned by this extension. */
export const NS = 'web-dsh-extension'

/** Dictionaries registered under {@link NS}. */
export const dictionaries = { zh, en }
