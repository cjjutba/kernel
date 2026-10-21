import { describe, expect, it } from 'vitest'
import type { Chat, Workspace } from '@shared/types'
import { bannerFor, limitBannerExpired, limitBannerKey, type BannerInput } from '../src/renderer/src/screens/workspace/banners/model'

const now = new Date(2026, 9, 7, 11, 0).getTime()
const S = (ms: number) => Math.round(ms / 1000)
const ws: Workspace = { id: 'ws', projectId: 'project', name: 'invoice-table', branch: 'feat/x', baseRef: 'main', path: '/tmp/ws', mode: 'worktree', agentId: 'christian', port: 4300, status: 'ready', prState: 'none', createdAt: 1 }
const chat: Chat = { id: 'chat', workspaceId: 'ws', title: 'Table', kind: 'chat', model: 'claude-sonnet-5-5', effort: 'high', plan: false, createdAt: 1 }
const input = (o: Partial<BannerInput> = {}): BannerInput => ({
  ws, chat, agentName: 'Christian', running: false, usage: [], account: { signedIn: true }, online: true,
  hooks: { port: 7420, listening: true, installed: true, events: [] }, now, ...o
})

describe('workspace banners', () => {
  it('shows nothing when all is well', () => {
    expect(bannerFor(input())).toBeNull()
  })

  it('words the 5-hour limit with its reset time, and keeps the composer open', () => {
    const b = bannerFor(input({ usage: [{ type: 'five_hour', status: 'rejected', resetsAt: S(new Date(2026, 9, 7, 15, 40).getTime()) }] }))
    expect(b).toMatchObject({ id: 'session', kind: 'limit', title: "You've hit your 5-hour limit", sub: 'Resets at 3:40 PM. Christian finished this turn and stopped.', blocks: false, limit: 'five_hour' })
    expect(b?.actions.map((a) => a.label)).toEqual(['Notify me'])
  })

  it('blocks the composer on the weekly limit and names the reset day', () => {
    const b = bannerFor(input({ usage: [{ type: 'seven_day', status: 'rejected', resetsAt: S(new Date(2026, 9, 12, 9, 0).getTime()) }, { type: 'five_hour', status: 'rejected', resetsAt: S(now + 3600_000) }] }))
    expect(b).toMatchObject({ id: 'weekly', sub: 'Resets Monday at 9:00 AM. Every project is paused.', blocks: true })
  })

  it('ignores a rejection whose reset time has passed', () => {
    expect(bannerFor(input({ usage: [{ type: 'five_hour', status: 'rejected', resetsAt: S(now - 1000) }] }))).toBeNull()
  })

  it('offers another model in one click when the chat\'s own model is limited', () => {
    // Claude Code calls `seven_day_overage_included` the Fable limit. It is not the weekly limit, so no project is paused.
    const b = bannerFor(input({ chat: { ...chat, model: 'claude-fable-5-1' }, usage: [{ type: 'seven_day_overage_included', status: 'rejected', model: 'claude-fable-5-1', resetsAt: S(now + 3 * 86_400_000 - 3600_000) }] }))
    expect(b).toMatchObject({ id: 'model', title: "Fable 5.1's own limit is used up", sub: 'Christian can carry on with Opus 5.5 until it resets Saturday at 10:00 AM.', switchTo: 'claude-opus-5-5', blocks: false })
    expect(b?.actions.map((a) => a.label)).toEqual(['Not now', 'Use Opus 5.5'])
    // A limit on another model is not this chat's banner.
    expect(bannerFor(input({ usage: [{ type: 'seven_day_opus', status: 'rejected', model: 'claude-opus-5-5' }] }))).toBeNull()
  })

  it('counts down an overloaded retry', () => {
    const b = bannerFor(input({ retry: { attempt: 2, of: 5, nextAt: now + 12_000 } }))
    expect(b).toMatchObject({ id: 'overloaded', kind: 'retry', sub: 'Retrying in 12s, attempt 2 of 5. Your message is safe.' })
  })

  it('offers to compact from 90% context', () => {
    expect(bannerFor(input({ chat: { ...chat, context: 89 } }))).toBeNull()
    expect(bannerFor(input({ chat: { ...chat, context: 92 } }))).toMatchObject({ id: 'context', actions: [{ id: 'compact', primary: true }] })
  })

  it('shows no banner for a long chat while the window has headroom, and the next one still shows (KERNEL-488)', () => {
    const used = (tokens: number, max = 1_000_000, context = Math.round((tokens / max) * 100)) => ({ ...chat, context, contextUsage: { used: tokens, max, rows: [] } })
    // 160k and 336k in a 1M window are far under 90%, and the context popover already shows how much is free.
    expect(bannerFor(input({ chat: used(160_000) }))).toBeNull()
    expect(bannerFor(input({ chat: used(336_000) }))).toBeNull()
    const hooks = { port: 7420, listening: false, installed: true, events: [] }
    expect(bannerFor(input({ chat: used(336_000), hooks }))).toMatchObject({ id: 'hooks', title: "Kernel can't hear from agents", as: 'toast' })
  })

  it('still says the context is almost full from 90%, on any window size', () => {
    const used = (tokens: number, max: number, context = Math.round((tokens / max) * 100)) => ({ ...chat, context, contextUsage: { used: tokens, max, rows: [] } })
    const full = bannerFor(input({ chat: used(184_000, 200_000) }))
    expect(full).toMatchObject({ id: 'context', title: "This chat's context is almost full", sub: 'Compact it to keep going. Christian keeps a summary of what happened.' })
    expect(full?.actions.map((a) => a.id)).toEqual(['compact'])
    expect(bannerFor(input({ chat: used(900_000, 1_000_000) }))?.id).toBe('context')
    expect(bannerFor(input({ chat: used(120_000, 200_000) }))).toBeNull()
    // A chat that never read its context has nothing to go on.
    expect(bannerFor(input({ chat: { ...chat, contextUsage: undefined } }))).toBeNull()
  })

  describe('close to a usage limit (KERNEL-224)', () => {
    const near = (type: 'five_hour' | 'seven_day', utilization: number | undefined, resetsAt: number, status: 'allowed' | 'allowed_warning' = 'allowed') => ({ type, status, ...(utilization === undefined ? {} : { utilization }), resetsAt: S(resetsAt) })
    const at340 = new Date(2026, 9, 7, 15, 40).getTime()
    const monday = new Date(2026, 9, 12, 9, 0).getTime()

    it('says new work waits at 90% of the 5-hour window, with when it resumes, and blocks nothing', () => {
      const b = bannerFor(input({ usage: [near('five_hour', 0.91, at340)] }))
      expect(b).toMatchObject({ id: 'nearLimit', kind: 'limit', title: '91% of the 5-hour window used', sub: 'Turns in progress finish. New work waits until 3:40 PM.', blocks: false, limit: 'five_hour' })
      expect(b?.actions).toEqual([{ id: 'notify', label: 'Notify me' }])
      expect(bannerFor(input({ usage: [near('five_hour', 0.9, at340)] }))?.id).toBe('nearLimit')
      expect(bannerFor(input({ usage: [near('five_hour', 0.89, at340)] }))).toBeNull()
    })

    it('says so for the weekly window at 95%, with the day it resumes', () => {
      expect(bannerFor(input({ usage: [near('seven_day', 0.96, monday)] }))).toMatchObject({ id: 'nearLimit', title: '96% of the weekly window used', sub: 'Turns in progress finish. New work waits until Monday at 9:00 AM.' })
    })

    it("shows nothing in the Lead's workspace, and nothing with the switch off, since nothing is held there", () => {
      expect(bannerFor(input({ isLead: true, usage: [near('five_hour', 0.99, at340)] }))).toBeNull()
      expect(bannerFor(input({ usageSettings: { pauseNearLimit: false }, usage: [near('five_hour', 0.99, at340)] }))).toBeNull()
      expect(bannerFor(input({ usageSettings: { pauseNearLimit: true }, usage: [near('five_hour', 0.99, at340)] }))?.id).toBe('nearLimit')
    })

    it('reads a warning with no number as close, a number as the number, and a window past its reset as nothing', () => {
      expect(bannerFor(input({ usage: [near('five_hour', undefined, at340, 'allowed_warning')] }))?.id).toBe('nearLimit')
      expect(bannerFor(input({ usage: [near('five_hour', 0.5, at340, 'allowed_warning')] }))).toBeNull()
      expect(bannerFor(input({ usage: [near('five_hour', 0.99, now - 1000)] }))).toBeNull()
    })

    it('warns that 80% of the week is used, in any workspace, and not below it', () => {
      const b = bannerFor(input({ usage: [near('seven_day', 0.8, monday)] }))
      expect(b).toMatchObject({ id: 'weeklyWarn', kind: 'limit', title: "80% of this week's limit used", sub: 'It resets Monday at 9:00 AM.', blocks: false })
      expect(bannerFor(input({ usage: [near('seven_day', 0.79, monday)] }))).toBeNull()
      expect(bannerFor(input({ usage: [near('seven_day', 0.9, monday)] }))?.title).toBe("90% of this week's limit used")
      // The Lead isn't held, but it can still read how much of the week is gone.
      expect(bannerFor(input({ isLead: true, usage: [near('seven_day', 0.85, monday)] }))?.id).toBe('weeklyWarn')
      expect(bannerFor(input({ usageSettings: { warnBeforeWeekly: false }, usage: [near('seven_day', 0.85, monday)] }))).toBeNull()
    })

    it('says tomorrow when the weekly window resets the next day', () => {
      const tomorrow = new Date(2026, 9, 8, 4, 0).getTime()
      expect(bannerFor(input({ usage: [near('seven_day', 0.85, tomorrow)] }))).toMatchObject({ id: 'weeklyWarn', sub: 'It resets tomorrow at 4:00 AM.' })
      expect(bannerFor(input({ usage: [near('seven_day', 0.96, tomorrow)] }))).toMatchObject({ id: 'nearLimit', sub: 'Turns in progress finish. New work waits until tomorrow at 4:00 AM.' })
    })

    it('shows the hold rather than the weekly warning once the week is close enough to hold teammates', () => {
      expect(bannerFor(input({ usage: [near('seven_day', 0.97, monday)] }))?.id).toBe('nearLimit')
      // The 5-hour window decides first when both are close.
      expect(bannerFor(input({ usage: [near('seven_day', 0.85, monday), near('five_hour', 0.92, at340)] }))?.id).toBe('nearLimit')
    })

    describe('closing the information-only banners (KERNEL-595)', () => {
      const weeklyWarn = near('seven_day', 0.85, monday)
      const hooks = { port: 7420, listening: false, installed: true, events: [] }
      const keyed = (u: ReturnType<typeof near>) => limitBannerKey(u.type === 'five_hour' ? 'nearLimit' : 'weeklyWarn', u.resetsAt)

      it('keys the 80% and near-limit banners by banner and window, and no other banner', () => {
        expect(bannerFor(input({ usage: [weeklyWarn] }))?.dismissKey).toBe(`weeklyWarn:${S(monday)}`)
        expect(bannerFor(input({ usage: [near('five_hour', 0.95, at340)] }))?.dismissKey).toBe(`nearLimit:${S(at340)}`)
        const others = [
          input({ usage: [{ type: 'seven_day', status: 'rejected', resetsAt: S(monday) }] }),
          input({ usage: [{ type: 'five_hour', status: 'rejected', resetsAt: S(at340) }] }),
          input({ usage: [{ type: 'seven_day_opus', status: 'rejected', model: 'claude-sonnet-5-5', resetsAt: S(monday) }] }),
          input({ account: { signedIn: false } }),
          input({ online: false }),
          input({ ws: { ...ws, status: 'failed' } }),
          input({ retry: { attempt: 1, of: 5, nextAt: now + 5000 } }),
          input({ chat: { ...chat, context: 95 } }),
          input({ hooks })
        ]
        for (const o of others) expect(bannerFor(o)?.dismissKey, bannerFor(o)?.id).toBeUndefined()
      })

      it('hides a closed banner and shows the next one in line in its place', () => {
        const dismissed = new Set([keyed(weeklyWarn)])
        expect(bannerFor(input({ usage: [weeklyWarn], dismissed }))).toBeNull()
        expect(bannerFor(input({ usage: [weeklyWarn], dismissed, hooks }))?.id).toBe('hooks')
        expect(bannerFor(input({ usage: [weeklyWarn], dismissed, retry: { attempt: 1, of: 5, nextAt: now + 5000 } }))?.id).toBe('overloaded')
        const five = near('five_hour', 0.95, at340)
        expect(bannerFor(input({ usage: [five], dismissed: new Set([keyed(five)]) }))).toBeNull()
        expect(bannerFor(input({ usage: [five], dismissed: new Set([keyed(five)]), hooks }))?.id).toBe('hooks')
      })

      it('closes one banner and not the other', () => {
        const five = near('five_hour', 0.95, at340)
        expect(bannerFor(input({ usage: [five, weeklyWarn], dismissed: new Set([keyed(five)]) }))?.id).toBe('weeklyWarn')
        expect(bannerFor(input({ usage: [five, weeklyWarn], dismissed: new Set([keyed(weeklyWarn)]) }))?.id).toBe('nearLimit')
        // At 96% the hold is the one banner for the week. Closing it does not bring the 80% line for the same week back.
        const week = near('seven_day', 0.96, monday)
        expect(bannerFor(input({ usage: [week] }))?.id).toBe('nearLimit')
        expect(bannerFor(input({ usage: [week], dismissed: new Set([limitBannerKey('nearLimit', week.resetsAt)]) }))).toBeNull()
      })

      it('shows a closed banner again when its window resets', () => {
        const dismissed = new Set([keyed(weeklyWarn)])
        const nextWeek = near('seven_day', 0.85, monday + 7 * 86_400_000)
        expect(bannerFor(input({ usage: [nextWeek], dismissed }))).toMatchObject({ id: 'weeklyWarn', dismissKey: `weeklyWarn:${nextWeek.resetsAt}` })
        const five = near('five_hour', 0.95, at340)
        expect(bannerFor(input({ usage: [near('five_hour', 0.95, at340 + 5 * 3600_000)], dismissed: new Set([keyed(five)]) }))?.id).toBe('nearLimit')
      })

      it('never hides a blocking banner or any other, whatever was closed', () => {
        const dismissed = new Set([limitBannerKey('weeklyWarn', S(monday)), limitBannerKey('nearLimit', S(at340)), `weekly:${S(monday)}`, `session:${S(at340)}`])
        expect(bannerFor(input({ dismissed, usage: [{ type: 'seven_day', status: 'rejected', resetsAt: S(monday) }] }))?.id).toBe('weekly')
        expect(bannerFor(input({ dismissed, usage: [{ type: 'five_hour', status: 'rejected', resetsAt: S(at340) }] }))?.id).toBe('session')
        expect(bannerFor(input({ dismissed, account: { signedIn: false } }))?.id).toBe('signedOut')
        expect(bannerFor(input({ dismissed, hooks }))?.id).toBe('hooks')
        expect(bannerFor(input({ dismissed, chat: { ...chat, context: 95 } }))?.id).toBe('context')
      })

      it('forgets the key of a window that has reset', () => {
        expect(limitBannerExpired(`weeklyWarn:${S(monday)}`, monday - 1000)).toBe(false)
        expect(limitBannerExpired(`weeklyWarn:${S(monday)}`, monday)).toBe(true)
        expect(limitBannerExpired('nearLimit:not-a-time', monday)).toBe(false)
      })
    })

    it('says See usage on the warning that has it, and no other action runs a terminal for it', () => {
      const usage = (b: ReturnType<typeof bannerFor>) => b?.actions.filter((a) => a.id === 'usage')
      expect(usage(bannerFor(input({ usage: [{ type: 'seven_day', status: 'rejected', resetsAt: S(monday) }] })))).toEqual([])
      expect(usage(bannerFor(input({ usage: [near('five_hour', 0.95, at340)] })))).toEqual([])
      expect(usage(bannerFor(input({ usage: [near('seven_day', 0.85, monday)] })))).toEqual([{ id: 'usage', label: 'See usage' }])
    })

    it('comes after sign-out and offline, and before overloaded, context and hooks', () => {
      const usage = [near('five_hour', 0.95, at340)]
      expect(bannerFor(input({ usage, account: { signedIn: false } }))?.id).toBe('signedOut')
      expect(bannerFor(input({ usage, online: false }))?.id).toBe('offline')
      // A limit that already rejected is the stronger line, whichever window it is.
      expect(bannerFor(input({ usage: [near('five_hour', 0.95, at340), { type: 'seven_day', status: 'rejected', resetsAt: S(monday) }] }))?.id).toBe('weekly')
      expect(bannerFor(input({ usage: [{ type: 'five_hour', status: 'rejected', resetsAt: S(at340) }] }))?.id).toBe('session')
      expect(bannerFor(input({ usage: [near('five_hour', 0.95, at340), { type: 'seven_day_opus', status: 'rejected', model: 'claude-sonnet-5-5', resetsAt: S(monday) }] }))?.id).toBe('model')
      expect(bannerFor(input({ usage, retry: { attempt: 1, of: 5, nextAt: now + 5000 }, chat: { ...chat, context: 95 }, hooks: { port: 7420, listening: false, installed: true, events: [] } }))?.id).toBe('nearLimit')
      expect(bannerFor(input({ retry: { attempt: 1, of: 5, nextAt: now + 5000 }, usage: [near('seven_day', 0.85, monday)] }))?.id).toBe('weeklyWarn')
    })
  })

  it('puts sign-out first, then offline', () => {
    const all = { account: { signedIn: false }, online: false, ws: { ...ws, status: 'failed' as const } }
    expect(bannerFor(input(all))).toMatchObject({ id: 'signedOut', blocks: true })
    expect(bannerFor(input({ ...all, account: { signedIn: true } }))).toMatchObject({ id: 'offline', blocks: false })
  })

  it('has no banner for a failed setup or a failed worktree: they are toasts (KERNEL-1093)', () => {
    expect(bannerFor(input({ ws: { ...ws, status: 'failed' } }))).toBeNull()
    expect(bannerFor(input({ ws: { ...ws, status: 'ready', setupRun: { startedAt: 1, endedAt: 2, end: 1 } } }))).toBeNull()
    expect(bannerFor(input({ ws: { ...ws, status: 'failed', worktreePending: { error: 'fatal: already exists' } } }))).toBeNull()
  })

  describe('errors are a toast, and the box says why a message can\'t go (Pen 14.7)', () => {
    it('says a folder that is gone in the placeholder, with no banner and no toast', () => {
      expect(bannerFor(input({ ws: { ...ws, folderGone: true } }))).toMatchObject({ id: 'folder', as: 'none', blocks: true, placeholder: "This chat's folder is gone. Archive the chat, or put the folder back." })
    })

    it('raises being offline once as a toast, and leaves the box open with a placeholder', () => {
      const b = bannerFor(input({ online: false }))
      expect(b).toMatchObject({ id: 'offline', as: 'toast', blocks: false, placeholder: "You're offline. Messages queue until you're back." })
      expect(b?.toast).toEqual({ key: 'offline', title: "You're offline", sub: 'Messages you send wait in the queue.', actions: [] })
    })

    it('says a signed-out Claude Code with the command that fixes it, and an added account with its sign-in', () => {
      expect(bannerFor(input({ account: { signedIn: false } }))).toMatchObject({
        as: 'toast', blocks: true, placeholder: 'Sign in to Claude Code to keep going',
        toast: { key: 'signedOut:claude:cli', title: 'Claude Code is signed out', sub: 'Run claude auth login in Terminal, then try again.', actions: [{ label: 'Copy command', copy: 'claude auth login' }, { label: 'Try again', recheckAccount: true, primary: true }] }
      })
      const added = [{ id: 'second', provider: 'claude' as const, label: '2nd account', cli: false, auth: 'subscription' as const, active: true, signedIn: false }]
      expect(bannerFor(input({ account: { signedIn: false }, accounts: added }))).toMatchObject({ placeholder: 'Sign in to 2nd account to keep going', toast: { key: 'signedOut:claude:second', title: '2nd account is signed out' } })
    })

    it('counts down an overloaded retry in the placeholder and offers Retry now on the toast, named for the provider', () => {
      const b = bannerFor(input({ retry: { attempt: 1, of: 5, nextAt: now + 30_000 } }))
      expect(b).toMatchObject({ as: 'toast', title: 'Anthropic is overloaded', placeholder: 'Kernel retries in 30 seconds', toast: { key: 'overloaded:chat', sub: "Kernel retries Christian's turn in 30 seconds.", actions: [{ label: 'Retry now', retryNow: 'chat' }] } })
      expect(bannerFor(input({ retry: { attempt: 1, of: 5, nextAt: now + 1_000 } }))?.placeholder).toBe('Kernel retries in 1 second')
    })

    it('raises the hooks going down as a toast that opens Check hooks', () => {
      expect(bannerFor(input({ hooks: { port: 7420, listening: false, installed: true, events: [] } }))?.toast).toMatchObject({ key: 'hooks', title: "Kernel can't hear from agents", actions: [{ label: 'Check hooks', modal: { name: 'checkHooks' } }] })
    })

    it('keeps a limit that needs a choice as a banner', () => {
      expect(bannerFor(input({ usage: [{ type: 'five_hour', status: 'rejected', resetsAt: S(now + 3600_000) }] }))?.as).toBeUndefined()
    })
  })

  it('shows the hook server going down last', () => {
    expect(bannerFor(input({ hooks: { port: 7420, listening: false, installed: true, events: [] } }))).toMatchObject({ id: 'hooks', actions: [{ id: 'checkHooks' }, { id: 'reconnect' }] })
  })

  it('shows the hooks banner when Kernel could not rewrite out-of-date hooks at start (KERNEL-206)', () => {
    expect(bannerFor(input({ hooks: { port: 7420, listening: true, installed: false, events: [], needsInstall: true } }))).toMatchObject({ id: 'hooks', actions: [{ id: 'checkHooks' }, { id: 'reconnect' }] })
    expect(bannerFor(input({ hooks: { port: 7420, listening: true, installed: false, events: [] } }))).toBeNull()
  })
})
