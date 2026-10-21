# KERNEL-1097: pull request and merge

Amends the PR header in KERNEL-274 and KERNEL-413, the Lead's PRs tab in KERNEL-354 and KERNEL-757, and Merge anyway in KERNEL-501.

**The pull request has no band.** The header that sat in the chat's title bar and at the top of the panel is gone. A pull request now shows in the Session rail's Review stage, in the title bar when neither the rail nor the panel is open, and in the panel's Pull request tab. All three read one function, `reviewStages` in `pr/prStage.ts`, so a state has one wording. The `pr-*` band tokens are removed, and `pr-*-text` stays for the glyph of a chip or a note. KERNEL-1097.

**The rail is where you act.** Review offers Create PR, Ready for review, Fix checks, Address review, Address blockers, Resolve, Update branch, Reopen, Merge PR, Merge anyway and Open PR, and after a merge Archive and Continue. An idle workspace with changes counts as Built, since Review is where Create PR now lives. KERNEL-1097.

**Merge is green everywhere, and purple appears once it merged.** `--merge` with white text is the Merge button on the rail, the title bar, a Team update row, the Lead's PRs tab and the Work pills. A merge that runs keeps its green. Archive and Continue after a merge are outlines. KERNEL-1097.

**Merge anyway records the overrule.** The dialog lists what the review found, and confirming calls `reviews.overrule` and then `pr.merge` with `override`. The separate Overrule button and its dialog are gone. The overrule stays on the pull request if the merge then fails, and "You overruled 2 blockers" says so. KERNEL-1097.

**Left out for lack of an engine call.** The Open PR menu has no Mark as draft or Close pull request, and the Team update's hand-off has no Hand off and Not now buttons. Kernel can't convert a pull request to a draft or close one, and a hand-off row doesn't carry its approval. They come back when the engine has them. KERNEL-1097.
