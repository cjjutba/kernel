**A chat needs you when one of its tabs, or a workspace it started, needs you.** The sidebar row's icon (while the chat is folded) and its hover card follow the same rule, so the card never says "Nothing is waiting on you." while the row shows the question icon. The line can name a workspace instead of a tab ("Fix the login redirect asks whether to keep Google sign in."), and the foot counts those workspaces: "3 tabs · 2 need you". KERNEL-339.

**With more than one wait, the card's line shows the one that has gone longest.** The age on the right is that wait's age. Waiting wins over working in the foot and the pill. KERNEL-339.

**The card's age is shown in every state.** With nothing waiting it is the newest line in any of the chat's tabs, or when the chat started if no tab has loaded its transcript. KERNEL-339.

**Only a question reads "{name} asks {what}".** A plan or a permission uses the line the app already shows for it (Home's list and the approval card), with the tab or workspace name in front: "Client portal login: Plan for T-15 is ready", "Invoice table: Noor wants to run a command". No new copy. A question that starts "Should we" or "Do you want to" reads "whether to". Any other question is lowercased as asked. KERNEL-339.

**Ask Rowan joins the chat you are in.** In the Lead's workspace that is the chat on screen. In a workspace a chat started it is that chat, found by `threadId` or by the tab that handed it off. From Home, the Inbox, a workspace no chat started, or a chat that has closed, it passes no thread and the answer opens as a new chat. ⌘K's New tab joins the chat on screen the same way. KERNEL-339.
