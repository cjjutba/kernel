# Contributing

Thanks for taking a look. Kernel is a small project with one maintainer, so small, focused pull requests get reviewed fastest.

## Build and run

You need an Apple silicon Mac, Node 22 or later, the Xcode command line tools, and Claude Code.

```sh
pnpm install   # also rebuilds the native modules for Electron
pnpm dev       # runs the app with hot reload
```

`KERNEL_FIXTURES=<Screen> pnpm dev` opens the app on one fixture from `fixtures/`, with no database or sessions. It's the quickest way to work on a single screen.

## Tests

```sh
pnpm test        # vitest on Electron's Node
pnpm typecheck   # main, preload and renderer
pnpm build       # all three bundles
```

Run one file with `pnpm test test/kernel.test.ts`. Plain `pnpm exec vitest` fails because the native modules are built for Electron (D-013 in `docs/DECISIONS.md`).

If you change a screen, run `pnpm shots <Screen>` and attach the shot in `shots/<Screen>.png` to the PR.

## Contributor agreement

Before your first pull request can merge, you sign the [contributor agreement](CLA.md). You keep the copyright on your work. The agreement gives the maintainer a license to use it, including the right to relicense it, so Kernel can later offer commercial licenses or a hosted version.

A bot comments on your first pull request. Reply with the sentence it gives you, and the CLA check turns green. You sign once, and it covers your later pull requests.

## Pull requests

1. Branch from `main`.
2. Keep the PR to one change. If you find an unrelated bug, open an issue for it.
3. Make sure `pnpm test`, `pnpm typecheck` and `pnpm build` pass.
4. Use a Conventional Commits title, for example `fix(workspace): keep the diff open after a revert`.
5. Say what changed and how you checked it. Add screenshots for UI changes.

`AGENTS.md` and `DESIGN.md` hold the project's rules (design tokens, copy style, no fake statuses). They're written for agents but apply to everyone. Check `docs/DECISIONS.md` and `docs/decisions/` before changing something that looks deliberate. New decisions go in `docs/decisions/`, one file each (`docs/decisions/README.md`).
