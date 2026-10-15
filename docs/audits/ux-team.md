# UX audit: Team screens

Audit only. Nothing under `src/` changed. Scope: agents and New agent, projects (Projects, New project, Connect a repo, Open a folder, project setup), Inbox, Issues (Linear, GitHub, other trackers), Pull requests, History and the command palette.

How this was done. I read each screen's code and `DESIGN.md`, added fixtures for the states a fixture can reach, shot them at 1440x900 and looked at each shot. Findings marked "shot" are visible in the image. Findings marked "code" come from reading the component, because no fixture can fail a call (only `hold` for a call that never answers, `push` for offline, and empty data exist). The keyboard paths were first read from code. The re-audit below walked them live.

The six questions used below:

1. Does it say in plain words what is happening?
2. Does it say what to do next, with a real button?
3. Can a keyboard reach it and leave it?
4. Does it match DESIGN.md?
5. Does it recover once the cause goes away?
6. Does it survive a restart, a screen switch and a resize?

Contact sheet of every state: shared in the Kernel chat as "Team screens audit sheet". Shot names below are fixture names, saved as `shots/<Fixture>.png` by `pnpm shots` (the folder is git-ignored).

## Re-audit after the UX pass (KERNEL-872)

Rechecked on `a9e880daf`, after KERNEL-859 to 871 merged. Every fixture named in the findings was shot again and set beside its before shot on the sheet shared in the PR. Keyboard paths were driven in a hidden Electron window. "Fixed (code)" means the fix is in the source and no fixture can draw it.

Final check (KERNEL-885) on the branch after KERNEL-873 to 891. Every finding below has a final status. All 18 first findings and n1 are fixed (M1, m1 and p2 by code only). Nothing in this audit is still open.

New since the first audit:

**n1. Focus is lost when the command palette closes.** Opened from the Search button with Enter, the palette took focus on its combobox and Escape closed it, but focus landed on the page body. Fails 3.

**Status: fixed.** Walked live: Enter on Search opens the palette, Escape closes it and focus is back on the Search button. Opened with ⌘K from the button, the same. After: `CommandPalette`.

## Counts

| Severity | Count |
| --- | --- |
| Blocker | 0 |
| Major | 10 |
| Minor | 5 |
| Polish | 3 |

No blocker: nothing loses data or locks the app. The majors are dead ends where a failure leaves the person with no button, or words that describe a different state.

## Major

**M1. New agent: Cancel while Kernel drafts, then the late answer reopens the dialog.** Fixture: none reachable (needs a draft that answers late). Source: code, `agent/NewAgent.tsx`. Fails 3, 6. Direction: ignore a draft result once the dialog was cancelled.

**Status: fixed (code).** `NewAgent.tsx` ignores a draft that answers after Cancel. No fixture can answer late.

**M2. Linear "rejected token" has no Settings button.** Fixture: none (no error injection). Source: code, `issues/LinearIssues.tsx`. Fails 2, 5. Direction: show the same banner as other kinds, with an "Open Settings, Integrations" button.

**Status: fixed.** "Linear rejected the token" with Open Settings, Integrations. After: `IssuesRejected`.

**M3. GitHub issues have no sign-in or connect path, and every failure reads as offline.** Shot: `IssuesGitHubOffline` shows "Can't reach GitHub, check your connection" with Try again. A signed-out `gh` or a missing repo would show the same text. Fails 1, 2. Direction: separate not signed in, repo gone and offline, each with its own next step.

**Status: fixed.** Signed out and offline now read differently, each with its own button. After: `IssuesGitHubSignedOut`, `IssuesGitHubFailed`.

**M4. Connect a repo: loading looks blank, and an empty account says "No repositories match."** Shots: `ConnectRepoLoading` (search box and nothing under it), `ConnectRepoEmpty` (the "No repositories match." line with an empty search box). Fails 1, 5. Direction: a "Loading repositories" row like Issues has, and "This account has no repositories" when the list is empty and the search is too.

**Status: fixed.** A "Loading repositories" row shows while the list loads. After: `ConnectRepoLoading`.

**M5. Connect a repo: a failed fetch looks like an empty list, with no retry or sign-in.** The header says "Signed in" whatever the auth state is. Fixture: none (no error injection). Source: code, `projects/ConnectRepo.tsx`. Fails 1, 2, 5. Direction: an error row with Try again and a Switch account button.

