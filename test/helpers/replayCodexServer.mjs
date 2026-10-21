// A stand-in for `codex app-server` that plays a recording (test/fixtures/replay/README.md): JSON-RPC over stdio, one message per
// line, the way Kernel's real Rpc speaks it. REPLAY_FILE is the recording, REPLAY_LOG the file it reports to.
//
// Frames are `{ dir, msg }` with `msg` a JSON-RPC message. It sends every `in` frame up to the next `out` frame, then waits for
// Kernel. Each message Kernel sends must match the next `out` frame (see mismatch in replayMatch.mjs). A request's id is left out
// of the comparison, and an `in` response without an id answers the oldest request Kernel is still waiting on. A request the
// recording sends (an approval) carries its own id, and Kernel's answer must carry it back. Methods in the header's `ignore` list
// are answered with `{}` and are not part of the order.
//
// The first message that doesn't match ends the process with exit code 3 and a `{ failed }` line in the log, which names the frame.
// After every step the log gets `{ consumed }`, the number of frames played so far.
import { appendFileSync, readFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { mismatch, parseReplay, show } from './replayMatch.mjs'

const { header, frames } = parseReplay(readFileSync(process.env.REPLAY_FILE, 'utf8'), process.env.REPLAY_FILE)
const ignore = new Set(header.ignore ?? [])
const log = (entry) => appendFileSync(process.env.REPLAY_LOG, JSON.stringify(entry) + '\n')
const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n')

let at = 0
// The ids of Kernel's requests that wait for an `in` response, oldest first.
const owed = []

const fail = (reason, actual) => {
  log({ failed: { frame: at + 1, line: at + 2, reason, expected: show(frames[at]), actual } })
  process.exit(3)
}

/** Sends every `in` frame up to the next `out` one. */
function advance() {
  while (at < frames.length && frames[at].dir === 'in') {
    const { msg } = frames[at]
    if (!msg) fail('an "in" frame needs a "msg"')
    if (msg.method === undefined && msg.id === undefined) {
      if (!owed.length) fail('the recording answers a request Kernel has not sent')
      send({ id: owed.shift(), ...msg })
    } else send(msg)
    at++
  }
  log({ consumed: at, of: frames.length })
}

createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return
  const actual = JSON.parse(line)
  log({ out: actual })
  if (actual.method !== undefined && ignore.has(actual.method)) { if (actual.id !== undefined) send({ id: actual.id, result: {} }); return }
  const frame = frames[at]
  if (!frame || frame.dir !== 'out') return fail(frame ? 'Kernel sent a message while the recording expected nothing' : 'Kernel sent a message after the recording ended', actual)
  // A request's id is Kernel's own counter. A response keeps its id: it must be the one the recording's request carried.
  const { id, ...rest } = actual
  const compared = actual.method === undefined ? actual : rest
  const { id: _expectedId, ...expected } = frame.msg ?? {}
  const why = mismatch(actual.method === undefined ? frame.msg : expected, compared)
  if (why) return fail(why, actual)
  if (actual.method !== undefined && id !== undefined) owed.push(id)
  at++
  advance()
})

advance()
