import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { exec } from '../src/main/services/exec'
import { bundledCodex } from '../src/main/services/providers/binary'

// Mac only (vitest.config.ts leaves `*.mac.test.ts` out anywhere else): `bundledCodex` looks in the Mac build's vendor folder,
// `x86_64-apple-darwin` or `aarch64-apple-darwin`. The app ships for the Mac only, so it never looks for the Linux one.
describe('the Codex Kernel bundles (KERNEL-406)', () => {
  it('bundles the pinned Codex, the version its protocol types came from', async () => {
    const bin = bundledCodex()
    expect(bin).toBeTruthy()
    const pinned = (await readFile(join(__dirname, '..', 'src/main/services/providers/codex/protocol/VERSION'), 'utf8')).trim()
    const pkg = JSON.parse(await readFile(join(__dirname, '..', 'package.json'), 'utf8')) as { dependencies: Record<string, string> }
    expect(pinned).toBe(`codex-cli ${pkg.dependencies['@openai/codex']}`)
    expect((await exec(bin!, ['--version'], { timeoutMs: 60_000 })).stdout.trim()).toBe(pinned)
  })
})
