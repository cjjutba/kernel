import { describe, expect, it } from 'vitest'
import { bashVerdict, matchesRoomRule, matchesRule, parse, pushesTo, pushMightReach, unwrap, usesNetwork } from '../src/main/services/bashGuard'

// KERNEL-230: the guard reads a command the way a shell does, so quoting, wrappers, aliases, flag order and redirections
// don't get past Never allow, Always ask or a room rule.

const lists = {
  neverAllow: ['git push origin main'],
  alwaysAsk: ['rm -rf', 'git push --force', 'drizzle-kit push', 'pnpm db:reset'],
  protectedBranches: ['main', 'dev']
}
/** Only the protected branches speak, so a rule's own text can't be what matched. */
const branchesOnly = { neverAllow: [], alwaysAsk: [], protectedBranches: ['main', 'dev'] }

const words = (command: string) => parse(command).map((s) => s.words)

describe('reading a command', () => {
  it('takes quotes and escapes off words, and splits on operators outside them', () => {
    expect(words(`echo 'a; b' "c && d" e\\ f && ls`)).toEqual([['echo', 'a; b', 'c && d', 'e f'], ['ls']])
    expect(words('echo m"a"i\'n\'')).toEqual([['echo', 'main']])
    expect(words('echo "a \\"quoted\\" \\$x"')).toEqual([['echo', 'a "quoted" $x']])
    expect(words('a || b | c |& d & e ; f\ng')).toEqual([['a'], ['b'], ['c'], ['d'], ['e'], ['f'], ['g']])
    expect(words('git commit -m "feat: x; y"')).toEqual([['git', 'commit', '-m', 'feat: x; y']])
  })

  it('reads C escapes, line continuations and comments', () => {
    expect(words("echo $'\\x6dain\\n'")).toEqual([['echo', 'main\n']])
    expect(words('echo a \\\nb')).toEqual([['echo', 'a', 'b']])
    expect(words('git status # git push origin main')).toEqual([['git', 'status']])
    expect(words('echo a#b')).toEqual([['echo', 'a#b']])
  })

  it('flattens subshells and groups, and finds the commands inside substitutions', () => {
    expect(words('(a; b) && { c; d; }')).toEqual([['a'], ['b'], ['{', 'c'], ['d'], ['}']])
    expect(words('echo $(git rev-parse HEAD) `date`')).toEqual([['git', 'rev-parse', 'HEAD'], ['date'], ['echo', '$(git rev-parse HEAD)', '`date`']])
    expect(words('echo "x $(a $(b))"')).toEqual([['b'], ['a', '$(b)'], ['echo', 'x $(a $(b))']])
    expect(words('echo $((1 + $(a)))')).toEqual([['a'], ['echo', '$((1 + $(a)))']])
  })

  it('marks a word that is only known when it runs', () => {
    const s = parse('git push origin $b "${c}" "$(d)" {x,y} \'$e\' \\$f plain').find((x) => x.words[0] === 'git')!
    expect(s.words.slice(3)).toEqual(['$b', '${c}', '$(d)', '{x,y}', '$e', '$f', 'plain'])
    expect(s.dynamic.slice(3)).toEqual([true, true, true, true, false, false, false])
    expect(parse('echo $1 $@ $? $$ $')[0].dynamic).toEqual([false, true, true, true, true, false])
  })

  it('records redirections, process substitution and heredocs, and skips the body of a heredoc', () => {
    expect(parse('cat a > b 2>&1 >> c < d &> e <<< f')[0]).toMatchObject({ words: ['cat', 'a'], redirects: ['>', '2>&', '>>', '<', '&>', '<<<'] })
    expect(parse('diff <(a) >(b)').map((s) => [s.words, s.procSub])).toEqual([[['a'], false], [['b'], false], [['diff', '<(a)', '>(b)'], true]])
    const heredoc = parse("cat <<'EOF' > notes.md\ngit push origin main\nEOF\nls")
    expect(heredoc.map((s) => s.words)).toEqual([['cat'], ['ls']])
    expect(heredoc[0]).toMatchObject({ heredoc: true, redirects: ['<<', '>'] })
    expect(words('cat <<-EOF\n\tbody\n\tEOF\nls')).toEqual([['cat'], ['ls']])
    // An unquoted heredoc runs the substitutions in its body. A quoted one doesn't.
    expect(words('cat <<EOF\n$(date)\nEOF')).toEqual([['cat'], ['date']])
    expect(words("cat <<'EOF'\n$(date)\nEOF")).toEqual([['cat']])
  })

  it('marks text it cannot finish as unknown, and does not loop on it', () => {
    for (const c of ['echo "open', "echo 'open", 'echo $(open', 'echo `open', 'echo ${open', 'echo $\'open', 'echo \\', '>', '<<', '(((', '))))', '$(' + '$('.repeat(40)]) {
      const out = parse(c)
      expect(Array.isArray(out), c).toBe(true)
    }
    for (const c of ['echo "open', 'echo $(open', 'echo `open', 'echo ${open']) expect(parse(c).find((x) => x.words[0] === 'echo')?.unknown, c).toBe(true)
  })
})

