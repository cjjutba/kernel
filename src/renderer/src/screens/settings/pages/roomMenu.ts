import { actions, useStore } from '../../../store'

type MenuId = Parameters<typeof actions.ui.toggleMenu>[0]

/** The open state of a Select kept in the store's `ui.menu`, so a fixture can shoot it open (KERNEL-680). Spread it onto the Select. */
export function useMenuOpen(id: MenuId): { open: boolean; onOpenChange: (open: boolean) => void } {
  const open = useStore((s) => s.ui.menu === id)
  return { open, onOpenChange: (next) => { if (next !== open) actions.ui.toggleMenu(id) } }
}
