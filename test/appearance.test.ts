import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { APPEARANCE_ARG, DEFAULT_APPEARANCE, FONT_ZOOM, readAppearance, WINDOW_BG, WindowAppearance, type NativeThemeLike } from '../src/main/features/appearance'

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })
function settingsFile(content?: string) {
  const dir = mkdtempSync(join(tmpdir(), 'kernel-appearance-'))
  dirs.push(dir)
  const file = join(dir, 'settings.json')
  if (content !== undefined) writeFileSync(file, content)
  return file
}

describe('readAppearance', () => {
  it('reads what the user saved', () => {
    const file = settingsFile(JSON.stringify({ version: 2, appearance: { theme: 'light', fontSize: 'large', density: 'compact', pointerCursors: true, reduceMotion: true } }))
    expect(readAppearance(file)).toEqual({ theme: 'light', fontSize: 'large', density: 'compact', pointerCursors: true, reduceMotion: true })
  })
  it('keeps Match system as system', () => {
    expect(readAppearance(settingsFile(JSON.stringify({ appearance: { theme: 'system' } }))).theme).toBe('system')
  })
  it('gives the defaults, dark, for a fresh install, an unreadable file or no appearance', () => {
    expect(readAppearance(settingsFile())).toEqual(DEFAULT_APPEARANCE)
    expect(readAppearance(settingsFile('{ not json'))).toEqual(DEFAULT_APPEARANCE)
    expect(readAppearance(settingsFile('[]'))).toEqual(DEFAULT_APPEARANCE)
    expect(readAppearance(settingsFile(JSON.stringify({ general: { openTo: 'inbox' } })))).toEqual(DEFAULT_APPEARANCE)
  })
  it('keeps the default for each key that is missing or wrong', () => {
    const file = settingsFile(JSON.stringify({ appearance: { theme: 'sepia', fontSize: 'large', density: 3, pointerCursors: 'yes' } }))
    expect(readAppearance(file)).toEqual({ ...DEFAULT_APPEARANCE, fontSize: 'large' })
  })
})

function fakeTheme(systemDark: boolean) {
  const listeners: (() => void)[] = []
  const t = {
    themeSource: 'system' as NativeThemeLike['themeSource'],
    systemDark,
    get shouldUseDarkColors() { return this.themeSource === 'system' ? this.systemDark : this.themeSource === 'dark' },
    on(_e: 'updated', l: () => void) { listeners.push(l) },
    macOS(dark: boolean) { this.systemDark = dark; for (const l of listeners) l() }
  }
  return t
}

describe('WindowAppearance', () => {
  it('moves the traffic lights when the Font size changes, and only then (KERNEL-972)', () => {
    const zooms: number[] = []
    const a = new WindowAppearance({ nativeTheme: fakeTheme(true), window: () => null, initial: DEFAULT_APPEARANCE, onFontZoom: (z) => zooms.push(z) })
    expect(a.fontZoom).toBe(1)
    a.set({ ...DEFAULT_APPEARANCE, theme: 'light' })
    a.set({ ...DEFAULT_APPEARANCE, theme: 'light', fontSize: 'large' })
    a.set({ ...DEFAULT_APPEARANCE, theme: 'light', fontSize: 'large', density: 'compact' })
    a.set({ ...DEFAULT_APPEARANCE, fontSize: 'small' })
    expect(zooms).toEqual([FONT_ZOOM.large, FONT_ZOOM.small])
    expect(a.fontZoom).toBe(FONT_ZOOM.small)
  })
  it('sets native UI to the saved theme and opens on its background', () => {
    const nativeTheme = fakeTheme(true)
    const a = new WindowAppearance({ nativeTheme, window: () => null, initial: { ...DEFAULT_APPEARANCE, theme: 'light' } })
    expect(nativeTheme.themeSource).toBe('light')
    expect(a.theme).toBe('light')
    expect(a.backgroundColor).toBe(WINDOW_BG.light)
  })
  it('follows macOS on Match system, at launch and when it changes', () => {
    const nativeTheme = fakeTheme(false)
    const painted: string[] = []
    const a = new WindowAppearance({ nativeTheme, window: () => ({ setBackgroundColor: (c) => painted.push(c) }), initial: { ...DEFAULT_APPEARANCE, theme: 'system' } })
    expect(nativeTheme.themeSource).toBe('system')
    expect(a.backgroundColor).toBe(WINDOW_BG.light)
    nativeTheme.macOS(true)
    expect(painted).toEqual([WINDOW_BG.dark])
  })
  it('repaints the window and native UI when the theme changes in Settings', () => {
    const nativeTheme = fakeTheme(false)
    const painted: string[] = []
    const a = new WindowAppearance({ nativeTheme, window: () => ({ setBackgroundColor: (c) => painted.push(c) }), initial: DEFAULT_APPEARANCE })
    expect(a.backgroundColor).toBe(WINDOW_BG.dark)
    a.set({ ...DEFAULT_APPEARANCE, fontSize: 'small' })
    expect(painted).toEqual([])
    a.set({ ...DEFAULT_APPEARANCE, theme: 'light' })
    expect(nativeTheme.themeSource).toBe('light')
    expect(painted).toEqual([WINDOW_BG.light])
    expect(JSON.parse(a.arg.slice(APPEARANCE_ARG.length))).toEqual({ ...DEFAULT_APPEARANCE, theme: 'light' })
  })
})

describe('the startup appearance across processes', () => {
  it('paints the window in tokens.css --canvas for each theme', () => {
    const css = readFileSync('src/renderer/src/tokens.css', 'utf8')
    const canvas = (selector: string) => css.slice(css.indexOf(selector)).match(/--canvas:\s*(#[0-9a-f]+)/i)?.[1]
    expect(canvas(":root, [data-theme='dark'] {")).toBe(WINDOW_BG.dark)
    expect(canvas("[data-theme='light'] {")).toBe(WINDOW_BG.light)
  })
  it('zooms the traffic lights by the zoom settings.css gives each Font size', () => {
    const css = readFileSync('src/renderer/src/screens/settings/settings.css', 'utf8')
    for (const [size, zoom] of Object.entries(FONT_ZOOM)) {
      const rule = css.match(new RegExp(`html\\[data-font='${size}'\\] #root \\{ zoom: ([\\d.]+);`))?.[1]
      expect(rule === undefined ? 1 : Number(rule)).toBe(zoom)
    }
    expect(css).toMatch(/data-font='small'/)
    expect(css).toMatch(/data-font='large'/)
  })
  it('the preload reads the flag main passes', () => {
    expect(readFileSync('src/preload/index.ts', 'utf8')).toContain(`'${APPEARANCE_ARG}'`)
  })
})
