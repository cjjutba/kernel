# UX audit: app shell and platform

Pre-launch audit of the sidebar, toasts, update card, onboarding, Settings, the modal shell and the confirms. Nothing under `src/` changed. Shots are in `shots/<Fixture>.png` (git ignored, regenerate with `pnpm shots <Fixture>`), and the contact sheet is shared in the PR.

The six questions: 1 plain words, 2 says what to do next with a real button, 3 reachable and leavable by keyboard, 4 matches DESIGN.md, 5 recovers on its own, 6 survives a restart and a resize.

How I checked: every state below was rendered with `pnpm shots` and looked at. The first pass read the keyboard paths from code. The re-audit below ran them live.

Counts at the first audit: blocker 0, major 6, minor 2, polish 2.

## Re-audit after the UX pass (KERNEL-872)

Rechecked on `a9e880daf`, after KERNEL-859 to 871 merged. Every fixture named here was shot again and set beside its before shot on the sheet shared in the PR. The keyboard and focus paths were driven in a hidden Electron window (`KERNEL_HEADLESS=1`, Playwright), not read from code. Each finding below carries a **Status** line. "Fixed (code)" means the fix is in the source and no fixture can draw it, so it was read, not run.

Result: 9 fixed (M5 by code only), and m2 fixed in part (the close is unverified, KERNEL-882).
One thing could not be proved: **focus return after a modal closes.** The fixtures open `ConfirmArchive` and `TelemetryAsk` directly, with no trigger, so there is nothing to return to. Tab trapping and Escape were walked live on `ConfirmArchive` (Tab cycles Archive anyway, Cancel, Push and archive and the input, Escape closes). The `TelemetryAsk` dialog stayed open after Escape in the fixture, probably because the fixture bypasses the answered flag. The sidebar's Archive button archives with no dialog. Focus after the command palette closes is a real miss, see the team audit (n1).

## Major

**M1. A failed update says nothing outside About.** Fixture `AuditHomeUpdateError` (shot identical to a normal Home). The footer pill and update card only appear for `status: 'ready'`. A failed or blocked update is visible only in Settings, About, as "Could not check for updates". Fails 1, 2, 5. Direction: show a quiet footer line with a Try again button when the update fails, and clear it when a later check succeeds.

**Status: fixed.** The footer shows "No internet connection" with Try again. After: `AuditHomeUpdateError`.

**M2. A download shows no progress and the button stays live.** Fixtures `AuditAboutDownloading`, `AuditHomeUpdateDownloading`. About says "Downloading version 0.2.0" with no percentage although `progress` is sent, "Check for updates" stays enabled, and Home shows nothing. Fails 1, 4 (busy button pattern). Direction: show the percentage, make the button busy with "Downloading", and add the footer state from M1.

**Status: fixed.** About reads "Downloading version 0.2.0, 42%", the button is busy as "Downloading", and the footer shows "Downloading update 42%". After: `AuditAboutDownloading`, `AuditHomeUpdateDownloading`.

**M3. The setup checks can wait forever.** Fixture `AuditSetupChecksWaiting`. "Checking" with a disabled Continue, no time limit and no other button. If the preflight call never answers, the only way out is quitting. Fails 2, 5. Direction: after about 10 seconds say it is taking longer and offer Check again.

**Status: fixed.** After a while the page says "Still checking" and offers Check again. After: `AuditSetupChecksSlow`.

**M4. First launch with no room reads "You're all caught up".** Fixture `AuditFirstLaunchHome`. Inbox says nothing needs you, "Your rooms" is an empty header, and no button says to add a repo. New users see a finished state instead of a first step. Fails 1, 2. Direction: when there are no rooms, replace the inbox empty state with "Add your first room" and a real button.

**Status: fixed.** Home says "Add your first room" with Connect a repo and Open a folder. After: `AuditFirstLaunchHome`.

