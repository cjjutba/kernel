# UX audit: app shell and platform

Pre-launch audit of the sidebar, toasts, update card, onboarding, Settings, the modal shell and the confirms. Nothing under `src/` changed. Shots are in `shots/<Fixture>.png` (git ignored, regenerate with `pnpm shots <Fixture>`), and the contact sheet is shared in the PR.

The six questions: 1 plain words, 2 says what to do next with a real button, 3 reachable and leavable by keyboard, 4 matches DESIGN.md, 5 recovers on its own, 6 survives a restart and a resize.

How I checked: every state below was rendered with `pnpm shots` and looked at. The keyboard and focus results come from reading `ui/overlays.tsx` and the components, not from driving a real window, so they are marked "code". I did not run a live keyboard walk.

Counts: blocker 0, major 6, minor 2, polish 2.

## Major

**M1. A failed update says nothing outside About.** Fixture `AuditHomeUpdateError` (shot identical to a normal Home). The footer pill and update card only appear for `status: 'ready'`. A failed or blocked update is visible only in Settings, About, as "Could not check for updates". Fails 1, 2, 5. Direction: show a quiet footer line with a Try again button when the update fails, and clear it when a later check succeeds.

**M2. A download shows no progress and the button stays live.** Fixtures `AuditAboutDownloading`, `AuditHomeUpdateDownloading`. About says "Downloading version 0.2.0" with no percentage although `progress` is sent, "Check for updates" stays enabled, and Home shows nothing. Fails 1, 4 (busy button pattern). Direction: show the percentage, make the button busy with "Downloading", and add the footer state from M1.

**M3. The setup checks can wait forever.** Fixture `AuditSetupChecksWaiting`. "Checking" with a disabled Continue, no time limit and no other button. If the preflight call never answers, the only way out is quitting. Fails 2, 5. Direction: after about 10 seconds say it is taking longer and offer Check again.

**M4. First launch with no room reads "You're all caught up".** Fixture `AuditFirstLaunchHome`. Inbox says nothing needs you, "Your rooms" is an empty header, and no button says to add a repo. New users see a finished state instead of a first step. Fails 1, 2. Direction: when there are no rooms, replace the inbox empty state with "Add your first room" and a real button.

**M5. Settings can show a blank page while its data loads or fails.** No fixture (holding `settings.get` also blocks the harness's ready signal, so it cannot be drawn). Code: `Settings.tsx` renders `body = null` while `settings` is null, and `useRoomSettings` ends in `.catch(() => undefined)`. Fails 1, 2, 5. Direction: render the page title with a Spinner, and an error with Try again when the load fails.

**M6. Action toasts are hard to reach by keyboard (code).** Fixtures `AuditToastsStacked`. Toasts last 5 seconds, hold on hover or focus, and dismiss only by swipe. Escape does not dismiss, and there is no close button. The Undo after an account switch is a link at the end of the page, so a keyboard user has no realistic way to press it in time. With three toasts and the update card, four cards stack, each on its own timer. Fails 3. Direction: let Escape dismiss the newest toast, make Undo reachable from a shortcut, and cap the stack at three.

## Minor

**m1. A long toast has no height limit.** Fixture `AuditToastLong`. A two-line title and a path wrap into a card eight lines tall, and the path breaks mid-word. Fails 4. Direction: clamp the sub to three lines and break paths at slashes.

**m2. Escape on the usage-data question is a permanent "Don't share".** Fixture `TelemetryAsk`. `onCancel` saves `off`, so pressing Escape by habit answers for good. Initial focus is on "See what's sent", not the primary. Fails 1, 3. Direction: let Escape close without saving, and ask again next launch.

## Polish

**p1. The update card has a close button, toasts do not.** `AuditToastsStacked`, `UpdateReady`. DESIGN.md says toasts have no close button. Direction: pick one.

**p2. The update error has no reason.** `AuditAboutUpdateError`. "Could not check for updates" hides the cause (the fixture carries `net::ERR_INTERNET_DISCONNECTED`). Direction: say "No internet connection" when offline.

## States that pass

`WorkspaceOffline` (says what happens, Try again), `WorkspaceSignedOut` (Sign in, Open terminal, composer paused), `SetupClaudeMissing` (command, Copy, Check again), `ConfirmRemoveRoom` (one step, red only on the final button, worktree deletion is an opt-in checkbox), `ConfirmArchive`, `ConfirmBypass`, `AuditSidebarWide` (480px, no clipping), `WorkspaceHistoryButtonsNarrow` (200px), `UpdateReadyNoSidebar`, `UsageFooterNarrow`, `AuditAboutUpdateBlocked`, `LoadingError` (alert with Try again), `SettingsAccountsCodexSignedOut`, `SettingsTeamEmpty`.

## Modal shell and confirms (code)

`Modal` traps Tab between its first and last focusable, closes on Escape through `useLayer`, and returns focus to the element focused before it opened. Confirms use the one 460px shell with `role="alertdialog"`. Only the final confirm is red. A second step is only warranted where something is lost for good (discard, delete history, remove room with worktrees), and the current confirms match that.

## States with no fixture

- Settings page while its data loads or fails to load (M5).
- Quit mid-onboarding and reopen, a real network drop, and the Mac waking mid-onboarding: they need a real process or sleep, not a fixture.
- App-level offline outside a workspace: only the workspace banner exists, and no fixture sets a global offline state.
- Focus return after a modal closes, and Tab trapping: they need a live window.
- Settings search with no results: needs a typed query, so it needs an `interactions` entry in `scripts/shots.ts`.
- Sidebar with very many rooms and long names: the room seed is fixed in `fixtures/base.ts`, which the other audits share.

## New fixtures

All in `fixtures/platform.ts`, prefixed `Audit`: `AuditAboutChecking`, `AuditAboutDownloading`, `AuditAboutUpdateError`, `AuditAboutUpdateBlocked`, `AuditHomeUpdateDownloading`, `AuditHomeUpdateError`, `AuditToastsStacked`, `AuditToastLong`, `AuditFirstLaunchHome`, `AuditSetupChecksWaiting`, `AuditSidebarWide` (with an `interactions` entry in `scripts/shots.ts`). Reused: the fixtures named under "States that pass" and `UpdateReady`, `Welcome`, `LoadingApp`, `CheckHooks`, `SetupPermissions`, `InboxEmpty`, `SettingsAbout`, `SettingsPrivacy`.
