# KERNEL-1095: talking to the agent

Amends D-062 (a chip shows an icon, never a thumbnail), KERNEL-1053 (chip icons take a color for their kind), KERNEL-815 (chips land with no loader) and KERNEL-599 (the chat rail's list opens on hover).

**Every attachment is a token, and images are thumbnails too.** A token is 24px, `--surface-3` on a `--line-3` outline, with the icon of its kind: an image's own picture at 16px, an attached file's Material icon, a document glyph for pasted text, the tracker's mark and key for an issue. The colors that marked a kind (`--kind-image` to `--kind-media`) are gone, since a file's Material icon carries its type. Images also show as 64px thumbnails across the top of the box and as 104 by 76 thumbnails on a sent message, so the picture is seen where it is typed and where it was sent. A file being read shows the loader and "Attaching" in its token, where KERNEL-815 had it land with no loader, because the Pen draws the wait and Send already waits on it.

**A file Kernel won't attach is a toast.** Over 50 MB, a folder, a file that is neither text nor a format the agent can open, more than 20 files and more than 200 MB in a message each say why in a toast and leave no token. `cantOpen` reads the file's first bytes the way main does when a message goes out (`sniffBytes`), so the two agree on audio, video and binary data. A file that left the disk after a send (an archived workspace) stays in the sent message as a token that says "Gone from disk" over an empty thumbnail. The composer has no way to learn a draft's file left the disk, so it draws no such state for a draft.

**The composer's outline is `--line-3`, focused or not.** Only plan mode changes it. The agent shows as its avatar and name with no border or role. The radius is 12, as the Pen draws it, so `--r-md` and not `--r-lg`. An empty box keeps its height when the first word lands.

**The menus sit where the eye is.** The @ and / menus open 8px above the word being typed and 10px before it, the + menu lines up with its right edge and the pickers with their left, and the reply's ... menu opens below its button, with Copy message on top and Revert files to here under a rule. The @ menu groups reference folders apart from this project and a folder opens with →.

**The rail shows a message under the pointer and jumps on a click.** The list of every message opens from the keyboard (Tab to the rail, then the arrow keys), since the pointer no longer opens it. The list adds a time to each row. This changes KERNEL-599's hover-opens-list, which the Pen replaces with a preview of the one message.

**Revert says what it does, truthfully.** A revert rewrites files only. The commits since stay in the branch's history and their changes come back as uncommitted edits, so the dialog never says Kernel adds a commit. The Pen's rows of commits need the commit list from main, and its "Kept as is" and "Revert the rest" need a revert that skips files, neither of which the engine has, so they are left out. A file main changed too is named in the sentence and goes back with the rest, as KERNEL-797 does it.

**Compact at stays 200k or the full window.** The picker's Compact at row is a Settings choice between two windows, so it reads "200k tokens" and "Full window", where the Pen draws 85%.

Left for later: Send now stays on a held message the engine can send sooner (a brief waiting on a merge, an account move or an agent slot), which the Pen's tiles draw without it. KERNEL-1095.
