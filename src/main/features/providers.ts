import { join } from 'node:path'
import type { Provider, ProviderBinary, ProviderStatus } from '@shared/types'
import type { Handlers } from '../kernel'
import { exec } from '../services/exec'
import { planName } from '../services/preflight'
import { resolveBinary } from '../services/providers/binary'
import { codexPlan, readCodexAccount } from '../services/providers/codex/client'
import { Feature } from './feature'

/** Until the provider accounts land later in KERNEL-406, the new channels say so instead of answering. */
const notYet = (): never => { throw new Error('Providers and accounts are not ready yet (KERNEL-406).') }

/** "codex-cli 0.153.4" or "2.1.292 (Claude Code)" to the version alone. */
export const versionOf = (out: string) => /(\d+\.\d+\.\d+)/.exec(out)?.[1]

/** Claude Code and Codex: their executables, accounts, switching, model lists and status (KERNEL-406). */
export class Providers extends Feature {
  /** The executable a provider runs, by Settings, Providers. */
  binary(provider: Provider): { path?: string; source: ProviderStatus['source'] } {
    return resolveBinary(provider, this.settings?.providers?.[provider])
  }

  /** CODEX_HOME of the active Codex account. Undefined is Codex's own `~/.codex`, the CLI login. */
  codexHome(): string | undefined { return undefined }

  /** The CLI's own config file, which Open shows. */
  configFile(provider: Provider) { return provider === 'claude' ? this.k.hooks.claudeSettings : join(process.env.CODEX_HOME ?? join(this.home, '.codex'), 'config.toml') }

  /**
   * Settings, Providers' status table, read through Kernel's own binary rather than whatever is on the PATH (KERNEL-277).
   * Text only: version, login method, plan and email.
   */
  async status(provider: Provider): Promise<ProviderStatus> {
    const { path, source } = this.binary(provider)
    const base: ProviderStatus = { provider, path, source, signedIn: false, configFile: this.configFile(provider) }
    if (!path) return { ...base, error: provider === 'claude' ? 'Kernel could not find Claude Code.' : 'Kernel could not find Codex.' }
    const v = await exec(path, ['--version'], { timeoutMs: 60_000 })
    const version = v.code === 0 ? versionOf(v.stdout) : undefined
    if (!version) return { ...base, error: `${path} did not start.` }
    if (provider === 'claude') {
      const a = await exec(path, ['auth', 'status'], { timeoutMs: 15_000 })
      let s: { loggedIn?: boolean; authMethod?: string; email?: unknown; subscriptionType?: unknown } = {}
      try { s = JSON.parse(a.stdout) } catch { /* not signed in, or an older CLI */ }
      if (!s.loggedIn) return { ...base, version }
      return { ...base, version, signedIn: true, loginMethod: 'Claude account', plan: planName(s.subscriptionType), email: typeof s.email === 'string' ? s.email : undefined }
    }
    const { account } = await readCodexAccount(path, undefined)
    // An API key login bills the API, which Kernel never runs on (D-018), so it reads as signed out.
    if (account?.type !== 'chatgpt') return { ...base, version, ...(account ? { error: 'Codex is signed in with an API key. Kernel runs agents on your ChatGPT plan, so sign in with ChatGPT.' } : {}) }
    return { ...base, version, signedIn: true, loginMethod: 'ChatGPT', plan: codexPlan(account.planType), email: account.email ?? undefined }
  }

  /** The executable path field and "Use system Claude" / "Use system Codex" / "Use bundled". */
  async setPath(provider: Provider, o: { path?: string; useSystem?: boolean }): Promise<ProviderStatus> {
    const cur: ProviderBinary = this.settings.providers[provider]
    const next = { path: o.path !== undefined ? o.path.trim() : cur.path, useSystem: o.useSystem ?? cur.useSystem }
    await this.k.config.setSettings({ providers: { [provider]: next } })
    return this.status(provider)
  }

  handlers() {
    return {
      'providers.status': async ({ provider }) => this.status(provider),
      'providers.setPath': async ({ provider, path, useSystem }) => this.setPath(provider, { path, useSystem }),
      'providers.signIn': async () => notYet(),
      'providers.openConfig': async ({ provider }) => { await this.o.openFile?.(this.configFile(provider)); return { ok: true as const } },
      'accounts.list': async () => notYet(),
      'accounts.add': async () => notYet(),
      'accounts.code': async () => notYet(),
      'accounts.cancelAdd': async () => notYet(),
      'accounts.switch': async () => notYet(),
      'accounts.signOut': async () => notYet(),
      'accounts.remove': async () => notYet(),
      'models.list': async () => notYet()
    } satisfies Partial<Handlers>
  }
}
