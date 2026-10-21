# Provider replays

Recorded provider sessions that `test/providerReplay.test.ts` plays through Kernel's real runners with no model: Claude through a fake `query()`, Codex through a fake `codex app-server` process. They catch regressions in how Kernel drives each provider: what it sends, in what order, and what it stores and shows for what comes back.

## Format

One file per scenario, named `<provider>-<scenario>.ndjson`: NDJSON, one JSON value per line.

The first line is the header:

```json
{"provider":"codex","scenario":"plain-turn","description":"A turn with a reasoning summary, a command and the final reply."}
```

`provider` is `claude` or `codex`, and all three fields are required. A Codex header may add `"ignore": ["method", ...]`: requests Kernel sends on the side, answered with `{}` and left out of the order.

Every other line is a frame. `dir` says who sends it:

- `in`: the provider sends it to Kernel. The replay plays every `in` frame up to the next `out` frame, then waits.
- `out`: Kernel is expected to send it. The next thing Kernel does must match it, or the replay fails.

Nothing waits on a timer. The replay moves on when Kernel does what the next `out` frame says, so a scenario that never gets there fails with the frame it stopped at instead of hanging on a sleep.

### Matching

An `out` frame lists only the fields that matter, and the actual message must have them all. Fields it does not name are ignored, which is how ids, timestamps and paths stay out of a recording. Inside a frame:

- `"*"` matches any value that is there
- a string starting with `~` matches a string that contains the rest (`"~You are Sean."`)
- an array matches item by item, with the same length
- anything else must be equal

A failure names the frame and its line, what the frame expected, and what Kernel did: `plain-turn: frame 6 (line 7 of ...) did not match: $.params.input[0].text: expected "Add a pdf_url column", got "Something else"`. Frame numbers count the lines after the header, so frame N is line N + 1. A scenario that ends before the recording does fails with `the replay stopped at frame N`, naming the `out` frame Kernel never sent.

### Claude frames

The fake `query()` takes the frames in this shape:

| Frame | Meaning |
| --- | --- |
| `{"dir":"out","query":{...}}` | The options `query()` was called with, the keys named only. Always the first frame. `resume` is how a resume shows. |
| `{"dir":"out","user":{"text":"..."}}` | A message Kernel pushed into the prompt stream (its first text block). |
| `{"dir":"out","interrupt":true}` | Kernel called `interrupt()`. |
| `{"dir":"in","msg":{...}}` | An SDK message (`system`, `assistant`, `user`, `result`, `rate_limit_event`), as the pinned SDK's `sdk.d.ts` shapes it. |
| `{"dir":"in","ask":{"tool","input","toolUseID"}}` | Claude Code asks `canUseTool`. The stream stops until Kernel answers. |
| `{"dir":"out","answer":{...}}` | What `canUseTool` returned for the last `ask`. |
| `{"dir":"in","exit":true}` | The process ends on its own. |

The stream stays open after the last frame, as the SDK's does between turns, until the test stops the session.

### Codex frames

`{"dir": "in" | "out", "msg": {...}}`, with `msg` a JSON-RPC message as `codex app-server` speaks it, one per line and without the `jsonrpc` field. The generated types are in `src/main/services/providers/codex/protocol/`.

- A request's `id` is Kernel's own counter and is not compared.
- An `in` response has no `id`: the replay gives it the id of the oldest request Kernel is waiting on.
- A request the recording sends, an approval for example, carries its own `id`, and Kernel's `out` response must carry it back.

## Scenarios

Each provider has the same four, each asserting the chat's rows, the approval rows and the agent's statuses:

- `plain-turn`: thinking, streamed text, a tool call and the result
- `approval-allowed`: an approval asked, then allowed
- `interrupt`: the user stops a turn that is running a command
- `resume`: a chat with a saved session id continues after a restart. The test seeds the chat and its rows, since the restart itself is a new process with a new recording

The checked-in files were written by hand from real message shapes. The recorder below replaces them with real ones.

## Recording a real session

`scripts/record-replay.ts` drives the real Claude Agent SDK or the real `codex app-server` through one turn and writes the frames. It spends a real turn on your account, never runs in CI, and refuses to start unless `KERNEL_LIVE=1` is set.

```sh
KERNEL_LIVE=1 node scripts/record-replay.ts claude plain-turn --prompt "Read package.json and tell me the name" --cwd /path/to/side-project
KERNEL_LIVE=1 node scripts/record-replay.ts codex approval-allowed --prompt "Run pnpm install" --cwd /path/to/side-project
```

Options: `--description`, `--model`, `--resume <id>`, `--deny` (decline approvals; the default allows them), `--interrupt-after <n>` (interrupt after the provider's n-th message), `--codex <path>`, `--out <file>` and `--timeout <seconds>`. The default output is `test/fixtures/replay/<provider>-<scenario>.ndjson`.

The recorder keeps what the provider sends as it came, and cuts what it sends itself to the fields Kernel's own requests share (model, thread, input). Before you commit a recording:

- use a throwaway repo, since the file holds paths, ids and the text of the session
- read it for anything private, and for fields a test should not depend on, such as timestamps and token counts, which can stay but need no `out` frame
- keep the scenario small, one behavior each

A recording is played with `claudeReplay(file)` or `codexReplay(file)` from `test/helpers/`. Start a chat, wait for the turn to end with the helpers in `providerReplay.test.ts`, then call `assertDone()` so a recording Kernel left unfinished fails.
