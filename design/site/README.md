# Website design kit

The approved design for Kernel's landing page and changelog, in a form code can read.

- Canvas (needs CJ's login): https://claude.ai/artifact/QkKTWG8JptN5AaqvPVBn1o
- Implementation plan: `docs/plans/website.md`

| Folder | Contents |
| --- | --- |
| `reference/` | `landing.html`, `changelog.html` and the shared `site.css`. Open the HTML files in a browser; they are the spec. |
| `renders/` | Full page renders at 1440 px for visual comparison. |
| `images/` | Product screenshots used on the pages. |
| `logo/` | The node K mark (SVG), app icon, favicons, Apple touch icon, social preview image. |
| `fonts/` | Inter and Geist Mono, used by the reference files only. The site uses `next/font`. |

The reference files are the source of truth for layout, spacing, color and copy. The one intended deviation is `--color-faint` (see the plan, section 6.1).
