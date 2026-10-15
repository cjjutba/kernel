import { describe, expect, it } from 'vitest'
import { currentRoute } from '../src/shared/settingsRoutes'
import type { Route } from '../src/shared/types'

const project = (section: string, row?: string) => ({ name: 'settings', page: 'project', projectId: 'p1', section, ...(row ? { row } : {}) }) as unknown as Route

describe('currentRoute (KERNEL-914)', () => {
  it.each([['permissions'], ['skills']])('opens Agents for the old %s section, keeping the row', (section) => {
    expect(currentRoute(project(section, 'mode'))).toEqual(project('agents', 'mode'))
  })

  it('opens Environment for the old files section and keeps setup for scripts', () => {
    expect(currentRoute(project('files'))).toEqual(project('environment'))
    expect(currentRoute(project('scripts'))).toEqual(project('setup'))
  })

  it('leaves the six current sections as they are', () => {
    for (const section of ['general', 'git', 'setup', 'environment', 'agents', 'prs']) expect(currentRoute(project(section))).toEqual(project(section))
  })
})
