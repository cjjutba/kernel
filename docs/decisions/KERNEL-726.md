# KERNEL-726: Room settings say where each value comes from

Room pages told a person where a value came from five different ways: a badge on each section, a "From settings.toml" line, "Default (Off)" dropdowns, a plain-text Reset and a header button whose label changed. Room pages also turned toggles and segments into dropdowns so they could hold an "inherit" choice.

## Decision

- Each page has one line under the title saying where its values are saved: "Saved on this Mac in .kernel/settings.local.toml" or "Shared with the repo in .kernel/settings.toml". A section keeps a badge only when its scope differs from the page's.
- A room row uses the same control as the app page. A toggle stays a toggle and a segment stays a segment.
- A row the room doesn't set shows the app's value and a muted "Default, from Settings, Git" link under the label. Changing it makes an override.
- A row the room sets says "Changed for this room" and has one Reset (`Row`'s `onReset`). Focus moves to the row's control after Reset.
- App pages say "Changed in Client A, Client B" under a row a room overrides. The page reads each room's settings with `settings.room`, so main has no new contract. The room name opens that room's page. When KERNEL-727 adds row targets, the link can scroll to the row.
- A value saved to the tracked settings.toml says "Saved to settings.toml. Commit it so your team gets it."

## Consequences

- `sourceLine` and `Row`'s `source` are gone. A value that comes from settings.toml says nothing on its row, since the page line already says it is shared.
- A value with no app default (scripts, files, the tracker) shows only the changed state.
