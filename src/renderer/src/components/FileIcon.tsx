/*!
 * File and folder icons: Material Icon Theme 5.39.0, https://github.com/material-extensions/vscode-material-icon-theme
 *
 * The MIT License (MIT)
 * Copyright (c) 2025 Material Extensions
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files
 * (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge,
 * publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so,
 * subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
 * MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE
 * FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION
 * WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
 */
import './fileIcon.css'
// Named imports, so the build leaves out the parts of the manifest Kernel doesn't read (folderNamesExpanded, iconDefinitions, languageIds).
import { file, fileExtensions, fileNames, folder, folderNames, light } from 'material-icon-theme/dist/material-icons.json'
import { iconName, type IconFor, type IconManifest } from '../fileIcons'
import { useStore } from '../store'

const m: IconManifest = { file, fileExtensions, fileNames, folder, folderNames, light }
// Every icon is its own file in the build (the renderer's assetsInlineLimit keeps SVGs out of data: URIs), fetched when first drawn.
const urls = import.meta.glob<string>('./*.svg', { base: '../../../../node_modules/material-icon-theme/icons/', query: '?url', import: 'default', eager: true })
const byName = new Map(Object.entries(urls).map(([file, url]) => [file.slice(2, -4), url]))

/** The URL of the icon VS Code draws for a path, in the given theme (KERNEL-399). */
export function fileIconUrl(path: string, o: IconFor = {}): string | undefined {
  return byName.get(iconName(m, path, o)) ?? byName.get(o.dir ? m.folder : m.file)
}

/**
 * A file or folder's icon from Material Icon Theme, in color, wherever a repo file shows (KERNEL-399). It is decoration: the name next
 * to it says what it is, so it has no alt text.
 */
export function FileIcon({ path, dir, open, size = 16, className }: { path: string; dir?: boolean; open?: boolean; size?: number; className?: string }) {
  const light = useStore((s) => s.ui.theme) === 'light'
  const src = fileIconUrl(path, { dir, open, light })
  if (!src) return null
  return <img className={['file-icon', className].filter(Boolean).join(' ')} src={src} width={size} height={size} alt="" aria-hidden="true" draggable={false} />
}

/** A path with its icon in front, for a path shown on its own: an approval's file, the Inbox's File row, a list of files in Settings. */
export function FileLabel({ path, size = 14 }: { path: string; size?: number }) {
  return <span className="file-label"><FileIcon path={path} size={size} /><span className="ellipsis">{path}</span></span>
}
