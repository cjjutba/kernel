import type { UpNext as UpNextData } from '@/lib/schema'
import { ChangeList } from './ChangeList'
import { EntryShell, VersionPill } from './ReleaseEntry'

export function UpNext({ data }: { data: UpNextData }) {
  return (
    <EntryShell
      titleId="next"
      meta={
        <>
          <div className="flex items-center gap-2">
            <VersionPill next>Up next</VersionPill>
          </div>
          <p className="mt-2 block text-label text-muted">Planned</p>
        </>
      }
    >
      <h2 id="next" className="text-entry-title">
        {data.title}
      </h2>
      <p className="mt-6 text-intro text-ink-3">{data.intro}</p>
      <ChangeList items={data.items} />
    </EntryShell>
  )
}
