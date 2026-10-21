# KERNEL-1059: cross-model review by default

A review kind with no `provider` and no `model` runs on the provider that did not build the PR, when that provider is signed in, and is neither at nor near its limit. A provider with no usage read yet counts as having room; one whose last usage read failed does not (KERNEL-1076). Otherwise it runs on the builder's provider, with no error and no Inbox item.

Why: a second model catches what the builder's own model tends to miss. Changed in KERNEL-1076: no usage read yet used to count as no room, so someone who had just signed into Codex never saw a cross-model review on their first run. Now only a read that failed, or a provider at or near its limit, falls back to the builder's provider.

An explicit `provider` in `[review]` always wins and now applies without a `model`. A `model` alone still decides its own provider. The verdict records the provider that ran it.
