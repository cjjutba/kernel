import { Button, useBusy } from '../../../ui'
import { Row } from '../kit'

/**
 * A list on a Settings page that could not be read: the row stays calm with what failed and Try again, and the failure's toast carries the error
 * (DESIGN.md, Errors and what failed). Try again spins and can't be pressed twice.
 */
export function CalmRow({ title, sub, onRetry }: { title: string; sub: string; onRetry: () => Promise<unknown> | void }) {
  const [busy, run] = useBusy<'retry'>()
  return (
    <Row label={title} desc={sub}>
      <Button busy={busy === 'retry'} busyLabel="Trying again" onClick={() => void run('retry', async () => onRetry())}>Try again</Button>
    </Row>
  )
}
