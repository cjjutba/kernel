import type { MenuItemConstructorOptions } from 'electron'
import type { ZoomStep } from './windowZoom'

/**
 * The app menu: Electron's default macOS menu, built from the same roles, with Help holding Copy diagnostics (KERNEL-288).
 * The roles bring Cmd+C, Cmd+V, Cmd+Q and the rest of the standard shortcuts. Quit calls app.quit, so it still asks while
 * agents work (KERNEL-214). Cmd+W closes a tab, not the window: the window catches it before the menu does.
 * View spells out the default view menu so Zoom In, Zoom Out and Actual Size go through `zoom`, which moves the traffic lights with
 * the page (KERNEL-901). The zoom roles would change the page alone.
 */
export function appMenu(o: { copyDiagnostics: () => void; zoom: (step: ZoomStep) => void }): MenuItemConstructorOptions[] {
  return [
    { role: 'appMenu' },
    { role: 'fileMenu' },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { id: 'zoom-reset', label: 'Actual Size', accelerator: 'CommandOrControl+0', click: () => o.zoom('reset') },
        { id: 'zoom-in', label: 'Zoom In', accelerator: 'CommandOrControl+Plus', click: () => o.zoom('in') },
        { id: 'zoom-out', label: 'Zoom Out', accelerator: 'CommandOrControl+-', click: () => o.zoom('out') },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    { role: 'windowMenu' },
    { role: 'help', submenu: [{ label: 'Copy diagnostics', click: () => o.copyDiagnostics() }] }
  ]
}
