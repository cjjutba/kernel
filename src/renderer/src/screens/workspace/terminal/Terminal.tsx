import { useEffect, useRef } from 'react'
import { Terminal as Xterm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { call } from '../../../api'
import { appended } from './buffer'
import { getState, useStore } from '../../../store'

const css = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim()

/**
 * A real terminal: xterm.js here, node-pty in the main process. `id` is a terminal chat id, or `shell:<workspaceId>` for the plain shell.
 * Output arrives through the store (it keeps the buffer while the tab is hidden), so a tab you come back to still shows everything.
 */
export function TerminalView({ id, label, compact }: { id: string; label: string; compact?: boolean }) {
  const host = useRef<HTMLDivElement>(null)
  const theme = useStore((s) => s.ui.theme)
  const buffer = useStore((s) => s.terminal[id] ?? '')
  const live = useRef<{ term: Xterm; seen: string } | undefined>(undefined)
  useEffect(() => {
    const el = host.current
    if (!el) return
    const term = new Xterm({
      fontFamily: css('--mono') || 'monospace',
      fontSize: compact ? 12 : 13,
      lineHeight: 1.45,
      scrollback: 10_000,
      cursorBlink: true,
      allowProposedApi: true,
      theme: { background: css('--code-bg'), foreground: css('--ink-2'), cursor: css('--ink'), selectionBackground: css('--line-4') }
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(el)
    // The first resize is also what starts the process, so it goes out only once the size is known.
    let sent = ''
    const resize = () => {
      try { fit.fit() } catch { return }
      const key = `${term.cols}x${term.rows}`
      if (key === sent) return
      sent = key
      void call('terminal.resize', { chatId: id, cols: term.cols, rows: term.rows }).catch(() => undefined)
    }
    const seen = getState().terminal[id] ?? ''
    if (seen) term.write(seen)
    live.current = { term, seen }
    term.onData((data) => void call('terminal.write', { chatId: id, data }).catch(() => undefined))
    // Copy needs the selection; paste arrives as the browser paste event on xterm's textarea.
    term.attachCustomKeyEventHandler((e) => {
      if (e.type === 'keydown' && e.metaKey && !e.shiftKey && e.key === 'c' && term.hasSelection()) {
        void navigator.clipboard.writeText(term.getSelection())
        return false
      }
      // The app's own tab shortcuts are not for the shell.
      if (e.metaKey && ['t', 'w'].includes(e.key.toLowerCase())) return false
      return true
    })
    const ro = new ResizeObserver(() => requestAnimationFrame(resize))
    ro.observe(el)
    resize()
    if (!compact) term.focus()
    return () => { live.current = undefined; ro.disconnect(); term.dispose() }
  }, [id, compact])
  // The terminal colours follow the theme, which changes after the terminal was made.
  useEffect(() => {
    const l = live.current
    if (l) l.term.options.theme = { background: css('--code-bg'), foreground: css('--ink-2'), cursor: css('--ink'), selectionBackground: css('--line-4') }
  }, [theme])
  // New output goes to the open terminal. The store keeps the buffer, so a remount replays it above.
  useEffect(() => {
    const l = live.current
    if (!l || l.seen === buffer) return
    l.term.write(appended(l.seen, buffer))
    l.seen = buffer
  }, [buffer])
  return (
    <div className={compact ? 'term term-compact' : 'term'} role="group" aria-label={label} data-theme-key={theme}>
      <div ref={host} className="term-host" />
    </div>
  )
}
