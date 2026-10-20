# KERNEL-1098: Stay on top of everything

The Inbox, Work and the command palette follow Pen part 11. Where the frames and the engine disagree, these are the choices.

- **Failed lists are a calm state plus a toast.** `FailedState` is an `EmptyState` with an icon, what failed, one line and Try again. The call that failed raises `failToast`, whose Try again runs `retry` on the toast's action, which the open screen registered with `useRetryKey`. Signed out, a gone repo and offline say it on the page and raise no toast, since nothing failed that a toast could add.
- **Loading is skeleton rows and one line.** Rows hold the layout, and "Loading issues" with the arrow-down loader sits under them (`LoadingRow inline`).
- **Pull requests group by project, not by state.** Inside a project the rows still run ready, needs you, in progress. The merged list groups by project too, with the date in its own column.
- **The Inbox filter opens on `/` or its search button.** The frames draw it only in the sheet, so the header stays clean until it is wanted.
- **An overlap offers "Let the Lead sort it", not an order.** The frame's "X first, Y rebases" needs an engine call that takes an order, and none exists. The two workspaces link to their own chats.
- **Connect Linear opens Settings, Integrations.** Linear connects with a token, not a browser sign-in, so the frame's "You sign in to Linear in your browser" line is left out.
- **Always allow here** is the label everywhere an approval is decided, as on the chat's permission card. "Always allow in this project" and "Approve" are gone.
- **An issue's Plan with Kernel and Hand to an agent live in the Work card**, which says "No one yet". With work on the issue the card lists the workspaces and PRs and offers Open and View. The footer remains only for the project to plan in and the team link.
- **A row's live word comes from real events**: Working while a chat runs, Needs you while an approval waits in that workspace, and the PR's own states.
