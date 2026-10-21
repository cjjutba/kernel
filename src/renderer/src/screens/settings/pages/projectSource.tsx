import type { ComponentProps, ReactNode } from 'react'
import type { ProjectSettings } from '@shared/types'
import { Button } from '../../../ui'
import { Row, SettingsLink, type SettingsTarget } from '../kit'

/** Where a project's value is set: the app's own, the repo's settings.toml, the personal file, or the personal file over settings.toml. */
export type Where = 'app' | 'shared' | 'mine' | 'both'

export function whereOf(rs: ProjectSettings | null, path: string): Where {
  const source = rs?.sources?.[path]
  return source === 'local' ? 'mine' : source === 'override' ? 'both' : source === 'shared' ? 'shared' : 'app'
}

/** A value the personal file sets is the one Reset can drop. settings.toml can't be reset from here. */
export const isMine = (where: Where) => where === 'mine' || where === 'both'

/** The small word after a label that says which file holds the value. The app's own value has none: its row says so in its line. */
export function SourcePill({ children }: { children: ReactNode }) {
  return <span className="rm-pill">{children}</span>
}

const PILL: Record<Where, string | undefined> = { app: undefined, shared: 'settings.toml', mine: 'Your file', both: 'Your file' }

/** "Same as the app." with the app's page one click away, for a row that follows it. `tail` finishes it ("Follows the app, which leaves it off."). */
export function FollowsApp({ to, lead = 'Same as', name = 'the app', tail }: { to: SettingsTarget; lead?: string; name?: string; tail?: string }) {
  return <>{lead} <SettingsLink variant="quiet" to={to}>{name}</SettingsLink>{tail ? `, which ${tail}` : ''}.</>
}

type RowProps = ComponentProps<typeof Row>

/**
 * A project row that says where its value comes from. The pill after the label names the file, and the line under it says what that means:
 * `app` is what the row says while it follows the app, `value` is the word for the value in the personal file ("Off"), when the row has one.
 * A value in the personal file can be reset, and the button shows with the pointer or focus on the row.
 */
export function SourcedRow({ rs, path, app, value, extra, onReset, label, desc, ...rest }: Omit<RowProps, 'inherited' | 'changed' | 'changedIn' | 'onReset' | 'hover'> & {
  rs: ProjectSettings | null; path: string; app?: ReactNode; value?: string; extra?: ReactNode; onReset?: () => void
}) {
  const where = whereOf(rs, path)
  const pill = PILL[where]
  const source = desc ?? (where === 'app' ? app : where === 'shared' ? 'Shared with the team in settings.toml.' : where === 'mine' ? 'Only on this Mac, in your personal file.' : `${value ? `${value} in your file. ` : 'Your file wins. '}settings.toml sets it for everyone else.`)
  const line = extra ? <>{source} {extra}</> : source
  return (
    <Row
      {...rest}
      label={<>{label}{pill && <SourcePill>{pill}</SourcePill>}</>}
      desc={line}
      hover={isMine(where) && onReset ? <Button variant="ghost" aria-label={`Reset ${typeof label === 'string' ? label : 'setting'}`} onClick={onReset}>Reset</Button> : undefined}
    />
  )
}
