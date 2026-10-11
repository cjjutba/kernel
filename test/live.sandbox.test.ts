import { describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { query, type SandboxSettings } from '@anthropic-ai/claude-agent-sdk'
import { exec, git, run } from '../src/main/services/exec'
import { linkNodeModules } from '../src/main/services/scripts'
import { sessionEnv } from '../src/main/services/providers/claude'
import { bundledClaude, bundledCodex, findOnPath } from '../src/main/services/providers/binary'
import { withCodex } from '../src/main/services/providers/codex/client'
import type { SandboxPolicy } from '../src/main/services/providers/codex/protocol/v2/SandboxPolicy'

// KERNEL-436: what each provider's sandbox lets a command do in a Kernel worktree. Codex's sandbox runs through app-server's
// `command/exec`, with no model. Claude spends two short Haiku turns on the Claude plan, in Bypass, each running one probe
// script. So it only runs when asked:
//   KERNEL_LIVE=1 pnpm test test/live.sandbox.test.ts
// KERNEL_LIVE_OUT=<file> saves each probe's exit code and stderr as JSON. The fixture is a new folder in your home folder, not
// $TMPDIR or /tmp, which both sandboxes may let a command write, and is deleted afterwards. It changes no settings.
// EXPECTED holds the draft answers in docs/decisions/KERNEL-436.md. A mismatch means the draft is wrong there, not Kernel.

type Verdict = 'allowed' | 'denied' | 'not run'
type Verdicts = Record<string, Verdict>

interface Fixture {
  root: string
  repo: string
  wt: string
  common: string
  modules: string
  outside: string
  userTmp: string
  npmCache?: string
  /** gh is signed in and keeps its token in the Keychain, so `gh auth token` has to reach it. */
  ghKeychain: boolean
  node: boolean
  tag: string
}

interface Probe { id: string; run: string; effect?: () => boolean | Promise<boolean> }

const HAIKU = 'claude-haiku-4-5-20251001'
const GITHUB = ['github.com', '*.github.com', '*.githubusercontent.com']
const REGISTRIES = ['registry.npmjs.org', 'registry.yarnpkg.com', 'repo.yarnpkg.com']

/** The draft's answers, by provider, sandbox and probe. Probes the Mac can't run (no gh in the Keychain, no node) drop out. */
const EXPECTED: Record<'claude' | 'codex', Record<string, Verdicts>> = {
  claude: {
    bare: { commit: 'denied', outside: 'denied', tmpdir: 'allowed', userTmpdir: 'denied', modulesRead: 'allowed', modulesWrite: 'denied', commonDir: 'denied', hooks: 'denied', config: 'denied', unlisted: 'allowed', registry: 'allowed', npmCache: 'denied', ghKeychain: 'allowed', ghApi: 'denied', bind: 'denied' },
    a10: { commit: 'allowed', outside: 'denied', tmpdir: 'allowed', userTmpdir: 'allowed', modulesRead: 'allowed', modulesWrite: 'allowed', commonDir: 'allowed', hooks: 'denied', config: 'denied', unlisted: 'denied', registry: 'allowed', npmCache: 'allowed', ghKeychain: 'allowed', ghApi: 'allowed', bind: 'allowed' }
  },
  codex: {
    bare: { commit: 'denied', outside: 'denied', tmpdir: 'allowed', userTmpdir: 'allowed', modulesRead: 'allowed', modulesWrite: 'denied', commonDir: 'denied', hooks: 'denied', config: 'denied', unlisted: 'denied', registry: 'denied', npmCache: 'denied', ghKeychain: 'denied', ghApi: 'denied', bind: 'denied' },
    kernel: { commit: 'allowed', outside: 'denied', tmpdir: 'allowed', userTmpdir: 'allowed', modulesRead: 'allowed', modulesWrite: 'denied', commonDir: 'allowed', hooks: 'allowed', config: 'allowed', unlisted: 'allowed', registry: 'allowed', npmCache: 'denied', ghKeychain: 'allowed', ghApi: 'allowed', bind: 'allowed' }
  }
}

/** Claude's sandbox with nothing added, and with what A10 would add for a worktree. Both refuse dangerouslyDisableSandbox. */
function claudeSandboxes(f: Fixture): Record<string, SandboxSettings> {
  const base = { enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false }
  return {
    bare: base,
    a10: {
      ...base,
      filesystem: { allowWrite: [f.common, f.modules, f.userTmp, ...(f.npmCache ? [f.npmCache] : [])] },
      network: { allowedDomains: [...GITHUB, ...REGISTRIES], strictAllowlist: true, allowLocalBinding: true },
      enableWeakerNetworkIsolation: true
    }
  }
}

/** Codex's `workspace-write` with nothing added, and as `CodexRunner.sandbox()` sets it today with network on (KERNEL-406). */
function codexSandboxes(f: Fixture): Record<string, SandboxPolicy> {
  const base = { type: 'workspaceWrite' as const, excludeTmpdirEnvVar: false, excludeSlashTmp: false }
  return {
    bare: { ...base, writableRoots: [], networkAccess: false },
    kernel: { ...base, writableRoots: [f.common], networkAccess: true }
  }
}

function probes(f: Fixture): Probe[] {
  const t = `kernel-spike-${f.tag}`
  const at = (...p: string[]) => JSON.stringify(join(...p))
  const unsetGh = 'env -u GH_TOKEN -u GITHUB_TOKEN gh'
  const list: (Probe | false)[] = [
    // git writes the index, objects and the branch's ref under the repo's git common dir, outside the worktree.
    { id: 'commit', run: `echo hi > ${t}.txt && git add ${t}.txt && git commit -q -m ${t}`, effect: async () => (await git(f.wt, 'log', '-1', '--format=%s')).trim() === t },
    { id: 'outside', run: `echo x > ${at(f.outside, t)}`, effect: () => existsSync(join(f.outside, t)) },
    // $TMPDIR as the sandboxed shell has it, then the Mac's own per-user temp folder, which the app's $TMPDIR names.
    { id: 'tmpdir', run: 'f=$(mktemp) && echo x > "$f" && rm "$f"' },
    { id: 'userTmpdir', run: `echo x > ${at(f.userTmp, t)}`, effect: () => existsSync(join(f.userTmp, t)) },
    // The worktree's node_modules is a link to the main checkout's (linkNodeModules).
    { id: 'modulesRead', run: 'cat node_modules/left-pad/index.js' },
    { id: 'modulesWrite', run: `echo x > node_modules/${t}`, effect: () => existsSync(join(f.modules, t)) },
    { id: 'commonDir', run: `echo x > ${at(f.common, t)}`, effect: () => existsSync(join(f.common, t)) },
    // A hook or a config line there would run when Kernel, or the user, runs git outside the sandbox.
    { id: 'hooks', run: `echo x > ${at(f.common, 'hooks', t)}`, effect: () => existsSync(join(f.common, 'hooks', t)) },
    { id: 'config', run: `: >> ${at(f.common, 'config')}` },
    { id: 'unlisted', run: 'curl -sS -o /dev/null --max-time 15 https://example.com/' },
    { id: 'registry', run: 'curl -sS -o /dev/null --max-time 15 https://registry.npmjs.org/' },
    !!f.npmCache && { id: 'npmCache', run: `mkdir ${at(f.npmCache, t)} && rmdir ${at(f.npmCache, t)}` },
    // The token goes to /dev/null, so it never reaches the model or this test's output.
    f.ghKeychain && { id: 'ghKeychain', run: `${unsetGh} auth token > /dev/null` },
    f.ghKeychain && { id: 'ghApi', run: `${unsetGh} api /rate_limit --jq .resources.core.limit` },
    f.node && { id: 'bind', run: `node -e "require('net').createServer().listen(0, '127.0.0.1', function () { this.close() })"` }
  ]
  return list.filter((p): p is Probe => !!p)
}

async function fixture(): Promise<Fixture> {
  const root = await realpath(await mkdtemp(join(homedir(), '.kernel-sandbox-')))
  const repo = join(root, 'repo')
  const wt = join(root, 'wt')
  const outside = join(root, 'outside')
  await mkdir(join(repo, 'node_modules', 'left-pad'), { recursive: true })
  await mkdir(outside)
  await writeFile(join(repo, 'README.md'), '# spike\n')
  await writeFile(join(repo, '.gitignore'), 'node_modules\n')
  await writeFile(join(repo, 'node_modules', 'left-pad', 'index.js'), 'module.exports = 1\n')
  await run('git', ['init', '-q', '-b', 'main', repo])
  await git(repo, 'config', 'user.email', 't@t.dev')
  await git(repo, 'config', 'user.name', 'Test')
  await git(repo, 'add', '-A')
  await git(repo, 'commit', '-q', '-m', 'init')
  await git(repo, 'worktree', 'add', '-q', '-b', 'kernel/spike', wt)
  await linkNodeModules(repo, wt)
  const common = (await git(wt, 'rev-parse', '--path-format=absolute', '--git-common-dir')).trim()
  const cache = (await exec('npm', ['config', 'get', 'cache'])).stdout.trim()
  const env = { ...process.env, GH_TOKEN: '', GITHUB_TOKEN: '' }
  const gh = await exec('gh', ['auth', 'status'], { env })
  return {
    root, repo, wt, common, outside,
    modules: await realpath(join(wt, 'node_modules')),
    userTmp: await realpath(tmpdir()),
    npmCache: cache && existsSync(cache) ? await realpath(cache) : undefined,
    ghKeychain: gh.code === 0 && /\(keyring\)/.test(gh.stdout + gh.stderr),
    node: !!findOnPath('node'),
    tag: randomUUID().slice(0, 8)
  }
}

async function cleanUp(f: Fixture) {
  await rm(join(f.userTmp, `kernel-spike-${f.tag}`), { force: true })
  await rm(f.root, { recursive: true, force: true })
}

/** Each probe's verdict. A probe with an effect is judged by it, from outside the sandbox. The others by their exit code. */
async function judge(list: Probe[], codes: Record<string, { code: number }>): Promise<Verdicts> {
  const out: Verdicts = {}
  for (const p of list) {
    const code = codes[p.id]?.code
    out[p.id] = code === undefined || Number.isNaN(code) ? 'not run' : (p.effect ? await p.effect() : code === 0) ? 'allowed' : 'denied'
  }
  return out
}

const expected = (provider: 'claude' | 'codex', box: string, list: Probe[]) => Object.fromEntries(list.map((p) => [p.id, EXPECTED[provider][box][p.id]]))

/** What every probe did, saved to KERNEL_LIVE_OUT after each sandbox. */
const evidence: Record<string, unknown> = {}

async function save() {
  const file = process.env.KERNEL_LIVE_OUT
  if (file) await writeFile(file, JSON.stringify(evidence, null, 2))
}

describe.skipIf(!process.env.KERNEL_LIVE)('live sandbox in a worktree', () => {
  it('Codex workspace-write, bare and as Kernel sets it', { timeout: 300_000 }, async () => {
    const bin = bundledCodex()
    expect(bin, 'the pinned Codex binary').toBeTruthy()
    const got: Record<string, Verdicts> = {}
    const want: Record<string, Verdicts> = {}
    for (const box of ['bare', 'kernel']) {
      const f = await fixture()
      try {
        const list = probes(f)
        const policy = codexSandboxes(f)[box]
        const codes = await withCodex(bin!, undefined, async (rpc) => {
          const out: Record<string, { code: number; err: string }> = {}
          for (const p of list) {
            const r = await rpc.request<{ exitCode: number; stderr: string }>('command/exec', { command: ['/bin/bash', '-c', `(${p.run}) > /dev/null`], cwd: f.wt, sandboxPolicy: policy, timeoutMs: 30_000 }, { timeoutMs: 60_000 })
            out[p.id] = { code: r.exitCode, err: r.stderr.trim().slice(-300) }
          }
          return out
        }, { cwd: f.wt, timeoutMs: 240_000 })
        got[box] = await judge(list, codes)
        want[box] = expected('codex', box, list)
        evidence[`codex.${box}`] = { policy, codes, verdicts: got[box] }
        console.log(`[live] codex ${box} ${JSON.stringify(got[box])}`)
      } finally {
        await save()
        await cleanUp(f)
      }
    }
    expect(got).toEqual(want)
  })

  it('Claude sandbox in Bypass, bare and with what A10 adds', { timeout: 600_000 }, async () => {
    const got: Record<string, Verdicts> = {}
    const want: Record<string, Verdicts> = {}
    for (const box of ['bare', 'a10']) {
      const f = await fixture()
      try {
        const list = probes(f)
        const sandbox = claudeSandboxes(f)[box]
        await mkdir(join(f.wt, '.spike', 'out'), { recursive: true })
        await writeFile(join(f.wt, '.spike', 'probe.sh'), list.map((p) => `(${p.run}) > /dev/null 2> .spike/out/${p.id}.err; echo $? > .spike/out/${p.id}`).join('\n') + '\n')
        const calls: unknown[] = []
        let result: unknown
        const q = query({
          prompt: 'Run exactly `bash .spike/probe.sh` with the Bash tool, once. Some of its checks are meant to fail. Run nothing else, then reply with one word: done.',
          options: {
            cwd: f.wt, model: HAIKU, permissionMode: 'bypassPermissions', allowDangerouslySkipPermissions: true,
            settingSources: [], persistSession: false, tools: ['Bash'], maxTurns: 4, sandbox,
            env: sessionEnv(process.env, {}), pathToClaudeCodeExecutable: bundledClaude()
          }
        })
        for await (const m of q) {
          if (m.type === 'assistant') for (const b of m.message.content) if (b.type === 'tool_use') calls.push(b.input)
          if (m.type === 'result') result = { subtype: m.subtype, denials: m.permission_denials }
        }
        const codes: Record<string, { code: number; err: string }> = {}
        for (const p of list) {
          const code = await readFile(join(f.wt, '.spike', 'out', p.id), 'utf8').then((s) => Number(s.trim()), () => NaN)
          const err = await readFile(join(f.wt, '.spike', 'out', `${p.id}.err`), 'utf8').catch(() => '')
          codes[p.id] = { code, err: err.trim().slice(-300) }
        }
        got[box] = await judge(list, codes)
        want[box] = expected('claude', box, list)
        evidence[`claude.${box}`] = { sandbox, calls, result, codes, verdicts: got[box] }
        console.log(`[live] claude ${box} ${JSON.stringify(got[box])}, calls ${JSON.stringify(calls)}`)
      } finally {
        await save()
        await cleanUp(f)
      }
    }
    expect(got).toEqual(want)
  })
})
