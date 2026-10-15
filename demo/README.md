# Landing page demo

The hero on the landing page is the real Kernel renderer, running in a browser on sample data. This folder builds it.

```bash
pnpm demo:build   # writes site/public/demo, which the site serves at /demo/index.html
pnpm demo:clips   # builds demo/scenes and records the feature clips into site/public/clips (needs ffmpeg)
```

Both outputs are committed, so the site deploys from `site/` alone, without the Electron app's dependencies. Run them again after a change to the renderer that the hero or a clip shows, and commit what they write.

- `bridge.ts` plays the preload's part. It installs `window.kernel` before the renderer boots, and answers every call from the story first and then from the fixture handlers that `KERNEL_FIXTURES=<Screen> pnpm dev` uses.
- `story.ts` is the whole loop from a blank chat, on sample data. It opens on New chat in a room called Kernel. Your brief gets a reply in Accept edits mode that says the demo plans one sample change and to switch to Plan. In plan mode, asking for the plan gets the full write-up (Why, Behavior, Files, Checks, Tracker) and three tasks. Approving it hands them to Noor, Kai and Ivy, whose workspaces appear under the chat and build on their own. Each opens a PR, a team update reaches Kernel, Theo reviews it in a workspace of his own, and the PR is ready to merge. Each click changes the fixture and pushes the same events the engine would. Two test accounts on Claude Code and two on Codex fill the usage footer and the account menu, and switching between them works.
- `guide.ts` shows one hint at a time, at the next real control. It goes as soon as the visitor does what it asks (opens a workspace, merges a PR), hides while a menu is open, and moves on with the story. Nothing clicks by itself. It tells the site `ready` with `postMessage` and listens for `restart`.
- `chrome.ts` draws the Mac window's traffic lights, which macOS draws for the real app.
- `focus.ts` clears the renderer's saved state so every visit starts fresh, and stops focus inside the demo from scrolling the page.
- `shims/` are browser stand-ins for the Node modules the fixture handlers import. Calling anything the demo doesn't need throws.

Anything the demo can't do, like starting a new chat, answers with a message that says it works in the app.

## Feature clips

The bento on the landing page plays clips recorded from the same renderer.

- `scenes/` is a second build (`vite.scenes.config.ts`, into `out/scenes`, never shipped). `?scene=<name>` picks a scene: the hero's story, or a `pnpm shots` fixture with sample names in place of real ones, moved on by the same push events the engine sends.
- `clips.ts` (`node demo/clips.ts --encode` re-encodes without recording) opens each scene at 1440x900 and 2x, moves a drawn cursor to what it clicks, and captures every frame Chrome paints. Each clip also moves a camera that zooms in on each step. The page itself never moves: after recording, every frame is drawn from the 2x capture through the camera's view, then ffmpeg encodes an MP4 and a poster. `pnpm demo:clips reviews` records one.
