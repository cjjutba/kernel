import { describe, expect, it } from 'vitest'
import type { AppUpdate } from '../src/shared/types'
import { notesSections, whatsNewView } from '../src/renderer/src/screens/update/whatsNewView'

const running = [{ title: 'Fixed', body: 'Fixed the footer.' }]
const next = [{ title: 'Checkpoints', body: 'Every turn saves the worktree.' }]
const idle: AppUpdate = { status: 'idle', current: '0.1.1', currentNotes: running }
const head = (u: AppUpdate | undefined) => {
  const { ready, loading, current, title, from, to, note } = whatsNewView(u)
  return { ready, loading, current, title, from, to, note }
}

describe('whatsNewView (KERNEL-154)', () => {
  it('offers to restart only when an update has downloaded, from the running version to the new one', () => {
    expect(head({ ...idle, status: 'ready', version: '0.2.0', notes: next })).toEqual({ ready: true, loading: false, current: false, title: 'Kernel 0.2 is ready', from: '0.1.1', to: '0.2.0', note: undefined })
  })

  it('shows the running version\'s notes with Done when no update is ready', () => {
    for (const status of ['idle', 'checking', 'downloading', 'error'] as const) {
      const v = whatsNewView({ ...idle, status, version: status === 'downloading' ? '0.2.0' : undefined, notes: status === 'downloading' ? next : undefined })
      expect([v.ready, v.current, v.title, v.to, v.note]).toEqual([false, true, "What's new in Kernel 0.1.1", '0.1.1', 'Your version'])
      expect(v.sections.map((s) => s.title)).toEqual(['Fixed'])
    }
  })

  it('shows the installed version\'s notes once after an update', () => {
    const v = whatsNewView({ status: 'idle', current: '0.2.0', installed: true, version: '0.2.0', notes: next })
    expect([v.title, v.to, v.note, v.sections[0]!.highlights]).toEqual(["What's new in Kernel 0.2", '0.2.0', 'Just installed', [{ title: 'Checkpoints', text: 'Every turn saves the worktree.' }]])
  })

  it('keeps a patch release\'s number in the title', () => {
    expect(whatsNewView({ status: 'idle', current: '0.2.1', currentNotes: running }).title).toBe("What's new in Kernel 0.2.1")
    expect(whatsNewView({ ...idle, status: 'ready', version: '0.2.1', notes: next }).title).toBe('Kernel 0.2.1 is ready')
  })

  it('is loading before the state arrives, and has no sections when there are no notes', () => {
    expect(head(undefined)).toEqual({ ready: false, loading: true, current: true, title: "What's new in Kernel", from: undefined, to: undefined, note: undefined })
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
    expect(n).toEqual({ title: 'New', count: 1, highlights: [{ title: 'Pull requests page', text: 'Every open pull request in one list.' }], lines: [], groups: [] })
    expect(imp!.count).toBe(9)
    expect(imp!.lines).toEqual(['Rooms are projects.'])
    expect(imp!.groups.map((g) => [g.area, g.lines.length])).toEqual([['Chat', 4], ['Keyboard', 4]])
  })

  it('lists a short section flat, each fix keeping its "Fixed"', () => {
    expect(notesSections([{ title: 'Fixed: Chat', body: 'Fixed a chat drifting.' }, { title: 'Fixed', body: 'Fixed the footer.' }])).toEqual([
      { title: 'Fixed', count: 2, highlights: [], lines: ['Fixed the footer.', 'Fixed a chat drifting.'], groups: [] }
    ])
  })

  it('orders sections New, Improved, Fixed whatever order the notes came in', () => {
    expect(notesSections([{ title: 'Fixed', body: 'Fixed a.' }, { title: 'Improved', body: 'B.' }, { title: 'Checkpoints', body: 'C.' }]).map((s) => s.title)).toEqual(['New', 'Improved', 'Fixed'])
  })
})
