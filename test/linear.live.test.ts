import { describe, expect, it } from 'vitest'
import { getIssue, getScope, listIssues, linearToken } from '../src/main/services/linear'

// The read queries against the real Linear API, to catch a field Linear renamed or removed. Read-only: it never moves an issue.
// LINEAR_API_KEY=lin_api_... pnpm test test/linear.live.test.ts
const token = linearToken()

describe.skipIf(!token)('Linear, live', () => {
  it('lists open issues, reads the first one with its comments, and reads the scope', async () => {
    const scope = await getScope(token)
    expect(scope.teams.length).toBeGreaterThan(0)
    for (const c of scope.cycles) expect(scope.teams.map((t) => t.id)).toContain(c.teamId)

    const issues = await listIssues(token, { mine: false })
    expect(issues.length).toBeLessThanOrEqual(100)
    for (const i of issues) expect(['triage', 'backlog', 'unstarted', 'started']).toContain(i.state.type)
    const first = issues[0]
    if (!first) return
    expect(first.branchName).not.toBe('')

    const team = await listIssues(token, { mine: false, teamId: first.team.id, query: first.id })
    expect(team.map((i) => i.id)).toContain(first.id)

    const issue = await getIssue(token, first.id)
    expect(issue).toMatchObject({ id: first.id, uuid: first.uuid, title: first.title })
    expect(typeof issue.description).toBe('string')
    expect(issue.comments.length).toBeLessThanOrEqual(50)
  }, 30_000)
})
