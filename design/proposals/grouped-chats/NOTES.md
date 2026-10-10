# Grouped chats proposal

This is a proposal, not the spec. Nothing here is built, and `design/screens/` and `design/canvas/project/` are untouched.

Today (D-139, D-133) every Lead tab in a room is also a sidebar row, and the tab row shows every Lead tab. The proposal:

- A chat is a sidebar row, one per topic. Only ⌘N (the New chat dialog) starts one.
- A tab is a conversation inside a chat. + and ⌘T add a tab to the chat you are in, with no new row.
- The tab row shows only the open chat's tabs. Clicking another chat row, or ⌘1 to ⌘9, swaps it.
- Workspaces handed off by any tab nest under the chat row.
- Each tab is its own Claude session. Every tab sees the chat's workspaces as its own and can read the chat's approved plans.
- The context-full banner and Fork add a tab to the same chat.
- If the tab that handed off work is closed, team updates go to another open tab in the chat.
- A chat row shows the strongest status of its tabs: the question icon if any tab waits on you, else the spinner if any runs.
- Closing the last tab closes the chat. Its workspaces stay in the sidebar as unowned rows.
- Ask Rowan opens its answer as a new tab in the chat you are in, or as a new chat from Home or Inbox.

## Rebuilding

```
node design/proposals/grouped-chats/build.mjs              all pages, then all PNGs
node design/proposals/grouped-chats/build.mjs GroupedTabs  one page
```

`build.mjs` reads the partials and the Workspace, CommandPalette and Confirm templates in `design/canvas/source/templates/` and writes pages to `build/` (ignored by git). `design/canvas/source/render.mjs` renders them here (new `--from` flag). Each page takes about 25 seconds, mostly loading fonts.

## Sample data

Every screen uses Client A. The eight Lead tabs are:

- Chat 1, Export invoices as PDF: "Export invoices as PDF" (the plan), "How is Kai's PR going?" (side question), "One PDF per client" (fork)
- Chat 2, Invoice table and empty states: "Invoice table and empty states", "Empty state copy"
- Chat 3, Client portal login: "Client portal login", "Fix the login redirect"
- Chat 4, Seed realistic demo data: "Seed realistic demo data"

Today that is eight sidebar rows. Proposed it is four.

## Screens

Current (how main behaves now)

1. `GroupedCurrentTabs`: the eight tabs as eight sidebar rows. The tab titles shrink to a few letters, as `.ws-tab` does in the app.
2. `GroupedCurrentAskRowan`: two Ask Rowan questions add two tabs and two rows. The list runs past the window and Own app and Portfolio fall off the bottom.
3. `GroupedCurrentContextFull`: the context-full banner with its New chat button. `GroupedCurrentContextFullAfter`: the new tab and the new "New chat" row it made.

Proposed

4. `GroupedNewChat`: just after Create in the New chat dialog. One new chat row, a tab row with one tab.
5. `GroupedTabs`: chat 1 with three tabs. Its three workspaces nest under the row, and the tab row shows only these three.
6. `GroupedSwitchChat`: chat 2 selected. The tab row shows its two tabs.
7. `GroupedNewTabMenu`: the + menu with New tab ⌘T and Big terminal ⌘⇧T.
8. `GroupedSharedWork`: tab 2 answers "How is Kai's PR going?" by listing the chat's workspaces and quoting the plan approved in tab 1.
9. `GroupedContextFull`: the banner offers a new tab in this chat. `GroupedContextFullAfter`: the new tab in the tab row, sidebar unchanged.
10. `GroupedUpdateRouted`: tab 1 is closed and a Team update lands in tab 2, naming the tab you closed.
11. `GroupedRowStatus`: chat 2 spins and chat 3 shows the question icon, both from tabs you can't see. A hover card on chat 3 says which tab needs you.
12. `GroupedCloseLastTab`: the confirm when the last tab of a chat is still running. `GroupedCloseLastTabAfter`: the chat is gone and its two workspaces sit at chat level.
13. `GroupedAskRowan`: the same two questions as screen 2, now two tabs in chat 1. The sidebar does not change.
14. `GroupedPalette`: ⌘K with New chat in Client A ⌘N, New tab ⌘T, and the chats listed by name.

`GroupedOverview` pairs 1 with 5, 2 with 13 and 3 with 9 (after the click), then thumbnails the rest.

## Proposed strings

Copy the app does not have today. Everything else on these screens is the canvas's or the app's existing copy.

| Where | Today | Proposed |
|---|---|---|
| + menu, first item (7) | New chat ⌘T | New tab ⌘T |
| Context-full banner button (9) | New chat | New tab |
| Context-full banner text (9) | A new chat starts clean on this branch. | A new tab starts clean in this chat. |
| Empty tab heading (9 after) | New chat with Rowan | New tab with Rowan |
| Title of a tab with no message yet (9 after) | New chat | New tab |
| Fork, tab menu and message action | Fork into new chat | Fork into new tab (not drawn, needed because the label says chat) |
| Team update, routed (10) | From "{chat}", a Lead chat that is now closed | From "Export invoices as PDF", a tab you closed |
| Close confirm title (12) | none | Close this chat? |
| Close confirm body (12) | none | Rowan is still working in this chat. Closing its last tab stops that turn and closes the chat. The 2 workspaces it started stay in the sidebar. |
| Close confirm facts (12) | none | Invoice table and empty states / 1 tab · Rowan is working |
| Close confirm buttons (12) | none | Cancel, Close chat |
| Chat hover card (11) | none | Client A · Chat with Rowan, Needs you, Fix the login redirect asks whether to keep Google sign in., 2 tabs · 1 needs you |
| Palette group (14) | none | Chats in Client A, with 3 tabs, 2 tabs, 2 tabs, 1 tab on the right |
| Palette item (14) | New chat tab ⌘T | New tab ⌘T |
| Settings, Shortcuts | New chat tab | New tab (not drawn) |

Transcript text in 4, 6, 8, 10 and 13 is sample content, not UI copy.

## Where the drawings disagree with the canvas or the code

- `CommandPalette.png` still says "New workspace in Client A ⌘⇧N". The app says "New chat in Client A ⌘N" (`search/model.ts`), so screen 14 follows the app.
- The canvas tab row never shrinks its tabs and the app does. Screens 1 to 3 follow the app.
- The canvas draws a caret on the open tab where the app draws a pen and a close button. These screens follow the canvas PNGs.
- DESIGN.md says sidebar rows sit 3px apart. The canvas draws 1px. These screens follow the canvas.
- The hover card on a chat row exists in code for workspaces and the Lead but no PNG draws it. Screen 11 reuses its CSS.
