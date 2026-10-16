import type { Fixture } from './types'
import { platformFixtures } from './platform'
import { scrollCheckFixtures } from './scrollCheck'
import { teamFixtures } from './team'
import { workspaceFixtures } from './workspace'

export type { Fixture } from './types'

/**
 * Every fixture, keyed by its screen name. One file per lane so lanes don't edit each other's.
 * The issue that builds a screen adds its fixture to its lane file, next to the screens it belongs with and not at the end of the file.
 * When every PR appends at the end, they all collide on the same lines.
 */
export const fixtures: Record<string, Fixture> = { ...teamFixtures, ...workspaceFixtures, ...platformFixtures, ...scrollCheckFixtures }
