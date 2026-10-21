import { useEffect, useRef, useState } from 'react'
import { call, cleanError } from '../../api'
import { actions, useStore } from '../../store'
import { Button, CopyButton, EmptyList, LoadingRow, Modal, useBusy } from '../../ui'
import './projects.css'

/**
 * A project's setup log (KERNEL-1117): each step of its setup with the time, what the tool behind it printed, and why it failed or
 * was skipped, oldest first. Details on New chat opens it. It opens on the end, where the latest try is. The log is plain text,
 * so a copy is what the person sends along with a bug report.
 */
export function SetupLog({ projectId }: { projectId: string }) {
  const name = useStore((s) => s.projects.find((p) => p.id === projectId)?.name)
  const [log, setLog] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  const [busy, run] = useBusy<'retry'>()
  const text = useRef<HTMLPreElement>(null)

  const load = () => call('projects.setupLog', { projectId }).then(
    (t) => { setLog(t); setFailed(false) },
    (e: unknown) => { setFailed(true); actions.ui.toast({ title: 'Could not read the setup log', sub: cleanError(e), glyph: 'error' }) }
  )
  useEffect(() => { void load() }, [projectId])
  useEffect(() => { if (text.current) text.current.scrollTop = text.current.scrollHeight }, [log])
  const retry = () => run('retry', async () => { setFailed(false); await load() })

  return (
    <Modal
      title={name ? `Setup log for ${name}` : 'Setup log'} onClose={actions.ui.closeModal} width={640} top={112}
      footer={
        <>
          <span className="grow" />
          {!!log?.trim() && <CopyButton text={log} label="Copy the log" />}
          <Button variant="primary" size="lg" onClick={actions.ui.closeModal}>Done</Button>
        </>
      }
    >
      <div className="sl-body" aria-busy={log === null && !failed}>
        {log === null && !failed && <LoadingRow what="the setup log" />}
        {failed && <EmptyList icon="warning" title="Could not read the setup log" action={<Button size="md" busy={busy === 'retry'} busyLabel="Trying again" busyPattern="ripple" onClick={() => void retry()}>Try again</Button>}>Kernel could not read it.</EmptyList>}
        {log !== null && !log.trim() && <EmptyList icon="doc" title="Nothing was logged yet">Kernel writes each setup step here as it runs. This project was set up before Kernel kept a log.</EmptyList>}
        {!!log?.trim() && <pre ref={text} className="code sl-log" tabIndex={0} aria-label="Setup log">{log}</pre>}
      </div>
    </Modal>
  )
}