describe('taking wrappers off', () => {
  const effective = (command: string) => parse(command).flatMap((s) => unwrap(s)).map((s) => s.words)

  it('drops assignments, env, command, exec, sudo, nice, nohup, time and timeout', () => {
    expect(effective('FOO=1 BAR="a b" git status')).toEqual([['git', 'status']])
    expect(effective('env -i X=1 -u Y git status')).toEqual([['git', 'status']])
    expect(effective('env -S "FOO=1 git status"')).toEqual([['git', 'status']])
    expect(effective('command -p git status')).toEqual([['git', 'status']])
    expect(effective('exec -a name git status')).toEqual([['git', 'status']])
    expect(effective('sudo -u root -E git status')).toEqual([['git', 'status']])
    expect(effective('sudo -Eu root git status')).toEqual([['git', 'status']])
    expect(effective('nice -n 5 nohup time -p git status')).toEqual([['git', 'status']])
    expect(effective('timeout -k 5 30 git status')).toEqual([['git', 'status']])
    expect(effective('/usr/bin/env /usr/bin/git status')).toEqual([['git', 'status']])
  })

  it('keeps command -v, which looks a command up and runs nothing', () => {
    expect(effective('command -v git')).toEqual([['command', '-v', 'git']])
  })

  it('reads the script of bash -c, sh -c and zsh -c', () => {
    expect(effective(`bash -c 'git status; ls'`)).toContainEqual(['git', 'status'])
    expect(effective(`sh -lc "cd x && git status"`)).toContainEqual(['git', 'status'])
    expect(effective(`zsh -ic 'git status'`)).toContainEqual(['git', 'status'])
    expect(effective(`bash -o pipefail -c 'git status'`)).toContainEqual(['git', 'status'])
    expect(effective(`bash -c 'bash -c "git status"'`)).toContainEqual(['git', 'status'])
    expect(effective('bash script.sh')).toEqual([['bash', 'script.sh']])
  })

  it('reads eval as unknown, with its text read as a script', () => {
    const out = parse('eval "git status"').flatMap((s) => unwrap(s))
    expect(out.map((s) => [s.words, s.unknown])).toEqual([[['eval', 'git status'], true], [['git', 'status'], false]])
  })

  it('takes group keywords off, so what follows is the command', () => {
    expect(effective('if true; then git status; fi')).toContainEqual(['git', 'status'])
    expect(effective('for x in a; do git status; done')).toContainEqual(['git', 'status'])
    expect(effective('! git status')).toEqual([['git', 'status']])
    expect(effective('f() { git status; }')).toContainEqual(['git', 'status'])
    expect(effective('function f { git status; }')).toContainEqual(['git', 'status'])
  })

  it('reads a command word that is an expansion as unknown', () => {
    expect(parse('$tool push origin main').flatMap((s) => unwrap(s))[0].unknown).toBe(true)
  })
})

