import type { AppSettings, ToolCalls } from '@shared/types'
import { SegmentedControl, Select, Toggle } from '../../../ui'
import { actions, useStore } from '../../../store'
import { Page, Row, Section } from '../kit'
import { patchSettings } from '../useSettings'
import './personal.css'

type Appearance = AppSettings['appearance']
const TOOL_CALLS: { value: ToolCalls; label: string }[] = [{ value: 'auto', label: 'Folded when the turn ends' }, { value: 'closed', label: 'Always folded' }, { value: 'open', label: 'Always show' }]
const THEMES: { value: Appearance['theme']; label: string }[] = [{ value: 'system', label: 'System' }, { value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }]
/** Reduce motion is on or off in the saved settings. Off still follows the Mac's own Reduce motion, which the styles read from the system. */
const MOTION: { value: string; label: string }[] = [{ value: 'system', label: 'Follow macOS' }, { value: 'reduce', label: 'Always reduce' }]

/** One drawing of the app in a theme. It carries its own `data-theme`, so it keeps that theme whatever the window shows. */
function Sketch({ theme }: { theme: 'dark' | 'light' }) {
  return (
    <span className="pe-sketch" data-theme={theme}>
      <span className="pe-side"><i /><i /><i /></span>
      <span className="pe-panel"><i /><i /><i /></span>
    </span>
  )
}

/** Settings > Appearance (SettingsPage.png, page appearance): three theme cards, text and layout, accessibility (KERNEL-680). Changes apply at once through appearance.ts. */
export function Appearance({ s }: { s: AppSettings }) {
  const a = s.appearance
  const toolCalls = useStore((st) => st.ui.workspace.toolCalls ?? 'auto')
  const set = (patch: Partial<Appearance>) => void patchSettings({ appearance: patch })
  const pick = (i: number, step: number) => {
    const next = THEMES[(i + step + THEMES.length) % THEMES.length]
    set({ theme: next.value })
    document.getElementById(`pe-theme-${next.value}`)?.focus()
  }
  return (
    <Page title="Appearance" desc="How Kernel looks.">
      <Section id="theme" title="Theme" plain>
        <div role="radiogroup" aria-label="Theme" className="pe-themes">
          {THEMES.map((t, i) => (
            <button key={t.value} id={`pe-theme-${t.value}`} type="button" role="radio" aria-checked={a.theme === t.value} tabIndex={a.theme === t.value ? 0 : -1} className="pe-theme" onClick={() => set({ theme: t.value })}
              onKeyDown={(e) => { const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0; if (step) { e.preventDefault(); pick(i, step) } }}>
              <span className="pe-art" aria-hidden="true">
                {t.value === 'system' ? <><span className="pe-half"><Sketch theme="dark" /></span><span className="pe-half right"><Sketch theme="light" /></span></> : <Sketch theme={t.value} />}
              </span>
              <span className="pe-name"><span className="pe-dot" aria-hidden="true" />{t.label}</span>
            </button>
          ))}
        </div>
      </Section>
      <Section title="Text and layout">
        <Row id="font-size" label="Font size"><SegmentedControl label="Font size" value={a.fontSize} onChange={(v) => set({ fontSize: v as Appearance['fontSize'] })} options={[{ value: 'small', label: 'Small' }, { value: 'default', label: 'Default' }, { value: 'large', label: 'Large' }]} /></Row>
        <Row id="density" label="Density"><SegmentedControl label="Density" value={a.density} onChange={(v) => set({ density: v as Appearance['density'] })} options={[{ value: 'comfortable', label: 'Comfortable' }, { value: 'compact', label: 'Compact' }]} /></Row>
      </Section>
      <Section title="Chat">
        <Row id="tool-calls" label="Tool calls" desc="How a turn's steps show in a chat."><Select label="Tool calls" align="right" value={toolCalls} onChange={(v) => actions.ui.setToolCalls(v as ToolCalls)} options={TOOL_CALLS} /></Row>
      </Section>
      <Section title="Accessibility">
        <Row id="reduce-motion" label="Reduce motion"><Select label="Reduce motion" align="right" value={a.reduceMotion ? 'reduce' : 'system'} onChange={(v) => set({ reduceMotion: v === 'reduce' })} options={MOTION} /></Row>
        <Row id="pointer-cursors" label="Use pointer cursors" desc="Show a hand over buttons and links."><Toggle label="Use pointer cursors" checked={a.pointerCursors} onChange={(v) => set({ pointerCursors: v })} /></Row>
      </Section>
    </Page>
  )
}
