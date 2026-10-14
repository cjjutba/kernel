import { describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { tempRepo, trustRoom } from './helpers'
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
  it('runs nothing from a repo\'s env files until the room is trusted, in a shell or a big terminal', async () => {
    // ZDOTDIR makes `zsh -l` run the repo's own .zshenv, the way BASH_ENV does for `bash -c`.
    const repo = await tempRepo({
      'README.md': '# shell\n',
      '.env.shell': 'ZDOTDIR=zd\nFROM_REPO=yes\n',
      'zd/.zshenv': 'touch "$PWD/zshenv-ran"\n',
      '.claude/agents/kai.md': '---\nname: kai\ndescription: Frontend engineer.\n---\nYou are Kai.',
      '.kernel/settings.toml': '[env]\nfiles = [".env.shell"]\n'
    })
    const dataDir = await mkdtemp(join(tmpdir(), 'kernel-data-'))
    const home = await mkdtemp(join(tmpdir(), 'kernel-home-'))
    await writeFile(join(dataDir, 'settings.json'), JSON.stringify({ hookPort: 18000 + Math.floor(Math.random() * 900), worktreeRoot: join(home, 'wt'), workspace: { baseRef: 'main' } }))
    const shell = process.env.SHELL
    process.env.SHELL = '/bin/zsh'
    const k = new Kernel({ dataDir, home, cipher: fakeCipher })
    try {
      await k.start()
      k.sessions.send = async () => ({ queued: false })
      const h = k.handlers()
      const room = await k.addRoom(repo)
      await h['env.set']({ roomId: room.id, name: 'MINE', value: 'set-by-me' })
      const ws = await k.createWorkspace(room.id, { prompt: 'go', agentId: 'kai', title: 'Shell' })
      expect(ws.status).toBe('trust')
      expect((await h['rooms.scriptTrust']({ roomId: room.id }))?.envFiles).toEqual(['.env.shell'])
      // The user's own variables still apply. The repo's file doesn't.
      expect(k.envFor(ws)).toMatchObject({ MINE: 'set-by-me' })
      expect(k.envFor(ws).FROM_REPO).toBeUndefined()
      expect(k.envFor(ws, { script: true }).FROM_REPO).toBeUndefined()

      let out = ''
      const on = (e: { type: string; chatId?: string; data?: string }) => { if (e.type === 'terminal.data') out += e.data }
      bus.on('push', on)
      const plain = `shell:${ws.id}`
      await h['terminal.resize']({ chatId: plain, cols: 100, rows: 30 })
      await h['terminal.write']({ chatId: plain, data: 'echo "plain-$((40+2))"\r' })
      await until(() => out.includes('plain-42'))
      expect(existsSync(join(ws.path, 'zshenv-ran'))).toBe(false)

      // Once trusted, the same file is read, and the shell runs the repo's .zshenv. That shows the check above is real.
      await trustRoom(k, room.id)
      expect(k.envFor(ws).FROM_REPO).toBe('yes')
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