**M5. Settings can show a blank page while its data loads or fails.** No fixture (holding `settings.get` also blocks the harness's ready signal, so it cannot be drawn). Code: `Settings.tsx` renders `body = null` while `settings` is null, and `useRoomSettings` ends in `.catch(() => undefined)`. Fails 1, 2, 5. Direction: render the page title with a Spinner, and an error with Try again when the load fails.

**Status: fixed (code).** `Settings.tsx` has a pending state with a failed variant and a Retry button. No fixture can draw it, so this one is read, not shot.

**M6. Action toasts are hard to reach by keyboard (code).** Fixtures `AuditToastsStacked`. Toasts last 5 seconds, hold on hover or focus, and dismiss only by swipe. Escape does not dismiss, and there is no close button. The Undo after an account switch is a link at the end of the page, so a keyboard user has no realistic way to press it in time. With three toasts and the update card, four cards stack, each on its own timer. Fails 3. Direction: let Escape dismiss the newest toast, make Undo reachable from a shortcut, and cap the stack at three.

**Status: fixed.** Walked live: with three toasts stacked, Escape dismissed the newest (3 to 2), and ⌘⌥Z pressed Undo on the next (2 to 1). The stack holds three. After: `AuditToastsStacked`.

## Minor

**m1. A long toast has no height limit.** Fixture `AuditToastLong`. A two-line title and a path wrap into a card eight lines tall, and the path breaks mid-word. Fails 4. Direction: clamp the sub to three lines and break paths at slashes.

**Status: fixed.** The sub is clamped with an ellipsis. After: `AuditToastLong`.

**m2. Escape on the usage-data question is a permanent "Don't share".** Fixture `TelemetryAsk`. `onCancel` saves `off`, so pressing Escape by habit answers for good. Initial focus is on "See what's sent", not the primary. Fails 1, 3. Direction: let Escape close without saving, and ask again next launch.

**Status: fixed in part, KERNEL-882.** Escape now sends no settings call, so it no longer answers "Don't share" for good (walked live on `TelemetryAsk`). In that fixture the dialog stayed open, which looks like a fixture artifact (the fixture opens it directly, bypassing the answered flag). Not proven either way, so the close itself is unverified.

## Polish

**p1. The update card has a close button, toasts do not.** `AuditToastsStacked`, `UpdateReady`. DESIGN.md says toasts have no close button. Direction: pick one.

**Status: fixed.** The update card has no close button. After: `UpdateReady`.

**p2. The update error has no reason.** `AuditAboutUpdateError`. "Could not check for updates" hides the cause (the fixture carries `net::ERR_INTERNET_DISCONNECTED`). Direction: say "No internet connection" when offline.

**Status: fixed.** The error reads "No internet connection". After: `AuditAboutUpdateError`.

## States that pass

`WorkspaceOffline` (says what happens, Try again), `WorkspaceSignedOut` (Sign in, Open terminal, composer paused), `SetupClaudeMissing` (command, Copy, Check again), `ConfirmRemoveRoom` (one step, red only on the final button, worktree deletion is an opt-in checkbox), `ConfirmArchive`, `ConfirmBypass`, `AuditSidebarWide` (480px, no clipping), `WorkspaceHistoryButtonsNarrow` (200px), `UpdateReadyNoSidebar`, `UsageFooterNarrow`, `AuditAboutUpdateBlocked`, `LoadingError` (alert with Try again), `SettingsAccountsCodexSignedOut`, `SettingsTeamEmpty`.

## Modal shell and confirms (walked live, return to trigger not proved)

`Modal` traps Tab between its first and last focusable and closes on Escape through `useLayer` (walked live on `ConfirmArchive`). It is meant to return focus to the element focused before it opened. That was not shown live, see the re-audit note. Confirms use the one 460px shell with `role="alertdialog"`. Only the final confirm is red. A second step is only warranted where something is lost for good (discard, delete history, remove room with worktrees), and the current confirms match that.

## States with no fixture

- Settings page while its data loads or fails to load (M5). Still no fixture, so the fix is code only.
- Quit mid-onboarding and reopen, a real network drop, and the Mac waking mid-onboarding: they need a real process or sleep, not a fixture.
- App-level offline outside a workspace: only the workspace banner exists, and no fixture sets a global offline state.
- Focus return after a modal closes: needs a fixture that opens the modal from a trigger. Tab trapping and Escape were walked live in the re-audit.
- Settings search with no results: needs a typed query, so it needs an `interactions` entry in `scripts/shots.ts`.
- Sidebar with very many rooms and long names: the room seed is fixed in `fixtures/base.ts`, which the other audits share.

## New fixtures

The UX pass added `AuditSetupChecksSlow`.

All in `fixtures/platform.ts`, prefixed `Audit`: `AuditAboutChecking`, `AuditAboutDownloading`, `AuditAboutUpdateError`, `AuditAboutUpdateBlocked`, `AuditHomeUpdateDownloading`, `AuditHomeUpdateError`, `AuditToastsStacked`, `AuditToastLong`, `AuditFirstLaunchHome`, `AuditSetupChecksWaiting`, `AuditSidebarWide` (with an `interactions` entry in `scripts/shots.ts`). Reused: the fixtures named under "States that pass" and `UpdateReady`, `Welcome`, `LoadingApp`, `CheckHooks`, `SetupPermissions`, `InboxEmpty`, `SettingsAbout`, `SettingsPrivacy`.