**Status: fixed.** A failed fetch shows an error row with Try again and Switch account. After: `ConnectRepoFailed`.

**M6. Project setup failed: no retry, and the page still says "This takes a minute".** Shot: `ProjectSetupFailed`. The failed step has red text, the later steps stay as dashes, "Open the project" is disabled, and the footer still says "Kernel keeps going". Fails 1, 2, 4. Direction: change the heading and footer on failure, add Try again on the failed step, and use the neutral banner style for the error.

**Status: fixed.** The heading and footer say "did not finish setting up" and "A step stopped. Its error is below.", the error uses the neutral box, and the failed step has a Try again button. Walked live on the final states: after Try again the project opens, and when the retry fails again the page stays on the failed state with Try again. A failed clone and a restart both leave Try again available. The "Trying again" label while the call waits was not captured, so it is read from code, not walked. After: `ProjectSetupFailed`, `ProjectSetupRetryFailed`.

**M7. Delete from History: if the preview call fails, the dialog sits on "Counting" forever.** Fixture: none (needs a failing `deletePreview`). Source: code, `history/ConfirmDeleteHistory.tsx`. Fails 1, 2, 5. Direction: show the error and a Try again button, and keep Delete disabled.

**Status: fixed.** The dialog says it could not count, keeps Delete off, and offers Try again. After: `HistoryConfirmDeleteFailed`.

**M8. Open a folder: loading and failure look like an empty list.** Shot: `OpenFolderLoading` (the "Recent folders" heading with nothing under it), `OpenFolderEmpty` for comparison. Fails 1, 5. Direction: the same loading row as M4, and a failure line with Try again.

**Status: fixed.** "Could not read your recent folders" with Try again. After: `OpenFolderFailed`.

**M9. Linear issue list: a failed refresh replaces the whole list with an error.** Shot: `IssuesError` (the offline banner replaces the list even when the list was already loaded). Fails 5. Direction: keep the loaded rows and show the banner above them.

**Status: fixed.** A failed refresh keeps the rows and shows the banner above them (KERNEL-867).

**M10. Pull requests has no loading, failed or not-connected state.** The page reads workspaces Kernel already has, so a failed GitHub read looks like "no pull requests". Shots: `PullRequestsEmpty`, `PullRequestsNoMerged`. Fails 1, 2. Direction: show when the PR status was last read and a banner when it could not be.

**Status: fixed.** A banner shows when the read failed, and the page says when the status was last read ("Status read 16m ago"). After: `PullRequestsReadFailed`.

## Minor

**m1. Projects and Pull requests tabs are not remembered.** Source: code. DESIGN.md says remembered choices go through `useRemembered`. Fails 6.

**Status: fixed (code).** Both tabs use `useRemembered`.

**m2. Counts and caps are silent.** Shot: `IssuesMany` ("All 100+", no way to load more). The merged list on Pull requests stops at 50 with no note. Fails 1.

**Status: fixed.** Issues says "Showing the 100 issues updated most recently", and Pull requests says "Showing the 50 most recent of N merged pull requests". After: `IssuesMany`, `PullRequestsMergedCapped`.

**m3. A failed issue detail is a muted paragraph with no retry.** Shown when an issue opened from the list is gone. Source: code (and visible in an early `IssuesMany` shot before I fixed the fixture id). The loading state is fine: `IssuesDetailLoading`, `IssuesGitHubDetailLoading`. Fails 2.

**Status: fixed.** "Could not load the description" with Try again. After: `IssuesDetailFailed`.

**m4. The Open a folder drop zone does not accept a dropped folder.** Shot: `OpenFolder` says "Drop a project folder here". Source: code. Fails 1.

**Status: fixed by copy.** The screen now says "Choose a project folder on this Mac" and promises no drop. After: `OpenFolder`.

**m5. Error styling differs by screen.** See the consistency list.

**Status: fixed.** The failure banners share one neutral style across the screens above.

## Polish

**p1. New project repeats "Brief Kernel right away".** Shot: `NewProject`. Source: code.

**Status: fixed.** `NewProject` shows the "Brief Kernel right away" label once. After: `NewProject`.

**p2. The command palette's `aria-expanded` is always true.** Source: code, `search/CommandPalette.tsx`. Fails 3.