describe('Never allow and protected branches', () => {
  it.each([
    'git push origin main',
    'git push origin "main"',
    "git push origin 'main'",
    'git push origin ma"in"',
    'git push origin m\\ain',
    "git push origin $'\\x6dain'",
    'git push origin +main',
    'git push origin :main',
    'git push origin HEAD:main',
    'git push origin HEAD:refs/heads/main',
    'git push origin +HEAD:refs/heads/main',
    'git push -u origin main',
    'git push --force-with-lease=main:abc origin main',
    'git push origin feature main',
    'git push origin dev',
    'git push --all',
    'git push --all origin',
    'git push --mirror',
    'git push --mirr origin',
    'git push --branches',
    'git push -o ci.skip --all',
    'git -c alias.p=push p origin main',
    "git -c alias.p='push -u' p origin main",
    "git -c user.name=x -c alias.p=push -C ../app p origin main",
    "git -c 'alias.p=!git push origin main' p",
    'git -C ../app push origin main',
    'git --no-pager push origin main',
    'git -P push --git-dir=/x origin main',
    'git --git-dir /x --work-tree /y push origin main',
    '/usr/bin/git push origin main',
    'bash -c "git push origin main"',
    "bash -lc 'cd app && git push origin main'",
    "zsh -c 'git push origin main'",
    'env X=1 git push origin main',
    'FOO=1 git push origin main',
    'sudo -u root git push origin main',
    'command git push origin main',
    'exec git push origin main',
    'nice -n 5 git push origin main',
    'nohup git push origin main',
    'time git push origin main',
    'timeout 30 git push origin main',
    'eval "git push origin main"',
    'npm test && git push origin main',
    'echo hi\ngit push origin main',
    'git push origin main &',
    'git push origin main # for later',
    'echo $(git push origin main)',
    'echo `git push origin main`',
    'echo "$(git push origin main)"',
    'cat <(git push origin main)',
    'cat <<EOF\n$(git push origin main)\nEOF',
    'if true; then git push origin main; fi',
    '{ git push origin main; }',
    '(git push origin main)',
    'f() { git push origin main; }; f',
    'for b in x; do git push origin main; done',
    // Commands that run another with their words, and a heredoc a shell reads: all denied before this reader, so still.
    'echo | xargs git push origin HEAD:main',
    'xargs git push origin dev',
    'find . -exec git push origin HEAD:main \\;',
    'npx git push origin +main',
    'watch git push origin HEAD:main',
    'ssh box git push origin HEAD:main',
    'bash <<EOF\ngit push origin HEAD:main\nEOF',
    'sh -s <<EOF\ngit push origin dev\nEOF',
    'cat <<EOF | bash\ngit push origin HEAD:main\nEOF',
    "ssh box <<'EOF'\ngit push origin HEAD:main\nEOF",
    'echo $(case x in x) git push origin dev;; esac)',
    'echo $(case x in\n x) git push origin dev;;\n y) ls;;\nesac)',
    'echo $(case $a in (x|y) git push origin dev;; esac) && ls',
    'x=$(case x in x) echo hi;; esac); git push origin dev'
  ])('denies %j', (command) => {
    expect(bashVerdict(command, branchesOnly, []), command).toBe('deny')
    expect(pushesTo(command, ['main', 'dev'])).toBe(true)
  })

  it('denies the default Never allow rule in the same forms', () => {
    for (const c of ['git push origin "main"', 'git -c alias.p=push p origin main', 'bash -c "git push origin main"', 'env X=1 git push origin main', 'git -C x push origin main'])
      expect(bashVerdict(c, lists, []), c).toBe('deny')
  })

  it('asks when a ref can only be read at run time', () => {
    for (const c of [
      'b=main; git push origin $b',
      'git push origin "$B"',
      'git push origin ${B:-feature}',
      'git push origin $(git branch --show-current)',
      'git push -u origin "$(git rev-parse --abbrev-ref HEAD)"',
      'git push origin {main,x}',
      'git push origin refs/heads/*:refs/heads/*',
      'git push $remote $ref',
      'bash -c \'git push origin "$B"\'',
      'eval "git push origin $b"'
    ]) expect(bashVerdict(c, branchesOnly, []), c).toBe('ask')
  })

  it('asks about a command git does not provide, or one only known at run time, that names a protected branch', () => {
    expect(bashVerdict('git town sync main', branchesOnly, [])).toBe('ask')
    expect(bashVerdict('git $sub origin main', branchesOnly, [])).toBe('ask')
    expect(bashVerdict('$tool push origin main', branchesOnly, [])).toBe('ask')
    expect(bashVerdict('eval $cmd main', branchesOnly, [])).toBe('ask')
    expect(bashVerdict('git town sync feature', branchesOnly, [])).toBeUndefined()
    expect(bashVerdict('eval "$(ssh-agent -s)"', branchesOnly, [])).toBeUndefined()
  })

  it('leaves everything else to Claude Code', () => {
    for (const c of [
      'npm run build',
      'git push origin feature',
      'git push -u origin feat/x',
      'git push origin feat/main',
      'git push --tags origin',
      'git push --force-with-lease origin feature',
      'git push -o ci.skip origin feature',
      'git push',
      'git status',
      'git checkout main',
      'git merge origin/main',
      'git log main..HEAD',
      'git commit -m "git push origin main"',
      'echo git push origin main',
      'echo "git push origin main" > notes.md',
      'git status # git push origin main',
      "cat <<'EOF' > notes.md\ngit push origin main\nEOF",
      'bash script.sh main',
      'echo git push origin main',
      'printf "%s" git push origin main',
      'which git',
      'command -v git',
      'xargs git status',
      'find . -exec git status \\;',
      'git log --grep=git',
      'ssh box ls',
      'bash <<EOF\ngit status\nEOF',
      'echo $(case x in x) git status;; esac)',
      'ls -la'
    ]) expect(bashVerdict(c, branchesOnly, []), c).toBeUndefined()
  })

  it('leaves a protected branch alone when none is protected', () => {
    expect(bashVerdict('git push origin main', { neverAllow: [], alwaysAsk: [] }, [])).toBeUndefined()
    expect(bashVerdict('git push --all', { neverAllow: [], alwaysAsk: [], protectedBranches: [] }, [])).toBeUndefined()
  })
})

