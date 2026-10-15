import { useCallback, useEffect, useState } from 'react'
import { isRunName, type AppSettings, type DeepPartial, type ProjectSettings, type ProjectSettingsPatch } from '@shared/types'
import { call, cleanError } from '../../api'
import { actions, getState, useStore } from '../../store'
import { remoteOf } from './remote'

/** The app settings, read from the store. Null until the first load. */
export function useSettings(): AppSettings | null {
  return useStore((s) => s.settings)
}

function merge<T>(base: T, over: unknown): T {
  if (over === null || typeof over !== 'object' || Array.isArray(over) || base === null || typeof base !== 'object') return over as T
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) }
  for (const [k, v] of Object.entries(over)) out[k] = merge((base as Record<string, unknown>)[k], v)
  return out as T
}

const newest = new Map<string, number>()
let saves = 0

function leafPaths(patch: unknown, at = ''): string[] {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return [at]
  const keys = Object.keys(patch)
  return keys.length ? keys.flatMap((k) => leafPaths((patch as Record<string, unknown>)[k], at ? `${at}.${k}` : k)) : [at]
}

/** Marks a save as the newest for its keys. The answer lands only while no later save has touched one of them. */
function claim(scope: string, patch: unknown) {
  const id = ++saves
  const keys = leafPaths(patch).map((k) => `${scope}:${k}`)
  for (const k of keys) newest.set(k, id)
  return () => keys.every((k) => newest.get(k) === id)
}

/**
 * Save a change. The screen updates at once and main's answer replaces it (main clamps numbers). It returns the saved settings,
 * or undefined when the save failed. A failure puts the old settings back and says so, so a control never shows a value that was
 * not saved. When two saves touch one key, only the newest answer lands.
 */
export async function patchSettings(patch: DeepPartial<AppSettings>): Promise<AppSettings | undefined> {
  const before = getState().settings
  if (!before) return undefined
  const current = claim('app', patch)
  actions.settings.set(merge(before, patch))
  try {
    const saved = await call('settings.set', { patch })
    if (current()) actions.settings.set(saved)
    return saved
  } catch (e) {
    if (current()) actions.settings.set(before)
    actions.ui.toast({ title: 'Could not save the setting', sub: cleanError(e) })
    return undefined
  }
}

/** A project's settings from its .kernel files. Null until the first read, and `failed` when that read did not come back. */
export function useProjectSettingsLoad(projectId?: string): { rs: ProjectSettings | null; failed: boolean; retry: () => Promise<void> } {
  const rs = useStore((s) => (projectId ? s.projectSettings[projectId] ?? null : null))
  const [failed, setFailed] = useState(false)
  const load = useCallback(async () => {
    if (!projectId) return
    try {
      actions.settings.setProject(projectId, await call('settings.project', { projectId }))
      setFailed(false)
    } catch {
      setFailed(true)
    }
  }, [projectId])
  useEffect(() => { setFailed(false); void load() }, [load])
  return { rs, failed: failed && !rs, retry: load }
}

/** A project's settings from its .kernel files. Null until the first read. */
export function useProjectSettings(projectId?: string): ProjectSettings | null {
  return useProjectSettingsLoad(projectId).rs
}

/**
 * Apply a project patch the way main writes the personal file: a `null` or an empty string removes the key, and `sources` follows.
 * It reads the groups from the patch, so a new setting group needs no change here.
 */