**Status: fixed (code).** `aria-expanded` follows whether there are results.

**p3. List keys differ.** Inbox uses j and k, Issues uses arrows, and Projects, Pull requests and History have no arrow navigation. Fails 3.

**Status: fixed.** Walked live in History, Inbox, Projects, Issues and Pull requests: ArrowDown, j, ArrowUp, k, Home and End each move the row focus.

## Consistency

Each row is the same kind of state with different looks or words.

| Kind | Where it differs |
| --- | --- |
| Loading | Issues: "Loading issues" with the load loader. Connect a repo, Open a folder: blank. Pull requests, Projects, History: no loading state. Issue detail: grey skeleton bars. |
| Empty | History and Issues: icon, title and one line. Projects: a plain line in the table. Connect a repo: "No repositories match." Inbox: its own text. |
| Failed | Issues: neutral banner with icon and Try again. Project setup: red text. Connect a repo, Open a folder: an empty list. History delete: stuck "Counting". Issue detail: muted paragraph. |
| Offline or auth | Linear has banners per kind. GitHub issues use the offline banner for everything. Connect a repo says "Signed in" with no check. |
| Keyboard lists | j and k in Inbox, arrows in Issues, nothing in Projects, Pull requests and History. |

## States with no fixture yet

These need a way to fail a call or answer late, which `fixtures/` does not have (`hold` only never answers). A `fail: { channel: message }` field on `Fixture` would cover most of them. That is a change to `src/main/fixtures.ts`, so it is out of this PR.

- Linear rejected token, rate limited, and a failed refresh over a loaded list (M2, M9 beyond offline)
- GitHub issues signed out, repo gone, rate limited (M3)
- Connect a repo failed fetch (M5)
- Open a folder failed read (M8)
- Delete from History preview failure (M7)
- New agent draft that answers after Cancel (M1), and a draft that fails
- Issue detail not found, with a retry
- Pull requests with 100 or more rows (the existing scene builds seven open rows; a count override would help)
- Command palette with a query typed (a fixture cannot prefill the input)

## New fixtures in this PR

`HistoryEmpty`, `InboxMany`, `ProjectsEmpty`, `ConnectRepoLoading`, `ConnectRepoEmpty`, `OpenFolderLoading`, `OpenFolderEmpty`, `ProjectSetupFailed`, `IssuesDetailLoading`, `IssuesMany`, `IssuesGitHubLoading`, `IssuesGitHubEmpty`, `IssuesGitHubOffline`, `IssuesGitHubDetailLoading`. Existing fixtures reused: `Inbox`, `InboxEmpty`, `Projects`, `NewProject`, `ProjectSetupWarnings`, `ConnectRepo`, `OpenFolder`, `Issues`, `IssuesLoading`, `IssuesEmpty`, `IssuesConnect`, `IssuesError`, `IssuesNoProject`, `IssuesNoTracker`, `IssuesJira`, `IssuesGitHub`, `PullRequests`, `PullRequestsEmpty`, `PullRequestsNoMerged`, `History`, `NewAgent`, `NewAgentNoProject`, `NewAgentDraft`, `CommandPalette`, `SearchArchived`.

`InboxMany` (80 rows) looked fine: the list scrolls and the detail pane keeps its place. No finding.

## Keyboard walk (live)

- **Lists.** In History, Inbox, Projects, Issues and Pull requests, ArrowDown, j, ArrowUp, k, End and Home each move the row focus. One key model (p3, fixed).
- **Command palette.** Enter on Search opens it with focus on the combobox. Tab stays on the combobox, which is right for a combobox. Escape closes it and focus returns to the Search button (n1, fixed). Same from ⌘K.
- **Project setup Try again.** Enter on Try again runs it. When it works the app leaves setup for the project. When it fails again the failed state stays with Try again (M6, fixed).
- **Busy retries.** Try again in Connect a repo and Open a folder shows its busy label and settles (M5, fixed).
- **Escape, toast up.** A field keeps Escape, then the screen, then the toast. On Settings, Escape leaves Settings and the next Escape clears the toast (KERNEL-896, see the platform audit).
- **Cap notes.** `IssuesGitHubCapped` and `PullRequestsMergedCapped` show the note that the list is cut at its cap.