// KERNEL-447: Bypass permissions never asks, so a push that might reach a protected branch is refused instead.
describe('a push that might reach a protected branch', () => {
  const branches = ['main', 'dev']

  it.each([
    ['git push origin main'],
    ['git push origin HEAD:refs/heads/dev'],
    ['git push --all origin'],
    // Git picks the branch from the upstream and push.default, which a worktree branched from main may point at.
    ['git push'],
    ['git push origin'],
    ['git push -u origin'],
    ['git push --set-upstream origin HEAD'],
    ['git push origin @'],
    ['git push origin +HEAD'],
    ['git -C ../other push'],
    ['cd sub && git push'],
    // A ref or a command only known when it runs.
    ['git push origin "$BRANCH"'],
    ['git push origin "feat/*"'],
    ['git $SUB origin feat/x'],
    // A command git doesn't provide that mentions a protected branch, such as an alias from a config file.
    ['git ship main']
  ])('%s', (command) => {
    expect(pushMightReach(command, branches)).toBe(true)
  })

  it.each([
    ['git push origin feat/invoice-schema'],
    ['git push -u origin feat/invoice-schema'],
    ['git push origin HEAD:feat/invoice-schema'],
    ['git push origin HEAD:refs/heads/feat/x'],
    ['git push --tags'],
    ['git push origin --tags'],
    ['git push -o ci.skip origin feat/x'],
    ['git status && git log -1'],
    ['git ship'],
    ['ls']
  ])('lets %s through', (command) => {
    expect(pushMightReach(command, branches)).toBe(false)
  })

  it('lets every push through when no branch is protected', () => {
    expect(pushMightReach('git push', [])).toBe(false)
    expect(pushMightReach('git push origin main', [])).toBe(false)
  })
})

