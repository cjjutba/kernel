# Draft, to confirm with a live run

Agents can't run the live tests (D-023). So this draft rests on the pinned SDK's types (0.3.292), the Claude Code CLI bundled with that SDK (2.1.292), the Codex protocol and binary (0.153.4) and the live findings in KERNEL-406. `test/live.sandbox.test.ts` checks every answer below. The maintainer confirms it with:

```
KERNEL_LIVE=1 KERNEL_LIVE_OUT=shots/sandbox-live.json pnpm test test/live.sandbox.test.ts
```

It spends two short Haiku turns in Bypass. Codex's sandbox runs through app-server's `command/exec`, with no model. The gh rows need gh signed in with its token in the Keychain, and the bind row needs `node` on the PATH. Without them those rows drop out. The test's `EXPECTED` table holds this file's answers. Where the run disagrees, the run wins: fix the table and this file, then drop the heading.

**Claude's `sandbox` option sets real write paths and domains, and the sdk.d.ts comment that says otherwise is out of date.** The comment on `Options.sandbox` (sdk.d.ts:2155 to 2166) says filesystem and network restrictions come from `Read`, `Edit` and `WebFetch` permission rules, "not via these sandbox settings". The schema (:3432 to :3463, :3470 to :3569) has `filesystem.allowWrite`, `denyWrite`, `denyRead` and `allowRead`, and `network.allowedDomains`, `deniedDomains`, `strictAllowlist` and `allowLocalBinding`. The pinned CLI's own settings schema settles it. `allowWrite` is "Additional paths to allow writing within the sandbox. Merged with paths from Edit(...) allow permission rules", and `allowedDomains` is "Domains sandboxed commands may reach without a prompt". So both feed the sandbox. The SDK's code (`iq` in sdk.mjs) adds three things:
- The option reaches the CLI as the `sandbox` key of `--settings`, a layer the CLI trusts. The CLI honors `strictAllowlist` and `allowUnsandboxedCommands: false` from there, and ignores a project's `.claude/settings.json` that tries to loosen them.
- It replaces any `sandbox` key in an object passed as `settings`, and throws when `settings` is a file path. Kernel passes an object (the room's switched-off skills and MCP servers), so A10 puts the whole sandbox in the option.
- With `enabled: true` and no `failIfUnavailable`, the SDK sets `failIfUnavailable: true`. The CLI's own default is false, which is what the schema's description says.

**What each case does today.** The Claude column is the sandbox on, in Bypass, with nothing added. The Codex column is `workspace-write` as the runner sets it (KERNEL-406): the git common dir as a writable root, and network as Settings, Permissions says, here on. Under `untrusted`, a command Kernel accepts runs with no sandbox at all (KERNEL-406). So the Codex column covers the commands Codex runs without asking, and every command under `never` or `on-request`.

| Case | Claude | Codex |
| --- | --- | --- |
| A commit in a worktree | Fails. Git writes the index, the objects and the branch's ref in the repo's git common dir, outside the worktree. | Works, because the common dir is a writable root. |
| A write outside the folder | Fails. By default a command may write only the worktree, `/tmp/claude`, `~/.npm/_logs` and `~/.claude/debug`. | Fails, except in `$TMPDIR` and `/tmp`, which `workspace-write` allows unless told not to. |
| `curl` to an unlisted domain | Goes through. When a sandboxed command reaches an unlisted host, the CLI decides by mode: Bypass allows, Auto asks its classifier, dontAsk denies, and the other modes ask the user. Only `strictAllowlist: true` refuses before that. | Goes through with network on, fails with it off. `networkAccess` is one switch. Codex's per-domain lists belong to its experimental managed proxy (`experimental_network` and permission profiles), which Kernel doesn't use. |
| `node_modules` linked into the main checkout | Reads work, writes fail. Both sandboxes read everywhere, and both check a write against the link's real path, which is in the main checkout. `pnpm install` in the worktree fails, and so does anything that keeps a cache there, such as Vite's `node_modules/.vite`. | Same as Claude. |
| Writing the git common dir | Fails unless added. Once added, `.git/hooks` and `.git/config` stay read-only. The CLI always protects them, along with shell rc files, `.mcp.json`, `.vscode`, `.idea`, `.claude/commands` and `.claude/agents`. | Works, all of it. `writableRoots` has no deny list, so a command can write `hooks/` and `config`. |
| gh reaching the Keychain | Works: the Seatbelt profile allows `com.apple.SecurityServer`. gh's API calls probably fail. gh is written in Go, Go checks certificates through `com.apple.trustd.agent`, and the profile allows that only with `enableWeakerNetworkIsolation`. The bare run's `ghApi` row decides. | Works with network on. Codex allows `com.apple.SecurityServer` only with network access, and always allows trustd. With network off, gh can't read its token. |

Two more Claude settings matter in Bypass. `allowUnsandboxedCommands` defaults to true, which lets the model set `dangerouslyDisableSandbox` on a Bash call. The CLI then asks for permission, and Bypass says yes. With false, the CLI ignores the parameter. `allowLocalBinding` defaults to false, so a dev server can't listen on localhost.

**A10 runs Bypass on Claude inside this sandbox.** Each chat's session gets one `sandbox` option:

```ts
sandbox: {
  enabled: true,
  failIfUnavailable: false,
  allowUnsandboxedCommands: false,
  filesystem: { allowWrite: [gitCommonDir, nodeModulesTarget, userTmp, ...caches] },
  network: { allowedDomains: [...github, ...registries], strictAllowlist: true, allowLocalBinding: true },
  enableWeakerNetworkIsolation: true
}
```

- `gitCommonDir` is `git rev-parse --path-format=absolute --git-common-dir` in the worktree, so commits, branches and stashes work. Hooks and config stay protected. The agent can still move any local branch, as any git command could.
- `nodeModulesTarget` is the real path of the worktree's `node_modules` when `linkNodeModules` made it a link. The cost: a write there changes the packages the main checkout runs outside the sandbox. Kernel already shares that folder between worktrees, and without the write `pnpm dev` on Vite fails.
- `userTmp` is the real path of Kernel's own `os.tmpdir()`, `/private/var/folders/.../T`. The CLI points a sandboxed command's `TMPDIR` at a folder of its own under `/tmp/claude`, which the command can write. Tools that ask macOS for the per-user temp folder instead of reading `TMPDIR` land in `userTmp`.
- `caches` are whichever of these exist: `~/.npm`, `~/Library/pnpm/store`, `~/Library/Caches/pnpm`, `~/Library/Caches/Yarn`, `~/.yarn/berry`, `~/.bun/install/cache` and `~/.cache/node/corepack`. Defaults only. Asking each tool for its path would start several processes per chat, and few people move these.
- `allowedDomains` is GitHub (`github.com`, `*.github.com` and `*.githubusercontent.com`, for git over HTTPS, the API, raw files and release downloads) and the npm registries (`registry.npmjs.org`, `registry.yarnpkg.com` and `repo.yarnpkg.com`). pnpm and Bun install from the npm registry. Other ecosystems wait for A11's settings rows.
- `strictAllowlist: true`, or Bypass lets every other host through and the list means nothing.
- `allowLocalBinding: true`, for dev servers and the run script on `$KERNEL_PORT`.
- `allowUnsandboxedCommands: false`, or the model can leave the sandbox and Bypass approves it.
- `failIfUnavailable: false`, with a note in the chat when the sandbox falls back (A10). The macOS sandbox is Seatbelt, which ships with the OS, so a fallback should be rare.
- `enableWeakerNetworkIsolation: true` only if the live run's bare `ghApi` row is denied and its A10 row allowed. It opens `com.apple.trustd.agent`, which the CLI calls a possible exfiltration path. If gh works without it, A10 leaves it off.

The live test doesn't cover git over SSH. The sandbox proxies HTTP and SOCKS, and nothing checks `ssh` to port 22. A repo's own `.claude/settings.json` can also add `allowWrite` paths, since Kernel loads project settings. The maintainer's call stands: the sandbox runs in Bypass only until a live run confirms these answers. KERNEL-436.

**Codex keeps KERNEL-406's sandbox for now, and that sandbox leaves the repo's git hooks writable.** Bypass on Codex keeps `untrusted` (the plan's open decision 4), so whatever Kernel accepts runs unsandboxed and A10's list doesn't apply to it. The gap is the common dir. As a writable root, it lets a sandboxed command write `.git/hooks` and `.git/config`, and the live run's `hooks` and `config` rows check that. A patch probably can too, since `approveFiles` accepts any change without a `grantRoot` in Accept edits and Bypass. Nothing tests the patch path yet. A hook planted there runs the next time Kernel itself runs git outside any sandbox, for example `post-checkout` when it adds the next worktree. Codex's Bypass ticket has to close this. One way is narrower roots: `objects`, `refs`, `logs` and `worktrees/<name>` instead of the whole common dir. That breaks git commands that lock a file in the common dir itself, such as packing refs. The other way is a deny entry, once Codex's permission profiles leave experimental. KERNEL-436.
