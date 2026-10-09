# Kernel website

The landing page (`/`) and changelog (`/changelog`) for Kernel. A standalone Next.js 16 app, separate from the Electron app in the rest of the repo. The design it implements is in `../design/site/` and the plan is `../docs/plans/website.md`.

## Develop

Node 22 or later.

```bash
cd site
pnpm install
pnpm dev               # http://localhost:3000
```

## Check

```bash
pnpm lint
pnpm typecheck
pnpm test              # unit tests, including the design rules
pnpm build
pnpm exec playwright install --with-deps chromium   # once
pnpm test:e2e          # e2e, axe, render comparison, JS budget
```

`pnpm test:e2e` builds the site into `.next-e2e` against a stub GitHub API that reports 1,234 stars and serves it on port 3100. Locally it reuses a server that is already running on that port.

The design rules are tests (`tests/unit/rules.test.ts`): no hex colors in components or pages, no arbitrary Tailwind values, and no em or en dashes. Colors, sizes and effects are tokens and named utilities in `app/globals.css`.

To compare against the design while you work, run the site on port 3000 and use:

```bash
node scripts/compare.mjs landing "hero=#top"   # reference left, site right, in test-results/compare/
node scripts/check-render.mjs changelog        # full page against design/site/renders
```

## Environment

| Variable | Needed | What it does |
| --- | --- | --- |
| `NEXT_PUBLIC_SITE_URL` | In production | The public origin, for canonical URLs, Open Graph, the sitemap and robots.txt. Defaults to `http://localhost:3000`. |
| `GITHUB_TOKEN` | No | Sent to the GitHub API for the star count, so builds aren't rate limited. A fine grained token with no permissions is enough. |

## Add a changelog entry

Each release is a file in `content/releases/<version>.md`, compiled from the repo's release-note fragments by `pnpm release:notes` at the repo root (`../.changes/README.md`, `../docs/RELEASING.md`). Don't write one from scratch; edit the compiled file in the release PR.

```md
---
version: 0.2.0
date: 2026-11-02
title: Short headline
image: /images/floor.png
imageAlt: What the screenshot shows
intro: One or two sentences.
---

## New

- **Bold lead in.** The rest of the line. (#41)
```

`image` and `imageAlt` (a 1440x900 PNG in `public/images`) and `intro` are optional. Quote a value in double quotes when it contains `: `. Sections are free text: compiled releases use New, Improved and Fixed. An item may end with its PR, `(#41)`.

`content/changelog.ts` reads the files at build time and checks them with the schema in `lib/schema.ts`, so a bad file fails the build. A minor version is its own entry; its patches show inside it as "New in x.y.z". The newest entry gets the Latest badge and the newest version sets the "Kernel 0.1 is here" pill on the landing page. Update `content/upNext.ts` when plans change.

## Deploy (Vercel)

- Root Directory `site`, Framework Next.js, Node 22.
- Ignored Build Step: `[ -n "$VERCEL_GIT_PREVIOUS_SHA" ] && [ "$VERCEL_GIT_PREVIOUS_SHA" != "$(git rev-parse HEAD)" ] && git diff --quiet "$VERCEL_GIT_PREVIOUS_SHA" HEAD -- .` Vercel runs it from the Root Directory, so `.` means `site/`. It compares with the last successful deployment, so a push whose last commit skips `site/` still builds. It also builds when there is nothing to compare with, and when the commit is the one already deployed, so Redeploy after an environment variable change works.
- Set `NEXT_PUBLIC_SITE_URL` to `https://kernel.cjjutba.dev` for Production, and optionally `GITHUB_TOKEN`.
- Domain: `kernel.cjjutba.dev`, a CNAME record at Porkbun pointing to the value Vercel shows.