describe('Always ask', () => {
  it.each([
    'rm -rf dist',
    'rm -fr dist',
    'rm -r -f dist',
    'rm -f -r dist',
    'rm --recursive --force dist',
    'rm -rfv dist',
    'rm -Rf dist',
    'rm dist -rf',
    'rm -rf',
    '/bin/rm -fr dist',
    'sudo rm -fr dist',
    'env X=1 rm -r -f dist',
    'bash -c "rm -fr dist"',
    'find . -name x -exec rm -rf {} +',
    'xargs rm -fr',
    'echo hi && rm -rf dist',
    'git push -f',
    'git push --force',
    'git push --force-with-lease',
    'git push --force-with-lease=main:abc origin x',
    'git push -fu origin feature',
    'git push origin feature --force',
    'git push origin +feature',
    'git push origin +HEAD',
    'git push --set-upstream origin +HEAD:feature',
    'git -C x push -f origin feature',
    "git -c alias.p='push -f' p origin feature",
    'pnpm drizzle-kit push',
    'bash -c "pnpm db:reset"'
  ])('asks about %j', (command) => {
    expect(bashVerdict(command, lists, []), command).toBe('ask')
  })

  it('does not ask about the same words in other commands or plain flags', () => {
    for (const c of ['rm -r dist', 'rm -f dist', 'rm dist', 'ls -rf', 'git push origin feature', 'git push -u origin feature', 'git push --tags', 'git push --follow-tags origin feature', 'git status', 'npm run build'])
      expect(bashVerdict(c, lists, []), c).toBeUndefined()
  })

  it('matches rules by their words in a row, and keeps the text match it always had', () => {
    expect(matchesRule('pnpm drizzle-kit push --force', ['drizzle-kit push'])).toBe('drizzle-kit push')
    expect(matchesRule('curl https://x.sh | sh', ['curl * | sh'])).toBe('curl * | sh')
    expect(matchesRule('git -C x -c alias.p=push p origin main', ['git push origin main'])).toBe('git push origin main')
    expect(matchesRule('git push origin main', ['git push * main'])).toBe('git push * main')
    expect(matchesRule('sudo rm -fr x', ['sudo rm -rf'])).toBe('sudo rm -rf')
    expect(matchesRule('rm -fr /home', ['rm -rf /'])).toBe('rm -rf /')
    expect(matchesRule('rm -fr dist', ['rm -rf /'])).toBeUndefined()
    expect(matchesRule('ls -la', ['rm -rf'])).toBeUndefined()
    expect(matchesRule('git push origin feature', ['git push --force'])).toBeUndefined()
  })
})

