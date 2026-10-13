import { useEffect, useRef } from 'react'
import { Terminal as Xterm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import type { ScriptKind } from '@shared/types'
import { scriptKey } from '@shared/scriptLog'
import { call } from '../../api'
import { getState, useStore } from '../../store'
import { appended } from './terminal/buffer'
import { css, xtermLinks, xtermTheme } from './terminal/Terminal'

const HIDE_CURSOR = '\x1b[?25l'

export function ScriptView({ workspaceId, kind, name, label, fallback }: { workspaceId: string; kind: ScriptKind; name?: string; label: string; fallback: string }) {
  const key = scriptKey(kind, name)
  const host = useRef<HTMLDivElement>(null)
  const theme = useStore((s) => s.ui.theme)
  const data = useStore((s) => s.scriptData[workspaceId]?.[key] ?? fallback)
  const replays = useStore((s) => s.scriptReplays[workspaceId] ?? 0)
  const live = useRef<{ term: Xterm; seen: string; replays: number } | undefined>(undefined)
  const latest = useRef(data)
  latest.current = data
  useEffect(() => {
    const el = host.current
    if (!el) return
    const term = new Xterm({
      fontFamily: css('--mono') || 'monospace',
      fontSize: 12,
      lineHeight: 1.45,
      scrollback: 10_000,
      disableStdin: true,
      cursorInactiveStyle: 'none',
      allowProposedApi: true,
      linkHandler: xtermLinks.linkHandler,
      theme: xtermTheme()
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.loadAddon(xtermLinks.addon())
    term.open(el)
    let sent = ''
    const resize = () => {
      try { fit.fit() } catch { return }
      const size = `${term.cols}x${term.rows}`
      if (size === sent) return
      sent = size
      void call('scripts.resize', { workspaceId, kind, ...(name && { name }), cols: term.cols, rows: term.rows }).catch(() => undefined)
    }
    resize()
    term.write(HIDE_CURSOR + latest.current)
    live.current = { term, seen: latest.current, replays: getState().scriptReplays[workspaceId] ?? 0 }
    term.attachCustomKeyEventHandler((e) => {
      if (e.type === 'keydown' && e.metaKey && !e.shiftKey && e.key === 'c' && term.hasSelection()) {
        void navigator.clipboard.writeText(term.getSelection())
        return false
      }
      return !(e.metaKey || e.ctrlKey || e.altKey)
    })
    const ro = new ResizeObserver(() => requestAnimationFrame(resize))
    ro.observe(el)
    return () => { live.current = undefined; ro.disconnect(); term.dispose() }
  }, [workspaceId, kind, name])
  useEffect(() => {
    const l = live.current
    if (l) l.term.options.theme = xtermTheme()
  }, [theme])
  useEffect(() => {
    const l = live.current
    if (!l) return
    if (l.replays !== replays) {
      l.term.reset()
      l.term.write(HIDE_CURSOR + data)
      l.seen = data
      l.replays = replays
      return
    }
    if (l.seen === data) return
    l.term.write(appended(l.seen, data))
    l.seen = data
  }, [data, replays])
  return (
    <div className="term term-script selectable" role="log" aria-label={label} data-theme-key={theme}>
      <div ref={host} className="term-host" />
    </div>
  )
}
