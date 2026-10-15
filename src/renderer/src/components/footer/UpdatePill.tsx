import { call } from '../../api'
import { actions, useStore } from '../../store'
import { Icon } from '../../icons'
import { Spinner, useBusy } from '../../ui'
import { downloadPercent, updateDownloading, updateFailed, updateReason } from './updateModel'

/** The footer's update slot: the pill once an update has downloaded, a quiet progress line while it downloads, and a quiet line with Try again when a check or download failed (KERNEL-864). */
export function UpdatePill() {
  const update = useStore((s) => s.system.update)
  const online = useStore((s) => s.system.online)
  const [busy, run] = useBusy<'retry'>()
  if (update?.status === 'ready') {
    return (
      <button type="button" className="ft-pill" onClick={() => actions.ui.openModal({ name: 'whatsNew' })}>
        <Icon name="download" size={12} />Update ready
      </button>
    )
  }
  if (update && updateDownloading(update)) {
    return <span className="ft-upd" role="status"><Spinner label={null} pattern="arrow-down" />Downloading update <span className="ft-pc">{downloadPercent(update)}%</span></span>
  }
  if (!updateFailed(update)) return null
  const retry = () => void run('retry', () => call('update.check', undefined).then(actions.system.setUpdate).catch(() => undefined))
  return (
    <span className="ft-upd" role="status">
      {updateReason(update?.error, online)}
      <button type="button" className="ft-pill ft-retry" disabled={busy !== null} aria-busy={busy !== null || undefined} onClick={retry}>
        {busy ? <><Spinner label={null} pattern="rotate" />Trying again</> : 'Try again'}
      </button>
    </span>
  )
}
