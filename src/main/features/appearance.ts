import { readFileSync } from 'node:fs'
import type { AppSettings, Theme } from '@shared/types'

export type Appearance = AppSettings['appearance']

/** The window's background in each theme, `--canvas` in tokens.css. test/appearance.test.ts checks they still match. */
export const WINDOW_BG: Record<Theme, string> = { dark: '#141414', light: '#f2f2f2' }

/**
 * How much each Font size zooms the page, the `zoom` on `#root` in settings.css. Electron's page zoom doesn't include it, so the traffic
 * lights, which main places, multiply it in (KERNEL-972). test/appearance.test.ts checks they still match.
 */
export const FONT_ZOOM: Record<Appearance['fontSize'], number> = { small: 0.92, default: 1, large: 1.1 }

export const DEFAULT_APPEARANCE: Appearance = { theme: 'dark', fontSize: 'default', density: 'comfortable', pointerCursors: false, reduceMotion: false }

/** The flag main hands the page through `additionalArguments`, read by the preload. */
export const APPEARANCE_ARG = '--kernel-appearance='

const oneOf = <T>(v: unknown, values: readonly T[], fallback: T): T => (values.includes(v as T) ? (v as T) : fallback)

/** A saved appearance group, each key checked on its own. A missing or wrong key keeps its default. */
export function appearanceOf(v: unknown): Appearance {
  const a = v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
  const d = DEFAULT_APPEARANCE
  return {
    theme: oneOf(a.theme, ['dark', 'light', 'system'] as const, d.theme),
    fontSize: oneOf(a.fontSize, ['default', 'small', 'large'] as const, d.fontSize),
    density: oneOf(a.density, ['comfortable', 'compact'] as const, d.density),
    pointerCursors: typeof a.pointerCursors === 'boolean' ? a.pointerCursors : d.pointerCursors,
    reduceMotion: typeof a.reduceMotion === 'boolean' ? a.reduceMotion : d.reduceMotion
  }
}

/**
 * Settings, Appearance from settings.json, read before the window exists so its first frame matches (KERNEL-708). Kernel
 * loads settings later, after the window opens. A missing or unreadable file gives the defaults: dark.
 */
export function readAppearance(settingsFile: string): Appearance {
  try { return appearanceOf(JSON.parse(readFileSync(settingsFile, 'utf8'))?.appearance) } catch { return DEFAULT_APPEARANCE }
}

/** The theme to draw. 'system' follows macOS. */
export const resolvedTheme = (pref: Appearance['theme'], systemDark: boolean): Theme => (pref === 'system' ? (systemDark ? 'dark' : 'light') : pref)

/** What WindowAppearance needs of Electron's nativeTheme. */
export interface NativeThemeLike {
  themeSource: 'system' | 'light' | 'dark'
  readonly shouldUseDarkColors: boolean
  on(event: 'updated', listener: () => void): unknown
}

/**
 * Keeps native UI and the window's background on Settings, Appearance. `themeSource` makes menus, context menus and dialogs
 * follow Dark or Light, and the page's prefers-color-scheme with them. The background is what shows before the page paints
 * and while it resizes. It follows a change in Settings, and a change in macOS while on Match system.
 */
export class WindowAppearance {
  private a: Appearance

  constructor(private readonly o: { nativeTheme: NativeThemeLike; window: () => { setBackgroundColor(color: string): void } | null | undefined; initial: Appearance; onFontZoom?: (zoom: number) => void }) {
    this.a = o.initial
    o.nativeTheme.themeSource = this.a.theme
    o.nativeTheme.on('updated', () => this.paint())
  }

  get current(): Appearance { return this.a }

  get theme(): Theme { return resolvedTheme(this.a.theme, this.o.nativeTheme.shouldUseDarkColors) }

  get backgroundColor(): string { return WINDOW_BG[this.theme] }

  /** How much the Font size zooms the page. */
  get fontZoom(): number { return FONT_ZOOM[this.a.fontSize] }

  /** The flag that hands this appearance to a new window's page. */
  get arg(): string { return APPEARANCE_ARG + JSON.stringify(this.a) }

  /** Settings changed. A new Font size zooms the page, so the traffic lights move with it. */
  set(a: Appearance) {
    const theme = a.theme !== this.a.theme
    const font = a.fontSize !== this.a.fontSize
    this.a = a
    if (font) this.o.onFontZoom?.(this.fontZoom)
    if (!theme) return
    // Setting themeSource fires 'updated' when the resolved colors change, but not from system to the theme macOS is in.
    this.o.nativeTheme.themeSource = a.theme
    this.paint()
  }

  private paint() { this.o.window()?.setBackgroundColor(this.backgroundColor) }
}
