**A fresh install sees a splash, then New chat. The checks never take a screen of their own.** Amends KERNEL-27, KERNEL-213 and KERNEL-457. CJ's call, from the onboarding redesign canvas.

**The splash is the wordmark alone.** It shows on a fresh install, and from Settings, About, Show again. It opens New chat when the wordmark's own animation ends (an `animationend` event), not on a timer. Welcome, Checks, Permissions and Create your first project are gone, and `OnboardingStep` is `splash`, `project` and `loading`.

**The checks run behind the app.** Boot still runs them on every launch. A blocking failure shows as one line above New chat's box, with its fix: Copy command for a command, Use 7421 for a taken port, Check again otherwise. A launch that opens anywhere else gets a toast. Nothing moves the route.

**The permission mode is saved without asking.** The splash saves the mode the app already shows (Auto on a new install), so the KERNEL-432 migration never pins a new install to Accept edits. People change it from the composer's mode picker or Settings, Permissions.

**Signing out lands on New chat**, where the failing sign-in check shows with `claude auth login`. Check hooks still opens on a first run whose hooks aren't installed, now over New chat.