export function applyProjectPatch(rs: ProjectSettings, patch: ProjectSettingsPatch): ProjectSettings {
  const out: Record<string, unknown> = { ...rs }
  const sources = { ...rs.sources }
  for (const [group, values] of Object.entries(patch) as [string, Record<string, unknown> | undefined][]) {
    if (group === 'runScripts') {
      out.runScripts = applyRunScripts(rs.runScripts ?? [], sources, (values ?? {}) as Record<string, string | null>)
      continue
    }
    if (group === 'references') {
      // The folders are one top-level list in the personal file: a patch replaces all of it, and an empty list or null removes the key.
      const next = (values as unknown as string[] | null) ?? []
      out.references = next
      out.missingReferences = (rs.missingReferences ?? []).filter((p) => next.includes(p))
      continue
    }
    if (group === 'preview') {
      out.preview = { urls: applyPreviewUrls(rs.preview?.urls ?? [], sources, (values as ProjectSettingsPatch['preview'])?.urls) }
      continue
    }
    const next: Record<string, unknown> = { ...(rs as unknown as Record<string, Record<string, unknown> | undefined>)[group] }
    for (const [k, v] of Object.entries(values ?? {})) {
      const path = `${group}.${k}`
      if (v === null || v === '') {
        delete next[k]
        // The personal file stops setting it: an override falls back to settings.toml, and a personal value to the app default.
        if (sources[path] === 'override') sources[path] = 'shared'
        else if (sources[path] === 'local') delete sources[path]
      } else {
        next[k] = v
        sources[path] = sources[path] === 'shared' || sources[path] === 'override' ? 'override' : 'local'
      }
    }
    if (Object.keys(next).length || group in rs) out[group] = next
  }
  return { ...(out as unknown as ProjectSettings), sources }
}

/**
 * The run scripts after a patch, by name. `run` stays first. Removing an override keeps the command on screen (settings.toml's
 * is not known here), and the saved settings replace it a moment later.
 */
export function applyRunScripts(list: ProjectSettings['runScripts'], sources: ProjectSettings['sources'], values: Record<string, string | null>): ProjectSettings['runScripts'] {
  let next = [...list]
  for (const [key, v] of Object.entries(values)) {
    const name = isRunName(key) ? 'run' : key
    const path = `runScripts.${name}`
    if (v === null || v === '') {
      if (sources[path] === 'override') sources[path] = 'shared'
      else if (sources[path] !== 'shared') { next = next.filter((r) => r.name !== name); delete sources[path] }
    } else {
      next = next.some((r) => r.name === name) ? next.map((r) => (r.name === name ? { name, command: v } : r)) : [...next, { name, command: v }]
      sources[path] = sources[path] === 'shared' || sources[path] === 'override' ? 'override' : 'local'
    }
  }
  return [...next.filter((r) => r.name === 'run'), ...next.filter((r) => r.name !== 'run')]
}

/**
 * The preview URLs after a patch. The list is one value: a patch replaces all of it, and one with no address left, like `null`,
 * stops the personal file setting it (an override falls back to settings.toml, whose list the saved settings bring back).
 */
export function applyPreviewUrls(list: ProjectSettings['preview']['urls'], sources: ProjectSettings['sources'], value: ProjectSettings['preview']['urls'] | null | undefined): ProjectSettings['preview']['urls'] {
  if (value === undefined) return list
  const urls = (value ?? []).filter((u) => u.url.trim())
  const path = 'preview.urls'
  if (!urls.length) {
    if (sources[path] === 'override') sources[path] = 'shared'
    else if (sources[path] !== 'shared') delete sources[path]
    return sources[path] === 'shared' ? list : []
  }
  sources[path] = sources[path] === 'shared' || sources[path] === 'override' ? 'override' : 'local'
  return urls
}

/** Save a change to a project's personal settings, `.kernel/settings.local.toml`. Returns the saved settings, or undefined after a failure, which rolls back and says so. */
export async function patchProjectSettings(projectId: string, patch: ProjectSettingsPatch): Promise<ProjectSettings | undefined> {
  const before = getState().projectSettings[projectId]
  const current = claim(`project:${projectId}`, patch)
  if (before) actions.settings.setProject(projectId, applyProjectPatch(before, patch))
  try {
    const saved = await call('settings.setProject', { projectId, patch })
    if (current()) actions.settings.setProject(projectId, saved)
    return saved
  } catch (e) {
    if (before && current()) actions.settings.setProject(projectId, before)
    actions.ui.toast({ title: 'Could not save the setting', sub: cleanError(e) })
    return undefined
  }
}

/** The remote this project uses, from its own settings and the app's. */
export function useRemote(projectId?: string): string {
  const rs = useProjectSettings(projectId)
  return remoteOf(rs, useSettings())
}
