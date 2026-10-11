import { readFile, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import type { InstructionConflict, InstructionConflictKind } from '@shared/types'

/**
 * Rules in a repo's CLAUDE.md and AGENTS.md that fight how Kernel works (KERNEL-452). Agents read those files next to
 * Kernel's own rules, so "commit straight to main" pulls them the other way. Room setup lists each rule next to what Kernel
 * tells agents. Kernel only reads the files.
 *
 * The matcher is narrow on purpose: a false alarm teaches the user to ignore the list. Most rules that name main agree with
 * Kernel ("never commit to main", "rebase onto origin/main", "don't run git pull in the main checkout"). So a line counts
 * only when the clause tells the agent to do it, with no negation or condition before it, and the branch ends the clause.
 */

/** The files Claude Code and Codex read at a repo's root, in the order Room setup lists them. */
export const INSTRUCTION_FILES = ['CLAUDE.md', '.claude/CLAUDE.md', 'AGENTS.md']

/** A line longer than this is quoted by the sentence that fights, not whole. */
const LONG_LINE = 200

export interface ScanOptions {
  /** The room's default branch and the protected ones, which Kernel's agents never commit or push to. */
  branches: string[]
  /** Where teammates' worktrees start, `origin/main`, for what Kernel says to stacked PRs. */
  base: string
}

/** What Kernel tells agents instead, in RoomSetupConflicts.png's words. */
export function kernelSays(kind: InstructionConflictKind, base: string): string {
  if (kind === 'no-pull-requests') return 'Every task ends in a pull request. Never push to a shared branch.'
  if (kind === 'push-to-protected') return 'Push your own branch and open a pull request.'
  if (kind === 'stacked-prs') return `Start from ${base}. One task, one branch, one pull request.`
  return 'Work on your own branch and open a pull request.'
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// The verb starts its clause, after nothing but words that keep it an instruction: "Commit", "Always commit", "You can
// commit", "Feel free to commit". "Every push to main", "Only maintainers push to main" and "Before you push to main" don't.
const LEAD = String.raw`(?<=(?:^|[.;:!?,(]\s*|\s[-–—]\s)(?:(?:please|always|just|simply|then|also|and|so|you|we|agents?|claude|codex|can|may|should|must|will|could|feel free to|go ahead and|(?:it['’]?s\s+)?(?:fine|ok|okay)\s+to)\s+)*)`
// What may sit between the verb and "to main": "commit your changes to main", "push the fix straight to main".
const OBJ = String.raw`(?:\s+(?:your|the|all|any|its|it|them|these|small|minor|quick|changes?|work|code|edits?|fix|fixes|everything|commits?|updates?|branch))*`
const ADV = String.raw`(?:straight|directly|right)`
const TO = String.raw`\s+(?:${ADV}\s+)?(?:to|on|onto|into)\s+`
// The branch ends its clause, so "the main checkout", "main process" and "mainline" are not branches.
const END = String.raw`(?=\s*(?:$|[.,;:!?)])|\s+[-–—]\s|\s+(?:directly|straight|only|and|or|when|whenever|once|unless|for|so|instead|without|then|after|before|too|as|if|with|every|each|on|to|please)\b)`
const PRS = String.raw`(?:pull requests?|PRs?)`
// "No PRs." ends there. "Don't open a PR until tests pass" is about when, not whether.
const DONE = String.raw`(?=\s*(?:$|[.,;:!?)])|\s+(?:at all|ever|here|in this repo)\b)`
const NOT_PART = String.raw`(?![\w-]|\s+(?:template|description|checklist|reviews?|title|body|checks?|labels?|step|number|link)\b)`
const DONT = String.raw`(?:never|don['’]?t|do not)\s+(?:ever\s+)?`
const CLAUSE_START = String.raw`(?<=(?:^|[.;:!?,(]\s*))`

const NEGATION = /\b(?:never|not|no|nothing|nobody|no one|don['’]?t|do not|doesn['’]?t|does not|didn['’]?t|isn['’]?t|aren['’]?t|shouldn['’]?t|mustn['’]?t|can['’]?t|cannot|won['’]?t|avoid|avoiding|stop|forbidden|prohibited|disallowed|blocked|instead of)\b/i
const CONDITION = /\b(?:if|when|whenever|before|after|once|until|unless|while|only)\b/i
const PAST = /\b(?:used to|no longer|any ?more)\b/i

function patterns(branches: string[]): { kind: InstructionConflictKind; re: RegExp }[] {
  const names = [...new Set(branches.map((b) => b.trim()).filter(Boolean))].map(esc)
  const named = names.length ? [String.raw`[\`'"]?(?:origin/|upstream/)?(?:${names.join('|')})[\`'"]?(?:\s+branch)?`] : []
  const BR = String.raw`(?:the\s+)?(?:${[...named, 'default branch', 'trunk', 'shared branch'].join('|')})`
  const list: [InstructionConflictKind, string][] = [
    ['commit-to-main', String.raw`${LEAD}\bcommit(?:\s+(?:and|&)\s+push)?${OBJ}${TO}${BR}${END}`],
    ['commit-to-main', String.raw`${LEAD}\b(?:work|develop)(?:\s+${ADV})?\s+(?:on|in)\s+${BR}${END}`],
    ['commit-to-main', String.raw`\bcommitted\s+${ADV}\s+(?:to|on|onto|into)\s+${BR}${END}`],
    ['push-to-protected', String.raw`${LEAD}\bpush${OBJ}${TO}${BR}${END}`],
    ['push-to-protected', String.raw`\bpushed\s+${ADV}\s+(?:to|onto|into)\s+${BR}${END}`],
    ['no-pull-requests', String.raw`${LEAD}${DONT}(?:open|create|make|file|raise|submit|send|use)\s+(?:a\s+|any\s+)?${PRS}${DONE}`],
    ['no-pull-requests', String.raw`${CLAUSE_START}no\s+${PRS}(?:${DONE}|(?=\s+(?:needed|required|necessary)\b))`],
    ['no-pull-requests', String.raw`${LEAD}\bskip\s+(?:the\s+|a\s+)?${PRS}${NOT_PART}`],
    ['no-pull-requests', String.raw`${LEAD}\b(?:merge|ship|land|commit|push)\b[^.;:!?]*?\bwithout\s+(?:opening\s+|creating\s+)?(?:a\s+|any\s+)?${PRS}${DONE}`],
    ['no-pull-requests', String.raw`${CLAUSE_START}${PRS}\s+(?:are|is)\s+(?:not\s+(?:needed|required|necessary|used)|unnecessary|optional)\b`],
    ['no-branches', String.raw`${LEAD}${DONT}(?:create|make|open|use|cut|start)\s+(?:a\s+|any\s+)?(?:(?:new|feature|separate|topic|git)\s+)*branch(?:es)?${DONE}`],
    // "Stack PRs", "We stack PRs", "Use stacked PRs". "Stacked PRs" as a subject is about them, as in "Stacked PRs: avoid them".
    ['stacked-prs', String.raw`${LEAD}(?:\bstack\s+(?:(?:your|the|small)\s+)?|\b(?:use|prefer|open|create|make|send|submit|write)\s+(?:a\s+)?stacked[\s-]+)(?:pull requests?|PRs?|branches|diffs)\b`],
    ['stacked-prs', String.raw`\b(?:each|every)\s+(?:branch|PR|pull request)\s+(?:builds|is based|sits|stacks|starts|branches off)\s+(?:on top of|on|from|off)\s+(?:the\s+)?(?:one\s+before|previous|last|prior|earlier)\b`],
    ['stacked-prs', String.raw`${LEAD}\bbranch\s+(?:off|from)\s+(?:of\s+)?(?:the\s+|your\s+)?(?:previous|prior|last|earlier)\s+(?:PR|pull request|branch|task)\b`]
  ]
  return list.map(([kind, source]) => ({ kind, re: new RegExp(source, 'gi') }))
}

/** Where the sentence around `[from, to)` starts and ends. A sentence ends at `.`, `!`, `?` or `;` before a space. */
function sentence(line: string, from: number, to: number) {
  const before = line.slice(0, from)
  const stops = [...before.matchAll(/[.!?;](?=\s)/g)]
  const start = stops.length ? stops[stops.length - 1].index! + 1 : 0
  const next = /[.!?;](?=\s|$)/.exec(line.slice(to))
  return { start, end: next ? to + next.index + 1 : line.length }
}

/**
 * No negation in the sentence before the match or in the rest of its clause, and no condition in the clause before it.
 * The rest of the clause runs past a colon, which gives the verdict ("Commit to main: never"), and a question takes its
 * answer with it ("Commit to main? Never."). "Only" after it makes the rule an exception ("work in main only if the user
 * asks"), which Kernel has room for, and a habit the repo dropped ("we used to stack PRs, but no longer") is no rule.
 */
function stands(line: string, from: number, to: number): boolean {
  const { start, end } = sentence(line, from, to)
  const answered = line[end - 1] === '?' ? sentence(line, end, end).end : end
  const before = line.slice(start, from)
  const clauseBefore = before.slice(Math.max(before.lastIndexOf(','), before.lastIndexOf(':')) + 1)
  const after = line.slice(to, answered).split(/,|\bbut\b/)[0]
  return !NEGATION.test(before) && !NEGATION.test(after) && !CONDITION.test(clauseBefore) && !/\bonly\b/i.test(after) && !PAST.test(line.slice(start, answered))
}

/** The line as a person reads it: no quote, heading or list marker, no bold or italics. */
const clean = (line: string) => line
  .replace(/^\s*(?:>\s*)*/, '')
  .replace(/^#{1,6}\s+/, '')
  .replace(/^(?:[-*+]|\d+[.)])\s+/, '')
  .replace(/^\[[ xX]\]\s+/, '')
  .replace(/\*\*|__/g, '')
  .replace(/(?<![\w*])[*_](?=\S)([^*_]+?)(?<=\S)[*_](?![\w*])/g, '$1')
  .replace(/\s+/g, ' ')
  .trim()

/** The rules in one file's `text` that fight Kernel's workflow, one per line at most. Code blocks and HTML comments are skipped. */
export function findConflicts(text: string, file: string, o: ScanOptions): InstructionConflict[] {
  const res = patterns(o.branches)
  const out: InstructionConflict[] = []
  let fence: string | undefined
  let comment = false
  text.split(/\r?\n/).forEach((raw, i) => {
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(raw)?.[1]
    if (fence) { if (marker && marker[0] === fence[0] && marker.length >= fence.length) fence = undefined; return }
    if (marker) { fence = marker; return }
    let rest = raw
    if (comment) { const close = rest.indexOf('-->'); if (close < 0) return; comment = false; rest = rest.slice(close + 3) }
    rest = rest.replace(/<!--.*?-->/g, '')
    const open = rest.indexOf('<!--')
    if (open >= 0) { comment = true; rest = rest.slice(0, open) }
    const line = clean(rest)
    if (!line) return
    let hit: { kind: InstructionConflictKind; from: number; to: number } | undefined
    for (const { kind, re } of res) {
      for (const m of line.matchAll(re)) {
        const from = m.index!
        const to = from + m[0].length
        if ((!hit || from < hit.from) && stands(line, from, to)) hit = { kind, from, to }
      }
    }
    if (!hit) return
    const { start, end } = sentence(line, hit.from, hit.to)
    const quote = line.length > LONG_LINE ? line.slice(start, end).trim() : line
    out.push({ kind: hit.kind, text: quote, file, line: i + 1, kernel: kernelSays(hit.kind, o.base) })
  })
  return out
}

/**
 * Reads the repo's instruction files at `root` and returns their conflicts, file by file. A missing or unreadable file has
 * none, and a file that is a link to one already read (CLAUDE.md to AGENTS.md, say) isn't listed twice.
 */
export async function scanInstructions(root: string, o: ScanOptions): Promise<InstructionConflict[]> {
  const seen = new Set<string>()
  const out: InstructionConflict[] = []
  for (const file of INSTRUCTION_FILES) {
    const path = join(root, file)
    const real = await realpath(path).catch(() => undefined)
    if (!real || seen.has(real)) continue
    seen.add(real)
    const text = await readFile(real, 'utf8').catch(() => undefined)
    if (text !== undefined) out.push(...findConflicts(text, file, o))
  }
  return out
}
