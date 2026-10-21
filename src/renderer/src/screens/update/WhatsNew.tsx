import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import type { AppUpdate } from '@shared/types'
import { checkAgain, restartToUpdate } from '../../components/footer/updateActions'
import { downloadPercent } from '../../components/footer/updateModel'
import { Icon } from '../../icons'
import { actions, getState, useStore } from '../../store'
import { Button, FailedState, LoadingRow, Modal } from '../../ui'
import { whatsNewView, type NotesSection } from './whatsNewView'
import './update.css'

/**
 * What's new (Pen 17.2, 17.4). With an update downloaded it offers Later and Restart to update. While one downloads it shows the new notes with the
 * percentage in the footer. Once after an update installs it opens by itself with one Done button. Opened any other time, it shows the running
 * version's notes the same way (KERNEL-154). A failed restart or check leaves the dialog as it was and says why in a toast, with Try again.
 * The title and the buttons stay put and only the notes scroll.
 */
export function WhatsNew({ update: opened }: { update?: AppUpdate }) {
  // What the modal opened with: the install it was given at boot, or the live state from the pill, the sidebar,
  // the account menu or the palette. A check that starts while it's open replaces the live state and its notes.
  const [held, hold] = useState(() => opened ?? getState().system.update)
  // Opened before Kernel answered `update.get` (a fixture opens it at boot), it holds the first state that arrives.
  const live = useStore((s) => s.system.update)
  const online = useStore((s) => s.system.online)
  if (!held && live) hold(live)
  // The page the updater is on moves while it is open: a download finishing turns the percentage into Restart to update.
  const update = opened?.installed ? held : (live ?? held)
  const [busy, setBusy] = useState(false)
  const [retrying, setRetrying] = useState(false)
  const titleId = useId()
  const close = () => actions.ui.closeModal()
  const view = whatsNewView(update)

  // Kernel quits on success, so the button stays busy until it does. With agents working Kernel asks first, and Cancel keeps it running, and a failure raises its toast.
  const restart = () => {
    setBusy(true)
    void restartToUpdate().then((r) => { if (r !== 'quit') setBusy(false) })
  }
  const retryCheck = useCallback(async () => {
    setRetrying(true)
    await checkAgain(online)
    setRetrying(false)
  }, [online])

  // The header keeps its hairline, and the fade above the footer shows until the notes end.
  const scroller = useRef<HTMLDivElement>(null)
  const [atEnd, setAtEnd] = useState(true)
  const measure = useCallback(() => {
    const el = scroller.current
    if (!el) return
    const next = el.scrollTop + el.clientHeight >= el.scrollHeight - 2
    setAtEnd((e) => (e === next ? e : next))
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

  const pc = update && view.downloading ? downloadPercent(update) : 0
  const footer = view.ready
    ? <>
        {view.downloading
          ? (
            <span className="wn-progress" role="status">
              <span className="wn-meter" role="progressbar" aria-label="Download" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pc}><span style={{ width: `${pc}%` }} /></span>
              Downloading <span className="wn-pc">{pc}%</span>
            </span>
          )
          : <span className="wn-note">Running agents pause for a few seconds.</span>}
        <span className="grow" />
        {!busy && <Button key="later" variant="ghost" size="lg" onClick={close}>Later</Button>}
        <Button key="restart" variant="primary" size="lg" data-autofocus={view.downloading ? undefined : true} disabled={view.downloading} busy={busy} busyPattern="ripple" busyLabel="Restarting" onClick={restart}>Restart to update</Button>
      </>
    : <><span className="grow" />{view.failed ? <Button key="close" variant="ghost" size="lg" data-autofocus onClick={close}>Close</Button> : <Button key="done" variant="primary" size="lg" data-autofocus onClick={close}>Done</Button>}</>

  return (
    <Modal title={view.title} onClose={close} width={640} top={100} footer={footer} bare labelledBy={titleId}>
      <div className="wn-head">
        <div className="wn-heading">
          <h2 id={titleId}>{view.title}</h2>
          {view.to && (
            <p className="wn-meta">
              {view.from && <>{view.from}<Icon name="right" size={12} /><span className="sr-only">to</span></>}
              <span className="wn-to">{view.to}</span>
            </p>
          )}
          {view.note && <p className="wn-meta">{view.note}</p>}
        </div>
        <button type="button" data-close data-dismiss className="icon-btn" aria-label="Close"><Icon name="close" /></button>
      </div>

      <div className="wn-body" data-state={view.loading || view.failed || view.sections.length === 0 ? 'calm' : undefined}>
        <div ref={scroller} className="wn-scroll" tabIndex={0} aria-label="Release notes" onScroll={measure}>
          {view.loading
            ? <LoadingRow what="release notes" />
            : view.failed
              ? <FailedState icon="wifioff" title="Release notes didn't load" onRetry={retryCheck}>Kernel couldn't reach GitHub releases.</FailedState>
              : view.sections.length === 0
                ? <p className="wn-empty">This release has no notes.</p>
                : view.sections.map((s) => <Section key={s.title} section={s} onToggle={measure} />)}
        </div>
        {!atEnd && <div className="wn-fade" aria-hidden="true" />}
      </div>
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
      {section.lines.length > 0 && (section.fold ? <Fold lines={section.lines} onToggle={onToggle} /> : <ul className="wn-lines">{section.lines.map((l, i) => <li key={i}>{l}</li>)}</ul>)}
      {section.groups.length > 0 && (
        <div className="wn-groups">
          {section.groups.map((g) => <Row key={g.area} label={g.area} lines={g.lines} onToggle={onToggle} />)}
        </div>
      )}
    </section>
  )
}

/** Changes without an area, from a release before areas, folded into one row: Show 3 changes, then Hide 3 changes. */
function Fold({ lines, onToggle }: { lines: string[]; onToggle: () => void }) {
  return <div className="wn-groups"><Row label={(open) => `${open ? 'Hide' : 'Show'} ${lines.length} ${lines.length === 1 ? 'change' : 'changes'}`} lines={lines} onToggle={onToggle} plain /></div>
}

/** One area's row: closed until opened, then its changes under it. */
function Row({ label, lines, onToggle, plain }: { label: string | ((open: boolean) => string); lines: string[]; onToggle: () => void; plain?: boolean }) {
  const [open, setOpen] = useState(false)
  const id = useId()
  useLayoutEffect(onToggle, [open, onToggle])
  const text = typeof label === 'string' ? label : label(open)
  return (
    <div className="wn-group">
      <h4>
        <button type="button" className="wn-row" aria-expanded={open} aria-controls={id} onClick={() => setOpen((o) => !o)}>
          <Icon name="right" size={13} />
          <span className="wn-row-label">{text}</span>
          {!plain && <span className="wn-count">{lines.length}</span>}
        </button>
      </h4>
      {open && <ul id={id} className="wn-items">{lines.map((l, i) => <li key={i}>{l}</li>)}</ul>}
    </div>
  )
}
