import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { basename, delimiter, join } from 'node:path'
import { KERNEL_SERVER } from './kernelServer'

export const seatsDir = (dataDir: string) => join(dataDir, 'seats')
export const seatDir = (dataDir: string, chatId: string) => join(seatsDir(dataDir), chatId)

const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`

/**
 * What a tab types. A login shell's rc files can put Claude's own folder first on the PATH after the seat's folder, so the line
 * defines a `claude` function that runs the seat's script, and every `claude` the tab types later, after `/exit`, finds it
 * before any PATH folder. Fish has its own syntax. The name is quoted so an alias of `claude` can't swallow the definition.
 */
export function seatCommand(dir: string, typed: string | undefined, shell: string): string {
  const script = quote(join(dir, 'claude'))
  const define = basename(shell) === 'fish' ? `function claude; ${script} $argv; end` : `'claude'() { ${script} "$@"; }`
  return typed === undefined ? define : `${define}; ${typed}`
}

/**
 * The `claude` script of a seat's folder (KERNEL-998). It finds the real `claude` on the PATH without its own folder and runs it
 * wired into Kernel: the MCP config file (which holds the token, so argv never does), the chat's system prompt and, when the
 * chat has a session, `--resume`. A command line that already names a session or `--continue` keeps its own.
 */
export function claudeScript(dir: string): string {
  return `#!/bin/sh
self=${quote(dir)}
real=
oldifs=$IFS
IFS=:
for d in $PATH; do
  [ -z "$d" ] && continue
  [ "$d" = "$self" ] && continue
  if [ -f "$d/claude" ] && [ -x "$d/claude" ]; then real="$d/claude"; break; fi
done
IFS=$oldifs
if [ -z "$real" ]; then echo "claude was not found on your PATH." >&2; exit 127; fi
own=
for a in "$@"; do
  case "$a" in --resume|--resume=*|-r|--continue|-c|--session-id|--session-id=*) own=1 ;; esac
done
if [ -s "$self/session" ] && [ -z "$own" ]; then set -- --resume "$(cat "$self/session")" "$@"; fi
set -- --mcp-config "$self/mcp.json" --append-system-prompt "$(cat "$self/prompt.txt")" "$@"
exec "$real" "$@"
`
}

export interface SeatFiles { url: string; token: string; prompt: string; sessionId?: string }

/** Writes the seat's folder, all of it again each time its pty starts. The file with the token is 0600. */
export function writeSeatDir(dir: string, f: SeatFiles) {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const config = { mcpServers: { [KERNEL_SERVER]: { type: 'http', url: f.url, headers: { Authorization: `Bearer ${f.token}` } } } }
  writeFileSync(join(dir, 'mcp.json'), JSON.stringify(config), { mode: 0o600 })
  chmodSync(join(dir, 'mcp.json'), 0o600)
  writeFileSync(join(dir, 'prompt.txt'), f.prompt)
  writeSeatSession(dir, f.sessionId)
  writeFileSync(join(dir, 'claude'), claudeScript(dir), { mode: 0o755 })
  chmodSync(join(dir, 'claude'), 0o755)
}

/** The session the seat's next `claude` resumes. None removes it. */
export function writeSeatSession(dir: string, sessionId: string | undefined) {
  try {
    if (sessionId) writeFileSync(join(dir, 'session'), sessionId)
    else rmSync(join(dir, 'session'), { force: true })
  } catch { /* the folder is gone, with its seat */ }
}

export const withDirFirst = (dir: string, path: string | undefined) => [dir, ...(path ?? '').split(delimiter).filter((p) => p && p !== dir)].join(delimiter)

export const removeSeatDir = (dir: string) => rmSync(dir, { recursive: true, force: true })
