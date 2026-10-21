import { readFile } from 'node:fs/promises'
import type { CanUseTool, Options } from '@anthropic-ai/claude-agent-sdk'
import { mismatch, parseReplay, show, type ReplayFrame, type ReplayHeader } from './replayMatch.mjs'

// A stand-in for the SDK's `query()` that plays a recording (test/fixtures/replay/README.md). A test mocks the SDK with
// `replayQuery` and loads a recording with `claudeReplay` before it sends the chat's first message.
//
// Frames, with `dir` as in every recording:
//   in  { msg }                     an SDK message, delivered to Kernel in order
//   in  { ask: { tool, input, toolUseID } }   Claude Code asks `canUseTool`, and the stream stops until Kernel answers
//   in  { exit: true }              the process ends on its own
//   out { query: { ...options } }   the options `query()` was called with, the keys named only. Always the first frame
//   out { user: { text } }          a message Kernel sent (the first text block)
//   out { interrupt: true }         Kernel interrupted the turn
//   out { answer: { ... } }         what `canUseTool` returned for the last `ask`
// The first thing Kernel does that the next frame doesn't allow fails the replay: the frame number goes into the error and
// the stream, so the chat ends with it, and `assertDone()` throws it.

export interface ClaudeReplay {
  header: ReplayHeader
  /** The `query()` options, once Kernel has called it. */
  options?: Options
  /** Throws the first thing Kernel sent that the recording did not expect. */
  assertNoMismatch(): void
  /** Throws on a mismatch, or when the recording was not played to its end. */
  assertDone(): void
}

class Replay implements ClaudeReplay {
  options?: Options
  private at = 0
  private failure?: Error
  private started = false
  private ended = false
  private asking = false
  private aborted?: Error
  private readonly ready: IteratorResult<unknown>[] = []
  private readonly waiters: { resolve: (r: IteratorResult<unknown>) => void; reject: (e: Error) => void }[] = []

  constructor(readonly header: ReplayHeader, private readonly frames: ReplayFrame[], private readonly file: string) {}

  assertNoMismatch() { if (this.failure) throw this.failure }

  assertDone() {
    this.assertNoMismatch()
    if (this.at < this.frames.length) throw new Error(`${this.header.scenario}: the replay stopped at frame ${this.at + 1} of ${this.frames.length} (line ${this.at + 2} of ${this.file}): Kernel never did what the recording expects next: ${show(this.frames[this.at])}`)
  }

  /** `query()` was called. */
  start(prompt: AsyncIterable<any>, options: Options & { abortController?: AbortController }) {
    if (this.started) return this.fail('Kernel called query() a second time, and the recording has one session', options)
    this.started = true
    this.options = options
    // An aborted stream gives what was delivered, then throws, as the SDK does.
    options.abortController?.signal.addEventListener('abort', () => {
      this.aborted = new Error('Claude Code process aborted by user')
      for (const w of this.waiters.splice(0)) w.reject(this.aborted)
    })
    this.expect('query', options)
    void (async () => { for await (const m of prompt) this.expect('user', { text: m.message?.content?.[0]?.text }) })()
  }

  interrupt() { this.expect('interrupt', true) }

  /** The stream Kernel reads: what the recording sends, then it waits, then it ends or is aborted. */
  next(): Promise<IteratorResult<unknown>> {
    if (this.ready.length) return Promise.resolve(this.ready.shift()!)
    if (this.failure) return Promise.reject(this.failure)
    if (this.aborted) return Promise.reject(this.aborted)
    if (this.ended) return Promise.resolve({ value: undefined, done: true })
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }))
  }

  private deliver(r: IteratorResult<unknown>) { const w = this.waiters.shift(); if (w) w.resolve(r); else this.ready.push(r) }

  private fail(reason: string, actual: unknown) {
    const error = new Error(`${this.header.scenario}: frame ${this.at + 1} (line ${this.at + 2} of ${this.file}) did not match: ${reason}\nexpected ${show(this.frames[this.at])}\nKernel did ${JSON.stringify(actual, (_k, v) => (typeof v === 'function' ? '[function]' : v))?.slice(0, 400)}`)
    this.failure ??= error
    for (const w of this.waiters.splice(0)) w.reject(error)
  }

  /** Kernel did something. It must be what the next frame says, and then the recording plays on. */
  private expect(kind: 'query' | 'user' | 'interrupt' | 'answer', actual: unknown) {
    if (this.failure) return
    const frame = this.frames[this.at]
    if (!frame || frame.dir !== 'out') return this.fail(frame ? 'Kernel acted while the recording expected the provider to go on' : 'Kernel acted after the recording ended', { [kind]: actual })
    if (frame[kind] === undefined) return this.fail(`the recording expects another kind of frame, not "${kind}"`, { [kind]: actual })
    const why = mismatch(frame[kind], actual)
    if (why) return this.fail(why, { [kind]: actual })
    this.at++
    this.advance()
  }

  /** Delivers every `in` frame up to the next `out` one, or up to a question Kernel has to answer first. */
  private advance() {
    while (!this.failure && !this.asking && this.at < this.frames.length && this.frames[this.at].dir === 'in') {
      const frame = this.frames[this.at++]
      if (frame.msg) this.deliver({ value: frame.msg, done: false })
      else if (frame.exit) { this.ended = true; for (const w of this.waiters.splice(0)) w.resolve({ value: undefined, done: true }) }
      else if (frame.ask) this.ask(frame.ask as { tool: string; input: Record<string, unknown>; toolUseID: string })
      else this.fail('an "in" frame needs "msg", "ask" or "exit"', frame)
    }
  }

  private ask({ tool, input, toolUseID }: { tool: string; input: Record<string, unknown>; toolUseID: string }) {
    this.asking = true
    const answer = (this.options!.canUseTool as CanUseTool)(tool, input, { signal: new AbortController().signal, toolUseID, requestId: `req-${toolUseID}` } as never)
    void answer.then((result) => {
      this.asking = false
      this.expect('answer', result)
    })
  }
}

const state: { next?: Replay; calls: number } = { calls: 0 }

/** Loads a recording for the next `query()` call. */
export async function claudeReplay(file: string): Promise<ClaudeReplay> {
  const { header, frames } = parseReplay(await readFile(file, 'utf8'), file)
  const replay = new Replay(header, frames, file)
  state.next = replay
  return replay
}

/** The SDK's `query`, for `vi.mock('@anthropic-ai/claude-agent-sdk', ...)`. */
export function replayQuery({ prompt, options }: { prompt: AsyncIterable<unknown>; options: Options }) {
  const replay = state.next
  if (!replay) throw new Error('query() was called with no recording loaded: call claudeReplay() first')
  state.next = undefined
  state.calls++
  replay.start(prompt, options)
  return {
    [Symbol.asyncIterator]: () => ({ next: () => replay.next() }),
    interrupt: async () => { (replay as any).interrupt() },
    setModel: async () => {},
    setPermissionMode: async () => {},
    initializationResult: async () => ({ models: [] }),
    applyFlagSettings: async () => {}
  }
}
