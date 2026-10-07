# Kernel design rules

The canvas is the source of truth. Every screen is exported to `design/screens/<Screen>.png`, and its markup (exact sizes, colors, copy) is in `design/canvas/project/<Screen>.dc.html`. Live canvas: https://claude.ai/artifact/QkKTWG8JptN5AaqvPVBn1o

## Character

Linear-inspired, dark first, quiet. Monochrome surfaces; color only carries meaning. Dense but calm: 13px UI text, generous line height, hairline borders.

## Color (dark)

| Token | Value | Use |
|---|---|---|
| canvas | #08090a | window background |
| panel | #0f1011 | main panel |
| surface | #141516 | inputs, cards |
| surface-2 | #18191b | menus, modals |
| surface-3 | #1c1d21 | selected rows, hover fills |
| hover | #232428 | menu item hover |
| line | #1a1b1e | dividers |
| line-2 | #23252a | input borders |
| line-3 | #2a2b30 | buttons, menus |
| ink | #f7f8f8 | primary text |
| ink-2 | #d0d6e0 | secondary text |
| muted | #8a8f98 | labels, meta |
| faint | #62666d | tertiary |
| add | #4cb782 | diff additions, passing checks |
| del | #eb5757 | diff deletions, errors |
| merged | #b9a3f5 (text), #7c5ce0 (fill) | merged PRs only |
| danger | #e5484d | destructive confirm buttons |

There is no accent color. Primary buttons are ink on canvas.

## Color (light)

Light values start from the lighten map in `design/canvas/source/build.py` (HomeLight, WorkspaceLight). Where text failed 4.5:1 on any surface, the value is darker than the canvas shows. `test/theme.test.ts` checks every pair.

| Token | Value | Use |
|---|---|---|
| canvas | #f3f3f4 | window background |
| panel | #ffffff | main panel |
| surface | #f4f4f5 | inputs, cards |
| surface-2 | #efeff1 | menus, modals |
| surface-3 | #eaeaed | selected rows, hover fills |
| hover | #e6e6e9 | menu item hover |
| line | #e8e8eb | dividers |
| line-2 | #dedee2 | input borders |
| line-3 | #d6d6db | buttons, menus |
| ink | #18191b | primary text |
| ink-2 | #3a3d44 | secondary text |
| muted | #62666d | labels, meta |
| faint | #636770 | tertiary (4.5:1, so close to muted) |
| add | #166a45 | diff additions, passing checks |
| del | #b32e2e | diff deletions, errors |
| merged | #6b4bd0 (text), #7c5ce0 (fill) | merged PRs only |
| danger | #bd2b2b | destructive confirm buttons |

The terminal palette (`--term-*`) and the floor art (`floor/floor-light.svg`, made by `scripts/floor-light.mjs`) follow the theme. Colors live in `tokens.css` and the floor art only; `test/theme.test.ts` fails on a hex or rgb value anywhere else in the renderer.

## Type

- Inter for UI (13px base, 14px in chat and composer, 12px meta), Geist Mono for code, branches, paths, shortcuts
- Weights 400 and 500; 600 only for page titles and names on cards
- Sentence case everywhere. Plain words. No em dashes.

## Shape

- Radii: 6px rows, 7 to 8px buttons and inputs, 10px cards and panels, 12px composer, 14px modals, 999px pills and tags
- 1px borders, no drop shadows anywhere
- Icons: 16px stroke icons, 1.4 stroke width, round caps

## Patterns

- No status dots, anywhere. Status is a word ("working", "needs you"), sometimes with a ring on floor tags.
- One modal shell: a blur scrim over the whole window (sidebar included) at z-index 40, the modal at 50, 14px radius, 1px border.
- Hover actions: message actions (copy, retry, edit, fork) and sidebar `...` menus appear on hover and on keyboard focus.
- Banners for failures: neutral surface (#141517) with an icon per type (limit/clock, offline/wifi, auth/key, setup/x-circle, hooks/plug, retry/spinner). Never red backgrounds.
- Toasts: bottom right, auto-dismiss after 2.6s.
- Danger: red only on the final confirm button, never on the trigger.
- Merged is the only purple: the PR link, the Merged label, the merged History row.

## Motion

- Floor characters bob while working and stride while walking (see `.bob` and `.stride` in `design/canvas/source/templates/_helmet.html`).
- Respect reduced motion: jump instead of walk, no spinners rotating.

## Accessibility

Real `<button>`, `<a>`, `<input>` with labels; focus rings visible; every icon-only control has `aria-label`; text contrast 4.5:1 (3:1 at 24px and up).
