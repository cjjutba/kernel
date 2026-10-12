// Regenerates src/main/services/providers/codex/protocol from the pinned Codex (KERNEL-406).
//
//   node scripts/codex-protocol.mjs
//
// `codex app-server generate-ts --experimental` writes the whole protocol, about 800 files. Kernel keeps only the types it
// uses and everything they import, so a Codex bump shows up as a readable diff. Add a root below when the runner needs a
// new message, then run this again.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, normalize, relative } from 'node:path'

const root = join(import.meta.dirname, '..')
const out = join(root, 'src', 'main', 'services', 'providers', 'codex', 'protocol')
const ROOTS = [
  'InitializeParams', 'InitializeResponse',
  'v2/ThreadStartParams', 'v2/ThreadStartResponse', 'v2/ThreadResumeParams', 'v2/ThreadResumeResponse', 'v2/ThreadForkParams', 'v2/ThreadForkResponse',
  'v2/ThreadCompactStartParams', 'v2/TurnStartParams', 'v2/TurnStartResponse', 'v2/TurnInterruptParams',
  'v2/ThreadItem', 'v2/ItemStartedNotification', 'v2/ItemCompletedNotification', 'v2/TurnStartedNotification', 'v2/TurnCompletedNotification',
  'v2/ErrorNotification', 'v2/ThreadTokenUsageUpdatedNotification',
  'v2/CommandExecutionRequestApprovalParams', 'v2/CommandExecutionRequestApprovalResponse',
  'v2/FileChangeRequestApprovalParams', 'v2/FileChangeRequestApprovalResponse',
  'v2/PermissionsRequestApprovalParams', 'v2/PermissionsRequestApprovalResponse',
  'v2/ToolRequestUserInputParams', 'v2/ToolRequestUserInputResponse',
  'v2/DynamicToolSpec', 'v2/DynamicToolCallParams', 'v2/DynamicToolCallResponse',
  'v2/GetAccountParams', 'v2/GetAccountResponse', 'v2/GetAccountRateLimitsResponse', 'v2/AccountRateLimitsUpdatedNotification',
  'v2/LoginAccountParams', 'v2/LoginAccountResponse', 'v2/AccountLoginCompletedNotification',
  'v2/ModelListParams', 'v2/ModelListResponse',
  'v2/ConfigReadParams', 'v2/ConfigReadResponse',
  'v2/McpServerStatusUpdatedNotification'
]

const pkg = createRequire(import.meta.url).resolve('@openai/codex/package.json')
const platform = createRequire(pkg).resolve(`@openai/codex-${process.platform}-${process.arch}/package.json`)
const codex = join(dirname(platform), 'vendor', `${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}-apple-darwin`, 'bin', 'codex')
const version = execFileSync(codex, ['--version'], { encoding: 'utf8' }).trim()
const tmp = mkdtempSync(join(tmpdir(), 'codex-protocol-'))
try {
  execFileSync(codex, ['app-server', 'generate-ts', '--experimental', '--out', tmp], { stdio: 'ignore' })
  const keep = new Set()
  const visit = (name) => {
    const file = normalize(name) + '.ts'
    if (keep.has(file)) return
    if (!existsSync(join(tmp, file))) throw new Error(`${version} has no ${file}`)
    keep.add(file)
    const text = readFileSync(join(tmp, file), 'utf8')
    for (const m of text.matchAll(/from "(\.{1,2}\/[^"]+)"/g)) visit(join(dirname(file), m[1]))
  }
  ROOTS.forEach(visit)
  rmSync(out, { recursive: true, force: true })
  for (const file of [...keep].sort()) {
    mkdirSync(dirname(join(out, file)), { recursive: true })
    writeFileSync(join(out, file), readFileSync(join(tmp, file), 'utf8'))
  }
  writeFileSync(join(out, 'VERSION'), `${version}\n`)
  console.log(`${keep.size} files from ${version} in ${relative(root, out)}`)
} finally {
  rmSync(tmp, { recursive: true, force: true })
}
