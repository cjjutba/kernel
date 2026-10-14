import { describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import { copyFile, mkdir, mkdtemp, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const electron = createRequire(import.meta.url)('electron') as string
const asar = join(dirname(dirname(electron)), 'Resources', 'default_app.asar')
const removeTree = resolve(__dirname, '../src/main/services/removeTree.ts')

/** A worktree with Electron in its node_modules, as Kernel's own worktrees have. */
async function tree() {
  const dir = await mkdtemp(join(tmpdir(), 'kernel-asar-'))
  const res = join(dir, 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'Resources')
  await mkdir(res, { recursive: true })
  await copyFile(asar, join(res, 'default_app.asar'))
  return dir
}

/** Runs `code` as an ES module in Electron's own Node, the way Kernel's main process runs, and returns what it printed. */
async function inElectron(code: string): Promise<string> {
  const file = join(await mkdtemp(join(tmpdir(), 'kernel-asar-run-')), 'run.mjs')
  await writeFile(file, code)
  return new Promise((done) => {
    execFile(electron, [file], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, timeout: 30_000 }, (_e, out) => done(out.trim()))
  })
}

// Mac only (vitest.config.ts leaves `*.mac.test.ts` out anywhere else): the Electron binary pnpm installs is the Mac one.
describe('deleting a worktree under Electron (KERNEL-810)', () => {
  it("fails with Electron's own fs, and removeTree deletes it", async () => {
    // Without the fix: Electron reads the .asar file as a folder, so the folder holding it is never empty.
    const plain = await tree()
    expect(await inElectron(`import { rm } from 'node:fs/promises'\nawait rm(${JSON.stringify(plain)}, { recursive: true, force: true }).then(() => console.log('deleted'), (e) => console.log(e.code))`)).toBe('ENOTEMPTY')

    const dir = await tree()
    expect(await inElectron(`const { removeTree } = await import(${JSON.stringify(removeTree)})\nawait removeTree(${JSON.stringify(dir)})\nconsole.log('deleted')`)).toBe('deleted')
    await expect(stat(dir)).rejects.toThrow(/ENOENT/)
  }, 60_000)
})
