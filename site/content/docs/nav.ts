// The docs sidebar, in order. Each page is <slug>.md in this folder. `introduction` is /docs, the rest /docs/<slug>.
// A page missing from this list doesn't show, and a slug here with no file fails the build.

export const DOCS_NAV: { title: string; pages: string[] }[] = [
  { title: 'Get started', pages: ['introduction', 'install', 'first-brief', 'how-it-works'] },
  { title: 'Concepts', pages: ['rooms', 'kernel', 'agents', 'plans', 'workspaces', 'pull-requests', 'reviews'] },
  { title: 'Features', pages: ['issues', 'shared-files', 'scripts', 'accounts', 'permissions', 'checkpoints', 'inbox'] },
  { title: 'Configuration', pages: ['settings', 'room-settings', 'shortcuts'] },
  { title: 'Help', pages: ['troubleshooting', 'privacy'] }
]
