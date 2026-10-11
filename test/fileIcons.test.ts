import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import manifest from 'material-icon-theme/dist/material-icons.json'
import { iconName, openFolder, type IconManifest } from '../src/renderer/src/fileIcons'

// KERNEL-399: files and folders take Material Icon Theme's icons, picked the way VS Code picks them.
const m: IconManifest = manifest
const icon = (path: string, o?: Parameters<typeof iconName>[2]) => iconName(m, path, o)

describe('file icons', () => {
  it('picks a file by its whole name first, ignoring case', () => {
    expect(icon('package.json')).toBe('nodejs')
    expect(icon('docs/README.md')).toBe('readme')
    expect(icon('.gitignore')).toBe('git')
    expect(icon('tsconfig.web.json')).toBe('tsconfig')
  })

  it('then by its extensions, longest first', () => {
    expect(icon('test/a.test.ts')).toBe('test-ts')
    expect(icon('src/App.tsx')).toBe('react_ts')
    expect(icon('src/kernel.ts')).toBe('typescript')
    expect(icon('notes.MD')).toBe('markdown')
    expect(icon('.env')).toBe('tune')
  })

  it('falls back to the plain file and folder icons', () => {
    expect(icon('x.unknownext')).toBe('file')
    expect(icon('Unnamed')).toBe('file')
    expect(icon('plain-folder', { dir: true })).toBe('folder')
    expect(icon('plain-folder', { dir: true, open: true })).toBe('folder-open')
  })

  it('picks a folder by its name, open or closed', () => {
    expect(icon('src', { dir: true })).toBe('folder-src')
    expect(icon('packages/web/src/', { dir: true, open: true })).toBe('folder-src-open')
    expect(icon('.github', { dir: true })).toBe('folder-github')
  })

  it('derives every open folder icon the manifest spells out, so the renderer can leave that list out', () => {
    const pairsOf = (closed: Record<string, string>, open: Record<string, string>) => Object.entries(open).map(([k, v]) => [closed[k], v])
    const pairs = [...pairsOf(manifest.folderNames, manifest.folderNamesExpanded), ...pairsOf(manifest.light.folderNames, manifest.light.folderNamesExpanded)]
    expect(pairs.length).toBeGreaterThan(500)
    expect(pairs.filter(([closed, open]) => openFolder(closed) !== open)).toEqual([])
    expect(openFolder(manifest.folder)).toBe(manifest.folderExpanded)
  })

  it('takes the light theme overrides in light only', () => {
    expect(icon('.kernel/settings.toml')).toBe('toml')
    expect(icon('.kernel/settings.toml', { light: true })).toBe('toml_light')
  })

  it('has an SVG for every icon the manifest names', () => {
    const dist = join(__dirname, '../node_modules/material-icon-theme/dist')
    const missing = Object.entries(manifest.iconDefinitions).filter(([, d]) => !existsSync(join(dist, d.iconPath))).map(([name]) => name)
    expect(missing).toEqual([])
  })
})
