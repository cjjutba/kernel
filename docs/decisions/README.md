# Decisions

Add a decision when you make a choice someone might later "fix". Each one is its own file in this folder, so two PRs never edit the same file and never pick the same name.

D-001 to D-139 live in `docs/DECISIONS.md` and stay there as written. When you look for a decision, grep both places.

## The file

Name it after the Linear issue: `docs/decisions/KERNEL-164.md`. Linear hands out keys one at a time, so two branches can't pick the same name. A PR with no issue names its file after its branch in kebab-case, the same rule release notes use (`.changes/README.md`).

A file holds one or more entries in the same shape as the old ones: a bold first sentence ending in a period, then the body. No frontmatter and no D-number. End the entry with the issue key, or leave it off when there is none. `feat-one-file-per-decision-in-docs-decisions.md`, the first file here, shows the shape.

## Citing one

Cite a new decision by its file name without `.md`: KERNEL-164. That goes for docs and code comments. Old entries keep their numbers: D-093.

## Changing one

Never edit an old entry. A decision that changes an older one says so in its own file: "Amends D-093" or "Amends KERNEL-141".
