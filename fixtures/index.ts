import type { Fixture } from './types'
import { floorFixtures } from './floor'
import { platformFixtures } from './platform'
import { teamFixtures } from './team'
import { workspaceFixtures } from './workspace'

export type { Fixture } from './types'

/**
 * Every fixture, keyed by its PNG name in design/screens. One file per lane so lanes don't edit each other's.
 * The issue that builds a screen adds its fixture here.
 */
export const fixtures: Record<string, Fixture> = { ...teamFixtures, ...floorFixtures, ...workspaceFixtures, ...platformFixtures }
