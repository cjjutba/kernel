/** The lookups in Material Icon Theme's manifest (`material-icon-theme/dist/material-icons.json`) that pick an icon (KERNEL-399). */
export interface IconLookup {
  fileNames: Record<string, string>
  fileExtensions: Record<string, string>
  folderNames: Record<string, string>
}

export interface IconManifest extends IconLookup {
  file: string
  folder: string
  light: Partial<IconLookup>
}

export interface IconFor { dir?: boolean; open?: boolean; light?: boolean }

/**
 * An open folder's icon from its closed one: `folder-src` opens as `folder-src-open`, `folder-jinja_light` as `folder-jinja-open_light`.
 * The manifest spells every pair out in `folderNamesExpanded`, which is a third of its size, so the renderer leaves that out and
 * derives it (test/fileIcons.test.ts checks every pair).
 */
export const openFolder = (closed: string) => closed.replace(/(_light)?$/, '-open$1')

/**
 * The icon VS Code draws for a path with Material Icon Theme. A file goes by its whole name, then by its extensions from the longest
 * (`a.test.ts` tries `test.ts`, then `ts`; `.env` tries `env`). A folder goes by its name. In the light theme, the manifest's light
 * overrides come first at each step.
 */
export function iconName(m: IconManifest, path: string, o: IconFor = {}): string {
  const trimmed = path.replace(/\/+$/, '')
  const name = trimmed.slice(trimmed.lastIndexOf('/') + 1).toLowerCase()
  const maps: Partial<IconLookup>[] = o.light ? [m.light, m] : [m]
  const find = (key: keyof IconLookup, k: string) => { for (const x of maps) { const v = x[key]?.[k]; if (v) return v } return undefined }
  if (o.dir) { const closed = find('folderNames', name) ?? m.folder; return o.open ? openFolder(closed) : closed }
  const byName = find('fileNames', name)
  if (byName) return byName
  const parts = name.split('.')
  for (let i = 1; i < parts.length; i++) {
    const byExt = find('fileExtensions', parts.slice(i).join('.'))
    if (byExt) return byExt
  }
  return m.file
}
