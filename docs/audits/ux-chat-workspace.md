# UX audit: chat and workspace

Audit only. No file under `src/` changed. Scope is `screens/workspace/` and `screens/new-workspace/`, read against the six questions in the brief:

1. Says what is happening in plain words.
2. Says what to do next, with a real button.
3. Reachable and leavable by keyboard alone.
4. Matches DESIGN.md.
5. Recovers on its own when the cause goes away.
6. Survives a restart, a chat switch and a window resize.

Composer findings are tagged **may change with the composer redesign** (Kai's work after #862). The composer was audited as it is on main.

## How far this got

Graded with a shot or a motion sheet: the held chat load, the Interrupted, Relaunch, Error, Offline, Hooks down and queued-offline states, the question card, a message with ten images, send in a new chat, plan approve, Scroll to bottom. Everything else in scope was read in code only, and is listed under "Not reproduced". The keyboard walk is from code, not run. This is a partial audit, not a full one.

Counts: blocker 0, major 4, minor 1, polish 0.

## Findings

### Major

**M1. An existing chat shows the new chat welcome while its items load.**
State: opening a chat whose `chats.items` call is slow. Fixture: `AuditItemsLoading` (`hold: ['chats.items']`). Shot: `shots/AuditItemsLoading.png`, first cell of the state sheet.
The transcript says "New tab with Kai, Same worktree and branch, fresh context" with three starter buttons, over a chat that has a full history. `loadWorkspace` in `store.ts` sets the chat list first and loads items one chat at a time after, and `Transcript.tsx:1229` treats `!items.length && !running` as empty. Suspect (a) is confirmed.
Fails 1 and 5. The welcome is wrong, and it only goes away when the load answers, so a failed load leaves it up for good.
Direction: keep a per chat "items loaded" flag and show a blank or skeleton thread until it is true. Show an error with Retry if the load fails.

**M2. Plan approve moves four things at once.**
State: approve a plan in the Lead chat. Fixture: `WorkspacePlanApprove --motion`. Sheet: `shots/WorkspacePlanApprove-motion.png`, shared as "Audit motion: plan approve".
Frame 0 to 3: the plan card collapses to an "Approved" pill, the pill jumps about 110px up the view, the uncommitted file note and composer shift about 14px as the plan bar closes, and the mode chip flips from Plan to Auto later, around frame 7. The thread is left mostly empty under the pill. Suspect (d) is confirmed. `plan.tsx:91` also uses an instant `scrollIntoView` while the transcript aim runs, so smooth scroll restarts when the goal moves 48px or more.
Fails 4 (motion).
Direction: sequence it. Close the strip first, then collapse the card, and let the aim settle once at the end.

**M3. The composer swallows load failures.**
State: `chats.queue`, `chats.queueReason` and `chats.runMode` fail. Code: `composer/Composer.tsx:137`, `:138`, `:221` end in `.catch(() => undefined)`. No fixture can inject a failing call, so there is no shot. Suspect (f) is confirmed from code only.
A failed queue load means a queued message is not shown and the person may send it twice. A failed run mode load shows the default mode as if it were the chat's. Nothing is said in either case.
Fails 1, 2 and 5.
Direction: show a one line note above the box with a Retry button, and retry on reconnect. **May change with the composer redesign.**

**M4. There is no way to stop a turn from the keyboard, and Stop has no busy state.**
Code: `composer/Composer.tsx` `onKey` handles Escape only for the autocomplete. `composer/ComposerToolbar.tsx:54` renders Stop only when the box is empty, and it does not spin or say "Stopping".
With a draft in the box, a running turn can only be stopped by clearing the draft first. Stop can be pressed twice with no sign the first press landed.
Fails 3 and 4 (busy buttons, DESIGN.md).
Direction: Escape stops the turn after the picker and chips have taken theirs, and never touches the draft. Use `useBusy` on Stop. **May change with the composer redesign.**

### Minor

**m1. A new chat's first message paints low, then glides up.**
Fixture: `WorkspaceNewChatSendMotion --motion`, shared as "Audit motion: new chat first message". Suspect (b) is confirmed: the first frames show the message near the bottom, then it moves to the top anchor. The anchor is set in an effect, after the first paint. It is one motion and it ends in the right place, so it is minor.
Fails 4 (motion).
Direction: set the anchor in a layout effect so the first paint is the final position.

## Suspects ruled out

- **Ten images (i):** `AuditTenImages`. Images in a sent message are file chips, not thumbnails, so ten of them wrap onto three lines and nothing shifts when image data arrives. Fine.
- **Several banners at once (g):** `banners/model.ts` returns one banner by priority and masks the rest, so banners do not stack. The notes above the composer (uncommitted note, queue tray, hunk card) can still stack. `WorkspaceOffline` shows the offline banner over the queue tray and the box with room to spare, and fits at 1440x900. Not checked at a small window height.
- **Scroll to bottom motion:** `AuditScrollToBottomMotion --motion`. The view reaches the end in about three frames as one motion. Fine.
- **Approval buttons with no spinner:** deliberate, KERNEL-834 (`cards/decideFold.ts`). Not a finding.

## Not reproduced

Each needs either a fixture that can fail an IPC call, a scripted click in `scripts/shots.ts`, or a live run.

- (c) Four motion systems with different timing: seen in the plan approve sheet, not measured.
- (e) The aim snaps after 150 frames (`AIM_FRAMES`, `Transcript.tsx:1140`): code reading only. Needs a transcript whose height keeps changing for over 2 seconds.
- (h) A failed send leaving padding under nothing: no fixture fails a send.
- (j) Stop then send at once, queued messages after a failed turn, archiving a running chat, an approval answered elsewhere: not run. `WorkspaceInterrupted` and `WorkspaceRelaunch` render sensibly (see the state sheet) but I did not check the keyboard or recovery paths.
- Question answer motion: `AuditQuestionPicked` captures the picked state, but a motion run of the answer timed out clicking under `--motion` and I did not find out why.
- A 200 line command output: `AuditLongOutput` renders, but the output is inside a collapsed "Ran a command" row, so the shot shows none of it. Needs a click helper.
- Plan taller than the view, huge diff, queued messages after a failed turn: no fixture yet.
- Not read at all: `SetupWait`, `UpNext`, `NewLeadChat`, `ChatTabs`, `ChatRail`, `Panels`, `TeamUpdateCard`, `SharedCard`, `ErrorCard` beyond its shot.
- Window resize and restart (question 6) were not checked for any state.

## Fixtures added

In `fixtures/workspace.ts`, after `WorkspaceError`: `AuditItemsLoading`, `AuditLongOutput`, `AuditTenImages`, `AuditScrollToBottomMotion`, `AuditQuestionPicked`. `scripts/shots.ts` has two interaction entries for the last two.
