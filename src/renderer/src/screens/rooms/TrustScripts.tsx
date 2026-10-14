import { useEffect, useRef, useState } from 'react'
import { call } from '../../api'
import { actions, useStore } from '../../store'
import { CodeBlock, ConfirmDialog, useBusy } from '../../ui'
import './rooms.css'

/**
 * Run this repo's scripts? (KERNEL-218, no PNG.) The room's scripts, files.copy list and the install scripts in package.json
 * exactly as Kernel will run them, held by KERNEL-209 and KERNEL-260 until the user trusts that text. Trust and run releases the held workspaces. Not now leaves them held,
 * and the workspace banner keeps its Review action.
 */
export function TrustScripts({ roomId }: { roomId: string }) {
  const room = useStore((s) => s.rooms.find((r) => r.id === roomId))
  const trust = useStore((s) => s.scriptTrust[roomId])
  const [busy, run] = useBusy()
  const [error, setError] = useState<string | null>(null)
  const [checked, setChecked] = useState(!!trust)
  const list = useRef<HTMLDivElement>(null)
  const close = actions.ui.closeModal

  // The store has the text from the push or the last load. Ask once more in case neither reached this window.
  useEffect(() => {
    if (checked) return
    void call('rooms.scriptTrust', { roomId }).then((t) => { if (t) actions.rooms.setTrust(roomId, t) }).catch(() => undefined).finally(() => setChecked(true))
  }, [checked, roomId])
  // Nothing waits any more, such as when a Settings save trusted it: there is nothing left to ask.
  useEffect(() => { if (checked && !trust) close() }, [checked, trust, close])
  // A trust prompt starts on its safe answer, not on the first Copy button.
  useEffect(() => { list.current?.closest<HTMLElement>('[role="alertdialog"]')?.querySelector<HTMLElement>('.modal-foot button')?.focus({ preventScroll: true }) }, [!!trust])

  if (!room || !trust) return null

  const confirm = () => run('trust', async () => {
    setError(null)
    try {
      await call('rooms.trust', { roomId, hash: trust.hash })
      actions.rooms.setTrust(roomId, null)
      close()
    } catch (e) {
      // The text changed since it was read. Main pushes the new text; load it too so the list below is what a second yes would cover.
      setError((e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
      await call('rooms.scriptTrust', { roomId }).then((t) => actions.rooms.setTrust(roomId, t)).catch(() => undefined)
    }
  })

  const entries: { label: string; text: string }[] = [
    ...(trust.scripts.setup ? [{ label: 'Setup', text: trust.scripts.setup }] : []),
    ...(trust.scripts.run ? [{ label: 'Run', text: trust.scripts.run }] : []),
    ...(trust.runScripts ?? []).map((r) => ({ label: `Run: ${r.name}`, text: r.command })),
    ...(trust.scripts.archive ? [{ label: 'Archive', text: trust.scripts.archive }] : []),
    ...(trust.copy.length ? [{ label: 'Files to copy', text: trust.copy.join('\n') }] : []),
    ...(trust.envFiles?.length ? [{ label: 'Env files', text: trust.envFiles.join('\n') }] : [])
  ]
  // The repo's own package.json scripts that a package install runs (KERNEL-260). Shown apart, since they come from another file.
  const installs = trust.installScripts?.length ? [{ label: 'Install scripts in package.json', text: trust.installScripts.map((i) => `${i.name}: ${i.command}`).join('\n') }] : []
  // The room's one-time install, which runs the repo's own code (KERNEL-682).
  const install = trust.install ? [{ label: 'Install dependencies', text: trust.install }] : []
  const body = [
    entries.length ? `These come from .kernel/settings.toml in ${room.name}. Kernel runs them in your login shell for each new workspace.` : '',
    installs.length ? `The install scripts come from package.json in ${room.name}. A package install runs them.` : '',
    install.length ? `Kernel runs the install once in ${room.name}, and it runs code from the repo.` : ''
  ].filter(Boolean).join(' ')

  return (
    <ConfirmDialog
      title="Run this repo's scripts?" busy={!!busy} busyPattern="pulse" busyLabel="Trusting" confirmLabel="Trust and run" cancelLabel="Not now" onConfirm={() => void confirm()} onCancel={close}
      body={body}
    >
      <div ref={list} className="ts-list">
        {[...entries, ...installs, ...install].map((e) => (
          <section key={e.label} className="ts-item" aria-label={e.label}>
            <h3 className="ts-label">{e.label}</h3>
            <CodeBlock>{e.text}</CodeBlock>
          </section>
        ))}
      </div>
      {error && <p role="alert" className="ts-error">{error} The list above is the new text.</p>}
    </ConfirmDialog>
  )
}
