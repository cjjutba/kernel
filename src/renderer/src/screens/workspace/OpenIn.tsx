import { useEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent } from 'react'
import type { OpenApp, Workspace } from '@shared/types'
import { call, cleanError } from '../../api'
import { actions, getState } from '../../store'
import { Icon, Menu, MENU_SEPARATOR, SplitButton, type IconName, type MenuEntry } from '../../ui'
import './openIn.css'

interface OpenApps { apps: OpenApp[]; defaultId?: string }

/**
 * What `app.openApps` last said, kept across workspaces so the header never starts empty. It loads when a workspace opens and again
 * each time the menu opens. A pick changes the default at once, and a load that was asked for before the pick is dropped, so the old
 * default never flashes back (KERNEL-428).
 */
let cache: OpenApps | undefined
let epoch = 0
const listeners = new Set<() => void>()
const subscribe = (l: () => void) => { listeners.add(l); return () => void listeners.delete(l) }
const publish = (next: OpenApps) => { cache = next; listeners.forEach((l) => l()) }
const load = () => {
  const asked = epoch
  return call('app.openApps', undefined).then((r) => { if (asked === epoch) publish(r) }, () => undefined)
}

/** The glyph for an app that has no icon of its own (fixture mode, or an icon that could not be read). */
const KIND_ICON: Record<OpenApp['kind'], IconName> = { finder: 'folder', editor: 'code', terminal: 'term' }

/** Opens `path` in `app`, which becomes the default, or in the default app when there is none to name. A failure toasts and puts the real default back. */
async function openIn(path: string, app: OpenApp | undefined) {
  if (app && cache && app.id !== cache.defaultId) { epoch++; publish({ ...cache, defaultId: app.id }) }
  try {
    await call('app.openIn', { path, app: app?.id })
    // Main saves the pick once the app has opened, so a list asked for while it opened may still carry the old default.
    if (app) epoch++
  } catch (e) {
    const title = `Could not open in ${app?.name ?? 'the app'}`
    const why = cleanError(e)
    actions.ui.toast({ title, sub: why === title ? undefined : why })
    if (app) { epoch++; void load() }
  }
}

async function copyPath(path: string) {
  try {
    await navigator.clipboard.writeText(path)
    actions.ui.toast({ title: 'Path copied', sub: path })
  } catch { actions.ui.toast({ title: 'Could not copy', sub: 'The clipboard is not available.' }) }
}

/**
 * The workspace header's Open in control: a split button whose left half opens the workspace in the app used last
 * and whose right half lists every editor and terminal on this Mac, numbered 1 to 9, then Copy path. ⌘O does what the left half does.
 */
export function OpenIn({ ws }: { ws: Workspace }) {
  const data = useSyncExternalStore(subscribe, () => cache)
  const apps = data?.apps ?? []
  const current = apps.find((a) => a.id === data?.defaultId)
  const [open, setOpen] = useState(false)
  const anchor = useRef<HTMLSpanElement>(null)

  useEffect(() => { void load() }, [])

  // ⌘O anywhere on the screen, except in a terminal, which has its own keys, and over a modal.
  const latest = useRef({ path: ws.path, current })
  latest.current = { path: ws.path, current }
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (!e.metaKey || e.altKey || e.ctrlKey || e.shiftKey || e.repeat || e.key.toLowerCase() !== 'o') return
      if (document.activeElement?.closest('.term') || getState().ui.modal) return
      e.preventDefault()
      void openIn(latest.current.path, latest.current.current)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  /** The menu goes away with its items, so a keyboard user would land on the page. Focus goes back to the button that opened it. */
  const close = () => {
    if (anchor.current?.contains(document.activeElement)) anchor.current.querySelector('button')?.focus()
    setOpen(false)
  }
  const toggle = () => {
    if (!open) void load()
    setOpen(!open)
  }
  // 1 to 9 pick that row while the menu is open. The shared Menu knows nothing of numbers, so this listens on the wrapper.
  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (!open || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || !/^[1-9]$/.test(e.key)) return
    const app = apps[Number(e.key) - 1]
    if (!app) return
    e.preventDefault()
    close()
    void openIn(ws.path, app)
  }

  const items: (MenuEntry | typeof MENU_SEPARATOR)[] = [
    ...apps.map((app, i): MenuEntry => ({
      id: app.id,
      label: app.name,
      ...(app.icon ? { leading: <img className="open-in-icon" src={app.icon} alt="" /> } : { icon: KIND_ICON[app.kind] }),
      shortcut: [app.id === current?.id && '⌘O', i < 9 && String(i + 1)].filter(Boolean).join(' ') || undefined,
      onSelect: () => void openIn(ws.path, app)
    })),
    ...(apps.length ? [MENU_SEPARATOR] : []),
    { id: 'copy-path', label: 'Copy path', icon: 'copy', onSelect: () => void copyPath(ws.path) }
  ]

  return (
    <SplitButton
      className="open-in"
      role="group"
      aria-label="Open in"
      onKeyDown={onKeyDown}
      mainProps={{ 'aria-label': `Open in ${current?.name ?? 'editor'}`, 'data-tip-kbd': '⌘O' }}
      onClick={() => void openIn(ws.path, current)}
      caretLabel="Choose app to open in"
      expanded={open}
      onCaret={toggle}
      anchorRef={anchor}
      menu={open && <Menu label="Open in" anchorRef={anchor} onClose={close} style={{ right: 0, top: 'calc(100% + 6px)', width: 244 }} items={items} />}
    >
      {current?.icon ? <img className="open-in-icon" src={current.icon} alt="" /> : <Icon name="code" size={16} />}
    </SplitButton>
  )
}
