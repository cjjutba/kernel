import { call } from '../../api'
import { actions, useStore } from '../../store'
import { Icon } from '../../icons'
import { LinkButton, Spinner, useBusy } from '../../ui'
import { downloadPercent, updateDownloading, updateFailed, updateReason } from './updateModel'

/** The sidebar footer's update slot: a round download button once an update has downloaded (Pen 14.1), a quiet progress line while it downloads, and a quiet line with Try again when a check or download failed (KERNEL-864). */
export function UpdateSlot() {
  const update = useStore((s) => s.system.update)
  const online = useStore((s) => s.system.online)
  const [busy, run] = useBusy<'retry'>()
  if (update?.status === 'ready') {
    return (
      <button type="button" className="sbf-update" aria-label="Update ready" onClick={() => actions.ui.openModal({ name: 'whatsNew' })}>
        <Icon name="download" />
      </button>
    )
  }
  if (update && updateDownloading(update)) {
    return <span className="sbf-upd" role="status"><Spinner label={null} pattern="arrow-down" />Downloading <span className="sbf-pc">{downloadPercent(update)}%</span></span>
  }
  if (!updateFailed(update)) return null
  const retry = () => void run('retry', () => call('update.check', undefined).then(actions.system.setUpdate).catch(() => undefined))
  return (
    <span className="sbf-upd" role="status" data-tip={updateReason(update?.error, online)}>
      Update failed
      <LinkButton variant="inline" size="meta" busy={busy !== null} busyLabel="Trying again" onClick={retry}>Try again</LinkButton>
    </span>
  )
}
