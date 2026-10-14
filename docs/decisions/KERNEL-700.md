**Within one usage window, the highest reading wins, unless the window reset or the reading dropped clearly.** Every usage reading goes through `mergeLimit` (`services/providers/limits.ts`). The sources are each live Claude session's `rate_limit_event`, the usage call, the D-069 recheck, and each Codex runner's `account/rateLimits/read` and `account/rateLimits/updated`. Until now the newest reading replaced the stored one. Claude Code answers from a snapshot up to a minute old, one per session, so an older snapshot could land after a newer one, and the meters flipped between values such as 2% and 3%.

Now a reading lower than the stored one, for the same window, keeps the stored utilization. A lower reading is taken as it is when:

- the window reset: the stored reset time has passed, or the reading resets more than a minute later (the check D-069 already used for status), or
- it is lower by more than 5 points (`DROPPED_BY`, next to `LIFTED_UNDER`). That covers a reset on claude.ai, a bigger plan, or the CLI's login switching account under the same key.

Kernel treats a drop of 5 points or less inside one window as a stale snapshot. Usage really falling by that little without a reset is rare, and the next reading after the reset time corrects it anyway.

Status is unchanged. D-069's rule that a reading under 95% lifts a rejected window still compares the reading itself, not the utilization Kernel keeps, so an early lift and the queue release after it (KERNEL-220) happen as before. A patch with a status and no utilization behaves as before.

Narrows D-017 and D-069: "the newest reading wins" becomes "the highest reading in a window wins, unless the window reset or the reading dropped clearly". KERNEL-700.
