import './settings.css'
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyEvent } from 'react'
import type { ProjectSettingsSection, SettingsPage } from '@shared/types'
import { actions, getState, go, useStore } from '../../store'
import { ProjectIcon } from '../../components/ProjectIcon'
import { Icon, useScreenEscape } from '../../ui'
import { HistoryButtons } from '../../components/PanelToggles'
import { spotKey, useKeptScroll } from '../../ui/keptScroll'
import { NAV, PROJECT_PAGES, keywordHits, navMatch, type Keyword } from './nav'

/** The groups the sidebar lists. They live in nav.ts so search and the command palette read the same list (KERNEL-680). */
export const GROUPS = NAV

/**
 * What the sidebar frame holds in Settings (KERNEL-509): back to the app, search, the app pages, and each project with its own pages under it.
 * Search filters the list by name. The top stays put; the list under it scrolls, and the open page scrolls into view there. The frame
 * (components/sidebar/Sidebar.tsx) owns the `<nav>` named Settings, the width and the resize edge, so these are its direct flex children.
 */
export function SettingsNav({ page, projectId, section }: { page: SettingsPage; projectId?: string; section?: ProjectSettingsSection }) {
  const [q, setQ] = useState('')
  const [folded, setFolded] = useState<string | null>(null)
  const list = useRef<HTMLDivElement>(null)
  const keep = useKeptScroll(list, { key: spotKey.settings('app', 'nav'), ready: true })
  const projects = useStore((s) => s.projects.filter((r) => !r.hidden && !r.archived))
  const match = (label: string, keywords?: Keyword[], terms?: string[]) => navMatch(q, label, keywords, terms)
  // Escape: the search box clears first. Other text fields keep it for themselves, and elsewhere it leaves Settings.
  // Menus and modals take Escape before it gets here, and a toast waits for it to be left alone.
  useScreenEscape((e, inField) => {
    const { modal, menu } = getState().ui
    if (modal || menu) return false
    const el = e.target instanceof HTMLElement ? e.target : null
    if (el?.id === 'set-q' && q) { setQ(''); return true }
    if (inField && el?.id !== 'set-q') return false
    actions.ui.leaveSettings()
    return true
  })
  // A project's pages run past the bottom of the window, so a project page brings the end of its project and the next project's row into view, then the open page.
  useEffect(() => {
    if (page !== 'project') return
    keep.stop()
    const end = list.current?.querySelector('[data-project-end]')
    ;(end?.parentElement?.nextElementSibling?.firstElementChild ?? end)?.scrollIntoView({ block: 'nearest' })
    list.current?.querySelector('[aria-current="page"]')?.scrollIntoView({ block: 'nearest' })
  }, [page, projectId, section])
  useEffect(() => setFolded(null), [page, projectId])
  const groups = GROUPS.map((g) => ({ ...g, items: g.items.filter((i) => match(i.label, i.keywords, i.terms)) })).filter((g) => g.items.length)
  // Only the project whose page is open is expanded. On an app page every project is folded.
  const open = page === 'project' ? projects.find((r) => r.id === projectId)?.id : undefined
  const searching = !!q.trim()
  // A search that matches a project's name shows all its pages, and one that matches a page name shows that page.
  const shownProjects = projects.map((r) => ({ project: r, pages: match(r.name) ? PROJECT_PAGES : PROJECT_PAGES.filter((p) => match(p.label, p.keywords, p.terms)) })).filter((r) => r.pages.length)
  // A result opens its page and names the row, which Settings scrolls to, highlights and focuses (KERNEL-727).
  const found = (keywords: Keyword[], to: (row: string) => Parameters<typeof go>[0]) => keywordHits(q, keywords).map((k) => (
    <button key={k.rowId} type="button" className="nav-item set-item set-sub set-hit-item" onClick={() => go(to(k.rowId))}>{k.label}</button>
  ))
  // Arrow keys walk the results from the search box: Down enters the list, Up from the first result returns to the box.
  const walk = (e: ReactKeyEvent<HTMLElement>) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    const input = document.getElementById('set-q')
    const items = [...(list.current?.querySelectorAll<HTMLElement>('button.set-item') ?? [])]
    const from = e.target === input ? -1 : items.indexOf(e.target as HTMLElement)
    if (e.target !== input && from < 0) return
    const to = e.key === 'ArrowDown' ? items[from + 1] : from === 0 ? input : items[from - 1]
    if (!to) return
    e.preventDefault()
    to.focus()
  }
  const here = (id: string, s: ProjectSettingsSection) => page === 'project' && projectId === id && (section ?? 'general') === s
  return (
    <>
      {/* The same strip as the app sidebar's, so Back and Forward stay where they were. Settings has no sidebar toggle. */}
      <div className="drag sb-titlebar">
        <span className="grow" />
        <HistoryButtons />
      </div>
      <button type="button" className="set-back" onClick={() => actions.ui.leaveSettings()}><Icon name="left" size={14} />Back to app</button>
      <div className="set-search">
        <label htmlFor="set-q" className="sr-only" style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap' }}>Search settings</label>
        <Icon name="search" size={14} />
        <input id="set-q" type="text" autoComplete="off" placeholder="Search settings" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => {
          if (e.key === 'Enter' && searching) { e.preventDefault(); list.current?.querySelector<HTMLElement>('button.set-item')?.click() } else walk(e)
        }} />
      </div>
      <div ref={list} className="set-list sb-scroll" onKeyDown={walk}>
        {groups.map((g) => (
          <div key={g.title}>
            <p className="set-group">{g.title}</p>
            {g.items.map((i) => (
              <div key={i.page} data-keep-id={i.page}>
                <button type="button" className="nav-item set-item" aria-current={page === i.page ? 'page' : undefined} onClick={() => go({ name: 'settings', page: i.page })}>
                  <Icon name={i.icon} size={16} />{i.label}
                </button>
                {found(i.keywords, (row) => ({ name: 'settings', page: i.page, row }))}
              </div>
            ))}
          </div>
        ))}
        {shownProjects.length > 0 && (
          <div>
            <p className="set-group">Projects</p>
            {shownProjects.map(({ project: r, pages }) => {
              const expanded = searching ? true : open === r.id && folded !== r.id
              return (
                <div key={r.id} data-keep-id={r.id}>
                  <button type="button" className="nav-item set-item set-project" aria-expanded={expanded} onClick={() => {
                    // Another project opens on its General page. Its own row folds and unfolds its pages.
                    if (open === r.id) setFolded(expanded ? r.id : null)
                    else { setFolded(null); go({ name: 'settings', page: 'project', projectId: r.id }) }
                  }}>
                    <ProjectIcon project={r} className="set-letter" /><span className="grow">{r.name}</span>
                  </button>
                  {expanded && (
                    <div className="set-pages" data-project-end={open === r.id ? '' : undefined}>
                      {pages.map((p) => (
                        <div key={p.section}>
                          <button type="button" className="nav-item set-item set-sub" aria-current={here(r.id, p.section) ? 'page' : undefined} onClick={() => go({ name: 'settings', page: 'project', projectId: r.id, section: p.section })}>
                            <Icon name={p.icon} size={16} />{p.label}
                          </button>
                          {found(p.keywords, (row) => ({ name: 'settings', page: 'project', projectId: r.id, section: p.section, row }))}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
        {!groups.length && !shownProjects.length && <p className="set-group">No settings match</p>}
      </div>
    </>
  )
}
