import type { PreflightCheck } from '@shared/types'
import { actions } from '../../store'

/** Backticks mark code in a check's text, and a toast has no code styling. */
const plain = (text: string) => text.replaceAll('`', '')

/**
 * Setup problems after onboarding (KERNEL-1088): a launch that finds a required check failing says so in a toast on New chat, with the
 * command that fixes it and a Check again button. Only checks that stop agents count. Setup never blocks the app.
 */
export function setupToasts(checks: PreflightCheck[]) {
  for (const c of checks.filter((x) => !x.ok && x.blocking).slice(0, 2)) {
    const port = /listen on (\d+)/.exec(c.detail)?.[1]
    actions.ui.toast({
      title: c.title,
      sub: plain(c.detail),
      glyph: 'error',
      ...(c.fix?.command ? { other: { label: 'Copy command', copy: c.fix.command } } : {}),
      action: c.fix?.action === 'use-next-port' ? { label: port ? `Use ${port}` : 'Use the next port', fix: c.id, primary: true } : { label: 'Check again', recheck: true, primary: true }
    })
  }
}
