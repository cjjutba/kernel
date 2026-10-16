// The Other apps check (.github/workflows/other-apps.yml). The repo is public, so a design choice is described by its
// behavior and reason, never as copying or matching another app. Fails when a tracked file names Conductor, Superset
// or Orca outside the allowlist below. Run it locally with:
//   node scripts/other-apps-check.ts
import { execFileSync } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dirname, '..')
const NAMES = /conductor|superset|\borca\b/i

// Files that name the tools on purpose: the script-import feature reads their config, and published notes stay as written.
const ALLOWED = [
  'src/main/services/scriptImport.ts',
  'src/main/services/kernelMcp.ts',
  'src/main/features/setup.ts',
  'src/shared/ipc.ts',
  'src/shared/types/settings.ts',
  'test/scriptImport.test.ts',
  'test/projectScripts.test.ts',
  'test/setupScriptE2e.test.ts',
  'test/hookServer.test.ts',
  'test/integrationProjects.test.ts',
  'docs/HOOKS.md',
  'docs/decisions/KERNEL-682.md',
  'docs/decisions/KERNEL-683.md',
  '.conductor/**',
  '.changes/released/**',
  'site/content/releases/**',
  'scripts/other-apps-check.ts',
  '.github/workflows/other-apps.yml'
]

// A fixture line may name them only when it models an import: the tool's config paths, the suggestion source or the scene.
const FIXTURES = /^fixtures\/[^/]+\.ts$/
const IMPORT_LINE = /\.conductor\b|\.superset\b|conductor\.json|source: '(?:conductor|superset)'|WorkspaceSetupAddConductor/

const globToRegExp = (glob: string) => new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\u0000/g, '.*')}$`)
const allowed = ALLOWED.map(globToRegExp)

// --untracked also reads new files a PR adds, so a local run sees them before they are staged.
const out = execFileSync('git', ['grep', '--untracked', '-n', '-I', '-i', '-E', 'conductor|superset|orca'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).split('\n')

const hits: string[] = []
for (const row of out) {
  const m = /^([^:]+):(\d+):(.*)$/.exec(row)
  if (!m) continue
  const [, file = '', line = '', text = ''] = m
  if (!NAMES.test(text) || allowed.some((re) => re.test(file))) continue
  if (FIXTURES.test(file) && IMPORT_LINE.test(text)) continue
  hits.push(`${file}:${line}: ${text.trim().slice(0, 160)}`)
}

if (hits.length) {
  const details = [
    'These lines name another app (Conductor, Superset or Orca):',
    ...hits.map((h) => `  ${h}`),
    '',
    'Kernel is public. Describe the behavior and the reason for it instead of naming another app.',
    'If the file is part of the script-import feature, add it to ALLOWED in scripts/other-apps-check.ts (AGENTS.md, Rules).'
  ].join('\n')
  console.log(`::error title=Other apps::${hits.length} line${hits.length === 1 ? '' : 's'} name another app.`)
  console.error(`\n${details}\n`)
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Other apps\n\n\`\`\`\n${details}\n\`\`\`\n`)
  process.exit(1)
}
console.log('Other apps: ok. No line names Conductor, Superset or Orca outside the allowlist.')
