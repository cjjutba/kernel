import type { ReactNode } from 'react'
import type { SettingsPage } from '@shared/types'
import { actions } from '../store'
import { Banner, EmptyState, Spinner } from './display'
import { Button } from './controls'
import { useBusy } from './hooks'
import type { IconName } from '../icons'

export function LoadingRow({ what }: { what: string }) {
  return <div className="state-center state-loading" role="status"><Spinner label={null} pattern="arrow-down" />Loading {what}</div>
}

export function EmptyList({ icon, title, children, action }: { icon: IconName; title: string; children?: ReactNode; action?: ReactNode }) {
  return <div className="state-center"><EmptyState icon={icon} title={title} action={action}>{children}</EmptyState></div>
}

export function FailedState({ title, children, onRetry }: { title: string; children?: ReactNode; onRetry: () => Promise<unknown> | void }) {
  const [busy, run] = useBusy<'retry'>()
  return (
    <div className="state-center">
      <div className="state-fail">
        <Banner kind="offline" title={title} actions={<Button size="md" busy={busy === 'retry'} busyLabel="Trying again" busyPattern="rotate" onClick={() => void run('retry', async () => onRetry())}>Try again</Button>}>{children}</Banner>
      </div>
    </div>
  )
}

export function NotConnectedState({ icon, title, children, page, label }: { icon: IconName; title: string; children?: ReactNode; page: SettingsPage; label: string }) {
  return (
    <div className="state-center">
      <EmptyState icon={icon} title={title} action={<Button onClick={() => actions.ui.go({ name: 'settings', page })}>{label}</Button>}>{children}</EmptyState>
    </div>
  )
}
