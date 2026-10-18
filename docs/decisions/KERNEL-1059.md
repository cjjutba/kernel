# KERNEL-1059: cross-model review by default

A review kind with no `provider` and no `model` runs on the provider that did not build the PR, when that provider is signed in, has a usage read, and is neither at nor near its limit. Otherwise it runs on the builder's provider, with no error and no Inbox item.

Why: a second model catches what the builder's own model tends to miss. An unknown usage read counts as no room, so a review never starts on a provider Kernel can't see the limits of.

An explicit `provider` in `[review]` always wins and now applies without a `model`. A `model` alone still decides its own provider. The verdict records the provider that ran it.
