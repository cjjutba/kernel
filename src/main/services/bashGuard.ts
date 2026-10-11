import type { PermissionUpdate } from '@anthropic-ai/claude-agent-sdk'

// The Bash guard: what Kernel says about a command before Claude Code runs it (D-016). Never allow, the room's Always allow
// rules, then Always ask, plus the protected-branch and network checks. It reads a command the way a shell does (KERNEL-230),
// so quotes, wrappers, aliases and flag order don't change the answer. It is a guard for the forms an agent actually writes,
// not a sandbox.

export type BashVerdict = 'deny' | 'allow' | 'ask' | undefined

// ---------------------------------------------------------------------------------------------------------------------
// Reading a command

/** One simple command: the words of a command, with what the shell does around them. */
export interface Simple {
  /** The words as the shell passes them, with quotes and escapes taken off. A word with an expansion keeps its source text (`$b`). */
  words: string[]
  /** Per word: it holds `$VAR`, `${…}`, `$((…))`, a command substitution or a brace list, so its value is only known when it runs. */
  dynamic: boolean[]
  /** The redirections, as their operators: `>`, `>>`, `2>`, `<`, `&>`, `<<<`. */
  redirects: string[]
  /** It has `<( )` or `>( )`. */
  procSub: boolean
  /** It has `<<` or `<<-`. */
  heredoc: boolean
  /** Kernel can't tell what this runs: `eval`, a command word that is an expansion, or text the reader couldn't finish. */
  unknown: boolean
}

const blank = (): Simple => ({ words: [], dynamic: [], redirects: [], procSub: false, heredoc: false, unknown: false })

interface Word { text: string; dynamic: boolean; quoted: boolean; glob: boolean }

