import { describe, expect, it } from 'vitest'
import type { AppUpdate } from '../src/shared/types'
import { notesSections, whatsNewView } from '../src/renderer/src/screens/update/whatsNewView'

const running = [{ title: 'Fixed', body: 'Fixed the footer.' }]
const next = [{ title: 'Checkpoints', body: 'Every turn saves the worktree.' }]
const idle: AppUpdate = { status: 'idle', current: '0.1.1', currentNotes: running }
const head = (u: AppUpdate | undefined) => {
  const { ready, downloading, failed, loading, current, title, from, to, note } = whatsNewView(u)
  return { ready, downloading, failed, loading, current, title, from, to, note }
}
const flags = { ready: false, downloading: false, failed: false, loading: false, current: false }

describe('whatsNewView (KERNEL-154, KERNEL-1104)', () => {
  it('offers to restart only when an update has downloaded, from the running version to the new one', () => {
    expect(head({ ...idle, status: 'ready', version: '0.2.0', notes: next })).toEqual({ ...flags, ready: true, title: 'Kernel 0.2 is ready', from: '0.1.1', to: '0.2.0', note: undefined })
  })

  it('shows the new notes with the percentage while an update downloads, and Restart to update waits', () => {
    const v = whatsNewView({ ...idle, status: 'downloading', version: '0.2.0', notes: next })
    expect([v.ready, v.downloading, v.title, v.from, v.to]).toEqual([true, true, 'Kernel 0.2 is available', '0.1.1', '0.2.0'])
    expect(v.sections[0]!.highlights).toHaveLength(1)
  })

  it("shows the running version's notes with Done when no update is ready", () => {
    for (const status of ['idle', 'checking', 'error'] as const) {
      const v = whatsNewView({ ...idle, status })
      expect([v.ready, v.current, v.title, v.from, v.to, v.note]).toEqual([false, true, "What's new in 0.1.1", undefined, undefined, "You're on 0.1.1."])
      expect(v.sections.map((s) => s.title)).toEqual(['Fixed'])
    }
  })

  it('says a failed check calmly when there are no notes to show', () => {
    expect(head({ status: 'error', current: '0.1.1', error: 'net::ERR_TIMED_OUT' })).toMatchObject({ failed: true, current: true, title: "What's new", to: undefined })
    expect(whatsNewView({ ...idle, status: 'error', error: 'net::ERR_TIMED_OUT' }).failed).toBe(false)
  })

  it("shows the installed version's notes once after an update", () => {
    const v = whatsNewView({ status: 'idle', current: '0.2.0', installed: true, version: '0.2.0', notes: next })
    expect([v.title, v.note, v.sections[0]!.highlights]).toEqual(["You're on Kernel 0.2", 'Installed just now. Your agents picked up where they were.', [{ title: 'Checkpoints', text: 'Every turn saves the worktree.' }]])
  })

  it("keeps a patch release's number in the title", () => {
    expect(whatsNewView({ status: 'idle', current: '0.2.1', currentNotes: running }).title).toBe("What's new in 0.2.1")
    expect(whatsNewView({ ...idle, status: 'ready', version: '0.2.1', notes: next }).title).toBe('Kernel 0.2.1 is ready')
  })

  it('is loading before the state arrives, and has no sections when there are no notes', () => {
    expect(head(undefined)).toEqual({ ...flags, loading: true, current: true, title: "What's new", from: undefined, to: undefined, note: undefined })
    expect(whatsNewView({ status: 'idle', current: '0.1.1' })).toMatchObject({ loading: false, sections: [] })
  })
})

describe('notesSections', () => {
  const lines = (n: number, word: string) => Array.from({ length: n }, (_, i) => `${word} ${i + 1}.`).join('\n')

  it('reads titled notes as new features and "<section>: <area>" notes as area rows', () => {
    const [n, imp] = notesSections([
      { title: 'Pull requests page', body: 'Every open pull request in one list.' },
      { title: 'Improved', body: 'Rooms are projects.' },
      { title: 'Improved: Chat', body: lines(4, 'Chat') },
      { title: 'Improved: Keyboard', body: lines(4, 'Key') }
    ])
    expect(n).toEqual({ title: 'New', count: 1, highlights: [{ title: 'Pull requests page', text: 'Every open pull request in one list.' }], lines: [], fold: false, groups: [] })
    expect(imp!.count).toBe(9)
    expect(imp!.lines).toEqual(['Rooms are projects.'])
    expect(imp!.groups.map((g) => [g.area, g.lines.length])).toEqual([['Chat', 4], ['Keyboard', 4]])
  })

  it('keeps areas as rows however short the section, and folds a list with no area only beside other sections', () => {
    const [fixed] = notesSections([{ title: 'Fixed: Chat', body: 'Fixed a chat drifting.' }, { title: 'Fixed', body: 'Fixed the footer.' }])
    expect(fixed).toEqual({ title: 'Fixed', count: 2, highlights: [], lines: ['Fixed the footer.'], fold: false, groups: [{ area: 'Chat', lines: ['Fixed a chat drifting.'] }] })
    // A patch's one short list opens flat. The same list beside another section folds into "Show N changes".
    expect(notesSections([{ title: 'Fixed', body: 'Fixed a.\nFixed b.' }]).map((s) => s.fold)).toEqual([false])
    expect(notesSections([{ title: 'Improved', body: 'A.\nB.' }, { title: 'Fixed', body: 'Fixed a.' }]).map((s) => s.fold)).toEqual([true, true])
  })

  it('orders sections New, Improved, Fixed whatever order the notes came in', () => {
    expect(notesSections([{ title: 'Fixed', body: 'Fixed a.' }, { title: 'Improved', body: 'B.' }, { title: 'Checkpoints', body: 'C.' }]).map((s) => s.title)).toEqual(['New', 'Improved', 'Fixed'])
  })
})
