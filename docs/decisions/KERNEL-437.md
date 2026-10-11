**A hooks install that fails says why in one of five cards, each with one fix.** CheckHooks keeps its event list for a working install. When the install fails, the list gives way to a status row, a card and one line saying agents keep working, with their statuses stopped and approvals back in the terminal. The status row carries the error code or the setting (`EACCES`, `EROFS`, `managed settings`, `disableAllHooks`). The footer's primary button is the retry, with Done as plain text beside it.

- CheckHooksNotWritable. Kernel can't write to `~/.claude`, usually because Claude Code once ran with sudo. The fix is `sudo chown -R "$USER" ~/.claude`, then Install hooks.
- CheckHooksReadOnly. The disk that holds `~/.claude` is mounted read-only. The fix is `sudo mount -uw /Volumes/<disk>`, then Install hooks.
- CheckHooksSymlink. `settings.json` links into `/nix/store`. The fix is one command that removes the link and copies the store file over it, then Install hooks. Home Manager may put the link back on its next switch. The card doesn't say so, because the one step is the same either way.
- CheckHooksManaged. The managed settings file sets `allowManagedHooksOnly`, so Claude Code ignores user hooks. Kernel can't change that file. The one step is asking whoever manages the Mac, and Copy hooks for your admin copies Kernel's `hooks` block for them. The primary button is Check again.
- CheckHooksOff. The user's own `settings.json` sets `disableAllHooks`. Turn hooks on removes that line, after the first backup in `settings.json.kernel-backup`. When managed settings set `disableAllHooks`, the Managed card is used with the title "Your organization turns hooks off". That variant isn't drawn.

The paths, the disk name and the commands in the drawings are examples. The real card fills them in from the error and from `stat`.

**The push check runs when a room is set up and from the room's Git page, and shows two results.** Reach origin is `git ls-remote <remote>`. Permission to push is gh's answer for the repo. Setting up a room gets a Check push access step after Install hooks. A room with no remote skips it, which is why RoomSetupTeam has no such row. Settings, Room, Git gets a Push access section under New workspaces, with Check again in its heading and a note saying when it last ran.

- Both pass. Reached and Can push, each with a green check.
- gh is signed in and push fails. Permission to push says "Can't push", with "gh is signed in as cjjutba, but git isn't using that login" and `gh auth setup-git` to copy.
- `ls-remote` fails. Reach origin says "Failed" and prints git's own error in a box, with "Check your connection or VPN, then check again". Permission to push says "Not checked". The same row reads "Not checked" with "gh isn't signed in" when `ls-remote` works over SSH and gh is signed out. That one isn't drawn, and an SSH push needs no fix.

**Readiness checks say where the gh login comes from, swap the Claude sign-in for Bedrock or Vertex, and warn when the shell read times out.** All three use the rows Getting Kernel ready already has.

- SetupGhIdentity. "Signed in as cjjutba, from the keyring". When `GH_TOKEN` or `GITHUB_TOKEN` is also set, a note says Kernel leaves it out, because gh would use it instead of the stored login.
- SetupGhToken. "Signed in as cjjutba-bot, from GH_TOKEN in your shell", with a note that Kernel passes it on because gh has no stored login. `GITHUB_TOKEN` reads the same.
- SetupBedrock. "Using Bedrock from your shell" takes the place of Signed in, with the region at the right and the variable in a note. Vertex reads "Using Vertex AI from your shell".
- SetupShellTimeout. "Reading your shell timed out" is the first row, with a Check again button.

**A warning never blocks and its button is bordered.** The amber triangle is the `needs` warning from KERNEL-217. While only warnings show, Continue and Open the room stay on, and a warning row's own button is bordered, so the one ink button on the page is the way forward. This amends the app's Checks screen, where a warning's Check again is a primary button. A failure that blocks keeps the ink button.

**Disk use is a section of the room's General page.** Disk has a Worktrees row with the size from the cached background `du`, and a Measure again button in its heading. Empty trash after is a select with 1, 3, 7, 14 and 30 days or Never, 7 days by default, and its description says what the trash holds now. While the measurement runs, the heading button spins and says Measuring, the row says Measuring, and the trash description drops its size. SettingsRoomIcon follows the page, so it shows the section too.

**A copied `.env` that looks like production warns by file and variable name, never by value.** Files to copy gets a banner above its list, with the files, the variable that gave it away and two buttons. Don't copy these files adds them to the room's exclusions. Keep copying remembers the choice for the room. Room setup says the same in its Copy local files row, with Review files going to this page. What counts as production is B7's call. The drawings show a database URL on a remote host and a live Stripe key.

KERNEL-437.
