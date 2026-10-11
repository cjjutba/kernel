import type { MenuItemConstructorOptions } from 'electron'

/**
 * The app menu: Electron's default macOS menu, built from the same roles, with Help holding Copy diagnostics (KERNEL-288).
 * The roles bring Cmd+C, Cmd+V, Cmd+Q and the rest of the standard shortcuts. Quit calls app.quit, so it still asks while
 * agents work (KERNEL-214). Cmd+W closes a tab, not the window: the window catches it before the menu does.
 */
export function appMenu(o: { copyDiagnostics: () => void }): MenuItemConstructorOptions[] {
  return [
    { role: 'appMenu' },
    { role: 'fileMenu' },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
    { role: 'help', submenu: [{ label: 'Copy diagnostics', click: () => o.copyDiagnostics() }] }
  ]
}
