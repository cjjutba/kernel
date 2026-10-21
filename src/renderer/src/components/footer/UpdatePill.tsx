import { actions, useStore } from '../../store'
import { Icon } from '../../icons'
import { Spinner } from '../../ui'
import { downloadPercent, updateDownloading, updateFailed, updateReason } from './updateModel'

const openWhatsNew = () => actions.ui.openModal({ name: 'whatsNew' })

/** The ink pill that says an update is ready (Pen 17.1). It opens What's new, where Restart to update lives. */
function UpdatePill({ where }: { where: 'footer' | 'titlebar' }) {
  return (
    <button type="button" className="update-pill" data-where={where} onClick={openWhatsNew}>
      <Icon name="download" size={13} />
      Update
    </button>
  )
}

/**
 * The sidebar footer's update slot (Pen 17.1, 17.3): the Update pill once an update has downloaded, a quiet line with the arrow-down loader and the
 * percentage while it downloads, and, after a check or download failed, the same round button the footer has between updates. A failure says why in a
 * toast (UpdateCard), so the footer stays calm (KERNEL-864, KERNEL-1118).
 */
export function UpdateSlot() {
  const update = useStore((s) => s.system.update)
  const online = useStore((s) => s.system.online)
  if (update?.status === 'ready') return <UpdatePill where="footer" />
  if (update && updateDownloading(update)) {
    return (
      <span className="sbf-upd" role="status" aria-label={`Downloading ${downloadPercent(update)}%`} data-tip={`Downloading Kernel ${update.version ?? ""}`.trim()}>
        <Spinner label={null} pattern="arrow-down" />
        <span className="sbf-upd-label">Downloading<span className="sbf-upd-version">{update.version ? ` ${update.version}` : ''}</span></span>
        <span className="sbf-pc">{downloadPercent(update)}%</span>
      </span>
    )
  }
  if (!updateFailed(update)) return null
  return (
    <button type="button" className="sbf-update" aria-label="Update" data-tip={updateReason(update?.error, online)} onClick={openWhatsNew}>
      <Icon name="download" size={14} />
    </button>
  )
}

/** With the sidebar hidden its footer goes too, so the Update pill moves to the title bar's right end (Pen 17.3). Rendered once by App while the sidebar is hidden. */
export function TitleBarUpdate() {
  const ready = useStore((s) => s.system.update?.status === 'ready')
  const inWorkspace = useStore((s) => s.ui.route.name === 'workspace')
  if (!ready) return null
  return <div className="titlebar-update" data-in-workspace={inWorkspace || undefined}><UpdatePill where="titlebar" /></div>
}
