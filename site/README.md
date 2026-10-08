# Kernel website

The landing page (`/`) and changelog (`/changelog`) for Kernel. A standalone Next.js 16 app, separate from the Electron app in the rest of the repo. The design it implements is in `../design/site/` and the plan is `../docs/plans/website.md`.

## Develop

Node 22 or later.

```bash
cd site
npm install
npm run dev            # http://localhost:3000
```

## Check

```bash
npm run lint
npm run typecheck
npm test               # unit tests, including the design rules
npm run build
npx playwright install --with-deps chromium   # once
npm run test:e2e       # e2e, axe, render comparison, JS budget
```

`npm run test:e2e` builds the site into `.next-e2e` against a stub GitHub API that reports 1,234 stars and serves it on port 3100. Locally it reuses a server that is already running on that port.

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

Add the release at the top of `releases` in `content/changelog.ts`, so the list stays newest first. The newest release gets the Latest badge and sets the "Kernel 0.1 is here" pill on the landing page.

```ts
{
  version: '0.2.0',             // x.y.z
  date: '2026-11-02',           // yyyy-mm-dd
  title: 'Short headline',
  image: { src: '/images/floor.png', alt: 'What the screenshot shows' },  // optional, 1440x900 in public/images
  intro: 'One or two sentences.',
  sections: [
    { title: 'Highlights', items: [{ lead: 'Bold lead in.', text: 'The rest of the line.' }] },
    { title: 'Under the hood', items: [{ text: 'A fix.', pr: 41 }] }
  ]
}
```

The schema in `lib/schema.ts` checks every entry at build time, and `npm test` checks the order. Update `upNext` when plans change.

## Deploy (Vercel)

- Root Directory `site`, Framework Next.js, Node 22.
- Ignored Build Step: `[ -n "$VERCEL_GIT_PREVIOUS_SHA" ] && git diff --quiet "$VERCEL_GIT_PREVIOUS_SHA" HEAD -- .` Vercel runs it from the Root Directory, so `.` means `site/`. It compares with the last successful deployment, so a push whose last commit skips `site/` still builds, and a build runs whenever there is nothing to compare with.
- Set `NEXT_PUBLIC_SITE_URL` to `https://kernel.cjjutba.dev` for Production, and optionally `GITHUB_TOKEN`.
- Domain: `kernel.cjjutba.dev`, a CNAME record at Porkbun pointing to the value Vercel shows.