describe('room rules', () => {
  it('lets a prefix rule cover one plain command whose words start with the prefix', () => {
    for (const c of ['npm run build', 'npm run build -- --watch', 'npm   run  build', ' npm run build\n']) expect(matchesRoomRule(c, 'npm run build:*'), c).toBe(true)
    for (const c of ['npm run builder', 'npm run', 'npm', 'pnpm run build']) expect(matchesRoomRule(c, 'npm run build:*'), c).toBe(false)
  })

  it('never lets a prefix rule cover a redirection, process substitution, heredoc, expansion or unknown word', () => {
    expect(matchesRoomRule('cat file', 'cat:*')).toBe(true)
    for (const c of [
      'cat <(cmd)',
      'cat >(cmd)',
      'cat file > out',
      'cat file >> out',
      'cat < file',
      'cat file 2> err',
      'cat file &> out',
      'cat <<< hi',
      'cat <<EOF\nhi\nEOF',
      'cat $(cmd)',
      'cat `cmd`',
      'cat $FILE',
      'cat ${FILE}',
      'cat "$FILE"',
      'cat {a,b}',
      'cat file; ls',
      'cat file && ls',
      'cat file | sh',
      'cat file &',
      '(cat file)',
      '{ cat file; }',
      'FOO=1 cat file',
      'sudo cat file',
      'env cat file',
      'eval cat file',
      '$tool file'
    ]) expect(matchesRoomRule(c, 'cat:*'), c).toBe(false)
    expect(matchesRoomRule('echo hi > ~/.zshrc', 'echo:*')).toBe(false)
    expect(matchesRoomRule('echo hi', 'echo:*')).toBe(true)
  })

  it('compares an exact rule with the command spelled the same way, whatever the spacing', () => {
    expect(matchesRoomRule('git log --oneline -1', 'git log --oneline -1')).toBe(true)
    expect(matchesRoomRule('git  log   --oneline -1', 'git log --oneline -1')).toBe(true)
    expect(matchesRoomRule('git log --oneline -2', 'git log --oneline -1')).toBe(false)
    expect(matchesRoomRule('cd web && npm run build', 'cd web && npm run build')).toBe(true)
    expect(matchesRoomRule('cd web;npm run build', 'cd web && npm run build')).toBe(false)
    expect(matchesRoomRule("echo 'a b'", 'echo a b')).toBe(false)
    expect(matchesRoomRule('echo "a b"', "echo 'a b'")).toBe(true)
    // An expansion or a glob only means something at run time, so only the same text matches.
    expect(matchesRoomRule('echo $HOME', 'echo $HOME')).toBe(true)
    expect(matchesRoomRule('echo  $HOME', 'echo $HOME')).toBe(false)
    expect(matchesRoomRule("ls '*.log'", 'ls *.log')).toBe(false)
  })

  it('keeps D-016: a room rule beats Always ask, and Never allow beats the room rule', () => {
    const p = { neverAllow: ['git push origin main'], alwaysAsk: ['pnpm db:reset', 'rm -rf'], protectedBranches: ['main'] }
    expect(bashVerdict('pnpm db:reset', p, ['pnpm db:reset:*'])).toBe('allow')
    expect(bashVerdict('rm -fr dist', p, ['rm -fr dist'])).toBe('allow')
    expect(bashVerdict('rm -fr dist', p, ['rm -rf dist'])).toBe('ask')
    expect(bashVerdict('git push origin main', p, ['git:*'])).toBe('deny')
    expect(bashVerdict('git push origin "main"', p, ['git:*'])).toBe('deny')
    expect(bashVerdict('pnpm db:reset && ls', p, ['pnpm db:reset:*'])).toBe('ask')
    expect(bashVerdict('pnpm db:reset > out', p, ['pnpm db:reset:*'])).toBe('ask')
    // A prefix rule can't cover a push to a ref Kernel can't read.
    expect(bashVerdict('git push origin $b', branchesOnly, ['git push:*'])).toBe('ask')
    expect(bashVerdict('git push origin feature', branchesOnly, ['git push:*'])).toBe('allow')
  })
})

describe('network access', () => {
  it('finds a command that reaches the network through wrappers and substitutions', () => {
    for (const c of [
      'curl https://x.dev',
      'FOO=1 wget x',
      'sudo -E ssh box',
      'bash -c "curl x"',
      'echo $(curl x)',
      'cat <(curl x)',
      'npm test && npm install left-pad',
      'command npm install',
      'npm --silent install x',
      'pnpm add x',
      'git -C app fetch',
      'git --no-pager -c user.name=x pull',
      "git -c alias.f=fetch f",
      'git push origin feat/x',
      'gh pr create',
      'echo hi | ssh box'
    ]) expect(usesNetwork(c), c).toBe(true)
    for (const c of ['npm test', 'npm run install-docs', 'git status', 'git commit -m "curl it"', 'ls -la', 'echo curl', "echo 'ssh box'", 'command -v curl']) expect(usesNetwork(c), c).toBe(false)
  })

  it('denies them only while the setting is off', () => {
    const off = { neverAllow: [], alwaysAsk: [], network: false }
    expect(bashVerdict('bash -c "curl https://x.dev"', off, [])).toBe('deny')
    expect(bashVerdict('bash -c "curl https://x.dev"', { ...off, network: true }, [])).toBeUndefined()
  })
})