/** How deep substitutions and nested shells may go before the reader gives up and marks the rest unknown. */
const MAX_DEPTH = 16
const STOP = new Set([' ', '\t', '\r', '\n', ';', '&', '|', '(', ')', '<', '>'])
const isDigit = (c: string | undefined) => c !== undefined && c >= '0' && c <= '9'
const quote = (w: string) => (/^[\w@%+=:,./-]+$/.test(w) ? w : `'${w.replace(/'/g, `'\\''`)}'`)

class Reader {
  i = 0
  readonly result: Simple[] = []
  /** The command has an operator: `;`, `&&`, `||`, `|`, `&`, a newline or a group. */
  chained = false
  /** The command has a pipe, `|` or `|&`. */
  piped = false
  /** The command's tokens, for comparing two spellings of the same command. */
  readonly canon: string[] = []
  /** Cleared by anything whose meaning isn't in its text: an expansion, a glob, a heredoc. */
  canonOk = true
  private broken = false
  private nest = 0
  private heredocs: { delim: string; strip: boolean; quoted: boolean }[] = []
  /** The text of every heredoc body. Data, unless a shell reads it (`bash <<EOF`), which `analyze` checks. */
  readonly bodies: string[] = []

  constructor(private readonly s: string, private readonly depth = 0) {}

  run(): this { this.list(false); return this }

  /** Reads commands up to the end, or up to the `)` that closes a substitution when `inner`. True when it found that `)`. */
  private list(inner: boolean): boolean {
    const s = this.s
    let cur = blank()
    let parens = 0
    // A `case` pattern ends in `)` too, which must not close the substitution it sits in: `$(case x in x) git status;; esac)`.
    let cases = 0
    let pattern = false
    const flush = () => {
      if (cur.words[0] === 'case' && cur.words.includes('in')) { cases++; pattern = true }
      else if (cur.words[0] === 'esac') { cases = Math.max(0, cases - 1); pattern = false }
      if (cur.words.length || cur.redirects.length || cur.procSub || cur.heredoc) this.result.push(cur)
      cur = blank()
    }
    while (this.i < s.length) {
      const c = s[this.i]
      if (c === ' ' || c === '\t' || c === '\r') { this.i++; continue }
      if (c === '\\' && s[this.i + 1] === '\n') { this.i += 2; continue }
      if (c === '\n') { flush(); this.operator(';'); this.i++; this.readHeredocs(); continue }
      if (c === '#') { while (this.i < s.length && s[this.i] !== '\n') this.i++; continue }
      if (c === ';') {
        flush(); this.operator(';')
        if (cases > 0 && s[this.i + 1] === ';') pattern = true
        this.i++
        continue
      }
      if (c === '&') {
        if (s[this.i + 1] === '>') { this.redirect(cur, ''); continue }
        const two = s[this.i + 1] === '&'
        flush(); this.operator(two ? '&&' : '&'); this.i += two ? 2 : 1
        continue
      }
      if (c === '|') {
        const two = s[this.i + 1] === '|' || s[this.i + 1] === '&'
        flush(); this.operator(two ? s.slice(this.i, this.i + 2) : '|'); this.i += two ? 2 : 1
        continue
      }
      if (c === '(') { flush(); parens++; this.operator('('); this.i++; continue }
      if (c === ')') {
        const first = cur.words[0]
        const opens = first === 'case' && cur.words.includes('in')
        // The pattern is in this command when words follow `in`, or in the next one.
        const patternRead = opens && cur.words.length > cur.words.indexOf('in') + 1
        const wasPattern = pattern
        flush()
        if (patternRead || (!opens && first !== 'esac' && wasPattern && cases > 0)) { pattern = false; this.operator(')'); this.i++; continue }
        if (parens === 0 && inner) { this.i++; return true }
        parens = Math.max(0, parens - 1)
        this.operator(')'); this.i++
        continue
      }
      if (c === '<' || c === '>') {
        if (s[this.i + 1] === '(') this.procSub(cur)
        else this.redirect(cur, '')
        continue
      }
      if (isDigit(c)) {
        let j = this.i
        while (isDigit(s[j])) j++
        if ((s[j] === '<' || s[j] === '>') && s[j + 1] !== '(') { const fd = s.slice(this.i, j); this.i = j; this.redirect(cur, fd); continue }
      }
      this.addWord(cur, this.word())
    }
    // A substitution that never closed, or text that gave up on its depth, can't be trusted.
    if (inner || this.broken) cur.unknown = true
    this.broken = false
    flush()
    return false
  }

  private operator(op: string) {
    this.chained = true
    if (op === '|' || op === '|&') this.piped = true
    if (op === ';' && this.canon[this.canon.length - 1] === ';') return
    this.canon.push(op)
  }

  private addWord(cur: Simple, w: Word) {
    cur.words.push(w.text)
    cur.dynamic.push(w.dynamic)
    this.canonWord(w)
    if (this.broken) { cur.unknown = true; this.broken = false }
  }

  private canonWord(w: Word) {
    if (w.dynamic || w.glob) this.canonOk = false
    this.canon.push(quote(w.text))
  }

  /** `>`, `>>`, `<`, `2>`, `&>`, `<<<` and the rest, with their target word. A heredoc's body is read at the next newline. */
  private redirect(cur: Simple, fd: string) {
    const s = this.s
    const at = this.i
    const op = s[at] === '&' ? (s.startsWith('&>>', at) ? '&>>' : '&>')
      : s[at] === '>' ? ['>>', '>|', '>&'].find((o) => s.startsWith(o, at)) ?? '>'
      : ['<<<', '<<-', '<<', '<&', '<>'].find((o) => s.startsWith(o, at)) ?? '<'
    this.i += op.length
    cur.redirects.push(fd + op)
    this.canon.push(fd + op)
    while (s[this.i] === ' ' || s[this.i] === '\t') this.i++
    const next = s[this.i]
    if (next === undefined) return
    if ((next === '<' || next === '>') && s[this.i + 1] === '(') { this.procSub(cur); return }
    if (STOP.has(next)) return
    const w = this.word()
    if (op === '<<' || op === '<<-') {
      this.heredocs.push({ delim: w.text, strip: op === '<<-', quoted: w.quoted })
      cur.heredoc = true
      this.canonOk = false
    } else this.canonWord(w)
    if (this.broken) { cur.unknown = true; this.broken = false }
  }

  /** `<( )` and `>( )`: the inside runs as its own commands, and the outside sees a file name. */
  private procSub(cur: Simple) {
    const start = this.i
    this.i += 2
    if (!this.descend(() => this.list(true))) this.broken = true
    cur.procSub = true
    cur.words.push(this.s.slice(start, this.i))
    cur.dynamic.push(true)
    this.canonOk = false
  }

  /** Reads a substitution's inside with `read`. False when it never closed, or when it is nested too deep to read. */
  private descend(read: () => boolean): boolean {
    if (this.depth + this.nest >= MAX_DEPTH) { this.i = this.s.length; return false }
    this.nest++
    try { return read() } finally { this.nest-- }
  }

  /** The bodies of the heredocs started on the line that just ended. Data, except for the substitutions an unquoted one runs. */
  private readHeredocs() {
    const s = this.s
    for (const h of this.heredocs.splice(0)) {
      const lines: string[] = []
      while (this.i < s.length) {
        const nl = s.indexOf('\n', this.i)
        const line = s.slice(this.i, nl < 0 ? s.length : nl)
        this.i = nl < 0 ? s.length : nl + 1
        if ((h.strip ? line.replace(/^\t+/, '') : line) === h.delim) break
        lines.push(line)
      }
      this.bodies.push(lines.join('\n'))
      if (!h.quoted && lines.length) this.substitutions(lines.join('\n'))
    }
  }

  private word(): Word {
    const s = this.s
    let text = ''
    // The unquoted text, with every quoted or expanded character as a NUL, to tell a glob or a brace list from a quoted one.
    let plain = ''
    let dynamic = false
    let quoted = false
    while (this.i < s.length) {
      const c = s[this.i]
      if (STOP.has(c)) break
      if (c === '\\') {
        const n = s[this.i + 1]
        if (n === '\n') { this.i += 2; continue }
        quoted = true
        text += n ?? '\\'
        plain += '\0'
        this.i += n === undefined ? 1 : 2
        continue
      }
      if (c === "'") {
        quoted = true
        const end = s.indexOf("'", this.i + 1)
        text += s.slice(this.i + 1, end < 0 ? s.length : end)
        plain += '\0'
        if (end < 0) this.broken = true
        this.i = end < 0 ? s.length : end + 1
        continue
      }
      if (c === '"') {
        quoted = true
        this.i++
        const r = this.dquote(true)
        text += r.text
        dynamic ||= r.dynamic
        plain += '\0'
        continue
      }
      if (c === '$') {
        const r = this.dollar(false)
        text += r.text
        dynamic ||= r.dynamic
        plain += '\0'
        continue
      }
      if (c === '`') { text += this.backtick(); dynamic = true; plain += '\0'; continue }
      text += c
      plain += c
      this.i++
    }
    if (/\{[^{}]*(?:,|\.\.)[^{}]*\}/.test(plain)) dynamic = true
    return { text, dynamic, quoted, glob: /[*?[]/.test(plain) || plain.startsWith('~') }
  }

  /** The inside of `"…"`, after the opening quote. `untilQuote` false reads to the end, as a heredoc body or `${…}` is read. */
  private dquote(untilQuote: boolean): { text: string; dynamic: boolean } {
    const s = this.s
    let text = ''
    let dynamic = false
    while (this.i < s.length) {
      const c = s[this.i]
      if (c === '"' && untilQuote) { this.i++; return { text, dynamic } }
      if (c === '\\') {
        const n = s[this.i + 1]
        if (n === '\n') { this.i += 2; continue }
        if (n === '$' || n === '`' || n === '"' || n === '\\') { text += n; this.i += 2; continue }
        text += '\\'
        this.i++
        continue
      }
      if (c === '$') { const r = this.dollar(true); text += r.text; dynamic ||= r.dynamic; continue }
      if (c === '`') { text += this.backtick(); dynamic = true; continue }
      text += c
      this.i++
    }
    if (untilQuote) this.broken = true
    return { text, dynamic }
  }

  /** What starts with `$` at the current position: a variable, `${…}`, `$((…))`, `$(…)`, `$'…'` or a lone `$`. */
  private dollar(inQuotes: boolean): { text: string; dynamic: boolean } {
    const s = this.s
    const at = this.i
    const n = s[at + 1]
    if (n === '(') {
      if (s[at + 2] === '(') {
        const end = this.arith(at + 3)
        if (end >= 0) {
          this.substitutions(s.slice(at + 3, end - 2))
          this.i = end
          return { text: s.slice(at, end), dynamic: true }
        }
      }
      this.i = at + 2
      if (!this.descend(() => this.list(true))) this.broken = true
      return { text: s.slice(at, this.i), dynamic: true }
    }
    if (n === '{') {
      const end = this.brace(at + 2)
      if (end < 0) { this.i = s.length; this.broken = true; return { text: s.slice(at), dynamic: true } }
      this.substitutions(s.slice(at + 2, end - 1))
      this.i = end
      return { text: s.slice(at, end), dynamic: true }
    }
    if (n === "'" && !inQuotes) return this.ansi(at)
    // `$"…"` is `"…"` with a translation, so the quote that follows reads it.
    if (n === '"' && !inQuotes) { this.i = at + 1; return { text: '', dynamic: false } }
    if (n !== undefined && /[A-Za-z_]/.test(n)) {
      let j = at + 2
      while (j < s.length && /\w/.test(s[j])) j++
      this.i = j
      return { text: s.slice(at, j), dynamic: true }
    }
    if (n !== undefined && /[0-9@*#?$!-]/.test(n)) { this.i = at + 2; return { text: s.slice(at, at + 2), dynamic: true } }
    this.i = at + 1
    return { text: '$', dynamic: false }
  }

  /** `$'…'`, which the shell reads with C escapes. */
  private ansi(at: number): { text: string; dynamic: boolean } {
    const s = this.s
    const plain: Record<string, string> = { n: '\n', t: '\t', r: '\r', a: '\x07', b: '\b', e: '\x1b', E: '\x1b', f: '\f', v: '\v', '\\': '\\', "'": "'", '"': '"', '?': '?' }
    let j = at + 2
    let text = ''
    while (j < s.length && s[j] !== "'") {
      if (s[j] !== '\\' || j + 1 >= s.length) { text += s[j++]; continue }
      const e = s[j + 1]
      if (e in plain) { text += plain[e]; j += 2; continue }
      const num = /^(?:x([0-9a-fA-F]{1,2})|u([0-9a-fA-F]{1,4})|U([0-9a-fA-F]{1,8})|([0-7]{1,3}))/.exec(s.slice(j + 1, j + 11))
      if (!num) { text += '\\' + e; j += 2; continue }
      const code = parseInt(num[1] ?? num[2] ?? num[3] ?? num[4], num[4] ? 8 : 16)
      text += code <= 0x10ffff ? String.fromCodePoint(code) : '\ufffd'
      j += 1 + num[0].length
    }
    if (j >= s.length) this.broken = true
    this.i = Math.min(j + 1, s.length)
    return { text, dynamic: false }
  }

  /** `` `…` ``: its inside runs as its own commands. The word keeps the source text. */
  private backtick(): string {
    const s = this.s
    const start = this.i
    let j = start + 1
    let inner = ''
    while (j < s.length && s[j] !== '`') {
      const n = s[j + 1]
      if (s[j] === '\\' && (n === '`' || n === '\\' || n === '$')) { inner += n; j += 2; continue }
      inner += s[j++]
    }
    if (j >= s.length) this.broken = true
    this.i = Math.min(j + 1, s.length)
    this.commands(inner)
    return s.slice(start, this.i)
  }

  /** Reads `text` as commands of their own, such as a backtick's inside, and keeps what it finds. */
  private commands(text: string) {
    if (this.depth + this.nest >= MAX_DEPTH) { this.broken = true; return }
    const r = new Reader(text, this.depth + this.nest + 1).run()
    this.result.push(...r.result)
    this.bodies.push(...r.bodies)
  }

  /** The commands that run inside text that is read like double quotes: an unquoted heredoc, `${…}`, `$((…))`. */
  private substitutions(text: string) {
    if (this.depth + this.nest >= MAX_DEPTH) { this.broken = true; return }
    const r = new Reader(text, this.depth + this.nest + 1)
    r.dquote(false)
    this.result.push(...r.result)
    this.bodies.push(...r.bodies)
  }

  /** The index after the `))` that closes an arithmetic expansion whose body starts at `from`, or -1 when it is a `$( (…) )` instead. */
  private arith(from: number): number {
    const s = this.s
    let depth = 2
    for (let j = from; j < s.length; j++) {
      const c = s[j]
      if (c === '\\') { j++; continue }
      if (c === "'" || c === '"') {
        const end = s.indexOf(c, j + 1)
        if (end < 0) return -1
        j = end
        continue
      }
      if (c === '(') depth++
      else if (c === ')' && --depth === 0) return j - 1 >= from && s[j - 1] === ')' ? j + 1 : -1
    }
    return -1
  }

  /** The index after the `}` that closes a `${` whose body starts at `from`, or -1. */
  private brace(from: number): number {
    const s = this.s
    let depth = 1
    for (let j = from; j < s.length; j++) {
      const c = s[j]
      if (c === '\\') { j++; continue }
      if (c === '{') depth++
      else if (c === '}' && --depth === 0) return j + 1
    }
    return -1
  }
}

interface Analysis {
  /** Every simple command in the text, the ones inside substitutions too, in the order they were finished. */
  simples: Simple[]
  /** The same, each with its wrappers taken off and the scripts they run read in (`unwrap`). */
  effective: Simple[]
  chained: boolean
  /** The command has a pipe, `|` or `|&`. One inside a backtick isn't counted, and no room rule covers a backtick anyway. */
  piped: boolean
  /** The text of the command with one spelling per meaning, or undefined when part of it only means something at run time. */
  canonical?: string
}

const analyses = new Map<string, Analysis>()

function analyze(command: string): Analysis {
  const known = analyses.get(command)
  if (known) return known
  const r = new Reader(command).run()
  const effective = r.result.flatMap((s) => unwrap(s))
  // A heredoc is data until a shell reads it: `bash <<EOF`, `cat <<EOF | sh`, `ssh host <<EOF`. Then its lines are commands.
  if (r.bodies.length && effective.some((s) => SHELLS.has(base(s.words[0] ?? '')) || base(s.words[0] ?? '') === 'ssh')) {
    for (const body of r.bodies) effective.push(...parse(body).flatMap((s) => unwrap(s)))
  }
  const a: Analysis = { simples: r.result, effective, chained: r.chained, piped: r.piped, canonical: r.canonOk ? r.canon.join(' ') : undefined }
  if (analyses.size >= 64) analyses.delete(analyses.keys().next().value!)
  analyses.set(command, a)
  return a
}

/**
 * The simple commands of a shell command, read the way a shell does. It handles `'…'`, `"…"` and backslashes; the operators
 * `&&`, `||`, `;`, `|`, `&` and newlines; subshells and `{ …; }` groups (flattened); `$( )` and backticks (their inside is
 * parsed as commands of its own); `<( )` and `>( )`; redirections; heredocs (the body is data); and comments. `$VAR`, `${…}`
 * and `$((…))` make a word dynamic. Text it can't finish marks the simple command unknown.
 */
export function parse(command: string): Simple[] { return analyze(command).simples }

// ---------------------------------------------------------------------------------------------------------------------
// Taking wrappers off

/** Words that open or close a compound command rather than name one. */
const KEYWORDS = new Set(['{', '}', '!', 'if', 'then', 'else', 'elif', 'fi', 'do', 'done', 'while', 'until', 'esac', 'coproc'])
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh'])
/** Commands that only print or read their words, so a `git` among them is text: `echo git push origin main`. */
const TEXT_ONLY = new Set(['echo', 'printf', 'command', 'hash', 'cat', 'grep', 'egrep', 'fgrep', 'rg', 'head', 'tail', 'less', 'more', 'man', 'which', 'type', 'whereis', 'wc', 'ls', 'sed', 'awk', 'diff', 'cmp', 'test', '[', '[[', 'read', 'export', 'alias', 'unalias', 'set', 'declare', 'typeset', 'local', 'readonly', 'true', 'false', 'cd'])
const SUDO_ARGS = new Set(['-u', '-g', '-p', '-C', '-D', '-r', '-t', '-h', '-T', '-U', '--user', '--group', '--prompt', '--close-from', '--chdir', '--role', '--type', '--host', '--command-timeout', '--other-user'])
const ENV_ARGS = new Set(['-u', '--unset', '-C', '--chdir'])

const isAssign = (w: string) => /^[A-Za-z_][A-Za-z0-9_]*\+?=/.test(w)
/** `/usr/bin/git` is `git`. */
const base = (w: string) => { const k = w.lastIndexOf('/'); return k >= 0 && k < w.length - 1 ? w.slice(k + 1) : w }

/** How many leading words of `w` a wrapper command takes: itself and its options. Undefined for a command that isn't one. */
function wrapperLength(cmd: string, w: string[]): number | undefined {
  switch (cmd) {
    case 'env': {
      let j = 1
      while (j < w.length) {
        if (w[j] === '--') { j++; break }
        if (ENV_ARGS.has(w[j])) { j += 2; continue }
        if (isAssign(w[j]) || w[j].startsWith('-')) { j++; continue }
        break
      }
      return j
    }
    case 'sudo': case 'doas': {
      let j = 1
      while (j < w.length && w[j].startsWith('-')) {
        if (w[j] === '--') { j++; break }
        // `-Eu root` is two flags, the second of which takes a value.
        j += SUDO_ARGS.has(w[j]) || /^-[A-Za-z]+[ugpCDrtTU]$/.test(w[j]) ? 2 : 1
      }
      return j
    }
    case 'command': {
      let j = 1
      while (w[j] === '-p') j++
      // `command -v git` looks `git` up and runs nothing.
      return w[j] === '-v' || w[j] === '-V' ? undefined : j
    }
    case 'exec': {
      let j = 1
      while (j < w.length && w[j].startsWith('-')) {
        if (w[j] === '--') { j++; break }
        j += w[j] === '-a' ? 2 : 1
      }
      return j
    }
    case 'nice': {
      if (w[1] === '-n') return 3
      return /^(?:-n?\d+|--adjustment=.*)$/.test(w[1] ?? '') ? 2 : 1
    }
    case 'time': {
      let j = 1
      while (j < w.length && w[j].startsWith('-')) j += ['-o', '-f', '--output', '--format'].includes(w[j]) ? 2 : 1
      return j
    }
    case 'timeout': {
      let j = 1
      while (j < w.length && w[j].startsWith('-')) j += ['-k', '--kill-after', '-s', '--signal'].includes(w[j]) ? 2 : 1
      // The duration comes before the command.
      return j + 1
    }
    case 'nohup': case 'builtin': return 1
    default: return undefined
  }
}

/** The script a shell is told to run with `-c`, as in `bash -lc 'script'`, or undefined when it runs a file or stdin. */
function shellScript(w: string[]): string | undefined {
  let c = false
  for (let j = 1; j < w.length; j++) {
    const x = w[j]
    if (x === '-o' || x === '+o' || x === '-O' || x === '+O') { j++; continue }
    if (x.startsWith('-') || x.startsWith('+')) { if (/^-[a-zA-Z]*c[a-zA-Z]*$/.test(x)) c = true; continue }
    return c ? x : undefined
  }
  return undefined
}

/**
 * The commands a simple command really runs. Leading `VAR=…` assignments, `env`, `command`, `exec`, `sudo`, `nice`,
 * `nohup`, `time` and `timeout` come off. `bash|sh|zsh -c '<script>'` is read as the script. `eval` is unknown, and its
 * text is read as a script as well. Group keywords (`if`, `then`, `{`) come off, so what follows them is the command.
 * A git alias set with `-c alias.x=!script` adds the script. The result always holds at least one simple command, and
 * the words of the first one are never a wrapper's.
 */
export function unwrap(s: Simple, depth = 0): Simple[] {
  let words = s.words
  let dyn = s.dynamic
  for (;;) {
    if (!words.length) break
    const cut = KEYWORDS.has(words[0]) || isAssign(words[0]) ? 1 : words[0] === 'function' && words.length > 1 ? 2 : 0
    if (!cut) break
    words = words.slice(cut)
    dyn = dyn.slice(cut)
  }
  const plain = (unknown = s.unknown): Simple => ({ ...s, words, dynamic: dyn, unknown })
  if (!words.length) return [plain()]
  // What the command word expands to is only known when it runs.
  if (dyn[0] || depth > 8) return [plain(true)]
  const cmd = base(words[0])
  const rest = (n: number) => unwrap({ ...s, words: words.slice(n), dynamic: dyn.slice(n) }, depth + 1)
  if (cmd === 'env') {
    // `env -S 'git push'` splits its argument into words first.
    let k = 1
    while (k < words.length && (words[k].startsWith('-') || isAssign(words[k]))) {
      if (words[k] === '-S' || words[k] === '--split-string') {
        const split = parse(words[k + 1] ?? '')[0]
        return unwrap({ ...s, words: [...words.slice(0, k), ...(split?.words ?? []), ...words.slice(k + 2)], dynamic: [...dyn.slice(0, k), ...(split?.dynamic ?? []), ...dyn.slice(k + 2)] }, depth + 1)
      }
      k += ENV_ARGS.has(words[k]) ? 2 : 1
    }
  }
  const n = wrapperLength(cmd, words)
  if (n !== undefined) return rest(n)
  if (cmd === 'eval') return [plain(true), ...parse(words.slice(1).join(' ')).flatMap((x) => unwrap(x, depth + 1))]
  if (SHELLS.has(cmd)) {
    const script = shellScript(words)
    if (script !== undefined) return [plain(), ...parse(script).flatMap((x) => unwrap(x, depth + 1))]
  }
  const out = [plain()]
  if (words[0] !== cmd) out[0].words = [cmd, ...words.slice(1)]
  const git = gitCall(out[0])
  if (git) out.push(...git.scripts.flatMap((x) => unwrap(x, depth + 1)))
  // A command that runs another with the rest of its words: `xargs git push ...`, `find -exec git push ... \;`, `ssh host git push ...`, `watch git push ...`.
  if (cmd !== 'git' && !TEXT_ONLY.has(cmd)) {
    for (let k = 1; k < words.length; k++) if (base(words[k]) === 'git' && !dyn[k]) out.push(...unwrap({ ...s, words: words.slice(k), dynamic: dyn.slice(k) }, depth + 1))
  }
  return out
}

// ---------------------------------------------------------------------------------------------------------------------
// Git

/** Every command `git` itself provides. An alias can't take one of these names, and a name outside the list is something Kernel can't read. */
const GIT_COMMANDS = new Set(('add am annotate apply archive bisect blame branch bugreport bundle cat-file check-attr check-ignore check-mailmap check-ref-format checkout checkout-index cherry cherry-pick ' +
  'citool clean clone column commit commit-graph commit-tree config count-objects credential daemon describe diagnose diff diff-files diff-index diff-tree difftool fast-export fast-import fetch ' +
  'fetch-pack filter-branch fmt-merge-msg for-each-ref for-each-repo format-patch fsck gc get-tar-commit-id gitk gitweb grep gui hash-object help hook index-pack init instaweb interpret-trailers log ' +
  'ls-files ls-remote ls-tree mailinfo mailsplit maintenance merge merge-base merge-file merge-index merge-tree mergetool mktag mktree multi-pack-index mv name-rev notes p4 pack-objects pack-redundant ' +
  'pack-refs patch-id prune prune-packed pull push range-diff read-tree rebase receive-pack reflog refs remote repack replace replay request-pull rerere reset restore rev-list rev-parse revert rm ' +
  'scalar send-email send-pack shortlog show show-branch show-index show-ref sparse-checkout stage stash status stripspace submodule subtree svn switch symbolic-ref tag unpack-file unpack-objects ' +
  'update-index update-ref update-server-info upload-archive upload-pack var verify-commit verify-pack verify-tag version whatchanged worktree write-tree').split(' '))

/** Options that go between `git` and its command, and take the next word. */
const GIT_ARGS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--super-prefix', '--config-env', '--attr-source'])

interface GitCall {
  /** The command after aliases from `-c alias.x=…`, or undefined when it is a word that is only known at run time. */
  sub?: string
  /** Its arguments, with an alias's own arguments first. */
  args: string[]
  dynamic: boolean[]
  /** The commands a `!` alias runs. */
  scripts: Simple[]
}

/** A call of git, with its global options (`-C dir`, `-c k=v`, `--no-pager`) set aside and its command resolved. Undefined for anything else. */
function gitCall(s: Simple): GitCall | undefined {
  const w = s.words
  if (!w.length || base(w[0]) !== 'git' || s.dynamic[0]) return undefined
  const aliases = new Map<string, string>()
  let j = 1
  while (j < w.length && w[j].startsWith('-')) {
    if (w[j] === '-c' && w[j + 1]?.toLowerCase().startsWith('alias.')) {
      const kv = w[j + 1]
      const eq = kv.indexOf('=')
      if (eq > 6) aliases.set(kv.slice(6, eq).toLowerCase(), kv.slice(eq + 1))
    }
    j += GIT_ARGS.has(w[j]) ? 2 : 1
  }
  const scripts: Simple[] = []
  let sub: string | undefined = s.dynamic[j] ? undefined : w[j]
  let args = w.slice(j + 1)
  let dyn = s.dynamic.slice(j + 1)
  for (let n = 0; n < 5 && sub !== undefined && !GIT_COMMANDS.has(sub) && aliases.has(sub.toLowerCase()); n++) {
    const value = aliases.get(sub.toLowerCase())!
    if (value.startsWith('!')) { scripts.push(...parse(value.slice(1))); sub = undefined; args = []; dyn = []; break }
    const expanded = parse(value)[0]
    sub = expanded?.words[0]
    args = [...(expanded?.words.slice(1) ?? []), ...args]
    dyn = [...(expanded?.dynamic.slice(1) ?? []), ...dyn]
  }
  return { sub, args, dynamic: dyn, scripts }
}

/** The branch a push word names: the right side of `src:dst`, without a leading `+` and without `refs/heads/`. */
const pushTarget = (word: string) => {
  const w = word.replace(/^\+/, '')
  return (w.includes(':') ? w.slice(w.lastIndexOf(':') + 1) : w).replace(/^refs\/heads\//, '')
}

/** Whether one of the words is a protected branch, written as `main`, `HEAD:main`, `+refs/heads/main` or `origin/main`. */
const mentions = (words: string[], branches: string[]) =>
  words.some((w) => w.split(/[\s:/]+/).some((part) => branches.includes(part.replace(/^\+/, ''))))

/** `--force`, `-f`, `--force-with-lease[=…]`, or short flags that include `f` (`-fu`). */
const isForceFlag = (a: string) => /^--force(?:-with-lease(?:=.*)?)?$/.test(a) || /^-[a-zA-Z]*f[a-zA-Z]*$/.test(a)

/** `a` is `full` or a shorter start of it that git still accepts (`--mirr`), at least `min` characters long. */
const abbreviates = (a: string, full: string, min: number) => a.length >= min && full.startsWith(a)

/** Options of `git push` that take the next word as their value. */
const PUSH_ARGS = new Set(['--repo', '--receive-pack', '--exec', '--push-option', '-o'])

/** A `git push` that overwrites the remote: a force flag, or a `+` refspec. */
function forcesPush(args: string[]): boolean {
  let end = false
  for (const a of args) {
    if (!end && a === '--') { end = true; continue }
    if (!end && isForceFlag(a)) return true
    if ((end || !a.startsWith('-')) && a.startsWith('+')) return true
  }
  return false
}

/**
 * What a simple command does to a protected branch. `deny` for a `git push` that names one (`main`, `HEAD:main`,
 * `+refs/heads/main`, `:main`, quoted or not), or that pushes `--all`, `--branches` or `--mirror`. `ask` when a ref can't be read: a word
 * with an expansion, a `*` pattern, or a command git doesn't provide that mentions a protected branch (an alias set in a
 * git config file, say). A bare `git push` names no branch, so it is left alone.
 */
export function pushVerdict(s: Simple, protectedBranches: string[]): 'deny' | 'ask' | undefined {
  if (!protectedBranches.length) return undefined
  const g = gitCall(s)
  if (!g) return undefined
  if (g.sub !== 'push') {
    if (g.sub !== undefined && GIT_COMMANDS.has(g.sub)) return undefined
    // A `!` alias runs a script, which `unwrap` reads as commands of their own.
    if (g.sub === undefined && g.scripts.length) return undefined
    // A command git doesn't provide, or one only known at run time: it may push.
    return mentions([g.sub ?? '', ...g.args], protectedBranches) ? 'ask' : undefined
  }
  let verdict: 'ask' | undefined
  let end = false
  for (let k = 0; k < g.args.length; k++) {
    const a = g.args[k]
    if (!end && a === '--') { end = true; continue }
    if (!end && a.startsWith('-')) {
      if (abbreviates(a, '--all', 4) || abbreviates(a, '--branches', 3) || abbreviates(a, '--mirror', 3)) return 'deny'
      if (PUSH_ARGS.has(a)) k++
      continue
    }
    if (g.dynamic[k]) { verdict = 'ask'; continue }
    const target = pushTarget(a)
    if (protectedBranches.includes(target)) return 'deny'
    if (target.includes('*')) verdict = 'ask'
  }
  return verdict
}

// ---------------------------------------------------------------------------------------------------------------------
// Rules

/**
 * Kernel's say on one Bash command: Never allow, then the room's Always allow rules, then Always ask.
 * Undefined leaves it to Claude Code's own settings, so the user's allow list still covers everyday commands.
 * A push to a protected branch is denied, a ref Kernel can't read is asked about, and a command Kernel can't read that
 * mentions a protected branch is asked about too.
 */
export function bashVerdict(command: string, p: { neverAllow: string[]; alwaysAsk: string[]; protectedBranches?: string[]; network?: boolean }, roomAllow: string[]): BashVerdict {
  const branches = p.protectedBranches ?? []
  const { effective } = analyze(command.trim())
  const pushes = effective.map((s) => pushVerdict(s, branches))
  if (matchesRule(command, p.neverAllow) || pushes.includes('deny') || (p.network === false && usesNetwork(command))) return 'deny'
  if (matchesRoomRule(command, roomAllow)) return 'allow'
  if (matchesRule(command, p.alwaysAsk) || pushes.includes('ask') || (branches.length > 0 && effective.some((s) => s.unknown && mentions(s.words, branches)))) return 'ask'
  return undefined
}

/**
 * A push Bypass permissions can't let through, because it might reach a protected branch (KERNEL-447): one `pushVerdict`
 * denies or asks about, a command Kernel can't read that mentions a protected branch, a `git` whose command is only known at
 * run time, and a `git push` that leaves its destination to git (`pushesUnnamed`). Every mode but Bypass asks about the
 * ones `bashVerdict` asks about and leaves the unnamed ones to the user's own settings.
 */
export function pushMightReach(command: string, branches: string[]): boolean {
  if (!branches.length) return false
  return analyze(command.trim()).effective.some((s) => {
    if (pushVerdict(s, branches) || (s.unknown && mentions(s.words, branches))) return true
    const g = gitCall(s)
    return !!g && ((g.sub === undefined && !g.scripts.length) || pushesUnnamed(g))
  })
}

/**
 * A `git push` that names no branch to push to, so git picks it from the upstream and `push.default`, which can be a
 * protected branch: a bare push, one naming only the remote, or one pushing `HEAD` or `@` without `:dst`. With `--tags` and
 * no refspec it pushes tags only.
 */
function pushesUnnamed(g: GitCall): boolean {
  if (g.sub !== 'push') return false
  const words: string[] = []
  let tags = false
  let end = false
  for (let k = 0; k < g.args.length; k++) {
    const a = g.args[k]
    if (!end && a === '--') { end = true; continue }
    if (!end && a.startsWith('-')) {
      if (a === '--tags') tags = true
      if (PUSH_ARGS.has(a)) k++
      continue
    }
    words.push(a)
  }
  const refspecs = words.slice(1)
  if (!refspecs.length) return !tags
  return refspecs.some((r) => /^\+?(?:HEAD|@)$/.test(r))
}

/** A `git push` that names a protected branch (`origin main`, `origin "main"`, `origin HEAD:refs/heads/main`, `git -C dir push ...`), or pushes `--all` or `--mirror`. A bare `git push` names none, so it is left alone. */
export function pushesTo(command: string, branches: string[]): boolean {
  return analyze(command.trim()).effective.some((s) => pushVerdict(s, branches) === 'deny')
}

const NET_PROGRAMS = new Set(['curl', 'wget', 'nc', 'ncat', 'ssh', 'scp', 'rsync', 'ftp', 'sftp', 'telnet', 'gh'])
const NET_PACKAGE = new Set(['npm', 'pnpm', 'yarn', 'bun', 'pip', 'pip3', 'brew'])
const NET_PACKAGE_COMMANDS = new Set(['install', 'i', 'add', 'update', 'upgrade', 'publish'])
const NET_GIT = new Set(['push', 'pull', 'fetch', 'clone', 'ls-remote'])

/** Commands that reach the network: downloads, remote shells, package installs and git calls to a remote. Matched per command in a chain, so it is a guard for obvious cases, not a sandbox. */
export function usesNetwork(command: string): boolean {
  return analyze(command.trim()).effective.some((s) => {
    const cmd = base(s.words[0] ?? '')
    if (NET_PROGRAMS.has(cmd)) return true
    if (NET_PACKAGE.has(cmd)) return NET_PACKAGE_COMMANDS.has(s.words.slice(1).find((x) => !x.startsWith('-')) ?? '')
    const g = gitCall(s)
    return !!g?.sub && NET_GIT.has(g.sub)
  })
}

/** The simple commands only: no operators, redirections, process substitution, heredoc, expansion or unknown words. */
const isPlain = (s: Simple) => !s.unknown && !s.redirects.length && !s.procSub && !s.heredoc && !s.dynamic.some(Boolean)

/** Shells, and the builtins that run a script file, which run whatever a pipe sends them: `curl … | sh`, `… | source /dev/stdin`. */
const RUNS_INPUT = new Set([...SHELLS, 'source', '.'])

/** A word that may be a glob, which only the same text covers exactly. The quotes are off by now, so a quoted `*` counts too. */
const mayGlob = (w: string) => /[*?[]/.test(w) || w.startsWith('~')

/** A room rule as the words of one plain simple command, `:*` making it a prefix. Undefined for a chain or anything else. */
function roomRuleOf(rule: string): { words: string[]; prefix: boolean } | undefined {
  const r = rule.trim()
  const prefix = r.endsWith(':*')
  const a = analyze(prefix ? r.slice(0, -2).trim() : r)
  const [only] = a.simples
  if (a.simples.length !== 1 || a.chained || !isPlain(only) || !only.words.length) return undefined
  return { words: only.words, prefix }
}

/**
 * The words a room rule must cover in one simple command of a chain, without the `{`, `if` or `then` before them. Undefined
 * when no rule may cover it (KERNEL-454): a redirection, process substitution, heredoc, `$(…)`, backtick or any word only known
 * when it runs; `eval`; a command that runs another one it names (`xargs git push`, a git `!` alias); a shell told to run a
 * script with `-c`, wherever it sits (`xargs sh -c`, `find -exec bash -c`); and a shell or `source` in a command with a pipe,
 * which may run what the pipe sends. A wrapper such as `sudo` stays in the words, so a rule has to name it.
 */
function coverable(s: Simple, piped: boolean): string[] | undefined {
  if (!isPlain(s)) return undefined
  const [run, ...more] = unwrap(s)
  if (run.unknown || more.length) return undefined
  if (s.words.some((w, k) => SHELLS.has(base(w)) && shellScript(s.words.slice(k)) !== undefined)) return undefined
  if (piped && RUNS_INPUT.has(base(run.words[0] ?? ''))) return undefined
  let k = 0
  while (k < s.words.length && KEYWORDS.has(s.words[k])) k++
  return s.words.slice(k)
}

/**
 * Whether the room's Always allow rules cover a command. Rules use Claude Code's Bash rule shape: `prefix:*` covers the prefix
 * with any arguments, otherwise the exact command. A rule covers the command it was saved from, spelled the same way whatever
 * the spacing, chained or not (KERNEL-230). Otherwise every simple command in it must be covered on its own (KERNEL-454): `cd`
 * needs no rule, and each other one is plain and matches a rule, a prefix rule by its first words and an exact rule by all of
 * them. So `npm run build:*` and `npm test:*` cover `cd web && npm run build && npm test`, but `npm run build:*` alone can't
 * wave through `npm run build && pnpm db:reset`, and `echo:*` doesn't cover `echo hi > ~/.zshrc`. `$(…)`, backticks, `eval`,
 * `sh -c` and its kind and a pipe into a shell never match (`coverable`). A chain of `cd` alone matches nothing.
 */
export function matchesRoomRule(command: string, rules: string[]): boolean {
  if (!rules.length) return false
  const c = command.trim()
  const a = analyze(c)
  const same = (r: string) => c === r || (a.canonical !== undefined && a.canonical === analyze(r).canonical)
  if (rules.some((r) => !r.trim().endsWith(':*') && same(r.trim()))) return true
  const parsed = rules.flatMap((r) => roomRuleOf(r) ?? [])
  let ruled = false
  for (const s of a.simples) {
    const words = coverable(s, a.piped)
    if (!words) return false
    if (!words.length || words[0] === 'cd') continue
    const hit = parsed.some((r) => r.prefix
      ? r.words.length <= words.length && r.words.every((w, i) => words[i] === w)
      : r.words.length === words.length && !words.some(mayGlob) && r.words.every((w, i) => words[i] === w))
    if (!hit) return false
    ruled = true
  }
  return ruled
}

/**
 * The rule "Always allow in this room" saves: Claude Code's own suggestion when it is a single Bash rule and may be saved,
 * else the exact command.
 */
export function roomRule(command: string, suggestions?: PermissionUpdate[], suppressAlwaysAllowRule?: boolean): string {
  const rules = suppressAlwaysAllowRule ? [] : (suggestions ?? []).flatMap((s) => (s.type === 'addRules' && s.behavior === 'allow' ? s.rules : []))
  return rules.length === 1 && rules[0].toolName === 'Bash' && rules[0].ruleContent ? rules[0].ruleContent : command.trim()
}

const isFlag = (w: string) => w.startsWith('-') && w.length > 1
const RM_LONG: Record<string, string> = { '--recursive': 'r', '--force': 'f', '--dir': 'd', '--verbose': 'v', '--interactive': 'i' }

/** The flags of an `rm`, one letter each, whatever their grouping: `-rf`, `-fr`, `-r -f` and `--recursive --force` all give `r` and `f`. */
function rmFlags(words: string[]): Set<string> {
  const out = new Set<string>()
  for (const w of words) {
    if (w === '--') break
    if (w.startsWith('--')) out.add(RM_LONG[w] ?? w)
    else if (isFlag(w)) for (const ch of w.slice(1)) out.add(ch === 'R' ? 'r' : ch)
  }
  return out
}

/** What `rm` is given to remove: the words that aren't flags, and everything after `--`. */
function rmTargets(words: string[]): string[] {
  const out: string[] = []
  let end = false
  for (const w of words) {
    if (!end && w === '--') { end = true; continue }
    if (end || !isFlag(w)) out.push(w)
  }
  return out
}

/** Some `rm` in the words has every flag of the rule, in any order or grouping, and targets that start with the rule's. */
function rmMatches(words: string[], rule: string[]): boolean {
  const need = [...rmFlags(rule.slice(1))]
  const want = rmTargets(rule.slice(1))
  return words.some((w, k) => {
    if (base(w) !== 'rm') return false
    const have = rmFlags(words.slice(k + 1))
    const targets = rmTargets(words.slice(k + 1))
    return need.every((f) => have.has(f)) && want.every((t, i) => targets[i]?.startsWith(t))
  })
}

/** A rule with `*` as a pattern that stands for any characters. */
const globRule = (rule: string) => new RegExp('^' + rule.split('*').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$')

/** The rule's words appear in a row among the words, with `*` standing for any characters inside a word. */
function inRow(words: string[], rule: string[]): boolean {
  const tests = rule.map((r) => (r.includes('*') ? globRule(r) : r))
  for (let k = 0; k + tests.length <= words.length; k++) {
    if (tests.every((t, i) => (typeof t === 'string' ? words[k + i] === t : t.test(words[k + i])))) return true
  }
  return false
}

/** A rule that is one simple command, as words with the program's own name. Undefined for a rule with operators, redirections or an expansion. */
function ruleWords(rule: string): string[] | undefined {
  const a = analyze(rule.trim())
  const [only] = a.simples
  if (a.simples.length !== 1 || a.chained || only.redirects.length || only.procSub || only.heredoc || !only.words.length) return undefined
  // `sudo rm -rf /` as a rule means the `rm`.
  const [bare, ...inner] = unwrap(only)
  const words = (inner.length ? only : bare).words
  return words.length ? [base(words[0]), ...words.slice(1)] : undefined
}

/** Whether one command, with its wrappers off, is what the rule describes. */
function commandMatches(s: Simple, rule: string[]): boolean {
  if (rule[0] === 'rm' && rule.slice(1).some(isFlag)) return rmMatches(s.words, rule)
  const g = gitCall(s)
  // Any force push matches a rule that only says to force.
  if (rule[0] === 'git' && rule[1] === 'push' && rule.length > 2 && rule.slice(2).every(isForceFlag)) return g?.sub === 'push' && forcesPush(g.args)
  // Git without its global options and aliases, so `git -C dir -c alias.p=push p origin main` reads as `git push origin main`.
  return inRow(s.words, rule) || (!!g && inRow(['git', ...(g.sub ? [g.sub] : []), ...g.args], rule))
}

/**
 * Match a Bash command against Settings > Permissions lists. A rule matches when its text appears in the command (`*` stands for
 * anything), or when it is one simple command that the command runs once its wrappers (`sudo`, `env X=1`, `bash -c`) and
 * git's global options and aliases are off. `rm -rf` also covers `rm -fr`, `rm -r -f` and `rm --recursive --force`, and
 * `git push --force` covers `-f`, `--force-with-lease` and a `+ref` (KERNEL-230).
 */
export function matchesRule(command: string, rules: string[]): string | undefined {
  const c = command.trim()
  return rules.find((r) => {
    if (textMatches(c, r)) return true
    const words = ruleWords(r)
    return !!words && analyze(c).effective.some((s) => commandMatches(s, words))
  })
}

/** The way a rule has always matched: its text anywhere in the command, or `*` as a pattern over the whole command. */
function textMatches(c: string, r: string): boolean {
  if (r.includes('*')) return globRule(r).test(c)
  return c === r || c.startsWith(r + ' ') || c.includes(r)
}
