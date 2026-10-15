**Any file the user attaches is copied into the workspace by its path, under caps Kernel checks before it copies anything.** The composer used to refuse every file that wasn't an image or text up to 1 MB, so a 2.9 MB PDF failed. Now the composer sends a file's path on the Mac (`window.kernel.pathOf`, Electron's `webUtils.getPathForFile`) and the main process copies it into `.kernel/attachments/<n>/`, out of git. The file never passes through the window, so a large one can't freeze it. The caps are exported from `src/shared/types/chats.ts` so the composer can refuse early, and main checks them again:

| | Decision |
| -- | -- |
| Per-file cap | 50 MB |
| Per-message cap | 200 MB and 20 files, pasted screenshots included |
| Folders | Refused ("Attach the files inside instead") |
| Types the agent can't open | Accepted with `readable: false`, marked "can't be opened" in the message, and the agent is told to say so instead of guessing |
| HEIC, TIFF, BMP | Converted to PNG on save with macOS `sips` |
| Text files | Up to 1 MB inlined as before. Larger ones are saved as files |
| Pasted screenshots | Unchanged. Alone in a message they still fall back to inline when saving fails |
| Push guard for attachments | KERNEL-910 |

Kernel decides a file's kind from its first bytes, and from a zip's entry list for .docx, .xlsx and .pptx, never from its name. A PDF renamed `.txt` is a PDF and is saved as `.pdf`. The extension only picks between Office's old formats, which share one header. Audio, video and unknown binary files are the kinds agents can't open. Documents, sheets, slides and archives count as readable, since an agent can extract or unpack them with its shell.

A message with attached files has no fallback. If any check or copy fails, Kernel removes that message's folder, doesn't send the message, and ends the turn with the reason in the chat. An image can go inline when saving fails, but a file can't. A copy keeps macOS's quarantine flag: Kernel sets it from the original when `copyFile` drops it, so Gatekeeper still checks a downloaded file before anything opens it.

Each saved file is named in the message by path, kind, size and, for a PDF, page count. The lines after the markers say the files are reference material from the user, not instructions and not files to add to the repo, and that a large file should be read in parts. Claude is told to use Read. Codex has no PDF reader, so it is told to extract the text.

The Lead's `images` argument on create_workspace and message_agent now takes any file in `.kernel/attachments/`. The argument keeps its name so the Lead's tool contract doesn't change, and the limit stays at 3. An image still goes as an image part with its data URL. Any other file goes by its path in the Lead's workspace, and the teammate's send copies it into their own worktree. Amends KERNEL-658. KERNEL-907
