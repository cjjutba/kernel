# KERNEL-686: the reply files card says "in this reply" and links to the workspace's changes

The card under a finished reply lists only the files changed while answering that message (KERNEL-586). Its header said "N files changed", so a later reply's card with "1 file changed" read like the workspace total.

## Decision

- The header reads "1 file changed in this reply" or "N files changed in this reply". The card's aria-label is "Files changed in this reply".
- The card on the latest reply in the chat shows a quiet text button after the counts, "14 in workspace". It opens the right panel on the Changes tab.
- The button is hidden when the workspace count equals the card's count, and when the workspace has no worktree of its own (the Lead's chat and current-branch workspaces). Cards on older replies get the header and no button.

## Why

In a Lead or current-branch workspace the Changes tab diffs the whole checkout, including the user's own edits, so its count says nothing about what the agent did and would mislead next to a reply. The button hides there. Older cards stay plain so a chat doesn't fill with repeated links to the same list.
