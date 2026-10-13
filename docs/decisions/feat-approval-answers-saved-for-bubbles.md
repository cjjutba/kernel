**An approved plan adds no note to the chat.** The settled plan card already says "Plan approved", so the note `planApproved` wrote when nothing was queued showed it twice. The agent still reads the same text: with ExitPlanMode's answer, from `request_plan_approval`, or in Kernel's message on Codex and after a restart.

**Kernel's message that answers a plan names the approval.** The user item, and the queue entry it waits in, carry `approvalId`, so the chat can draw the user's answer as their own bubble in place of Kernel's text. That covers Approve and Request changes after a restart, and Approve on Codex.

**Request changes keeps what the user typed, not what the agent read.** The plan's `answer` holds the notes before Kernel adds a line per attached image, live and after a restart. The agent still gets those lines.

**A plan card ends with its reason before the session stops.** Closing a chat and archiving a workspace expire its plan cards with `expiredBy` (`closed`, `archived`) first, because stopping the session would expire them with no reason. A newer plan marks the one it replaces `replaced`. A launch that finds a plan whose chat closed or whose workspace was archived says so too. Other kinds and older rows leave it unset.
