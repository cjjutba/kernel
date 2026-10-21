import type { ReactElement, ReactNode } from 'react'
import type { SettingsPage } from '@shared/types'
import { actions } from '../store'
import { EmptyState, Spinner } from './display'
import { Button } from './controls'
import { useBusy } from './hooks'
import type { IconName } from '../icons'

/** The arrow-down loader and what is loading. Centered in its area, or `inline` under skeleton rows that hold the layout (Pen 11.16). */
export function LoadingRow({ what, inline }: { what: string; inline?: boolean }) {
  return <div className={inline ? 'state-loading state-inline' : 'state-center state-loading'} role="status"><Spinner label={null} pattern="arrow-down" />Loading {what}</div>
}

export function EmptyList({ icon, title, children, action }: { icon: IconName | ReactElement; title: string; children?: ReactNode; action?: ReactNode }) {
  return <div className="state-center"><EmptyState icon={icon} title={title} action={action}>{children}</EmptyState></div>
}

/**
 * A list, panel or page that failed to load: a calm empty state with the reason and Try again. The call that failed raises its own toast, which carries the error (DESIGN.md, State kinds).
 * `action` replaces Try again when the fix is somewhere else, such as Open Settings, Git.
 */
export function FailedState({ icon = 'warning', title, children, onRetry, action }: { icon?: IconName | ReactElement; title: string; children?: ReactNode; onRetry?: () => Promise<unknown> | void; action?: ReactNode }) {
  const [busy, run] = useBusy<'retry'>()
  const retry = onRetry && <Button busy={busy === 'retry'} busyLabel="Trying again" busyPattern="ripple" onClick={() => void run('retry', async () => onRetry())}>Try again</Button>
  return <div className="state-center"><EmptyState icon={icon} title={title} action={action ?? retry}>{children}</EmptyState></div>
}

export function NotConnectedState({ icon, title, children, page, label }: { icon: IconName; title: string; children?: ReactNode; page: SettingsPage; label: string }) {
  return (
    <div className="state-center">
      <EmptyState icon={icon} title={title} action={<Button onClick={() => actions.ui.go({ name: 'settings', page })}>{label}</Button>}>{children}</EmptyState>
    </div>
  )
}
