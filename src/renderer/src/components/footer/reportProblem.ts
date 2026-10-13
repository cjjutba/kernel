import { call } from '../../api'

const NEW_ISSUE = 'https://github.com/cjjutba/kernel/issues/new'

export interface ProblemEnv {
  /** Kernel's own version, from `app.info`. */
  version: string
  /** "macOS 14.5", or what is known of it. */
  os: string
  arch?: string
}

/**
 * A prefilled new GitHub issue: headings for the user to fill in, then the Environment. Nothing in it names an account, an email, a path or a repo.
 * The user reviews it on GitHub and submits it there, and Kernel sends nothing itself.
 */
export function reportProblemUrl(env: ProblemEnv): string {
  const body = [
    '## What happened', '', '', '## What you expected', '', '', '## Steps to reproduce', '', '1. ', '',
    '## Environment', '',
    `- Kernel ${env.version}`,
    `- ${env.os}${env.arch ? `, ${env.arch}` : ''}`,
    '- Logs are in ~/Library/Logs/Kernel and can be attached to this issue.'
  ].join('\n')
  return `${NEW_ISSUE}?labels=bug&body=${encodeURIComponent(body)}`
}

interface UaData { platformVersion?: string; architecture?: string }

/** The macOS version and architecture the window reports. Chromium freezes the version in the user agent, so the client hints come first. */
async function readOs(): Promise<Pick<ProblemEnv, 'os' | 'arch'>> {
  const nav = navigator as Navigator & { userAgentData?: { getHighEntropyValues(hints: string[]): Promise<UaData> } }
  try {
    const hints = await nav.userAgentData?.getHighEntropyValues(['platformVersion', 'architecture'])
    if (hints?.platformVersion) return { os: `macOS ${hints.platformVersion}`, ...(hints.architecture ? { arch: hints.architecture === 'arm' ? 'arm64' : hints.architecture } : {}) }
  } catch { /* fall back to the user agent */ }
  const mac = /Mac OS X ([\d_.]+)/.exec(navigator.userAgent)?.[1]?.replace(/_/g, '.')
  return { os: mac ? `macOS ${mac}` : 'macOS' }
}

/** Opens the prefilled issue in the browser. */
export async function reportProblem(): Promise<void> {
  const [info, os] = await Promise.all([call('app.info', undefined), readOs()])
  await call('system.openExternal', { url: reportProblemUrl({ version: info.version, ...os }) })
}
