// PreToolUse guard for the Kernel repo (D-023). Permission rules in
// .claude/settings.json can't express "outside this repo" or catch every
// spelling of a force push, so this script checks what they miss and denies it.
import { execFileSync } from 'node:child_process'
import { readFileSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

const input = JSON.parse(readFileSync(0, 'utf8'))
const home = homedir()
const root = real(process.env.CLAUDE_PROJECT_DIR || path.resolve(import.meta.dirname, '../..'))

function deny(reason) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: `Kernel guard: ${reason} See docs/AUTOPILOT.md.`
      }
    })
  )
  process.exit(0)
}

// Resolves symlinks on the longest prefix that exists, so /tmp and
// /private/tmp compare equal and new files still resolve.
function real(p) {
  let cur = path.resolve(p)
  const rest = []
  for (;;) {
    try {
      return path.join(realpathSync(cur), ...rest.reverse())
    } catch {}
    const parent = path.dirname(cur)
    if (parent === cur) return path.resolve(p)
    rest.push(path.basename(cur))
    cur = parent
  }
}

function expand(p, cwd) {
  if (p === '~') return home
  if (p.startsWith('~/')) return path.join(home, p.slice(2))
  return path.resolve(cwd, p)
}

function inside(p) {
  const rel = path.relative(root, real(p))
  return !rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel)
}

const tool = input.tool_name
const args = input.tool_input ?? {}
const cwd0 = input.cwd || process.cwd()

if (['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(tool)) {
  const file = args.file_path ?? args.notebook_path
  if (file && !inside(expand(file, cwd0))) deny(`${file} is outside this repo.`)
  process.exit(0)
}

if (tool !== 'Bash') process.exit(0)

const command = String(args.command ?? '')

if (/\bKERNEL_LIVE=/.test(command)) deny('the live test (KERNEL_LIVE) needs CJ.')
if (/\bgh\s+repo\s+(delete|edit)\b/.test(command)) deny('gh repo delete and gh repo edit are off limits.')
for (const h of ['~', '$HOME', '${HOME}', home]) {
  if (command.includes(`${h}/.claude/settings`)) deny('~/.claude/settings.json is off limits.')
}
if (/Application(\\ | )Support\/Kernel/.test(command)) deny('~/Library/Application Support/Kernel is off limits.')

function currentBranch(dir) {
  try {
    return execFileSync('git', ['-C', dir, 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' }).trim()
  } catch {
    return ''
  }
}

function checkPush(words, cwd) {
  const at = words.indexOf('push')
  if (at < 0) return
  const rest = words.slice(at + 1)
  const positional = []
  for (const w of rest) {
    if (w === '--force' || w.startsWith('--force-') || /^-[a-zA-Z]*f[a-zA-Z]*$/.test(w)) deny('force pushes are off limits.')
    if (w === '--mirror' || w === '--all') deny(`git push ${w} is off limits.`)
    if (!w.startsWith('-')) positional.push(w)
  }
  const refspecs = positional.slice(1)
  if (refspecs.some((r) => r.startsWith('+'))) deny('force pushes (+refspec) are off limits.')
  const toMain = (r) => r === 'main' || r.endsWith(':main') || r.endsWith('refs/heads/main')
  if (refspecs.some(toMain)) deny('pushing to main is off limits. Merge through a PR.')
  const onMain = currentBranch(cwd) === 'main'
  if (onMain && (refspecs.length === 0 || refspecs.includes('HEAD'))) {
    deny('pushing to main is off limits. Merge through a PR.')
  }
}

function checkRm(words, cwd) {
  const flags = []
  const targets = []
  let endOfFlags = false
  for (const w of words.slice(1)) {
    if (!endOfFlags && w === '--') endOfFlags = true
    else if (!endOfFlags && w.startsWith('-')) flags.push(w)
    else targets.push(w)
  }
  const recursive = flags.some((f) => f === '--recursive' || (/^-[a-zA-Z]+$/.test(f) && /[rR]/.test(f)))
  if (!recursive) return
  for (const t of targets) {
    if (/[$`]/.test(t)) deny(`rm -r on ${t} can't be checked. Use a plain path inside this repo.`)
    // For a glob, check the folder it expands inside.
    const glob = t.search(/[*?[]/)
    let base = glob < 0 ? t : t.slice(0, glob)
    if (glob >= 0 && !base.endsWith('/')) base = path.dirname(base || '.')
    const target = real(expand(base || '.', cwd))
    if (!inside(target)) deny(`rm -r on ${t} reaches outside this repo.`)
    if (target === root || target === path.join(root, '.git')) deny(`rm -r on ${t} would delete the repo.`)
  }
}

// Split on control operators and walk the pieces in order, following cd.
let cwd = cwd0
for (const piece of command.split(/&&|\|\||[;|\n]/)) {
  let words = piece.trim().split(/\s+/).filter(Boolean).map((w) => w.replace(/^['"]|['"]$/g, ''))
  while (words.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]) || ['env', 'command', 'sudo', 'exec'].includes(words[0]))) {
    words = words.slice(1)
  }
  if (!words.length) continue
  if (words[0] === 'cd') {
    cwd = words[1] && words[1] !== '-' ? expand(words[1], cwd) : home
    continue
  }
  if (words[0] === 'git') checkPush(words, cwd)
  if (words[0] === 'rm') checkRm(words, cwd)
}

process.exit(0)
