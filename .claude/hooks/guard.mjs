// PreToolUse guard for the Kernel repo (D-023). Permission rules in
// .claude/settings.json can't express "outside this repo" or catch every
// spelling of a force push, so this script checks what they miss and denies it.
import { execFileSync } from 'node:child_process'
import { lstatSync, readFileSync, readlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

const input = JSON.parse(readFileSync(0, 'utf8'))
const home = homedir()
const root = real(path.resolve(process.env.CLAUDE_PROJECT_DIR || path.join(import.meta.dirname, '../..')))

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

// Walks the path one part at a time, following every symlink (dangling ones
// too) before it applies the next "..", the way the OS does. Parts that don't
// exist yet are kept as written, so new files still resolve and /tmp and
// /private/tmp compare equal.
function real(p, hops = 0) {
  const parts = p.split('/').filter((s) => s && s !== '.')
  let cur = '/'
  for (let i = 0; i < parts.length; i++) {
    if (parts[i] === '..') {
      cur = path.dirname(cur)
      continue
    }
    const next = path.join(cur, parts[i])
    let link = null
    try {
      if (lstatSync(next).isSymbolicLink()) link = readlinkSync(next)
    } catch {}
    if (link === null) {
      cur = next
      continue
    }
    if (hops >= 40) deny(`${p} has a symlink loop.`)
    const target = link.startsWith('/') ? link : `${cur}/${link}`
    return real([target, ...parts.slice(i + 1)].join('/'), hops + 1)
  }
  return cur
}

// Joins without collapsing "..", so real() can follow symlinks first.
function expand(p, cwd) {
  if (p === '~') return home
  if (p.startsWith('~/')) return `${home}/${p.slice(2)}`
  return path.isAbsolute(p) ? p : `${cwd}/${p}`
}

function inside(p) {
  const rel = path.relative(root, real(p))
  return !rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel)
}

// Plan mode writes its plan to ~/.claude/plans/<slug>.md, so a .md file
// directly in that folder is the one write allowed outside the repo. The
// plans folder itself is not followed: if it were a symlink to ~/.claude,
// CLAUDE.md would count as a plan.
function plan(p) {
  const file = real(p)
  return path.dirname(file) === path.join(real(`${home}/.claude`), 'plans') && file.endsWith('.md')
}

// The app's own data folder (settings.json, kernel.db). Agents building Kernel
// may read and change it (D-095). rm -r on it is still denied below.
function appData(p) {
  const rel = path.relative(real(`${home}/Library/Application Support/Kernel`), real(p))
  return !rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel)
}

const tool = input.tool_name
const args = input.tool_input ?? {}
const cwd0 = input.cwd || process.cwd()

if (['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(tool)) {
  const file = args.file_path ?? args.notebook_path
  if (file && !inside(expand(file, cwd0)) && !plan(expand(file, cwd0)) && !appData(expand(file, cwd0))) deny(`${file} is outside this repo.`)
  process.exit(0)
}

if (tool !== 'Bash') process.exit(0)

const command = String(args.command ?? '')

if (/\bKERNEL_LIVE=/.test(command)) deny('the live test (KERNEL_LIVE) needs a person.')
if (/\bgh\s+repo\s+(delete|edit)\b/.test(command)) deny('gh repo delete and gh repo edit are off limits.')
for (const h of ['~', '$HOME', '${HOME}', home]) {
  if (command.includes(`${h}/.claude/settings`)) deny('~/.claude/settings.json is off limits.')
}

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
