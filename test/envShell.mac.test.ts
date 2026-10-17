import { describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { tempRepo, freePort } from './helpers'
import { Kernel } from '../src/main/kernel'
import { bus } from '../src/main/bus'
import type { Cipher } from '../src/main/services/env'

/** Stands in for safeStorage, which doesn't work under ELECTRON_RUN_AS_NODE. Its output never holds the text it was given. */
const fakeCipher: Cipher = {
  encrypt: (text) => `enc:${Buffer.from([...text].reverse().join(''), 'utf8').toString('hex')}`,
  decrypt: (data) => [...Buffer.from(data.slice('enc:'.length), 'hex').toString('utf8')].reverse().join('')
}

const until = async (ok: () => boolean, ms = 8000) => { const t = Date.now(); while (!ok()) { if (Date.now() - t > ms) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 25)) } }

// Mac only (vitest.config.ts leaves `*.mac.test.ts` out anywhere else): the terminal is forced to /bin/zsh, which macOS ships
// and ubuntu-latest doesn't, and the check is zsh's ZDOTDIR and .zshenv.
describe('Kernel env in a shell', () => {
  it('reads a repo\'s env files with no trust step, in a shell or a big terminal (KERNEL-913)', async () => {
    // ZDOTDIR makes `zsh -l` run the repo's own .zshenv, the way BASH_ENV does for `bash -c`.
    const repo = await tempRepo({
      'README.md': '# shell\n',
      '.env.shell': 'ZDOTDIR=zd\nFROM_REPO=yes\n',
      'zd/.zshenv': 'touch "$PWD/zshenv-ran"\n',
      '.claude/agents/christian.md': '---\nname: christian\ndescription: Frontend engineer.\n---\nYou are Christian.',
      '.kernel/settings.toml': '[env]\nfiles = [".env.shell"]\n'
    })
    const dataDir = await mkdtemp(join(tmpdir(), 'kernel-data-'))
    const home = await mkdtemp(join(tmpdir(), 'kernel-home-'))
    await writeFile(join(dataDir, 'settings.json'), JSON.stringify({ hookPort: await freePort(), worktreeRoot: join(home, 'wt'), workspace: { baseRef: 'main' } }))
    const shell = process.env.SHELL
    process.env.SHELL = '/bin/zsh'
    const k = new Kernel({ dataDir, home, cipher: fakeCipher })
    try {
      await k.start()
      k.sessions.send = async () => ({ queued: false })
      const h = k.handlers()
      const project = await k.addProject(repo)
      await h['env.set']({ projectId: project.id, name: 'MINE', value: 'set-by-me' })
      const ws = await k.createWorkspace(project.id, { prompt: 'go', agentId: 'christian', title: 'Shell' })
      expect(ws.status).toBe('ready')
      // The user's own variables and the repo's file both apply, and the shell runs the repo's .zshenv.
      expect(k.envFor(ws)).toMatchObject({ MINE: 'set-by-me', FROM_REPO: 'yes' })
      expect(k.envFor(ws, { script: true }).FROM_REPO).toBe('yes')

      let out = ''
      const on = (e: { type: string; chatId?: string; data?: string }) => { if (e.type === 'terminal.data') out += e.data }
      bus.on('push', on)
      const plain = `shell:${ws.id}`
      await h['terminal.resize']({ chatId: plain, cols: 100, rows: 30 })
      await h['terminal.write']({ chatId: plain, data: 'echo "plain-$((40+2))"\r' })
      await until(() => out.includes('plain-42'))
      expect(existsSync(join(ws.path, 'zshenv-ran'))).toBe(true)
      await rm(join(ws.path, 'zshenv-ran'))
      const start = k.ptys.start.bind(k.ptys)
      k.ptys.start = (id, o) => start(id, { ...o, command: undefined })
      const term = await h['chats.create']({ workspaceId: ws.id, kind: 'terminal' })
      await h['terminal.write']({ chatId: term.id, data: 'echo "big-$((40+3))"\r' })
      await until(() => out.includes('big-43'))
      expect(existsSync(join(ws.path, 'zshenv-ran'))).toBe(true)
      bus.off('push', on)
    } finally {
      if (shell === undefined) delete process.env.SHELL
      else process.env.SHELL = shell
      await k.stop()
    }
  })
})
