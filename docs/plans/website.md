# Kernel website: landing page and changelog

Implementation plan for Claude Code. Owner: CJ. Branch: `feat/website`.

## 0. Read this first

You are building Kernel's public website: a landing page at `/` and a changelog at `/changelog`, as a standalone Next.js app in `site/` inside this repo. The design is finished and approved. Your job is to reproduce it faithfully, as production code, without redesigning anything.

**Design source.** The approved design lives on CJ's canvas:
**https://claude.ai/artifact/QkKTWG8JptN5AaqvPVBn1o** (section 19, boards "Landing page · desktop" and "Changelog"; section 20, "Logo · The node K").
You cannot open that link (it needs CJ's login). The same design is in this repo as a machine readable kit at `design/site/` (section 2). Treat the kit as the spec.

**Ground rules.**

1. Work only on the branch `feat/website`. Never commit to `main`. Open a draft PR early and keep it updated.
2. One task in section 17 equals one Conventional Commit, in that order.
3. Evidence before assertions: a task is done only when its commands have run and you have read their output.
4. Do not change the Electron app (`src/`, `test/`, `scripts/`, `electron-builder.yml`, `.claude/`). The only files outside `site/` you may touch are listed in section 4.7.
5. Copy is final. Take every word verbatim from `design/site/reference/*.html`. Do not rewrite, shorten or "improve" copy. If something reads wrong, ask CJ.
6. No em dashes or en dashes anywhere in user facing text. No hex colors in components. No arbitrary Tailwind values. These are enforced by tests (section 14.4).
7. Do not invent facts: no fake star counts, testimonials, download numbers or features.

## 1. Goal and scope

**In scope**

- Landing page `/`: nav, hero, how it works, product tour (tabs), details, privacy, FAQ, final call to action, footer.
- Changelog `/changelog`: header, release entries from typed data, an "Up next" entry, footer.
- Shared brand: the node K mark and the connected wordmark (the mark is the "K", followed by "ernel").
- Direct DMG download from every download button (no detour through the GitHub release page).
- SEO, social preview, icons, accessibility, performance, tests, CI.
- Deploy configuration for Vercel (CJ performs the account steps, section 16).

**Out of scope (follow ups)**

- A dedicated mobile design. Implement the responsive rules in section 10; CJ will design mobile later.
- Analytics. Do not add any tracking. GitHub already counts DMG downloads.
- Pulling the changelog automatically from GitHub Releases.
- Any change to the desktop app.

## 2. The design kit (`design/site/`)

| Path | What it is |
| --- | --- |
| `reference/landing.html` | The landing page markup, exactly as designed. Open it in a browser. |
| `reference/changelog.html` | The changelog markup, exactly as designed. |
| `reference/site.css` | The complete stylesheet for both pages. Every color, size, spacing and effect is here. |
| `renders/landing-1440.png` | Full page render of the landing page at 1440 px wide (6601 px tall). |
| `renders/changelog-1440.png` | Full page render of the changelog at 1440 px (2915 px tall). |
| `images/*.png` | Product screenshots used on the pages (1440 x 900): `floor`, `workspace`, `inbox`, `board`, `checkpoints`. |
| `logo/kernel-mark-white.svg`, `logo/kernel-mark-black.svg` | The node K mark, vector. |
| `logo/kernel-app-icon.svg`, `logo/kernel-app-icon-512.png` | The app icon (mark on the dark rounded square). |
| `logo/favicon.svg`, `logo/favicon-32.png`, `logo/favicon-16.png`, `logo/apple-touch-icon.png` | Site icons. |
| `logo/og-image.png` | Social preview, 1200 x 630. |
| `fonts/*.woff2` | Inter (variable) and Geist Mono 400/500, used by the reference files only. |

**Precedence when sources disagree:** `reference/*.html` and `reference/site.css` win, then this plan, then the renders. The renders are for visual comparison, not measurement.

The reference files open directly in a browser (`open design/site/reference/landing.html`). Use them constantly: inspect any element to get its exact values.

## 3. Branch and workflow

```bash
git checkout main && git pull
git checkout -b feat/website
```

- First commit: this plan and the kit (`docs(site): add website plan and design kit`). CJ may have already placed them; if so, commit them as they are.
- Push the branch and open a **draft** PR titled `feat(site): Kernel website, landing page and changelog`. Link this plan in the description.
- After each task: run the task's checks, commit, push, and tick the task in the PR description.
- When section 18 is fully true, mark the PR ready and ask CJ for review. Do not merge.

## 4. Architecture decisions

### 4.1 Location and isolation

The site is a separate app in `site/` with its own `package.json`, lockfile, `tsconfig.json`, ESLint, Vitest and Playwright configs. It is **not** an npm workspace of the root package, so the Electron app's native dependencies and scripts never mix with the website.

### 4.2 Stack

Use CJ's standard stack, pinned to exact versions (no `^` or `~`), latest stable at install time:

- Next.js 16 (App Router), React 19, TypeScript in strict mode.
- Tailwind CSS 4 with design tokens declared in `site/app/globals.css` via `@theme`.
- `@radix-ui/react-tabs` for the product tour tabs (accessible tabs out of the box). No other UI kit is needed.
- Zod for the changelog data schema.
- Vitest for unit tests, Playwright with `@axe-core/playwright` for end to end, accessibility and visual checks.
- Node 22.

### 4.3 Rendering

Both pages are statically generated. The only dynamic value is the GitHub star count, fetched on the server with `fetch(..., { next: { revalidate: 3600 } })`. Client JavaScript is limited to the tabs.

### 4.4 Fonts

Use `next/font` so fonts are self hosted at build time and no request goes to Google at runtime:

- Inter (variable) as `--font-sans`, with `font-feature-settings: 'cv01', 'ss03'` on the root (the reference sets these).
- Geist Mono 400 and 500 as `--font-mono`.

### 4.5 Links

| Element | Destination |
| --- | --- |
| Every "Download" and "Download for macOS" button | `https://github.com/cjjutba/kernel/releases/latest/download/Kernel-arm64.dmg` (direct file download) |
| Hero pill "Kernel 0.1 is here" | `/changelog` |
| Final call to action "Release notes" | `/changelog` |
| Nav "Changelog", footer "Changelog" | `/changelog` |
| Nav "Features", "How it works", "Privacy", "FAQ" | `/#features`, `/#how`, `/#privacy`, `/#faq` (work from the changelog too) |
| Star button, "View on GitHub", footer "GitHub" | `https://github.com/cjjutba/kernel` |
| Changelog "View releases on GitHub" | `https://github.com/cjjutba/kernel/releases` |
| Changelog PR chips | `https://github.com/cjjutba/kernel/pull/<n>` |
| Footer "Contributing", "Issues", "License", "Security" | the repo's `CONTRIBUTING.md`, `/issues`, `LICENSE.md`, `/security` |

Keep the download URL in one constant (`site/lib/links.ts`). The reference HTML still links some of these to GitHub Releases; this table replaces those links.

### 4.6 Content

- Landing copy lives in the components, verbatim from the reference.
- Changelog entries live in `site/content/changelog.ts`, validated by a Zod schema (section 9). The newest entry drives the hero pill text ("Kernel 0.1 is here") and the "Latest" badge.

### 4.7 Files outside `site/` you may change

- `design/site/**` and `docs/plans/website.md` (adding them in the first commit only).
- Root configs, **only** to exclude `site/` if they would otherwise pick it up: root `tsconfig*.json`, root Vitest config, root ESLint config, `.gitignore` (add `site/.next`, `site/node_modules`, `site/test-results`, `site/playwright-report`).
- `.github/workflows/site.yml` (new) and `.github/dependabot.yml` (add a `site/` npm entry if the file exists).
- `docs/DECISIONS.md`: add one entry (next free number) recording the website stack and location.
- `README.md`: only after CJ confirms the live domain, add a "Website" link.

After any root config change, run the root test suite (`ELECTRON_RUN_AS_NODE=1 electron node_modules/vitest/vitest.mjs run`) and confirm it still passes with the same counts.

## 5. File structure

```
site/
  app/
    layout.tsx            fonts, metadata defaults, skip link, body
    globals.css           Tailwind 4 import, @theme tokens, named utilities
    page.tsx              landing page
    changelog/page.tsx    changelog page
    sitemap.ts
    robots.ts
    icon.svg, apple-icon.png, opengraph-image.png, twitter-image.png
  components/
    brand/KernelMark.tsx, Wordmark.tsx, AppIcon.tsx
    ui/Button.tsx, StarButton.tsx, Shot.tsx, SectionHead.tsx, Eyebrow.tsx
    layout/SiteNav.tsx, SiteFooter.tsx
    landing/Hero.tsx, HowItWorks.tsx, StepMinis.tsx, ProductTour.tsx,
            Details.tsx, Privacy.tsx, Faq.tsx, FinalCta.tsx
    changelog/ChangelogHeader.tsx, ReleaseEntry.tsx, UpNext.tsx
  content/changelog.ts
  lib/links.ts, github.ts, format.ts, schema.ts
  public/images/floor.png, workspace.png, inbox.png, board.png, checkpoints.png
  tests/unit/*.test.ts
  tests/e2e/*.spec.ts
  next.config.ts, tsconfig.json, eslint.config.mjs, vitest.config.ts,
  playwright.config.ts, package.json, README.md
```

## 6. Design tokens

Port these into `@theme` in `globals.css`. Components use only these tokens through Tailwind classes. The values come from `design/site/reference/site.css`.

### 6.1 Color

| Token | Value | Used for |
| --- | --- | --- |
| `--color-canvas` | `#08090a` | page background |
| `--color-surface-1` | `#0b0c0d` | card gradient end |
| `--color-surface-2` | `#0f1011` | card gradient start, star count cell, tab track |
| `--color-surface-3` | `#141517` | mini UI cards |
| `--color-surface-4` | `#1c1d21` | active tab |
| `--color-line-faint` | `#141518` | section and footer dividers |
| `--color-line` | `#1d1e22` | card borders, FAQ rows |
| `--color-line-strong` | `#23252a` | detail item rules, pills |
| `--color-edge` | `#2a2b30` | buttons, mini UI borders |
| `--color-edge-hover` | `#34363c` | hover borders |
| `--color-ink` | `#f7f8f8` | primary text, primary button |
| `--color-ink-2` | `#d0d6e0` | secondary text |
| `--color-ink-3` | `#a9aeb7` | changelog list text |
| `--color-muted` | `#8a8f98` | body copy on dark |
| `--color-faint` | `#777b83` | small print (see note) |
| `--color-add` / `--color-del` | `#4cb782` / `#eb5757` | diff counts |
| `--color-merged` / `-edge` / `-fill` | `#b9a3f5` / `#4b3d86` / `#7c5ce0` | merged PR only |

**Note on `--color-faint`:** the canvas uses `#62666d`, which is 3.4:1 on the background and fails WCAG AA for small text. Use `#777b83` (4.7:1). This is the only intended deviation from the reference.

Purple is reserved for "merged". Do not use it anywhere else.

### 6.2 Spacing

One scale, everywhere: 4, 8, 12, 16, 24, 32, 40, 48, 56, 64, 80, 96, 128, 160 px. These map to Tailwind's default 4 px spacing steps (`1, 2, 3, 4, 6, 8, 10, 12, 14, 16, 20, 24, 32, 40`), so no arbitrary values are needed.

| Rule | Value |
| --- | --- |
| Page gutter | 24 |
| Container | max 1200 content width (1248 including gutters) |
| Between sections | 160 |
| Section heading to its content | 56 |
| Eyebrow to heading, heading to subtitle | 16 |
| Hero and final CTA rhythm | 32 to headline, 24 to subtitle, 40 to buttons, 16 to small print |
| Hero small print to screenshot | 64 |
| Final CTA padding | 128 top and bottom |
| Card and row padding | 24 |
| Tour: tabs to line, line to screenshot | 32, 32 |
| Details grid gap | 48 |
| FAQ columns gap | 80 |
| Footer | 64 top; 64 above the legal row; 48 above the large wordmark |

### 6.3 Type

| Token | Size / line height / tracking | Weight |
| --- | --- | --- |
| `display` (hero h1) | `clamp(44px, 5.6vw, 80px)` / 1 / -0.042em | 600 |
| `display-sm` (final CTA h2) | `clamp(36px, 4.2vw, 60px)` / 1.04 / -0.04em | 600 |
| `h2` | `clamp(32px, 3.4vw, 48px)` / 1.08 / -0.04em | 600 |
| `changelog-title` | `clamp(40px, 4vw, 56px)` / 1.04 / -0.04em | 600 |
| `entry-title` | 32 / 1.15 / -0.03em | 600 |
| `hero-lead` | 19 / 1.55 | 400 |
| `lead` | 17 / 1.6 | 400 |
| `body` | 15 / 1.55 | 400 |
| `ui` | 14 | 500 |
| `small` | 13 | 400 |
| `eyebrow` (mono) | 12.5, tracking 0.2px | 500 |
| `micro` (mono labels) | 12 | 500 |

Declare these as `--text-*` theme tokens (with their line heights and tracking) so components use named classes, not arbitrary values. `clamp()` lives in the token, not in components.

### 6.4 Radius, borders, motion

- Radius: pill 999, frame and card 16, tab track 12, large button 10, button and nav link 8, mini button 7, chip 6.
- Borders are 1 px hairlines. No drop shadows anywhere.
- Transitions: color, background and border at 150 ms. Respect `prefers-reduced-motion` (no transitions, no animation).

### 6.5 Decorative effects

These are hard to express as utilities. Define them once in `globals.css` as named `@utility` blocks using the tokens, copied from `site.css`:

- `bg-dots-hero`: 1 px dots on a 24 px grid, masked by an ellipse (62% by 58% at 50% 22%).
- `bg-dots-card`: 1 px dots on a 16 px grid at 5% white (step visuals).
- `bg-dots-final`: dots masked from the bottom (final CTA).
- `glow-hero`, `glow-final`: soft radial glows.
- `frame-gradient`: the screenshot frame (1 px padding with a vertical gradient from `#3a3c42` to `#141518`, inner radius 15).
- `text-wordmark-fade`: the large footer wordmark gradient text (`#1b1c1f` to `#0b0c0d`).

## 7. Shared components

### 7.1 `KernelMark`

An inline SVG of the node K, from `design/site/logo/kernel-mark-white.svg` (single path, viewBox `0 0 440.5 455.3`), filled with `currentColor`. Props: `className`, `title` (when set, `role="img"` and a `<title>`; otherwise `aria-hidden`).

### 7.2 `Wordmark`

The mark **is** the "K", followed by the text "ernel". The reference markup is `.kword` in `site.css`:

- `inline-flex`, `align-items: baseline`, weight 600, tracking -0.02em, line height 1.
- Mark height `0.78em`, `margin-right: 0.02em`, so its top meets the "l" and its round nodes sit on the baseline.
- Sizes: 18 px in the nav and footer.
- A visually hidden "K" sits between the mark and "ernel", so the text reads "Kernel" for screen readers, search engines, copy and paste and link previews. The mark itself is `aria-hidden`.

### 7.3 `AppIcon`

`design/site/logo/kernel-app-icon.svg` as a component. Not used on the pages right now (the final CTA has no icon), but used for the touch icon and social image sources.

### 7.4 `Button`

Variants `primary` (ink background, canvas text) and `secondary` (transparent with edge border). Sizes `md` (32 px tall, 12 px horizontal padding, 14 px text, radius 8) and `lg` (48 px, 20 px padding, 15 px text, radius 10). Optional leading icon with an 8 px gap. Renders an `<a>`.

### 7.5 `StarButton`

Split button from the nav: left cell "GitHub mark + Star", right cell "star icon + count" in Geist Mono.

- Server component. Fetch `https://api.github.com/repos/cjjutba/kernel` and read `stargazers_count`, revalidating hourly. Send `GITHUB_TOKEN` as a bearer token when the env var is set.
- Show the count only when it is at least `STAR_COUNT_MIN = 10` (exported constant in `lib/github.ts`). Below that, or when the fetch fails, render the left cell only, with a full border. Never show a fake or cached default number.
- Format with `formatStars`: 0 to 999 as is, then `1.2k`, `12k`.
- `aria-label`: "Star Kernel on GitHub" plus ", N stars" when shown.

### 7.6 `Shot`

Screenshot frame: `frame-gradient`, inner radius 15, `overflow: hidden`, containing a `next/image` (`width={1440}` `height={900}`, responsive `sizes`). The hero uses `priority`. Alt text verbatim from the reference.

### 7.7 `SectionHead` and `Eyebrow`

Eyebrow (mono 12.5 px, muted), h2 (16 px below), optional lead (16 px below). Variants `center` (max width 1000, lead max 560) and `start`.

### 7.8 `SiteNav`

64 px tall, sticky is **not** required (it is static in the design). Bottom hairline at 6% white, background canvas at 72% with a 14 px backdrop blur.

Left to right: Wordmark (links to `/`), a 32 px gap, then links (Features, How it works, Privacy, FAQ, Changelog) as 32 px tall pills with 12 px horizontal padding and 4 px gaps, a flexible spacer, the StarButton, an 8 px gap, the primary `md` Download button with the download icon.

On `/changelog`, the "Changelog" link gets the active style and `aria-current="page"`.

### 7.9 `SiteFooter`

Top border `line-faint`, 64 px top padding, `overflow: hidden`.

1. **Top row** (flex, wraps, `space-between`, 48 px gap):
   - Left: Wordmark linking to `/`, and under it (16 px) the tagline "Your coding agents, working as a team." (14 px, muted, max width 300).
   - Right: three columns, 80 px apart. Headings 13 px ink; links 14 px muted, 12 px apart.
     - Product: Download, Features, Changelog, FAQ
     - Project: GitHub, Contributing, Issues
     - Legal: License, Security
2. **Legal row**, 64 px below: "© 2026 Christian Jerald Jutba" left, "Elastic License 2.0" right, 13 px faint, with a hairline above it that spans the content width only (not the gutters).
3. **Large wordmark**, 48 px below: the mark plus "ernel", centered, `font-size: clamp(120px, 16vw, 232px)`, line height 0.78, tracking -0.043em, mark at 0.78em, the text in `text-wordmark-fade`, the mark filled with the same gradient. The block is `0.72em` tall with `overflow: hidden`, so the bottom of the letters is cropped by the page edge. `aria-hidden="true"`.

## 8. Landing page sections

Build each section to match `reference/landing.html` and `renders/landing-1440.png`. Order and anchors:

### 8.1 Hero (`#top`)

- 128 px top padding, centered.
- Background: `bg-dots-hero` (980 px tall, absolute) and `glow-hero` behind the screenshot.
- Pill linking to `/changelog`: white "New" tag, text "Kernel 0.1 is here", arrow icon. The version comes from the newest changelog entry (`0.1.0` becomes "0.1").
- h1 "Your coding agents,<br>working as a team." (forced break), `display` type, 32 px below the pill.
- Lead (24 px below), max width 600, balanced wrapping.
- Buttons (40 px below): primary `lg` "Download for macOS" with the download icon; secondary `lg` "View on GitHub" with the GitHub mark; 12 px apart.
- Small print (16 px below): "Free · For Macs with Apple silicon".
- Screenshot `floor.png` in a `Shot`, 64 px below, max width 1280, `priority`.
- The hero copy does not mention any specific coding agent. Keep it that way.

### 8.2 How it works (`#how`)

Center `SectionHead`: eyebrow "How it works", h2 "From a brief to a merged pull request.", lead "You stay the decision maker. Your lead plans, and the team builds in parallel."

Three cards, 56 px below, 16 px gap, `repeat(auto-fit, minmax(min(320px, 100%), 1fr))`. Each card: a 240 px tall visual area with `bg-dots-card` and 24 px padding, a hairline, then a 24 px body with the mono number, title (8 px) and text (8 px).

The visuals are small UI mockups built in HTML and CSS, **not images** (copy them from the reference `.mini` markup into `StepMinis.tsx`):

1. A brief composer: "Add PDF export to invoices. Spec first.", a "To Rowan · Lead" chip, a white round send button.
2. A plan card: "Rowan's plan is ready", "T-15 · Export invoices as PDF", three task rows (T-15a PDF renderer Noor, T-15b Download button Kai, T-15c Snapshot tests Ivy), "Request changes" and "Approve plan" buttons.
3. A PR card: branch "invoice-pdf", "Kai", "+212 -20", "4 checks passed", then the merged row "#41 Merged" and a purple "Archive" button.

These are decorative: `aria-hidden="true"` on each visual.

### 8.3 Product tour (`#features`)

Center `SectionHead`: eyebrow "The app", h2 "The whole team, in one window." (one line at desktop width).

Tabs, 56 px below, using Radix Tabs (`role="tablist"`, arrow key navigation, Home and End). The track: 4 px padding, 1 px border, radius 12, surface 2. Each tab: 36 px tall, 16 px padding, icon plus label, 8 px gap; the active tab gets surface 4, an edge border and ink text.

| Tab | Line (32 px below the tabs, centered, max 640) | Image |
| --- | --- | --- |
| Workspaces | Every task runs in its own git worktree, branch and port. | `workspace.png` |
| Inbox | Plans, risky commands and questions wait here for you. | `inbox.png` |
| Board | Every task from the plan, moving on its own as agents work. | `board.png` |
| Checkpoints | Every turn is saved. Step back without losing the chat. | `checkpoints.png` |

The screenshot sits 32 px below the line, full container width, in a `Shot`. Switching tabs must not shift the layout (all images share one aspect ratio). Preload only the first tab's image.

### 8.4 Details

Start aligned `SectionHead`: eyebrow "Details", h2 "The small things, done right." (max width 640).

Grid 56 px below, `repeat(auto-fit, minmax(min(320px, 100%), 1fr))`, 48 px gap. Each item: a hairline on top (`line-strong`), 24 px padding top, title 16 px, text 8 px below. No boxes, no icons. Items, in order:

1. The floor
2. Pull requests, end to end
3. Your agent's own terminal
4. A team made of plain files
5. Pause the room
6. Notifications that matter

### 8.5 Privacy (`#privacy`)

Center `SectionHead`: eyebrow "Privacy", h2 "Your Mac. Your plan. Your code.", lead "No account and no servers of its own. Kernel runs on your machine and the subscription you already have."

A row 56 px below with hairlines above and below, three columns separated by vertical hairlines, 32 px padding (no outer padding on the first and last columns). Each column: mono label (Plan, Data, Code), title 12 px below, text 8 px below. Titles: "Runs on your own plan", "Stays on your Mac", "Public on GitHub".

### 8.6 FAQ (`#faq`)

Two columns: left 380 px, right flexible, 80 px gap.

- Left: eyebrow "FAQ", h2 "Questions,<br>answered.", lead "Something missing? Ask on GitHub." with "Ask on GitHub" as an underlined link to `/issues`.
- Right: seven native `<details>`/`<summary>` rows (no JavaScript), the first one open. Rows have hairlines between them, 24 px vertical padding, a 14 px plus icon that turns into a minus when open. Answers sit 8 px under the question with 48 px right padding.

Questions in order: Is Kernel free? · Which coding agents does it support? · What do I need to run it? · Does my code leave my Mac? · Can I change the team? · Does it work on Intel Macs or Windows? · Can I contribute?

### 8.7 Final call to action

160 px above, a `line-faint` top border, 128 px padding top and bottom, centered, `bg-dots-final` and `glow-final` behind.

- h2 "Put your agents to work." in `display-sm`. **No icon above it.**
- Lead (24 px below): "Install it, open a repo, and brief your lead. The team takes it from there."
- Buttons (40 px below): primary `lg` "Download for macOS", secondary `lg` "Release notes" linking to `/changelog`.
- Small print (16 px below): "Free · For Macs with Apple silicon".

### 8.8 Footer

`SiteFooter` (section 7.9).

## 9. Changelog page

### 9.1 Data model (`lib/schema.ts`, `content/changelog.ts`)

```ts
const ChangeItem = z.object({
  lead: z.string().optional(),      // bold lead in, e.g. "The floor."
  text: z.string(),
  pr: z.number().int().positive().optional(),
});
const Release = z.object({
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  title: z.string(),
  image: z.object({ src: z.string(), alt: z.string() }).optional(),
  intro: z.string(),
  sections: z.array(z.object({ title: z.string(), items: z.array(ChangeItem).min(1) })),
});
const UpNext = z.object({ title: z.string(), intro: z.string(), items: z.array(ChangeItem) });
```

Releases are sorted newest first; the first one gets the "Latest" badge. Dates render as "October 8, 2026" in a `<time datetime>`.

Seed it with exactly what the reference shows:

- **0.1.0**, 2026-10-08, "Meet your team", image `floor.png`, the intro sentence, section **Highlights** (seven items with bold lead ins) and section **Under the hood** (six items with PR numbers 32, 33, 34, 35, 37, 38).
- **Up next**: "What we're working on", the intro, four items (More coding agents, A smoother first launch, Outside sessions on the floor, A much smaller download).

### 9.2 Layout

- Header: 128 px top and 64 px bottom padding, bottom hairline, dots background (520 px). Eyebrow "Changelog", h1 "What's new in Kernel" (`changelog-title`, 16 px below), lead (16 px below, max 560), and the "View releases on GitHub" link with the GitHub mark and an arrow (24 px below).
- Container: max 1000 content width, same gutters.
- Entry: two columns, 200 px meta and the body, 56 px gap, 64 px vertical padding, bottom hairline.
  - Meta: version pill (mono, 24 px tall, edge border) plus a white "Latest" badge on the newest; the date 8 px below.
  - Body: title (`entry-title`), screenshot 32 px below, intro (16.5 px, ink 2, line height 1.7) 24 px below, then each section title 40 px below and its list 16 px below. List items: 15.5 px, ink 3, 8 px apart, a 5 px round bullet; bold lead ins in ink; PR chips 8 px after the text (mono 11.5 px, 20 px tall, linking to the PR).
- Up next: same layout; the version pill reads "Up next" with a dashed border, meta text "Planned"; no image.
- End note: "This is where it all starts. Older releases will appear here as Kernel grows." centered, 64 px top and 96 px bottom padding.
- Footer.

## 10. Responsive behavior

The mobile design is not done yet. Until it is, implement these rules from the reference:

- Fluid container: `max-width` with 24 px gutters. Nothing has a fixed pixel width.
- Type tokens scale with `clamp()` (section 6.3).
- Grids use `auto-fit` and collapse to one column on narrow screens.
- At 880 px and below, the FAQ stacks (head above the list, 40 px gap).
- At 760 px and below: hide the nav links and the StarButton (keep the Wordmark and Download); privacy columns stack with a top hairline instead of a left one and 24 px vertical padding; changelog entries stack (meta above body, 16 px gap).
- The tab track wraps if needed.
- No horizontal scrolling at any width down to 360 px.

## 11. SEO, metadata, icons, social

- Base URL from `NEXT_PUBLIC_SITE_URL` (default `http://localhost:3000`); `metadataBase` set from it.
- `/`: title "Kernel · Your coding agents, working as a team"; description "Brief a lead, approve the plan, and watch your coding agents build in parallel, each in its own workspace. Free for Macs with Apple silicon."
- `/changelog`: title "Changelog · Kernel"; description "New features, improvements and fixes in every Kernel release."
- Open Graph and Twitter (`summary_large_image`) with `design/site/logo/og-image.png` copied to `app/opengraph-image.png` and `app/twitter-image.png`, with alt text.
- Icons: `app/icon.svg` from `logo/favicon.svg`, `app/apple-icon.png` from `logo/apple-touch-icon.png`, plus a 32 px PNG fallback.
- `theme-color` `#08090a`, `color-scheme: dark`.
- `sitemap.ts` with `/` and `/changelog`; `robots.ts` allowing all and pointing to the sitemap.
- JSON-LD on `/`: `SoftwareApplication` with name Kernel, `operatingSystem` "macOS", `applicationCategory` "DeveloperApplication", `offers` price 0 USD, `downloadUrl` the DMG URL.
- Canonical URLs on both pages.

## 12. Accessibility

Target WCAG 2.2 AA.

- A "Skip to content" link, visible on focus.
- Landmarks: `header`, `nav` (labelled "Main"), `main`, `footer` (with its nav labelled "Footer").
- One h1 per page; h2 per section; h3 inside.
- Focus ring on every interactive element: 2 px `rgba(247,248,248,.55)` outline, 2 px offset (from the reference).
- Text contrast at least 4.5:1 (hence `--color-faint`, section 6.1).
- Decorative SVGs and mini UIs `aria-hidden`; meaningful images have the reference alt text.
- Tabs: full keyboard support (Radix). FAQ: native `<details>`.
- `prefers-reduced-motion`: no transitions.
- The Wordmark reads as "Kernel".

## 13. Performance budgets

- Lighthouse (desktop and mobile) on both pages: Performance 95 or more, Accessibility 100, Best Practices 100, SEO 100.
- LCP under 2.0 s on desktop, CLS under 0.02.
- First load JavaScript, gzipped: the site's own code on `/` under 30 kB and on `/changelog` under 10 kB, on top of Next's shared runtime (about 132 kB in Next 16). The total on `/` stays under 160 kB and the budget test reports it. `/changelog` never loads the tour tabs.
- Images through `next/image` (AVIF and WebP), explicit dimensions, lazy except the hero.
- No runtime requests to third party origins except the server side GitHub API call.

## 14. Testing and verification

### 14.1 Unit (Vitest)

- `content/changelog.ts` parses with the Zod schema; versions are unique and sorted newest first; every `pr` is a positive integer.
- `formatStars` cases (0, 9, 999, 1000, 1234, 12345).
- `latestVersionLabel` turns `0.1.0` into `0.1`.
- `DOWNLOAD_URL` equals `https://github.com/cjjutba/kernel/releases/latest/download/Kernel-arm64.dmg`.

### 14.2 End to end (Playwright, Chromium, 1440 x 900 and 390 x 844)

- Both pages load with status 200 and no console errors.
- Every download link has the exact `DOWNLOAD_URL` href.
- "Release notes", the hero pill and nav "Changelog" go to `/changelog`.
- Nav anchors scroll to the right sections, from `/` and from `/changelog`.
- Tabs: clicking and arrow keys switch panels; the right image and line appear; focus stays on the tablist.
- FAQ: the first row is open; clicking a closed row opens it.
- The footer shows the Wordmark and the large wordmark; the final CTA shows no icon.
- With a mocked star count of 3, no count shows; with 1234, "1.2k" shows.
- No horizontal scroll at 390 px or 360 px.

### 14.3 Accessibility (axe)

Run `@axe-core/playwright` on both pages at both viewports. Zero violations.

### 14.4 Rules as failing tests

- No hex colors (`#rgb`, `#rrggbb`, `#rrggbbaa`) in `components/**` and `app/**/*.tsx`. Only `globals.css` may contain them.
- No arbitrary Tailwind values (`-[` inside class strings) in `components/**` and `app/**`.
- No em dashes or en dashes in `components/**`, `content/**` and `app/**`.

### 14.5 Visual comparison

At 1440 px wide, take full page screenshots of `/` and `/changelog` and compare them to `design/site/renders/*.png` with Playwright's `toHaveScreenshot` (allow a small pixel ratio difference for font rasterization, around 2%). Mask the star count. Also save side by side images to the PR for CJ to review.

The page heights should land close to the renders (landing about 6601 px, changelog about 2915 px). A difference of more than 24 px means spacing drifted: find it before moving on.

### 14.6 Commands

```bash
cd site
npm run lint && npm run typecheck && npm run test && npm run build
npx playwright install --with-deps chromium
npm run test:e2e
```

Then run the root suite once to prove the app is untouched (section 4.7).

## 15. CI

`.github/workflows/site.yml`: runs on pull requests and pushes that touch `site/**` or `design/site/**`. Node 22, `npm ci` in `site/`, then lint, typecheck, unit tests, build, Playwright (Chromium) with axe and visual checks. Upload the Playwright report as an artifact on failure. Cache npm and the Playwright browsers.

## 16. Deployment (Vercel)

Prepare the repo so CJ only clicks through:

- `site/README.md` documents: local dev (`npm run dev`), tests, environment variables (`NEXT_PUBLIC_SITE_URL`, optional `GITHUB_TOKEN`), and how to add a changelog entry.
- `vercel.json` is not required; settings below are set in the dashboard.

CJ's steps (list them in the PR description):

1. Vercel: Add New Project, import `cjjutba/kernel`, Root Directory `site`, Framework Next.js, Node 22.
2. Ignored Build Step: `git diff --quiet HEAD^ HEAD -- .` (skips builds when the site did not change). Vercel runs it from the Root Directory, so `.` means `site/`.
3. Environment: `NEXT_PUBLIC_SITE_URL` set to `https://kernel.cjjutba.dev` (Production); optionally `GITHUB_TOKEN` (a fine grained token with no permissions is enough for the public API).
4. Domain: `kernel.cjjutba.dev`. Add it in Vercel and create the CNAME record it shows at Porkbun.
5. After the first production deploy: add the website link to `README.md` (section 4.7) in a follow up commit.

## 17. Tasks (one task, one commit)

Each task lists its commit message and what proves it done.

1. `docs(site): add website plan and design kit`. This file and `design/site/` are committed. **Done when** `git show --stat` lists them.
2. `chore(site): scaffold Next.js app in site/`. Next 16, React 19, TS strict, Tailwind 4, ESLint, Vitest, Playwright, exact versions, scripts `dev build start lint typecheck test test:e2e`. Root configs exclude `site/`. **Done when** `npm run build` in `site/` passes and the root test suite still passes with the same counts.
3. `feat(site): design tokens, fonts and global styles`. Section 6 in `globals.css`, `next/font` setup, base layout with skip link. **Done when** a token preview page (delete it before the PR is ready) shows the right colors and type.
4. `feat(site): brand components`. KernelMark, Wordmark, AppIcon, icons and social images in `app/`. **Done when** the Wordmark at 18 px and 120 px matches the reference footer and nav.
5. `feat(site): shared UI`. Button, StarButton (with `lib/github.ts`, `lib/format.ts`), Shot, SectionHead, Eyebrow, `lib/links.ts`. **Done when** unit tests for `formatStars` and `DOWNLOAD_URL` pass.
6. `feat(site): navigation and footer`. **Done when** both match the reference at 1440 and follow section 10 at 390.
7. `feat(site): hero`.
8. `feat(site): how it works`.
9. `feat(site): product tour tabs`.
10. `feat(site): details and privacy`.
11. `feat(site): FAQ and final call to action`. After this task, the landing page visual comparison (14.5) must pass.
12. `feat(site): changelog`. Schema, data, page. **Done when** the changelog visual comparison passes and the schema tests pass.
13. `feat(site): metadata, sitemap and structured data`. **Done when** `next build` output lists the sitemap and robots routes and the OG image is served.
14. `fix(site): responsive pass`. **Done when** the 390 and 360 px checks in 14.2 pass.
15. `test(site): end to end, accessibility, visual and rules tests`. **Done when** all of section 14 passes locally.
16. `ci(site): GitHub Actions workflow`. **Done when** the workflow runs green on the PR.
17. `docs(site): site README and decision record`. `site/README.md` and the `docs/DECISIONS.md` entry.

## 18. Definition of done

- [ ] All tasks in section 17 are committed on `feat/website`, in order, with passing checks.
- [ ] Both pages match the reference at 1440 px (visual comparison passes; heights within 24 px).
- [ ] Every download button downloads the DMG directly; release notes and changelog links go to `/changelog`.
- [ ] The footer shows the Wordmark and the large wordmark; the final CTA has no icon; the hero names no specific agent.
- [ ] Lint, typecheck, unit, build, end to end, axe and rules tests pass locally and in CI.
- [ ] Lighthouse budgets in section 13 are met (attach the reports to the PR).
- [ ] The root app test suite passes with unchanged counts.
- [ ] The PR description lists CJ's Vercel steps and includes side by side screenshots.
- [ ] The PR is ready for review and **not merged**.

## 19. Follow ups (not in this PR)

- Mobile design pass on the canvas, then implement it.
- Website link in `README.md` once the domain is live.
- Consider generating changelog entries from GitHub Releases.
- When Kernel supports more agents, update the FAQ answer and the "Up next" list.
