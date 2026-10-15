# UX audit: chat and workspace

Audit only. No file under `src/` changed. Scope is `screens/workspace/` and `screens/new-workspace/`, read against the six questions in the brief:

1. Says what is happening in plain words.
2. Says what to do next, with a real button.
3. Reachable and leavable by keyboard alone.
4. Matches DESIGN.md.
5. Recovers on its own when the cause goes away.
6. Survives a restart, a chat switch and a window resize.

Composer findings are tagged **may change with the composer redesign** (Kai's work after #862). The composer was audited as it is on main.

## How this was done

Three kinds of evidence, tagged on every line that depends on one:

- **shot**: a `pnpm shots` image of a fixture, in `shots/` (git-ignored) and in the shared sheets. Looked at in the 1440x900 render, and in 640px tiles on the group sheets.
- **motion**: a `--motion` contact sheet and GIF.
- **code**: read from source, not run. Each has a file and line, and repro steps for whoever fixes it. A code tag means "I did not see this happen".

The first pass read the keyboard walk from code. The re-audit at the end of this section ran it live. Question 6 (restart, chat switch, resize) is graded from shots at 1440x900 and the narrow fixtures, and from code for restart. No state was run through a real restart.

Counts at the first audit: blocker 0, major 4, minor 7, polish 1.

## Re-audit after the UX pass (KERNEL-872)

Rechecked on `a9e880daf`, after KERNEL-859 to 871 merged. Every fixture named in the findings was shot again, and the seven motion paths were rerun. The before and after sheets sit side by side in the PR. The keyboard and focus paths were driven in a hidden Electron window. Motion sheets were read at contact-sheet scale only, so M2, m1 and m2 rest on that and on the PR's changes. "Fixed (code)" means the fix is in the source and no fixture can draw it.

Final check (KERNEL-885) on the branch after KERNEL-873 to 891. Nothing in this audit is still open. n1, n2, m2 and the rest are fixed. M2, m1 and m3 are replaced by KERNEL-891, which removed the send anchor and the send glide, so their old fixes no longer describe the app. The new scroll behavior was traced numerically, see "Scroll behavior after KERNEL-891" below.

**n1. Focus is lost when the link-issue menu closes.** ⌘I opens the menu with focus in "Search issues". Escape closed it, but focus fell to the body, so a second Escape did not stop the running turn. Fails 3.

**Status: fixed.** Walked live in `WorkspaceTurnRunning`, from ⌘I and from the + menu: the first Escape closes the picker and focus is back on the composer, and the second Escape stops the turn (the Stop buttons go from 2 to 1). After: `NewChatLinkIssue`.

**n2. The question card's choices are separate Tab stops.** In `WorkspaceQuestion` ArrowDown did not move between the radios. Space selected, Tab reached Send, and Enter answered. Polish.

**Status: fixed.** Walked live: the choices are one roving radio group. ArrowDown and ArrowRight move focus to the next choice and stop at the last, ArrowUp and ArrowLeft move back, and only the focused choice is a Tab stop. In `WorkspaceQuestionOther`, Escape in the "Something else" field closes the field and keeps the card, focus returns to the choice. After: `WorkspaceQuestion`, `WorkspaceQuestionStates`.

## Findings

### Major

**M1. An existing chat shows the new chat welcome while its items load.** (shot)
**Status: fixed.** The thread stays blank until the items load, with no new chat welcome. After: `AuditItemsLoading`.
State: opening a chat whose `chats.items` call is slow. Fixture: `AuditItemsLoading` (`hold: ['chats.items']`). Shot: `shots/AuditItemsLoading.png`.
The transcript says "New tab with Kai, Same worktree and branch, fresh context" with three starter buttons, over a chat that has a full history. `loadWorkspace` in `store.ts` sets the chat list first and loads items one chat at a time after, and `Transcript.tsx:1229` treats `!items.length && !running` as empty. Suspect (a) confirmed.
Fails 1 and 5. The welcome is wrong, and it only goes away when the load answers, so a failed load leaves it up for good.
Direction: keep a per chat "items loaded" flag and show a blank or skeleton thread until it is true. Show an error with Retry if the load fails.

**M2. Plan approve moves four things at once.** (motion)
**Status: replaced by KERNEL-891.** KERNEL-862 sequenced the approve and its scroll aim. KERNEL-891 then removed the aim and the glide, so approving a plan no longer scrolls on purpose. Traced in the final check: the view stays at the end, and the only scroll change is the content getting shorter as the card collapses to its pill. The strip and mode chip sequence stays. After: `WorkspacePlanApprove-motion`.
Fixture: `WorkspacePlanApprove --motion`. Sheet: `shots/WorkspacePlanApprove-motion.png`.
Frames 0 to 3: the plan card collapses to an "Approved" pill, the pill jumps about 110px up the view, the uncommitted file note and composer shift about 14px as the plan bar closes, and the mode chip flips from Plan to Auto around frame 7. The thread is left mostly empty under the pill. Suspect (d) confirmed. `plan.tsx:91` also uses an instant `scrollIntoView` while the transcript aim runs, so smooth scroll restarts when the goal moves 48px or more.
Fails 4.
Direction: sequence it. Close the strip first, then collapse the card, and let the aim settle once at the end.

**M3. The composer swallows load failures.** (code)
**Status: fixed.** The composer says "Couldn't load this chat's queue and mode" with Retry. After: `WorkspaceComposerLoadFailed`.
`composer/Composer.tsx:137`, `:138` and `:221` end in `.catch(() => undefined)` for `chats.queue`, `chats.queueReason` and `chats.runMode`. No fixture can fail an IPC call. Suspect (f) confirmed.
Repro: in devtools, make `chats.queue` reject (or block it in the main handler), then open a chat that has a queued message. The tray is empty and nothing says why, so the person can send it twice. A failed `chats.runMode` shows the default mode as if it were the chat's.
Fails 1, 2 and 5.
Direction: one line note above the box with Retry, and retry on reconnect. **May change with the composer redesign.**

**M4. No way to stop a turn from the keyboard, and Stop has no busy state.** (code)
**Status: fixed.** Walked live: Escape closes the autocomplete first, then calls `chats.interrupt` and keeps the draft. Shift+Esc and ⌘Esc do not stop. After Escape the Stop button is gone. After: `WorkspaceStop`.
`composer/Composer.tsx` `onKey` handles Escape only for the autocomplete. `composer/ComposerToolbar.tsx:54` renders Stop only when the box is empty, and the Stop handler (`Composer.tsx:391`, `chats.interrupt`) does not spin or say "Stopping".
Repro: start a turn, type a few characters. The Stop button is gone, and Escape does nothing. Clear the box and press Stop twice quickly: both presses fire.
Fails 3 and 4 (busy buttons).
Direction: Escape stops the turn after the picker and chips have had theirs, and never touches the draft. Use `useBusy` on Stop. **May change with the composer redesign.**

### Minor

**m1. A new chat's first message paints low, then glides up.** (motion)
**Status: replaced by KERNEL-891.** KERNEL-860 set the anchor early. KERNEL-891 has no anchor. The first message of a new chat sits at the top only because the thread is short, and nothing scrolls. Traced: no scroll movement besides the new row. After: `WorkspaceNewChatSendMotion-motion`, `WorkspaceNewChatJustSent`.
Fixture: `WorkspaceNewChatSendMotion --motion`. Suspect (b) confirmed: the first frames show the message near the bottom, then it moves to the top anchor. The anchor is set in an effect, after the first paint. One motion, right end point.
Fails 4. Direction: set the anchor in a layout effect.

**m2. Five timing systems, none shared.** (motion and code)
**Status: fixed.** KERNEL-881 moved the fold, group collapse, tray row and scrim durations onto the shared duration tokens (`--dur-fast`, `--dur-base`, `--dur-glide` in `tokens.css`). KERNEL-891 then removed the send glide and the lift, so the two glides left are Scroll to bottom and the rail jump. Both were traced as one smooth, one-direction scroll. Group collapse is in `AuditGroupCollapseMotion-motion`. After: `AuditScrollToBottomMotion-motion`, `AuditRailJumpMotion-motion`, `AuditQuestionAnswerMotion-motion`.
Suspect (c) confirmed. The send glide and the lift are 120 to 700ms, set by distance (`Transcript.tsx:65`, `glideMs`, ease `cubic-bezier(0.45,0,0.05,1)`). The rail jump is native smooth scroll with a 1000ms fallback and a 1.2s ring (`ChatRail.tsx`). The approval fold is 200ms with a 120ms fade (`archiveMotion.css`). Group collapse is 180ms ease. The queue tray row leaves in 160ms (`QueueList.tsx:34`), and the scrim is 160ms.
Each one looks fine alone. They collide only in plan approve (M2). Recorded paths: send in a long chat is one glide of about 4 frames (`WorkspaceSendLongMotion`); send in a short chat is already at rest at frame 0 (`WorkspaceSendShortMotion`, see "Can't be reached"); question answer shows the answer bubble at once and the card folds in about 4 frames, one motion (`AuditQuestionAnswerMotion`); rail jump is one glide from the end to the first message that lands in about 400ms and retakes the aim once (`AuditRailJumpMotion`); first message and plan approve are m1 and M2; Scroll to bottom is three frames.
Direction: put the durations in tokens so they can be tuned together. Not urgent.

**m3. A failed answer leaves the view jumping.** (code)
**Status: replaced by KERNEL-891.** The anchor and the reply padding this finding was about are gone, so a dropped optimistic row leaves no padding to collapse. No fixture can fail the call, so this stays a read of the code.
Suspect (h). A composer send has no optimistic row, so a failed send leaves no padding behind (ruled out for typing). An answer does: `decideInChat` places a row (`cards/optimisticAnswer.ts:33-38`) and anchors it, `padReply` pads below it. When the call fails, `undo()` drops the row, `anchored.current` points at a row that is gone, `padReply` sets padding to 0 (`Transcript.tsx:1083`), and the view clamps and jumps.
Repro: make `approvals.decide` reject, then answer a question card or approve a plan. The answer appears, the card folds, then the answer vanishes, the card comes back and the view shifts by the padding.
Fails 4 and 6.
Direction: when the anchored row is dropped, release the anchor and keep the scroll position.

**m4. Up next can move the composer on first visit.** (code)
**Status: fixed (code).** `UpNext.tsx` no longer holds a spacer, and it renders cached rows first. Not shot.
`UpNext.tsx` holds a three row spacer until the tracker call settles, then returns null for a project with no tracker. The composer, docked under it, moves by the spacer height. Failures are swallowed on purpose.
Repro: open the New chat page of a project with no tracker with `trackers.issues` slow (or held in a fixture with `hold`). Fails 4.

**m5. After a failed first send, nothing takes focus.** (code)
**Status: fixed (code).** `NewLeadChat.tsx` refocuses the box after a failed first send. Not walked live.
`NewLeadChat.tsx`: `ComposerInput disabled={busy}` blurs the box while the first message goes out. On failure the toast says "Could not send" and the text stays, but nothing focuses the box again. `start()` on an empty draft or an unusable project focuses it silently, with no word on why.
Repro: make `leads.start` reject, type, press Enter, then press a key. Nothing is typed. Fails 3 and 2.

**m6. A shared file card vanishes when the file is not in the store.** (code)
**Status: fixed.** The card shows "A shared file, This file is no longer available". After: `WorkspaceSharedMissing`.
`SharedCard.tsx`: `if (!file || !v) return null`. A message that points at a shared file the store doesn't have (an archived workspace, a failed list load) loses the card and the message reads as if it was never attached.
Repro: remove the file from `shared` in a fixture and render `WorkspaceSharedCard`. Fails 1 and 5.

**m7. Stop clears the queue without a word.** (code)
**Status: fixed.** Walked live in `WorkspaceQueued`: Escape on an empty box unqueues both messages, interrupts, and puts the queued text back in the box.
`sessions.ts:1889`: `if (stopped) this.setQueue(chatId, [])`. This is deliberate (D-030, "Stopping a chat clears its queue"). The tray rows fade out and nothing says the messages were dropped, so someone who queued three messages and pressed Stop loses all three with no way back. Send now keeps them.
Repro: run a turn, queue two messages, press Stop. Fails 1.
Direction: keep the rule, add a toast with Undo, or put the dropped text back in the box.

### Polish

**p1. Chat tabs take no Home and End.** (code)
**Status: fixed.** Walked live in `GroupedTabs`: ArrowRight, ArrowLeft, Home and End move focus, with wrap.
`ChatTabs.tsx`: arrows wrap and focus is roving, but Home and End do nothing. The ChatRail has both. Fails 3 for the last tab of a long strip.

## State inventory and grades by surface

Grades are the six questions in order, 1 to 6, as pass (P), fail (F) or not applicable (n/a). A code grade is a read, not a run. Sheets: `audit-g1` to `audit-g9`, shared with this PR.

### ChatRail (sheet g1)

States: hidden under 2 entries, closed, open with long labels, Lead list with team updates, narrow window. Shots: `ChatRail`, `ChatRailOpen`, `ChatRailLead`, `ChatRailNarrow`. Motion: `AuditRailJumpMotion`.
Grades: 1 P, 2 P (Enter jumps when open), 3 P (`aria-haspopup=listbox`, `aria-activedescendant`, Home, End, arrows, Enter, Escape, code), 4 P, 5 P (follows the items), 6 P for resize (`ChatRailNarrow`), restart and chat switch not run. The 1.2s jump ring is not visible in the dark frames at sheet scale (see "Can't be reached"). Findings: m2.

### Chat tabs (g1)

States: one tab, several, a running tab, an unread tab, overflow, the tab menu, rename. Shots: `WorkspaceTabStates`, `WorkspaceTabMenu`.
Grades: 1 P, 2 P (the menu has the real actions), 3 P with p1 (`role=tablist`, roving tabindex, arrows wrap, ⌘T, ⌘W, ⌘⇧T, code), 4 P, 5 P, 6 P (tabs are in the store). Rename commits on Enter and blur and cancels on Escape. Whether blur after Escape commits is unverified. Close, rename and fork failures toast. Closing a running chat asks first. Findings: p1.

### Panels

**Files.** `WorkspaceFilesTree`, `WorkspaceFile` (g2). Empty, tree, file open, open in editor. "Could not list files" is in code (`Panels.tsx:66`) and has no Retry button. Grades: 1 P, 2 F on the failure (no Retry, code), 3 P, 4 P, 5 F on the failure (stays until reopened, code), 6 P.
**Diffs.** `WorkspaceChangesList`, `WorkspaceDiffTab`, `PanelFilter`, `PanelCompare` (g2, g3, g4). Changes list, filtered list, empty filter, compare menu, diff tab. "Could not compare" and the empty and no-match states are in code. Grades: 1 P, 2 P, 3 P, 4 P, 5 P, 6 P. In `PanelCompare` the commit list sits close to the right edge of the window. Cosmetic, looked at in a 640px tile only, not counted.
**Terminal.** `WorkspaceTerminal` (g3). Shows the Claude Code banner and a live prompt. Grades: 1 P, 2 n/a, 3 P (the terminal takes keys, so leaving it is the tab strip or ⌘ shortcuts, code), 4 P, 5 n/a, 6 not run (a restart ends the pty, code).
**Scripts.** `WorkspaceRunScripts`, `WorkspaceRunEmpty`, `WorkspaceSetupAdd`, `PanelSetup` (g2, g4). Run output with tabs per script, "No run script" with Add run script, "Add setup script" with Ask Kernel and Add manually. Setup tab has Stop (`Panels.tsx:526`). Start and stop failures toast ("Could not stop setup", "Could not start ..."). Grades: 1 P, 2 P, 3 P, 4 P, 5 P, 6 P. Busy buttons spin.
**PR view and checks.** `WorkspacePRChecks`, `WorkspacePRConflict`, `PanelSplit`, `PanelCollapsed`, `PanelTabsOverflow` (g4). Open PR, checks running, merge conflicts with "Resolve conflicts", no PR with "Create PR". Grades: 1 P, 2 P, 3 P, 4 P (status is text and icon, no dots), 5 P (follows GitHub), 6 P.
**Shared tab.** `WorkspaceSharedPanel`, `WorkspaceSharedPanelEmpty` (g4). List and the empty "Nothing shared in this workspace yet". Grades all P.

### SetupWait (g5)

States: running with a queued bubble, failed after 1:08, stopped, worktree failed, edit a queued message. Shots: `SetupRunning`, `SetupFailed`, `SetupStopped`, `SetupWorktreeFailed`, `SetupEditQueued`.
Grades: 1 P ("Running setup", "Setup failed after 1:08", "Couldn't create the worktree"), 2 P (Run again, Send anyway, Edit script, or Try again), 3 P (real busy buttons, `role=status`, code), 4 P, 5 P (Run again re-enters the wait), 6 P for chat switch, restart drops the held first prompt by design (D-044). Queued bubbles have Edit and Cancel. There is no Stop on the card itself, only in the Setup tab. "Show log" appears only when the panel is closed. Findings: none.

### UpNext (g6)

States: three rows, none (no tracker), no project. Shots: `NewChat`, `NewChatNoProject`. Grades: 1 P, 2 P, 3 P, 4 P, 5 P (a failed read is swallowed on purpose and the section is just absent, code), 6 P. Findings: m4.

### New chat page (g6)

States: ready, no project ("Pick a project" button), long draft, narrow, after send, queued. Shots: `NewChat`, `NewChatNoProject`, `NewChatLongDraft`, `NewChatNarrow`, `NewChatAfterSend`, and the first message motion (m1).
Grades: 1 P, 2 P, 3 F after a failed start (m5), 4 P, 5 P, 6 P (draft survives a switch, long draft and narrow render fine). `lead.prefetch` failures are swallowed, harmless. Findings: m5, m1.

### TeamUpdateCard (g7)

States: merge, review, ask, PR states (checks failed, merging, changes requested, conflicts, draft, in history), shared files in an update. Shots: `TeamUpdateMerge`, `TeamUpdateReview`, `TeamUpdateAsk`, `TeamUpdatePrStates`, `TeamUpdateShared`, `WorkspaceKernelNote`.
Grades: 1 P, 2 P (Merge only on the newest row per PR, "Needs you" replaces Merge for a stuck PR, "Merge anyway" when blocked), 3 P (the reply clamps to 3 lines with a Show more button, `aria-expanded`, code), 4 P, 5 P (rows follow PR state), 6 P. Open items cap at 5 and the fallbacks "In History" and "From ..." read well. Findings: none. Note: "Could not read the pull request from GitHub." shows inline on a card and has no Retry (shot `TeamUpdateShared`). Not counted, the next poll recovers it.

### SharedCard (g8)

States: card in a message (thumbnail, kind, version, who), a comment on an archived workspace, comment with "Noor's workspace is archived" and a disabled Send. Shots: `WorkspaceSharedCard`, `WorkspaceSharedCommentArchived`.
Grades: 1 P, 2 P (Open, "Restore it from History"), 3 P, 4 P, 5 F when the file is missing (m6), 6 P. Findings: m6.

### Steps and folds (g8, g9)

States: step states, long run of steps, 493 earlier steps, working fold, folded, folded then opened, stopped turn, failed turn, orphaned turn, error card, queued. Shots: `WorkspaceStepStates`, `WorkspaceStepsLong`, `WorkspaceFoldWorking`, `WorkspaceTurnFolded`, `WorkspaceTurnFoldedOpen`, `WorkspaceTurnStopped`, `WorkspaceTurnFailed`, `WorkspaceTurnOrphaned`, `WorkspaceError`, `WorkspaceQueued`, `WorkspaceQueuedOffline`, `WorkspaceInterrupted`.
Grades: 1 P ("INTERRUPTED BY YOU", "Couldn't run a command", "The turn failed"), 2 P (ErrorCard has Open terminal, Retry and Ask Kai to fix, all busy buttons, `role=alert`; the queue has Edit, Send now and Remove), 3 P (code), 4 P, 5 F: ErrorCard never clears itself when the cause goes away, it waits for Retry (code, by design, not counted), 6 P (open state of a fold survives a chat switch via `useRowOpen`, `chatPlace.ts:86`, until Kernel restarts, KERNEL-765). Findings: m7 for the queue.

## Interrupted flows (suspect j)

- **Quit mid-turn.** (shot) `WorkspaceRelaunch` and `WorkspaceInterrupted` read sensibly. The turn carries on at the next launch, and `onTurnDone` is skipped while Kernel closes (`sessions.ts:1887`), so no false "finished" note. Ruled out. A quit that fails on a sign-out waits for the hold to lift (`sessions.ts:1868`).
- **Stop, then send at once.** (code) `interrupt` sets `live.interrupted` (`sessions.ts:1393`), the message queues, and Stop empties the queue when the turn ends (`sessions.ts:1877`). A message sent after Stop but before the turn ends is dropped with the rest. Sent after it ends, it goes. That is m7, and the window is small but real. Repro: press Stop and type a message within the time the turn takes to end, then press Enter.
- **Queued messages after a failed turn.** (code) The turn ends with `ok` false and not stopped, so `drain` sends the next queued message (`sessions.ts:1890`) while an ErrorCard with Retry sits above. Retry then re-sends the earlier turn after the new one has started. I did not run it. Repro: queue a message, make the turn fail (bad command), watch the queue. Needs a live check before anyone acts on it.
- **Archiving a running chat.** (code) `archiveChatFromSidebar` reads `threads.archivePreview`, and a workspace with `running` opens `ConfirmArchiveChat`, which says "still running" and "Archiving removes the worktrees" (`archiveChat.ts:38-40`, `ConfirmArchiveChat.tsx:20`). A failed preview says "Kernel couldn't read what this chat would stop." and still archives on confirm. Ruled out as a finding.
- **An approval answered elsewhere.** (code) `store.ts:798` upserts the approval on the push, so a pending card flips to answered where it sits. No toast, the card just resolves. An answer sent from here at the same moment would see the engine's row replace the optimistic one by id (`optimisticAnswer.ts:1-10`). Ruled out.

## Keyboard and focus walk (live)

Run in a hidden Electron window against the current build.

- **Escape order.** In `WorkspaceRunning` with "@ hello" typed: Escape #1 closes the autocomplete, Escape #2 calls `chats.interrupt` and the draft stays, Escape #3 does nothing more. Shift+Esc and ⌘Esc do not stop. In `WorkspaceQueued`, Escape on an empty box unqueues both messages, interrupts, and puts the queued text back in the box. `WorkspaceTurnRunning` and `WorkspaceFoldWorking` lose their Stop button after Escape.
- **Link-issue menu.** In `WorkspaceTurnRunning`, ⌘I and the + menu open it. Escape closes it and focus returns to the composer, a second Escape stops the turn (n1, fixed).
- **Chat tabs.** ArrowRight and ArrowLeft move and wrap, Home and End go to the first and last tab.
- **Approve a plan.** In `WorkspacePlan`, Enter on "Approve ⌘⇧↵" calls `approvals.decide` with allow, and focus returns to the composer.
- **Answer a question.** In `WorkspaceQuestion`, Space picks a choice, Tab reaches Send, Enter calls `approvals.decide` with the answer. Arrows rove focus through the choices (n2, fixed). Escape in the "Something else" field keeps the card.
- **Toasts.** In `AuditToastsStacked`, Escape dismisses the newest and ⌘⌥Z runs Undo on the next. With a turn running and a toast up, the first Escape stops the turn and the second dismisses the toast.
- **Not run.** Return of focus to the New chat box after a failed first send (code only).

## Scroll behavior after KERNEL-891

KERNEL-891 changed sending: a sent message appears at the end and the view follows it, with no anchor and no glide. Only Scroll to bottom and a rail jump glide. Traced in a hidden Electron window, sampling the thread's scroll position every frame:

| Path | Fixture | Result |
| --- | --- | --- |
| Send, short thread | `WorkspaceSendShortMotion` | No scroll movement, only the new row. |
| Send, long thread | `WorkspaceSendLongMotion` | The view follows to the end in about 3 frames, no glide. |
| Send from a new chat | `WorkspaceNewChatSendMotion` | Thread is short, no scroll. The first message sits at the top because of that. |
| Plan approve | `WorkspacePlanApprove` | No scroll glide. The position only drifts as the card collapses and the content gets shorter, and the view stays at the end. |
| Question answer | `AuditQuestionAnswerMotion` | The thread does not scroll, so nothing moves. |
| Scroll to bottom | `AuditScrollToBottomMotion` | One smooth glide in one direction. |
| Rail jump | `AuditRailJumpMotion` | One smooth glide in one direction. |
| Send during a rail jump | `AuditRailJumpSendMotion` | The send goes to the end at once, no glide. |

## Fixtures added

In `fixtures/workspace.ts`: `AuditItemsLoading`, `AuditLongOutput`, `AuditTenImages`, `AuditScrollToBottomMotion`, `AuditQuestionPicked`, `AuditQuestionAnswerMotion`, `AuditRailJumpMotion`. `scripts/shots.ts` has an interaction entry for each of the last four and `AuditScrollToBottomMotion`. The other surfaces used fixtures that were already on main.

## Suspects ruled out

- **Ten images (i):** `AuditTenImages`. Images in a sent message are file chips, so ten wrap onto three lines and nothing shifts when image data arrives.
- **Several banners at once (g):** `banners/model.ts` picks one banner by priority. The notes above the composer (uncommitted note, queue tray, hunk card) can still stack. `WorkspaceOffline` fits at 1440x900. Not checked at a small window height.
- **Scroll to bottom motion:** three frames, one motion.
- **Approval buttons with no spinner:** deliberate, KERNEL-834 (`cards/decideFold.ts`).
- **The 150 frame aim cap (e):** (code) `Transcript.tsx:1140`. At `AIM_FRAMES` the aim stops being smooth and does one instant `scrollTo` if the view is not calm. It needs a row that keeps changing height for about 2.5 seconds at 60Hz (1.25s at 120Hz). Nothing in the app does that on a normal run, so it is not a finding. Repro for whoever wants to see it: in a fixture, make the last row's height change every frame for 3 seconds right after a send.
- **A 200 line command output:** `AuditLongOutput` renders, but the output sits in a collapsed row. Fine as far as the shot goes, see below.

## Can't be reached, and why

- **Failed IPC calls** (M3, m3, m5, the "Could not list files" state, "Could not compare"): no fixture injects a failing call. Needs a `fail: string[]` option next to `hold`, in `fixtures/types.ts` and the shots harness. That is outside this audit's rule against changing shared files, so the findings are code tags with repro steps.
- **The first frames of a short chat send** (`WorkspaceSendShortMotion`): the lift is at least 120ms and the harness waits about 150ms before frame 0, so the start is not captured.
- **120Hz** and **the 150 frame cap in practice**: no display here. Code tag above.
- **The rail's jump ring:** lasts 1.2s but is a low contrast hairline, and is not visible at 640px in the dark theme. Read in code only.
- **Quit and relaunch for real:** fixtures show the state after a relaunch, not the relaunch. Question 6 for restart is graded from code.
- **The output of a long command:** the row is collapsed and `shots.ts` has no step that opens it. A click helper would do it. Not done.
- **A plan taller than the view, a huge diff:** no fixture. Not built, since neither is in the known suspects.
- **Small window height** for stacked banners: shots are at 1440x900 only, apart from the narrow fixtures.
- **Retry after a failed turn with a message queued:** needs a live run.
