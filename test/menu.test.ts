import type { MenuItemConstructorOptions } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import { appMenu } from '../src/main/menu'

// KERNEL-288: the app menu is Electron's default, built from its roles, with Help holding Copy diagnostics.
describe('the app menu', () => {
  it('keeps the standard menus, whose roles bring Cmd+C, Cmd+V and Cmd+Q', () => {
    const menus = appMenu({ copyDiagnostics: () => undefined, zoom: () => undefined }).map((m) => m.role ?? m.label)
    expect(menus).toEqual(['appMenu', 'fileMenu', 'editMenu', 'View', 'windowMenu', 'help'])
  })

  it('has Copy diagnostics under Help', () => {
    const copy = vi.fn()
    const help = appMenu({ copyDiagnostics: copy, zoom: () => undefined }).find((m) => m.role === 'help')!
    const item = (help.submenu as MenuItemConstructorOptions[]).find((i) => i.label === 'Copy diagnostics')!
    item.click!({} as never, undefined, {} as never)
    expect(copy).toHaveBeenCalledOnce()
  })

  // KERNEL-901: the View menu zooms through Kernel, which moves the traffic lights, and keeps the standard keys and the other roles.
  it('zooms the window from View, with the standard keys', () => {
    const zoom = vi.fn()
    const view = appMenu({ copyDiagnostics: () => undefined, zoom }).find((m) => m.label === 'View')!
    const items = view.submenu as MenuItemConstructorOptions[]
    const click = (label: string) => items.find((i) => i.label === label)!.click!({} as never, undefined, {} as never)
    click('Zoom In'); click('Zoom Out'); click('Actual Size')
    expect(zoom.mock.calls).toEqual([['in'], ['out'], ['reset']])
    expect(items.filter((i) => i.accelerator).map((i) => i.accelerator)).toEqual(['CommandOrControl+0', 'CommandOrControl+Plus', 'CommandOrControl+-'])
    expect(items.filter((i) => i.role).map((i) => i.role)).toEqual(['reload', 'forceReload', 'toggleDevTools', 'togglefullscreen'])
  })
})
