import type { ReactNode } from 'react'
import { FailedState, LoadingRow } from '../../ui/states'

/** The page title with a loading or failed body, for a Settings page whose data has not arrived (KERNEL-866). */
export function SettingsPending({ title, crumb, failed, what, onRetry }: { title: string; crumb?: ReactNode; failed: boolean; what: string; onRetry: () => Promise<unknown> | void }) {
  return (
    <div className="set-scroll set-pending">
      <div className="set-page">
        <div className="set-head"><h1>{crumb}<span>{title}</span></h1></div>
        {failed
          ? <FailedState title={`Could not load ${what}`} onRetry={onRetry}>Check that Kernel is running, then try again.</FailedState>
          : <LoadingRow what={what} />}
      </div>
    </div>
  )
}
