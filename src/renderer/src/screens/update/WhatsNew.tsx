import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import type { AppUpdate } from '@shared/types'
import { call, cleanError } from '../../api'
import { downloadPercent, updateDownloading, updateFailed, updateReason } from '../../components/footer/updateModel'
import { Icon } from '../../icons'
import { actions, getState, useStore } from '../../store'
import { Banner, Button, EmptyList, LoadingRow, Modal, Spinner, useBusy } from '../../ui'
import { FOLD_AT, FLAT_MAX, whatsNewView, type NotesSection } from './whatsNewView'
import './update.css'

/**
 * What's new (WhatsNew.png). With an update downloaded it offers Later and Restart to update. Once after an update
 * installs it opens by itself, titled "What's new in Kernel <version>", with one Done button. Opened any other time,
 * it shows the running version's notes the same way (KERNEL-154), with the updater's progress or failure above them.
 * The title and the buttons stay put and only the notes scroll.
 */
export function WhatsNew({ update: opened }: { update?: AppUpdate }) {
  // What the modal opened with: the install it was given at boot, or the live state from the pill, the sidebar,
  // the account menu or the palette. A check that starts while it's open replaces the live state and its notes.
  const [update, hold] = useState(() => opened ?? getState().system.update)
  // Opened before Kernel answered `update.get` (a fixture opens it at boot), it holds the first state that arrives.
  const live = useStore((s) => s.system.update)
  const online = useStore((s) => s.system.online)
  if (!update && live) hold(live)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState<string | null>(null)
  const [retrying, run] = useBusy<'retry'>()
  const titleId = useId()
  const close = () => actions.ui.closeModal()
  const view = whatsNewView(update)

  const restart = () => {
    setBusy(true)
    setFailed(null)
    // Cancel in Kernel's "agents are working" dialog keeps it running, so the button is usable again.
    void call('update.install', undefined).then((r) => { if (r.canceled) setBusy(false) }, (e: unknown) => {
      setBusy(false)
      setFailed(cleanError(e))
    })
  }
  const retryCheck = () => void run('retry', () => call('update.check', undefined).then(actions.system.setUpdate).catch(() => undefined))

  // The header's hairline shows once the notes scroll, and the fade above the footer until they end.
  const scroller = useRef<HTMLDivElement>(null)
  const [edges, setEdges] = useState({ scrolled: false, atEnd: true })
  const measure = useCallback(() => {
    const el = scroller.current
    if (!el) return
    const next = { scrolled: el.scrollTop > 0, atEnd: el.scrollTop + el.clientHeight >= el.scrollHeight - 2 }
    // A section heading that sticks gets a hairline, so the lines scrolling under it read as going under, not cut off.
    const top = el.getBoundingClientRect().top
    for (const sec of el.querySelectorAll<HTMLElement>('.wn-sec')) {
      const stuck = sec.getBoundingClientRect().top < top - 1
      sec.querySelector('.wn-sec-head')?.toggleAttribute('data-stuck', stuck)
    }
    setEdges((e) => (e.scrolled === next.scrolled && e.atEnd === next.atEnd ? e : next))
  }, [])
  useLayoutEffect(measure)
  useEffect(() => {
    const el = scroller.current
    if (!el) return
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [measure])

  // Opened before the state arrived, the footer swaps Done for Later and Restart to update. Focus follows to the ink
  // button unless the person already moved it.
  useEffect(() => {
    const modal = scroller.current?.closest('.modal')
    if (modal && (!modal.contains(document.activeElement) || document.activeElement === modal)) modal.querySelector<HTMLElement>('[data-autofocus]')?.focus({ preventScroll: true })
  }, [view.ready])

  const footer = view.ready
    ? <>
        <span className="wn-note">{busy ? 'Agents pause, Kernel restarts, agents resume.' : failed ? '' : 'Running agents pause for a few seconds.'}</span>
        <Button key="later" variant="ghost" size="lg" disabled={busy} onClick={close}>Later</Button>
        <Button key="restart" variant="primary" size="lg" data-autofocus busy={busy} busyPattern="ripple" busyLabel="Restarting" onClick={restart}>{failed ? 'Try again' : 'Restart to update'}</Button>
      </>
    : <><span className="grow" /><Button key="done" variant="primary" size="lg" data-autofocus onClick={close}>Done</Button></>

  const reason = updateReason(live?.error, online)
  return (
    <Modal title={view.title} onClose={close} width={640} top={100} footer={footer} bare labelledBy={titleId}>
      <div className="wn-head" data-scrolled={edges.scrolled || undefined}>
        <div className="wn-heading">
          <h2 id={titleId}>{view.title}</h2>
          {view.to && (
            <p className="wn-meta">
              {view.from && <>{view.from}<Icon name="right" size={12} /><span className="sr-only">to</span></>}
              <span className="wn-to">{view.to}</span>
              {view.note && <><span aria-hidden="true">·</span>{view.note}</>}
            </p>
          )}
        </div>
        <button type="button" data-close data-dismiss className="icon-btn" aria-label="Close"><Icon name="close" /></button>
      </div>

      <div className="wn-body" data-state={view.loading ? 'loading' : view.sections.length === 0 ? 'empty' : undefined}>
        <div ref={scroller} className="wn-scroll" tabIndex={0} aria-label="Release notes" onScroll={measure}>
          {view.current && live && updateDownloading(live) && (
            <div className="wn-status" role="status">
              <Spinner label={null} pattern="arrow-down" />
              <span className="grow">Downloading update <span className="wn-pc">{downloadPercent(live)}%</span></span>
              {live.version && <span>Kernel {live.version}</span>}
            </div>
          )}
          {view.current && updateFailed(live) && (
            <div className="wn-check">
              <Banner
                kind="offline"
                title="Could not check for updates"
                actions={<Button size="md" busy={retrying === 'retry'} busyLabel="Trying again" busyPattern="ripple" onClick={retryCheck}>Try again</Button>}
              >
                {reason === 'Could not check for updates' ? undefined : reason}
              </Banner>
            </div>
          )}
          {view.loading
            ? <LoadingRow what="release notes" />
            : view.sections.length === 0
              ? <EmptyList icon="doc" title="No release notes">This version came without notes.</EmptyList>
              : view.sections.map((s) => <Section key={s.title} section={s} onToggle={measure} />)}
        </div>
        {!edges.atEnd && <div className="wn-fade" aria-hidden="true" />}
      </div>

      {failed && (
        <div className="wn-fail">
          <Banner kind="warn" title="Could not restart to update">{failed}</Banner>
        </div>
      )}
    </Modal>
  )
}

function Section({ section, onToggle }: { section: NotesSection; onToggle: () => void }) {
  const id = useId()
  return (
    <section className="wn-sec" aria-labelledby={id}>
      <div className="wn-sec-head">
        <h3 id={id}>{section.title}</h3>
        <span className="wn-count">{section.count}</span>
      </div>
      {section.highlights.length > 0 && (
        <ul className="wn-hl">
          {section.highlights.map((h, i) => (
            <li key={i}>
              <span className="wn-hl-title">{h.title}</span>
              {h.text && <span className="wn-hl-text">{h.text}</span>}
            </li>
          ))}
        </ul>
      )}
      {section.lines.length > 0 && <Lines lines={section.lines} fold={section.title !== 'New'} onToggle={onToggle} />}
      {section.groups.length > 0 && (
        <div className="wn-groups">
          {section.groups.map((g) => <Group key={g.area} area={g.area} lines={g.lines} onToggle={onToggle} />)}
        </div>
      )}
    </section>
  )
}

/** One area's row: closed until opened, then its changes under a guide line. */
function Group({ area, lines, onToggle }: { area: string; lines: string[]; onToggle: () => void }) {
  const [open, setOpen] = useState(false)
  const id = useId()
  useLayoutEffect(onToggle, [open, onToggle])
  return (
    <div className="wn-group">
      <h4>
        <button type="button" className="wn-row" aria-expanded={open} aria-controls={id} onClick={() => setOpen((o) => !o)}>
          <Icon name="right" size={12} />
          <span className="wn-row-label">{area}</span>
          <span className="wn-count">{lines.length}</span>
        </button>
      </h4>
      {open && <ul id={id} className="wn-lines">{lines.map((l, i) => <li key={i}>{l}</li>)}</ul>}
    </div>
  )
}

/** Changes without an area. A long list, from a release before areas, shows FOLD_AT and a Show more button. */
function Lines({ lines, fold, onToggle }: { lines: string[]; fold: boolean; onToggle: () => void }) {
  const [open, setOpen] = useState(false)
  const folds = fold && lines.length > FLAT_MAX
  useLayoutEffect(onToggle, [open, onToggle])
  const shown = folds && !open ? lines.slice(0, FOLD_AT) : lines
  return (
    <>
      <ul className="wn-lines">{shown.map((l, i) => <li key={i}>{l}</li>)}</ul>
      {folds && (
        <button type="button" className="wn-more" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          {open ? 'Show less' : `Show ${lines.length - FOLD_AT} more`}
          <Icon name="right" size={12} />
        </button>
      )}
    </>
  )
}
